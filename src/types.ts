import type { CallTelemetry } from "./telemetry.js";
import type { FrameRef } from "./frames.js";

export type { CallTelemetry } from "./telemetry.js";
export type { FrameRef } from "./frames.js";

/**
 * Provider labels. Deprecated in 0.7.0: the SDK no longer labels calls; the
 * server derives the provider from `telemetry.request.url`.
 */
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
  ElevenLabs = "elevenlabs",
  Rumik = "rumik",
  Exa = "exa",
  Firecrawl = "firecrawl",
  Typesafe = "typesafe",
  // OpenAI-compatible inference hosts
  DeepInfra = "deepinfra",
  Nvidia = "nvidia",
  SambaNova = "sambanova",
  Novita = "novita",
  Hyperbolic = "hyperbolic",
  Nebius = "nebius",
  Alibaba = "alibaba",
  Moonshot = "moonshot",
  ZAI = "zai",
  MiniMax = "minimax",
  HuggingFace = "huggingface",
  Baseten = "baseten",
  Lambda = "lambda",
  Featherless = "featherless",
  Friendli = "friendli",
  AI21 = "ai21",
  Upstage = "upstage",
  Sarvam = "sarvam",
  Cloudflare = "cloudflare",
  Vercel = "vercel",
  Ollama = "ollama",
  // Speech, embeddings and search
  Deepgram = "deepgram",
  AssemblyAI = "assemblyai",
  Cartesia = "cartesia",
  Voyage = "voyage",
  Jina = "jina",
  Tavily = "tavily",
  Unknown = "unknown",
}

/**
 * Normalized usage shape still accepted from callers of `recordUsage`. The
 * SDK never derives it from provider payloads.
 */
export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Reasoning/thinking tokens (OpenAI o-series, Anthropic extended thinking) */
  reasoningTokens: number | null;
  /** Cache-related tokens (Anthropic prompt caching) */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** Provider-reported total cost in USD (for routers such as OpenRouter). */
  costUsd?: number | null;
  /** Image tokens included in outputTokens; absent means the breakdown is unknown. */
  imageOutputTokens?: number | null;
  /**
   * Non-token billable units the server prices from its catalog: `characters`,
   * `audioSeconds`, `searchQueries`, `searchResults`, `groundingRequests`,
   * `mapsGroundingRequests`, `credits`, `pages`, `images`, `requests`.
   * Absent means none were observed, not zero.
   */
  nativeUnits?: Record<string, number>;
}

/** Captured call site from stack trace */
export interface CallSite {
  /** Raw stack trace string */
  raw: string;
  /** Every parsed frame, innermost first, unfiltered (the server picks the call site). */
  frames: StackFrame[];
}

export interface StackFrame {
  functionName: string | null;
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  /** Source context, only on in-app frames whose file could be read (Node only). */
  contextLine?: string;
  preContext?: string[];
  postContext?: string[];
}

/** User-provided context via withContext() or manual tags */
export interface EventContext {
  task?: string;
  team?: string;
  /** Auto-generated trace ID for grouping calls within a request/operation */
  traceId?: string;
  /** Human-readable trace name (e.g., route path, job name) */
  traceName?: string;
  /** Stable grouped-work identity (batch, experiment, or evaluation suite). */
  groupId?: string;
  groupName?: string;
  /** Group kind supplied by the application (for example `batch`). */
  groupKind?: string;
  /** Fresh invocation identity for grouped work. */
  executionId?: string;
  /** Explicit provider/framework attempt identity for one call or component. */
  attemptId?: string;
  /** Explicit relationship to a known parent attempt/event. */
  parentEventId?: string;
  /** Conversation identity supplied by the application or integration. */
  conversationId?: string;
  /** Voice session identity supplied by the application or integration. */
  voiceSessionId?: string;
  /** The span (agent, step, tool...) the current code runs inside. */
  spanId?: string;
  /** Name of the nearest enclosing agent span; calls inherit it for cost slicing. */
  agent?: string;
  /** Name of the nearest enclosing tool span. */
  tool?: string;
  /** End user the work is done for (first-class attribution). */
  userId?: string;
  [key: string]: string | number | boolean | undefined;
}

/** Values that are safe to carry over an explicit service/queue handoff. */
export type ContextCarrier = Pick<
  EventContext,
  | "traceId"
  | "traceName"
  | "groupId"
  | "groupName"
  | "groupKind"
  | "executionId"
  | "feature"
  | "customer"
  | "customerId"
  | "environment"
  | "service"
  | "release"
  | "function"
  | "operation"
  | "phase"
  | "caseId"
  | "datasetRevision"
  | "conversationId"
  | "voiceSessionId"
  | "spanId"
  | "agent"
  | "tool"
  | "userId"
>;

export type TraceLifecycle = "started" | "completed" | "failed" | "cancelled";

/** What a span represents. Calls inside a span are attributed to it. */
export type SpanKind =
  | "agent"
  | "step"
  | "tool"
  | "workflow"
  | "task"
  | "judge"
  | "retrieval"
  | "handoff"
  | "guardrail"
  | "chain"
  | "custom";

export type SpanStatus = "running" | "ok" | "error" | "cancelled";

export type SpanAttributeValue = string | number | boolean | null;

export interface SpanOptions {
  /** Stable, low-cardinality name: the agent, tool or step name. */
  name: string;
  kind?: SpanKind;
  /** Small searchable attributes (model, step number, tool version...). */
  attributes?: Record<string, SpanAttributeValue>;
  /** Input payload; only sent when body capture is enabled. */
  input?: unknown;
  /** Resume a span started in another process (for example after a pause). */
  spanId?: string;
  /** Explicit parent when it can't be inherited (a resumed child span). */
  parentSpanId?: string;
  /** Additional labels merged into inherited context for calls in this span. */
  context?: EventContext;
}

/** Handle passed to the span callback. */
export interface SpanHandle {
  readonly id: string;
  readonly traceId: string;
  /** Add or update an attribute; sent with the span's end. */
  setAttribute(key: string, value: SpanAttributeValue): void;
  /** Record the span's output; only sent when body capture is enabled. */
  setOutput(value: unknown): void;
}

export interface CostKeySpanEvent {
  id: string;
  timestamp: string;
  projectId: string;
  eventType: "span";
  source: "explicit";
  kind: SpanKind;
  name: string;
  status: SpanStatus;
  traceId: string;
  traceName?: string;
  parentSpanId?: string;
  executionId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** Raw JS error name (contract detail 7). */
  errorName?: string;
  /** Legacy alias of errorName, same raw value. */
  errorType?: string;
  attributes?: Record<string, unknown>;
  context: EventContext;
  /** Where the span was opened (raw stack). */
  callSite?: CallSite | null;
}
export type ExecutionLifecycle = TraceLifecycle;

export interface TraceOptions {
  /** Human-readable operation name. */
  name?: string;
  /** Reuse a compatible upstream trace identity when one already exists. */
  traceId?: string;
  /** Additional boundary labels merged into inherited context. */
  context?: EventContext;
}

export interface ExecutionOptions {
  /** Stable group name reused by later invocations. */
  name: string;
  /** Optional explicit stable group name when `name` is a display label. */
  groupName?: string;
  /** Group kind, such as `batch`, `experiment`, or `evaluation`. */
  kind?: string;
  /** Explicit invocation identity supplied by an external runner. */
  executionId?: string;
  /** Optional stable group identifier when a name is not globally unique. */
  groupId?: string;
  /** Expected item count supplied by the runner. */
  expectedItems?: number;
  /** Items the runner completed when this invocation ended or was updated. */
  completedItems?: number;
  /** Items the runner failed when this invocation ended or was updated. */
  failedItems?: number;
  /** Configuration/variant metadata supplied by the runner. */
  configuration?: Record<string, unknown>;
  datasetRevision?: string;
  caseId?: string;
  phase?: string;
  /** Additional boundary labels merged into inherited context. */
  context?: EventContext;
}

interface LifecycleEventBase {
  id: string;
  timestamp: string;
  projectId: string;
  eventType: "lifecycle";
  source: "explicit";
  entityType: "trace" | "execution";
  entityId: string;
  lifecycle: TraceLifecycle;
  /** Per-entity ordering fence; repeated/resumed scopes advance it. */
  sequence: number;
  traceId?: string;
  traceName?: string;
  groupId?: string;
  groupName?: string;
  groupKind?: string;
  executionId?: string;
  phase?: string;
  datasetRevision?: string;
  caseId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** Raw JS error name (contract detail 7). */
  errorName?: string;
  /** Legacy alias of errorName, same raw value. */
  errorType?: string;
  expectedItems?: number;
  completedItems?: number;
  failedItems?: number;
  configuration?: Record<string, unknown>;
  context: EventContext;
  provider?: Provider | string;
  model?: string | null;
  url?: string;
  method?: string;
  statusCode?: number | null;
  usage?: NormalizedUsage | UsageUnits | null;
  costUsd?: number | null;
  streaming?: boolean;
  callSite?: CallSite | null;
  requestBody?: unknown | null;
  responseBody?: unknown | null;
}

export type CostKeyLifecycleEvent = LifecycleEventBase;

export type UsageAggregation = "delta" | "cumulative";

export interface UsageAmount {
  value: number;
  currency: string;
}

export type UsageUnits = Record<string, number | null>;

export type PolicyMode = "monitor" | "enforce";

export type PolicyRefusalReason =
  | "budget_exhausted"
  | "price_unavailable"
  | "decision_unavailable"
  | "unsupported_integration"
  | "unbounded_request"
  | "missing_context"
  | "idempotency_conflict"
  | (string & {});

export interface PolicyIntegrationProof {
  supported: boolean;
  admissionSupported: boolean;
  capabilityVersion?: string;
  verified: boolean;
}

export interface PolicyAdmissionRequest {
  projectId: string;
  admissionId: string;
  requestId?: string | null;
  traceId?: string | null;
  executionId?: string | null;
  scope?: Record<string, string>;
  context?: EventContext;
  integration?: PolicyIntegrationProof;
  /**
   * The request as it is about to be sent (skeleton, no content). The server
   * identifies the provider and estimates usage bounds from it.
   */
  telemetry?: { v: 1; request: CallTelemetry["request"] };
}

export interface PolicyAdmissionResult {
  decision: "allow" | "refuse";
  replay?: boolean;
  providerCallAllowed?: boolean;
  reservationId?: string | null;
  reservation?: Record<string, unknown> | null;
  policyId?: string;
  policyVersion?: number | null;
  reason?: PolicyRefusalReason;
  message?: string;
  scope?: Record<string, string>;
  allowance?: Record<string, unknown>;
  window?: string;
  retryAt?: string | null;
  policies?: Array<Record<string, unknown>>;
}

export interface PolicySettlementRequest {
  projectId: string;
  reservationId: string;
  settlementId: string;
  outcome: "success" | "failed" | "cancelled" | "unknown";
  providerAttempted?: boolean;
}

export type PolicyAdmissionHandler = (
  request: PolicyAdmissionRequest,
) => PolicyAdmissionResult | boolean | Promise<PolicyAdmissionResult | boolean>;

export interface PolicyOptions {
  /** Monitor makes no blocking decision; enforce fails closed. */
  mode?: PolicyMode;
  /**
   * Optional custom handler (your code decides). Without it, the
   * DSN-authenticated endpoint decides.
   */
  admission?: PolicyAdmissionHandler;
  /** Override the DSN-derived endpoint for a trusted compatible server. */
  endpoint?: string;
  /** Request timeout for admission/settlement calls. */
  timeout?: number;
  integration?: PolicyIntegrationProof;
  scope?: Record<string, string>;
}

export interface RuntimeCaptureConfig {
  projectId: string;
  capture: {
    mode: "metadata" | "text";
    bodyCaptureEnabled: boolean;
    redactionEnabled: boolean;
    bodyRetentionDays?: number;
    metadataRetentionDays?: number;
    /** Project allows screen capture (absent means off). */
    screenCaptureEnabled?: boolean;
  };
  providers?: Array<Record<string, unknown>>;
}

export interface RecordUsageEvent {
  /** Caller-supplied stable event/envelope identity. */
  id: string;
  /** Stable component identity, for example `tts:session-42`. */
  componentId?: string;
  /** Migration alias for componentId. */
  component?: string;
  /** Stable billable charge identity used to reconcile auto/manual reports. */
  chargeId?: string;
  /** Provider request identity when an explicit adapter can observe it. */
  providerRequestId?: string;
  /** Logical attempt identity when the provider/framework exposes one. */
  attemptId?: string;
  /** Parent event identity for a manual component attached to an auto call. */
  parentEventId?: string;
  /** Monotonic component revision. */
  revision: number;
  /** Whether usage is an increment or a total snapshot. */
  aggregation: UsageAggregation;
  /** Provider or custom component that produced the usage. */
  provider?: Provider | string;
  model?: string | null;
  /** Native usage units; omission is unknown, not zero. */
  usage?: UsageUnits | NormalizedUsage | null;
  /** Migration alias for usage. */
  nativeUsage?: UsageUnits | NormalizedUsage | null;
  nativeUnits?: UsageUnits | NormalizedUsage | null;
  /** Optional exact billable-unit map for adapters with multiple unit families. */
  billingUnits?: UsageUnits | null;
  /** Reported monetary amount and currency. */
  amount?: UsageAmount | number | null;
  /** Alias accepted for adapters that call the amount a cost. */
  cost?: UsageAmount | number | null;
  /** Convenience alias for a USD-reported amount. */
  costUsd?: number | null;
  /** Currency for scalar amount/costUsd aliases. */
  currency?: string;
  /** Stable pricing/rate identity when amount is not directly reported. */
  pricingId?: string;
  amountKind?: "reported" | "estimated";
  unitKind?: string;
  unitValue?: number;
  unit?: string;
  timestamp?: string | Date;
  context?: EventContext | ContextCarrier;
  traceId?: string;
  executionId?: string;
  metadata?: Record<string, unknown>;
  /** Raw telemetry an adapter observed (LiveKit rows); sent as given. */
  telemetry?: UsageTelemetry;
}

/** Raw telemetry on an explicit usage event, e.g. a LiveKit session snapshot. */
export interface UsageTelemetry {
  v: 1;
  source: string;
  [key: string]: unknown;
}

export interface CostKeyUsageEvent {
  id: string;
  timestamp: string;
  projectId: string;
  eventType: "usage";
  source: "explicit";
  component?: string;
  componentId: string;
  chargeId: string;
  revision: number;
  aggregation: UsageAggregation;
  provider: Provider | string;
  model: string | null;
  providerRequestId?: string | null;
  attemptId?: string | null;
  parentEventId?: string | null;
  usage: UsageUnits | null;
  nativeUsage: UsageUnits | null;
  billingUnits?: UsageUnits | null;
  amount?: UsageAmount | null;
  costUsd: number | null;
  currency: string;
  pricingId?: string;
  amountKind?: "reported" | "estimated";
  unitKind?: string;
  unitValue?: number;
  unit?: string;
  context: EventContext;
  traceId?: string;
  executionId?: string;
  metadata?: Record<string, unknown>;
  usageEvent: Record<string, unknown>;
  groupId?: string;
  groupName?: string;
  groupKind?: string;
  phase?: string;
  datasetRevision?: string;
  caseId?: string;
  url?: string;
  method?: string;
  statusCode?: number | null;
  durationMs?: number;
  streaming?: boolean;
  callSite?: CallSite | null;
  requestBody?: unknown | null;
  responseBody?: unknown | null;
  /** Raw telemetry for integration-reported usage (LiveKit rows). */
  telemetry?: UsageTelemetry;
}

export type CostKeyTelemetryEvent =
  | CostKeyEvent
  | CostKeyLifecycleEvent
  | CostKeyUsageEvent
  | CostKeySpanEvent;

/** Explicit (non-call) events that pass through `beforeSendEvent`. */
export type CostKeyAdditiveEvent =
  | CostKeyLifecycleEvent
  | CostKeyUsageEvent
  | CostKeySpanEvent;

export type BeforeSendEventHook = (
  event: CostKeyAdditiveEvent,
) =>
  | CostKeyAdditiveEvent
  | null
  | Promise<CostKeyAdditiveEvent | null>;

/**
 * A captured provider call. The SDK sends only what it observed: `telemetry`
 * (request/response/stream skeletons, headers, timing) carries everything the
 * server needs to identify the provider and model and to count usage.
 */
export interface CostKeyEvent {
  /** Unique event ID (also the policy admission ID). */
  id: string;
  eventType: "call";
  source: "auto";
  /** ISO timestamp of the request start. */
  timestamp: string;
  /** Project identifier from DSN */
  projectId: string;
  /** Request URL without userinfo, query or fragment (legacy; see telemetry.request.url). */
  url: string;
  /** HTTP method */
  method: string;
  /** HTTP status code of the response; null when no response arrived. */
  statusCode: number | null;
  /** Total request duration in ms (to the end of the body or stream). */
  durationMs: number;
  /** Whether the response was read as a stream (telemetry.stream is set). */
  streaming: boolean;
  /** Call site captured from stack trace (every frame). */
  callSite: CallSite | null;
  /** User-provided context */
  context: EventContext;
  /** Caller-supplied attempt label, or the event ID. */
  attemptId?: string | null;
  /** The span this call ran inside. */
  spanId?: string | null;
  /** Known parent attempt/event for a retry or fallback; never inferred by the SDK. */
  parentEventId?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  groupKind?: string | null;
  executionId?: string | null;
  phase?: string | null;
  datasetRevision?: string | null;
  caseId?: string | null;
  /** Request body content, only when body capture is enabled (scrubbed, never truncated). */
  requestBody: unknown | null;
  /** Response body content, only when body capture is enabled (scrubbed, never truncated). */
  responseBody: unknown | null;
  /**
   * Images in the request, in order (newest last), only when screen capture
   * is on. Each is uploaded separately, once, by hash.
   */
  frames?: FrameRef[];
  /** Raw telemetry (contract v1): always present, never content. */
  telemetry: CallTelemetry;
}

/** Hook called before an event is sent — return null to drop the event */
export type BeforeSendHook = (
  event: CostKeyEvent,
) => CostKeyEvent | null | Promise<CostKeyEvent | null>;

/** SDK configuration options */
export interface CostKeyOptions {
  /** DSN in format https://<key>@costkey.dev/<project-id>. Falls back to COSTKEY_DSN env var. Omit both to disable (test mode). */
  dsn?: string;
  /** Capture request/response bodies (default: true; media bytes are omitted, text is sent whole) */
  captureBody?: boolean;
  /**
   * Upload images sent to the model, such as an agent's screenshots, so the
   * console can replay the run (default: false). Also needs screen capture
   * turned on for the project. Each image is uploaded once.
   */
  captureScreens?: boolean;
  /** Hook to modify/filter events before sending */
  beforeSend?: BeforeSendHook;
  /** Hook for additive lifecycle and explicit usage records. */
  beforeSendEvent?: BeforeSendEventHook;
  /** Explicit pre-call policy admission; omitted means observation only. */
  policy?: PolicyOptions;
  /** Runtime privacy/provider configuration is fetched asynchronously. */
  configRefreshInterval?: number;
  /** Max events to buffer before flushing (default: 50) */
  maxBatchSize?: number;
  /** Flush interval in ms (default: 5000) */
  flushInterval?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Additional default context applied to all events */
  defaultContext?: EventContext;
  /**
   * Release version — used for sourcemap translation on the server, and to
   * compare deploys. Defaults to COSTKEY_RELEASE, then the commit SHA.
   */
  release?: string;
  /** Commit SHA of the running code. Detected from CI/platform variables or .git when unset. */
  commit?: string;
  /** Source repository URL, so the console links releases to commits. Detected when unset. */
  repository?: string;
}

/** Batched payload sent to the ingest API */
export interface TransportPayload {
  /** SDK version */
  sdkVersion: string;
  /** Release version (for sourcemap translation); the commit SHA unless set */
  release?: string;
  /** Full commit SHA of the running code, when known */
  commit?: string;
  /** Source repository as an https URL, when known */
  repository?: string;
  /** Events in this batch */
  events: CostKeyTelemetryEvent[];
}
