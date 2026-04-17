import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BudgetGuard,
  CostKeyBudgetExceeded,
  CostKeyRateLimited,
  estimateTokens,
} from "../budget.js";
import { estimateCost, totalTokens } from "../pricing.js";

describe("BudgetGuard — daily cap", () => {
  it("allows calls under budget", () => {
    const g = new BudgetGuard({ daily: 10, onExceed: "throw" }, undefined, false);
    g.record(3, 1000);
    g.record(3, 1000);
    expect(() => g.checkOrThrow(0)).not.toThrow();
    expect(g.snapshot().daily.spent).toBeCloseTo(6);
  });

  it("throws when daily budget exceeded (throw policy)", () => {
    const g = new BudgetGuard({ daily: 10, onExceed: "throw" }, undefined, false);
    g.record(12, 1000);
    expect(() => g.checkOrThrow(0)).toThrow(CostKeyBudgetExceeded);
    try {
      g.checkOrThrow(0);
    } catch (e) {
      const err = e as CostKeyBudgetExceeded;
      expect(err.scope).toBe("daily");
      expect(err.limit).toBe(10);
      expect(err.spent).toBeGreaterThanOrEqual(12);
      expect(err.code).toBe("COSTKEY_BUDGET_EXCEEDED");
    }
  });

  it("warns instead of throwing when policy is 'warn'", () => {
    const g = new BudgetGuard({ daily: 10, onExceed: "warn" }, undefined, false);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    g.record(15, 1000);
    expect(g.checkOrThrow(0)).toBe("ok");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns 'blocked' instead of throwing when policy is 'block'", () => {
    const g = new BudgetGuard({ daily: 10, onExceed: "block" }, undefined, false);
    g.record(15, 1000);
    expect(g.checkOrThrow(0)).toBe("blocked");
  });

  it("suppresses repeated warnings within a minute (no stderr spam)", () => {
    const g = new BudgetGuard({ daily: 1, onExceed: "warn" }, undefined, false);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    g.record(5, 100);
    g.checkOrThrow(0); // first warn — logs
    g.checkOrThrow(0); // second — suppressed
    g.checkOrThrow(0); // third — suppressed
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("BudgetGuard — monthly cap", () => {
  it("throws when monthly budget exceeded", () => {
    const g = new BudgetGuard({ monthly: 100, onExceed: "throw" }, undefined, false);
    g.record(120, 1000);
    expect(() => g.checkOrThrow(0)).toThrow(CostKeyBudgetExceeded);
  });
});

describe("BudgetGuard — rate limits", () => {
  it("throws when calls-per-minute exceeded", () => {
    const g = new BudgetGuard(
      undefined,
      { callsPerMinute: 3, onExceed: "throw" },
      false,
    );
    g.record(0.01, 100);
    g.record(0.01, 100);
    g.record(0.01, 100);
    expect(() => g.checkOrThrow(0)).toThrow(CostKeyRateLimited);
  });

  it("throws when tokens-per-minute estimate exceeded", () => {
    const g = new BudgetGuard(
      undefined,
      { tokensPerMinute: 1000, onExceed: "throw" },
      false,
    );
    g.record(0.01, 500);
    // Next call claims 600 estimated tokens: 500 + 600 = 1100 > 1000 → block
    expect(() => g.checkOrThrow(600)).toThrow(CostKeyRateLimited);
  });

  it("skips token check when estimate is 0 (unknown request shape)", () => {
    const g = new BudgetGuard(
      undefined,
      { tokensPerMinute: 100, onExceed: "throw" },
      false,
    );
    g.record(0.01, 99_999);
    // Estimate=0 means "we don't know" — don't block on it
    expect(() => g.checkOrThrow(0)).not.toThrow();
  });
});

describe("BudgetGuard — enabled flag", () => {
  it("is disabled with no options", () => {
    const g = new BudgetGuard(undefined, undefined, false);
    expect(g.enabled).toBe(false);
  });
  it("is enabled with budget only", () => {
    expect(new BudgetGuard({ daily: 1 }, undefined, false).enabled).toBe(true);
  });
  it("is enabled with rate limit only", () => {
    expect(new BudgetGuard(undefined, { callsPerMinute: 1 }, false).enabled).toBe(
      true,
    );
  });
});

describe("BudgetGuard — alert webhook", () => {
  it("fires 80% + 100% alerts exactly once each", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    // Point the raw-fetch hook at our mock
    const { setRawFetch } = await import("../budget.js");
    setRawFetch(fetchMock as unknown as typeof globalThis.fetch);

    const g = new BudgetGuard(
      { daily: 10, onExceed: "warn", alertWebhook: "https://example.com/hook" },
      undefined,
      false,
    );
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    g.record(5, 100);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(0); // 50% — no alert

    g.record(3.5, 100); // now at 8.5 = 85% → 80% alert fires
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    g.record(0.5, 100); // still below 100% — no new alert
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    g.record(2, 100); // now at 11 = 110% → 100% alert fires
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    g.record(2, 100); // already fired — no new alerts
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });

  it("swallows webhook failures silently", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const { setRawFetch } = await import("../budget.js");
    setRawFetch(fetchMock as unknown as typeof globalThis.fetch);

    const g = new BudgetGuard(
      { daily: 1, onExceed: "warn", alertWebhook: "https://example.com/hook" },
      undefined,
      false,
    );
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Exceeds 80% AND 100% in one record — both should attempt, both fail silently
    expect(() => g.record(2, 100)).not.toThrow();
    spy.mockRestore();
  });
});

describe("BudgetGuard — snapshot", () => {
  it("exposes current usage with limits", () => {
    const g = new BudgetGuard(
      { daily: 10, monthly: 100 },
      { callsPerMinute: 60, tokensPerMinute: 10_000 },
      false,
    );
    g.record(2.5, 500);
    g.record(1.0, 200);
    const s = g.snapshot();
    expect(s.daily.spent).toBeCloseTo(3.5);
    expect(s.daily.limit).toBe(10);
    expect(s.monthly.spent).toBeCloseTo(3.5);
    expect(s.monthly.limit).toBe(100);
    expect(s.callsPerMinute.count).toBe(2);
    expect(s.callsPerMinute.limit).toBe(60);
    expect(s.tokensPerMinute.used).toBe(700);
    expect(s.tokensPerMinute.limit).toBe(10_000);
  });
});

describe("estimateTokens", () => {
  it("returns 0 for empty or unknown bodies", () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens({})).toBe(0);
    expect(estimateTokens("not an object")).toBe(0);
  });

  it("sums max_tokens + rough input estimate for OpenAI-style body", () => {
    // 40-char message ≈ 10 input tokens + 500 output = 510
    const t = estimateTokens({
      model: "gpt-4o",
      max_tokens: 500,
      messages: [{ role: "user", content: "a".repeat(40) }],
    });
    expect(t).toBeGreaterThanOrEqual(500);
    expect(t).toBeLessThan(520);
  });

  it("handles Anthropic-style max_output_tokens", () => {
    const t = estimateTokens({
      model: "claude-sonnet-4-5",
      max_output_tokens: 1000,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(t).toBeGreaterThanOrEqual(1000);
  });

  it("handles Google-style maxOutputTokens (camelCase)", () => {
    const t = estimateTokens({
      maxOutputTokens: 750,
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    expect(t).toBeGreaterThanOrEqual(750);
  });
});

describe("pricing — estimateCost", () => {
  it("computes cost for gpt-4o", () => {
    // 1000 input tokens * $2.50/M + 500 output * $10/M = $0.0025 + $0.005 = $0.0075
    const cost = estimateCost(
      {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      },
      "gpt-4o",
    );
    expect(cost).toBeCloseTo(0.0075, 6);
  });

  it("returns 0 for unknown model (don't pollute budget)", () => {
    const cost = estimateCost(
      {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      },
      "some-model-we-dont-know",
    );
    expect(cost).toBe(0);
  });

  it("matches by substring — claude-sonnet-4-5-20250514 → claude-sonnet-4", () => {
    const cost = estimateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      },
      "claude-sonnet-4-5-20250514",
    );
    expect(cost).toBeCloseTo(3.0, 4); // $3/M input for claude-sonnet-4
  });

  it("handles Anthropic prompt caching rates", () => {
    // 0 fresh input, 1M cache-read, 0 cache-write → cached read rate only
    const cost = estimateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
        reasoningTokens: null,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 0,
      },
      "claude-sonnet-4",
    );
    // billedInput = max(0, 1M - 1M) = 0. cacheRead = 1M * $0.30/M = $0.30
    expect(cost).toBeCloseTo(0.3, 4);
  });
});

describe("totalTokens", () => {
  it("prefers totalTokens field if provided", () => {
    expect(
      totalTokens({
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 999,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      }),
    ).toBe(999);
  });
  it("falls back to input + output sum", () => {
    expect(
      totalTokens({
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      }),
    ).toBe(300);
  });
  it("returns 0 on null usage", () => {
    expect(totalTokens(null)).toBe(0);
  });
});
