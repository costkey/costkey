import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { CostKey } from "../index.js";
import { addCaptureTarget } from "../providers/registry.js";
import { isStreamingRequest } from "../fetch-patch.js";
import { wireBody } from "./wireBody";

type Event = Record<string, unknown>;

addCaptureTarget({
  label: "span-provider",
  match: (url) => url.hostname === "127.0.0.1" && url.pathname === "/span-provider",
});

describe("agent spans", () => {
  let originalFetch: typeof globalThis.fetch;
  let provider: Server;
  let providerUrl: string;
  let events: Event[];

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    events = [];
    provider = createServer((_request, response) => {
      // A slow provider makes call start vs end observable.
      setTimeout(() => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ id: "req", usage: { input_tokens: 4, output_tokens: 2 } }));
      }, 40);
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider did not bind");
    providerUrl = `http://127.0.0.1:${address.port}/span-provider`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://costkey.dev/api/v1/events") {
        const body = JSON.parse(wireBody(init)) as { events: Event[] };
        events.push(...body.events);
        return new Response(JSON.stringify({ accepted: body.events.length }), { status: 202 });
      }
      return originalFetch(input, init);
    };
  });

  afterEach(async () => {
    await CostKey.shutdown();
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });

  it("nests agent, step and tool spans and attributes calls to the innermost span", async () => {
    CostKey.init({ dsn: "https://ck_test@costkey.dev/spans-test", captureBody: false, maxBatchSize: 200 });

    let agentSpanId = "";
    let toolSpanId = "";
    await CostKey.agent("dash", async (agentSpan) => {
      agentSpanId = agentSpan.id;
      agentSpan.setAttribute("model", "gpt-6-sol");
      await fetch(providerUrl, { method: "POST", body: JSON.stringify({ model: "span-model" }) });
      await CostKey.step("turn 1", async () => {
        await CostKey.tool("search_funds", async (toolSpan) => {
          toolSpanId = toolSpan.id;
          await fetch(providerUrl, { method: "POST", body: JSON.stringify({ model: "span-model" }) });
        });
      });
    });
    await CostKey.flush();

    const spans = events.filter((event) => event["eventType"] === "span");
    const calls = events.filter((event) => event["eventType"] === "call");
    // Each span is delivered when it starts and when it ends.
    expect(spans).toHaveLength(6);
    const ended = spans.filter((span) => span["status"] !== "running");
    expect(ended.map((span) => [span["kind"], span["name"], span["status"]])).toEqual([
      ["tool", "search_funds", "ok"],
      ["step", "turn 1", "ok"],
      ["agent", "dash", "ok"],
    ]);
    const [toolEnd, stepEnd, agentEnd] = ended;
    expect(stepEnd?.["parentSpanId"]).toBe(agentSpanId);
    expect(toolEnd?.["parentSpanId"]).toBe(stepEnd?.["id"]);
    expect(agentEnd?.["parentSpanId"]).toBeUndefined();
    expect((agentEnd?.["attributes"] as Event)["model"]).toBe("gpt-6-sol");
    // Each span says where it was opened, raw, so the server can attribute
    // calls a framework makes on its own task to that code.
    const agentSite = agentEnd?.["callSite"] as { frames: Array<{ fileName?: string }> } | undefined;
    expect(agentSite?.frames.some((frame) => frame.fileName?.endsWith("spans.test.ts"))).toBe(true);

    // Outside a run, the agent span started one: every event shares its trace.
    const traceIds = new Set([...spans, ...calls].map((event) => event["traceId"] ?? (event["context"] as Event)["traceId"]));
    expect(traceIds.size).toBe(1);
    const lifecycle = events.filter((event) => event["eventType"] === "lifecycle");
    expect(lifecycle.map((event) => event["traceName"])).toEqual(["dash", "dash"]);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.["spanId"]).toBe(agentSpanId);
    expect((calls[0]?.["context"] as Event)["agent"]).toBe("dash");
    expect((calls[0]?.["context"] as Event)["tool"]).toBeUndefined();
    expect(calls[1]?.["spanId"]).toBe(toolSpanId);
    expect((calls[1]?.["context"] as Event)["agent"]).toBe("dash");
    expect((calls[1]?.["context"] as Event)["tool"]).toBe("search_funds");
  });

  it("stamps calls at their start and records failed spans", async () => {
    CostKey.init({ dsn: "https://ck_test@costkey.dev/spans-test", captureBody: false, maxBatchSize: 200 });
    const before = Date.now();
    await expect(CostKey.agent("planner", async () => {
      await fetch(providerUrl, { method: "POST", body: "{}" });
      throw new TypeError("planner gave up");
    })).rejects.toThrow("planner gave up");
    await CostKey.flush();

    const call = events.find((event) => event["eventType"] === "call");
    expect(Date.parse(String(call?.["timestamp"])) - before).toBeLessThan(30);
    expect(Number(call?.["durationMs"])).toBeGreaterThanOrEqual(35);
    const failed = events.find((event) => event["eventType"] === "span" && event["status"] === "error");
    expect(failed?.["errorName"]).toBe("TypeError");
  });

  it("wraps framework tools and only sends tool payloads when capture is on", async () => {
    CostKey.init({ dsn: "https://ck_test@costkey.dev/spans-test", captureBody: false, maxBatchSize: 200 });
    const tools = CostKey.instrumentTools({
      lookup: { description: "Look up a fund", execute: async (input: { code: string }) => ({ name: `fund ${input.code}` }) },
      label: "not a tool",
    });
    expect(tools.label).toBe("not a tool");
    const result = await CostKey.agent("chat", () => tools.lookup.execute({ code: "INF123" }));
    expect(result).toEqual({ name: "fund INF123" });
    await CostKey.flush();

    const toolEnd = events.find((event) => event["eventType"] === "span" && event["kind"] === "tool" && event["status"] === "ok");
    expect(toolEnd?.["name"]).toBe("lookup");
    expect((toolEnd?.["attributes"] as Event | undefined)?.["input"]).toBeUndefined();
  });

  it("carries span identity across a handoff so a resumed process stays in the same run", async () => {
    CostKey.init({ dsn: "https://ck_test@costkey.dev/spans-test", captureBody: false, maxBatchSize: 200 });
    let carrier = {};
    await CostKey.agent("browser", async () => {
      carrier = CostKey.exportContext();
    });
    // Later, another worker resumes the same agent span.
    await CostKey.withContext(carrier, async () => {
      await fetch(providerUrl, { method: "POST", body: "{}" });
    });
    await CostKey.flush();
    const agentSpan = events.find((event) => event["eventType"] === "span");
    const call = events.find((event) => event["eventType"] === "call");
    expect(call?.["spanId"]).toBe(agentSpan?.["id"]);
    expect((call?.["context"] as Event)["agent"]).toBe("browser");
  });
});

describe("stream read mode", () => {
  it("detects streaming declared in the body or the URL (it only picks how the body is read)", () => {
    expect(isStreamingRequest(new URL("https://aiplatform.googleapis.com/v1/models/gemini:streamGenerateContent?alt=sse"), {})).toBe(true);
    expect(isStreamingRequest(new URL("https://bedrock-runtime.us-east-1.amazonaws.com/model/x/converse-stream"), {})).toBe(true);
    expect(isStreamingRequest(new URL("https://api.openai.com/v1/responses"), { stream: true })).toBe(true);
    expect(isStreamingRequest(new URL("https://api.openai.com/v1/responses"), {})).toBe(false);
  });
});
