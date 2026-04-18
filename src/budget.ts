/**
 * Client-side budget + rate-limit enforcement.
 *
 * Rules come from two sources:
 *   1. init() options — a single "local" rule with no scope, for the pre-fetch
 *      window and for users who don't configure anything in the dashboard.
 *   2. GET /api/v1/sdk/budget/rules — fetched at init and repolled every 5
 *      minutes. Each rule can be scope-limited (by model glob, function glob,
 *      or both).
 *
 * Per call, every matching rule is checked. Most-restrictive policy wins
 * (throw beats block beats warn). Every matching rule is recorded against
 * after the call completes.
 *
 * Limitations (addressed in a future server-sync mode):
 *   - Each SDK instance has its own counters. A serverless deployment with
 *     many short-lived workers will under-enforce — each worker starts at $0.
 *   - Counters are memory-only. Process restarts reset them.
 */

import type { StackFrame } from "./types.js";

export type BudgetExceedPolicy = "throw" | "warn" | "block";

export interface BudgetOptions {
  /** Hard cap in USD per rolling 24 hours */
  daily?: number;
  /** Hard cap in USD per rolling 30 days */
  monthly?: number;
  /** What to do when a budget is exceeded (default: "throw") */
  onExceed?: BudgetExceedPolicy;
  /** Fire this webhook URL with JSON when budget hits 80% and 100%. Only
   *  applies to the local init-option rule, not to server-fetched rules
   *  (server-side rules fire their own alerts via the platform). */
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

/** Server-fetched rule shape (matches GET /api/v1/sdk/budget/rules). */
export interface RemoteBudgetRule {
  id: string;
  name: string | null;
  scopeModel: string | null;
  scopeFunction: string | null;
  dailyUsd: number | null;
  monthlyUsd: number | null;
  callsPerMinute: number | null;
  tokensPerMinute: number | null;
  onExceed: BudgetExceedPolicy;
}

/** Thrown when a hard budget cap is hit and onExceed is "throw" */
export class CostKeyBudgetExceeded extends Error {
  readonly code = "COSTKEY_BUDGET_EXCEEDED";
  constructor(
    public readonly scope: "daily" | "monthly",
    public readonly limit: number,
    public readonly spent: number,
    public readonly ruleName?: string,
  ) {
    super(
      `CostKey ${scope} budget exceeded${ruleName ? ` [${ruleName}]` : ""}: spent $${spent.toFixed(4)} of $${limit} limit`,
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
    public readonly ruleName?: string,
  ) {
    super(
      `CostKey rate limit hit${ruleName ? ` [${ruleName}]` : ""}: ${observed} ${scope} in last 60s (limit ${limit})`,
    );
    this.name = "CostKeyRateLimited";
  }
}

// ── Glob matching ─────────────────────────────────────────────────────

/** Convert a glob (`*`, `?`) to a regex. Escapes all other regex metachars. */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(pattern);
}

const globCache = new Map<string, RegExp>();
function matchGlob(glob: string, target: string): boolean {
  let rx = globCache.get(glob);
  if (!rx) { rx = globToRegex(glob); globCache.set(glob, rx); }
  return rx.test(target);
}

// ── Sliding window ────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;
const MIN_MS = 60 * 1000;

interface SpendEntry { ts: number; cost: number; tokens: number }

class SlidingWindow {
  private entries: SpendEntry[] = [];
  private lastCompact = 0;

  record(cost: number, tokens: number): void {
    this.entries.push({ ts: Date.now(), cost, tokens });
    if (Date.now() - this.lastCompact > 30_000) this.compact();
  }
  private compact(): void {
    const cutoff = Date.now() - MONTH_MS;
    this.entries = this.entries.filter((e) => e.ts >= cutoff);
    this.lastCompact = Date.now();
  }
  costSince(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let sum = 0;
    for (const e of this.entries) if (e.ts >= cutoff) sum += e.cost;
    return sum;
  }
  tokensSince(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let sum = 0;
    for (const e of this.entries) if (e.ts >= cutoff) sum += e.tokens;
    return sum;
  }
  countSince(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let n = 0;
    for (const e of this.entries) if (e.ts >= cutoff) n++;
    return n;
  }
  reset(): void { this.entries = []; this.lastCompact = 0 }
}

// ── Rule (internal shape, source-agnostic) ────────────────────────────

interface InternalRule {
  id: string;
  name: string | null;
  scopeModel: string | null;
  scopeFunction: string | null;
  dailyUsd: number | null;
  monthlyUsd: number | null;
  callsPerMinute: number | null;
  tokensPerMinute: number | null;
  onExceed: BudgetExceedPolicy;
  window: SlidingWindow;
  // Webhook alert state (only used for the local rule)
  alertWebhook: string | null;
  alerted80Daily: boolean;
  alerted100Daily: boolean;
  alerted80Monthly: boolean;
  alerted100Monthly: boolean;
}

function matchesRule(r: InternalRule, model: string | null, frames: StackFrame[]): boolean {
  if (r.scopeModel) {
    if (!model || !matchGlob(r.scopeModel, model)) return false;
  }
  if (r.scopeFunction) {
    const hit = frames.some((f) => {
      const fn = f.functionName ?? "";
      const key = `${f.fileName ?? ""}:${fn}`;
      return matchGlob(r.scopeFunction!, key) || matchGlob(r.scopeFunction!, fn);
    });
    if (!hit) return false;
  }
  return true;
}

// Policy precedence: throw > block > warn. When multiple matching rules fail
// a check, pick the most-restrictive policy and attribute the error to the
// first rule that failed (in order).
const POLICY_RANK: Record<BudgetExceedPolicy, number> = { warn: 0, block: 1, throw: 2 };

// ── Main enforcer ─────────────────────────────────────────────────────

export class BudgetGuard {
  private rules: InternalRule[] = [];
  private readonly warnTimestamps = new Map<string, number>();

  constructor(
    budget: BudgetOptions | undefined,
    rateLimit: RateLimitOptions | undefined,
    private readonly debug: boolean,
  ) {
    // Local init-option rule becomes an internal rule with no scope.
    const hasAny = Boolean(
      budget?.daily != null || budget?.monthly != null ||
      rateLimit?.callsPerMinute != null || rateLimit?.tokensPerMinute != null,
    );
    if (hasAny) {
      // Pick the more-restrictive onExceed across whichever blocks were
      // configured. If only one side is set, use its policy directly (default
      // "throw"); don't let the unset side's default poison the result.
      const hasBudget = budget?.daily != null || budget?.monthly != null;
      const hasRate = rateLimit?.callsPerMinute != null || rateLimit?.tokensPerMinute != null;
      const policies: BudgetExceedPolicy[] = [];
      if (hasBudget) policies.push(budget?.onExceed ?? "throw");
      if (hasRate) policies.push(rateLimit?.onExceed ?? "throw");
      const onExceed = policies.reduce(
        (acc, p) => (POLICY_RANK[p] > POLICY_RANK[acc] ? p : acc),
        policies[0] ?? "throw",
      );
      this.rules.push({
        id: "__local__",
        name: "init options",
        scopeModel: null,
        scopeFunction: null,
        dailyUsd: budget?.daily ?? null,
        monthlyUsd: budget?.monthly ?? null,
        callsPerMinute: rateLimit?.callsPerMinute ?? null,
        tokensPerMinute: rateLimit?.tokensPerMinute ?? null,
        onExceed,
        window: new SlidingWindow(),
        alertWebhook: budget?.alertWebhook ?? null,
        alerted80Daily: false, alerted100Daily: false,
        alerted80Monthly: false, alerted100Monthly: false,
      });
    }
  }

  /** Called by the SDK init code after fetching rules from the server.
   *  Replaces the remote portion (keeps the local init-option rule). */
  setRemoteRules(remote: RemoteBudgetRule[]): void {
    // Keep __local__, preserve its window. Drop all others. Add new.
    const local = this.rules.find((r) => r.id === "__local__");
    const kept: InternalRule[] = local ? [local] : [];
    for (const r of remote) {
      // Carry a window forward if a rule with the same id existed before
      const existing = this.rules.find((x) => x.id === r.id);
      kept.push({
        id: r.id,
        name: r.name,
        scopeModel: r.scopeModel,
        scopeFunction: r.scopeFunction,
        dailyUsd: r.dailyUsd,
        monthlyUsd: r.monthlyUsd,
        callsPerMinute: r.callsPerMinute,
        tokensPerMinute: r.tokensPerMinute,
        onExceed: r.onExceed,
        window: existing?.window ?? new SlidingWindow(),
        alertWebhook: null, // server-side alerts handle remote rules
        alerted80Daily: existing?.alerted80Daily ?? false,
        alerted100Daily: existing?.alerted100Daily ?? false,
        alerted80Monthly: existing?.alerted80Monthly ?? false,
        alerted100Monthly: existing?.alerted100Monthly ?? false,
      });
    }
    this.rules = kept;
    if (this.debug) {
      console.log(`[costkey] budget rules: ${this.rules.length} active (${remote.length} from server)`);
    }
  }

  get enabled(): boolean {
    return this.rules.length > 0;
  }

  /**
   * Before each AI call. Throws (or signals block) if ANY matching rule fails.
   * Most-restrictive policy wins.
   */
  checkOrThrow(model: string | null, frames: StackFrame[], tokensEstimate: number): "ok" | "blocked" {
    if (this.rules.length === 0) return "ok";

    let failurePolicy: BudgetExceedPolicy | null = null;
    let failureError: Error | null = null;

    for (const r of this.rules) {
      if (!matchesRule(r, model, frames)) continue;

      if (r.dailyUsd != null) {
        const spent = r.window.costSince(DAY_MS);
        if (spent >= r.dailyUsd) {
          const err = new CostKeyBudgetExceeded("daily", r.dailyUsd, spent, r.name ?? undefined);
          if (!failurePolicy || POLICY_RANK[r.onExceed] > POLICY_RANK[failurePolicy]) {
            failurePolicy = r.onExceed; failureError = err;
          }
          continue;
        }
      }
      if (r.monthlyUsd != null) {
        const spent = r.window.costSince(MONTH_MS);
        if (spent >= r.monthlyUsd) {
          const err = new CostKeyBudgetExceeded("monthly", r.monthlyUsd, spent, r.name ?? undefined);
          if (!failurePolicy || POLICY_RANK[r.onExceed] > POLICY_RANK[failurePolicy]) {
            failurePolicy = r.onExceed; failureError = err;
          }
          continue;
        }
      }
      if (r.callsPerMinute != null) {
        const count = r.window.countSince(MIN_MS);
        if (count >= r.callsPerMinute) {
          const err = new CostKeyRateLimited("calls", r.callsPerMinute, count, r.name ?? undefined);
          if (!failurePolicy || POLICY_RANK[r.onExceed] > POLICY_RANK[failurePolicy]) {
            failurePolicy = r.onExceed; failureError = err;
          }
          continue;
        }
      }
      if (r.tokensPerMinute != null && tokensEstimate > 0) {
        const used = r.window.tokensSince(MIN_MS);
        if (used + tokensEstimate > r.tokensPerMinute) {
          const err = new CostKeyRateLimited("tokens", r.tokensPerMinute, used + tokensEstimate, r.name ?? undefined);
          if (!failurePolicy || POLICY_RANK[r.onExceed] > POLICY_RANK[failurePolicy]) {
            failurePolicy = r.onExceed; failureError = err;
          }
        }
      }
    }

    if (!failurePolicy || !failureError) return "ok";

    if (failurePolicy === "warn") {
      if (this.debug || !this.hasWarnedThisMinute(failureError.name)) {
        console.warn(`[costkey] ${failureError.message}`);
      }
      return "ok";
    }
    if (failurePolicy === "block") {
      if (this.debug) console.warn(`[costkey] blocked: ${failureError.message}`);
      return "blocked";
    }
    throw failureError;
  }

  private hasWarnedThisMinute(key: string): boolean {
    const now = Date.now();
    const last = this.warnTimestamps.get(key) ?? 0;
    if (now - last < 60_000) return true;
    this.warnTimestamps.set(key, now);
    return false;
  }

  /** After an AI call, record into every matching rule's window. */
  record(costUsd: number, tokensUsed: number, model: string | null, frames: StackFrame[]): void {
    if (this.rules.length === 0) return;
    for (const r of this.rules) {
      if (!matchesRule(r, model, frames)) continue;
      r.window.record(costUsd || 0, tokensUsed || 0);
      this.maybeFireLocalAlert(r);
    }
  }

  private maybeFireLocalAlert(r: InternalRule): void {
    if (!r.alertWebhook) return;

    if (r.dailyUsd != null) {
      const spent = r.window.costSince(DAY_MS);
      if (!r.alerted80Daily && spent >= r.dailyUsd * 0.8) {
        r.alerted80Daily = true;
        void this.fireAlert(r.alertWebhook, { level: "warn", scope: "daily", threshold: 0.8, limit: r.dailyUsd, spent });
      }
      if (!r.alerted100Daily && spent >= r.dailyUsd) {
        r.alerted100Daily = true;
        void this.fireAlert(r.alertWebhook, { level: "critical", scope: "daily", threshold: 1.0, limit: r.dailyUsd, spent });
      }
    }
    if (r.monthlyUsd != null) {
      const spent = r.window.costSince(MONTH_MS);
      if (!r.alerted80Monthly && spent >= r.monthlyUsd * 0.8) {
        r.alerted80Monthly = true;
        void this.fireAlert(r.alertWebhook, { level: "warn", scope: "monthly", threshold: 0.8, limit: r.monthlyUsd, spent });
      }
      if (!r.alerted100Monthly && spent >= r.monthlyUsd) {
        r.alerted100Monthly = true;
        void this.fireAlert(r.alertWebhook, { level: "critical", scope: "monthly", threshold: 1.0, limit: r.monthlyUsd, spent });
      }
    }
  }

  private async fireAlert(url: string, body: unknown): Promise<void> {
    try {
      const rawFetch = getRawFetch();
      await rawFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // Never crash on failed alert
    }
  }

  /** Current usage snapshot per rule — exposed for status endpoints / UIs. */
  snapshot() {
    return this.rules.map((r) => ({
      id: r.id,
      name: r.name,
      scope: { model: r.scopeModel, function: r.scopeFunction },
      onExceed: r.onExceed,
      daily: { spent: r.window.costSince(DAY_MS), limit: r.dailyUsd },
      monthly: { spent: r.window.costSince(MONTH_MS), limit: r.monthlyUsd },
      callsPerMinute: { count: r.window.countSince(MIN_MS), limit: r.callsPerMinute },
      tokensPerMinute: { used: r.window.tokensSince(MIN_MS), limit: r.tokensPerMinute },
    }));
  }

  reset(): void {
    for (const r of this.rules) {
      r.window.reset();
      r.alerted80Daily = r.alerted100Daily = r.alerted80Monthly = r.alerted100Monthly = false;
    }
    this.warnTimestamps.clear();
  }
}

// ── Raw fetch access (set from fetch-patch.ts at patch time) ──────────

let _rawFetch: typeof globalThis.fetch | null = null;
export function setRawFetch(f: typeof globalThis.fetch): void { _rawFetch = f }
function getRawFetch(): typeof globalThis.fetch { return _rawFetch ?? globalThis.fetch }

// ── Pre-flight token estimation ───────────────────────────────────────

export function estimateTokens(requestBody: unknown): number {
  if (!requestBody || typeof requestBody !== "object") return 0;
  const body = requestBody as Record<string, unknown>;

  let inputChars = 0;
  const accumulate = (v: unknown): void => {
    if (typeof v === "string") inputChars += v.length;
    else if (Array.isArray(v)) for (const x of v) accumulate(x);
    else if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) accumulate(x);
    }
  };
  accumulate(body["messages"] ?? body["prompt"] ?? body["input"] ?? "");

  const inputEstimate = Math.ceil(inputChars / 4);
  const outputEstimate =
    (typeof body["max_tokens"] === "number" ? body["max_tokens"] : 0) ||
    (typeof body["max_output_tokens"] === "number" ? body["max_output_tokens"] : 0) ||
    (typeof body["maxOutputTokens"] === "number" ? body["maxOutputTokens"] : 0) ||
    0;

  return inputEstimate + (outputEstimate as number);
}
