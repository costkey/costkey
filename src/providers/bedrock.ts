import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage } from "./types.js";

/**
 * AWS Bedrock — Amazon's AI service
 * Endpoint: bedrock-runtime.{region}.amazonaws.com
 * Uses Converse API with TokenUsage in response
 */
export const bedrockExtractor: ProviderExtractor = {
  provider: Provider.Bedrock,

  match(url: URL): boolean {
    return url.hostname.includes("bedrock-runtime") && url.hostname.endsWith(".amazonaws.com");
  },

  extractUsage(body: unknown): NormalizedUsage | null {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;

    // Converse API format: usage.inputTokens, usage.outputTokens
    const usage = b["usage"] as Record<string, unknown> | undefined;
    if (usage) {
      return {
        inputTokens: asNumber(usage["inputTokens"]),
        outputTokens: asNumber(usage["outputTokens"]),
        totalTokens: asNumber(usage["totalTokens"]) ??
          (((asNumber(usage["inputTokens"]) ?? 0) + (asNumber(usage["outputTokens"]) ?? 0)) || null),
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      };
    }

    // InvokeModel format (older): varies by underlying model
    // Try OpenAI-style format as fallback
    const altUsage = b["amazon-bedrock-invocationMetrics"] as Record<string, unknown> | undefined;
    if (altUsage) {
      return {
        inputTokens: asNumber(altUsage["inputTokenCount"]),
        outputTokens: asNumber(altUsage["outputTokenCount"]),
        totalTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      };
    }

    return null;
  },

  extractModel(requestBody: unknown, responseBody: unknown): string | null {
    // Model is typically in the URL path for Bedrock, not the body
    // We'll extract it from the URL in the fetch-patch layer if needed
    const req = requestBody as Record<string, unknown> | null;
    if (req && typeof req["modelId"] === "string") return req["modelId"];
    return null;
  },
};

function asNumber(val: unknown): number | null {
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  return null;
}
