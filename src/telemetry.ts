/**
 * Raw telemetry contract v1 (packages/shared/RAW_TELEMETRY.md).
 *
 * The SDK only sends what happened. The transformations here are the three
 * the contract allows: content removal (the skeleton), secret removal (URL
 * query and header filtering) and size caps. Nothing here prices, normalizes,
 * counts tokens, infers models or providers, dedupes or classifies.
 */

export const TELEMETRY_VERSION = 1;

/** Exact key match: strings under these keys are kept verbatim (at most 200 characters). */
export const KEEP_STRING_KEYS: ReadonlySet<string> = new Set([
  "model", "model_id", "modelId", "modelVersion", "id", "object", "type", "status", "finish_reason",
  "stop_reason", "finishReason", "service_tier", "system_fingerprint", "responseId", "request_id",
  "requestId", "search_depth", "topic", "output_format", "response_format", "encoding", "language",
  "language_code", "voice_id", "size", "quality", "style", "mode", "operation", "event", "provider",
  "modality", "tier", "currency", "unit", "job_id", "jobId", "trafficType", "created", "created_at",
  "speech_model", "response_id",
]);

/** A container (object or array) at this depth becomes `{"$trunc": true}`. The root is depth 0. */
export const MAX_SKELETON_DEPTH = 12;
export const MAX_ARRAY_ITEMS = 32;
export const ARRAY_HEAD_ITEMS = 8;
export const MAX_KEPT_STRING_CHARS = 200;
export const MAX_SKELETON_BYTES = 64 * 1024;

export const MAX_STREAM_CHUNKS = 200;
export const STREAM_HEAD_CHUNKS = 20;
export const STREAM_TAIL_CHUNKS = 50;

export type StreamFormat = "sse" | "ndjson" | "json-array" | "aws-eventstream";

export interface TelemetryRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  bytes: number | null;
}

export interface TelemetryResponse {
  status: number | null;
  headers: Record<string, string>;
  body: unknown;
  bytes: number | null;
}

export interface TelemetryStream {
  format: StreamFormat;
  chunks: unknown[];
  chunkCount: number;
  firstChunkMs: number | null;
  lastChunkMs: number | null;
}

export interface TelemetryError {
  name: string;
  code?: string | number;
}

export interface CallTelemetry {
  v: 1;
  /** Set by integrations whose calls never cross this process's transport (contract detail 8). */
  source?: string;
  request: TelemetryRequest | null;
  response: TelemetryResponse | null;
  stream: TelemetryStream | null;
  error: TelemetryError | null;
  startedAt: string;
  durationMs: number | null;
}

export interface SkeletonOptions {
  /**
   * Also keep a string when the last dot-separated segment of its key is an
   * allowlisted key (`gen_ai.request.model` → `model`). Only used for
   * framework span attributes; provider payloads use exact key matching.
   */
  leafKeys?: boolean;
}

// ── Skeleton ──

/** Length in Unicode code points (not UTF-16 units). */
export function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    // A high surrogate followed by a low surrogate is one code point.
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    count++;
  }
  return count;
}

function keepsString(key: string | undefined, options: SkeletonOptions | undefined): boolean {
  if (key === undefined) return false;
  if (KEEP_STRING_KEYS.has(key)) return true;
  if (options?.leafKeys) {
    const dot = key.lastIndexOf(".");
    if (dot >= 0 && KEEP_STRING_KEYS.has(key.slice(dot + 1))) return true;
  }
  return false;
}

function stringSkeleton(value: string, key: string | undefined, options?: SkeletonOptions): unknown {
  const length = codePointLength(value);
  if (keepsString(key, options) && length <= MAX_KEPT_STRING_CHARS) return value;
  return { $s: length };
}

function binaryLength(value: unknown): number | null {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  return null;
}

/**
 * Replace every string by its length (unless its key is allowlisted), keep
 * numbers, booleans and null, cap arrays and depth. The result is then held
 * under the 64 KB size cap.
 */
export function skeleton(value: unknown, key?: string, options?: SkeletonOptions): unknown {
  return capSkeleton(walk(value, key, 0, new Set<object>(), options));
}

function walk(
  value: unknown,
  key: string | undefined,
  depth: number,
  ancestors: Set<object>,
  options: SkeletonOptions | undefined,
): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
      return stringSkeleton(value, key, options);
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "bigint":
      return Number(value);
    case "function":
    case "symbol":
      return null;
    default:
      break;
  }
  const bytes = binaryLength(value);
  if (bytes !== null) return { $bytes: bytes };
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : stringSkeleton(value.toISOString(), key, options);
  }
  const object = value as object;
  if (depth >= MAX_SKELETON_DEPTH || ancestors.has(object)) return { $trunc: true };
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      if (object.length <= MAX_ARRAY_ITEMS) {
        return object.map((item) => walk(item, undefined, depth + 1, ancestors, options));
      }
      const head = object
        .slice(0, ARRAY_HEAD_ITEMS)
        .map((item) => walk(item, undefined, depth + 1, ancestors, options));
      head.push({ $more: object.length - ARRAY_HEAD_ITEMS });
      return head;
    }
    const toJSON = (object as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      let serialized: unknown;
      try {
        serialized = toJSON.call(object);
      } catch {
        return { $trunc: true };
      }
      if (serialized !== object) return walk(serialized, key, depth, ancestors, options);
    }
    const result: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(object)) {
      // JSON semantics: undefined, functions and symbols are dropped.
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
      result[entryKey] = walk(entry, entryKey, depth + 1, ancestors, options);
    }
    return result;
  } finally {
    ancestors.delete(object);
  }
}

const MARKER_KEYS = new Set(["$trunc", "$s", "$more", "$bytes"]);

function isMarker(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && MARKER_KEYS.has(keys[0]!);
}

function serializedBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

function deepestContainer(value: unknown, depth: number): number {
  if (!value || typeof value !== "object" || isMarker(value)) return -1;
  let deepest = depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) deepest = Math.max(deepest, deepestContainer(child, depth + 1));
  return deepest;
}

function truncateAtDepth(value: unknown, target: number, depth: number): unknown {
  if (!value || typeof value !== "object" || isMarker(value)) return value;
  if (depth === target) return { $trunc: true };
  if (Array.isArray(value)) return value.map((item) => truncateAtDepth(item, target, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) result[key] = truncateAtDepth(child, target, depth + 1);
  return result;
}

/**
 * Size cap: while the serialized skeleton exceeds 64 KB, replace every
 * container at the current deepest level with `{"$trunc": true}`.
 */
export function capSkeleton(value: unknown, maxBytes = MAX_SKELETON_BYTES): unknown {
  let current = value;
  while (serializedBytes(current) > maxBytes) {
    const deepest = deepestContainer(current, 0);
    if (deepest < 0) return { $trunc: true };
    current = truncateAtDepth(current, deepest, 0);
  }
  return current;
}

// ── Bodies ──

export interface BodySkeleton {
  body: unknown;
  bytes: number | null;
}

/**
 * The skeleton of a request body as it was handed to fetch: JSON text is
 * parsed first, other text is a root string, FormData is `$multipart`, and
 * binary is `$bytes`.
 */
export function requestBodySkeleton(body: unknown): BodySkeleton {
  if (body === null || body === undefined) return { body: null, bytes: null };
  if (typeof body === "string") return textBodySkeleton(body, Buffer.byteLength(body, "utf8"));
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    const text = body.toString();
    return { body: skeleton(text), bytes: Buffer.byteLength(text, "utf8") };
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return { body: multipartSkeleton(body), bytes: null };
  }
  const bytes = binaryLength(body);
  if (bytes !== null) return { body: { $bytes: bytes }, bytes };
  // A ReadableStream or other iterable body can't be read without consuming it.
  return { body: { $bytes: null }, bytes: null };
}

/** Text of a response or request body: JSON is parsed, anything else is a root string. */
export function textBodySkeleton(text: string, bytes: number | null): BodySkeleton {
  if (text.length === 0) return { body: null, bytes };
  const parsed = parseJson(text);
  return { body: skeleton(parsed === NOT_JSON ? text : parsed), bytes };
}

const NOT_JSON = Symbol("not-json");

function parseJson(text: string): unknown {
  const trimmed = text.trimStart();
  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== '"' && !/^(?:-?\d|true|false|null)/.test(trimmed)) return NOT_JSON;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

export function multipartSkeleton(form: FormData): { $multipart: unknown[] } {
  const parts: unknown[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      parts.push({ name, value: walk(value, name, 1, new Set(), undefined) });
    } else {
      const file = value as Blob & { name?: string };
      parts.push({
        name,
        filename: typeof file.name === "string" ? { $s: codePointLength(file.name) } : null,
        contentType: typeof file.type === "string" && file.type ? file.type : null,
        bytes: typeof file.size === "number" ? file.size : null,
      });
    }
  }
  return capSkeleton({ $multipart: parts }) as { $multipart: unknown[] };
}

// ── URL and headers ──

const DROPPED_QUERY_EXACT = new Set([
  "key", "api_key", "apikey", "api-key", "token", "access_token", "sig", "signature", "code",
]);

function dropsQueryParameter(name: string): boolean {
  const lower = name.toLowerCase();
  return DROPPED_QUERY_EXACT.has(lower) || lower.startsWith("auth") || lower.startsWith("x-amz-");
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/**
 * Strip userinfo and the fragment, and drop secret-bearing query parameters
 * while keeping the rest (Deepgram's `model=`, Gemini's `alt=sse`).
 */
export function sanitizeTelemetryUrl(input: URL | string): string {
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input : input.href);
  } catch {
    return "";
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const kept = query
    .split("&")
    .filter((part) => part.length > 0)
    .filter((part) => !dropsQueryParameter(decodeComponent(part.split("=")[0] ?? "")));
  url.search = kept.length > 0 ? `?${kept.join("&")}` : "";
  return url.href;
}

/** The legacy top-level `url`: no userinfo, query or fragment. */
export function stripUrlQuery(input: URL | string): string {
  try {
    const url = new URL(typeof input === "string" ? input : input.href);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

const REQUEST_HEADER_ALLOWLIST = new Set([
  "content-type", "anthropic-version", "anthropic-beta", "openai-beta", "x-goog-api-client", "x-stainless-lang",
]);

const RESPONSE_HEADER_DENYLIST = new Set([
  "set-cookie", "cookie", "authorization", "proxy-authorization", "x-api-key", "api-key",
]);

type HeaderSource = Headers | Array<[string, string]> | Record<string, unknown> | null | undefined;

function headerEntries(headers: HeaderSource | unknown): Array<[string, string]> {
  if (!headers) return [];
  if (typeof Headers !== "undefined" && headers instanceof Headers) return [...headers.entries()];
  if (Array.isArray(headers)) {
    return headers
      .filter((entry): entry is [string, unknown] => Array.isArray(entry) && typeof entry[0] === "string")
      .map(([name, value]) => [name, String(value)]);
  }
  if (typeof headers === "object") {
    const entries: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      entries.push([name, Array.isArray(value) ? value.map(String).join(", ") : String(value)]);
    }
    return entries;
  }
  return [];
}

/** Request headers: only the allowlist, keys lowercased. */
export function telemetryRequestHeaders(...sources: unknown[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of headerEntries(source)) {
      const lower = name.toLowerCase();
      if (REQUEST_HEADER_ALLOWLIST.has(lower)) result[lower] = value;
    }
  }
  return result;
}

export function keepsResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (RESPONSE_HEADER_DENYLIST.has(lower)) return false;
  if (lower.includes("token") && !lower.includes("count")) return false;
  return true;
}

/** Response headers: everything except the denylist, keys lowercased. */
export function telemetryResponseHeaders(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headerEntries(headers)) {
    const lower = name.toLowerCase();
    if (keepsResponseHeader(lower)) result[lower] = value;
  }
  return result;
}

// ── Errors ──

/** The raw error name and code; never the message. */
export function telemetryError(error: unknown): TelemetryError | null {
  if (error === null || error === undefined) return null;
  if (typeof error !== "object") return { name: typeof error };
  const record = error as { name?: unknown; code?: unknown; cause?: unknown; constructor?: { name?: unknown } };
  const name = typeof record.name === "string" && record.name
    ? record.name
    : typeof record.constructor?.name === "string" && record.constructor.name
      ? record.constructor.name
      : "Error";
  const cause = record.cause && typeof record.cause === "object" ? record.cause as { code?: unknown } : null;
  const code = typeof record.code === "string" || typeof record.code === "number"
    ? record.code
    : typeof cause?.code === "string" || typeof cause?.code === "number"
      ? cause.code
      : undefined;
  return code === undefined ? { name } : { name, code };
}

/** The raw JS error name for spans and lifecycle events (contract detail 7). */
export function rawErrorName(error: unknown): string | undefined {
  return telemetryError(error)?.name;
}

// ── Streams ──

/** Holds every chunk up to 200; beyond that the first 20 and the last 50. */
export class ChunkCollector {
  private readonly head: unknown[] = [];
  private tail: unknown[] = [];
  count = 0;

  push(chunk: unknown): void {
    this.count++;
    if (this.count <= MAX_STREAM_CHUNKS) {
      this.head.push(chunk);
      return;
    }
    if (this.count === MAX_STREAM_CHUNKS + 1) {
      this.tail = this.head.splice(STREAM_HEAD_CHUNKS).slice(-(STREAM_TAIL_CHUNKS - 1));
    }
    this.tail.push(chunk);
    if (this.tail.length > STREAM_TAIL_CHUNKS) this.tail.shift();
  }

  chunks(): unknown[] {
    return [...this.head, ...this.tail];
  }
}

/**
 * A stream record that parsed as JSON, with its SSE `event:` name when it had
 * one. Content capture keeps these (and only these) whole.
 */
export type StreamContentHandler = (record: unknown, event: string | null) => void;

/** Incremental parser of a text stream into its JSON records. */
export class TextStreamParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventName: string | null = null;
  private jsonText = "";
  private jsonOverflow = false;
  private static readonly MAX_JSON_ARRAY_CHARS = 8 * 1024 * 1024;

  constructor(
    readonly format: Exclude<StreamFormat, "aws-eventstream">,
    private readonly onRecord: (record: unknown) => void,
    /** Content capture: every JSON record, uncapped (the 8 MB JSON-array cap is lifted). */
    private readonly onContent: StreamContentHandler | null = null,
  ) {}

  push(text: string): void {
    if (this.format === "json-array") {
      if (this.jsonOverflow) return;
      if (!this.onContent && this.jsonText.length + text.length > TextStreamParser.MAX_JSON_ARRAY_CHARS) {
        this.jsonOverflow = true;
        this.jsonText = "";
        return;
      }
      this.jsonText += text;
      return;
    }
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  end(): void {
    if (this.format === "json-array") {
      const parsed = parseJson(this.jsonText);
      this.jsonText = "";
      if (parsed === NOT_JSON) return;
      if (Array.isArray(parsed)) {
        for (const item of parsed) this.emit(item, null);
      } else {
        this.emit(parsed, null);
      }
      return;
    }
    if (this.buffer.length > 0) {
      const rest = this.buffer.replace(/\r$/, "");
      this.buffer = "";
      this.line(rest);
    }
    if (this.format === "sse") this.dispatch();
  }

  private line(line: string): void {
    if (this.format === "ndjson") {
      if (line.trim().length === 0) return;
      const parsed = parseJson(line);
      if (parsed === NOT_JSON) this.onRecord(line);
      else this.emit(parsed, null);
      return;
    }
    // SSE: data lines accumulate until a blank line ends the event.
    if (line.length === 0) {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      this.dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    } else if (line.startsWith("event:")) {
      const value = line.slice(6);
      this.eventName = value.startsWith(" ") ? value.slice(1) : value;
    }
  }

  private dispatch(): void {
    const eventName = this.eventName;
    this.eventName = null;
    if (this.dataLines.length === 0) return;
    const data = this.dataLines.join("\n");
    this.dataLines = [];
    // `[DONE]` is the SSE terminator (framing), not a record.
    if (data.trim() === "[DONE]" || data.length === 0) return;
    const parsed = parseJson(data);
    if (parsed === NOT_JSON) this.onRecord(data);
    else this.emit(parsed, eventName || null);
  }

  private emit(record: unknown, event: string | null): void {
    this.onRecord(record);
    if (this.onContent) this.onContent(record, event);
  }
}

/** Decode a base64 `bytes` field holding JSON (Bedrock invoke streams); framing only. */
export function decodeBytesField(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const bytes = record["bytes"];
  let text: string | null = null;
  if (typeof bytes === "string") {
    try {
      text = Buffer.from(bytes, "base64").toString("utf8");
    } catch {
      text = null;
    }
  } else if (bytes instanceof Uint8Array) {
    text = new TextDecoder().decode(bytes);
  }
  if (text === null) return payload;
  const parsed = parseJson(text);
  if (parsed === NOT_JSON) return payload;
  return { ...record, bytes: parsed };
}

/** Collects a stream's records as skeletons, with timing measured against the request start. */
export class StreamRecorder {
  readonly collector = new ChunkCollector();
  firstChunkMs: number | null = null;
  lastChunkMs: number | null = null;

  constructor(readonly format: StreamFormat, private readonly startTime: number) {}

  /** A network read arrived (timing only). */
  arrived(now = performance.now()): void {
    const elapsed = round(now - this.startTime);
    if (this.firstChunkMs === null) this.firstChunkMs = elapsed;
    this.lastChunkMs = elapsed;
  }

  record(chunk: unknown): void {
    this.collector.push(skeleton(chunk));
  }

  telemetry(): TelemetryStream {
    return {
      format: this.format,
      chunks: this.collector.chunks(),
      chunkCount: this.collector.count,
      firstChunkMs: this.firstChunkMs,
      lastChunkMs: this.lastChunkMs,
    };
  }
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}
