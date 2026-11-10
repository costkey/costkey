/**
 * LangChain.js and LangGraph.js: a callback handler that maps chains,
 * graphs, graph nodes, agents, tools and retrievers to CostKey spans.
 *
 *   import { CostKeyCallbackHandler } from "costkey/integrations/langchain";
 *   const handler = new CostKeyCallbackHandler();
 *   await graph.invoke(input, { callbacks: [handler] });
 *
 * Chat model and LLM runs are tracked for parentage only: the fetch patch
 * records each provider request, and it is attributed to the node or chain
 * it ran inside. Usage is never re-emitted.
 *
 * Finding that node: `invoke()` runs the model inside LangChain's async
 * context, which names the current run. `stream()` does not: LangChain runs
 * the stream generator with its context cleared unless LangSmith tracing is
 * on. For those calls the handler marks the model run itself when it starts,
 * in its own AsyncLocalStorage, from inside the model's generator: the mark
 * follows the generator to its provider request. Nothing is matched by timing.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { rawErrorName } from "../telemetry.js";
import { SpanTracker, pickKeys, stringOr } from "./shared.js";
import type { SpanKind } from "../types.js";

/** The global AsyncLocalStorage `@langchain/core` keeps the current run config in. */
const LANGCHAIN_ALS = Symbol.for("ls:tracing_async_local_storage");
const LC_CHILD_CONFIG = Symbol.for("lc:child_config");

interface Serialized {
  id?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

type Metadata = Record<string, unknown> | undefined;

/** Run metadata kept as raw attributes (LangGraph's node bookkeeping and model labels). */
const METADATA_KEYS = [
  "langgraph_node", "langgraph_step", "langgraph_triggers", "langgraph_path", "langgraph_checkpoint_ns",
  "ls_provider", "ls_model_name", "ls_model_type", "ls_temperature", "thread_id",
] as const;

function className(serialized: Serialized | undefined): string | undefined {
  const id = serialized?.id;
  if (Array.isArray(id) && id.length > 0) return String(id[id.length - 1]);
  return undefined;
}

function chainKind(serialized: Serialized | undefined, metadata: Metadata, runType: unknown, name: string): SpanKind {
  const cls = className(serialized) ?? "";
  if (metadata && typeof metadata["langgraph_node"] === "string") return "step";
  if (/graph/i.test(cls) || name === "LangGraph") return "workflow";
  if (runType === "agent" || /agent/i.test(cls) || /agent/i.test(name)) return "agent";
  return "chain";
}

function runName(serialized: Serialized | undefined, explicit: unknown, metadata: Metadata): string {
  if (typeof explicit === "string" && explicit) return explicit;
  if (metadata && typeof metadata["langgraph_node"] === "string") return metadata["langgraph_node"];
  if (typeof serialized?.name === "string" && serialized.name) return serialized.name;
  return className(serialized) ?? "chain";
}

/**
 * Duck-typed LangChain callback handler (it needs no `@langchain/core`
 * import). Handlers are awaited so spans open before the run's work starts.
 */
export class CostKeyCallbackHandler {
  readonly name = "costkey";
  readonly awaitHandlers = true;
  readonly raiseError = false;
  readonly ignoreLLM = false;
  readonly ignoreChain = false;
  readonly ignoreAgent = false;
  readonly ignoreRetriever = false;
  readonly ignoreCustomEvent = true;
  readonly lc_serializable = false;
  private readonly tracker = new SpanTracker("langchain");
  private readonly unregister: () => void;
  /** The model run started in this async context (stream generators lose LangChain's). */
  private readonly modelRun = new AsyncLocalStorage<string>();

  constructor() {
    this.unregister = this.tracker.registerResolver(() => this.currentRun());
  }

  copy(): this {
    return this;
  }

  /** Stop reporting LangChain runs as the current span. */
  dispose(): void {
    this.tracker.endAll();
    this.unregister();
  }

  handleChainStart(
    chain: Serialized,
    _inputs: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Metadata,
    runType?: string,
    name?: string,
  ): void {
    this.safe(() => {
      const resolved = runName(chain, name, metadata);
      this.tracker.start({
        key: runId,
        parentKey: parentRunId ?? null,
        kind: chainKind(chain, metadata, runType, resolved),
        name: resolved,
        attributes: { framework: "langchain", runType: runType ?? "chain", runId },
        raw: { class: className(chain), tags, ...pickKeys(metadata, METADATA_KEYS) },
        input: _inputs,
      });
    });
  }

  handleChainEnd(outputs: unknown, runId: string): void {
    this.safe(() => this.tracker.end(runId, { output: outputs }));
  }

  handleChainError(error: unknown, runId: string): void {
    this.safe(() => this.tracker.end(runId, { failed: true, errorName: rawErrorName(error) }));
  }

  handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Metadata,
    name?: string,
    toolCallId?: string,
  ): void {
    this.safe(() => {
      this.tracker.start({
        key: runId,
        parentKey: parentRunId ?? null,
        kind: "tool",
        name: runName(tool, name, undefined),
        attributes: { framework: "langchain", runType: "tool", runId },
        raw: { class: className(tool), tags, toolCallId, ...pickKeys(metadata, METADATA_KEYS) },
        input,
      });
    });
  }

  handleToolEnd(output: unknown, runId: string): void {
    this.safe(() => this.tracker.end(runId, { output }));
  }

  handleToolError(error: unknown, runId: string): void {
    this.safe(() => this.tracker.end(runId, { failed: true, errorName: rawErrorName(error) }));
  }

  handleRetrieverStart(
    retriever: Serialized,
    query: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Metadata,
    name?: string,
  ): void {
    this.safe(() => {
      this.tracker.start({
        key: runId,
        parentKey: parentRunId ?? null,
        kind: "retrieval",
        name: runName(retriever, name, undefined),
        attributes: { framework: "langchain", runType: "retriever", runId },
        raw: { class: className(retriever), tags, ...pickKeys(metadata, METADATA_KEYS) },
        input: query,
      });
    });
  }

  handleRetrieverEnd(documents: unknown, runId: string): void {
    this.safe(() => this.tracker.end(runId, { output: documents }));
  }

  handleRetrieverError(error: unknown, runId: string): void {
    this.safe(() => this.tracker.end(runId, { failed: true, errorName: rawErrorName(error) }));
  }

  handleLLMStart(llm: Serialized, _prompts: unknown, runId: string, parentRunId?: string): void {
    this.trackModel(llm, runId, parentRunId);
  }

  handleChatModelStart(llm: Serialized, _messages: unknown, runId: string, parentRunId?: string): void {
    this.trackModel(llm, runId, parentRunId);
  }

  handleLLMEnd(_output: unknown, runId: string): void {
    this.safe(() => this.tracker.end(runId));
  }

  handleLLMError(error: unknown, runId: string): void {
    this.safe(() => this.tracker.end(runId, { failed: true, errorName: rawErrorName(error) }));
  }

  /** Model runs are tracked so their provider call finds the enclosing node; never emitted. */
  private trackModel(llm: Serialized, runId: string, parentRunId?: string): void {
    this.safe(() => {
      this.tracker.start({
        key: runId,
        parentKey: parentRunId ?? null,
        kind: "custom",
        name: runName(llm, undefined, undefined),
        emit: false,
      });
      // This handler runs synchronously inside the model's generator, before
      // its provider request; the mark follows that request. A stale mark is
      // harmless: resolution skips ended runs and walks up to an open one.
      this.modelRun.enterWith(runId);
    });
  }

  /**
   * The run a provider request (or a new span) belongs to: LangChain's own
   * context, else the model run marked in this async context. An ended mark
   * resolves to its nearest open ancestor (or nothing), so it can't leak.
   */
  private currentRun(): string | null {
    const fromLangChain = currentRunId();
    if (fromLangChain) return fromLangChain;
    return this.modelRun.getStore() ?? null;
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // Telemetry never affects the chain.
    }
  }
}

/** The run id LangChain considers current in this async context. */
function currentRunId(): string | null {
  const storage = (globalThis as Record<symbol, unknown>)[LANGCHAIN_ALS] as
    | { getStore?: () => Record<string | symbol, unknown> | undefined }
    | undefined;
  const store = storage?.getStore?.();
  const extra = store?.["extra"] as Record<symbol, unknown> | undefined;
  const config = extra?.[LC_CHILD_CONFIG] as { callbacks?: unknown } | undefined;
  const callbacks = config?.callbacks as { getParentRunId?: () => unknown; _parentRunId?: unknown } | undefined;
  const runId = typeof callbacks?.getParentRunId === "function"
    ? callbacks.getParentRunId()
    : callbacks?._parentRunId;
  return typeof runId === "string" ? runId : null;
}

export function createCostKeyCallbackHandler(): CostKeyCallbackHandler {
  return new CostKeyCallbackHandler();
}
