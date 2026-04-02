import type { ProviderExtractor } from "./types.js";
import { openaiExtractor } from "./openai.js";
import { anthropicExtractor } from "./anthropic.js";
import { googleExtractor } from "./google.js";
import { openrouterExtractor } from "./openrouter.js";
import { xaiExtractor } from "./xai.js";
import { groqExtractor } from "./groq.js";
import { bedrockExtractor } from "./bedrock.js";
import {
  cohereExtractor,
  mistralExtractor,
  togetherExtractor,
  deepseekExtractor,
  fireworksExtractor,
  perplexityExtractor,
  cerebrasExtractor,
  portkeyExtractor,
  heliconeExtractor,
} from "./more.js";

/** All registered provider extractors — checked in order */
const extractors: ProviderExtractor[] = [
  // Major providers
  openaiExtractor,       // api.openai.com, *.openai.azure.com
  anthropicExtractor,    // api.anthropic.com
  googleExtractor,       // generativelanguage.googleapis.com, *-aiplatform.googleapis.com

  // Aggregators / routers
  openrouterExtractor,   // openrouter.ai

  // Cloud providers
  bedrockExtractor,      // bedrock-runtime.*.amazonaws.com

  // Fast inference
  groqExtractor,         // api.groq.com
  cerebrasExtractor,     // api.cerebras.ai
  fireworksExtractor,    // api.fireworks.ai
  togetherExtractor,     // api.together.xyz

  // Model providers
  xaiExtractor,          // api.x.ai, api.grok.xai.com
  mistralExtractor,      // api.mistral.ai
  deepseekExtractor,     // api.deepseek.com
  cohereExtractor,       // api.cohere.com
  perplexityExtractor,   // api.perplexity.ai

  // AI proxies/gateways
  portkeyExtractor,      // api.portkey.ai
  heliconeExtractor,     // *.helicone.ai
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
