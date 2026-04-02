import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage } from "./types.js";

/**
 * OpenRouter — OpenAI-compatible API at openrouter.ai
 * Response format matches OpenAI (prompt_tokens, completion_tokens, etc.)
 */
export const openrouterExtractor: ProviderExtractor = {
  provider: Provider.OpenRouter,

  match(url: URL): boolean {
    return url.hostname === "openrouter.ai";
  },

  extractUsage(body: unknown): NormalizedUsage | null {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    const usage = b["usage"] as Record<string, unknown> | undefined;
    if (!usage) return null;

    return {
      inputTokens: asNumber(usage["prompt_tokens"]),
      outputTokens: asNumber(usage["completion_tokens"]),
      totalTokens: asNumber(usage["total_tokens"]),
      reasoningTokens: null,
      cacheReadTokens: asNumber(usage["cached_tokens"]),
      cacheCreationTokens: asNumber(usage["cache_write_tokens"]),
    };
  },

  extractModel(requestBody: unknown, responseBody: unknown): string | null {
    const resp = responseBody as Record<string, unknown> | null;
    if (resp && typeof resp["model"] === "string") return resp["model"];
    const req = requestBody as Record<string, unknown> | null;
    if (req && typeof req["model"] === "string") return req["model"];
    return null;
  },

  injectStreamOptions(requestBody: unknown): unknown {
    if (!requestBody || typeof requestBody !== "object") return requestBody;
    const body = { ...(requestBody as Record<string, unknown>) };
    if (!body["stream"]) return requestBody;
    const existing = (body["stream_options"] as Record<string, unknown>) ?? {};
    body["stream_options"] = { ...existing, include_usage: true };
    return body;
  },
};

function asNumber(val: unknown): number | null {
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  return null;
}
