import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateText, isStepCount, registerTelemetry, streamText, tool, ToolLoopAgent } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { CostKey } from "../../index.js";
import { costkeyTelemetry } from "../../integrations/ai-sdk.js";
import { json, sse, startHarness, type Harness } from "./harness.js";

const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };

function chatCompletion(message: Record<string, unknown>, finish: string) {
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    created: 1_760_000_000,
    model: "gpt-4o-mini-2024-07-18",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
    usage,
  };
}

const toolCall = (name: string, args: unknown) => chatCompletion({
  content: null,
  tool_calls: [{ id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
}, "tool_calls");

describe("Vercel AI SDK integration (ai v7 telemetry)", () => {
  let harness: Harness;
  let script: Array<() => Response> = [];

  beforeAll(() => {
    harness = startHarness((url, _init, body) => {
      if (url.hostname !== "api.openai.com") return null;
      const next = script.shift();
      if (!next) throw new Error(`no scripted response for ${JSON.stringify(body)}`);
      return next();
    });
    registerTelemetry(costkeyTelemetry());
  });

  beforeEach(() => harness.reset());

  afterAll(async () => {
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [];
    await harness.close();
  });

  const openai = createOpenAI({ apiKey: "sk-test-not-real" });

  it("generateText with tools: run, steps and tool calls become spans; calls attach to their step", async () => {
    let toolContext: Record<string, unknown> = {};
    script = [
      () => json(toolCall("getWeather", { city: "Paris" })),
      () => json(chatCompletion({ content: "Sunny in Paris." }, "stop")),
    ];
    const result = await CostKey.startTrace({ name: "chat" }, () => generateText({
      model: openai.chat("gpt-4o-mini"),
      prompt: "Weather in Paris?",
      tools: {
        getWeather: tool({
          description: "Weather for a city",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => {
            toolContext = CostKey.getCurrentContext();
            return { forecast: `sunny in ${city}` };
          },
        }),
      },
      stopWhen: isStepCount(3),
      telemetry: { functionId: "weather-chat" },
    }));
    expect(result.text).toBe("Sunny in Paris.");
    await harness.flush();

    const ended = harness.endedSpans();
    expect(ended.map((span) => [span["kind"], span["name"], span["status"]])).toEqual([
      ["tool", "getWeather", "ok"],
      ["step", "step 0", "ok"],
      ["step", "step 1", "ok"],
      ["agent", "weather-chat", "ok"],
    ]);
    const [toolSpan, step0, step1, run] = ended;
    expect(step0!["parentSpanId"]).toBe(run!["id"]);
    expect(step1!["parentSpanId"]).toBe(run!["id"]);
    expect(toolSpan!["parentSpanId"]).toBe(step0!["id"]);
    expect(toolContext["spanId"]).toBe(toolSpan!["id"]);
    expect(toolContext["tool"]).toBe("getWeather");
    expect(toolContext["agent"]).toBe("weather-chat");

    // Exactly one call event per HTTP request, attributed to its step.
    const calls = harness.calls();
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call["spanId"])).toEqual([step0!["id"], step1!["id"]]);
    expect(calls.every((call) => call["context"]["agent"] === "weather-chat")).toBe(true);
    expect(calls[0]!["telemetry"]["response"]["body"]["usage"]).toEqual(usage);

    // Run attributes are raw framework fields; content is a skeleton in metadata-only mode.
    expect(run!["attributes"]).toMatchObject({ framework: "ai-sdk", operationId: "ai.generateText" });
    expect(run!["attributes"]["aiSdk"]).toMatchObject({ provider: "openai.chat", modelId: "gpt-4o-mini", tools: [{ $s: 10 }] });
    expect(JSON.stringify(ended)).not.toContain("Paris");
    expect(new Set(ended.map((span) => span["traceId"])).size).toBe(1);
  });

  it("streamText: the stream's call is attributed to its step", async () => {
    script = [() => sse([
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }] },
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", choices: [], usage },
    ])];
    const result = streamText({ model: openai.chat("gpt-4o-mini"), prompt: "Say hi" });
    expect(await result.text).toBe("Hi");
    await harness.flush();
    const ended = harness.endedSpans();
    expect(ended.map((span) => [span["kind"], span["name"]])).toEqual([["step", "step 0"], ["agent", "ai.streamText"]]);
    const calls = harness.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!["spanId"]).toBe(ended[0]!["id"]);
    expect(calls[0]!["telemetry"]["stream"]["chunkCount"]).toBe(3);
    // A run outside any CostKey trace opens one.
    expect(harness.lifecycle().map((event) => event["lifecycle"])).toEqual(["started", "completed"]);
    // stream_options.include_usage was requested.
    expect((harness.providerRequests[0]!.body as Record<string, any>)["stream_options"]).toEqual({ include_usage: true });
  });

  it("ToolLoopAgent and a nested generateText inside a tool keep the tree", async () => {
    script = [
      () => json(toolCall("research", { topic: "fees" })),
      () => json(chatCompletion({ content: "inner answer" }, "stop")),
      () => json(chatCompletion({ content: "outer answer" }, "stop")),
    ];
    const agent = new ToolLoopAgent({
      model: openai.chat("gpt-4o-mini"),
      tools: {
        research: tool({
          inputSchema: z.object({ topic: z.string() }),
          execute: async ({ topic }) => (await generateText({ model: openai.chat("gpt-4o-mini"), prompt: topic })).text,
        }),
      },
      telemetry: { functionId: "planner" },
    });
    const result = await agent.generate({ prompt: "Research fees" });
    expect(result.text).toBe("outer answer");
    await harness.flush();
    const ended = harness.endedSpans();
    const toolSpan = ended.find((span) => span["kind"] === "tool")!;
    const agents = ended.filter((span) => span["kind"] === "agent");
    const planner = agents.find((span) => span["name"] === "planner")!;
    const inner = agents.find((span) => span["name"] === "ai.generateText")!;
    expect(inner["parentSpanId"]).toBe(toolSpan["id"]);
    expect(inner["traceId"]).toBe(planner["traceId"]);
    const calls = harness.calls();
    expect(calls).toHaveLength(3);
    const innerStep = ended.find((span) => span["kind"] === "step" && span["parentSpanId"] === inner["id"])!;
    expect(calls[1]!["spanId"]).toBe(innerStep["id"]);
  });

  it("a failing tool and a failing model call end their spans with the raw error name", async () => {
    script = [
      () => json(toolCall("explode", {})),
      () => json({ error: { message: "upstream", type: "server_error" } }, 500),
    ];
    await expect(generateText({
      model: openai.chat("gpt-4o-mini"),
      prompt: "go",
      maxRetries: 0,
      tools: {
        explode: tool({
          inputSchema: z.object({}),
          execute: async () => {
            throw new RangeError("tool failed");
          },
        }),
      },
      stopWhen: isStepCount(3),
    })).rejects.toThrow();
    await harness.flush();
    const ended = harness.endedSpans();
    const toolSpan = ended.find((span) => span["kind"] === "tool")!;
    expect(toolSpan["status"]).toBe("error");
    expect(toolSpan["errorName"]).toBe("RangeError");
    const run = ended.find((span) => span["kind"] === "agent")!;
    expect(run["status"]).toBe("error");
    expect(typeof run["errorName"]).toBe("string");
    expect(JSON.stringify(ended)).not.toContain("tool failed");
    expect(harness.calls().map((call) => call["statusCode"])).toEqual([200, 500]);
  });
});
