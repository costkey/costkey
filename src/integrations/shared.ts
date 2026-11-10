/**
 * Shared span bookkeeping for framework integrations. An integration only
 * opens and closes spans and attaches the framework's raw data; it never
 * computes usage or cost, and it never emits call events for model calls
 * made in this process (the fetch patch already records those).
 */
import {
  emitIntegrationSpan,
  getCallContext,
  newId,
  nextSpanSeq,
  registerContextResolver,
  runWithSpanContext,
  startIntegrationTrace,
  type ContextResolution,
} from "../context.js";
import type { EventContext, SpanKind, SpanStatus } from "../types.js";

export interface SpanStartOptions {
  /** The framework's identifier for this span (run id, span id, call id). */
  key: string;
  kind: SpanKind;
  name: string;
  /** The framework's identifier of the parent span, when it has one. */
  parentKey?: string | null;
  /** The framework's trace identifier, used when no CostKey trace is active. */
  frameworkTraceId?: string | null;
  /** CostKey span id; defaults to a fresh `sp_…` id. */
  id?: string;
  /**
   * False for spans that are tracked only so their children find the right
   * parent (model generation spans: the fetch patch records the call itself).
   */
  emit?: boolean;
  /** Small attributes sent as is. */
  attributes?: Record<string, unknown>;
  /** The framework's raw payload, sent under `attributes[namespace]`. */
  raw?: unknown;
  /** Content: only sent when body capture is on. */
  input?: unknown;
  startedAt?: string;
  /** Explicit context fallback when the span starts outside the caller's async context. */
  context?: EventContext;
}

export interface SpanEndOptions {
  /** A name only known at the end (a handoff's target agent). */
  name?: string;
  /** True when the framework reported a failure. */
  failed?: boolean;
  /** Raw error class name, when the framework exposes one. */
  errorName?: string;
  raw?: unknown;
  attributes?: Record<string, unknown>;
  output?: unknown;
  endedAt?: string;
}

interface SpanState {
  key: string;
  id: string;
  kind: SpanKind;
  name: string;
  parentKey: string | null;
  parentSpanId?: string;
  traceId: string;
  traceName?: string;
  executionId?: string;
  emit: boolean;
  ended: boolean;
  seq: number;
  startedAt: string;
  startedMs: number;
  context: EventContext;
  attributes: Record<string, unknown>;
  raw: unknown;
  input: unknown;
  /** Ends the CostKey trace this span opened, if it opened one. */
  endTrace?: (failed?: boolean, errorName?: string) => void;
}

interface TraceState {
  traceId: string;
  endTrace?: (failed?: boolean, errorName?: string) => void;
}

const MAX_TRACKED = 10_000;

export class SpanTracker {
  private readonly spans = new Map<string, SpanState>();
  private readonly traces = new Map<string, TraceState>();

  constructor(private readonly namespace: string) {}

  /**
   * Map a framework trace to a CostKey trace: the caller's active trace when
   * there is one, otherwise a new trace with lifecycle events.
   */
  beginTrace(frameworkTraceId: string, name?: string, context?: EventContext): string {
    const existing = this.traces.get(frameworkTraceId);
    if (existing) return existing.traceId;
    const current = { ...(context ?? {}), ...getCallContext() };
    let state: TraceState;
    if (typeof current.traceId === "string" && current.traceId) {
      state = { traceId: current.traceId };
    } else {
      state = { traceId: frameworkTraceId };
      state.endTrace = startIntegrationTrace(frameworkTraceId, name, current);
    }
    this.traces.set(frameworkTraceId, state);
    this.prune();
    return state.traceId;
  }

  endTrace(frameworkTraceId: string, failed = false, errorName?: string): void {
    const state = this.traces.get(frameworkTraceId);
    if (!state) return;
    this.traces.delete(frameworkTraceId);
    state.endTrace?.(failed, errorName);
  }

  has(key: string): boolean {
    return this.spans.has(key);
  }

  start(options: SpanStartOptions): void {
    if (this.spans.has(options.key)) return;
    const parent = options.parentKey ? this.spans.get(options.parentKey) : undefined;
    const parentSpan = parent ? this.nearestEmitted(parent.key, true) : null;
    const callContext = { ...(options.context ?? {}), ...getCallContext() };
    const baseContext: EventContext = parent ? { ...parent.context } : callContext;

    let traceId: string;
    let traceName: string | undefined;
    let endTrace: ((failed?: boolean, errorName?: string) => void) | undefined;
    if (parent) {
      traceId = parent.traceId;
      traceName = parent.traceName;
    } else if (options.frameworkTraceId && this.traces.has(options.frameworkTraceId)) {
      traceId = this.traces.get(options.frameworkTraceId)!.traceId;
      traceName = typeof callContext.traceName === "string" ? callContext.traceName : undefined;
    } else if (typeof callContext.traceId === "string" && callContext.traceId) {
      traceId = callContext.traceId;
      traceName = typeof callContext.traceName === "string" ? callContext.traceName : undefined;
    } else {
      // A framework run outside any CostKey trace opens one, like CostKey.agent() does.
      traceId = options.frameworkTraceId ?? newId("tr");
      traceName = options.name;
      endTrace = startIntegrationTrace(traceId, traceName, callContext);
    }

    const emit = options.emit !== false;
    const id = options.id ?? newId("sp");
    const parentSpanId = parentSpan
      ? parentSpan.id
      : !parent && typeof callContext.spanId === "string" && callContext.spanId
        ? callContext.spanId
        : undefined;
    const context: EventContext = { ...baseContext, traceId };
    if (traceName) context.traceName = traceName;
    if (emit) {
      context.spanId = id;
      if (options.kind === "agent") context.agent = options.name;
      if (options.kind === "tool") context.tool = options.name;
    }

    const state: SpanState = {
      key: options.key,
      id,
      kind: options.kind,
      name: options.name,
      parentKey: options.parentKey ?? null,
      parentSpanId,
      traceId,
      traceName,
      executionId: typeof context.executionId === "string" ? context.executionId : undefined,
      emit,
      ended: false,
      seq: nextSpanSeq(),
      startedAt: options.startedAt ?? new Date().toISOString(),
      startedMs: Date.now(),
      context,
      attributes: { ...(options.attributes ?? {}) },
      raw: options.raw,
      input: options.input,
      endTrace,
    };
    this.spans.set(options.key, state);
    this.prune();
    if (emit) {
      emitIntegrationSpan({
        ...this.recordBase(state),
        status: "running",
        attributes: { ...state.attributes },
        ...(state.raw !== undefined ? { raw: { namespace: this.namespace, value: state.raw } } : {}),
        input: state.input,
      });
    }
  }

  end(key: string, options: SpanEndOptions = {}): void {
    const state = this.spans.get(key);
    if (!state || state.ended) return;
    state.ended = true;
    if (options.name) state.name = options.name;
    if (options.attributes) Object.assign(state.attributes, options.attributes);
    if (options.raw !== undefined) state.raw = mergeRaw(state.raw, options.raw);
    const failed = options.failed === true || options.errorName !== undefined;
    if (state.emit) {
      const endedAt = options.endedAt ?? new Date().toISOString();
      const status: SpanStatus = failed ? "error" : "ok";
      const startedMs = Date.parse(state.startedAt);
      const endedMs = Date.parse(endedAt);
      emitIntegrationSpan({
        ...this.recordBase(state),
        status,
        endedAt,
        durationMs: Number.isFinite(startedMs) && Number.isFinite(endedMs)
          ? Math.max(0, endedMs - startedMs)
          : Math.max(0, Date.now() - state.startedMs),
        ...(options.errorName ? { errorName: options.errorName } : {}),
        attributes: { ...state.attributes },
        ...(state.raw !== undefined ? { raw: { namespace: this.namespace, value: state.raw } } : {}),
        output: options.output,
      });
    }
    state.endTrace?.(failed, options.errorName);
  }

  /** The context for work running inside a framework span (its nearest emitted ancestor). */
  contextFor(key: string | null | undefined): EventContext | null {
    if (!key) return null;
    return this.nearestEmitted(key, false)?.context ?? null;
  }

  /** For registerContextResolver: the innermost open emitted span for a framework key. */
  resolution(key: string | null | undefined): ContextResolution | null {
    if (!key) return null;
    const state = this.nearestEmitted(key, false);
    return state ? { seq: state.seq, context: state.context } : null;
  }

  /** Run `fn` with the framework span as the current CostKey context. */
  run<T>(key: string | null | undefined, fn: () => T): T {
    const state = key ? this.nearestEmitted(key, false) : null;
    if (!state) return fn();
    return runWithSpanContext(state.context, state.seq, fn);
  }

  /** Report the innermost framework span through `getCallContext()`. */
  registerResolver(currentKey: () => string | null | undefined): () => void {
    return registerContextResolver(() => this.resolution(currentKey()));
  }

  /** Close every open span (framework shutdown). */
  endAll(): void {
    for (const state of [...this.spans.values()].reverse()) {
      if (!state.ended) this.end(state.key, { failed: false });
    }
  }

  private nearestEmitted(key: string, includeEnded: boolean): SpanState | null {
    let state = this.spans.get(key);
    let guard = 0;
    while (state && guard++ < 256) {
      if (state.emit && (includeEnded || !state.ended)) return state;
      state = state.parentKey ? this.spans.get(state.parentKey) : undefined;
    }
    return null;
  }

  private recordBase(state: SpanState) {
    return {
      id: state.id,
      traceId: state.traceId,
      ...(state.traceName ? { traceName: state.traceName } : {}),
      ...(state.parentSpanId ? { parentSpanId: state.parentSpanId } : {}),
      ...(state.executionId ? { executionId: state.executionId } : {}),
      kind: state.kind,
      name: state.name,
      startedAt: state.startedAt,
      context: state.context,
    };
  }

  /** Ended spans stay a while so late children still find their parent. */
  private prune(): void {
    if (this.spans.size > MAX_TRACKED) {
      for (const [key, state] of this.spans) {
        if (this.spans.size <= MAX_TRACKED * 0.9) break;
        if (state.ended) this.spans.delete(key);
      }
    }
    if (this.traces.size > MAX_TRACKED) {
      const oldest = this.traces.keys().next().value;
      if (oldest !== undefined) this.traces.delete(oldest);
    }
  }
}

/** End data supplements start data: plain objects merge, anything else replaces. */
function mergeRaw(start: unknown, end: unknown): unknown {
  const plain = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value);
  return plain(start) && plain(end)
    ? { ...(start as Record<string, unknown>), ...(end as Record<string, unknown>) }
    : end;
}

/** Shallow copy of an object without the listed (content) keys. */
export function omitKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!keys.includes(key)) result[key] = entry;
  }
  return result;
}

/** Only the listed keys of an object. */
export function pickKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
