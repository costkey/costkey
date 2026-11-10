import type { EventContext } from "./types.js";
import { STREAM_CONTENT_KEY, isCaptureActive, isContentCaptureActive, recordObservedCall } from "./fetch-patch.js";
import { captureCallSite } from "./stack.js";
import { withoutPadding } from "./eventstream.js";
import { getCallContext, withContext } from "./context.js";
import {
  StreamRecorder,
  TELEMETRY_VERSION,
  decodeBytesField,
  requestBodySkeleton,
  round,
  sanitizeTelemetryUrl,
  skeleton,
  telemetryError,
  telemetryRequestHeaders,
  telemetryResponseHeaders,
  type CallTelemetry,
  type TelemetryRequest,
  type TelemetryResponse,
} from "./telemetry.js";

/**
 * AWS SDK v3 (`@aws-sdk/client-bedrock-runtime`) sends requests through
 * Node's http module, not fetch, so the fetch patch never sees them. This
 * helper adds middleware to a BedrockRuntimeClient instead and records the
 * same raw telemetry as the fetch path: the serialized request, the response
 * status and headers (including x-amzn-bedrock-*-token-count), and the
 * deserialized output as a skeleton. ConverseStream /
 * InvokeModelWithResponseStream event streams are passed through and their
 * events recorded as chunks; with content capture on, every event's payload
 * is also sent whole as `responseBody: {"__costkey_stream__": [...]}`. No AWS
 * SDK import is needed; the client is duck-typed.
 */

type Handler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type HandlerContext = Record<string | symbol, unknown>;
type Middleware = (next: Handler, context: HandlerContext) => Handler;

/** Structural subset of an AWS SDK v3 client. */
export interface BedrockClientLike {
  middlewareStack: {
    add(middleware: Middleware, options: Record<string, unknown>): unknown;
  };
}

type Operation = "converse" | "converse-stream" | "invoke" | "invoke-with-response-stream";

interface CallerState {
  callSite: ReturnType<typeof captureCallSite>;
  context: EventContext;
}

const CALLER = Symbol("costkey.bedrock.caller");
const COMMAND_OPERATIONS: Record<string, Operation> = {
  ConverseCommand: "converse",
  ConverseStreamCommand: "converse-stream",
  InvokeModelCommand: "invoke",
  InvokeModelWithResponseStreamCommand: "invoke-with-response-stream",
};
const instrumented = new WeakSet<object>();

/**
 * Record every Converse, ConverseStream, InvokeModel and
 * InvokeModelWithResponseStream call a BedrockRuntimeClient makes. Returns
 * the same client; calling it twice is a no-op.
 */
export function instrumentBedrockClient<T>(client: T): T {
  try {
    if (!client || typeof client !== "object" || instrumented.has(client)) return client;
    const stack = (client as Partial<BedrockClientLike>).middlewareStack;
    if (!stack || typeof stack.add !== "function") return client;
    // Runs synchronously inside client.send(), so the caller's frames are
    // still on the stack.
    stack.add(captureCaller, {
      step: "initialize",
      priority: "high",
      name: "costkeyBedrockCaller",
      override: true,
    });
    // Outside the SDK's deserializer: sees the parsed output and the raw
    // response, once per attempt (retries run in finalizeRequest, above).
    stack.add(recordBedrockCall, {
      step: "deserialize",
      priority: "high",
      name: "costkeyBedrockUsage",
      override: true,
    });
    instrumented.add(client);
  } catch {
    // Instrumentation never breaks the client.
  }
  return client;
}

const captureCaller: Middleware = (next, handlerContext) => (args) => {
  try {
    if (isCaptureActive()) {
      handlerContext[CALLER] = { callSite: captureCallSite(), context: getCallContext() } satisfies CallerState;
    }
  } catch {
    // Call-site capture is best effort.
  }
  return next(args);
};

const recordBedrockCall: Middleware = (next, handlerContext) => async (args) => {
  let operation: Operation | null = null;
  let caller: CallerState | undefined;
  try {
    operation = bedrockOperation(args["request"], handlerContext["commandName"]);
    caller = handlerContext[CALLER] as CallerState | undefined;
  } catch {
    operation = null;
  }
  const context = caller?.context ?? getCallContext();
  if (!operation || !isCaptureActive() || isManualCapture(context)) return next(args);

  const startTime = performance.now();
  const startedAt = new Date().toISOString();
  let url: URL;
  let request: TelemetryRequest;
  try {
    const http = asRecord(args["request"]);
    url = requestUrl(http, asRecord(args["input"]), operation);
    const body = requestBodySkeleton(http?.["body"] ?? null);
    request = {
      method: typeof http?.["method"] === "string" ? (http["method"] as string).toUpperCase() : "POST",
      url: sanitizeTelemetryUrl(url),
      headers: telemetryRequestHeaders(http?.["headers"]),
      body: body.body,
      bytes: body.bytes,
    };
  } catch {
    return next(args);
  }
  const report = (
    response: TelemetryResponse | null,
    stream: CallTelemetry["stream"],
    error: unknown,
    responseContent?: unknown,
  ): void => {
    const durationMs = round(performance.now() - startTime);
    recordObservedCall({
      telemetry: {
        v: TELEMETRY_VERSION,
        request,
        response,
        stream,
        error: telemetryError(error),
        startedAt,
        durationMs,
      },
      url,
      method: request.method,
      callSite: caller?.callSite ?? null,
      context,
      ...(responseContent === undefined ? {} : { responseContent }),
    });
  };

  let result: Record<string, unknown>;
  try {
    // A client configured with a fetch-based handler must not also be
    // recorded by the fetch patch.
    result = await withContext({ costkeyCapture: "manual" }, () => next(args));
  } catch (error) {
    try {
      const status = errorStatus(error);
      report(
        status === null && !errorHeaders(error)
          ? null
          : { status, headers: telemetryResponseHeaders(errorHeaders(error)), body: null, bytes: null },
        null,
        error,
      );
    } catch {
      // Recording never replaces the provider error.
    }
    throw error;
  }

  try {
    const response = asRecord(result["response"]);
    const output = asRecord(result["output"]);
    const responseBase = {
      status: asNumber(response?.["statusCode"])
        ?? asNumber(asRecord(output?.["$metadata"])?.["httpStatusCode"]),
      headers: telemetryResponseHeaders(response?.["headers"]),
    };
    const streamKey = operation === "converse-stream" ? "stream"
      : operation === "invoke-with-response-stream" ? "body"
      : null;

    if (streamKey) {
      const source = output?.[streamKey];
      if (output && isAsyncIterable(source)) {
        const recorder = new StreamRecorder("aws-eventstream", startTime);
        const content: unknown[] | null = isContentCaptureActive() ? [] : null;
        output[streamKey] = observeStream(source, recorder, content, (error) => {
          report(
            { ...responseBase, body: null, bytes: null },
            recorder.telemetry(),
            error,
            content ? { [STREAM_CONTENT_KEY]: content } : undefined,
          );
        });
      } else {
        report({ ...responseBase, body: null, bytes: null }, null, null);
      }
    } else {
      report({ ...responseBase, body: outputSkeleton(output), bytes: null }, null, null);
    }
  } catch {
    // The caller always gets the SDK's result.
  }
  return result;
};

/**
 * The deserialized output without `$metadata`. InvokeModel's `body` is the
 * model's own JSON as bytes; it is decoded (framing) before the skeleton.
 */
function outputSkeleton(output: Record<string, unknown> | null): unknown {
  if (!output) return null;
  const { $metadata: _metadata, ...rest } = output;
  const body = rest["body"];
  if (body instanceof Uint8Array) {
    const decoded = decodeBytesField({ bytes: body }) as Record<string, unknown>;
    if (!(decoded["bytes"] instanceof Uint8Array)) return skeleton({ ...rest, body: decoded["bytes"] });
  }
  return skeleton(rest);
}

/**
 * Pass every stream event through unchanged and record it as a chunk (and,
 * with content capture on, its payload whole); report once when the caller
 * finishes, stops early or the stream fails.
 */
async function* observeStream(
  source: AsyncIterable<unknown>,
  recorder: StreamRecorder,
  content: unknown[] | null,
  onEnd: (error: unknown) => void,
): AsyncGenerator<unknown, void, undefined> {
  let failure: unknown = null;
  try {
    for await (const event of source) {
      try {
        recorder.arrived();
        const chunk = streamEventChunk(event);
        recorder.record(chunk);
        if (content) content.push(streamEventContent(chunk));
      } catch {
        // Skip an event that can't be read.
      }
      yield event;
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      onEnd(failure);
    } catch {
      // Never surface a recording failure to the caller.
    }
  }
}

/**
 * SDK stream events are already keyed by event type (`{ contentBlockDelta }`,
 * `{ metadata }`, `{ chunk: { bytes } }`), the same `{"<event-type>": payload}`
 * shape as the fetch path. A `bytes` payload is decoded to its JSON.
 */
function streamEventChunk(event: unknown): unknown {
  const record = asRecord(event);
  if (!record) return event;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) result[key] = decodeBytesField(value);
  return result;
}

/**
 * Content capture: the SDK stream event keyed by event type, the same element
 * the fetch path sends (`{"contentBlockDelta": {...}}`, `{"chunk": {"bytes": <JSON>}}`),
 * without undefined members or the `p` padding field.
 */
function streamEventContent(chunk: unknown): unknown {
  const record = asRecord(chunk);
  if (!record) return chunk;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) result[key] = withoutPadding(value);
  }
  return result;
}

function bedrockOperation(request: unknown, commandName: unknown): Operation | null {
  const path = asRecord(request)?.["path"];
  if (typeof path === "string") {
    const match = path.match(/\/(converse-stream|converse|invoke-with-response-stream|invoke)\/?$/);
    if (match) return match[1] as Operation;
  }
  return typeof commandName === "string" ? COMMAND_OPERATIONS[commandName] ?? null : null;
}

function requestUrl(http: Record<string, unknown> | null, input: Record<string, unknown> | null, operation: Operation): URL {
  if (http && typeof http["hostname"] === "string" && typeof http["path"] === "string") {
    const protocol = typeof http["protocol"] === "string" && http["protocol"]
      ? http["protocol"].replace(/:?$/, ":")
      : "https:";
    const port = typeof http["port"] === "number" ? `:${http["port"]}` : "";
    try {
      const url = new URL(`${protocol}//${http["hostname"]}${port}${http["path"]}`);
      const query = asRecord(http["query"]);
      if (query) {
        for (const [name, value] of Object.entries(query)) {
          if (typeof value === "string") url.searchParams.append(name, value);
          else if (Array.isArray(value)) for (const item of value) url.searchParams.append(name, String(item));
        }
      }
      return url;
    } catch {
      // Fall through to a synthetic Bedrock URL.
    }
  }
  const modelId = typeof input?.["modelId"] === "string" ? input["modelId"] : "unknown";
  return new URL(`https://bedrock-runtime.amazonaws.com/model/${encodeURIComponent(modelId)}/${operation}`);
}

function errorHeaders(error: unknown): unknown {
  return asRecord(asRecord(error)?.["$response"])?.["headers"] ?? null;
}

function errorStatus(error: unknown): number | null {
  const record = asRecord(error);
  return asNumber(asRecord(record?.["$metadata"])?.["httpStatusCode"])
    ?? asNumber(asRecord(record?.["$response"])?.["statusCode"]);
}

function isManualCapture(context: EventContext): boolean {
  return ["manual", "explicit", "disabled"].includes(String(context.costkeyCapture));
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === "function";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
