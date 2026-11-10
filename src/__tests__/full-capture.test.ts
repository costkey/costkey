/**
 * With capture on, content goes out whole: request and response bodies, span
 * input and output and raw framework strings are never truncated. The
 * transport splits large queues across POSTs instead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPendingCaptures, patchFetch, unpatchFetch } from "../fetch-patch.js";
import { MAX_BATCH_BYTES, Transport } from "../transport.js";
import { CostKey } from "../index.js";
import { SpanTracker } from "../integrations/shared.js";
import { json, settle, startHarness, type Harness } from "./integrations/harness.js";
import type { CostKeyTelemetryEvent } from "../types.js";
import { wireBody } from "./wireBody";

type Event = Record<string, any>;

const originalFetch = globalThis.fetch;

afterEach(() => {
  unpatchFetch();
  globalThis.fetch = originalFetch;
});

async function captureCall(prompt: string, answer: string): Promise<Event> {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ id: "c", choices: [{ message: { content: answer } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  const events: Event[] = [];
  patchFetch({
    transport: { enqueue: (event: Event) => events.push(event), start() {}, stop() {}, flush: async () => {} } as unknown as Transport,
    projectId: "full",
    captureBody: true,
    beforeSend: null,
    defaultContext: {},
    debug: false,
  });
  const response = await globalThis.fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: prompt }] }),
  });
  await response.arrayBuffer();
  await flushPendingCaptures();
  expect(events).toHaveLength(1);
  return events[0]!;
}

describe("full content capture", () => {
  it.each([
    ["100 KB+", 120 * 1024],
    ["1 MB", 1024 * 1024],
  ])("captures a %s request and response body whole", async (_label, size) => {
    const prompt = "p".repeat(size);
    const answer = "a".repeat(size);
    const event = await captureCall(prompt, answer);
    expect(event["requestBody"]).toEqual({ model: "gpt-4o", messages: [{ role: "user", content: prompt }] });
    expect(event["responseBody"]).toEqual({ id: "c", choices: [{ message: { content: answer } }] });
    const wire = JSON.stringify(event);
    expect(wire).not.toContain("truncated");
    expect(wire).not.toContain("__costkey_truncated__");
  });

  describe("spans", () => {
    let harness: Harness | null = null;

    afterEach(async () => {
      await harness?.close();
      harness = null;
    });

    it("sends span input and output over 2,000 chars whole", async () => {
      harness = startHarness(() => json({}), { captureBody: true, project: "full-spans" });
      await settle();
      const input = { question: "q".repeat(5_000) };
      const output = "o".repeat(5_000);
      await CostKey.startSpan({ name: "answer", kind: "tool", input }, (span) => {
        span.setOutput(output);
      });
      await harness.flush();
      // Input rides on the span's start record, output on its end record.
      const started = harness.spans().find((event) => event["name"] === "answer" && event["status"] === "running");
      const ended = harness.endedSpans().find((event) => event["name"] === "answer");
      expect(started?.["attributes"]["input"]).toBe(JSON.stringify(input));
      expect(ended?.["attributes"]["output"]).toBe(output);
    });

    it("sends raw framework strings and deep payloads whole", async () => {
      harness = startHarness(() => json({}), { captureBody: true, project: "full-raw" });
      await settle();
      const tracker = new SpanTracker("framework");
      let deep: Record<string, unknown> = { leaf: "deep leaf" };
      for (let depth = 0; depth < 20; depth++) deep = { next: deep };
      const prompt = "r".repeat(100_000);
      tracker.beginTrace("ft");
      tracker.start({ key: "s", kind: "chain", name: "chain", frameworkTraceId: "ft", raw: { prompt, deep } });
      tracker.end("s");
      tracker.endTrace("ft");
      await harness.flush();
      const span = harness.endedSpans().find((event) => event["name"] === "chain");
      expect(span?.["attributes"]["framework"]["prompt"]).toBe(prompt);
      expect(span?.["attributes"]["framework"]["deep"]).toEqual(deep);
    });
  });
});

describe("transport batching by size", () => {
  const MB = 1024 * 1024;

  function bigEvent(id: string, bytes: number): CostKeyTelemetryEvent {
    return { id, eventType: "call", requestBody: "x".repeat(bytes) } as unknown as CostKeyTelemetryEvent;
  }

  function stubIngest(statuses: number[] = []) {
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(wireBody(init));
      return new Response("{}", { status: statuses.shift() ?? 202 });
    }) as unknown as typeof fetch;
    return bodies;
  }

  const transport = () => new Transport({
    endpoint: "https://costkey.dev/api/v1/events",
    authKey: "ck_test",
    maxBatchSize: 50,
    flushInterval: 60_000,
    debug: false,
  });

  it("splits a queue over 8 MB into POSTs of at most 8 MB, an oversized event alone", async () => {
    const bodies = stubIngest();
    const t = transport();
    const sizes = [3 * MB, 3 * MB, 3 * MB, 12 * MB, 1 * MB, 2 * MB, 4 * MB];
    sizes.forEach((size, index) => t.enqueue(bigEvent(`e${index}`, size)));
    await t.flush();

    const batches = bodies.map((body) => (JSON.parse(body) as { events: Array<{ id: string; requestBody: string }> }).events);
    expect(bodies.length).toBeGreaterThan(1);
    // Every event arrives once, in order, whole.
    expect(batches.flat().map((event) => event.id)).toEqual(sizes.map((_, index) => `e${index}`));
    batches.flat().forEach((event, index) => expect(event.requestBody.length).toBe(sizes[index]));
    for (const [index, body] of bodies.entries()) {
      const bytes = Buffer.byteLength(body, "utf8");
      if (batches[index]!.length > 1) expect(bytes).toBeLessThanOrEqual(MAX_BATCH_BYTES);
      else if (bytes > MAX_BATCH_BYTES) expect(batches[index]![0]!.id).toBe("e3");
    }
    expect(batches.map((batch) => batch.map((event) => event.id))).toEqual([
      ["e0", "e1"],
      ["e2"],
      ["e3"],
      ["e4", "e5", "e6"],
    ]);
  });

  it("counts multi-byte characters as UTF-8 bytes", async () => {
    const bodies = stubIngest();
    const t = transport();
    // 1.5M three-byte characters = 4.5 MB each: two can't share a POST.
    for (let index = 0; index < 2; index++) {
      t.enqueue({ id: `u${index}`, eventType: "call", requestBody: "€".repeat(1_500_000) } as unknown as CostKeyTelemetryEvent);
    }
    await t.flush();
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_BATCH_BYTES);
  });

  it("requeues a rate-limited partial batch ahead of the rest, then delivers everything in order", async () => {
    const bodies = stubIngest([202, 429]);
    const t = transport();
    const sizes = [5 * MB, 5 * MB, 5 * MB];
    sizes.forEach((size, index) => t.enqueue(bigEvent(`r${index}`, size)));
    await t.flush();
    // First POST delivered r0; the second (r1) was rate limited, so the flush stopped.
    expect(bodies).toHaveLength(2);
    await t.flush();
    const delivered = [bodies[0]!, ...bodies.slice(2)]
      .flatMap((body) => (JSON.parse(body) as { events: Array<{ id: string }> }).events.map((event) => event.id));
    expect(delivered).toEqual(["r0", "r1", "r2"]);
  });

  it("still respects maxBatchSize for small events and drains the whole queue in one flush", async () => {
    const bodies = stubIngest();
    const t = new Transport({ endpoint: "https://costkey.dev/api/v1/events", authKey: "k", maxBatchSize: 3, flushInterval: 60_000, debug: false });
    // Enqueueing the 3rd event triggers an auto-flush; the rest drain on flush.
    for (let index = 0; index < 7; index++) t.enqueue(bigEvent(`s${index}`, 10));
    await t.flush();
    await t.flush();
    const batches = bodies.map((body) => (JSON.parse(body) as { events: Array<{ id: string }> }).events.map((event) => event.id));
    expect(batches.flat()).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6"]);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(3);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ sdkVersion: expect.any(String) });
  });
});

describe("gzip deliveries", () => {
  it("gzips a large batch and the server can read it back whole", async () => {
    const { gzipBody } = await import("../transport");
    const body = JSON.stringify({ events: [{ id: "e1", requestBody: { instructions: "You are Dash. ".repeat(40_000) } }] });
    const packed = await gzipBody(body);
    expect(packed).not.toBeNull();
    expect(packed!.length).toBeLessThan(body.length / 20);
    expect(wireBody({ body: packed!, headers: { "Content-Encoding": "gzip" } })).toBe(body);
    expect(await gzipBody("{}")).toBeNull();
  });
});
