/**
 * With content capture on, a streamed response is sent as
 * `responseBody: {"__costkey_stream__": [every event, in order]}` so the
 * server can assemble what the model answered. The caller's stream is
 * passed through byte for byte either way.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPendingCaptures, patchFetch, unpatchFetch } from "../fetch-patch.js";
import type { Transport } from "../transport.js";

type Event = Record<string, any>;

const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;

afterEach(() => {
  unpatchFetch();
  globalThis.fetch = originalFetch;
});

/** Deliver bytes in awkward slices so events (and UTF-8 characters) straddle reads. */
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

async function stream(
  url: string,
  requestBody: unknown,
  bytes: Uint8Array,
  contentType: string,
  captureBody: boolean,
): Promise<{ event: Event; received: Uint8Array }> {
  globalThis.fetch = vi.fn(async () => new Response(sliced(bytes, 7), {
    status: 200,
    headers: { "content-type": contentType },
  })) as unknown as typeof fetch;
  const events: Event[] = [];
  patchFetch({
    transport: { enqueue: (event: Event) => events.push(event), start() {}, stop() {}, flush: async () => {} } as unknown as Transport,
    projectId: "streams",
    captureBody,
    beforeSend: null,
    defaultContext: {},
    debug: false,
  });
  const response = await globalThis.fetch(url, { method: "POST", body: JSON.stringify(requestBody) });
  // Read the way an SDK does: chunk by chunk through the body's reader.
  const reader = response.body!.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  await flushPendingCaptures();
  expect(events).toHaveLength(1);
  const received = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    received.set(part, offset);
    offset += part.length;
  }
  return { event: events[0]!, received };
}

const sseText = (events: Array<{ event?: string; data: unknown }>, newline = "\n") =>
  events.map(({ event, data }) =>
    `${event ? `event: ${event}${newline}` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}${newline}${newline}`,
  ).join("");

// ── Fixtures ──

const responsesEvents = [
  { event: "response.created", data: { type: "response.created", sequence_number: 0, response: { id: "resp_1", status: "in_progress", model: "gpt-5" } } },
  { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } } },
  { event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Bonjour, " } },
  { event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "le monde 🌍" } },
  { event: "response.completed", data: {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Bonjour, le monde 🌍" }] }],
      usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    },
  } },
];

const chatChunks = [
  { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
  { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "The answer " } }] },
  { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "is 42." }, finish_reason: "stop" }] },
  { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } },
];

const anthropicEvents = [
  { event: "message_start", data: { type: "message_start", message: { id: "msg_01", model: "claude-sonnet-4-5", role: "assistant", content: [], usage: { input_tokens: 25, output_tokens: 1 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { event: "ping", data: { type: "ping" } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " there" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } } },
  { event: "message_stop", data: { type: "message_stop" } },
];

const geminiChunks = [
  { candidates: [{ content: { role: "model", parts: [{ text: "Roses " }] } }], modelVersion: "gemini-2.5-flash" },
  { candidates: [{ content: { role: "model", parts: [{ text: "are red." }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 5, totalTokenCount: 9 }, modelVersion: "gemini-2.5-flash" },
];

// ── Tests ──

describe("streamed response content", () => {
  it("OpenAI Responses SSE: named events become {event, data}, in order", async () => {
    const bytes = encoder.encode(sseText(responsesEvents));
    const { event, received } = await stream(
      "https://api.openai.com/v1/responses",
      { model: "gpt-5", input: "Say hello in French", stream: true },
      bytes,
      "text/event-stream; charset=utf-8",
      true,
    );
    expect(received).toEqual(bytes);
    expect(event["streaming"]).toBe(true);
    expect(event["responseBody"]).toEqual({ __costkey_stream__: responsesEvents });
    // The skeleton telemetry is unchanged by content capture.
    expect(event["telemetry"]["stream"]).toMatchObject({ format: "sse", chunkCount: 5 });
    expect(JSON.stringify(event["telemetry"])).not.toContain("Bonjour");
  });

  it("chat completions SSE: plain data events, [DONE] dropped", async () => {
    const bytes = encoder.encode(sseText([...chatChunks.map((data) => ({ data })), { data: "[DONE]" }]));
    const { event, received } = await stream(
      "https://api.openai.com/v1/chat/completions",
      { model: "gpt-4o", messages: [{ role: "user", content: "?" }], stream: true },
      bytes,
      "text/event-stream",
      true,
    );
    expect(received).toEqual(bytes);
    expect(event["responseBody"]).toEqual({ __costkey_stream__: chatChunks });
  });

  it("Anthropic Messages SSE (CRLF framing, comments, non-JSON data dropped)", async () => {
    const text = `: keep-alive\r\n\r\n${sseText(anthropicEvents, "\r\n")}event: note\r\ndata: not json\r\n\r\n`;
    const bytes = encoder.encode(text);
    const { event, received } = await stream(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-sonnet-4-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }], stream: true },
      bytes,
      "text/event-stream",
      true,
    );
    expect(received).toEqual(bytes);
    expect(event["responseBody"]).toEqual({ __costkey_stream__: anthropicEvents });
  });

  it("Gemini SSE (alt=sse): one element per data event", async () => {
    const bytes = encoder.encode(sseText(geminiChunks.map((data) => ({ data }))));
    const { event, received } = await stream(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
      { contents: [{ role: "user", parts: [{ text: "poem" }] }] },
      bytes,
      "text/event-stream",
      true,
    );
    expect(received).toEqual(bytes);
    expect(event["responseBody"]).toEqual({ __costkey_stream__: geminiChunks });
  });

  it("Gemini streamGenerateContent JSON array: one element per array item", async () => {
    const bytes = encoder.encode(`[${geminiChunks.map((chunk) => JSON.stringify(chunk)).join(",\r\n")}]`);
    const { event, received } = await stream(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent",
      { contents: [{ role: "user", parts: [{ text: "poem" }] }] },
      bytes,
      "application/json; charset=UTF-8",
      true,
    );
    expect(received).toEqual(bytes);
    expect(event["responseBody"]).toEqual({ __costkey_stream__: geminiChunks });
  });

  it("NDJSON: one element per parsed line", async () => {
    const lines = [
      { model: "llama3.2", message: { role: "assistant", content: "Hi" }, done: false },
      { model: "llama3.2", message: { role: "assistant", content: "!" }, done: false },
      { model: "llama3.2", done: true, prompt_eval_count: 12, eval_count: 4 },
    ];
    const bytes = encoder.encode(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const { event, received } = await stream(
      "http://localhost:11434/api/chat",
      { model: "llama3.2", messages: [{ role: "user", content: "hi" }], stream: true },
      bytes,
      "application/x-ndjson",
      true,
    );
    expect(received).toEqual(bytes);
    expect(event["responseBody"]).toEqual({ __costkey_stream__: lines });
  });

  it("keeps every event: no cap on count or size", async () => {
    const deltas = Array.from({ length: 1_500 }, (_, index) => ({
      event: "response.output_text.delta",
      data: { type: "response.output_text.delta", delta: index === 0 ? "x".repeat(40_000) : `t${index}` },
    }));
    const bytes = encoder.encode(sseText(deltas));
    const { event, received } = await stream(
      "https://api.openai.com/v1/responses",
      { model: "gpt-5", input: "long", stream: true },
      bytes,
      "text/event-stream",
      true,
    );
    expect(received).toEqual(bytes);
    expect(event["responseBody"]["__costkey_stream__"]).toHaveLength(1_500);
    expect(event["responseBody"]["__costkey_stream__"]).toEqual(deltas);
    // The skeleton keeps its existing chunk cap.
    expect(event["telemetry"]["stream"]["chunks"].length).toBeLessThan(1_500);
  });

  it("scrubs secrets in streamed events like any captured body", async () => {
    const chunks = [
      { id: "c", choices: [{ delta: { content: "key: " } }] },
      { id: "c", choices: [{ delta: { content: "sk-abcdefghijklmnopqrstuvwxyz123456" } }], api_key: "hunter2" },
    ];
    const bytes = encoder.encode(sseText(chunks.map((data) => ({ data }))));
    const { event, received } = await stream(
      "https://api.openai.com/v1/chat/completions",
      { model: "gpt-4o", messages: [], stream: true },
      bytes,
      "text/event-stream",
      true,
    );
    expect(received).toEqual(bytes);
    expect(event["responseBody"]).toEqual({
      __costkey_stream__: [
        { id: "c", choices: [{ delta: { content: "key: " } }] },
        { id: "c", choices: [{ delta: { content: "[REDACTED]" } }], api_key: "[REDACTED]" },
      ],
    });
  });

  describe("with capture off", () => {
    it.each([
      ["OpenAI Responses SSE", "https://api.openai.com/v1/responses", "text/event-stream", sseText(responsesEvents)],
      ["chat completions SSE", "https://api.openai.com/v1/chat/completions", "text/event-stream",
        sseText([...chatChunks.map((data) => ({ data })), { data: "[DONE]" }])],
      ["Anthropic SSE", "https://api.anthropic.com/v1/messages", "text/event-stream", sseText(anthropicEvents)],
      ["Gemini SSE", "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
        "text/event-stream", sseText(geminiChunks.map((data) => ({ data })))],
      ["NDJSON", "http://localhost:11434/api/chat", "application/x-ndjson", '{"done":false}\n{"done":true}\n'],
    ])("%s: no responseBody, only skeleton telemetry", async (_label, url, contentType, text) => {
      const bytes = encoder.encode(text);
      const { event, received } = await stream(url, { model: "m", stream: true }, bytes, contentType, false);
      expect(received).toEqual(bytes);
      expect(event["responseBody"]).toBeNull();
      expect(event["requestBody"]).toBeNull();
      expect(event["telemetry"]["stream"]["chunkCount"]).toBeGreaterThan(0);
      expect(JSON.stringify(event)).not.toContain("__costkey_stream__");
    });
  });
});
