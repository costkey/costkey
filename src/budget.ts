/**
 * Client-side budget enforcement. Tracks spend in-memory per process.
 *
 * Limitations (addressed in a future server-sync mode):
 *   - Each SDK instance has its own counters. A serverless deployment with
 *     many short-lived workers will under-enforce — each worker starts at $0.
 *   - Counters are memory-only. Process restarts reset them.
 *   - For a single long-running server (Node service, worker pool), this is
 *     accurate and has zero network overhead.
 */

export type BudgetExceedPolicy = "throw" | "warn" | "block";

export interface BudgetOptions {
  /** Hard cap in USD per rolling 24 hours */
  daily?: number;
  /** Hard cap in USD per rolling 30 days */
  monthly?: number;
  /** What to do when a budget is exceeded (default: "throw") */
  onExceed?: BudgetExceedPolicy;
  /** Fire this webhook URL with JSON when budget hits 80% and 100% */
  alertWebhook?: string;
}

export interface RateLimitOptions {
  /** Max AI calls per rolling 60s */
  callsPerMinute?: number;
  /** Max tokens (input + output estimate) per rolling 60s */
  tokensPerMinute?: number;
  /** What to do when a limit is exceeded (default: "throw") */
  onExceed?: BudgetExceedPolicy;
}

/** Thrown when a hard budget cap is hit and onExceed is "throw" */
export class CostKeyBudgetExceeded extends Error {
  readonly code = "COSTKEY_BUDGET_EXCEEDED";
  constructor(
    public readonly scope: "daily" | "monthly",
    public readonly limit: number,
    public readonly spent: number,
  ) {
    super(
      `CostKey ${scope} budget exceeded: spent $${spent.toFixed(4)} of $${limit} limit`,
    );
    this.name = "CostKeyBudgetExceeded";
  }
}

/** Thrown when a rate limit is hit and onExceed is "throw" */
export class CostKeyRateLimited extends Error {
  readonly code = "COSTKEY_RATE_LIMITED";
  constructor(
    public readonly scope: "calls" | "tokens",
    public readonly limit: number,
    public readonly observed: number,
  ) {
    super(
      `CostKey rate limit hit: ${observed} ${scope} in last 60s (limit ${limit})`,
    );
    this.name = "CostKeyRateLimited";
  }
}

// ── Internal state ────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;
const MIN_MS = 60 * 1000;

interface SpendEntry {
  ts: number; // epoch ms
  cost: number; // USD
  tokens: number;
}

/** Sliding-window accumulator. Holds up to ~1h of entries in memory. */
class SlidingWindow {
  private entries: SpendEntry[] = [];
  private lastCompact = 0;

  record(cost: number, tokens: number): void {
    this.entries.push({ ts: Date.now(), cost, tokens });
    // Compact every 30s to keep memory bounded (max ~2880 entries / hour at 1 req/sec)
    if (Date.now() - this.lastCompact > 30_000) {
      this.compact();
    }
  }

  private compact(): void {
    const cutoff = Date.now() - MONTH_MS;
    this.entries = this.entries.filter((e) => e.ts >= cutoff);
    this.lastCompact = Date.now();
  }

  /** Sum cost over the last windowMs milliseconds */
  costSince(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let sum = 0;
    for (const e of this.entries) if (e.ts >= cutoff) sum += e.cost;
    return sum;
  }

  /** Sum tokens over the last windowMs milliseconds */
  tokensSince(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let sum = 0;
    for (const e of this.entries) if (e.ts >= cutoff) sum += e.tokens;
    return sum;
  }

  /** Count entries over the last windowMs milliseconds */
  countSince(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let n = 0;
    for (const e of this.entries) if (e.ts >= cutoff) n++;
    return n;
  }

  reset(): void {
    this.entries = [];
    this.lastCompact = 0;
  }
}

// ── Budget guard (one instance per patchFetch lifetime) ──────────────

export class BudgetGuard {
  private readonly window = new SlidingWindow();
  private alertedDaily80 = false;
  private alertedDaily100 = false;
  private alertedMonthly80 = false;
  private alertedMonthly100 = false;

  constructor(
    private readonly budget: BudgetOptions | undefined,
    private readonly rateLimit: RateLimitOptions | undefined,
    private readonly debug: boolean,
  ) {}

  get enabled(): boolean {
    return Boolean(this.budget || this.rateLimit);
  }

  /**
   * Called before each AI call. Throws (or returns a synthetic blocked
   * response) if any budget/limit is exceeded.
   *
   * tokensEstimate: conservative pre-flight estimate (e.g. max_tokens from
   * the request body). 0 if unknown — we then skip tokens-per-minute check.
   */
  checkOrThrow(tokensEstimate: number): "ok" | "blocked" {
    const budgetPolicy = this.budget?.onExceed ?? "throw";
    const ratePolicy = this.rateLimit?.onExceed ?? "throw";

    if (this.budget?.daily != null) {
      const spent = this.window.costSince(DAY_MS);
      if (spent >= this.budget.daily) {
        return this.handleExceed(
          budgetPolicy,
          new CostKeyBudgetExceeded("daily", this.budget.daily, spent),
        );
      }
    }
    if (this.budget?.monthly != null) {
      const spent = this.window.costSince(MONTH_MS);
      if (spent >= this.budget.monthly) {
        return this.handleExceed(
          budgetPolicy,
          new CostKeyBudgetExceeded("monthly", this.budget.monthly, spent),
        );
      }
    }
    if (this.rateLimit?.callsPerMinute != null) {
      const count = this.window.countSince(MIN_MS);
      if (count >= this.rateLimit.callsPerMinute) {
        return this.handleExceed(
          ratePolicy,
          new CostKeyRateLimited(
            "calls",
            this.rateLimit.callsPerMinute,
            count,
          ),
        );
      }
    }
    if (this.rateLimit?.tokensPerMinute != null && tokensEstimate > 0) {
      const used = this.window.tokensSince(MIN_MS);
      if (used + tokensEstimate > this.rateLimit.tokensPerMinute) {
        return this.handleExceed(
          ratePolicy,
          new CostKeyRateLimited(
            "tokens",
            this.rateLimit.tokensPerMinute,
            used + tokensEstimate,
          ),
        );
      }
    }
    return "ok";
  }

  private handleExceed(
    policy: BudgetExceedPolicy,
    err: Error,
  ): "ok" | "blocked" {
    if (policy === "warn") {
      if (this.debug || !this.hasWarnedThisMinute(err.name)) {
        console.warn(`[costkey] ${err.message}`);
      }
      return "ok";
    }
    if (policy === "block") {
      if (this.debug) console.warn(`[costkey] blocked: ${err.message}`);
      return "blocked";
    }
    throw err;
  }

  // Rate-limit noisy warnings (don't spam stderr 1000x/second)
  private readonly warnTimestamps = new Map<string, number>();
  private hasWarnedThisMinute(key: string): boolean {
    const now = Date.now();
    const last = this.warnTimestamps.get(key) ?? 0;
    if (now - last < 60_000) return true;
    this.warnTimestamps.set(key, now);
    return false;
  }

  /** Called after every AI call completes, with the actual cost + tokens. */
  record(costUsd: number, tokensUsed: number): void {
    if (!this.enabled) return;
    this.window.record(costUsd || 0, tokensUsed || 0);
    this.maybeFireAlerts();
  }

  private maybeFireAlerts(): void {
    const url = this.budget?.alertWebhook;
    if (!url) return;

    const daily = this.budget?.daily;
    if (daily != null) {
      const spent = this.window.costSince(DAY_MS);
      if (!this.alertedDaily80 && spent >= daily * 0.8) {
        this.alertedDaily80 = true;
        void this.fireAlert(url, {
          level: "warn",
          scope: "daily",
          threshold: 0.8,
          limit: daily,
          spent,
        });
      }
      if (!this.alertedDaily100 && spent >= daily) {
        this.alertedDaily100 = true;
        void this.fireAlert(url, {
          level: "critical",
          scope: "daily",
          threshold: 1.0,
          limit: daily,
          spent,
        });
      }
    }
    const monthly = this.budget?.monthly;
    if (monthly != null) {
      const spent = this.window.costSince(MONTH_MS);
      if (!this.alertedMonthly80 && spent >= monthly * 0.8) {
        this.alertedMonthly80 = true;
        void this.fireAlert(url, {
          level: "warn",
          scope: "monthly",
          threshold: 0.8,
          limit: monthly,
          spent,
        });
      }
      if (!this.alertedMonthly100 && spent >= monthly) {
        this.alertedMonthly100 = true;
        void this.fireAlert(url, {
          level: "critical",
          scope: "monthly",
          threshold: 1.0,
          limit: monthly,
          spent,
        });
      }
    }
  }

  private async fireAlert(url: string, body: unknown): Promise<void> {
    try {
      // Use the ORIGINAL fetch captured before patching, otherwise we'll
      // recurse into ourselves and blow the stack.
      const rawFetch = getRawFetch();
      await rawFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // Never crash the user's app over a failed alert
    }
  }

  /** Current usage snapshot — exposed so hosts can build status UIs. */
  snapshot(): {
    daily: { spent: number; limit: number | null };
    monthly: { spent: number; limit: number | null };
    callsPerMinute: { count: number; limit: number | null };
    tokensPerMinute: { used: number; limit: number | null };
  } {
    return {
      daily: {
        spent: this.window.costSince(DAY_MS),
        limit: this.budget?.daily ?? null,
      },
      monthly: {
        spent: this.window.costSince(MONTH_MS),
        limit: this.budget?.monthly ?? null,
      },
      callsPerMinute: {
        count: this.window.countSince(MIN_MS),
        limit: this.rateLimit?.callsPerMinute ?? null,
      },
      tokensPerMinute: {
        used: this.window.tokensSince(MIN_MS),
        limit: this.rateLimit?.tokensPerMinute ?? null,
      },
    };
  }

  /** Reset all counters. Useful for tests. */
  reset(): void {
    this.window.reset();
    this.alertedDaily80 = false;
    this.alertedDaily100 = false;
    this.alertedMonthly80 = false;
    this.alertedMonthly100 = false;
    this.warnTimestamps.clear();
  }
}

// ── Raw fetch access (set from fetch-patch.ts at patch time) ──────────

let _rawFetch: typeof globalThis.fetch | null = null;

export function setRawFetch(f: typeof globalThis.fetch): void {
  _rawFetch = f;
}

function getRawFetch(): typeof globalThis.fetch {
  return _rawFetch ?? globalThis.fetch;
}

// ── Pre-flight token estimation ───────────────────────────────────────

/**
 * Estimate the upper bound of tokens a request will consume.
 * Used by rate-limit check. Conservative — better to under-allow than
 * over-allow.
 *
 * Strategy:
 *   - If max_tokens/max_output_tokens/maxOutputTokens is set, use it plus
 *     a rough input estimate (4 chars per token).
 *   - Otherwise return 0 and skip the check.
 */
export function estimateTokens(requestBody: unknown): number {
  if (!requestBody || typeof requestBody !== "object") return 0;
  const body = requestBody as Record<string, unknown>;

  // Estimate input from any text fields (rough: 4 chars per token)
  let inputChars = 0;
  const accumulate = (v: unknown): void => {
    if (typeof v === "string") inputChars += v.length;
    else if (Array.isArray(v)) for (const x of v) accumulate(x);
    else if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>))
        accumulate(x);
    }
  };
  accumulate(body["messages"] ?? body["prompt"] ?? body["input"] ?? "");

  const inputEstimate = Math.ceil(inputChars / 4);
  const outputEstimate =
    (typeof body["max_tokens"] === "number" ? body["max_tokens"] : 0) ||
    (typeof body["max_output_tokens"] === "number"
      ? body["max_output_tokens"]
      : 0) ||
    (typeof body["maxOutputTokens"] === "number"
      ? body["maxOutputTokens"]
      : 0) ||
    0;

  return inputEstimate + (outputEstimate as number);
}
