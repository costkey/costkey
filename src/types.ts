/** Supported AI providers */
export enum Provider {
  OpenAI = "openai",
  Anthropic = "anthropic",
  Google = "google",
  Azure = "azure",
  Groq = "groq",
  xAI = "xai",
  Mistral = "mistral",
  DeepSeek = "deepseek",
  Cohere = "cohere",
  Together = "together",
  Fireworks = "fireworks",
  Perplexity = "perplexity",
  Cerebras = "cerebras",
  OpenRouter = "openrouter",
  Bedrock = "bedrock",
  Unknown = "unknown",
}

/** Normalized usage extracted from any provider's response */
export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Reasoning/thinking tokens (OpenAI o-series, Anthropic extended thinking) */
  reasoningTokens: number | null;
  /** Cache-related tokens (Anthropic prompt caching) */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

/** Timing data for streaming responses */
export interface StreamTiming {
  /** Time to first byte/token in ms */
  ttft: number | null;
  /** Tokens per second (output) */
  tps: number | null;
  /** Total stream duration in ms */
  streamDuration: number | null;
  /** Number of chunks received */
  chunkCount: number;
}

/** Captured call site from stack trace */
export interface CallSite {
  /** Raw stack trace string */
  raw: string;
  /** Parsed frames (outermost first) */
  frames: StackFrame[];
}

export interface StackFrame {
  functionName: string | null;
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
}

/** User-provided context via withContext() or manual tags */
export interface EventContext {
  task?: string;
  team?: string;
  /** Auto-generated trace ID for grouping calls within a request/operation */
  traceId?: string;
  /** Human-readable trace name (e.g., route path, job name) */
  traceName?: string;
  [key: string]: string | number | boolean | undefined;
}

/** The core event that the SDK ships to costkey.dev */
export interface CostKeyEvent {
  /** Unique event ID */
  id: string;
  /** ISO timestamp */
  timestamp: string;
  /** Project identifier from DSN */
  projectId: string;

  /** Provider that served this request */
  provider: Provider;
  /** Model name as returned by the provider */
  model: string | null;
  /** The full request URL */
  url: string;
  /** HTTP method */
  method: string;
  /** HTTP status code of the response */
  statusCode: number | null;

  /** Normalized token usage */
  usage: NormalizedUsage | null;
  /** Estimated cost in USD */
  costUsd: number | null;

  /** Total request duration in ms */
  durationMs: number;
  /** Whether this was a streaming request */
  streaming: boolean;
  /** Streaming timing metrics */
  streamTiming: StreamTiming | null;

  /** Call site captured from stack trace */
  callSite: CallSite | null;
  /** User-provided context */
  context: EventContext;

  /** Request body (prompt) — captured if captureBody is enabled */
  requestBody: unknown | null;
  /** Response body (completion) — captured if captureBody is enabled */
  responseBody: unknown | null;
}

/** Provider extractor interface — one per AI provider */
export interface ProviderExtractor {
  /** Provider identifier */
  provider: Provider;
  /** Check if a URL belongs to this provider */
  match(url: URL): boolean;
  /** Extract normalized usage from the response body */
  extractUsage(body: unknown): NormalizedUsage | null;
  /** Extract the model name from request or response body */
  extractModel(requestBody: unknown, responseBody: unknown): string | null;
  /** Optionally modify request body before sending (e.g., inject stream_options) */
  injectStreamOptions?(requestBody: unknown): unknown;
}

/** Hook called before an event is sent — return null to drop the event */
export type BeforeSendHook = (
  event: CostKeyEvent,
) => CostKeyEvent | null | Promise<CostKeyEvent | null>;

/** SDK configuration options */
export interface CostKeyOptions {
  /** DSN in format https://<key>@costkey.dev/<project-id> */
  dsn: string;
  /** Capture request/response bodies (default: true) */
  captureBody?: boolean;
  /** Hook to modify/filter events before sending */
  beforeSend?: BeforeSendHook;
  /** Max events to buffer before flushing (default: 50) */
  maxBatchSize?: number;
  /** Flush interval in ms (default: 5000) */
  flushInterval?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Additional default context applied to all events */
  defaultContext?: EventContext;
  /** Release version — used for sourcemap translation on the server */
  release?: string;
}

/** Batched payload sent to the ingest API */
export interface TransportPayload {
  /** SDK version */
  sdkVersion: string;
  /** Release version (for sourcemap translation) */
  release?: string;
  /** Events in this batch */
  events: CostKeyEvent[];
}
