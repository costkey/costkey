import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CostKey } from "../../index.js";
import { ClaudeAgentTracker, instrumentClaudeAgentQuery } from "../../integrations/claude-agent-sdk.js";
import { startHarness, type Harness } from "./harness.js";

const assistant = (content: unknown[], parent: string | null = null) => ({
  type: "assistant",
  message: {
    id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content,
    stop_reason: null, usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
  },
  parent_tool_use_id: parent,
  session_id: "sess-1",
  uuid: "u1",
});

describe("Claude Agent SDK integration (hooks + message stream)", () => {
  let harness: Harness;

  beforeAll(() => {
    harness = startHarness(() => null);
  });

  beforeEach(() => harness.reset());

  afterAll(async () => {
    await harness.close();
  });

  it("maps hooks to run, tool and subagent spans and sends usage messages as raw call events", async () => {
    const tracker = new ClaudeAgentTracker({ name: "triage" });
    const hooks = tracker.mergeHooks({ PreToolUse: [{ hooks: [async () => ({ continue: true })] }] });
    // The user's own hook stays first.
    expect(hooks["PreToolUse"]).toHaveLength(2);
    const fire = async (event: string, input: Record<string, unknown>, toolUseID?: string) => {
      for (const matcher of hooks[event]!) {
        for (const hook of matcher.hooks) await hook(input, toolUseID, { signal: new AbortController().signal });
      }
    };

    tracker.observe({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-sonnet-4-5", cwd: "/secret/path" });
    tracker.observe(assistant([{ type: "tool_use", id: "toolu_task", name: "Task", input: { prompt: "research" } }]));
    await fire("PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { prompt: "research" }, tool_use_id: "toolu_task", session_id: "sess-1" }, "toolu_task");
    await fire("SubagentStart", { hook_event_name: "SubagentStart", agent_id: "agent-7", agent_type: "researcher", session_id: "sess-1" });
    await fire("PreToolUse", { hook_event_name: "PreToolUse", tool_name: "WebSearch", tool_input: { query: "q" }, tool_use_id: "toolu_ws", agent_id: "agent-7" }, "toolu_ws");
    tracker.observe(assistant([{ type: "text", text: "sub answer" }], "toolu_task"));
    await fire("PostToolUseFailure", { hook_event_name: "PostToolUseFailure", tool_name: "WebSearch", tool_use_id: "toolu_ws", error: "network down", agent_id: "agent-7" }, "toolu_ws");
    await fire("SubagentStop", { hook_event_name: "SubagentStop", agent_id: "agent-7", agent_type: "researcher" });
    await fire("PostToolUse", { hook_event_name: "PostToolUse", tool_name: "Task", tool_use_id: "toolu_task", tool_response: "done" }, "toolu_task");
    tracker.observe({ type: "user", message: { role: "user", content: "tool result" }, parent_tool_use_id: null });
    tracker.observe({
      type: "result", subtype: "success", is_error: false, num_turns: 2, duration_ms: 900, total_cost_usd: 0.0123,
      usage: { input_tokens: 24, output_tokens: 6 },
      modelUsage: { "claude-sonnet-4-5": { inputTokens: 24, outputTokens: 6, costUSD: 0.0123 } },
      result: "final secret answer", session_id: "sess-1",
    });
    tracker.finish();
    await harness.flush();

    const ended = harness.endedSpans();
    const run = ended.find((span) => span["name"] === "triage")!;
    const task = ended.find((span) => span["name"] === "Task")!;
    const sub = ended.find((span) => span["name"] === "researcher")!;
    const search = ended.find((span) => span["name"] === "WebSearch")!;
    expect(run).toMatchObject({ kind: "agent", status: "ok" });
    expect(task).toMatchObject({ kind: "tool", status: "ok", parentSpanId: run["id"] });
    expect(sub).toMatchObject({ kind: "agent", parentSpanId: run["id"] });
    expect(search).toMatchObject({ kind: "tool", status: "error", parentSpanId: sub["id"] });

    // One call event per message carrying usage: 2 assistant messages and the result.
    const calls = harness.calls();
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call["telemetry"]).toMatchObject({ v: 1, source: "claude-agent-sdk", request: null, stream: null, error: null });
      expect(call).not.toHaveProperty("usage");
      expect(call).not.toHaveProperty("costUsd");
    }
    expect(calls[0]!["telemetry"]["response"]["body"]).toEqual({
      type: "assistant",
      message: {
        id: "msg_1", type: "message", role: { $s: 9 }, model: "claude-sonnet-4-5",
        content: [{ type: "tool_use", id: "toolu_task", name: { $s: 4 }, input: { prompt: { $s: 8 } } }],
        stop_reason: null, usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      session_id: { $s: 6 },
      uuid: { $s: 2 },
    });
    // The subagent's message is attributed to the Task tool that spawned it.
    expect(calls[1]!["spanId"]).toBe(task["id"]);
    expect(calls[0]!["spanId"]).toBe(run["id"]);
    // The SDK's own cost estimate travels raw; no cost math here.
    expect(calls[2]!["telemetry"]["response"]["body"]).toMatchObject({
      total_cost_usd: 0.0123,
      modelUsage: { "claude-sonnet-4-5": { inputTokens: 24, outputTokens: 6, costUSD: 0.0123 } },
      result: { $s: 19 },
    });
    expect(JSON.stringify(harness.events())).not.toContain("final secret answer");
    expect(JSON.stringify(harness.events())).not.toContain("network down");
  });
});

// ── End to end with the real Claude Code process ──

/** The platform binary the SDK spawns (an optional dependency; skipped when absent). */
function claudeBinary(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const sdkDir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
    const name = `claude-agent-sdk-${process.platform}-${process.arch}`;
    for (const base of [join(sdkDir, ".."), join(sdkDir, "..", "..", "..", "..", "..", "node_modules", "@anthropic-ai")]) {
      for (const file of ["claude", "claude.exe"]) {
        const candidate = join(base, name, file);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

const binary = claudeBinary();

/** An Anthropic Messages API stand-in: a Glob tool call, then a final answer. */
function anthropicServer(): Promise<{ server: Server; url: string; requests: Array<Record<string, any>> }> {
  const requests: Array<Record<string, any>> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
        response.writeHead(request.url?.includes("count_tokens") ? 200 : 404, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const body = JSON.parse(raw || "{}") as Record<string, any>;
      requests.push(body);
      const sawTool = JSON.stringify(body["messages"] ?? []).includes("tool_result");
      const usage = { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const blocks = sawTool
        ? [{ type: "text", text: "Found notes.txt" }]
        : [{ type: "tool_use", id: "toolu_glob_1", name: "Glob", input: { pattern: "*.txt" } }];
      const events: Array<[string, unknown]> = [
        ["message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body["model"], content: [], stop_reason: null, usage } }],
      ];
      blocks.forEach((block, index) => {
        if (block.type === "text") {
          events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
          events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
        } else {
          events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]);
          events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
        }
        events.push(["content_block_stop", { type: "content_block_stop", index }]);
      });
      events.push(["message_delta", { type: "message_delta", delta: { stop_reason: sawTool ? "end_turn" : "tool_use" }, usage: { output_tokens: 7 } }]);
      events.push(["message_stop", { type: "message_stop" }]);
      if (body["stream"] === false) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "msg_ns", type: "message", role: "assistant", model: body["model"], content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${address.port}`, requests });
  }));
}

describe.skipIf(!binary)("Claude Agent SDK end to end (real Claude Code process, mocked Anthropic API)", () => {
  let harness: Harness;
  let api: Awaited<ReturnType<typeof anthropicServer>>;
  let workdir: string;

  beforeAll(async () => {
    harness = startHarness(() => null);
    api = await anthropicServer();
    workdir = mkdtempSync(join(tmpdir(), "costkey-claude-agent-"));
    writeFileSync(join(workdir, "notes.txt"), "private notes");
  });

  afterAll(async () => {
    await harness.close();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    rmSync(workdir, { recursive: true, force: true });
  });

  it("records the run, the Glob tool use and every usage-carrying message", async () => {
    const tracedQuery = instrumentClaudeAgentQuery(query, { name: "file-finder" });
    const seen: string[] = [];
    const hookCalls: string[] = [];
    await CostKey.startTrace({ name: "claude-run" }, async () => {
      for await (const message of tracedQuery({
        prompt: "Which text files are here?",
        options: {
          cwd: workdir,
          model: "claude-sonnet-4-5",
          allowedTools: ["Glob"],
          settingSources: [],
          maxTurns: 4,
          pathToClaudeCodeExecutable: binary!,
          hooks: { PostToolUse: [{ hooks: [async (input) => { hookCalls.push(String(input["tool_name"])); return {}; }] }] },
          env: {
            PATH: process.env["PATH"] ?? "",
            HOME: workdir,
            CLAUDE_CONFIG_DIR: join(workdir, ".claude"),
            ANTHROPIC_BASE_URL: api.url,
            ANTHROPIC_API_KEY: "sk-ant-test-not-real",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_TELEMETRY: "1",
            DISABLE_AUTOUPDATER: "1",
            DISABLE_ERROR_REPORTING: "1",
          },
        },
      })) {
        seen.push(`${(message as any).type}:${(message as any).subtype ?? ""}`);
      }
    });
    await harness.flush();

    expect(api.requests.length).toBeGreaterThanOrEqual(2);
    expect(seen).toContain("result:success");
    expect(hookCalls).toContain("Glob");

    const ended = harness.endedSpans();
    const run = ended.find((span) => span["name"] === "file-finder")!;
    const glob = ended.find((span) => span["kind"] === "tool" && span["name"] === "Glob")!;
    expect(run).toMatchObject({ kind: "agent", status: "ok" });
    expect(glob).toMatchObject({ status: "ok", parentSpanId: run["id"] });

    const calls = harness.calls();
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call["telemetry"]["source"]).toBe("claude-agent-sdk");
      expect(call["telemetry"]["request"]).toBeNull();
      expect(call["context"]["traceId"]).toBe(run["traceId"]);
    }
    const result = calls.find((call) => call["telemetry"]["response"]["body"]["type"] === "result")!;
    expect(result["telemetry"]["response"]["body"]["usage"]).toMatchObject({ input_tokens: expect.any(Number) });
    expect(JSON.stringify(harness.events())).not.toContain("private notes");
  }, 60_000);
});
