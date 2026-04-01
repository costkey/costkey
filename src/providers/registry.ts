import type { ProviderExtractor } from "../types.js";
import { openaiExtractor } from "./openai.js";
import { anthropicExtractor } from "./anthropic.js";
import { googleExtractor } from "./google.js";

/** All registered provider extractors */
const extractors: ProviderExtractor[] = [
  openaiExtractor,
  anthropicExtractor,
  googleExtractor,
];

/**
 * Find the provider extractor that matches a URL.
 * Returns null for non-AI URLs (the fast path — most fetch calls hit this).
 */
export function findExtractor(url: URL): ProviderExtractor | null {
  for (const extractor of extractors) {
    if (extractor.match(url)) return extractor;
  }
  return null;
}

/** Register a custom provider extractor */
export function registerExtractor(extractor: ProviderExtractor): void {
  extractors.push(extractor);
}
