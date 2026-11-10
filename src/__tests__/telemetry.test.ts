import { describe, expect, it } from "vitest";
import {
  ChunkCollector,
  KEEP_STRING_KEYS,
  TextStreamParser,
  capSkeleton,
  codePointLength,
  multipartSkeleton,
  requestBodySkeleton,
  sanitizeTelemetryUrl,
  skeleton,
  telemetryError,
  telemetryRequestHeaders,
  telemetryResponseHeaders,
} from "../telemetry.js";

describe("skeleton rules (contract v1)", () => {
  it("keeps every key, replaces strings by their length and keeps scalars", () => {
    expect(skeleton({
      model: "gpt-4o",
      id: "chatcmpl-1",
      messages: [{ role: "user", content: "hello there" }],
      temperature: 0.2,
      stream: true,
      stop: null,
      user: "alice@example.com",
    })).toEqual({
      model: "gpt-4o",
      id: "chatcmpl-1",
      messages: [{ role: { $s: 4 }, content: { $s: 11 } }],
      temperature: 0.2,
      stream: true,
      stop: null,
      user: { $s: 17 },
    });
  });

  it("keeps an allowlisted string only up to 200 characters", () => {
    expect(skeleton({ model: "m".repeat(200) })).toEqual({ model: "m".repeat(200) });
    expect(skeleton({ model: "m".repeat(201) })).toEqual({ model: { $s: 201 } });
  });

  it("counts Unicode code points, not UTF-16 units", () => {
    expect(codePointLength("héllo 😀")).toBe(7);
    expect(skeleton({ text: "😀😀" })).toEqual({ text: { $s: 2 } });
    expect(skeleton({ model: "naïve-😀" })).toEqual({ model: "naïve-😀" });
  });

  it("never keeps a string inside an array, even under an allowlisted key", () => {
    expect(skeleton({ model: ["gpt-4o"], type: ["a", 1] })).toEqual({ model: [{ $s: 6 }], type: [{ $s: 1 }, 1] });
  });

  it("keeps arrays of up to 32 items and caps longer ones at 8 plus $more", () => {
    const thirtyTwo = Array.from({ length: 32 }, (_, index) => index);
    expect(skeleton({ v: thirtyTwo })).toEqual({ v: thirtyTwo });
    const embedding = Array.from({ length: 1536 }, (_, index) => index / 1536);
    expect(skeleton({ embedding })).toEqual({ embedding: [...embedding.slice(0, 8), { $more: 1528 }] });
  });

  it("truncates containers at depth 12 and keeps scalars there", () => {
    // Root is depth 0; a container at depth 12 is replaced.
    let value: Record<string, unknown> = { leaf: 1, deep: {} };
    for (let depth = 0; depth < 12; depth++) value = { n: depth, child: value };
    let node = skeleton(value) as Record<string, unknown>;
    for (let depth = 0; depth < 11; depth++) node = node["child"] as Record<string, unknown>;
    // depth 11 object is kept; its child at depth 12 is truncated, its scalar kept.
    expect(node["n"]).toBe(0);
    expect(node["child"]).toEqual({ $trunc: true });
  });

  it("sends NaN and Infinity as null and drops undefined like JSON", () => {
    expect(skeleton({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: undefined, d: [Number.NEGATIVE_INFINITY] }))
      .toEqual({ a: null, b: null, d: [null] });
  });

  it("turns binary into $bytes", () => {
    expect(skeleton({ audio: new Uint8Array(1024) })).toEqual({ audio: { $bytes: 1024 } });
    expect(requestBodySkeleton(new ArrayBuffer(16))).toEqual({ body: { $bytes: 16 }, bytes: 16 });
  });

  it("caps a serialized skeleton at 64 KB by truncating the deepest subtrees first", () => {
    const wide = Array.from({ length: 30 }, (_, row) => ({
      row,
      cells: Array.from({ length: 30 }, (_, cell) => ({ cell, values: Array.from({ length: 30 }, (_, v) => v * 1000.5) })),
    }));
    const capped = capSkeleton(skeleton({ id: "x", rows: wide }, undefined)) as Record<string, any>;
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(64 * 1024);
    expect(capped["id"]).toBe("x");
    expect(capped["rows"][0]["row"]).toBe(0);
    // The deepest level (the value arrays) went first.
    expect(capped["rows"][0]["cells"][0]).toEqual({ cell: 0, values: { $trunc: true } });
  });

  it("parses JSON text bodies and treats other text as a root string", () => {
    expect(requestBodySkeleton('{"model":"x","input":"secret"}')).toEqual({
      body: { model: "x", input: { $s: 6 } },
      bytes: 30,
    });
    expect(requestBodySkeleton("plain secret text")).toEqual({ body: { $s: 17 }, bytes: 17 });
    expect(requestBodySkeleton(null)).toEqual({ body: null, bytes: null });
  });

  it("describes multipart bodies field by field", () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(88)], { type: "audio/wav" }), "meeting.wav");
    form.append("model", "whisper-1");
    form.append("prompt", "speaker names");
    expect(multipartSkeleton(form)).toEqual({
      $multipart: [
        { name: "file", filename: { $s: 11 }, contentType: "audio/wav", bytes: 88 },
        { name: "model", value: "whisper-1" },
        { name: "prompt", value: { $s: 13 } },
      ],
    });
    // A text field's key is its field name: allowlisted names keep their value.
    const allowed = new FormData();
    allowed.append("language", "en");
    expect(multipartSkeleton(allowed)).toEqual({ $multipart: [{ name: "language", value: "en" }] });
  });

  it("matches the contract's allowlist exactly", () => {
    expect([...KEEP_STRING_KEYS].sort()).toEqual([
      "created", "created_at", "currency", "encoding", "event", "finishReason", "finish_reason", "id", "job_id",
      "jobId", "language", "language_code", "modality", "mode", "model", "modelId", "modelVersion", "model_id",
      "object", "operation", "output_format", "provider", "quality", "request_id", "requestId", "response_format",
      "responseId", "search_depth", "service_tier", "size", "status", "stop_reason", "style", "system_fingerprint",
      "tier", "topic", "trafficType", "type", "unit", "voice_id", "speech_model", "response_id",
    ].sort());
  });
});

describe("URL query filtering (settled detail 1)", () => {
  it("keeps the query but drops secret parameters, userinfo and fragment", () => {
    expect(sanitizeTelemetryUrl(
      "https://user:pass@api.deepgram.com/v1/listen?model=nova-3&smart_format=true&key=k1&API_KEY=k2&apikey=k3&api-key=k4&token=t&access_token=t2&authorization=a&auth_token=a2&sig=s&Signature=s2&X-Amz-Credential=c&x-amz-security-token=c2&code=c3#frag",
    )).toBe("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true");
    expect(sanitizeTelemetryUrl(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=AIzaSecret",
    )).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
  });

  it("keeps parameters that merely contain a secret-looking word", () => {
    expect(sanitizeTelemetryUrl("https://api.example.com/x?monkey=1&keys=2&tokens_max=3&encoding=linear16"))
      .toBe("https://api.example.com/x?monkey=1&keys=2&tokens_max=3&encoding=linear16");
  });
});

describe("header allowlist and denylist", () => {
  it("sends only allowlisted request headers, lowercased", () => {
    expect(telemetryRequestHeaders({
      "Content-Type": "application/json",
      "Anthropic-Version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "OpenAI-Beta": "assistants=v2",
      "x-goog-api-client": "genai-js/1.0",
      "X-Stainless-Lang": "js",
      Authorization: "Bearer sk-secret",
      "x-api-key": "secret",
      "x-stainless-os": "MacOS",
      "user-agent": "OpenAI/JS",
    })).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "openai-beta": "assistants=v2",
      "x-goog-api-client": "genai-js/1.0",
      "x-stainless-lang": "js",
    });
  });

  it("sends every response header except the denylist and non-count token headers", () => {
    expect(telemetryResponseHeaders(new Headers({
      "x-request-id": "req_1",
      "x-amzn-bedrock-input-token-count": "120",
      "x-ratelimit-remaining-tokens": "9000",
      "anthropic-ratelimit-tokens-remaining": "100",
      "x-session-token": "secret",
      "set-cookie": "a=b",
      authorization: "secret",
      "proxy-authorization": "secret",
      "x-api-key": "secret",
      "api-key": "secret",
      "openai-processing-ms": "321",
      "Content-Type": "application/json",
    }))).toEqual({
      "x-request-id": "req_1",
      "x-amzn-bedrock-input-token-count": "120",
      "openai-processing-ms": "321",
      "content-type": "application/json",
    });
  });
});

describe("errors (settled detail 7)", () => {
  it("sends the raw name and code, never the message", () => {
    const abort = Object.assign(new Error("user went away"), { name: "AbortError" });
    expect(telemetryError(abort)).toEqual({ name: "AbortError" });
    const network = new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) });
    expect(telemetryError(network)).toEqual({ name: "TypeError", code: "ECONNRESET" });
    expect(JSON.stringify(telemetryError(network))).not.toContain("fetch failed");
  });
});

describe("stream chunk caps", () => {
  it("keeps every chunk up to 200", () => {
    const collector = new ChunkCollector();
    for (let index = 0; index < 200; index++) collector.push(index);
    expect(collector.count).toBe(200);
    expect(collector.chunks()).toEqual(Array.from({ length: 200 }, (_, index) => index));
  });

  it("keeps the first 20 and the last 50 beyond 200, with the real count", () => {
    const collector = new ChunkCollector();
    for (let index = 0; index < 1000; index++) collector.push(index);
    expect(collector.count).toBe(1000);
    expect(collector.chunks()).toEqual([
      ...Array.from({ length: 20 }, (_, index) => index),
      ...Array.from({ length: 50 }, (_, index) => 950 + index),
    ]);
    const justOver = new ChunkCollector();
    for (let index = 0; index < 201; index++) justOver.push(index);
    expect(justOver.chunks()).toEqual([
      ...Array.from({ length: 20 }, (_, index) => index),
      ...Array.from({ length: 50 }, (_, index) => 151 + index),
    ]);
  });
});

describe("stream parsing (framing only)", () => {
  const parse = (format: "sse" | "ndjson" | "json-array", parts: string[]) => {
    const records: unknown[] = [];
    const parser = new TextStreamParser(format, (record) => records.push(record));
    for (const part of parts) parser.push(part);
    parser.end();
    return records;
  };

  it("reads SSE data events split across reads, joins multi-line data and skips [DONE]", () => {
    expect(parse("sse", [
      'event: message_start\ndata: {"type":"mess',
      'age_start"}\n\n: comment\n\ndata: {"a":\ndata: 1}\n\n',
      "data: not json\n\ndata: [DONE]\n\n",
    ])).toEqual([{ type: "message_start" }, { a: 1 }, "not json"]);
  });

  it("reads NDJSON lines and a JSON array stream", () => {
    expect(parse("ndjson", ['{"done":false}\n{"do', 'ne":true,"eval_count":3}\n'])).toEqual([
      { done: false },
      { done: true, eval_count: 3 },
    ]);
    expect(parse("json-array", ['[{"a":1}\n,', '\r\n{"a":2}]'])).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
