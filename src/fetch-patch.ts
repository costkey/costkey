import type {
  BeforeSendHook,
  CallSite,
  CostKeyEvent,
  EventContext,
  PolicyAdmissionResult,
  PolicySettlementRequest,
} from "./types.js";
import { findCaptureTarget, injectStreamUsage, type CaptureTarget } from "./providers/registry.js";
import { captureCallSite } from "./stack.js";
import { EventStreamDecoder, eventStreamChunk, eventStreamContent } from "./eventstream.js";
import { getCallContext, importContext } from "./context.js";
import { Transport } from "./transport.js";
import { randomBytes } from "node:crypto";
import type { PolicyAdmissionClient } from "./policy.js";
import {
  StreamRecorder,
  TELEMETRY_VERSION,
  TextStreamParser,
  requestBodySkeleton,
  round,
  sanitizeTelemetryUrl,
  stripUrlQuery,
  telemetryError,
  telemetryRequestHeaders,
  telemetryResponseHeaders,
  textBodySkeleton,
  type CallTelemetry,
  type StreamFormat,
  type TelemetryRequest,
  type TelemetryResponse,
} from "./telemetry.js";

const TRACE_HEADER = "x-costkey-trace-id";
/** Captured streamed responses: `{"__costkey_stream__": [every event, in order]}`. */
export const STREAM_CONTENT_KEY = "__costkey_stream__";
const TRACE_NAME_HEADER = "x-costkey-trace-name";
const CONTEXT_HEADER = "x-costkey-context";

export interface FetchPatchOptions {
  transport: Transport;
  projectId: string;
  captureBody: boolean;
  beforeSend: BeforeSendHook | null;
  defaultContext: EventContext;
  debug: boolean;
  policy?: PolicyAdmissionClient | null;
  captureBodyRef?: { current: boolean };
}

let originalFetch: typeof globalThis.fetch | null = null;
let isPatched = false;
// Calls observed outside fetch (AWS SDK middleware, integrations) report through the same pipeline.
let activeOptions: FetchPatchOptions | null = null;
const pendingCaptures = new Set<Promise<void>>();
const pendingPolicySettlements = new Set<Promise<void>>();

/**
 * Monkey-patch globalThis.fetch to observe AI provider calls. Requests to
 * other hosts pass through after a hostname check.
 */
export function patchFetch(options: FetchPatchOptions): void {
  if (isPatched) return;
  if (typeof globalThis.fetch !== "function") {
    if (options.debug) {
      console.warn("[costkey] globalThis.fetch not available, skipping patch");
    }
    return;
  }

  originalFetch = globalThis.fetch;
  isPatched = true;
  activeOptions = options;

  globalThis.fetch = async function costKeyFetchWrapper(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    let url: URL;
    try {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      url = new URL(urlStr);
    } catch {
      return originalFetch!(input, init);
    }

    // Fast path: not a captured host.
    const target = findCaptureTarget(url);
    if (!target) {
      // Non-AI requests pass through untouched. Context propagation is an
      // explicit caller decision via CostKey.exportContext()/headers.
      return originalFetch!(input, init);
    }

    // Capture the stack before the first await, while the caller's frames exist.
    const callSite = captureCallSite();
    const context = { ...options.defaultContext, ...getCallContext() };

    // An explicit trusted handoff may arrive as a carrier or the legacy trace
    // headers. Never manufacture a trace from stack frames.
    const inputRequest =
      typeof Request !== "undefined" && input instanceof Request ? input : null;
    const incomingContext = getHeader(init?.headers, CONTEXT_HEADER)
      ?? getHeader(inputRequest?.headers, CONTEXT_HEADER);
    if (incomingContext) {
      const imported = importContext(incomingContext);
      for (const [key, value] of Object.entries(imported)) {
        if (context[key] === undefined) context[key] = value;
      }
    }
    if (!context.traceId) {
      const incomingTraceId = getHeader(init?.headers, TRACE_HEADER)
        ?? getHeader(inputRequest?.headers, TRACE_HEADER);
      if (incomingTraceId) {
        context.traceId = incomingTraceId;
        const incomingName = getHeader(init?.headers, TRACE_NAME_HEADER)
          ?? getHeader(inputRequest?.headers, TRACE_NAME_HEADER);
        if (incomingName) context.traceName = incomingName;
      }
    }

    // An explicit adapter (Bedrock middleware, manual recordUsage) owns this
    // request: keep its behavior and record nothing here.
    if (isManualCapture(context)) {
      return originalFetch!(
        removeContextHeadersFromRequest(input),
        removeContextHeaders(init),
      );
    }

    const startTime = performance.now();
    const startedAt = new Date().toISOString();
    let modifiedInit = removeContextHeaders(init);
    const forwardedInput = removeContextHeadersFromRequest(input);

    // The request body as it will be sent; `stream_options.include_usage` is
    // the one change the SDK makes to a request.
    let sentBody: unknown = init?.body ?? null;
    let parsedRequest: unknown = null;
    if (typeof sentBody === "string") {
      try {
        parsedRequest = JSON.parse(sentBody);
      } catch {
        parsedRequest = null;
      }
      if (parsedRequest !== null) {
        const injected = injectStreamUsage(target, parsedRequest);
        if (injected !== parsedRequest) {
          parsedRequest = injected;
          sentBody = JSON.stringify(injected);
          modifiedInit = { ...modifiedInit, body: sentBody as string };
        }
      }
    }

    const method = (
      init?.method
      ?? inputRequest?.method
      ?? (init?.body != null ? "POST" : "GET")
    ).toUpperCase();
    const requestSkeleton = requestBodySkeleton(sentBody);
    const request: TelemetryRequest = {
      method,
      url: sanitizeTelemetryUrl(url),
      headers: telemetryRequestHeaders(inputRequest?.headers, init?.headers),
      body: requestSkeleton.body,
      bytes: requestSkeleton.bytes,
    };
    const isStreaming = isStreamingRequest(url, parsedRequest);
    const captureBody = shouldCaptureBody(options);
    const contentRequestBody = captureBody
      ? parsedRequest ?? formFields(sentBody) ?? (typeof sentBody === "string" ? sentBody : null)
      : null;

    // Each observed request gets its own event and admission identity. An
    // explicit attempt label groups retries but never becomes the event id.
    const eventId = generateId();
    const retryAttemptId =
      typeof context.attemptId === "string" && context.attemptId.trim()
        ? context.attemptId.trim()
        : undefined;
    const base: CallBase = {
      eventId,
      retryAttemptId,
      url,
      method,
      startedAt,
      startTime,
      callSite,
      context,
      request,
      captureBody,
      contentRequestBody,
    };

    let admission: PolicyAdmissionResult | null = null;
    if (options.policy) {
      admission = await options.policy.admit({
        projectId: options.projectId,
        admissionId: eventId,
        requestId: eventId,
        traceId: context.traceId,
        executionId: context.executionId,
        context: policyContext(context),
        telemetry: { v: TELEMETRY_VERSION, request },
      });
    }

    let response: Response;
    try {
      response = await originalFetch!(forwardedInput, modifiedInit);
    } catch (err) {
      // The request never produced a response (network, DNS, abort).
      const event = buildCallEvent(base, options.projectId, {
        response: null,
        stream: null,
        error: telemetryError(err),
        durationMs: performance.now() - startTime,
        contentResponseBody: null,
      });
      if (options.policy && admission?.reservationId) {
        trackPolicySettlement(settlePolicy(options.policy, admission, options.projectId, eventId, "unknown", true));
      }
      await sendEvent(event, options, captureBody);
      throw err; // Never swallow the caller's error.
    }

    const responseBase = {
      status: response.status,
      headers: telemetryResponseHeaders(response.headers),
    };
    const mode = responseMode(response, isStreaming);

    if (mode.kind === "full" || mode.kind === "empty") {
      trackPendingCapture(recordFullResponse(
        mode.kind === "full" ? response.clone() : null,
        responseBase,
        base,
        admission,
        options,
      ));
      return response;
    }

    if (mode.kind === "binary") {
      const length = contentLength(response.headers);
      if (length !== null || !response.body) {
        // The size is known without reading audio or image bytes the caller streams.
        trackPendingCapture(finishCall(base, admission, options, {
          response: { ...responseBase, body: { $bytes: length }, bytes: length },
          stream: null,
          error: null,
          durationMs: performance.now() - startTime,
          contentResponseBody: null,
          completed: true,
        }));
        return response;
      }
      return observeBody(response, null, base, responseBase, admission, options);
    }

    return observeBody(response, mode.format, base, responseBase, admission, options);
  };
}

// ── Response handling ──

interface CallBase {
  eventId: string;
  retryAttemptId?: string;
  url: URL | null;
  method: string;
  startedAt: string;
  startTime: number;
  callSite: CallSite | null;
  context: EventContext;
  request: TelemetryRequest | null;
  captureBody: boolean;
  contentRequestBody: unknown;
}

interface CallResult {
  response: TelemetryResponse | null;
  stream: CallTelemetry["stream"];
  error: CallTelemetry["error"];
  durationMs: number;
  contentResponseBody: unknown;
}

type ResponseMode =
  | { kind: "empty" }
  | { kind: "full" }
  | { kind: "binary" }
  | { kind: "stream"; format: StreamFormat };

/**
 * How to observe a response without disturbing the caller: JSON and text are
 * read from a clone, streams are read as they pass through, and binary bodies
 * (audio, images) are never buffered.
 */
function responseMode(response: Response, isStreaming: boolean): ResponseMode {
  if (!response.body) return { kind: "empty" };
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/vnd.amazon.eventstream")) return { kind: "stream", format: "aws-eventstream" };
  if (contentType.includes("text/event-stream")) return { kind: "stream", format: "sse" };
  if (contentType.includes("ndjson")) return { kind: "stream", format: "ndjson" };
  const textual = contentType === "" || contentType.includes("json") || contentType.startsWith("text/");
  if (!textual) return { kind: "binary" };
  if (isStreaming) return { kind: "stream", format: contentType.includes("json") ? "json-array" : "sse" };
  return { kind: "full" };
}

async function recordFullResponse(
  clone: Response | null,
  responseBase: { status: number; headers: Record<string, string> },
  base: CallBase,
  admission: PolicyAdmissionResult | null,
  options: FetchPatchOptions,
): Promise<void> {
  let body: unknown = null;
  let bytes: number | null = clone ? null : 0;
  let contentResponseBody: unknown = null;
  let error: CallTelemetry["error"] = null;
  if (clone) {
    try {
      const buffer = new Uint8Array(await clone.arrayBuffer());
      const text = new TextDecoder().decode(buffer);
      const skeleton = textBodySkeleton(text, buffer.byteLength);
      body = skeleton.body;
      bytes = skeleton.bytes;
      if (base.captureBody && text.length > 0) {
        try {
          contentResponseBody = JSON.parse(text) as unknown;
        } catch {
          contentResponseBody = text;
        }
      }
    } catch (readError) {
      error = telemetryError(readError);
    }
  }
  await finishCall(base, admission, options, {
    response: { ...responseBase, body, bytes },
    stream: null,
    error,
    durationMs: performance.now() - base.startTime,
    contentResponseBody,
    completed: error === null,
  });
}

/**
 * Pass the body through unchanged while recording it: stream records as
 * skeletons (with timing), or only the byte count for an unsized binary body.
 * With content capture on, every JSON event of a stream is also kept whole,
 * in order, and sent as `responseBody: {"__costkey_stream__": [...]}`.
 * The call is recorded once, when the body ends, fails or is cancelled.
 */
function observeBody(
  response: Response,
  format: StreamFormat | null,
  base: CallBase,
  responseBase: { status: number; headers: Record<string, string> },
  admission: PolicyAdmissionResult | null,
  options: FetchPatchOptions,
): Response {
  const body = response.body!;
  const reader = body.getReader();
  const recorder = format ? new StreamRecorder(format, base.startTime) : null;
  const eventDecoder = format === "aws-eventstream" ? new EventStreamDecoder() : null;
  const textDecoder = new TextDecoder();
  // Content capture: SSE events with an `event:` name become {event, data}.
  const content: unknown[] | null = recorder && base.captureBody ? [] : null;
  const parser = recorder && format && format !== "aws-eventstream"
    ? new TextStreamParser(
      format,
      (record) => recorder.record(record),
      content ? (record, event) => content.push(event ? { event, data: record } : record) : null,
    )
    : null;
  let bytes = 0;
  let recorded = false;

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  trackPendingCapture(done);

  const record = async (completed: boolean, error: unknown): Promise<void> => {
    if (recorded) return;
    recorded = true;
    try {
      try {
        if (parser) {
          parser.push(textDecoder.decode());
          parser.end();
        }
      } catch {
        // A malformed tail never blocks recording what was seen.
      }
      await finishCall(base, admission, options, {
        response: {
          ...responseBase,
          body: recorder ? null : { $bytes: bytes },
          bytes,
        },
        stream: recorder ? recorder.telemetry() : null,
        error: telemetryError(error),
        durationMs: performance.now() - base.startTime,
        contentResponseBody: content ? { [STREAM_CONTENT_KEY]: content } : null,
        completed,
      });
    } catch {
      // Telemetry never errors the caller's stream.
    } finally {
      resolveDone();
    }
  };

  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: finished, value } = await reader.read();
        if (finished) {
          controller.close();
          await record(true, null);
          return;
        }
        // Pass the bytes on first: no buffering delay for the caller.
        controller.enqueue(value);
        try {
          bytes += value.byteLength;
          if (recorder) {
            recorder.arrived();
            if (eventDecoder) {
              for (const message of eventDecoder.push(value)) {
                recorder.record(eventStreamChunk(message));
                if (content) {
                  const element = eventStreamContent(message);
                  if (element !== undefined) content.push(element);
                }
              }
            } else if (parser) {
              parser.push(textDecoder.decode(value, { stream: true }));
            }
          }
        } catch {
          // Recording never interrupts the caller's stream.
        }
      } catch (err) {
        controller.error(err);
        await record(false, err);
      }
    },
    cancel(reason) {
      void reader.cancel(reason)
        .catch(() => undefined)
        .then(() => record(false, reason));
    },
  });

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function finishCall(
  base: CallBase,
  admission: PolicyAdmissionResult | null,
  options: FetchPatchOptions,
  result: CallResult & { completed: boolean },
): Promise<void> {
  const event = buildCallEvent(base, options.projectId, result);
  if (options.policy && admission?.reservationId) {
    const status = result.response?.status ?? 0;
    const outcome = result.completed && status >= 200 && status < 300 ? "success" : "unknown";
    trackPolicySettlement(settlePolicy(options.policy, admission, options.projectId, base.eventId, outcome, true));
  }
  await sendEvent(event, options, base.captureBody);
}

function contentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value);
}

/** String fields of a FormData body (content capture only); files are skipped. */
function formFields(body: unknown): Record<string, string> | null {
  if (typeof FormData === "undefined" || !(body instanceof FormData)) return null;
  const fields: Record<string, string> = {};
  for (const [key, value] of body.entries()) {
    if (typeof value === "string") fields[key] = value;
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

/** Restore the original fetch. Used for cleanup/testing. */
export function unpatchFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
    isPatched = false;
  }
  activeOptions = null;
}

/** Wait for response processing already started by fetch(). */
export async function flushPendingCaptures(): Promise<void> {
  await drain(pendingCaptures);
}

/** Wait for policy reservations settled by completed provider calls. */
export async function flushPendingPolicy(): Promise<void> {
  await drain(pendingPolicySettlements);
}

async function drain(set: Set<Promise<void>>): Promise<void> {
  const pending = [...set];
  if (pending.length === 0) return;
  const all = Promise.allSettled(pending);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve();
        }, 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (timedOut) {
    for (const promise of pending) set.delete(promise);
  }
}

function trackPendingCapture(pending: Promise<void>): void {
  pendingCaptures.add(pending);
  void pending.finally(() => pendingCaptures.delete(pending));
}

// ── Calls observed outside fetch ──

/** A provider call seen by another integration (AWS SDK middleware, Claude Agent SDK). */
export interface ObservedCall {
  telemetry: CallTelemetry;
  /** The provider URL when there is one; empty for calls made in another process. */
  url?: URL | null;
  method?: string;
  callSite: CallSite | null;
  /** Context captured when the call was made; default context is added here. */
  context: EventContext;
  /** Content, only sent when body capture is on. */
  requestContent?: unknown;
  responseContent?: unknown;
}

/** Whether the SDK is initialized with a DSN and can record calls. */
export function isCaptureActive(): boolean {
  return isPatched && activeOptions !== null;
}

/** Whether content capture (requestBody/responseBody) is on right now. */
export function isContentCaptureActive(): boolean {
  return activeOptions !== null && isPatched && shouldCaptureBody(activeOptions);
}

/** Record a call observed outside fetch through the same event pipeline. */
export function recordObservedCall(observed: ObservedCall): void {
  const options = activeOptions;
  if (!options) return;
  const pending = (async () => {
    try {
      const context = { ...options.defaultContext, ...observed.context };
      const captureBody = shouldCaptureBody(options);
      const telemetry = observed.telemetry;
      const base: CallBase = {
        eventId: generateId(),
        retryAttemptId:
          typeof context.attemptId === "string" && context.attemptId.trim()
            ? context.attemptId.trim()
            : undefined,
        url: observed.url ?? null,
        method: observed.method ?? telemetry.request?.method ?? "",
        startedAt: telemetry.startedAt,
        startTime: performance.now(),
        callSite: observed.callSite,
        context,
        request: telemetry.request,
        captureBody,
        contentRequestBody: captureBody ? observed.requestContent ?? null : null,
      };
      const event = buildCallEvent(base, options.projectId, {
        response: telemetry.response,
        stream: telemetry.stream,
        error: telemetry.error,
        durationMs: telemetry.durationMs ?? 0,
        contentResponseBody: captureBody ? observed.responseContent ?? null : null,
      }, telemetry.source);
      await sendEvent(event, options, captureBody);
    } catch {
      // Never crash the caller.
    }
  })();
  trackPendingCapture(pending);
}

// ── Policy ──

async function settlePolicy(
  policy: PolicyAdmissionClient,
  admission: PolicyAdmissionResult,
  projectId: string,
  admissionId: string,
  outcome: PolicySettlementRequest["outcome"],
  providerAttempted: boolean,
): Promise<void> {
  if (!admission.reservationId) return;
  // Actual usage is derived on the server from the call event with this ID.
  const request: PolicySettlementRequest = {
    projectId,
    reservationId: admission.reservationId,
    settlementId: `${admissionId}:settlement`,
    outcome,
    providerAttempted,
  };
  try {
    await policy.settle(request);
  } catch {
    // Settlement is best effort after the provider result; ask the server to
    // retain the reservation for reconciliation.
    if (outcome !== "unknown") {
      try {
        await policy.settle({ ...request, outcome: "unknown" });
      } catch {
        // Settlement remains durably unknown until a later retry.
      }
    }
  }
}

function trackPolicySettlement(pending: Promise<void>): void {
  pendingPolicySettlements.add(pending);
  void pending.finally(() => pendingPolicySettlements.delete(pending));
}

function policyContext(context: EventContext): EventContext {
  const safe: EventContext = {};
  for (const key of POLICY_CONTEXT_KEYS) {
    const value = context[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

const POLICY_CONTEXT_KEYS: Array<keyof EventContext> = [
  "traceId",
  "traceName",
  "groupId",
  "groupName",
  "groupKind",
  "executionId",
  "feature",
  "customer",
  "customerId",
  "environment",
  "service",
  "release",
  "function",
  "operation",
  "phase",
  "caseId",
  "datasetRevision",
  "conversationId",
  "voiceSessionId",
];

/**
 * Whether to read the response as a stream: declared in the body for
 * OpenAI-style APIs and in the URL for Gemini (:streamGenerateContent,
 * alt=sse) and Bedrock (*-stream). This only chooses how the body is read.
 */
export function isStreamingRequest(url: URL, requestBody: unknown): boolean {
  if (requestBody && typeof requestBody === "object" && (requestBody as Record<string, unknown>)["stream"] === true) {
    return true;
  }
  const path = url.pathname;
  if (/:(streamGenerateContent|streamRawPredict)$/.test(path) || url.searchParams.get("alt") === "sse") return true;
  if (/\/(invoke-with-response-stream|converse-stream)$/.test(path)) return true;
  return false;
}

// ── Event building ──

function shouldCaptureBody(options: FetchPatchOptions): boolean {
  return options.captureBodyRef?.current ?? options.captureBody;
}

function contextString(context: EventContext, key: string): string | null {
  const value = context[key];
  return typeof value === "string" ? value : null;
}

function buildCallEvent(
  base: CallBase,
  projectId: string,
  result: CallResult,
  source?: string,
): CostKeyEvent {
  const telemetry: CallTelemetry = {
    v: TELEMETRY_VERSION,
    ...(source ? { source } : {}),
    request: base.request,
    response: result.response,
    stream: result.stream,
    error: result.error,
    startedAt: base.startedAt,
    durationMs: round(result.durationMs),
  };
  const parentEventId = contextString(base.context, "parentEventId");
  return {
    id: base.eventId,
    eventType: "call",
    source: "auto",
    timestamp: base.startedAt,
    projectId,
    url: base.url ? stripUrlQuery(base.url) : "",
    method: base.method,
    statusCode: result.response?.status ?? null,
    durationMs: round(result.durationMs),
    streaming: result.stream !== null,
    callSite: base.callSite,
    context: base.context,
    attemptId: base.retryAttemptId ?? base.eventId,
    spanId: contextString(base.context, "spanId"),
    parentEventId: parentEventId?.trim() ? parentEventId.trim() : null,
    groupId: contextString(base.context, "groupId"),
    groupName: contextString(base.context, "groupName"),
    groupKind: contextString(base.context, "groupKind"),
    executionId: contextString(base.context, "executionId"),
    phase: contextString(base.context, "phase"),
    datasetRevision: contextString(base.context, "datasetRevision"),
    caseId: contextString(base.context, "caseId"),
    requestBody: base.captureBody && base.contentRequestBody != null
      ? captureContent(base.contentRequestBody)
      : null,
    responseBody: base.captureBody && result.contentResponseBody != null
      ? captureContent(result.contentResponseBody)
      : null,
    telemetry,
  };
}

/**
 * Opt-in content capture (requestBody/responseBody): credentials scrubbed and
 * media bytes omitted. Text is never truncated; the transport splits large
 * events across POSTs instead.
 */
const BINARY_VALUE_KEYS = new Set([
  "b64_json", "base64", "base64_data", "image_data", "inline_data", "bytes",
]);
const IMAGE_DATA_URI = /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?,/i;

function captureContent(body: unknown): unknown {
  return sanitizeCapturedValue(scrubCredentials(body));
}

function sanitizeCapturedValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    const image = value.match(IMAGE_DATA_URI);
    if (image) {
      const comma = value.indexOf(",");
      const encodedBytes = Math.max(0, value.length - comma - 1);
      const approxBytes = Math.floor(encodedBytes * 3 / 4);
      return `[image data omitted: ${image[1]}; ~${approxBytes} bytes]`;
    }

    if (key && BINARY_VALUE_KEYS.has(key.toLowerCase()) && value.length > 256) {
      return `[binary data omitted: ${value.length} chars]`;
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCapturedValue(item, key));
  }

  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const mimeType = typeof objectValue["media_type"] === "string"
      ? objectValue["media_type"]
      : typeof objectValue["mimeType"] === "string"
      ? objectValue["mimeType"]
      : typeof objectValue["mime_type"] === "string"
        ? objectValue["mime_type"]
        : null;
    const imagePayload = (mimeType?.toLowerCase().startsWith("image/") ?? false)
      || objectValue["type"] === "image"
      || objectValue["type"] === "input_image"
      || objectValue["type"] === "base64";
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (imagePayload && entryKey.toLowerCase() === "data" && typeof entryValue === "string") {
        const encodedBytes = entryValue.length;
        result[entryKey] = `[image data omitted: ${mimeType ?? "image/*"}; ~${Math.floor(encodedBytes * 3 / 4)} bytes]`;
      } else {
        result[entryKey] = sanitizeCapturedValue(entryValue, entryKey);
      }
    }
    return result;
  }

  return value;
}

async function sendEvent(
  event: CostKeyEvent,
  options: FetchPatchOptions,
  captureBody = shouldCaptureBody(options),
): Promise<void> {
  try {
    let finalEvent: CostKeyEvent | null = event;

    if (options.beforeSend) {
      try {
        finalEvent = await options.beforeSend(event);
      } catch {
        if (options.debug) {
          console.warn("[costkey] beforeSend hook failed; dropping event");
        }
        return; // Drop the event if beforeSend throws
      }
    }

    if (finalEvent && !captureBody) {
      // A user hook may mutate an event after it was built. Re-assert the
      // request-time privacy decision at the final wire boundary.
      finalEvent = {
        ...finalEvent,
        requestBody: null,
        responseBody: null,
      };
    }

    if (finalEvent && isPatched) {
      options.transport.enqueue(finalEvent);
    }
  } catch {
    // Never crash. Ever.
  }
}

/**
 * Built-in credential scrubber for captured content: removes values that look
 * like API keys, tokens or secrets.
 */
function scrubCredentials(body: unknown): unknown {
  const SECRET_PATTERNS = [
    /^sk-[a-zA-Z0-9]{20,}$/,           // OpenAI keys
    /^sk-ant-[a-zA-Z0-9-]{20,}$/,      // Anthropic keys
    /^AIza[a-zA-Z0-9_-]{30,}$/,        // Google API keys
    /^Bearer\s+.{20,}$/,               // Bearer tokens
    /^xox[bpras]-[a-zA-Z0-9-]{20,}$/,  // Slack tokens
    /^ghp_[a-zA-Z0-9]{30,}$/,          // GitHub tokens
    /^eyJ[a-zA-Z0-9_-]{20,}/,          // JWTs
  ];

  const SECRET_KEYS = new Set([
    "api_key", "apikey", "api-key",
    "secret", "secret_key", "secretkey",
    "token", "access_token", "refresh_token",
    "password", "passwd", "credential",
    "authorization", "auth",
    "private_key", "privatekey",
  ]);

  function scrub(obj: unknown): unknown {
    if (obj == null) return obj;
    if (typeof obj === "string") {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(obj)) return "[REDACTED]";
      }
      return obj;
    }
    if (Array.isArray(obj)) return obj.map(scrub);
    if (typeof obj === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        result[key] = SECRET_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : scrub(value);
      }
      return result;
    }
    return obj;
  }

  return scrub(body);
}

/** Generate a random event ID */
function generateId(): string {
  return randomBytes(16).toString("hex");
}

function isManualCapture(context: EventContext): boolean {
  return ["manual", "explicit", "disabled"].includes(String(context.costkeyCapture));
}

/** Remove CostKey's explicit carrier headers before calling a provider. */
function removeContextHeaders(init: RequestInit | undefined): RequestInit | undefined {
  if (!init?.headers) return init;
  const headers = new Headers(init.headers);
  let changed = false;
  for (const name of [CONTEXT_HEADER, TRACE_HEADER, TRACE_NAME_HEADER]) {
    if (headers.has(name)) {
      headers.delete(name);
      changed = true;
    }
  }
  return changed ? { ...init, headers } : init;
}

function removeContextHeadersFromRequest(
  input: string | URL | Request,
): string | URL | Request {
  if (
    typeof Request === "undefined" ||
    !(input instanceof Request)
  ) {
    return input;
  }
  const headers = new Headers(input.headers);
  let changed = false;
  for (const name of [CONTEXT_HEADER, TRACE_HEADER, TRACE_NAME_HEADER]) {
    if (headers.has(name)) {
      headers.delete(name);
      changed = true;
    }
  }
  if (!changed) return input;
  try {
    return new Request(input, { headers });
  } catch {
    return input;
  }
}

/** Read a header value from various header formats */
function getHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;

  if (headers instanceof Headers) {
    return headers.get(name);
  }

  if (Array.isArray(headers)) {
    const entry = headers.find(([k]) => String(k).toLowerCase() === name.toLowerCase());
    return entry ? entry[1] : null;
  }

  if (typeof headers === "object") {
    const h = headers as Record<string, string>;
    for (const [k, v] of Object.entries(h)) {
      if (k.toLowerCase() === name.toLowerCase()) return v;
    }
  }

  return null;
}

export type { CaptureTarget };
