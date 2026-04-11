import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage } from "./types.js";

const GOOGLE_HOSTS = new Set([
  "generativelanguage.googleapis.com",
]);

/** Matches Vertex AI endpoints like xxx-aiplatform.googleapis.com */
function isVertexAI(hostname: string): boolean {
  return hostname.endsWith("-aiplatform.googleapis.com");
}

export const googleExtractor: ProviderExtractor = {
  provider: Provider.Google,

  match(url: URL): boolean {
    return GOOGLE_HOSTS.has(url.hostname) || isVertexAI(url.hostname);
  },

  extractUsage(body: unknown): NormalizedUsage | null {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;

    const metadata = b["usageMetadata"] as Record<string, unknown> | undefined;
    if (!metadata) return null;

    const inputTokens = asNumber(metadata["promptTokenCount"]);
    const outputTokens = asNumber(metadata["candidatesTokenCount"]);
    const totalTokens =
      asNumber(metadata["totalTokenCount"]) ??
      (inputTokens != null && outputTokens != null
        ? inputTokens + outputTokens
        : null);

    const thoughtsTokens = asNumber(metadata["thoughtsTokenCount"]);

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      reasoningTokens: thoughtsTokens,
      cacheReadTokens: asNumber(metadata["cachedContentTokenCount"]),
      cacheCreationTokens: null,
    };
  },

  extractModel(requestBody: unknown, responseBody: unknown): string | null {
    // Google returns modelVersion in response
    const resp = responseBody as Record<string, unknown> | null;
    if (resp && typeof resp["modelVersion"] === "string")
      return resp["modelVersion"];

    // Some wrappers include model in the response top-level
    if (resp && typeof resp["model"] === "string")
      return resp["model"];

    // Check request body (some SDKs include model there)
    const req = requestBody as Record<string, unknown> | null;
    if (req && typeof req["model"] === "string")
      return req["model"];

    return null;
  },

  // Google includes usageMetadata in streaming by default — no injection needed
};

function asNumber(val: unknown): number | null {
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  return null;
}
