import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Agent, run, setTraceProcessors, setTracingDisabled, tool } from "@openai/agents";
import { z } from "zod";
import { CostKey } from "../../index.js";
import { CostKeyAgentsProcessor } from "../../integrations/openai-agents.js";
import { json, startHarness, type Event, type Harness } from "./harness.js";

/** Responses API bodies for a tool call, a handoff and a final answer. */
function responseBody(id: string, output: unknown[]) {
  return {
    id,
    object: "response",
    created_at: 1_760_000_000,
    status: "completed",
    model: "gpt-4.1-2025-04-14",
    output,
    usage: {
      input_tokens: 50,
      output_tokens: 10,
      total_tokens: 60,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

/** A streamed Responses API answer (SSE), as `run(..., { stream: true })` requests it. */
function streamedAnswer(): Response {
  const final = responseBody("resp_stream", [{
    type: "message", id: "msg_s", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Streamed hi.", annotations: [] }],
  }]);
  const events = [
    { type: "response.created", sequence_number: 0, response: { ...final, status: "in_progress", output: [] } },
    { type: "response.output_text.delta", sequence_number: 1, item_id: "msg_s", output_index: 0, content_index: 0, delta: "Streamed hi." },
    { type: "response.completed", sequence_number: 2, response: final },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("OpenAI Agents SDK integration (@openai/agents)", () => {
  let harness: Harness;
  let processor: CostKeyAgentsProcessor;
  let turn = 0;

  // One CostKey session for the file: the Agents SDK caches its default
  // OpenAI client (and the fetch it captured) across runs.
  beforeAll(() => {
    process.env["OPENAI_API_KEY"] = "sk-test-not-real";
    harness = startHarness((url, _init, body) => {
      if (url.hostname !== "api.openai.com" || url.pathname !== "/v1/responses") return null;
      if ((body as Record<string, unknown>)["stream"] === true) return streamedAnswer();
      turn++;
      if (turn === 1) {
        return json(responseBody("resp_1", [{
          type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather",
          arguments: JSON.stringify({ city: "Paris" }), status: "completed",
        }]));
      }
      if (turn === 2) {
        return json(responseBody("resp_2", [{
          type: "function_call", id: "fc_2", call_id: "call_2", name: "transfer_to_Weather_reporter",
          arguments: "{}", status: "completed",
        }]));
      }
      return json(responseBody("resp_3", [{
        type: "message", id: "msg_1", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Sunny in Paris.", annotations: [] }],
      }]));
    });
    processor = new CostKeyAgentsProcessor();
    setTraceProcessors([processor]);
    setTracingDisabled(false);
  });

  beforeEach(() => {
    turn = 0;
    harness.reset();
  });

  afterAll(async () => {
    await processor.shutdown();
    setTraceProcessors([]);
    await harness.close();
  });

  it("turns agents, tools, handoffs and guardrails into spans and attributes model calls to them", async () => {
    let toolSawContext: Record<string, unknown> = {};
    const getWeather = tool({
      name: "get_weather",
      description: "Weather for a city",
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        toolSawContext = CostKey.getCurrentContext();
        return `Sunny in ${city}`;
      },
    });
    const reporter = new Agent({ name: "Weather reporter", instructions: "Report the weather." });
    const triage = new Agent({
      name: "Triage",
      instructions: "Use tools, then hand off.",
      tools: [getWeather],
      handoffs: [reporter],
      inputGuardrails: [{
        name: "no_secrets",
        execute: async () => ({ outputInfo: { checked: true }, tripwireTriggered: false }),
      }],
    });

    const result = await CostKey.startTrace({ name: "weather-request" }, () => run(triage, "Weather in Paris?"));
    expect(result.finalOutput).toBe("Sunny in Paris.");
    await harness.flush();

    const ended = harness.endedSpans();
    const byKind = (kind: string) => ended.filter((span) => span["kind"] === kind);
    expect(byKind("agent").map((span) => span["name"]).sort()).toEqual(["Triage", "Weather reporter"]);
    expect(byKind("tool").map((span) => span["name"])).toEqual(["get_weather"]);
    expect(byKind("handoff").map((span) => span["name"])).toEqual(["Weather reporter"]);
    expect(byKind("guardrail").map((span) => span["name"])).toEqual(["no_secrets"]);
    // No model generation/response spans and no extra call events.
    expect(ended.every((span) => span["attributes"]["spanType"] !== "response")).toBe(true);

    // The Agents SDK's own tree: workflow task → agent → turn → tool/handoff.
    const workflow = byKind("task")[0]!;
    const triageSpan = byKind("agent").find((span) => span["name"] === "Triage")!;
    const reporterSpan = byKind("agent").find((span) => span["name"] === "Weather reporter")!;
    const turns = byKind("step");
    expect(turns.map((span) => span["name"])).toEqual(["turn 1", "turn 2", "turn 3"]);
    const toolSpan = byKind("tool")[0]!;
    expect(workflow["name"]).toBe("Agent workflow");
    expect(triageSpan["parentSpanId"]).toBe(workflow["id"]);
    expect(reporterSpan["parentSpanId"]).toBe(workflow["id"]);
    expect(turns[0]!["parentSpanId"]).toBe(triageSpan["id"]);
    expect(turns[2]!["parentSpanId"]).toBe(reporterSpan["id"]);
    expect(toolSpan["parentSpanId"]).toBe(turns[0]!["id"]);
    expect(byKind("handoff")[0]!["parentSpanId"]).toBe(turns[1]!["id"]);
    expect(byKind("guardrail")[0]!["parentSpanId"]).toBe(triageSpan["id"]);

    // One call event per provider request (fetch patch), none from the integration,
    // each attributed to the turn it ran in and labelled with its agent.
    const calls = harness.calls();
    expect(calls).toHaveLength(3);
    expect(harness.providerRequests).toHaveLength(3);
    expect(calls.map((call) => call["spanId"])).toEqual(turns.map((span) => span["id"]));
    expect(calls.map((call) => call["context"]["agent"])).toEqual(["Triage", "Triage", "Weather reporter"]);
    expect(calls[0]!["telemetry"]["response"]["body"]["usage"]).toEqual({
      input_tokens: 50, output_tokens: 10, total_tokens: 60,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
    });

    // The tool body ran with the tool span as its CostKey context.
    expect(toolSawContext["spanId"]).toBe(toolSpan["id"]);
    expect(toolSawContext["tool"]).toBe("get_weather");

    // Everything joins the caller's CostKey trace (no second trace opened).
    const traceIds = new Set([...ended.map((span) => span["traceId"]), ...calls.map((call) => call["context"]["traceId"])]);
    expect(traceIds.size).toBe(1);
    expect(harness.lifecycle().map((event: Event) => event["traceName"])).toEqual(["weather-request", "weather-request"]);

    // Metadata-only: raw span data is a skeleton (tool arguments never leave).
    expect(JSON.stringify(ended)).not.toContain("Paris");
    expect(toolSpan["attributes"]["openaiAgents"]).toMatchObject({ type: "function", name: { $s: 11 } });
  });

  it("opens its own trace when the run starts outside a CostKey trace", async () => {
    const answer = new Agent({ name: "Answerer", instructions: "Answer." });
    turn = 2; // skip straight to the final message
    await run(answer, "hello");
    await harness.flush();
    const lifecycle = harness.lifecycle();
    expect(lifecycle.map((event) => event["lifecycle"])).toEqual(["started", "completed"]);
    const agentSpan = harness.endedSpans().find((span) => span["kind"] === "agent")!;
    const turnSpan = harness.endedSpans().find((span) => span["kind"] === "step")!;
    expect(agentSpan["traceId"]).toBe(lifecycle[0]!["traceId"]);
    // The Agents SDK trace id becomes the CostKey trace id.
    expect(String(agentSpan["traceId"])).toMatch(/^trace_/);
    expect(harness.calls()).toHaveLength(1);
    expect(harness.calls()[0]!["spanId"]).toBe(turnSpan["id"]);
    expect(harness.calls()[0]!["context"]["agent"]).toBe("Answerer");
  });
  it("attributes a streamed run's model call to its turn", async () => {
    const streamer = new Agent({ name: "Streamer", instructions: "Answer." });
    const result = await run(streamer, "hello", { stream: true });
    let text = "";
    for await (const chunk of result.toTextStream()) text += chunk;
    await result.completed;
    expect(text).toBe("Streamed hi.");
    await harness.flush();
    const ended = harness.endedSpans();
    const agentSpan = ended.find((span) => span["kind"] === "agent")!;
    const turnSpan = ended.find((span) => span["kind"] === "step")!;
    const calls = harness.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!["streaming"]).toBe(true);
    expect(calls[0]!["spanId"]).toBe(turnSpan["id"]);
    expect(calls[0]!["context"]["agent"]).toBe("Streamer");
    expect(calls[0]!["context"]["traceId"]).toBe(agentSpan["traceId"]);
    expect(calls[0]!["telemetry"]["stream"]["chunkCount"]).toBe(3);
  });
});
