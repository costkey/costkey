import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { rawErrorName } from "./telemetry.js";
import { captureCallSite } from "./stack.js";
import type { CallSite } from "./types.js";
import type {
  ContextCarrier,
  EventContext,
  ExecutionOptions,
  ExecutionLifecycle,
  SpanAttributeValue,
  SpanHandle,
  SpanKind,
  SpanOptions,
  SpanStatus,
  TraceLifecycle,
  TraceOptions,
} from "./types.js";

const storage = new AsyncLocalStorage<EventContext>();
// Start order of the innermost CostKey span in this async context; compared
// with framework spans (see registerContextResolver) to find the innermost.
const spanSeqStorage = new AsyncLocalStorage<number>();
let spanSeqCounter = 0;
// A boundary owns a fresh identity by default. Explicit IDs (or an imported
// carrier outside a boundary) are the only way to join an existing identity.
const traceScopeOwned = new AsyncLocalStorage<boolean>();
const executionScopeOwned = new AsyncLocalStorage<boolean>();

/** Data emitted by a trace/execution boundary without coupling context to transport. */
export interface LifecycleRecord {
  entityType: "trace" | "execution";
  entityId: string;
  lifecycle: TraceLifecycle | ExecutionLifecycle;
  sequence: number;
  traceId?: string;
  traceName?: string;
  groupId?: string;
  groupName?: string;
  groupKind?: string;
  executionId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** Raw JS error name (contract detail 7); the server maps it to failed or cancelled. */
  errorName?: string;
  expectedItems?: number;
  completedItems?: number;
  failedItems?: number;
  configuration?: Record<string, unknown>;
  context: EventContext;
}

type LifecycleEmitter = (record: LifecycleRecord) => void;

/** One delivery of a span: emitted when it starts and again when it ends. */
export interface SpanRecord {
  id: string;
  traceId: string;
  traceName?: string;
  parentSpanId?: string;
  executionId?: string;
  kind: SpanKind;
  name: string;
  status: SpanStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** Raw JS error name (contract detail 7). */
  errorName?: string;
  attributes: Record<string, unknown>;
  /**
   * Raw framework payload for integration spans, sent as `attributes[namespace]`:
   * verbatim when body capture is on, as a skeleton otherwise.
   */
  raw?: { namespace: string; value: unknown };
  input?: unknown;
  output?: unknown;
  context: EventContext;
  /** Where the span was opened, raw; the server attributes calls made inside it with no code of their own to it. */
  callSite?: CallSite | null;
}

type SpanEmitter = (record: SpanRecord) => void;

let lifecycleEmitter: LifecycleEmitter | null = null;
let spanEmitter: SpanEmitter | null = null;

/** Configure the process-local sink for span deliveries. */
export function setSpanEmitter(emitter: SpanEmitter | null): void {
  spanEmitter = emitter;
}
const executionSequence = new Map<string, number>();
const traceSequence = new Map<string, number>();

/** Configure the process-local sink used by the public SDK facade. */
export function setLifecycleEmitter(emitter: LifecycleEmitter | null): void {
  lifecycleEmitter = emitter;
}

/** Reset process-local lifecycle ordering after a full SDK shutdown. */
export function resetLifecycleState(): void {
  executionSequence.clear();
  traceSequence.clear();
}

/**
 * Run a function with CostKey context. Any AI calls made inside
 * will be tagged with this context automatically.
 *
 * Contexts nest — inner contexts merge with outer contexts. A serialized
 * carrier returned by exportContext() is accepted for explicit handoffs.
 */
export function withContext<T>(
  context: EventContext | ContextCarrier | string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const parent = storage.getStore();
  const imported = normalizeContextInput(context);
  const merged = parent ? { ...parent, ...imported } : imported;
  return storage.run(merged, fn);
}

/**
 * Start one trace boundary. Trace identity is generated per invocation; it is
 * never derived from stack frames or a wall-clock bucket, so concurrent calls
 * through the same function cannot accidentally share a trace.
 */
export function startTrace<T>(
  options: TraceOptions = {},
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const parent = getCallContext();
  const optionContext = options.context ? normalizeContextInput(options.context) : {};
  const requestedTraceId = nonEmpty(options.traceId) ?? nonEmpty(optionContext.traceId);
  const ownsTrace = traceScopeOwned.getStore() === true;
  const inheritedTraceId = ownsTrace ? undefined : nonEmpty(parent.traceId);
  const traceId = requestedTraceId ?? inheritedTraceId ?? generateId("tr");
  const context: EventContext = {
    ...parent,
    ...optionContext,
    traceId,
  };
  if (options.name !== undefined) context.traceName = options.name;

  // A downstream service can import a carrier and still call startTrace() as
  // a framework boundary. Joining an existing identity avoids emitting a
  // second root lifecycle or prematurely terminalizing the upstream trace.
  const joinsExistingTrace =
    !!parent.traceId &&
    ((requestedTraceId !== undefined && requestedTraceId === parent.traceId) ||
      (!ownsTrace && requestedTraceId === undefined));
  if (joinsExistingTrace) {
    return traceScopeOwned.run(true, () => storage.run(context, fn));
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const startSequence = traceSequence.get(traceId) ?? 0;
  traceSequence.set(traceId, startSequence + 2);
  emitLifecycle({
    entityType: "trace",
    entityId: traceId,
    lifecycle: "started",
    sequence: startSequence,
    traceId,
    traceName: context.traceName,
    startedAt,
    context,
  });

  return traceScopeOwned.run(true, () => runBoundary(
    context,
    fn,
    (lifecycle, error) => {
      const endedAt = new Date().toISOString();
      emitLifecycle({
        entityType: "trace",
        entityId: traceId,
        lifecycle,
        sequence: startSequence + 1,
        traceId,
        traceName: context.traceName,
        startedAt,
        endedAt,
        durationMs: Math.max(0, Date.now() - startedMs),
        errorName: lifecycle === "failed" ? rawErrorName(error) : undefined,
        context,
      });
    },
  ));
}

/**
 * Start one grouped-work invocation. The group name is stable across runs;
 * executionId is fresh unless supplied by an external runner.
 */
export function startExecution<T>(
  options: ExecutionOptions,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  if (!options || typeof options !== "object") {
    throw new TypeError("CostKey.startExecution() requires options");
  }
  const optionContext = options.context ? normalizeContextInput(options.context) : {};
  const groupName =
    nonEmpty(options.groupName) ??
    nonEmpty(options.name) ??
    nonEmpty(optionContext.groupName);
  if (!groupName) {
    throw new TypeError("CostKey.startExecution() requires a non-empty name");
  }
  if (
    options.expectedItems !== undefined &&
    (!Number.isSafeInteger(options.expectedItems) || options.expectedItems < 0)
  ) {
    throw new RangeError("CostKey.startExecution() expectedItems must be a non-negative integer");
  }
  for (const [label, value] of [
    ["completedItems", options.completedItems],
    ["failedItems", options.failedItems],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`CostKey.startExecution() ${label} must be a non-negative integer`);
    }
  }

  const parent = getCallContext();
  const ownsExecution = executionScopeOwned.getStore() === true;
  const explicitExecutionId =
    nonEmpty(options.executionId) ?? nonEmpty(optionContext.executionId);
  const inheritedExecutionId = ownsExecution ? undefined : nonEmpty(parent.executionId);
  const executionId =
    explicitExecutionId ??
    inheritedExecutionId ??
    generateId("ex");
  const groupKind = nonEmpty(options.kind) ?? "batch";
  const configuration = options.configuration === undefined
    ? undefined
    : toJsonSafe(options.configuration);
  const context: EventContext = {
    ...parent,
    ...optionContext,
    ...(options.groupId ? { groupId: options.groupId } : {}),
    groupName,
    groupKind,
    executionId,
    ...(options.datasetRevision ? { datasetRevision: options.datasetRevision } : {}),
    ...(options.caseId ? { caseId: options.caseId } : {}),
    ...(options.phase ? { phase: options.phase } : {}),
  };

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const startSequence = executionSequence.get(executionId) ?? 0;
  executionSequence.set(executionId, startSequence + 2);
  emitLifecycle({
    entityType: "execution",
    entityId: executionId,
    lifecycle: "started",
    sequence: startSequence,
    traceId: context.traceId,
    traceName: context.traceName,
    groupId: context.groupId as string | undefined,
    groupName,
    groupKind,
    executionId,
    startedAt,
    expectedItems: options.expectedItems,
    completedItems: options.completedItems,
    failedItems: options.failedItems,
    configuration,
    context,
  });

  return executionScopeOwned.run(true, () => runBoundary(
    context,
    fn,
    (lifecycle, error) => {
      const endedAt = new Date().toISOString();
      emitLifecycle({
        entityType: "execution",
        entityId: executionId,
        lifecycle,
        sequence: startSequence + 1,
        traceId: context.traceId,
        traceName: context.traceName,
        groupId: context.groupId as string | undefined,
        groupName,
        groupKind,
        executionId,
        startedAt,
        endedAt,
        durationMs: Math.max(0, Date.now() - startedMs),
        errorName: lifecycle === "failed" ? rawErrorName(error) : undefined,
        expectedItems: options.expectedItems,
        completedItems: options.completedItems,
        failedItems: options.failedItems,
        configuration,
        context,
      });
    },
  ));
}

const SPAN_KINDS: readonly SpanKind[] = ["agent", "step", "tool", "workflow", "task", "judge", "retrieval", "handoff", "guardrail", "chain", "custom"];

/**
 * Run `fn` inside a span. Spans nest: a span started inside another becomes
 * its child, and every provider call made inside is attributed to the
 * innermost span. Outside any run, the outermost span starts one.
 */
export function startSpan<T>(
  options: SpanOptions,
  fn: (span: SpanHandle) => T | Promise<T>,
): T | Promise<T> {
  if (!options || typeof options !== "object") throw new TypeError("CostKey span requires options");
  const name = nonEmpty(options.name);
  if (!name) throw new TypeError("CostKey span requires a non-empty name");
  const kind: SpanKind = options.kind && SPAN_KINDS.includes(options.kind) ? options.kind : "custom";

  const parent = getCallContext();
  if (!parent.traceId) {
    return startTrace({ name }, () => startSpan(options, fn));
  }

  const id = nonEmpty(options.spanId) ?? generateId("sp");
  const inheritedParent = typeof parent.spanId === "string" && parent.spanId !== id ? parent.spanId : undefined;
  const parentSpanId = nonEmpty(options.parentSpanId) ?? inheritedParent;
  const optionContext = options.context ? normalizeContextInput(options.context) : {};
  const context: EventContext = { ...parent, ...optionContext, spanId: id };
  if (kind === "agent") context.agent = name;
  if (kind === "tool") context.tool = name;

  const attributes: Record<string, SpanAttributeValue> = { ...(options.attributes ?? {}) };
  let output: unknown;
  const handle: SpanHandle = {
    id,
    traceId: context.traceId as string,
    setAttribute(key: string, value: SpanAttributeValue) {
      attributes[key] = value;
    },
    setOutput(value: unknown) {
      output = value;
    },
  };

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const base = {
    id,
    traceId: context.traceId as string,
    traceName: context.traceName,
    parentSpanId,
    executionId: context.executionId,
    kind,
    name,
    startedAt,
    context,
    callSite: safeCallSite(),
  };
  emitSpan({ ...base, status: "running", attributes: { ...attributes }, input: options.input });

  const seq = nextSpanSeq();
  return spanSeqStorage.run(seq, () => runBoundary(context, () => fn(handle), (lifecycle, error) => {
    emitSpan({
      ...base,
      status: lifecycle === "completed" ? "ok" : "error",
      endedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedMs),
      errorName: lifecycle === "failed" ? rawErrorName(error) : undefined,
      attributes: { ...attributes },
      output,
    });
  }));
}

/** An agent run: model calls, tool calls and sub-agents inside are attributed to it. */
export function agent<T>(
  name: string,
  fn: (span: SpanHandle) => T | Promise<T>,
  options: Omit<SpanOptions, "name" | "kind"> = {},
): T | Promise<T> {
  return startSpan({ ...options, name, kind: "agent" }, fn);
}

/** One step of an agent loop (a turn, a browser action, a plan stage). */
export function step<T>(
  name: string,
  fn: (span: SpanHandle) => T | Promise<T>,
  options: Omit<SpanOptions, "name" | "kind"> = {},
): T | Promise<T> {
  return startSpan({ ...options, name, kind: "step" }, fn);
}

/** A tool call. Its latency and any model calls it makes are attributed to it. */
export function tool<T>(
  name: string,
  fn: (span: SpanHandle) => T | Promise<T>,
  options: Omit<SpanOptions, "name" | "kind"> = {},
): T | Promise<T> {
  return startSpan({ ...options, name, kind: "tool" }, fn);
}

/**
 * Wrap a map of tools that expose `execute` (Vercel AI SDK, Mastra and most
 * agent frameworks) so each invocation is recorded as a tool span.
 */
export function instrumentTools<T extends Record<string, unknown>>(tools: T): T {
  const wrapped: Record<string, unknown> = {};
  for (const [toolName, definition] of Object.entries(tools)) {
    const execute = definition && typeof definition === "object"
      ? (definition as { execute?: unknown }).execute
      : undefined;
    if (typeof execute !== "function") {
      wrapped[toolName] = definition;
      continue;
    }
    wrapped[toolName] = {
      ...(definition as Record<string, unknown>),
      execute(this: unknown, ...args: unknown[]) {
        return startSpan({ name: toolName, kind: "tool", input: args[0] }, (span) => {
          const result = (execute as (...input: unknown[]) => unknown).apply(this, args);
          if (isPromiseLike(result)) {
            return Promise.resolve(result).then((value) => {
              span.setOutput(value);
              return value;
            });
          }
          span.setOutput(result);
          return result;
        });
      },
    };
  }
  return wrapped as T;
}

/**
 * Get the current context: the nearest withContext/span scope, overlaid with
 * the innermost framework span an integration reports (see
 * registerContextResolver).
 */
export function getCurrentContext(): EventContext {
  return getCallContext();
}

// ── Framework integrations ──

/** A framework span that is current in this async context, as an integration sees it. */
export interface ContextResolution {
  /** Start order of the framework span (from nextSpanSeq()); the most recent wins. */
  seq: number;
  /** Context for work running inside it: at least `spanId` and `traceId`. */
  context: EventContext;
}

export type ContextResolver = () => ContextResolution | null | undefined;

const contextResolvers = new Set<ContextResolver>();

/**
 * Let an integration report the framework span that is current in the
 * caller's async context (OpenAI Agents, LangChain and OpenTelemetry keep
 * their own). Provider calls and new spans are attributed to whichever is
 * innermost: the CostKey span or the framework span, by start order.
 */
export function registerContextResolver(resolver: ContextResolver): () => void {
  contextResolvers.add(resolver);
  return () => {
    contextResolvers.delete(resolver);
  };
}

/** A monotonic start order shared by CostKey spans and integration spans. */
export function nextSpanSeq(): number {
  spanSeqCounter += 1;
  return spanSeqCounter;
}

/** The context a provider call or a new span made right now belongs to. */
export function getCallContext(): EventContext {
  const base = storage.getStore() ?? {};
  if (contextResolvers.size === 0) return { ...base };
  const ownSeq = spanSeqStorage.getStore() ?? 0;
  let best: ContextResolution | null = null;
  for (const resolver of contextResolvers) {
    let resolution: ContextResolution | null | undefined;
    try {
      resolution = resolver();
    } catch {
      continue;
    }
    if (!resolution || resolution.seq <= ownSeq) continue;
    if (!best || resolution.seq > best.seq) best = resolution;
  }
  return best ? { ...base, ...best.context } : { ...base };
}

/** Run `fn` with an integration span as the current CostKey context. */
export function runWithSpanContext<T>(context: EventContext, seq: number, fn: () => T): T {
  const merged = { ...(storage.getStore() ?? {}), ...context };
  return spanSeqStorage.run(seq, () => storage.run(merged, fn));
}

/** Deliver a span record built by an integration (start or end). */
export function emitIntegrationSpan(record: SpanRecord): void {
  emitSpan(record);
}

/**
 * Trace lifecycle for a framework run that started outside any CostKey
 * trace. Returns the function that ends it.
 */
export function startIntegrationTrace(
  traceId: string,
  traceName: string | undefined,
  context: EventContext,
): (failed?: boolean, errorName?: string) => void {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const startSequence = traceSequence.get(traceId) ?? 0;
  traceSequence.set(traceId, startSequence + 2);
  const traceContext: EventContext = { ...context, traceId, ...(traceName ? { traceName } : {}) };
  emitLifecycle({
    entityType: "trace",
    entityId: traceId,
    lifecycle: "started",
    sequence: startSequence,
    traceId,
    traceName,
    startedAt,
    context: traceContext,
  });
  let ended = false;
  return (failed?: boolean, errorName?: string) => {
    if (ended) return;
    ended = true;
    emitLifecycle({
      entityType: "trace",
      entityId: traceId,
      lifecycle: failed ? "failed" : "completed",
      sequence: startSequence + 1,
      traceId,
      traceName,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedMs),
      ...(errorName ? { errorName } : {}),
      context: traceContext,
    });
  };
}

/** A fresh CostKey identifier (`sp_…`, `tr_…`). */
export function newId(prefix: string): string {
  return generateId(prefix);
}

/** Get the current trace ID if inside a trace scope. */
export function getCurrentTraceId(): string | undefined {
  return getCallContext().traceId;
}

/**
 * Return an explicit, allowlisted carrier for trusted service/queue handoff.
 * Arbitrary user labels intentionally stay process-local unless copied by the
 * caller into a new context at the destination.
 */
export function exportContext(options?: { keys?: readonly string[] }): ContextCarrier {
  const current = getCallContext();
  const carrier: Record<string, string | number | boolean> = {};
  const keys = options?.keys
    ? [...options.keys]
    : CONTEXT_CARRIER_KEYS;
  for (const requestedKey of keys) {
    if (!CONTEXT_CARRIER_KEYS.includes(requestedKey as keyof ContextCarrier)) {
      throw new TypeError(`context key is not exportable: ${requestedKey}`);
    }
    const key = requestedKey as keyof ContextCarrier;
    const value = current[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      carrier[key] = value;
    }
  }
  return carrier as ContextCarrier;
}

/**
 * Convenience form for explicitly attaching a carrier to a trusted request.
 * The SDK never adds these headers to arbitrary application requests.
 */
export function exportContextHeaders(options?: { keys?: readonly string[] }): Record<string, string> {
  return { "x-costkey-context": JSON.stringify(exportContext(options)) };
}

/** Parse a carrier received from an explicitly trusted service/queue handoff. */
export function importContext(input: unknown): EventContext {
  return normalizeContextInput(input as EventContext | ContextCarrier | string);
}

function runBoundary<T>(
  context: EventContext,
  fn: () => T | Promise<T>,
  onTerminal: (lifecycle: TraceLifecycle, error?: unknown) => void,
): T | Promise<T> {
  let result: T | Promise<T>;
  try {
    result = storage.run(context, fn);
  } catch (error) {
    onTerminal("failed", error);
    throw error;
  }

  if (isPromiseLike<T>(result)) {
    return Promise.resolve(result).then(
      (value) => {
        onTerminal("completed");
        return value;
      },
      (error) => {
        onTerminal("failed", error);
        throw error;
      },
    );
  }

  onTerminal("completed");
  return result;
}

function emitSpan(record: SpanRecord): void {
  try {
    spanEmitter?.({ ...record, context: { ...record.context } });
  } catch {
    // Telemetry must never change the callback's result or error.
  }
}

function emitLifecycle(record: LifecycleRecord): void {
  try {
    lifecycleEmitter?.({ ...record, context: { ...record.context } });
  } catch {
    // Telemetry must never change the callback's result or error.
  }
}

function normalizeContextInput(input: EventContext | ContextCarrier | string): EventContext {
  let value: unknown = input;
  let explicitCarrier = typeof input === "string";
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const object = value as Record<string, unknown>;
  if (object["context"] && typeof object["context"] === "object") {
    value = object["context"];
    explicitCarrier = true;
  }

  const result: EventContext = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    const canonicalKey = CONTEXT_ALIASES[key] ?? key;
    if (explicitCarrier && !CONTEXT_CARRIER_KEYS.includes(canonicalKey as keyof ContextCarrier)) continue;
    if (canonicalKey !== key && Object.prototype.hasOwnProperty.call(value, canonicalKey)) continue;
    if (
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean"
    ) {
      result[canonicalKey] = candidate;
    }
  }
  return result;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return !!value && typeof value === "object" && typeof (value as Promise<T>).then === "function";
}

function toJsonSafe(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const parsed = JSON.parse(JSON.stringify(value)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

const CONTEXT_CARRIER_KEYS: Array<keyof ContextCarrier> = [
  "traceId",
  "traceName",
  "groupId",
  "groupName",
  "groupKind",
  "executionId",
  "feature",
  "customer",
  "customerId",
  "environment",
  "service",
  "release",
  "function",
  "operation",
  "phase",
  "caseId",
  "datasetRevision",
  "conversationId",
  "voiceSessionId",
  "spanId",
  "agent",
  "tool",
  "userId",
];

const CONTEXT_ALIASES: Record<string, keyof EventContext> = {
  trace_id: "traceId",
  trace_name: "traceName",
  group_id: "groupId",
  group_name: "groupName",
  group_kind: "groupKind",
  execution_id: "executionId",
  dataset_revision: "datasetRevision",
  case_id: "caseId",
  conversation_id: "conversationId",
  voice_session_id: "voiceSessionId",
  span_id: "spanId",
  user_id: "userId",
};

function safeCallSite(): CallSite | null {
  try {
    return captureCallSite();
  } catch {
    return null;
  }
}
