import type {
  CostKeyEvent,
  NormalizedUsage,
  StreamTiming,
  BeforeSendHook,
  EventContext,
} from "./types.js";
import { Provider } from "./types.js";
import { findExtractor } from "./providers/registry.js";
import { captureCallSite } from "./stack.js";
import { getCurrentContext } from "./context.js";
import { Transport } from "./transport.js";
const TRACE_HEADER = "x-costkey-trace-id";
const TRACE_NAME_HEADER = "x-costkey-trace-name";

export interface FetchPatchOptions {
  transport: Transport;
  projectId: string;
  captureBody: boolean;
  beforeSend: BeforeSendHook | null;
  defaultContext: EventContext;
  debug: boolean;
}

let originalFetch: typeof globalThis.fetch | null = null;
let isPatched = false;

/**
 * Monkey-patch globalThis.fetch to intercept AI provider calls.
 * Non-AI calls pass through with zero overhead beyond a URL hostname check.
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

  globalThis.fetch = async function costKeyFetchWrapper(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    // Parse URL from whatever fetch input format we got
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
      // Can't parse URL — not our problem, pass through
      return originalFetch!(input, init);
    }

    // Fast path: not an AI provider URL
    const extractor = findExtractor(url);
    if (!extractor) {
      // Not an AI call — but if we have a traceId, propagate it via headers
      // so downstream microservices can join the same trace
      const ctx = getCurrentContext();
      if (ctx.traceId) {
        const headers = new Headers(init?.headers);
        headers.set(TRACE_HEADER, ctx.traceId);
        if (ctx.traceName) headers.set(TRACE_NAME_HEADER, ctx.traceName);
        return originalFetch!(input, { ...init, headers });
      }
      return originalFetch!(input, init);
    }

    // ── AI call detected ──

    // Capture stack trace BEFORE the async call (otherwise we lose the caller's frames)
    const callSite = captureCallSite();
    const context = { ...options.defaultContext, ...getCurrentContext() };

    // Auto-generate traceId if none exists in context
    // Hash the parent frames of the stack trace — calls from the same
    // request handler get the same hash = same trace
    if (!context.traceId && callSite) {
      context.traceId = generateTraceIdFromStack(callSite.frames);
    }

    // Check if an incoming trace header was set by an upstream service
    // (this happens when Service A calls Service B and both have CostKey)
    if (!context.traceId && init?.headers) {
      const incomingTraceId = getHeader(init.headers, TRACE_HEADER);
      if (incomingTraceId) {
        context.traceId = incomingTraceId;
        const incomingName = getHeader(init.headers, TRACE_NAME_HEADER);
        if (incomingName) context.traceName = incomingName;
      }
    }

    const startTime = performance.now();

    // Parse and potentially modify the request body
    let requestBody: unknown = null;
    let modifiedInit = init;

    if (init?.body) {
      try {
        requestBody = JSON.parse(init.body as string);

        // Inject stream_options for providers that need it (OpenAI)
        if (extractor.injectStreamOptions) {
          const modified = extractor.injectStreamOptions(requestBody);
          if (modified !== requestBody) {
            modifiedInit = {
              ...init,
              body: JSON.stringify(modified),
            };
          }
        }
      } catch {
        // Body isn't JSON or can't be parsed — that's fine
      }
    }

    const isStreaming =
      requestBody != null &&
      typeof requestBody === "object" &&
      (requestBody as Record<string, unknown>)["stream"] === true;

    // Make the actual fetch call
    let response: Response;
    try {
      response = await originalFetch!(input, modifiedInit ?? init);
    } catch (err) {
      // Fetch itself failed (network error, DNS, etc.)
      // Still try to record the failed call
      const durationMs = performance.now() - startTime;
      const event = buildEvent({
        projectId: options.projectId,
        extractor,
        url,
        method: init?.method ?? "POST",
        statusCode: null,
        requestBody: options.captureBody ? requestBody : null,
        responseBody: null,
        usage: null,
        model: extractor.extractModel(requestBody, null),
        durationMs,
        streaming: isStreaming,
        streamTiming: null,
        callSite,
        context,
      });
      await sendEvent(event, options);
      throw err; // Re-throw — we never swallow user-facing errors
    }

    // For non-streaming responses: clone, read body, extract usage
    if (!isStreaming) {
      void processNonStreamingResponse(
        response.clone(),
        {
          startTime,
          url,
          method: init?.method ?? "POST",
          statusCode: response.status,
          requestBody,
          callSite,
          context,
          extractor,
        },
        options,
      );
      return response;
    }

    // For streaming responses: wrap the body to capture timing + final usage
    return processStreamingResponse(response, {
      startTime,
      url,
      method: init?.method ?? "POST",
      requestBody,
      callSite,
      context,
      extractor,
      options,
    });
  };
}

/** Restore the original fetch. Used for cleanup/testing. */
export function unpatchFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
    isPatched = false;
  }
}

// ── Non-streaming response processing ──

interface ResponseMeta {
  startTime: number;
  url: URL;
  method: string;
  statusCode: number;
  requestBody: unknown;
  callSite: ReturnType<typeof captureCallSite>;
  context: EventContext;
  extractor: ReturnType<typeof findExtractor> & {};
}

async function processNonStreamingResponse(
  clonedResponse: Response,
  meta: ResponseMeta,
  options: FetchPatchOptions,
): Promise<void> {
  try {
    const durationMs = performance.now() - meta.startTime;
    let responseBody: unknown = null;

    try {
      responseBody = await clonedResponse.json();
    } catch {
      // Response isn't JSON — still record the call, just without usage
    }

    const usage = responseBody
      ? meta.extractor.extractUsage(responseBody)
      : null;
    const model = meta.extractor.extractModel(meta.requestBody, responseBody);

    const event = buildEvent({
      projectId: options.projectId,
      extractor: meta.extractor,
      url: meta.url,
      method: meta.method,
      statusCode: meta.statusCode,
      requestBody: options.captureBody ? meta.requestBody : null,
      responseBody: options.captureBody ? responseBody : null,
      usage,
      model,
      durationMs,
      streaming: false,
      streamTiming: null,
      callSite: meta.callSite,
      context: meta.context,
    });

    await sendEvent(event, options);
  } catch {
    // Never crash user's app. Silently fail.
  }
}

// ── Streaming response processing ──

interface StreamMeta {
  startTime: number;
  url: URL;
  method: string;
  requestBody: unknown;
  callSite: ReturnType<typeof captureCallSite>;
  context: EventContext;
  extractor: ReturnType<typeof findExtractor> & {};
  options: FetchPatchOptions;
}

function processStreamingResponse(
  response: Response,
  meta: StreamMeta,
): Response {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let firstChunkTime: number | null = null;
  let chunkCount = 0;
  let accumulatedText = "";
  let lastUsage: NormalizedUsage | null = null;

  const wrappedStream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();

          // Stream complete — build and send event
          const endTime = performance.now();
          const durationMs = endTime - meta.startTime;

          // Try to parse accumulated SSE data for usage (from the final chunks)
          if (!lastUsage) {
            lastUsage = extractUsageFromSSE(accumulatedText, meta.extractor);
          }

          const streamTiming: StreamTiming = {
            ttft: firstChunkTime
              ? firstChunkTime - meta.startTime
              : null,
            tps:
              lastUsage?.outputTokens && firstChunkTime
                ? lastUsage.outputTokens /
                  ((endTime - firstChunkTime) / 1000)
                : null,
            streamDuration: durationMs,
            chunkCount,
          };

          const model = extractModelFromSSE(
            accumulatedText,
            meta.requestBody,
            meta.extractor,
          );

          const event = buildEvent({
            projectId: meta.options.projectId,
            extractor: meta.extractor,
            url: meta.url,
            method: meta.method,
            statusCode: response.status,
            requestBody: meta.options.captureBody
              ? meta.requestBody
              : null,
            responseBody: null, // Don't capture full stream body
            usage: lastUsage,
            model,
            durationMs,
            streaming: true,
            streamTiming,
            callSite: meta.callSite,
            context: meta.context,
          });

          void sendEvent(event, meta.options);
          return;
        }

        // Pass chunk through immediately — zero buffering delay for user
        controller.enqueue(value);

        chunkCount++;
        if (firstChunkTime === null) {
          firstChunkTime = performance.now();
        }

        // Accumulate text for SSE parsing (usage extraction)
        accumulatedText += decoder.decode(value, { stream: true });
      } catch (err) {
        controller.error(err);
      }
    },

    cancel() {
      void reader.cancel();
    },
  });

  // Return a new Response with our wrapped stream but same headers/status
  return new Response(wrappedStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Try to extract usage from accumulated SSE text (looks for the last data: line with usage) */
function extractUsageFromSSE(
  sseText: string,
  extractor: ReturnType<typeof findExtractor> & {},
): NormalizedUsage | null {
  const lines = sseText.split("\n");
  // Scan from the end — usage is in the final chunks
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data);
      const usage = extractor.extractUsage(parsed);
      if (usage) return usage;
    } catch {
      // Not valid JSON, skip
    }
  }
  return null;
}

/** Try to extract model name from accumulated SSE text */
function extractModelFromSSE(
  sseText: string,
  requestBody: unknown,
  extractor: ReturnType<typeof findExtractor> & {},
): string | null {
  const lines = sseText.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data);
      const model = extractor.extractModel(requestBody, parsed);
      if (model) return model;
    } catch {
      continue;
    }
  }
  return null;
}

// ── Event building ──

interface BuildEventParams {
  projectId: string;
  extractor: ReturnType<typeof findExtractor> & {};
  url: URL;
  method: string;
  statusCode: number | null;
  requestBody: unknown;
  responseBody: unknown;
  usage: NormalizedUsage | null;
  model: string | null;
  durationMs: number;
  streaming: boolean;
  streamTiming: StreamTiming | null;
  callSite: ReturnType<typeof captureCallSite>;
  context: EventContext;
}

function buildEvent(params: BuildEventParams): CostKeyEvent {
  return {
    id: generateId(),
    timestamp: new Date().toISOString(),
    projectId: params.projectId,
    provider: params.extractor.provider,
    model: params.model,
    url: params.url.toString(),
    method: params.method,
    statusCode: params.statusCode,
    usage: params.usage,
    costUsd: null, // Server calculates cost from usage + model
    durationMs: Math.round(params.durationMs * 100) / 100,
    streaming: params.streaming,
    streamTiming: params.streamTiming,
    callSite: params.callSite,
    context: params.context,
    requestBody: params.requestBody ? scrubCredentials(params.requestBody) : null,
    responseBody: params.responseBody ? scrubCredentials(params.responseBody) : null,
  };
}

async function sendEvent(
  event: CostKeyEvent,
  options: FetchPatchOptions,
): Promise<void> {
  try {
    let finalEvent: CostKeyEvent | null = event;

    if (options.beforeSend) {
      try {
        finalEvent = await options.beforeSend(event);
      } catch (err) {
        if (options.debug) {
          console.warn("[costkey] beforeSend hook threw:", err);
        }
        return; // Drop the event if beforeSend throws
      }
    }

    if (finalEvent) {
      options.transport.enqueue(finalEvent);
    }
  } catch {
    // Never crash. Ever.
  }
}

/**
 * Built-in credential scrubber. Runs automatically on every event.
 * Removes any values that look like API keys, tokens, or secrets
 * from captured request/response bodies.
 */
function scrubCredentials(body: unknown): unknown {
  if (body == null || typeof body !== "object") return body;

  // Patterns that look like API keys/secrets
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
        if (SECRET_KEYS.has(key.toLowerCase())) {
          result[key] = "[REDACTED]";
        } else {
          result[key] = scrub(value);
        }
      }
      return result;
    }
    return obj;
  }

  return scrub(body);
}

/** Generate a random event ID */
function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Auto-generate a traceId from stack trace frames.
 *
 * Hashes the "parent frames" (everything except the leaf AI call)
 * so that multiple AI calls made from the same request handler
 * get the same traceId automatically.
 *
 * Example:
 *   Call 1: classifyIntent → handleSearch → expressRouter
 *   Call 2: summarizeDoc → processResults → handleSearch → expressRouter
 *   Shared parents: handleSearch, expressRouter
 *   → Same hash → Same traceId → Grouped as one trace
 */
function generateTraceIdFromStack(frames: Array<{ functionName: string | null; fileName: string | null; lineNumber: number | null }>): string {
  // Use parent frames (skip leaf at index 0 — that's the AI call itself)
  // Take up to 5 parent frames for the hash
  const parents = frames.slice(1, 6);

  if (parents.length === 0) {
    // No parent frames — use a random ID
    return `tr_${generateId().slice(0, 16)}`;
  }

  // Create a stable string from the parent frames
  const key = parents
    .map((f) => `${f.functionName ?? "?"}@${f.fileName ?? "?"}`)
    .join("|");

  // Simple hash → hex string
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }

  // Include a time bucket (5-second window) so traces from different
  // requests don't collide even if they have the same stack
  const timeBucket = Math.floor(Date.now() / 5000);
  const combined = `${Math.abs(hash).toString(36)}_${timeBucket.toString(36)}`;

  return `tr_auto_${combined}`;
}

/** Read a header value from various header formats */
function getHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;

  if (headers instanceof Headers) {
    return headers.get(name);
  }

  if (Array.isArray(headers)) {
    const entry = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
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
