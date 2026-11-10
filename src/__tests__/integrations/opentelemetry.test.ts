import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { CostKey } from "../../index.js";
import { CostKeySpanProcessor } from "../../integrations/opentelemetry.js";
import { json, sse, startHarness, type Harness } from "./harness.js";

describe("OpenTelemetry bridge (SpanProcessor)", () => {
  let harness: Harness;
  let processor: CostKeySpanProcessor;
  let provider: BasicTracerProvider;

  beforeAll(() => {
    harness = startHarness((url, _init, body) => {
      if (url.hostname !== "api.openai.com") return null;
      if ((body as Record<string, unknown>)?.["stream"] === true) {
        return sse([{ id: "c1", choices: [{ delta: { content: "hi" } }] }, { id: "c1", choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }]);
      }
      return json({ id: "chatcmpl-otel", model: "gpt-4o-mini", usage: { prompt_tokens: 3, completion_tokens: 1 } });
    });
    processor = new CostKeySpanProcessor();
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    provider = new BasicTracerProvider({ spanProcessors: [processor] });
    trace.setGlobalTracerProvider(provider);
  });

  beforeEach(() => harness.reset());

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    await harness.close();
  });

  it("forwards GenAI spans with raw attributes, otelKind, otelName and the scope, and attributes calls to the active span", async () => {
    const tracer = trace.getTracer("my-agent-framework", "1.2.3");
    await tracer.startActiveSpan("invoke_agent planner", { kind: 1, attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "planner" } }, async (agentSpan) => {
      await tracer.startActiveSpan("chat gpt-4o-mini", {
        kind: 2,
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "gpt-4o-mini",
          "gen_ai.prompt": "What is my balance?",
          "gen_ai.usage.input_tokens": 3,
        },
      }, async (chatSpan) => {
        await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }) });
        chatSpan.setAttribute("gen_ai.response.id", "chatcmpl-otel");
        chatSpan.end();
      });
      agentSpan.end();
    });
    await harness.flush();

    const ended = harness.endedSpans();
    expect(ended.map((span) => span["name"])).toEqual(["chat gpt-4o-mini", "invoke_agent planner"]);
    const [chat, agent] = ended;
    // The server maps GenAI conventions: the SDK sends kind custom.
    expect(chat!["kind"]).toBe("custom");
    expect(chat!["parentSpanId"]).toBe(agent!["id"]);
    expect(chat!["attributes"]).toMatchObject({ otelKind: 2, otelName: "chat gpt-4o-mini", otelScope: "my-agent-framework" });
    // Metadata-only: identifiers whose last key segment is allowlisted are kept, text is a length.
    expect(chat!["attributes"]["otel"]).toEqual({
      "gen_ai.operation.name": { $s: 4 },
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.prompt": { $s: 19 },
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.response.id": "chatcmpl-otel",
    });
    // The GenAI span is not a call event; the HTTP request is the one call.
    const calls = harness.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!["spanId"]).toBe(chat!["id"]);
    expect(calls[0]!["context"]["traceId"]).toBe(chat!["traceId"]);
    // A root OTel span outside any CostKey trace opens one, under the OTel trace id.
    const lifecycle = harness.lifecycle();
    expect(lifecycle.map((event) => event["lifecycle"])).toEqual(["started", "completed"]);
    expect(lifecycle[0]!["traceId"]).toBe(chat!["traceId"]);
    expect(String(chat!["traceId"])).toMatch(/^[0-9a-f]{32}$/);
  });

  it("joins the caller's CostKey span and reports the raw exception type", async () => {
    const tracer = trace.getTracer("tools");
    let parent = "";
    await CostKey.agent("support", async (span) => {
      parent = span.id;
      const otelSpan = tracer.startSpan("execute_tool refund");
      otelSpan.recordException(new RangeError("amount too large"));
      otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: "amount too large" });
      otelSpan.end();
    });
    await harness.flush();
    const toolSpan = harness.endedSpans().find((span) => span["name"] === "execute_tool refund")!;
    expect(toolSpan["parentSpanId"]).toBe(parent);
    expect(toolSpan["status"]).toBe("error");
    expect(toolSpan["errorName"]).toBe("RangeError");
    expect(JSON.stringify(toolSpan)).not.toContain("amount too large");
  });
  it("attributes a streamed call to the active span even when the stream is read after it ends", async () => {
    const tracer = trace.getTracer("streams");
    const response = await tracer.startActiveSpan("chat stream", async (span) => {
      const streamed = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o-mini", stream: true, messages: [] }),
      });
      span.end();
      return streamed;
    });
    await response.text();
    await harness.flush();
    const span = harness.endedSpans().find((candidate) => candidate["name"] === "chat stream")!;
    const [call] = harness.calls();
    expect(call!["streaming"]).toBe(true);
    expect(call!["spanId"]).toBe(span["id"]);
    expect(call!["context"]["traceId"]).toBe(span["traceId"]);
    expect(call!["telemetry"]["stream"]["chunkCount"]).toBe(2);
  });
});
