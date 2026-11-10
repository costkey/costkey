/**
 * Golden skeleton tests: one per captured provider shape. The SDK sends what
 * it saw (request and response skeletons, headers, stream chunks); the
 * expected objects below are exactly what goes on the wire, minus timing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPendingCaptures, patchFetch, unpatchFetch } from "../fetch-patch.js";
import type { Transport } from "../transport.js";
import type { BeforeSendHook } from "../types.js";

type Event = Record<string, any>;

function createMockTransport() {
  const events: Event[] = [];
  return {
    transport: {
      enqueue: (event: Event) => events.push(event),
      start: () => {},
      stop: () => {},
      flush: async () => {},
    } as unknown as Transport,
    events,
  };
}

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const sse = (records: unknown[], headers: Record<string, string> = {}) =>
  new Response(records.map((record) => `data: ${typeof record === "string" ? record : JSON.stringify(record)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });

interface CaptureOptions {
  captureBody?: boolean;
  beforeSend?: BeforeSendHook;
}

async function capture(
  url: string,
  init: RequestInit | undefined,
  respond: () => Response | Promise<Response>,
  options: CaptureOptions = {},
) {
  const sent: Array<{ input: unknown; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (input: unknown, requestInit?: RequestInit) => {
    sent.push({ input, init: requestInit });
    return respond();
  }) as unknown as typeof fetch;
  const { transport, events } = createMockTransport();
  patchFetch({
    transport,
    projectId: "golden",
    captureBody: options.captureBody ?? false,
    beforeSend: options.beforeSend ?? null,
    defaultContext: {},
    debug: false,
  });
  const response = await globalThis.fetch(url, init);
  const body = new Uint8Array(await response.arrayBuffer());
  await flushPendingCaptures();
  return { events, event: events[0]!, response, body, sent };
}

/** The telemetry minus wall-clock values, which are checked for type only. */
function golden(event: Event): Event {
  const { startedAt, durationMs, ...rest } = event["telemetry"] as Event;
  expect(typeof startedAt).toBe("string");
  expect(typeof durationMs).toBe("number");
  if (rest["stream"]) {
    const { firstChunkMs, lastChunkMs, ...stream } = rest["stream"] as Event;
    expect(typeof firstChunkMs).toBe("number");
    expect(lastChunkMs).toBeGreaterThanOrEqual(firstChunkMs as number);
    rest["stream"] = stream;
  }
  return rest;
}

describe("raw telemetry capture through fetch", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    unpatchFetch();
    globalThis.fetch = originalFetch;
  });

  it("passes non-provider URLs through untouched", async () => {
    const { events, sent } = await capture("https://api.example.com/data", undefined, () => json({ ok: true }));
    expect(sent[0]).toEqual({ input: "https://api.example.com/data", init: undefined });
    expect(events).toHaveLength(0);
  });

  it("OpenAI chat completion (JSON)", async () => {
    const { event } = await capture(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-secret", "x-stainless-lang": "js" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }], max_tokens: 50 }),
      },
      () => json(
        {
          id: "chatcmpl-abc",
          object: "chat.completion",
          model: "gpt-4o-2024-08-06",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } },
          system_fingerprint: "fp_1",
        },
        { "x-request-id": "req_123", "openai-processing-ms": "200", "set-cookie": "__cf=1" },
      ),
    );
    expect(event).toMatchObject({
      eventType: "call",
      source: "auto",
      projectId: "golden",
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      statusCode: 200,
      streaming: false,
      requestBody: null,
      responseBody: null,
    });
    for (const derived of ["provider", "model", "usage", "costUsd", "streamTiming", "requestModel", "providerRequestId", "metadata", "systemPrompt"]) {
      expect(event).not.toHaveProperty(derived);
    }
    expect(event["callSite"]["frames"].length).toBeGreaterThan(0);
    expect(golden(event)).toEqual({
      v: 1,
      request: {
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        headers: { "content-type": "application/json", "x-stainless-lang": "js" },
        body: { model: "gpt-4o", messages: [{ role: { $s: 4 }, content: { $s: 2 } }], max_tokens: 50 },
        bytes: 78,
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "req_123", "openai-processing-ms": "200" },
        body: {
          id: "chatcmpl-abc",
          object: "chat.completion",
          model: "gpt-4o-2024-08-06",
          choices: [{ index: 0, message: { role: { $s: 9 }, content: { $s: 6 } }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } },
          system_fingerprint: "fp_1",
        },
        bytes: 314,
      },
      stream: null,
      error: null,
    });
  });

  it("OpenAI chat stream: injects stream_options.include_usage and sends every chunk", async () => {
    const { event, sent, body } = await capture(
      "https://api.openai.com/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [], stream_options: { foo: 1 } }) },
      () => sse([
        { id: "c1", object: "chat.completion.chunk", model: "gpt-4o", choices: [{ index: 0, delta: { content: "Hel" } }] },
        { id: "c1", object: "chat.completion.chunk", model: "gpt-4o", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
        { id: "c1", object: "chat.completion.chunk", model: "gpt-4o", choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
        "[DONE]",
      ]),
    );
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({
      model: "gpt-4o", stream: true, messages: [], stream_options: { foo: 1, include_usage: true },
    });
    expect(new TextDecoder().decode(body)).toContain("[DONE]");
    expect(event["streaming"]).toBe(true);
    const telemetry = golden(event);
    expect(telemetry["request"]["body"]).toEqual({
      model: "gpt-4o", stream: true, messages: [], stream_options: { foo: 1, include_usage: true },
    });
    expect(telemetry["response"]).toEqual({
      status: 200, headers: { "content-type": "text/event-stream" }, body: null, bytes: 424,
    });
    expect(telemetry["stream"]).toEqual({
      format: "sse",
      chunkCount: 3,
      chunks: [
        { id: "c1", object: "chat.completion.chunk", model: "gpt-4o", choices: [{ index: 0, delta: { content: { $s: 3 } } }] },
        { id: "c1", object: "chat.completion.chunk", model: "gpt-4o", choices: [{ index: 0, delta: { content: { $s: 2 } }, finish_reason: "stop" }] },
        { id: "c1", object: "chat.completion.chunk", model: "gpt-4o", choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
      ],
    });
  });

  it("OpenAI Responses API stream: no injection (the API rejects it)", async () => {
    const { sent, event } = await capture(
      "https://api.openai.com/v1/responses",
      { method: "POST", body: JSON.stringify({ model: "gpt-5", input: "hi", stream: true }) },
      () => sse([
        { type: "response.created", response: { id: "resp_1", model: "gpt-5", status: "in_progress" } },
        { type: "response.output_text.delta", response_id: "resp_1", item_id: "msg_1", delta: "Hi" },
        { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 5, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 } } } },
      ]),
    );
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({ model: "gpt-5", input: "hi", stream: true });
    const chunks = golden(event)["stream"]["chunks"];
    expect(chunks[1]).toEqual({ type: "response.output_text.delta", response_id: "resp_1", item_id: { $s: 5 }, delta: { $s: 2 } });
    expect(chunks[2]).toEqual({
      type: "response.completed",
      response: { id: "resp_1", status: "completed", usage: { input_tokens: 5, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 } } },
    });
  });

  it("Anthropic messages stream", async () => {
    const { event } = await capture(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: { "anthropic-version": "2023-06-01", "x-api-key": "sk-ant-secret", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, stream: true, system: "be brief", messages: [{ role: "user", content: "hi" }] }),
      },
      () => new Response(
        "event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "claude-sonnet-4-5", usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 0 } } }) + "\n\n"
        + "event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }) + "\n\n"
        + "event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } }) + "\n\n",
        { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_anth", "anthropic-ratelimit-tokens-remaining": "100" } },
      ),
    );
    const telemetry = golden(event);
    expect(telemetry["request"]).toEqual({
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: { "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: { model: "claude-sonnet-4-5", max_tokens: 1024, stream: true, system: { $s: 8 }, messages: [{ role: { $s: 4 }, content: { $s: 2 } }] },
      bytes: 125,
    });
    // `anthropic-ratelimit-tokens-remaining` contains "token" and is not a count header.
    expect(telemetry["response"]["headers"]).toEqual({ "content-type": "text/event-stream", "request-id": "req_anth" });
    expect(telemetry["stream"]).toEqual({
      format: "sse",
      chunkCount: 3,
      chunks: [
        { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-4-5", usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 0 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: { $s: 5 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } },
      ],
    });
  });

  it("Gemini generateContent: drops ?key=, keeps raw usageMetadata (no tool-token sums)", async () => {
    const { event } = await capture(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaSecret",
      { method: "POST", body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }], tools: [{ googleSearch: {} }] }) },
      () => json({
        candidates: [{
          content: { role: "model", parts: [{ text: "ok" }] },
          finishReason: "STOP",
          groundingMetadata: { webSearchQueries: ["q1", "q1"], groundingChunks: [{ web: { uri: "https://a" } }] },
        }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, toolUsePromptTokenCount: 50, thoughtsTokenCount: 4, totalTokenCount: 64 },
        modelVersion: "gemini-2.5-flash",
        responseId: "r-1",
      }),
    );
    const telemetry = golden(event);
    expect(event["url"]).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(telemetry["request"]["url"]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(telemetry["response"]["body"]).toEqual({
      candidates: [{
        content: { role: { $s: 5 }, parts: [{ text: { $s: 2 } }] },
        finishReason: "STOP",
        groundingMetadata: { webSearchQueries: [{ $s: 2 }, { $s: 2 }], groundingChunks: [{ web: { uri: { $s: 9 } } }] },
      }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, toolUsePromptTokenCount: 50, thoughtsTokenCount: 4, totalTokenCount: 64 },
      modelVersion: "gemini-2.5-flash",
      responseId: "r-1",
    });
  });

  it("Gemini streamGenerateContent without alt=sse is read as a JSON array stream", async () => {
    const { event } = await capture(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent",
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      () => new Response('[{"usageMetadata":{"promptTokenCount":5}}\n,\r\n{"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":9}}]', {
        status: 200, headers: { "content-type": "application/json; charset=UTF-8" },
      }),
    );
    expect(golden(event)["stream"]).toEqual({
      format: "json-array",
      chunkCount: 2,
      chunks: [{ usageMetadata: { promptTokenCount: 5 } }, { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 } }],
    });
  });

  it("Gemini alt=sse keeps alt in the URL", async () => {
    const { event } = await capture(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=secret",
      { method: "POST", body: "{}" },
      () => sse([{ usageMetadata: { promptTokenCount: 1 } }]),
    );
    const telemetry = golden(event);
    expect(telemetry["request"]["url"]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    );
    expect(telemetry["stream"]["chunkCount"]).toBe(1);
  });

  it("Deepgram listen: binary audio request, model from the query (no default model)", async () => {
    const { event } = await capture(
      "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true",
      { method: "POST", headers: { "Content-Type": "audio/wav", Authorization: "Token dg-secret" }, body: new Uint8Array(32_000) },
      () => json({ metadata: { request_id: "dg-1", duration: 12.5, channels: 1, models: ["m-1"] }, results: { channels: [] } }),
    );
    expect(golden(event)).toEqual({
      v: 1,
      request: {
        method: "POST",
        url: "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true",
        headers: { "content-type": "audio/wav" },
        body: { $bytes: 32_000 },
        bytes: 32_000,
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { metadata: { request_id: "dg-1", duration: 12.5, channels: 1, models: [{ $s: 3 }] }, results: { channels: [] } },
        bytes: 106,
      },
      stream: null,
      error: null,
    });
  });

  it("ElevenLabs TTS: request text length only, audio bytes never read (no default model)", async () => {
    const audio = new Uint8Array(4096);
    const { event, body } = await capture(
      "https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_128",
      { method: "POST", headers: { "content-type": "application/json", "xi-api-key": "secret" }, body: JSON.stringify({ text: "Hello world", voice_settings: { stability: 0.5 } }) },
      () => new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg", "content-length": "4096", "character-cost": "11" } }),
    );
    expect(body.byteLength).toBe(4096);
    expect(golden(event)).toEqual({
      v: 1,
      request: {
        method: "POST",
        url: "https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_128",
        headers: { "content-type": "application/json" },
        body: { text: { $s: 11 }, voice_settings: { stability: 0.5 } },
        bytes: 57,
      },
      response: {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": "4096", "character-cost": "11" },
        body: { $bytes: 4096 },
        bytes: 4096,
      },
      stream: null,
      error: null,
    });
  });

  it("an unsized binary response is counted as it passes through", async () => {
    const { event, body } = await capture(
      "https://api.cartesia.ai/tts/bytes",
      { method: "POST", body: JSON.stringify({ model_id: "sonic-2", transcript: "hi there" }) },
      () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(100));
          controller.enqueue(new Uint8Array(50));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "audio/wav" } }),
    );
    expect(body.byteLength).toBe(150);
    const telemetry = golden(event);
    expect(telemetry["request"]["body"]).toEqual({ model_id: "sonic-2", transcript: { $s: 8 } });
    expect(telemetry["response"]).toMatchObject({ body: { $bytes: 150 }, bytes: 150 });
    expect(telemetry["stream"]).toBeNull();
  });

  it("OpenAI transcription: multipart form described part by part", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(2048)], { type: "audio/mpeg" }), "call.mp3");
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    const { event } = await capture(
      "https://api.openai.com/v1/audio/transcriptions",
      { method: "POST", body: form },
      () => json({ text: "hello", duration: 3.2, usage: { type: "duration", seconds: 4 } }),
    );
    const telemetry = golden(event);
    expect(telemetry["request"]["body"]).toEqual({
      $multipart: [
        { name: "file", filename: { $s: 8 }, contentType: "audio/mpeg", bytes: 2048 },
        { name: "model", value: "whisper-1" },
        { name: "response_format", value: "verbose_json" },
      ],
    });
    expect(telemetry["response"]["body"]).toEqual({ text: { $s: 5 }, duration: 3.2, usage: { type: "duration", seconds: 4 } });
  });

  it("Ollama native chat stream (NDJSON)", async () => {
    const { event, sent } = await capture(
      "http://localhost:11434/api/chat",
      { method: "POST", body: JSON.stringify({ model: "llama3.2", messages: [{ role: "user", content: "hi" }], stream: true }) },
      () => new Response('{"model":"llama3.2","message":{"content":"Hi"},"done":false}\n{"model":"llama3.2","done":true,"prompt_eval_count":12,"eval_count":4}\n', {
        status: 200, headers: { "content-type": "application/x-ndjson" },
      }),
    );
    expect(JSON.parse(String(sent[0]?.init?.body))["stream_options"]).toEqual({ include_usage: true });
    expect(golden(event)["stream"]).toEqual({
      format: "ndjson",
      chunkCount: 2,
      chunks: [
        { model: "llama3.2", message: { content: { $s: 2 } }, done: false },
        { model: "llama3.2", done: true, prompt_eval_count: 12, eval_count: 4 },
      ],
    });
  });

  it("OpenRouter: the router's own cost stays a raw number (no costUsd field)", async () => {
    const { event } = await capture(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: "anthropic/claude-sonnet-4.5", messages: [] }) },
      () => json({ id: "gen-1", model: "anthropic/claude-sonnet-4.5", usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.00042 } }),
    );
    expect(event).not.toHaveProperty("costUsd");
    expect(golden(event)["response"]["body"]["usage"]).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.00042 });
  });

  it("Portkey and DeepSeek are captured as raw calls: no relabel, no field mapping", async () => {
    const portkey = await capture(
      "https://api.portkey.ai/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }) },
      () => json({ id: "pk-1", model: "gpt-4o-mini", usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    expect(portkey.event).not.toHaveProperty("provider");
    expect(golden(portkey.event)["request"]["url"]).toBe("https://api.portkey.ai/v1/chat/completions");
    unpatchFetch();
    const deepseek = await capture(
      "https://api.deepseek.com/chat/completions",
      { method: "POST", body: JSON.stringify({ model: "deepseek-chat", messages: [] }) },
      () => json({ id: "ds-1", model: "deepseek-chat", usage: { prompt_tokens: 9, completion_tokens: 3, prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 3 } }),
    );
    expect(golden(deepseek.event)["response"]["body"]["usage"]).toEqual({
      prompt_tokens: 9, completion_tokens: 3, prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 3,
    });
  });

  it("Exa, Firecrawl and Tavily: raw counts only, no default counts", async () => {
    const exa = await capture(
      "https://api.exa.ai/search",
      { method: "POST", body: JSON.stringify({ query: "ai costs", numResults: 5, type: "neural" }) },
      () => json({ requestId: "exa-1", results: [{ title: "a", url: "https://a" }], costDollars: { total: 0.005 } }),
    );
    expect(golden(exa.event)["response"]["body"]).toEqual({
      requestId: "exa-1", results: [{ title: { $s: 1 }, url: { $s: 9 } }], costDollars: { total: 0.005 },
    });
    unpatchFetch();
    const firecrawl = await capture(
      "https://api.firecrawl.dev/v1/scrape",
      { method: "POST", body: JSON.stringify({ url: "https://example.com", formats: ["markdown"] }) },
      () => json({ success: true, data: { markdown: "# Example", metadata: { creditsUsed: 1 } } }),
    );
    expect(golden(firecrawl.event)["response"]["body"]).toEqual({
      success: true, data: { markdown: { $s: 9 }, metadata: { creditsUsed: 1 } },
    });
    unpatchFetch();
    const tavily = await capture(
      "https://api.tavily.com/search",
      { method: "POST", body: JSON.stringify({ query: "x", search_depth: "advanced" }) },
      () => json({ query: "x", results: [], response_time: 1.2 }),
    );
    expect(golden(tavily.event)["request"]["body"]).toEqual({ query: { $s: 1 }, search_depth: "advanced" });
  });

  it("AssemblyAI polls: every GET is its own event (no completed-poll dedup), speech_model kept", async () => {
    let poll = 0;
    globalThis.fetch = vi.fn(async () => json({ id: "tr_1", status: poll++ === 0 ? "processing" : "completed", speech_model: "universal", audio_duration: 61, text: "secret" })) as unknown as typeof fetch;
    const { transport, events } = createMockTransport();
    patchFetch({ transport, projectId: "golden", captureBody: false, beforeSend: null, defaultContext: {}, debug: false });
    for (let index = 0; index < 3; index++) await (await fetch("https://api.assemblyai.com/v2/transcript/tr_1")).json();
    await flushPendingCaptures();
    expect(events).toHaveLength(3);
    expect(events.map((event) => event["telemetry"]["response"]["body"]["status"])).toEqual(["processing", "completed", "completed"]);
    expect(events[0]?.["method"]).toBe("GET");
    expect(events[2]?.["telemetry"]["response"]["body"]).toEqual({
      id: "tr_1", status: "completed", speech_model: "universal", audio_duration: 61, text: { $s: 6 },
    });
  });

  it("Rumik TTS: no default model is filled in", async () => {
    const { event } = await capture(
      "https://silk-api.rumik.ai/v1/tts",
      { method: "POST", body: JSON.stringify({ text: "namaste" }) },
      () => new Response(new Uint8Array(10), { status: 200, headers: { "content-type": "audio/wav", "content-length": "10" } }),
    );
    expect(golden(event)["request"]["body"]).toEqual({ text: { $s: 7 } });
    expect(event).not.toHaveProperty("model");
  });

  it("caps streams over 200 chunks at the first 20 and last 50 with the real count", async () => {
    const records = Array.from({ length: 450 }, (_, index) => ({ i: index }));
    const { event } = await capture(
      "https://api.openai.com/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [] }) },
      () => sse(records),
    );
    const stream = golden(event)["stream"];
    expect(stream["chunkCount"]).toBe(450);
    expect(stream["chunks"]).toHaveLength(70);
    expect(stream["chunks"].slice(0, 20)).toEqual(records.slice(0, 20));
    expect(stream["chunks"].slice(20)).toEqual(records.slice(400));
  });

  it("records a network failure with the raw error name and code, then rethrows", async () => {
    const failure = new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    globalThis.fetch = vi.fn(async () => {
      throw failure;
    }) as unknown as typeof fetch;
    const { transport, events } = createMockTransport();
    patchFetch({ transport, projectId: "golden", captureBody: false, beforeSend: null, defaultContext: {}, debug: false });
    await expect(fetch("https://api.mistral.ai/v1/chat/completions", { method: "POST", body: "{}" })).rejects.toBe(failure);
    await flushPendingCaptures();
    expect(events[0]?.["statusCode"]).toBeNull();
    expect(golden(events[0]!)).toMatchObject({ response: null, stream: null, error: { name: "TypeError", code: "ECONNRESET" } });
    expect(JSON.stringify(events[0])).not.toContain("socket hang up");
  });

  it("records a non-2xx response raw (the server classifies it)", async () => {
    const { event } = await capture(
      "https://api.groq.com/openai/v1/chat/completions",
      { method: "POST", body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [] }) },
      () => json({ error: { message: "Rate limit reached", type: "tokens", code: "rate_limit_exceeded" } }, { "retry-after": "2" }, 429),
    );
    expect(event["statusCode"]).toBe(429);
    expect(golden(event)["response"]).toEqual({
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "2" },
      body: { error: { message: { $s: 18 }, type: "tokens", code: { $s: 19 } } },
      bytes: 87,
    });
  });

  it("captures content (opt-in) with credentials scrubbed and media omitted, alongside the skeleton", async () => {
    const { event } = await capture(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o",
          api_key: "sk-thisisasecretthatshouldneverleave",
          messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(4000)}` } }] }],
        }),
      },
      () => json({ id: "c", choices: [{ message: { content: "a cat" } }] }),
      { captureBody: true },
    );
    expect(event["requestBody"]["api_key"]).toBe("[REDACTED]");
    expect(JSON.stringify(event["requestBody"])).toContain("[image data omitted: image/png");
    expect(event["responseBody"]).toEqual({ id: "c", choices: [{ message: { content: "a cat" } }] });
    expect(golden(event)["request"]["body"]["api_key"]).toEqual({ $s: 36 });
  });

  it("respects beforeSend and re-asserts metadata-only content at the wire", async () => {
    const { events } = await capture(
      "https://api.openai.com/v1/embeddings",
      { method: "POST", body: JSON.stringify({ model: "text-embedding-3-small", input: "x" }) },
      () => json({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.1) }], usage: { prompt_tokens: 1, total_tokens: 1 } }),
      { beforeSend: (event) => ({ ...event, requestBody: "smuggled", context: { ...event.context, tagged: true } }) },
    );
    expect(events[0]?.["requestBody"]).toBeNull();
    expect(events[0]?.["context"]["tagged"]).toBe(true);
    // Embedding vectors don't ship: 8 values, then $more.
    expect(events[0]?.["telemetry"]["response"]["body"]["data"][0]["embedding"]).toHaveLength(9);
    unpatchFetch();
    const dropped = await capture(
      "https://api.openai.com/v1/embeddings",
      { method: "POST", body: "{}" },
      () => json({}),
      { beforeSend: () => null },
    );
    expect(dropped.events).toHaveLength(0);
  });
});
