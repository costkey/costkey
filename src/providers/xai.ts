import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage } from "./types.js";

/**
 * xAI (Grok) — OpenAI-compatible API at api.x.ai
 */
export const xaiExtractor: ProviderExtractor = {
  provider: Provider.xAI,

  match(url: URL): boolean {
    return url.hostname === "api.x.ai" || url.hostname === "api.grok.xai.com";
  },

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
      cacheReadTokens: null,
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
