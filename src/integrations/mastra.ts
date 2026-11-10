/**
 * Mastra (`@mastra/core` 1.x with `@mastra/observability`): agent runs,
 * workflows and their steps, and tool calls become CostKey spans.
 *
 *   import { Mastra } from "@mastra/core/mastra";
 *   import { Observability } from "@mastra/observability";
 *   import { CostKeyMastraBridge } from "costkey/integrations/mastra";
 *
 *   new Mastra({
 *     agents: { weatherAgent },
 *     observability: new Observability({
 *       configs: { default: { serviceName: "app", bridge: new CostKeyMastraBridge() } },
 *     }),
 *   });
 *
 * As a bridge, Mastra runs each model call and tool execution inside its
 * span's context (`executeInContext`), so the provider request the fetch
 * patch records is attributed to the right agent, step or tool. When another
 * bridge is already configured, add `new CostKeyMastraExporter()` to
 * `exporters` instead: spans are recorded, and calls are attributed when you
 * pass Mastra's `getCurrentSpan` (`@mastra/core/observability/context-storage`).
 * Model generation spans are tracked for parentage only; usage is never
 * re-emitted.
 */
import { SpanTracker, omitKeys, stringOr } from "./shared.js";
import type { SpanKind } from "../types.js";

/** Structural subset of Mastra's exported span. */
export interface MastraExportedSpanLike {
  id: string;
  traceId: string;
  name: string;
  type: string;
  parentSpanId?: string;
  entityType?: string;
  entityId?: string;
  entityName?: string;
  startTime?: Date | string;
  endTime?: Date | string;
  attributes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  errorInfo?: { name?: string; message?: string; id?: string; [key: string]: unknown };
  isEvent?: boolean;
  isRootSpan?: boolean;
  [key: string]: unknown;
}

export interface MastraTracingEventLike {
  type: "span_started" | "span_updated" | "span_ended" | string;
  exportedSpan: MastraExportedSpanLike;
}

/**
 * What the bridge and exporter accept. Mastra's own TracingEvent is assignable
 * to this: its span attribute types are specific interfaces without an index
 * signature, so the event is narrowed to MastraTracingEventLike inside.
 */
export interface MastraTracingEventInput {
  type: string;
  exportedSpan: object;
}

/** Spans whose provider calls the fetch patch already records. */
const MODEL_SPAN_TYPES = new Set(["model_generation", "model_step", "model_inference", "model_chunk"]);

/** Exported-span fields that are content or already first-class span fields. */
const NON_RAW_KEYS = ["input", "output", "requestContext", "startTime", "endTime", "id", "traceId", "parentSpanId", "name"] as const;

function spanKind(type: string): SpanKind {
  switch (type) {
    case "agent_run": return "agent";
    case "workflow_run": return "workflow";
    case "workflow_step":
    case "workflow_conditional":
    case "workflow_conditional_eval":
    case "workflow_parallel":
    case "workflow_loop":
    case "workflow_sleep":
    case "workflow_wait_event":
    case "scorer_step":
      return "step";
    case "tool_call":
    case "mcp_tool_call":
    case "client_tool_call":
    case "provider_tool_call":
      return "tool";
    case "scorer_run":
    case "classifier_evaluation":
      return "judge";
    case "rag_embedding":
    case "rag_vector_operation":
      return "retrieval";
    default:
      return "custom";
  }
}

/**
 * Runs are named by their agent or workflow (`entityName`); workflow steps by
 * their step id (`entityId`, their `entityName` is the workflow's).
 */
function spanName(span: MastraExportedSpanLike, type: string): string {
  const fallback = stringOr(span.name, type);
  if (type.startsWith("workflow_") && type !== "workflow_run") return stringOr(span.entityId, fallback);
  return stringOr(span.entityName, fallback);
}

function iso(value: Date | string | undefined): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  return typeof value === "string" ? value : undefined;
}

class MastraSpanRecorder {
  readonly tracker = new SpanTracker("mastra");

  handle(event: MastraTracingEventLike): void {
    try {
      const span = event?.exportedSpan;
      if (!span || typeof span.id !== "string" || span.isEvent) return;
      if (event.type === "span_started") this.started(span);
      else if (event.type === "span_ended") this.ended(span);
    } catch {
      // Telemetry never affects the agent or workflow.
    }
  }

  private started(span: MastraExportedSpanLike): void {
    const type = String(span.type ?? "generic");
    this.tracker.start({
      key: span.id,
      parentKey: span.parentSpanId ?? null,
      frameworkTraceId: span.traceId,
      kind: spanKind(type),
      name: spanName(span, type),
      emit: !MODEL_SPAN_TYPES.has(type),
      id: span.id,
      attributes: { framework: "mastra", spanType: type },
      raw: omitKeys(span, NON_RAW_KEYS),
      input: span.input,
      startedAt: iso(span.startTime),
    });
  }

  private ended(span: MastraExportedSpanLike): void {
    if (!this.tracker.has(span.id)) this.started(span);
    this.tracker.end(span.id, {
      failed: !!span.errorInfo,
      errorName: typeof span.errorInfo?.name === "string" ? span.errorInfo.name : undefined,
      raw: omitKeys(span, NON_RAW_KEYS),
      output: span.output,
      endedAt: iso(span.endTime),
    });
  }
}

/**
 * The recommended Mastra integration: an observability bridge. It records
 * spans and runs model calls and tool executions in their span's context.
 * Span identifiers stay Mastra's own (`createSpan` returns undefined).
 */
export class CostKeyMastraBridge {
  readonly name = "costkey";
  private readonly recorder = new MastraSpanRecorder();

  init(): void {}

  createSpan(): undefined {
    return undefined;
  }

  executeInContext<T>(spanId: string, fn: () => Promise<T>): Promise<T> {
    return this.recorder.tracker.run(spanId, fn);
  }

  executeInContextSync<T>(spanId: string, fn: () => T): T {
    return this.recorder.tracker.run(spanId, fn);
  }

  async exportTracingEvent(event: MastraTracingEventInput): Promise<void> {
    this.recorder.handle(event as MastraTracingEventLike);
  }

  async flush(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.recorder.tracker.endAll();
  }
}

export interface CostKeyMastraExporterOptions {
  /** Mastra's `getCurrentSpan` from `@mastra/core/observability/context-storage`, for call attribution. */
  getCurrentSpan?: () => { id?: string } | undefined | null;
}

/** Spans only, for apps that already configure another Mastra bridge. */
export class CostKeyMastraExporter {
  readonly name = "costkey";
  private readonly recorder = new MastraSpanRecorder();
  private readonly unregister: (() => void) | null;

  constructor(options: CostKeyMastraExporterOptions = {}) {
    const current = options.getCurrentSpan;
    this.unregister = current
      ? this.recorder.tracker.registerResolver(() => {
          const id = current()?.id;
          return typeof id === "string" ? id : null;
        })
      : null;
  }

  init(): void {}

  async exportTracingEvent(event: MastraTracingEventInput): Promise<void> {
    this.recorder.handle(event as MastraTracingEventLike);
  }

  async flush(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.recorder.tracker.endAll();
    this.unregister?.();
  }
}
