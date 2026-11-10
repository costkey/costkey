/**
 * OpenTelemetry bridge: a SpanProcessor that forwards every finished OTel
 * span (GenAI semantic-convention spans included) as a CostKey span.
 *
 *   import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
 *   import { CostKeySpanProcessor } from "costkey/integrations/opentelemetry";
 *   const provider = new BasicTracerProvider({ spanProcessors: [new CostKeySpanProcessor()] });
 *
 * Each span carries `attributes.otel` (the raw OTel attributes), `otelKind`,
 * `otelName` and `otelScope` (contract detail 9). The server maps GenAI
 * conventions; the SDK sends every span with kind `custom`. Provider calls
 * made while an OTel span is active are attributed to it. GenAI spans are
 * never turned into call events: in-process provider calls are already
 * recorded by the fetch patch.
 */
import { SpanTracker, stringOr } from "./shared.js";

type HrTime = [number, number];

/** Structural subset of an OTel span (`Span` at start, `ReadableSpan` at end), SDK 1.x and 2.x. */
export interface OtelSpanLike {
  name: string;
  kind?: number;
  spanContext(): { traceId: string; spanId: string };
  /** SDK 2.x */
  parentSpanContext?: { spanId?: string } | undefined;
  /** SDK 1.x */
  parentSpanId?: string;
  startTime?: HrTime;
  endTime?: HrTime;
  status?: { code?: number; message?: string };
  attributes?: Record<string, unknown>;
  events?: Array<{ name: string; attributes?: Record<string, unknown> }>;
  /** SDK 2.x */
  instrumentationScope?: { name?: string; version?: string };
  /** SDK 1.x */
  instrumentationLibrary?: { name?: string; version?: string };
}

/** OTel `SpanStatusCode.ERROR`. */
const STATUS_ERROR = 2;
const OTEL_API = Symbol.for("opentelemetry.js.api.1");
const OTEL_SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");

function hrTimeToIso(time: HrTime | undefined): string | undefined {
  if (!Array.isArray(time) || time.length !== 2) return undefined;
  const ms = time[0] * 1_000 + time[1] / 1_000_000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function parentSpanId(span: OtelSpanLike): string | null {
  const id = span.parentSpanContext?.spanId ?? span.parentSpanId;
  return typeof id === "string" && id ? id : null;
}

function scopeName(span: OtelSpanLike): string | undefined {
  return span.instrumentationScope?.name ?? span.instrumentationLibrary?.name;
}

/** The raw exception class an instrumentation recorded (`exception.type`), if any. */
function exceptionType(span: OtelSpanLike): string | undefined {
  for (const event of span.events ?? []) {
    const type = event.attributes?.["exception.type"];
    if (event.name === "exception" && typeof type === "string" && type) return type;
  }
  return undefined;
}

export class CostKeySpanProcessor {
  private readonly tracker = new SpanTracker("otel");
  private readonly unregister: () => void;

  constructor() {
    this.unregister = this.tracker.registerResolver(activeOtelSpanId);
  }

  onStart(span: OtelSpanLike): void {
    try {
      const context = span.spanContext();
      this.tracker.start({
        key: context.spanId,
        id: context.spanId,
        parentKey: parentSpanId(span),
        frameworkTraceId: context.traceId,
        kind: "custom",
        name: stringOr(span.name, "span"),
        attributes: this.otelFields(span),
        startedAt: hrTimeToIso(span.startTime),
      });
    } catch {
      // Telemetry never affects the instrumented code.
    }
  }

  onEnd(span: OtelSpanLike): void {
    try {
      const { spanId } = span.spanContext();
      if (!this.tracker.has(spanId)) this.onStart(span);
      const failed = span.status?.code === STATUS_ERROR;
      this.tracker.end(spanId, {
        failed,
        errorName: failed ? exceptionType(span) : undefined,
        attributes: this.otelFields(span),
        raw: { ...(span.attributes ?? {}) },
        endedAt: hrTimeToIso(span.endTime),
      });
    } catch {
      // Telemetry never affects the instrumented code.
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.tracker.endAll();
    this.unregister();
  }

  private otelFields(span: OtelSpanLike): Record<string, unknown> {
    const scope = scopeName(span);
    return {
      otelKind: typeof span.kind === "number" ? span.kind : null,
      otelName: span.name,
      ...(scope ? { otelScope: scope } : {}),
    };
  }
}

/** The span id of the active OTel span, read through the global OTel API (no import). */
function activeOtelSpanId(): string | null {
  const api = (globalThis as Record<symbol, unknown>)[OTEL_API] as
    | { context?: { active?: () => { getValue?: (key: symbol) => unknown } } }
    | undefined;
  const active = api?.context?.active?.();
  const span = active?.getValue?.(OTEL_SPAN_KEY) as { spanContext?: () => { spanId?: string } } | undefined;
  const spanId = span?.spanContext?.()?.spanId;
  return typeof spanId === "string" ? spanId : null;
}
