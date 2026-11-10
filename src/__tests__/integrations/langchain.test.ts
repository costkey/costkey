import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { RunnableLambda } from "@langchain/core/runnables";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { CostKey } from "../../index.js";
import { CostKeyCallbackHandler } from "../../integrations/langchain.js";
import { json, startHarness, type Harness } from "./harness.js";

const usage = { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 };
const completion = (message: Record<string, unknown>, finish: string) => ({
  id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
  object: "chat.completion",
  created: 1_760_000_000,
  model: "gpt-4o-mini-2024-07-18",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
  usage,
});

/** An OpenAI-compatible local server (captured as Ollama): streams when asked, echoing the last message. */
function ollama(body: Record<string, any>): Response {
  const said = String(body["messages"]?.at(-1)?.content ?? "");
  const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
  if (!body["stream"]) {
    return json({
      id: "chatcmpl-local", object: "chat.completion", created: 1, model: body["model"],
      choices: [{ index: 0, message: { role: "assistant", content: `re: ${said}` }, finish_reason: "stop" }], usage,
    });
  }
  const chunk = (extra: Record<string, unknown>) => ({ id: "chatcmpl-local", object: "chat.completion.chunk", created: 1, model: body["model"], ...extra });
  const records = [
    chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "re: " }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: { content: said }, finish_reason: "stop" }] }),
    chunk({ choices: [], usage }),
  ];
  return new Response(records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("LangChain.js / LangGraph.js integration (callback handler)", () => {
  let harness: Harness;
  let handler: CostKeyCallbackHandler;
  let script: Array<() => Response> = [];

  beforeAll(() => {
    process.env["LANGCHAIN_TRACING_V2"] = "false";
    harness = startHarness((url, _init, body) => {
      if (url.hostname === "localhost" && url.port === "11434") return ollama(body as Record<string, any>);
      if (url.hostname !== "api.openai.com") return null;
      const next = script.shift();
      if (!next) throw new Error("no scripted response");
      return next();
    });
    handler = new CostKeyCallbackHandler();
  });

  beforeEach(() => harness.reset());

  afterAll(async () => {
    handler.dispose();
    await harness.close();
  });

  const model = () => new ChatOpenAI({ model: "gpt-4o-mini", apiKey: "sk-test-not-real", maxRetries: 0 });

  it("maps a LangGraph graph and its nodes to spans and attributes each model call to its node", async () => {
    script = [
      () => json(completion({ content: "a plan" }, "stop")),
      () => json(completion({ content: "the answer" }, "stop")),
    ];
    const llm = model();
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("plan", async (state) => ({ messages: [await llm.invoke(state.messages)] }))
      .addNode("answer", async (state) => ({ messages: [await llm.invoke(state.messages)] }))
      .addEdge(START, "plan")
      .addEdge("plan", "answer")
      .addEdge("answer", END)
      .compile();

    const result = await CostKey.startTrace({ name: "graph-run" }, () =>
      graph.invoke({ messages: [{ role: "user", content: "hi" }] }, { callbacks: [handler] }));
    expect(result.messages.at(-1)?.content).toBe("the answer");
    await harness.flush();

    const ended = harness.endedSpans();
    const graphSpan = ended.find((span) => span["kind"] === "workflow")!;
    // Every node LangGraph runs, its own __start__ included (no SDK-side filtering).
    const allNodes = ended.filter((span) => span["kind"] === "step");
    expect(graphSpan["name"]).toBe("LangGraph");
    expect(allNodes.map((span) => span["name"])).toEqual(["__start__", "plan", "answer"]);
    const nodes = allNodes.slice(1);
    for (const node of allNodes) expect(node["parentSpanId"]).toBe(graphSpan["id"]);
    expect(nodes[0]!["attributes"]["langchain"]).toMatchObject({ langgraph_node: { $s: 4 }, langgraph_step: 1 });

    const calls = harness.calls();
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call["spanId"])).toEqual(nodes.map((span) => span["id"]));
    expect(new Set([...ended.map((span) => span["traceId"]), ...calls.map((call) => call["context"]["traceId"])]).size).toBe(1);
    // No span for the chat model run itself: the call event is the model call.
    expect(ended.some((span) => span["name"] === "ChatOpenAI")).toBe(false);
  });

  it("maps a prebuilt ReAct agent and its tool calls", async () => {
    let toolContext: Record<string, unknown> = {};
    script = [
      () => json(completion({
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_price", arguments: JSON.stringify({ ticker: "NIFTY" }) } }],
      }, "tool_calls")),
      () => json(completion({ content: "NIFTY is 25000." }, "stop")),
    ];
    const getPrice = tool(async ({ ticker }) => {
      toolContext = CostKey.getCurrentContext();
      return `${ticker}: 25000`;
    }, { name: "get_price", description: "Price of an index", schema: z.object({ ticker: z.string() }) });
    const agent = createReactAgent({ llm: model(), tools: [getPrice], name: "pricing_agent" });

    await agent.invoke({ messages: [{ role: "user", content: "Price of NIFTY?" }] }, { callbacks: [handler] });
    await harness.flush();

    const ended = harness.endedSpans();
    const toolSpan = ended.find((span) => span["kind"] === "tool")!;
    expect(toolSpan["name"]).toBe("get_price");
    expect(toolContext["spanId"]).toBe(toolSpan["id"]);
    const root = ended.find((span) => !ended.some((other) => other["id"] === span["parentSpanId"]))!;
    expect(root["name"]).toBe("pricing_agent");
    const calls = harness.calls();
    expect(calls).toHaveLength(2);
    const callSpans = calls.map((call) => ended.find((span) => span["id"] === call["spanId"])!);
    expect(callSpans.map((span) => span["name"])).toEqual(["agent", "agent"]);
    // A graph run outside any CostKey trace opens one.
    expect(harness.lifecycle().map((event) => event["lifecycle"])).toEqual(["started", "completed"]);
    expect(JSON.stringify(ended)).not.toContain("NIFTY");
  });

  it("records chain errors with the raw error name", async () => {
    const failing = RunnableLambda.from(async () => {
      throw new SyntaxError("bad input");
    }).withConfig({ runName: "parse_step" });
    await expect(failing.invoke("x", { callbacks: [handler] })).rejects.toThrow("bad input");
    await harness.flush();
    const [span] = harness.endedSpans();
    expect(span).toMatchObject({ kind: "chain", name: "parse_step", status: "error", errorName: "SyntaxError" });
    expect(JSON.stringify(span)).not.toContain("bad input");
  });
  // Regression: LangChain runs stream() generators with its async context
  // cleared (unless LangSmith tracing is on), so a streamed call used to have
  // no span and no trace.
  const localModel = () => new ChatOpenAI({
    model: "llama3.2",
    apiKey: "not-needed",
    maxRetries: 0,
    configuration: { baseURL: "http://localhost:11434/v1" },
  });
  const streamText = async (llm: ChatOpenAI, messages: Parameters<ChatOpenAI["stream"]>[0]) => {
    let text = "";
    for await (const chunk of await llm.stream(messages)) text += String(chunk.content);
    return text;
  };

  it("attributes model.stream() inside a LangGraph node to that node and its trace", async () => {
    const llm = localModel();
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("answer", async (state) => ({ messages: [await llm.invoke(state.messages)] }))
      .addNode("stream", async (state) => ({ messages: [{ role: "assistant", content: await streamText(llm, state.messages) }] }))
      .addEdge(START, "answer")
      .addEdge("answer", "stream")
      .addEdge("stream", END)
      .compile({ name: "e2e-langgraph" });

    const result = await graph.invoke({ messages: [{ role: "user", content: "hi" }] }, { callbacks: [handler] });
    expect(result.messages.at(-1)?.content).toBe("re: re: hi");
    await harness.flush();

    const ended = harness.endedSpans();
    const graphSpan = ended.find((span) => span["kind"] === "workflow")!;
    const answer = ended.find((span) => span["name"] === "answer")!;
    const stream = ended.find((span) => span["name"] === "stream")!;
    expect(graphSpan["name"]).toBe("e2e-langgraph");
    const calls = harness.calls();
    expect(calls.map((call) => call["streaming"])).toEqual([false, true]);
    expect(calls.map((call) => call["spanId"])).toEqual([answer["id"], stream["id"]]);
    for (const call of calls) expect(call["context"]["traceId"]).toBe(graphSpan["traceId"]);
    expect(calls[1]!["telemetry"]["stream"]["chunkCount"]).toBe(3);
    expect(harness.lifecycle()[0]!["traceId"]).toBe(graphSpan["traceId"]);
  });

  it("keeps concurrent streaming nodes apart", async () => {
    const llm = localModel();
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("left", async () => ({ messages: [{ role: "assistant", content: await streamText(llm, [{ role: "user", content: "left" }]) }] }))
      .addNode("right", async () => ({ messages: [{ role: "assistant", content: await streamText(llm, [{ role: "user", content: "right" }]) }] }))
      .addEdge(START, "left")
      .addEdge(START, "right")
      .addEdge("left", END)
      .addEdge("right", END)
      .compile();
    await graph.invoke({ messages: [] }, { callbacks: [handler] });
    await harness.flush();

    const ended = harness.endedSpans();
    const left = ended.find((span) => span["name"] === "left")!;
    const right = ended.find((span) => span["name"] === "right")!;
    const calls = harness.calls();
    expect(calls).toHaveLength(2);
    // Each request is matched by its own async context, not by timing:
    // "left" is 4 characters, "right" 5.
    for (const call of calls) {
      const content = call["telemetry"]["request"]["body"]["messages"][0]["content"]["$s"];
      expect(call["spanId"]).toBe(content === 4 ? left["id"] : right["id"]);
    }
  });

  it("does not leak a finished model run into later calls", async () => {
    const llm = localModel();
    await streamText(llm, [{ role: "user", content: "outside" }]);
    // Outside any LangChain run: a later direct provider call has no span.
    await fetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "llama3.2", messages: [{ role: "user", content: "direct" }] }),
    });
    await harness.flush();
    expect(harness.calls().map((call) => call["spanId"])).toEqual([null, null]);
  });
});
