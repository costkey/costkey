import { describe, it, expect } from "vitest";
import { computeCost } from "../pricing.js";
import type { NormalizedUsage } from "../types.js";

function usage(input: number, output: number): NormalizedUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
  };
}

describe("Pricing", () => {
  it("computes cost for GPT-4o", () => {
    // 1000 input tokens * $2.50/1M + 500 output tokens * $10/1M
    const cost = computeCost("gpt-4o", usage(1000, 500));
    expect(cost).toBeCloseTo(0.0025 + 0.005, 6);
  });

  it("computes cost for GPT-4o-mini", () => {
    const cost = computeCost("gpt-4o-mini", usage(10000, 5000));
    // 10000 * 0.15/1M + 5000 * 0.6/1M = 0.0015 + 0.003
    expect(cost).toBeCloseTo(0.0045, 6);
  });

  it("computes cost for Claude Sonnet", () => {
    const cost = computeCost("claude-sonnet-4-0-20250514", usage(1000, 500));
    // 1000 * 3/1M + 500 * 15/1M = 0.003 + 0.0075
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it("computes cost for Gemini Flash", () => {
    const cost = computeCost("gemini-2.0-flash", usage(10000, 5000));
    // 10000 * 0.1/1M + 5000 * 0.4/1M
    expect(cost).toBeCloseTo(0.003, 6);
  });

  it("handles cache tokens for Anthropic", () => {
    const u: NormalizedUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: null,
      cacheReadTokens: 10000,
      cacheCreationTokens: 5000,
    };
    const cost = computeCost("claude-sonnet-4-0-20250514", u);
    // input: 100 * 3/1M = 0.0003
    // output: 50 * 15/1M = 0.00075
    // cacheRead: 10000 * 0.3/1M = 0.003
    // cacheWrite: 5000 * 3.75/1M = 0.01875
    expect(cost).toBeCloseTo(0.0003 + 0.00075 + 0.003 + 0.01875, 5);
  });

  it("matches versioned model names by prefix", () => {
    // "gpt-4o-2024-11-20" should match "gpt-4o" pricing
    const cost = computeCost("gpt-4o-2024-11-20", usage(1000, 500));
    expect(cost).not.toBeNull();
    expect(cost).toBeCloseTo(0.0075, 6);
  });

  it("returns null for unknown models", () => {
    expect(computeCost("some-unknown-model", usage(1000, 500))).toBeNull();
  });

  it("handles zero tokens", () => {
    const cost = computeCost("gpt-4o", usage(0, 0));
    expect(cost).toBe(0);
  });
});
