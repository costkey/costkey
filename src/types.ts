/** Supported AI providers */
export enum Provider {
  OpenAI = "openai",
  Anthropic = "anthropic",
  Google = "google",
  Azure = "azure",
  Unknown = "unknown",
}

/** Normalized usage extracted from any provider's response */
export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

/** Timing data for streaming responses */
export interface StreamTiming {
  ttft: number | null;
  tps: number | null;
  streamDuration: number | null;
  chunkCount: number;
}

/** Captured call site from stack trace */
export interface CallSite {
  raw: string;
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
  traceId?: string;
  traceName?: string;
  [key: string]: string | number | boolean | undefined;
}

/** The core event that the SDK ships to costkey.dev */
export interface CostKeyEvent {
  id: string;
  timestamp: string;
  projectId: string;
  provider: Provider;
  model: string | null;
  url: string;
  method: string;
  statusCode: number | null;
  usage: NormalizedUsage | null;
  costUsd: number | null;
  durationMs: number;
  streaming: boolean;
  streamTiming: StreamTiming | null;
  callSite: CallSite | null;
  context: EventContext;
  requestBody: unknown | null;
  responseBody: unknown | null;
}

/** Provider extractor interface — one per AI provider */
export interface ProviderExtractor {
  provider: Provider;
  match(url: URL): boolean;
  extractUsage(body: unknown): NormalizedUsage | null;
  extractModel(requestBody: unknown, responseBody: unknown): string | null;
  injectStreamOptions?(requestBody: unknown): unknown;
}

/** Hook called before an event is sent — return null to drop the event */
export type BeforeSendHook = (
  event: CostKeyEvent,
) => CostKeyEvent | null | Promise<CostKeyEvent | null>;

/** SDK configuration options */
export interface CostKeyOptions {
  dsn: string;
  captureBody?: boolean;
  beforeSend?: BeforeSendHook;
  maxBatchSize?: number;
  flushInterval?: number;
  debug?: boolean;
  defaultContext?: EventContext;
}

/** Batched payload sent to the ingest API */
export interface TransportPayload {
  sdkVersion: string;
  events: CostKeyEvent[];
}
