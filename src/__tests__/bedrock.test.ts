import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostKey, instrumentBedrockClient } from "../index.js";
import { withContext } from "../context.js";
import { flushPendingCaptures, patchFetch, unpatchFetch } from "../fetch-patch.js";
import { eventStreamChunk, decodeEventStream, EventStreamDecoder } from "../eventstream.js";
import type { Transport } from "../transport.js";

type Event = Record<string, unknown>;

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** One AWS event-stream frame with string headers (plus optional raw header bytes). */
function frame(headers: Record<string, string>, payload: unknown, rawHeaders: number[] = []): Uint8Array {
  const headerBytes: number[] = [...rawHeaders];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    headerBytes.push(nameBytes.length, ...nameBytes, 7, valueBytes.length >> 8, valueBytes.length & 0xff, ...valueBytes);
  }
  const body = encoder.encode(JSON.stringify(payload));
  const total = 12 + headerBytes.length + body.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(out.subarray(0, 8)));
  out.set(headerBytes, 12);
  out.set(body, 12 + headerBytes.length);
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)));
  return out;
}

const event = (type: string, payload: unknown, raw: number[] = []) =>
  frame({ ":message-type": "event", ":event-type": type, ":content-type": "application/json" }, payload, raw);

const chunk = (json: unknown) =>
  event("chunk", { bytes: Buffer.from(JSON.stringify(json)).toString("base64"), p: "abcdefgh" });

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Deliver bytes in awkward slices so frames straddle chunk boundaries. */
function sliced(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

function createMockTransport() {
  const events: Event[] = [];
  return {
    transport: {
      enqueue: (e: Event) => events.push(e),
      start: () => {},
      stop: () => {},
      flush: async () => {},
    } as unknown as Transport,
    events,
  };
}

describe("AWS event-stream decoding", () => {
  it("decodes frames split across chunks and skips non-string header types", () => {
    // `:retryable` bool true (type 0) and `n` int32 (type 4) before the strings.
    const raw = [10, ...encoder.encode(":retryable"), 0, 1, ...encoder.encode("n"), 4, 0, 0, 1, 0];
    const bytes = join(event("messageStart", { role: "assistant" }, raw), event("metadata", { usage: { inputTokens: 3 } }));
    const decoder = new EventStreamDecoder();
    const messages = [];
    for (let i = 0; i < bytes.length; i += 5) messages.push(...decoder.push(bytes.slice(i, i + 5)));
    expect(messages.map((message) => message.headers[":event-type"])).toEqual(["messageStart", "metadata"]);
    expect(messages[0]?.headers[":retryable"]).toBe(true);
    expect(messages[0]?.headers["n"]).toBe(256);
    expect(eventStreamChunk(messages[1]!)).toEqual({ metadata: { usage: { inputTokens: 3 } } });
  });

  it("stops at a malformed frame instead of throwing", () => {
    const bad = new Uint8Array(16);
    new DataView(bad.buffer).setUint32(0, 4);
    expect(decodeEventStream(bad)).toEqual([]);
  });

  it("keys exceptions by type and decodes base64 invoke chunks (framing only)", () => {
    const [exception] = decodeEventStream(frame({ ":message-type": "exception", ":exception-type": "throttlingException" }, { message: "slow" }));
    expect(eventStreamChunk(exception!)).toEqual({ throttlingException: { message: "slow" } });
    const [wrapped] = decodeEventStream(chunk({ type: "message_delta", usage: { output_tokens: 9 } }));
    expect(eventStreamChunk(wrapped!)).toEqual({
      chunk: { bytes: { type: "message_delta", usage: { output_tokens: 9 } }, p: "abcdefgh" },
    });
  });
});

describe("Bedrock event streams through fetch", () => {
  let originalFetch: typeof globalThis.fetch;
  let events: Event[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    unpatchFetch();
    globalThis.fetch = originalFetch;
  });

  function patchWith(body: Uint8Array, captureBody = false) {
    globalThis.fetch = vi.fn(async () => new Response(sliced(body, 7), {
      status: 200,
      headers: { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": "req-1" },
    }));
    const mock = createMockTransport();
    events = mock.events;
    patchFetch({ transport: mock.transport, projectId: "bedrock", captureBody, beforeSend: null, defaultContext: {}, debug: false });
  }

  it("with capture on, sends every message keyed by event type, padding dropped, and the bytes through unchanged", async () => {
    const converse = join(
      event("messageStart", { role: "assistant" }),
      event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hello" }, p: "abcdefghij" }),
      event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: " world" } }),
      event("messageStop", { stopReason: "end_turn" }),
      event("metadata", { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, metrics: { latencyMs: 80 } }),
    );
    patchWith(converse, true);
    const response = await globalThis.fetch(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-lite-v1%3A0/converse-stream",
      { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: [{ text: "hi" }] }] }) },
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(converse);
    await flushPendingCaptures();
    expect(events[0]?.["responseBody"]).toEqual({
      __costkey_stream__: [
        { messageStart: { role: "assistant" } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: " world" } } },
        { messageStop: { stopReason: "end_turn" } },
        { metadata: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, metrics: { latencyMs: 80 } } },
      ],
    });

    unpatchFetch();
    const invoke = join(
      chunk({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5, output_tokens: 1 } } }),
      chunk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
      chunk({ type: "message_stop" }),
    );
    patchWith(invoke, true);
    const invoked = await globalThis.fetch(
      "https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke-with-response-stream",
      { method: "POST", body: JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 10, messages: [] }) },
    );
    expect(new Uint8Array(await invoked.arrayBuffer())).toEqual(invoke);
    await flushPendingCaptures();
    // The base64 `bytes` field is decoded to the model's own JSON; `p` padding is dropped.
    expect(events[0]?.["responseBody"]).toEqual({
      __costkey_stream__: [
        { chunk: { bytes: { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5, output_tokens: 1 } } } } },
        { chunk: { bytes: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } } },
        { chunk: { bytes: { type: "message_stop" } } },
      ],
    });
    // The skeleton telemetry still sees the padding field.
    expect((events[0]?.["telemetry"] as Record<string, any>)["stream"]["chunks"][2]).toEqual({
      chunk: { bytes: { type: "message_stop" }, p: { $s: 8 } },
    });
  });

  it("with capture off, sends no responseBody for an event stream", async () => {
    const body = join(event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "secret answer" } }));
    patchWith(body);
    const response = await globalThis.fetch(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/x/converse-stream",
      { method: "POST", body: "{}" },
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    await flushPendingCaptures();
    expect(events[0]?.["responseBody"]).toBeNull();
    // The call site carries this test's own source lines, which spell the
    // fixture text; the response itself must not appear anywhere else.
    const { callSite: _callSite, ...rest } = events[0] ?? {};
    expect(JSON.stringify(rest)).not.toContain("secret answer");
  });

  it("records converse-stream usage from the metadata event and passes bytes through", async () => {
    const body = join(
      event("messageStart", { role: "assistant" }),
      event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hello" } }),
      event("messageStop", { stopReason: "end_turn" }),
      event("metadata", {
        usage: { inputTokens: 120, outputTokens: 33, totalTokens: 1153, cacheReadInputTokens: 1000 },
        metrics: { latencyMs: 640 },
      }),
    );
    patchWith(body);

    const modelId = "us.anthropic.claude-sonnet-4-20250514-v1:0";
    const response = await globalThis.fetch(
      `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(modelId)}/converse-stream`,
      { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: [{ text: "hi" }] }] }) },
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    await flushPendingCaptures();

    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("model");
    expect(events[0]).not.toHaveProperty("usage");
    const telemetry = events[0]?.["telemetry"] as Record<string, any>;
    expect(events[0]?.["streaming"]).toBe(true);
    expect(telemetry["request"]["url"]).toBe(
      `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(modelId)}/converse-stream`,
    );
    expect(telemetry["response"]).toMatchObject({ status: 200, body: null, headers: { "x-amzn-requestid": "req-1" } });
    expect(telemetry["stream"]).toMatchObject({
      format: "aws-eventstream",
      chunkCount: 4,
      chunks: [
        { messageStart: { role: { $s: 9 } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: { $s: 5 } } } },
        { messageStop: { stopReason: { $s: 8 } } },
        { metadata: {
          usage: { inputTokens: 120, outputTokens: 33, totalTokens: 1153, cacheReadInputTokens: 1000 },
          metrics: { latencyMs: 640 },
        } },
      ],
    });
    expect(telemetry["stream"]["firstChunkMs"]).toBeGreaterThanOrEqual(0);
  });

  it("records invoke-with-response-stream usage from Anthropic chunks and invocation metrics", async () => {
    const body = join(
      chunk({ type: "message_start", message: { id: "msg_bdrk_1", model: "claude", usage: { input_tokens: 55, output_tokens: 1, cache_creation_input_tokens: 9 } } }),
      chunk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
      chunk({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 18 } }),
      chunk({
        type: "message_stop",
        "amazon-bedrock-invocationMetrics": { inputTokenCount: 55, outputTokenCount: 18, invocationLatency: 900, firstByteLatency: 200 },
      }),
    );
    patchWith(body);

    const response = await globalThis.fetch(
      "https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke-with-response-stream",
      { method: "POST", body: JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 100, messages: [] }) },
    );
    await response.arrayBuffer();
    await flushPendingCaptures();

    const stream = (events[0]?.["telemetry"] as Record<string, any>)["stream"];
    expect(stream["chunkCount"]).toBe(4);
    // The base64 `bytes` payload is decoded to the model's JSON before the skeleton.
    expect(stream["chunks"][0]).toEqual({
      chunk: {
        bytes: { type: "message_start", message: { id: "msg_bdrk_1", model: "claude", usage: { input_tokens: 55, output_tokens: 1, cache_creation_input_tokens: 9 } } },
        p: { $s: 8 },
      },
    });
    expect(stream["chunks"][3]).toEqual({
      chunk: {
        bytes: {
          type: "message_stop",
          "amazon-bedrock-invocationMetrics": { inputTokenCount: 55, outputTokenCount: 18, invocationLatency: 900, firstByteLatency: 200 },
        },
        p: { $s: 8 },
      },
    });
  });

  it("never breaks the caller's stream on undecodable bytes", async () => {
    const garbage = encoder.encode("this is not an event stream at all");
    patchWith(garbage);
    const response = await globalThis.fetch(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/x/converse-stream",
      { method: "POST", body: "{}" },
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(garbage);
    await flushPendingCaptures();
    expect((events[0]?.["telemetry"] as Record<string, any>)["stream"]).toMatchObject({ chunkCount: 0, chunks: [] });
  });
});

type Mw = (next: (args: Event) => Promise<Event>, context: Record<string | symbol, unknown>) => (args: Event) => Promise<Event>;

/** Minimal stand-in for an AWS SDK v3 client: a middleware stack and send(). */
function fakeBedrockClient(respond: (args: Event, commandName: string) => Promise<Event>) {
  const steps = ["initialize", "serialize", "build", "finalizeRequest", "deserialize"];
  const priorities = ["high", "normal", "low"];
  const entries: Array<{ middleware: Mw; step: string; priority: string; name: string }> = [];
  return {
    entries,
    middlewareStack: {
      add(middleware: Mw, options: Record<string, unknown>) {
        const name = String(options["name"]);
        const existing = entries.findIndex((entry) => entry.name === name);
        if (existing >= 0 && !options["override"]) throw new Error(`Duplicate middleware name '${name}'`);
        const entry = { middleware, step: String(options["step"] ?? "initialize"), priority: String(options["priority"] ?? "normal"), name };
        if (existing >= 0) entries.splice(existing, 1, entry);
        else entries.push(entry);
      },
    },
    async send(command: { commandName: string; path: string; input: Event }) {
      const ordered = [...entries].sort((a, b) =>
        steps.indexOf(a.step) - steps.indexOf(b.step) || priorities.indexOf(a.priority) - priorities.indexOf(b.priority));
      const handlerContext: Record<string | symbol, unknown> = { clientName: "BedrockRuntimeClient", commandName: command.commandName };
      let handler = (args: Event) => respond(args, command.commandName);
      for (const entry of ordered.reverse()) handler = entry.middleware(handler, handlerContext);
      const { modelId: _modelId, ...rest } = command.input;
      const result = await handler({
        input: command.input,
        request: {
          protocol: "https:",
          hostname: "bedrock-runtime.us-east-1.amazonaws.com",
          path: command.path,
          method: "POST",
          headers: { "content-type": "application/json", authorization: "AWS4-HMAC-SHA256 secret" },
          // The serialized wire body, as the AWS SDK builds it.
          body: typeof rest["body"] === "string" ? rest["body"] : JSON.stringify(rest),
        },
      });
      return result["output"] as Event;
    },
  };
}

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe("CostKey.instrumentBedrockClient", () => {
  let originalFetch: typeof globalThis.fetch;
  let events: Event[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const mock = createMockTransport();
    events = mock.events;
    patchFetch({ transport: mock.transport, projectId: "aws", captureBody: true, beforeSend: null, defaultContext: { service: "api" }, debug: false });
  });

  afterEach(() => {
    unpatchFetch();
    globalThis.fetch = originalFetch;
  });

  it("is exposed on the CostKey facade and leaves non-clients untouched", () => {
    expect(CostKey.instrumentBedrockClient).toBe(instrumentBedrockClient);
    const plain = { send: () => undefined };
    expect(instrumentBedrockClient(plain)).toBe(plain);
    expect(instrumentBedrockClient(null)).toBeNull();
  });

  it("records Converse usage with the caller's context", async () => {
    const client = instrumentBedrockClient(fakeBedrockClient(async () => ({
      response: { statusCode: 200, headers: { "x-amzn-requestid": "aws-req-1", "content-type": "application/json" } },
      output: {
        $metadata: { httpStatusCode: 200 },
        output: { message: { role: "assistant", content: [{ text: "Hi" }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18, cacheReadInputTokens: 4 },
      },
    })));
    // Instrumenting twice must not add a second recorder.
    instrumentBedrockClient(client);
    expect(client.entries).toHaveLength(2);

    const output = await withContext({ task: "summarize" }, () => client.send({
      commandName: "ConverseCommand",
      path: "/model/amazon.nova-pro-v1%3A0/converse",
      input: {
        modelId: "amazon.nova-pro-v1:0",
        messages: [{ role: "user", content: [{ text: "hello" }, { image: { format: "png", source: { bytes: new Uint8Array(4096) } } }] }],
      },
    }));
    expect(output["stopReason"]).toBe("end_turn");
    await flushPendingCaptures();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      statusCode: 200,
      streaming: false,
      url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-pro-v1%3A0/converse",
      context: { task: "summarize", service: "api" },
    });
    expect(events[0]).not.toHaveProperty("usage");
    const telemetry = events[0]?.["telemetry"] as Record<string, any>;
    expect(telemetry["request"]["headers"]).toEqual({ "content-type": "application/json" });
    expect(telemetry["response"]).toEqual({
      status: 200,
      headers: { "x-amzn-requestid": "aws-req-1", "content-type": "application/json" },
      body: {
        output: { message: { role: { $s: 9 }, content: [{ text: { $s: 2 } }] } },
        stopReason: { $s: 8 },
        usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18, cacheReadInputTokens: 4 },
      },
      bytes: null,
    });
  });

  it("reads InvokeModel usage from the body or token-count headers", async () => {
    const client = instrumentBedrockClient(fakeBedrockClient(async () => ({
      response: {
        statusCode: 200,
        headers: { "x-amzn-bedrock-input-token-count": "40", "x-amzn-bedrock-output-token-count": "11" },
      },
      output: {
        $metadata: { httpStatusCode: 200 },
        contentType: "application/json",
        body: encoder.encode(JSON.stringify({ generation: "ok", stop_reason: "stop" })),
      },
    })));
    await client.send({
      commandName: "InvokeModelCommand",
      path: "/model/meta.llama3-1-70b-instruct-v1%3A0/invoke",
      input: { modelId: "meta.llama3-1-70b-instruct-v1:0", body: JSON.stringify({ prompt: "hi", max_gen_len: 64 }) },
    });
    await flushPendingCaptures();
    const telemetry = events[0]?.["telemetry"] as Record<string, any>;
    expect(telemetry["request"]["body"]).toEqual({ prompt: { $s: 2 }, max_gen_len: 64 });
    // Token-count headers are forwarded raw; the body's bytes are decoded (framing).
    expect(telemetry["response"]["headers"]).toEqual({
      "x-amzn-bedrock-input-token-count": "40",
      "x-amzn-bedrock-output-token-count": "11",
    });
    expect(telemetry["response"]["body"]).toEqual({
      contentType: { $s: 16 },
      body: { generation: { $s: 2 }, stop_reason: "stop" },
    });
  });

  it("records ConverseStream usage once the caller finishes the stream", async () => {
    const streamEvents = [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hel" } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "lo" } } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 90, outputTokens: 2, totalTokens: 92 }, metrics: { latencyMs: 300 } } },
    ];
    const client = instrumentBedrockClient(fakeBedrockClient(async () => ({
      response: { statusCode: 200, headers: {} },
      output: { $metadata: { httpStatusCode: 200 }, stream: from(streamEvents) },
    })));
    const output = await client.send({
      commandName: "ConverseStreamCommand",
      path: "/model/anthropic.claude-3-5-haiku-20241022-v1%3A0/converse-stream",
      input: { modelId: "anthropic.claude-3-5-haiku-20241022-v1:0", messages: [] },
    });
    await flushPendingCaptures();
    expect(events).toHaveLength(0);

    const seen: unknown[] = [];
    for await (const item of output["stream"] as AsyncIterable<unknown>) seen.push(item);
    expect(seen).toEqual(streamEvents);
    await flushPendingCaptures();

    expect(events).toHaveLength(1);
    // Capture is on: every event's payload is sent whole, in order.
    expect(events[0]).toMatchObject({
      streaming: true,
      responseBody: { __costkey_stream__: streamEvents },
    });
    const stream = (events[0]?.["telemetry"] as Record<string, any>)["stream"];
    expect(stream["format"]).toBe("aws-eventstream");
    expect(stream["chunkCount"]).toBe(5);
    expect(stream["chunks"][4]).toEqual({
      metadata: { usage: { inputTokens: 90, outputTokens: 2, totalTokens: 92 }, metrics: { latencyMs: 300 } },
    });
  });

  it("records InvokeModelWithResponseStream usage, even when the caller stops early", async () => {
    const bytes = (json: unknown) => ({ chunk: { bytes: encoder.encode(JSON.stringify(json)) } });
    const client = instrumentBedrockClient(fakeBedrockClient(async () => ({
      response: { statusCode: 200, headers: {} },
      output: {
        $metadata: { httpStatusCode: 200 },
        body: from([
          bytes({ type: "message_start", message: { usage: { input_tokens: 70, output_tokens: 1 } } }),
          bytes({ type: "content_block_delta", delta: { text: "a" } }),
          bytes({ type: "message_delta", usage: { output_tokens: 25 } }),
        ]),
      },
    })));
    const output = await client.send({
      commandName: "InvokeModelWithResponseStreamCommand",
      path: "/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke-with-response-stream",
      input: { modelId: "anthropic.claude-3-haiku-20240307-v1:0", body: "{}" },
    });
    for await (const _ of output["body"] as AsyncIterable<unknown>) break;
    await flushPendingCaptures();
    expect(events).toHaveLength(1);
    const stream = (events[0]?.["telemetry"] as Record<string, any>)["stream"];
    expect(stream["chunkCount"]).toBe(1);
    expect(stream["chunks"]).toEqual([
      { chunk: { bytes: { type: "message_start", message: { usage: { input_tokens: 70, output_tokens: 1 } } } } },
    ]);
    // Content: the events the caller read, keyed by event type with `bytes` decoded.
    expect(events[0]?.["responseBody"]).toEqual({
      __costkey_stream__: [
        { chunk: { bytes: { type: "message_start", message: { usage: { input_tokens: 70, output_tokens: 1 } } } } },
      ],
    });
  });

  it("records a failed call and rethrows the provider error", async () => {
    const throttled = Object.assign(new Error("Too many requests"), {
      name: "ThrottlingException",
      $metadata: { httpStatusCode: 429 },
    });
    const client = instrumentBedrockClient(fakeBedrockClient(async () => {
      throw throttled;
    }));
    await expect(client.send({
      commandName: "ConverseCommand",
      path: "/model/amazon.nova-lite-v1%3A0/converse",
      input: { modelId: "amazon.nova-lite-v1:0", messages: [] },
    })).rejects.toBe(throttled);
    await flushPendingCaptures();
    expect(events[0]).toMatchObject({ statusCode: 429 });
    // The raw exception class, never the message.
    expect((events[0]?.["telemetry"] as Record<string, any>)["error"]).toEqual({ name: "ThrottlingException" });
    expect(JSON.stringify(events[0])).not.toContain("Too many requests");
  });

  it("does not double-record when the client sends through fetch", async () => {
    const client = instrumentBedrockClient(fakeBedrockClient(async () => {
      // A fetch-based request handler hitting the patched fetch.
      await fetch("https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-micro-v1%3A0/converse", {
        method: "POST",
        body: "{}",
      });
      return {
        response: { statusCode: 200, headers: {} },
        output: { $metadata: { httpStatusCode: 200 }, usage: { inputTokens: 1, outputTokens: 1 } },
      };
    }));
    await client.send({
      commandName: "ConverseCommand",
      path: "/model/amazon.nova-micro-v1%3A0/converse",
      input: { modelId: "amazon.nova-micro-v1:0", messages: [] },
    });
    await flushPendingCaptures();
    expect(events).toHaveLength(1);
  });

  it("skips other Bedrock commands and explicitly manual calls", async () => {
    const client = instrumentBedrockClient(fakeBedrockClient(async () => ({
      response: { statusCode: 200, headers: {} },
      output: { $metadata: { httpStatusCode: 200 }, usage: { inputTokens: 1, outputTokens: 1 } },
    })));
    await client.send({ commandName: "ApplyGuardrailCommand", path: "/guardrail/g1/version/1/apply", input: {} });
    await withContext({ costkeyCapture: "manual" }, () => client.send({
      commandName: "ConverseCommand",
      path: "/model/x/converse",
      input: { modelId: "x", messages: [] },
    }));
    await flushPendingCaptures();
    expect(events).toHaveLength(0);
  });

  it("passes calls through untouched when CostKey is not initialized", async () => {
    unpatchFetch();
    const client = instrumentBedrockClient(fakeBedrockClient(async () => ({
      response: { statusCode: 200, headers: {} },
      output: { $metadata: { httpStatusCode: 200 }, usage: { inputTokens: 1, outputTokens: 1 } },
    })));
    const output = await client.send({ commandName: "ConverseCommand", path: "/model/x/converse", input: { modelId: "x" } });
    expect(output["usage"]).toEqual({ inputTokens: 1, outputTokens: 1 });
    expect(events).toHaveLength(0);
  });
});
