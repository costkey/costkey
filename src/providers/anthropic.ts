import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage } from "./types.js";

const ANTHROPIC_HOSTS = new Set([
  "api.anthropic.com",
]);

export const anthropicExtractor: ProviderExtractor = {
  provider: Provider.Anthropic,

  match(url: URL): boolean {
    return ANTHROPIC_HOSTS.has(url.hostname);
  },

  extractUsage(body: unknown): NormalizedUsage | null {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;

    const usage = b["usage"] as Record<string, unknown> | undefined;
    if (!usage) return null;

    const inputTokens = asNumber(usage["input_tokens"]);
    const outputTokens = asNumber(usage["output_tokens"]);
    const totalTokens =
      inputTokens != null && outputTokens != null
        ? inputTokens + outputTokens
        : null;

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      reasoningTokens: null,
      cacheReadTokens: asNumber(usage["cache_read_input_tokens"]),
      cacheCreationTokens: asNumber(usage["cache_creation_input_tokens"]),
    };
  },

  extractModel(requestBody: unknown, responseBody: unknown): string | null {
    const resp = responseBody as Record<string, unknown> | null;
    if (resp && typeof resp["model"] === "string") return resp["model"];

    const req = requestBody as Record<string, unknown> | null;
    if (req && typeof req["model"] === "string") return req["model"];

    return null;
  },

  // Anthropic includes usage in streaming by default — no injection needed
};

function asNumber(val: unknown): number | null {
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  return null;
}
