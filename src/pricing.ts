/**
 * SDK-side pricing — used for client-side budget enforcement ONLY.
 * The SERVER is the authoritative cost source. This table is a subset
 * of the server's pricing and only covers the most common models.
 *
 * If a model isn't in this table, budget tracking skips it for that call
 * (the server will still record the true cost via the pricing table there).
 *
 * Rates: USD per 1M tokens. Source: provider pricing pages, ~2026-04.
 */

import type { NormalizedUsage } from "./types.js";

interface ModelRate {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// Keyed by substring match — more specific patterns first.
const PRICING: [string, ModelRate][] = [
  // OpenAI
  ["gpt-4o-mini", { input: 0.15, output: 0.6 }],
  ["gpt-4o", { input: 2.5, output: 10 }],
  ["gpt-4-turbo", { input: 10, output: 30 }],
  ["gpt-4", { input: 30, output: 60 }],
  ["gpt-3.5-turbo", { input: 0.5, output: 1.5 }],
  ["o1-mini", { input: 3, output: 12 }],
  ["o1-pro", { input: 150, output: 600 }],
  ["o1", { input: 15, output: 60 }],
  ["o3-mini", { input: 1.1, output: 4.4 }],
  ["o3", { input: 10, output: 40 }],
  ["o4-mini", { input: 1.1, output: 4.4 }],

  // Anthropic
  ["claude-opus-4", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-haiku-4", { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  ["claude-haiku-3", { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  ["claude-3-5-sonnet", { input: 3, output: 15 }],
  ["claude-3-5-haiku", { input: 0.8, output: 4 }],
  ["claude-3-opus", { input: 15, output: 75 }],
  ["claude-3-sonnet", { input: 3, output: 15 }],
  ["claude-3-haiku", { input: 0.25, output: 1.25 }],

  // Google
  ["gemini-2.5-pro", { input: 1.25, output: 5 }],
  ["gemini-2.5-flash", { input: 0.075, output: 0.3 }],
  ["gemini-2.0-flash", { input: 0.075, output: 0.3 }],
  ["gemini-1.5-pro", { input: 1.25, output: 5 }],
  ["gemini-1.5-flash", { input: 0.075, output: 0.3 }],

  // Groq (fast inference of open models)
  ["llama-3.3-70b", { input: 0.59, output: 0.79 }],
  ["llama-3.1-70b", { input: 0.59, output: 0.79 }],
  ["llama-3.1-8b", { input: 0.05, output: 0.08 }],
  ["mixtral-8x7b", { input: 0.24, output: 0.24 }],

  // xAI
  ["grok-4", { input: 3, output: 15 }],
  ["grok-3", { input: 3, output: 15 }],
  ["grok-2", { input: 2, output: 10 }],

  // DeepSeek
  ["deepseek-chat", { input: 0.27, output: 1.1 }],
  ["deepseek-reasoner", { input: 0.55, output: 2.19 }],

  // Mistral
  ["mistral-large", { input: 2, output: 6 }],
  ["mistral-small", { input: 0.2, output: 0.6 }],
];

function findRate(model: string | null): ModelRate | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  for (const [key, rate] of PRICING) {
    if (lower.includes(key.toLowerCase())) return rate;
  }
  return null;
}

/**
 * Compute cost in USD for a given usage + model. Returns 0 if we don't
 * know the pricing for this model (don't let unknowns skew the budget).
 */
export function estimateCost(
  usage: NormalizedUsage | null,
  model: string | null,
): number {
  if (!usage) return 0;
  const rate = findRate(model);
  if (!rate) return 0;

  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheCreationTokens ?? 0;

  // Billed input excludes cached tokens (they're counted at the cache rate)
  const billedInput = Math.max(0, input - cacheRead - cacheWrite);

  const cost =
    (billedInput * rate.input) / 1_000_000 +
    (output * rate.output) / 1_000_000 +
    (cacheRead * (rate.cacheRead ?? rate.input)) / 1_000_000 +
    (cacheWrite * (rate.cacheWrite ?? rate.input)) / 1_000_000;

  return cost;
}

/** Total tokens used for rate-limit accounting. */
export function totalTokens(usage: NormalizedUsage | null): number {
  if (!usage) return 0;
  return (
    usage.totalTokens ??
    (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  );
}
