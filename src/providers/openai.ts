import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage } from "./types.js";

const OPENAI_HOSTS = new Set([
  "api.openai.com",
]);

/** Matches Azure OpenAI endpoints like xxx.openai.azure.com */
function isAzureOpenAI(hostname: string): boolean {
  return hostname.endsWith(".openai.azure.com");
}

export const openaiExtractor: ProviderExtractor = {
  provider: Provider.OpenAI,

  match(url: URL): boolean {
    return OPENAI_HOSTS.has(url.hostname) || isAzureOpenAI(url.hostname);
  },

  extractUsage(body: unknown): NormalizedUsage | null {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;

    // OpenAI Chat Completions & Responses API
    const usage = b["usage"] as Record<string, unknown> | undefined;
    if (!usage) return null;

    // Chat Completions format: prompt_tokens, completion_tokens
    // Responses API format: input_tokens, output_tokens
    const inputTokens =
      asNumber(usage["prompt_tokens"]) ?? asNumber(usage["input_tokens"]);
    const outputTokens =
      asNumber(usage["completion_tokens"]) ?? asNumber(usage["output_tokens"]);
    const totalTokens =
      asNumber(usage["total_tokens"]) ??
      (inputTokens != null && outputTokens != null
        ? inputTokens + outputTokens
        : null);

    // Reasoning tokens (o-series models)
    const details =
      (usage["completion_tokens_details"] as Record<string, unknown>) ??
      (usage["output_tokens_details"] as Record<string, unknown>);
    const reasoningTokens = details
      ? asNumber(details["reasoning_tokens"])
      : null;

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      reasoningTokens,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    };
  },

  extractModel(requestBody: unknown, responseBody: unknown): string | null {
    // Response body has the actual model used (may differ from requested)
    const resp = responseBody as Record<string, unknown> | null;
    if (resp && typeof resp["model"] === "string") return resp["model"];

    const req = requestBody as Record<string, unknown> | null;
    if (req && typeof req["model"] === "string") return req["model"];

    return null;
  },

  injectStreamOptions(requestBody: unknown): unknown {
    if (!requestBody || typeof requestBody !== "object") return requestBody;
    const body = { ...(requestBody as Record<string, unknown>) };

    // Only inject for streaming requests
    if (!body["stream"]) return requestBody;

    // Merge with existing stream_options, don't overwrite
    const existing =
      (body["stream_options"] as Record<string, unknown>) ?? {};
    body["stream_options"] = {
      ...existing,
      include_usage: true,
    };

    return body;
  },
};

function asNumber(val: unknown): number | null {
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  return null;
}
