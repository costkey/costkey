import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage } from "./types.js";

/**
 * Groq — Fast inference API at api.groq.com
 * OpenAI-compatible response format
 */
export const groqExtractor: ProviderExtractor = {
  provider: Provider.Groq,

  match(url: URL): boolean {
    return url.hostname === "api.groq.com";
  },

  extractUsage(body: unknown): NormalizedUsage | null {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    const usage = b["usage"] as Record<string, unknown> | undefined;
    if (!usage) return null;

    // Groq uses input_tokens/output_tokens format
    const inputTokens = asNumber(usage["input_tokens"]) ?? asNumber(usage["prompt_tokens"]);
    const outputTokens = asNumber(usage["output_tokens"]) ?? asNumber(usage["completion_tokens"]);
    const totalTokens = asNumber(usage["total_tokens"]);

    const inputDetails = usage["input_tokens_details"] as Record<string, unknown> | undefined;
    const outputDetails = usage["output_tokens_details"] as Record<string, unknown> | undefined;

    return {
      inputTokens,
      outputTokens,
      totalTokens: totalTokens ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
      reasoningTokens: outputDetails ? asNumber(outputDetails["reasoning_tokens"]) : null,
      cacheReadTokens: inputDetails ? asNumber(inputDetails["cached_tokens"]) : null,
      cacheCreationTokens: null,
    };
  },

  extractModel(requestBody: unknown, responseBody: unknown): string | null {
    const resp = responseBody as Record<string, unknown> | null;
    if (resp && typeof resp["model"] === "string") return resp["model"];
    const req = requestBody as Record<string, unknown> | null;
    if (req && typeof req["model"] === "string") return req["model"];
    return null;
  },
};

function asNumber(val: unknown): number | null {
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  return null;
}
