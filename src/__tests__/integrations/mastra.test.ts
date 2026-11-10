import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { createTool } from "@mastra/core/tools";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { Observability } from "@mastra/observability";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { CostKey } from "../../index.js";
import { CostKeyMastraBridge } from "../../integrations/mastra.js";
import { json, sse, startHarness, type Harness } from "./harness.js";

const usage = { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 };
const completion = (message: Record<string, unknown>, finish: string) => ({
  id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
  object: "chat.completion",
  created: 1_760_000_000,
  model: "gpt-4o-mini-2024-07-18",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
  usage,
});

describe("Mastra integration (@mastra/core bridge)", () => {
  let harness: Harness;
  let script: Array<() => Response> = [];
  let mastra: Mastra;
  let toolContext: Record<string, unknown> = {};

  beforeAll(() => {
    harness = startHarness((url) => {
      if (url.hostname !== "api.openai.com") return null;
      const next = script.shift();
      if (!next) throw new Error("no scripted response");
      return next();
    });
    const openai = createOpenAI({ apiKey: "sk-test-not-real" });
    const lookupFund = createTool({
      id: "lookup-fund",
      description: "Look up a fund",
      inputSchema: z.object({ code: z.string() }),
      execute: async (input) => {
        toolContext = CostKey.getCurrentContext();
        return { name: `Fund ${input.code}` };
      },
    });
    const advisor = new Agent({
      id: "advisor",
      name: "Advisor",
      instructions: "Answer fund questions.",
      model: openai.chat("gpt-4o-mini"),
      tools: { lookupFund },
    });
    const prepare = createStep({
      id: "prepare",
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.object({ prompt: z.string() }),
      execute: async ({ inputData }) => ({ prompt: inputData.question.trim() }),
    });
    const answer = createStep({
      id: "answer",
      inputSchema: z.object({ prompt: z.string() }),
      outputSchema: z.object({ text: z.string() }),
      execute: async ({ inputData, mastra: instance }) => {
        const result = await instance!.getAgent("advisor").generate(inputData.prompt);
        return { text: result.text };
      },
    });
    const workflow = createWorkflow({
      id: "fund-qa",
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.object({ text: z.string() }),
    }).then(prepare).then(answer).commit();
    mastra = new Mastra({
      agents: { advisor },
      workflows: { fundQa: workflow },
      logger: false,
      observability: new Observability({
        configs: { default: { serviceName: "costkey-test", bridge: new CostKeyMastraBridge() } },
      }),
    });
  });

  beforeEach(() => harness.reset());

  afterAll(async () => {
    await mastra.shutdown?.();
    await harness.close();
  });

  it("records agent runs and tool calls, and attributes the model calls to them", async () => {
    script = [
      () => json(completion({
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookupFund", arguments: JSON.stringify({ code: "INF123" }) } }],
      }, "tool_calls")),
      () => json(completion({ content: "It is Fund INF123." }, "stop")),
    ];
    const result = await CostKey.startTrace({ name: "fund-chat" }, () =>
      mastra.getAgent("advisor").generate("What is INF123?"));
    expect(result.text).toBe("It is Fund INF123.");
    await harness.flush();

    const ended = harness.endedSpans();
    const agentSpan = ended.find((span) => span["kind"] === "agent")!;
    const toolSpan = ended.find((span) => span["kind"] === "tool")!;
    expect(agentSpan["name"]).toBe("Advisor");
    expect(agentSpan["attributes"]).toMatchObject({ framework: "mastra", spanType: "agent_run" });
    expect(toolSpan["name"]).toMatch(/lookupFund|lookup-fund/);
    expect(toolContext["spanId"]).toBe(toolSpan["id"]);
    // Model spans are not emitted; nothing but agent, tool and step-like spans.
    expect(ended.every((span) => !String(span["attributes"]["spanType"]).startsWith("model_"))).toBe(true);

    const calls = harness.calls();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call["context"]["agent"]).toBe("Advisor");
      expect(call["context"]["traceId"]).toBe(agentSpan["traceId"]);
    }
    expect(calls[0]!["spanId"]).toBe(agentSpan["id"]);
    // Everything joined the caller's trace.
    expect(harness.lifecycle().map((event) => event["traceName"])).toEqual(["fund-chat", "fund-chat"]);
    expect(JSON.stringify(ended)).not.toContain("INF123");
  });

  it("records a workflow, its steps and the agent run inside a step", async () => {
    script = [() => json(completion({ content: "Low fees." }, "stop"))];
    const run = await mastra.getWorkflow("fundQa").createRun();
    const result = await run.start({ inputData: { question: "  fees? " } });
    expect(result.status).toBe("success");
    await harness.flush();

    const ended = harness.endedSpans();
    const workflow = ended.find((span) => span["kind"] === "workflow")!;
    const steps = ended.filter((span) => span["kind"] === "step");
    const agentSpan = ended.find((span) => span["kind"] === "agent")!;
    expect(workflow["name"]).toBe("fund-qa");
    expect(steps.map((span) => span["name"])).toEqual(expect.arrayContaining(["prepare", "answer"]));
    const answerStep = steps.find((span) => span["name"] === "answer")!;
    expect(agentSpan["parentSpanId"]).toBe(answerStep["id"]);
    expect(answerStep["parentSpanId"]).toBe(workflow["id"]);
    const [call] = harness.calls();
    expect(call!["context"]["agent"]).toBe("Advisor");
    expect(call!["context"]["traceId"]).toBe(workflow["traceId"]);
    // A workflow outside any CostKey trace opens one (Mastra's trace id).
    expect(harness.lifecycle().map((event) => event["lifecycle"])).toEqual(["started", "completed"]);
    expect(harness.lifecycle()[0]!["traceId"]).toBe(workflow["traceId"]);
  });
  it("attributes a streamed agent call (agent.stream) to the agent run", async () => {
    script = [() => sse([
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, delta: { role: "assistant", content: "Streamed." }, finish_reason: null }] },
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", choices: [], usage },
    ])];
    const output = await mastra.getAgent("advisor").stream("Say something");
    expect(await output.text).toBe("Streamed.");
    await harness.flush();
    // Mastra closes the run span after the stream settles; its start record is enough here.
    const agentSpan = harness.spans().find((span) => span["kind"] === "agent")!;
    const calls = harness.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!["streaming"]).toBe(true);
    expect(calls[0]!["spanId"]).toBe(agentSpan["id"]);
    expect(calls[0]!["context"]["traceId"]).toBe(agentSpan["traceId"]);
  });
});
