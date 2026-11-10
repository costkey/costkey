import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computerAction, defaultEvalScore, runEval, type EvalClient, type EvalItem } from "../evals.js";

const click = (x: number, y: number) => ({ content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "computer", input: { action: "left_click", coordinate: [x, y] } }] });

function item(fields: Partial<EvalItem> = {}): EvalItem {
  return {
    id: "dsi_1", label: "Good", note: null, expected: null, input: {}, output: click(100, 100),
    model: "claude-sonnet-4-5", provider: "anthropic", traceId: "tr_1", sourceEventId: "evt_1", incomplete: false,
    ...fields,
  };
}

describe("default eval score", () => {
  it("reads computer actions from both providers", () => {
    expect(computerAction(click(1, 2))).toEqual({ type: "left_click", x: 1, y: 2 });
    expect(computerAction({ output: [{ type: "computer_call", action: { type: "click", x: 5, y: 6 } }] })).toEqual({ type: "click", x: 5, y: 6 });
    expect(computerAction({ content: [{ type: "text", text: "done" }] })).toBeNull();
  });

  it("matches a Good item's original action within the tolerance", () => {
    expect(defaultEvalScore(item(), click(120, 110)).pass).toBe(true);
    expect(defaultEvalScore(item(), { output: [{ type: "computer_call", action: { type: "click", x: 100, y: 130 } }] }).pass).toBe(true);
    const far = defaultEvalScore(item(), click(400, 100));
    expect(far.pass).toBe(false);
    expect(far.reason).toContain("Expected left_click at 100, 100");
  });

  it("passes a Bad item only when the candidate doesn't repeat the original action", () => {
    expect(defaultEvalScore(item({ label: "bad" }), click(102, 101)).pass).toBe(false);
    expect(defaultEvalScore(item({ label: "Bad" }), click(600, 400)).pass).toBe(true);
  });

  it("prefers an expected action, and handles expected text and unscored items", () => {
    expect(defaultEvalScore(item({ label: "wrong click", expected: { action: "left_click", x: 600, y: 400 } }), click(605, 398)).pass).toBe(true);
    expect(defaultEvalScore(item({ label: "x", output: null, expected: "Order placed" }), { content: [{ type: "text", text: "Your order placed!" }] }).pass).toBe(true);
    expect(defaultEvalScore(item({ label: "stuck" }), click(1, 1)).pass).toBeNull();
  });
});

describe("runEval", () => {
  const originalFetch = globalThis.fetch;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const sha = "a".repeat(64);
  let requests: Array<{ url: string; auth: string | null }>;

  beforeEach(() => {
    requests = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/projects/proj/datasets")) {
        return new Response(JSON.stringify({ datasets: [{ id: "ds_1", name: "checkout clicks", revision: 4 }] }), { status: 200 });
      }
      if (url.endsWith("/datasets/ds_1/export")) {
        const rows = [
          { id: "dsi_good", label: "Good", sourceEventId: "e1", output: click(100, 100), input: { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: `[image data omitted: image/png; ~7 bytes; frame ${sha}]` } }] }] } },
          { id: "dsi_bad", label: "Bad", sourceEventId: "e2", output: click(300, 300), input: { image_url: `[image data omitted: image/png; ~7 bytes; frame ${"b".repeat(64)}]` } },
          { id: "dsi_none", label: "stuck", sourceEventId: "e3", output: null, input: null },
        ];
        return new Response(rows.map((row) => JSON.stringify(row)).join("\n"), { status: 200 });
      }
      if (url.endsWith(`/frames/${sha}`)) return new Response(png, { status: 200 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("runs the task per item with screenshots restored, scores it and reports scores", async () => {
    const events: Array<Record<string, unknown>> = [];
    const client: EvalClient = { apiBase: "https://ck.test/api/v1", projectId: "proj", enqueue: (event) => events.push(event as unknown as Record<string, unknown>), flush: async () => {} };
    const seen: Record<string, unknown> = {};
    const summary = await runEval(client, {
      dataset: "Checkout Clicks",
      apiToken: "ck_pat_test",
      configuration: { model: "claude-haiku-4-5" },
      task: (evalItem) => {
        seen[evalItem.id] = evalItem;
        if (evalItem.id === "dsi_good") return click(105, 95);
        if (evalItem.id === "dsi_bad") return click(305, 300);
        return click(1, 1);
      },
    });

    expect(requests.every((request) => request.auth === "Bearer ck_pat_test")).toBe(true);
    const good = seen["dsi_good"] as EvalItem;
    const restored = ((good.input as any).messages[0].content[0].source.data) as string;
    expect(restored).toBe(png.toString("base64"));
    expect(good.incomplete).toBe(false);
    // A screenshot that isn't stored stays a placeholder and marks the item.
    expect((seen["dsi_bad"] as EvalItem).incomplete).toBe(true);

    expect(summary.dataset).toEqual({ id: "ds_1", name: "checkout clicks", revision: 4 });
    expect([summary.total, summary.scored, summary.passed, summary.failed, summary.errors]).toEqual([3, 2, 1, 1, 0]);
    const byItem = Object.fromEntries(summary.results.map((result) => [result.itemId, result.pass]));
    expect(byItem).toEqual({ dsi_good: true, dsi_bad: false, dsi_none: null });

    const scores = events.filter((event) => event["eventType"] === "score");
    expect(scores).toHaveLength(2);
    expect(scores.map((score) => score["label"]).sort()).toEqual(["fail", "pass"]);
    expect(scores.every((score) => score["name"] === "eval: checkout clicks" && score["source"] === "code" && typeof score["traceId"] === "string")).toBe(true);
    expect(String(scores[0]!["id"])).toMatch(new RegExp(`^eval_${summary.executionId}_dsi_`));
  });

  it("explains what's missing", async () => {
    const client: EvalClient = { apiBase: "https://ck.test/api/v1", projectId: "proj", enqueue: () => {}, flush: async () => {} };
    const previous = process.env["COSTKEY_API_TOKEN"];
    delete process.env["COSTKEY_API_TOKEN"];
    await expect(runEval(client, { dataset: "x", task: () => null })).rejects.toThrow(/personal access token/);
    await expect(runEval(null, { dataset: "x", task: () => null, apiToken: "t" })).rejects.toThrow(/CostKey.init/);
    await expect(runEval(client, { dataset: "nope", task: () => null, apiToken: "t" })).rejects.toThrow(/No dataset named "nope"/);
    if (previous !== undefined) process.env["COSTKEY_API_TOKEN"] = previous;
  });
});
