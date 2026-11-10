/**
 * The capture filter: which hosts are AI provider calls worth recording.
 *
 * This is the only provider knowledge left in the SDK. It decides whether a
 * request is captured, and for a few hosts whether to ask a streamed
 * Chat/Completions request to report usage in its final chunk
 * (`stream_options.include_usage`). Provider identity, model names and usage
 * are derived on the server from `telemetry.request.url` and the skeletons.
 */

/**
 * - `chat`: inject only into streamed Chat/Completions bodies (`messages` or
 *   `prompt`); the Responses API rejects the option.
 * - `always`: inject into any streamed body.
 */
export type StreamUsageInjection = "chat" | "always";

export interface CaptureTarget {
  /** A short label for debugging; never sent and never used for attribution. */
  readonly label: string;
  match(url: URL): boolean;
  readonly injectStreamUsage?: StreamUsageInjection;
}

function hosts(label: string, names: readonly string[], injectStreamUsage?: StreamUsageInjection): CaptureTarget {
  const set = new Set(names);
  return { label, match: (url) => set.has(url.hostname), injectStreamUsage };
}

function suffix(hostname: string, ...suffixes: string[]): boolean {
  return suffixes.some((value) => hostname.endsWith(value));
}

const OLLAMA_HOSTS = new Set(["localhost", "127.0.0.1"]);
const OLLAMA_PATH = /^\/(?:api\/(?:chat|generate|embed|embeddings)|v1\/.+)\/?$/;

const BUILT_IN_TARGETS: readonly CaptureTarget[] = [
  {
    label: "openai",
    match: (url) => url.hostname === "api.openai.com"
      || suffix(url.hostname, ".openai.azure.com", ".services.ai.azure.com", ".cognitiveservices.azure.com"),
    injectStreamUsage: "chat",
  },
  hosts("anthropic", ["api.anthropic.com"]),
  {
    label: "google",
    match: (url) => url.hostname === "generativelanguage.googleapis.com"
      || url.hostname === "aiplatform.googleapis.com"
      || url.hostname.endsWith("-aiplatform.googleapis.com"),
  },

  // Routers and gateways
  hosts("openrouter", ["openrouter.ai"], "always"),
  hosts("vercel", ["ai-gateway.vercel.sh"], "chat"),
  hosts("huggingface", ["router.huggingface.co", "api-inference.huggingface.co"], "chat"),
  hosts("openai-gateway", ["api.portkey.ai", "oai.helicone.ai", "gateway.helicone.ai"], "chat"),
  hosts("anthropic-gateway", ["anthropic.helicone.ai"]),
  {
    label: "cloudflare",
    match: (url) => url.hostname === "api.cloudflare.com" && url.pathname.includes("/ai/"),
  },

  // Cloud providers
  {
    label: "bedrock",
    match: (url) => url.hostname.includes("bedrock-runtime") && url.hostname.endsWith(".amazonaws.com"),
  },

  // Fast inference
  hosts("groq", ["api.groq.com"]),
  hosts("cerebras", ["api.cerebras.ai"]),
  hosts("fireworks", ["api.fireworks.ai"]),
  hosts("together", ["api.together.xyz"]),
  hosts("deepinfra", ["api.deepinfra.com"], "chat"),
  hosts("nvidia", ["integrate.api.nvidia.com"], "chat"),
  hosts("sambanova", ["api.sambanova.ai"], "chat"),
  hosts("novita", ["api.novita.ai"], "chat"),
  hosts("hyperbolic", ["api.hyperbolic.xyz"], "chat"),
  hosts("nebius", ["api.studio.nebius.com", "api.studio.nebius.ai", "api.tokenfactory.nebius.com"], "chat"),
  hosts("baseten", ["inference.baseten.co"], "chat"),
  hosts("lambda", ["api.lambda.ai"], "chat"),
  hosts("featherless", ["api.featherless.ai"], "chat"),
  hosts("friendli", ["api.friendli.ai"], "chat"),

  // Model providers
  hosts("xai", ["api.x.ai", "api.grok.xai.com"], "always"),
  hosts("mistral", ["api.mistral.ai"]),
  hosts("deepseek", ["api.deepseek.com"]),
  hosts("cohere", ["api.cohere.com", "api.cohere.ai"]),
  hosts("perplexity", ["api.perplexity.ai"]),
  hosts("typesafe", ["api.typesafe.ai"]),
  hosts("alibaba", ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"], "chat"),
  hosts("moonshot", ["api.moonshot.ai", "api.moonshot.cn"]),
  hosts("zai", ["api.z.ai", "open.bigmodel.cn"]),
  hosts("minimax", ["api.minimax.io", "api.minimaxi.com", "api.minimax.chat"]),
  hosts("ai21", ["api.ai21.com"]),
  hosts("upstage", ["api.upstage.ai"]),
  hosts("sarvam", ["api.sarvam.ai"]),

  // Local
  {
    label: "ollama",
    match: (url) => OLLAMA_HOSTS.has(url.hostname) && url.port === "11434" && OLLAMA_PATH.test(url.pathname),
    injectStreamUsage: "chat",
  },

  // Embeddings and rerank
  hosts("voyage", ["api.voyageai.com"]),
  hosts("jina", ["api.jina.ai"]),

  // Voice
  { label: "elevenlabs", match: (url) => url.hostname.endsWith(".elevenlabs.io") },
  { label: "rumik", match: (url) => url.hostname.endsWith(".rumik.ai") },
  hosts("deepgram", ["api.deepgram.com"]),
  hosts("assemblyai", ["api.assemblyai.com", "api.eu.assemblyai.com"]),
  hosts("cartesia", ["api.cartesia.ai"]),

  // Search and scraping
  hosts("exa", ["api.exa.ai"]),
  hosts("firecrawl", ["api.firecrawl.dev"]),
  hosts("tavily", ["api.tavily.com"]),
];

/** Hosts added at runtime: project configuration (custom providers) and tests. */
const extraTargets: CaptureTarget[] = [];

/** The capture target for a URL, or null for a request CostKey ignores (the fast path). */
export function findCaptureTarget(url: URL): CaptureTarget | null {
  // The OpenAI Agents SDK exports its own traces here; it is not a model call.
  if (url.hostname === "api.openai.com" && url.pathname.startsWith("/v1/traces/")) return null;
  for (const target of BUILT_IN_TARGETS) {
    if (target.match(url)) return target;
  }
  for (const target of extraTargets) {
    if (target.match(url)) return target;
  }
  return null;
}

/** Add a host to the capture filter. Returns a function that removes it. */
export function addCaptureTarget(target: CaptureTarget): () => void {
  if (!extraTargets.includes(target)) extraTargets.push(target);
  return () => removeCaptureTarget(target);
}

export function removeCaptureTarget(target: CaptureTarget): void {
  const index = extraTargets.indexOf(target);
  if (index >= 0) extraTargets.splice(index, 1);
}

/** A capture target for a configured hostname (`api.example.com` or `*.example.com`). */
export function hostnameTarget(hostname: string): CaptureTarget | null {
  const normalized = hostname.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
  if (!normalized) return null;
  return {
    label: `custom:${normalized}`,
    match(url: URL): boolean {
      if (normalized.startsWith("*.")) return url.hostname.endsWith(normalized.slice(1));
      return url.hostname === normalized || url.host === normalized;
    },
  };
}

/**
 * Ask a streamed request to report usage in its final chunk, keeping any
 * caller stream options. Returns the same object when nothing changes.
 */
export function injectStreamUsage(target: CaptureTarget, requestBody: unknown): unknown {
  const mode = target.injectStreamUsage;
  if (!mode || !requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return requestBody;
  const body = requestBody as Record<string, unknown>;
  if (!body["stream"]) return requestBody;
  if (mode === "chat" && body["messages"] === undefined && body["prompt"] === undefined) return requestBody;
  const existing = body["stream_options"];
  return {
    ...body,
    stream_options: {
      ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Record<string, unknown> : {}),
      include_usage: true,
    },
  };
}
