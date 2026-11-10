/**
 * Claude Agent SDK for TypeScript (`@anthropic-ai/claude-agent-sdk`).
 *
 * Its model calls run inside a separate Claude Code process, so the fetch
 * patch never sees them. This integration uses the SDK's hooks and message
 * stream instead:
 *
 * - the `query()` run becomes an agent span, each tool use a tool span
 *   (PreToolUse → PostToolUse/PostToolUseFailure) and each subagent an agent
 *   span (SubagentStart → SubagentStop);
 * - every message that carries usage is sent as a call event whose
 *   `telemetry` has `source: "claude-agent-sdk"`, the raw message skeleton
 *   in `response.body` and `request: null` (contract detail 8). The server
 *   reads usage from it and dedupes; the SDK does no cost math.
 *
 *   import { query } from "@anthropic-ai/claude-agent-sdk";
 *   import { instrumentClaudeAgentQuery } from "costkey/integrations/claude-agent-sdk";
 *   const tracedQuery = instrumentClaudeAgentQuery(query, { name: "triage-agent" });
 *   for await (const message of tracedQuery({ prompt, options })) { ... }
 */
import { recordObservedCall } from "../fetch-patch.js";
import { captureCallSite } from "../stack.js";
import { TELEMETRY_VERSION, rawErrorName, skeleton } from "../telemetry.js";
import type { CallSite } from "../types.js";
import { SpanTracker, pickKeys, stringOr } from "./shared.js";

export const CLAUDE_AGENT_SDK_SOURCE = "claude-agent-sdk";

type HookInput = Record<string, unknown>;
type HookCallback = (input: HookInput, toolUseID: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;
type HookMatcher = { matcher?: string; hooks: HookCallback[]; timeout?: number };
export type ClaudeAgentHooks = Record<string, HookMatcher[]>;

export interface ClaudeAgentTrackerOptions {
  /** Name of the run span (default `claude-agent`). */
  name?: string;
}

/**
 * Tracks one `query()` run. `instrumentClaudeAgentQuery` wires it up; use it
 * directly to combine with your own hooks and message loop:
 *
 *   const tracker = createClaudeAgentTracker({ name: "triage" });
 *   const q = query({ prompt, options: { ...options, hooks: tracker.mergeHooks(options.hooks) } });
 *   for await (const message of q) { tracker.observe(message); ... }
 *   tracker.finish();
 */
export class ClaudeAgentTracker {
  private readonly tracker = new SpanTracker("claudeAgent");
  private readonly runKey: string;
  private readonly callSite: CallSite | null;
  private started = false;
  private finished = false;

  constructor(private readonly options: ClaudeAgentTrackerOptions = {}) {
    this.runKey = `run:${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    // The caller's frames: every usage event of this run points at the query() call.
    this.callSite = captureCallSite();
  }

  /** Open the run span. Called by the first hook or message if not called explicitly. */
  start(input?: unknown): void {
    if (this.started) return;
    this.started = true;
    this.tracker.start({
      key: this.runKey,
      kind: "agent",
      name: stringOr(this.options.name, "claude-agent"),
      attributes: { framework: "claude-agent-sdk" },
      input,
    });
  }

  /** Hooks to pass as `options.hooks`, merged after any you already have. */
  mergeHooks(existing?: Partial<ClaudeAgentHooks>): ClaudeAgentHooks {
    const own: ClaudeAgentHooks = {
      PreToolUse: [{ hooks: [this.hook((input, toolUseID) => this.toolStarted(input, toolUseID))] }],
      PostToolUse: [{ hooks: [this.hook((input, toolUseID) => this.toolEnded(input, toolUseID, false))] }],
      PostToolUseFailure: [{ hooks: [this.hook((input, toolUseID) => this.toolEnded(input, toolUseID, true))] }],
      SubagentStart: [{ hooks: [this.hook((input) => this.subagentStarted(input))] }],
      SubagentStop: [{ hooks: [this.hook((input) => this.subagentStopped(input))] }],
    };
    const merged: ClaudeAgentHooks = {};
    for (const [event, matchers] of Object.entries(existing ?? {})) {
      if (Array.isArray(matchers)) merged[event] = [...matchers];
    }
    for (const [event, matchers] of Object.entries(own)) {
      merged[event] = [...(merged[event] ?? []), ...matchers];
    }
    return merged;
  }

  /** Record one message from the query stream. */
  observe(message: unknown): void {
    try {
      this.start();
      if (!message || typeof message !== "object") return;
      const record = message as Record<string, unknown>;
      if (record["type"] === "system" && record["subtype"] === "init") {
        this.sessionInit = pickKeys(record, ["session_id", "model", "permissionMode", "apiKeySource", "claude_code_version"]);
      }
      if (!carriesUsage(record)) return;
      const parentToolUseId = typeof record["parent_tool_use_id"] === "string" ? record["parent_tool_use_id"] : null;
      const context = this.tracker.contextFor(parentToolUseId) ?? this.tracker.contextFor(this.runKey) ?? {};
      recordObservedCall({
        telemetry: {
          v: TELEMETRY_VERSION,
          source: CLAUDE_AGENT_SDK_SOURCE,
          request: null,
          response: { status: null, headers: {}, body: skeleton(record), bytes: null },
          stream: null,
          error: null,
          startedAt: new Date().toISOString(),
          durationMs: null,
        },
        url: null,
        method: "",
        callSite: this.callSite,
        context,
        responseContent: record,
      });
    } catch {
      // Telemetry never affects the agent.
    }
  }

  /** Close every open span; pass the error when the run failed. */
  finish(error?: unknown): void {
    if (this.finished) return;
    this.finished = true;
    try {
      this.start();
      this.tracker.end(this.runKey, {
        failed: error !== undefined && error !== null,
        errorName: error !== undefined && error !== null ? rawErrorName(error) : undefined,
        raw: this.sessionInit,
      });
      this.tracker.endAll();
    } catch {
      // Telemetry never affects the agent.
    }
  }

  private sessionInit: Record<string, unknown> | undefined;

  private hook(handler: (input: HookInput, toolUseID: string | undefined) => void): HookCallback {
    return async (input, toolUseID) => {
      try {
        this.start();
        handler(input ?? {}, toolUseID);
      } catch {
        // Telemetry never affects the agent.
      }
      return {};
    };
  }

  private parentFor(input: HookInput): string {
    const agentId = input["agent_id"];
    if (typeof agentId === "string" && this.tracker.has(`agent:${agentId}`)) return `agent:${agentId}`;
    return this.runKey;
  }

  private toolStarted(input: HookInput, toolUseID: string | undefined): void {
    const id = typeof input["tool_use_id"] === "string" ? input["tool_use_id"] : toolUseID;
    if (!id) return;
    this.tracker.start({
      key: id,
      parentKey: this.parentFor(input),
      kind: "tool",
      name: stringOr(input["tool_name"], "tool"),
      attributes: { framework: "claude-agent-sdk" },
      raw: pickKeys(input, ["tool_name", "tool_use_id", "agent_id", "agent_type", "mcp_server", "permission_mode"]),
      input: input["tool_input"],
    });
  }

  private toolEnded(input: HookInput, toolUseID: string | undefined, failed: boolean): void {
    const id = typeof input["tool_use_id"] === "string" ? input["tool_use_id"] : toolUseID;
    if (!id) return;
    this.tracker.end(id, {
      failed,
      raw: pickKeys(input, ["tool_name", "tool_use_id", "agent_id", "agent_type", "mcp_server", "duration_ms", "is_interrupt", "error"]),
      output: failed ? undefined : input["tool_response"],
    });
  }

  private subagentStarted(input: HookInput): void {
    const agentId = input["agent_id"];
    if (typeof agentId !== "string") return;
    this.tracker.start({
      key: `agent:${agentId}`,
      parentKey: this.runKey,
      kind: "agent",
      name: stringOr(input["agent_type"], "subagent"),
      attributes: { framework: "claude-agent-sdk" },
      raw: pickKeys(input, ["agent_id", "agent_type", "session_id"]),
    });
  }

  private subagentStopped(input: HookInput): void {
    const agentId = input["agent_id"];
    if (typeof agentId !== "string") return;
    this.tracker.end(`agent:${agentId}`, {
      raw: pickKeys(input, ["agent_id", "agent_type", "session_id"]),
    });
  }
}

/** A message carries usage when it (or its nested message or stream event) has a `usage` block. */
function carriesUsage(message: Record<string, unknown>): boolean {
  if (isObject(message["usage"]) || isObject(message["modelUsage"])) return true;
  const inner = message["message"];
  if (isObject(inner) && isObject((inner as Record<string, unknown>)["usage"])) return true;
  const event = message["event"];
  if (isObject(event)) {
    const record = event as Record<string, unknown>;
    if (isObject(record["usage"])) return true;
    const eventMessage = record["message"];
    if (isObject(eventMessage) && isObject((eventMessage as Record<string, unknown>)["usage"])) return true;
  }
  return false;
}

function isObject(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function createClaudeAgentTracker(options?: ClaudeAgentTrackerOptions): ClaudeAgentTracker {
  return new ClaudeAgentTracker(options);
}

type QueryParams = { prompt: unknown; options?: Record<string, unknown> };

/**
 * Wrap the SDK's `query` so every call is traced. The returned Query keeps
 * all of its methods (interrupt, setPermissionMode, ...); only iteration is
 * observed. Your own `options.hooks` still run.
 */
export function instrumentClaudeAgentQuery<F extends (params: QueryParams) => AsyncIterable<unknown>>(
  query: F,
  options: ClaudeAgentTrackerOptions = {},
): F {
  const wrapped = (params: QueryParams) => {
    const tracker = new ClaudeAgentTracker(options);
    tracker.start(typeof params?.prompt === "string" ? params.prompt : undefined);
    const queryOptions = params?.options ?? {};
    const instance = query({
      ...params,
      options: {
        ...queryOptions,
        hooks: tracker.mergeHooks(queryOptions["hooks"] as Partial<ClaudeAgentHooks> | undefined),
      },
    });
    return observeQuery(instance, tracker);
  };
  return wrapped as unknown as F;
}

function observeQuery<Q extends AsyncIterable<unknown>>(instance: Q, tracker: ClaudeAgentTracker): Q {
  const target = instance as unknown as AsyncIterator<unknown> & Record<string | symbol, unknown>;
  let iterator: AsyncIterator<unknown> | null = null;
  const source = (): AsyncIterator<unknown> => {
    iterator ??= typeof target.next === "function"
      ? target
      : (instance as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    return iterator;
  };
  const settle = async (step: Promise<IteratorResult<unknown>>): Promise<IteratorResult<unknown>> => {
    try {
      const result = await step;
      if (result.done) tracker.finish();
      else tracker.observe(result.value);
      return result;
    } catch (error) {
      tracker.finish(error);
      throw error;
    }
  };
  const proxy: Q = new Proxy(instance as object, {
    get(object, property, receiver) {
      if (property === Symbol.asyncIterator) return () => proxy;
      if (property === "next") return (...args: [] | [unknown]) => settle(source().next(...args));
      if (property === "return") {
        return (value?: unknown) => {
          tracker.finish();
          const finisher = source().return;
          return finisher ? finisher.call(source(), value) : Promise.resolve({ done: true, value });
        };
      }
      if (property === "throw") {
        return (error?: unknown) => {
          tracker.finish(error);
          const thrower = source().throw;
          return thrower ? thrower.call(source(), error) : Promise.reject(error);
        };
      }
      const value = Reflect.get(object, property, receiver);
      return typeof value === "function" ? value.bind(object) : value;
    },
  }) as Q;
  return proxy;
}
