import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage } from "./types.js";

function asNumber(val: unknown): number | null {
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  return null;
}

/** Standard OpenAI-compatible usage extraction — works for many providers */
function extractOpenAIUsage(body: unknown): NormalizedUsage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const usage = b["usage"] as Record<string, unknown> | undefined;
  if (!usage) return null;

  return {
    inputTokens: asNumber(usage["prompt_tokens"]) ?? asNumber(usage["input_tokens"]),
    outputTokens: asNumber(usage["completion_tokens"]) ?? asNumber(usage["output_tokens"]),
    totalTokens: asNumber(usage["total_tokens"]),
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
  };
}

function extractModel(requestBody: unknown, responseBody: unknown): string | null {
  const resp = responseBody as Record<string, unknown> | null;
  if (resp && typeof resp["model"] === "string") return resp["model"];
  const req = requestBody as Record<string, unknown> | null;
  if (req && typeof req["model"] === "string") return req["model"];
  return null;
}

/** Cohere — api.cohere.com */
export const cohereExtractor: ProviderExtractor = {
  provider: Provider.Cohere,
  match(url: URL) { return url.hostname === "api.cohere.com"; },
  extractUsage(body: unknown): NormalizedUsage | null {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    // Cohere Chat API uses meta.tokens
    const meta = b["meta"] as Record<string, unknown> | undefined;
    if (meta) {
      const tokens = meta["tokens"] as Record<string, unknown> | undefined;
      if (tokens) {
        return {
          inputTokens: asNumber(tokens["input_tokens"]),
          outputTokens: asNumber(tokens["output_tokens"]),
          totalTokens: null,
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
        };
      }
    }
    // Fallback to OpenAI format (Cohere v2 API)
    return extractOpenAIUsage(body);
  },
  extractModel,
};

/** Mistral — api.mistral.ai */
export const mistralExtractor: ProviderExtractor = {
  provider: Provider.Mistral,
  match(url: URL) { return url.hostname === "api.mistral.ai"; },
  extractUsage: extractOpenAIUsage,
  extractModel,
};

/** Together AI — api.together.xyz */
export const togetherExtractor: ProviderExtractor = {
  provider: Provider.Together,
  match(url: URL) { return url.hostname === "api.together.xyz"; },
  extractUsage: extractOpenAIUsage,
  extractModel,
};

/** DeepSeek — api.deepseek.com */
export const deepseekExtractor: ProviderExtractor = {
  provider: Provider.DeepSeek,
  match(url: URL) { return url.hostname === "api.deepseek.com"; },
  extractUsage(body: unknown): NormalizedUsage | null {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    const usage = b["usage"] as Record<string, unknown> | undefined;
    if (!usage) return null;

    const details = usage["completion_tokens_details"] as Record<string, unknown> | undefined;

    return {
      inputTokens: asNumber(usage["prompt_tokens"]),
      outputTokens: asNumber(usage["completion_tokens"]),
      totalTokens: asNumber(usage["total_tokens"]),
      reasoningTokens: details ? asNumber(details["reasoning_tokens"]) : null,
      cacheReadTokens: asNumber(usage["prompt_cache_hit_tokens"]),
      cacheCreationTokens: asNumber(usage["prompt_cache_miss_tokens"]),
    };
  },
  extractModel,
};

/** Fireworks AI — api.fireworks.ai */
export const fireworksExtractor: ProviderExtractor = {
  provider: Provider.Fireworks,
  match(url: URL) { return url.hostname === "api.fireworks.ai"; },
  extractUsage: extractOpenAIUsage,
  extractModel,
};

/** Perplexity — api.perplexity.ai */
export const perplexityExtractor: ProviderExtractor = {
  provider: Provider.Perplexity,
  match(url: URL) { return url.hostname === "api.perplexity.ai"; },
  extractUsage: extractOpenAIUsage,
  extractModel,
};

/** Cerebras — api.cerebras.ai */
export const cerebrasExtractor: ProviderExtractor = {
  provider: Provider.Cerebras,
  match(url: URL) { return url.hostname === "api.cerebras.ai"; },
  extractUsage: extractOpenAIUsage,
  extractModel,
};
