/**
 * OpenAI Agents SDK for JS (`@openai/agents`): a tracing processor that turns
 * agent runs, function tools, handoffs and guardrails into CostKey spans.
 *
 *   import { addTraceProcessor } from "@openai/agents";
 *   import { CostKeyAgentsProcessor } from "costkey/integrations/openai-agents";
 *   addTraceProcessor(new CostKeyAgentsProcessor());
 *
 * Model calls are not re-emitted: the fetch patch records each one and the
 * processor attributes it to the agent or tool span it ran inside (read from
 * the Agents SDK's own async context). Generation and response spans are
 * tracked only for parentage.
 */
import { SpanTracker, omitKeys, stringOr } from "./shared.js";
import type { SpanKind } from "../types.js";

/** Structural subset of `@openai/agents-core` Trace. */
export interface AgentsTraceLike {
  traceId: string;
  name?: string;
  groupId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Structural subset of `@openai/agents-core` Span. */
export interface AgentsSpanLike {
  spanId: string;
  traceId: string;
  parentId: string | null;
  spanData: { type: string; [key: string]: unknown };
  error?: { message?: string; data?: Record<string, unknown> } | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

/** The global AsyncLocalStorage `@openai/agents-core` keeps its current trace and span in. */
const AGENTS_ALS = Symbol.for("openai.agents.core.asyncLocalStorage");

/** Span data fields that hold prompts, tool arguments or outputs. */
const CONTENT_KEYS = ["input", "output", "_input", "_response"] as const;

/** Spans whose model calls the fetch patch already records. */
const MODEL_SPAN_TYPES = new Set(["generation", "response", "transcription", "speech", "speech_group"]);

function spanKind(type: string): SpanKind {
  switch (type) {
    case "agent": return "agent";
    case "function": return "tool";
    case "handoff": return "handoff";
    case "guardrail": return "guardrail";
    case "task": return "task";
    case "turn": return "step";
    default: return "custom";
  }
}

function spanName(data: AgentsSpanLike["spanData"]): string {
  switch (data.type) {
    case "handoff":
      return stringOr(data["to_agent"], "handoff");
    case "turn":
      return typeof data["turn"] === "number" ? `turn ${data["turn"]}` : "turn";
    case "mcp_tools":
      return stringOr(data["server"], "mcp_tools");
    default:
      return stringOr(data["name"], data.type);
  }
}

export class CostKeyAgentsProcessor {
  private readonly tracker = new SpanTracker("openaiAgents");
  private readonly unregister: () => void;

  constructor() {
    this.unregister = this.tracker.registerResolver(() => currentAgentsSpanId());
  }

  start(): void {}

  async onTraceStart(trace: AgentsTraceLike): Promise<void> {
    try {
      this.tracker.beginTrace(trace.traceId, trace.name);
    } catch {
      // Telemetry never affects the run.
    }
  }

  async onTraceEnd(trace: AgentsTraceLike): Promise<void> {
    try {
      this.tracker.endTrace(trace.traceId);
    } catch {
      // Telemetry never affects the run.
    }
  }

  async onSpanStart(span: AgentsSpanLike): Promise<void> {
    try {
      const data = span.spanData;
      const type = String(data?.type ?? "custom");
      this.tracker.start({
        key: span.spanId,
        parentKey: span.parentId,
        frameworkTraceId: span.traceId,
        kind: spanKind(type),
        name: spanName(data),
        emit: !MODEL_SPAN_TYPES.has(type),
        attributes: { framework: "openai-agents", spanType: type, frameworkSpanId: span.spanId },
        raw: omitKeys(data, CONTENT_KEYS),
        input: data["input"],
        startedAt: span.startedAt ?? undefined,
      });
    } catch {
      // Telemetry never affects the run.
    }
  }

  async onSpanEnd(span: AgentsSpanLike): Promise<void> {
    try {
      const data = span.spanData;
      const raw = omitKeys(data, CONTENT_KEYS) ?? {};
      if (span.error) raw["error"] = span.error;
      this.tracker.end(span.spanId, {
        name: data?.type === "handoff" ? spanName(data) : undefined,
        failed: !!span.error,
        raw,
        output: data["output"],
        endedAt: span.endedAt ?? undefined,
      });
    } catch {
      // Telemetry never affects the run.
    }
  }

  async shutdown(): Promise<void> {
    this.tracker.endAll();
    this.unregister();
  }

  async forceFlush(): Promise<void> {}
}

function currentAgentsSpanId(): string | null {
  const storage = (globalThis as Record<symbol, unknown>)[AGENTS_ALS] as
    | { getStore?: () => { span?: { spanId?: string } | null; active?: boolean } | undefined }
    | undefined;
  const store = storage?.getStore?.();
  if (!store || store.active === false) return null;
  const spanId = store.span?.spanId;
  return typeof spanId === "string" ? spanId : null;
}

/**
 * Register a CostKey processor with the Agents SDK. Pass the module (or any
 * object with `addTraceProcessor`); without one, `@openai/agents` is imported.
 */
export async function instrumentOpenAIAgents(
  agents?: { addTraceProcessor(processor: unknown): void },
): Promise<CostKeyAgentsProcessor> {
  const processor = new CostKeyAgentsProcessor();
  const module = agents ?? (await import(/* webpackIgnore: true */ "@openai/agents" as string)) as {
    addTraceProcessor(processor: unknown): void;
  };
  module.addTraceProcessor(processor);
  return processor;
}
