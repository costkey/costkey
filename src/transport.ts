import type { CostKeyTelemetryEvent } from "./types.js";
import type { FrameUpload } from "./frames.js";
import { SDK_VERSION } from "./version.js";

export interface TransportOptions {
  /** Ingest endpoint URL (parsed from DSN) */
  endpoint: string;
  /** Auth key (parsed from DSN) */
  authKey: string;
  /** Max events per batch */
  maxBatchSize: number;
  /** Flush interval in ms */
  flushInterval: number;
  /** Debug logging */
  debug: boolean;
  /** Release version for sourcemap translation */
  release?: string;
  /** Commit SHA and repository URL of the running code, sent with every batch */
  commit?: string;
  repository?: string;
  /**
   * Max serialized bytes per POST (default 8 MB, well under the ingest
   * limit). A single event larger than this is sent alone.
   */
  maxBatchBytes?: number;
}

/** Default byte budget for one POST body to /api/v1/events. */
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;
/** Frame bytes held for upload; the oldest are dropped past this. */
export const MAX_FRAME_QUEUE_BYTES = 32 * 1024 * 1024;
/** Hashes remembered as sent, so history images resent on every call upload once. */
export const SENT_FRAME_MEMORY = 4096;

/**
 * Batched, async, non-blocking transport.
 * Queues events in memory and flushes them periodically or when the batch is full.
 * A flush drains the queue in POSTs of at most `maxBatchSize` events and
 * `maxBatchBytes` of JSON each, so large captured bodies arrive whole.
 * Never throws into user code. Never blocks the event loop.
 */
export class Transport {
  private queue: CostKeyTelemetryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly maxQueueSize = 500;
  private hasConfirmedConnection = false;
  private inFlight: Promise<void> | null = null;
  private frameQueue: FrameUpload[] = [];
  private frameQueueBytes = 0;
  /** Hashes queued or sent this process, oldest first. */
  private readonly sentFrames = new Set<string>();
  private framesInFlight: Promise<void> | null = null;
  private framesDisabled = false;

  constructor(private readonly options: TransportOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.options.flushInterval);

    // Don't keep the process alive just for flushing
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Enqueue an event for sending. Never throws. */
  enqueue(event: CostKeyTelemetryEvent): void {
    if (this.queue.length >= this.maxQueueSize) {
      // Drop oldest to prevent OOM
      this.queue.shift();
      if (this.options.debug) {
        console.warn("[costkey] Queue full, dropping oldest event");
      }
    }

    this.queue.push(event);

    if (this.queue.length >= this.options.maxBatchSize) {
      void this.flush();
    }
  }

  /** Flush all queued events and frames. Best-effort, never throws. */
  flush(): Promise<void> {
    return Promise.all([this.flushEvents(), this.flushFrames()]).then(() => undefined);
  }

  private flushEvents(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.queue.length === 0) return Promise.resolve();
    this.inFlight = this.drain().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /**
   * Queue an image for upload, once per hash for the life of the process.
   * Never throws; the oldest frames are dropped when the queue is full.
   */
  enqueueFrame(frame: FrameUpload): void {
    if (this.framesDisabled || this.sentFrames.has(frame.sha256)) return;
    this.rememberFrame(frame.sha256);
    this.frameQueue.push(frame);
    this.frameQueueBytes += frame.bytes.length;
    while (this.frameQueueBytes > MAX_FRAME_QUEUE_BYTES && this.frameQueue.length > 1) {
      const dropped = this.frameQueue.shift()!;
      this.frameQueueBytes -= dropped.bytes.length;
      // Not sent: a later call that resends this image can queue it again.
      this.sentFrames.delete(dropped.sha256);
      if (this.options.debug) console.warn("[costkey] Frame queue full, dropping oldest frame");
    }
    void this.flushFrames();
  }

  private rememberFrame(sha256: string): void {
    this.sentFrames.add(sha256);
    while (this.sentFrames.size > SENT_FRAME_MEMORY) {
      const oldest = this.sentFrames.values().next().value as string;
      this.sentFrames.delete(oldest);
    }
  }

  private flushFrames(): Promise<void> {
    if (this.framesInFlight) return this.framesInFlight;
    if (this.frameQueue.length === 0) return Promise.resolve();
    this.framesInFlight = this.drainFrames().finally(() => { this.framesInFlight = null; });
    return this.framesInFlight;
  }

  private async drainFrames(): Promise<void> {
    while (this.frameQueue.length > 0 && !this.framesDisabled) {
      const frame = this.frameQueue.shift()!;
      this.frameQueueBytes -= frame.bytes.length;
      if (!(await this.sendFrame(frame))) return;
    }
  }

  /** PUT one frame's bytes. Returns false when the rest of the queue should wait. */
  private async sendFrame(frame: FrameUpload): Promise<boolean> {
    const endpoint = framesEndpoint(this.options.endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await withoutOtelTracing(() => fetch(`${endpoint}/${frame.sha256}`, {
        method: "PUT",
        headers: {
          "Content-Type": frame.mediaType,
          Authorization: `Bearer ${this.options.authKey}`,
          "User-Agent": `costkey-sdk/${SDK_VERSION}`,
        },
        body: frame.bytes,
        signal: controller.signal,
      }));
      if (response.ok) return true;
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        // The server doesn't take frames yet: stop for this process.
        this.disableFrames(`Frame upload isn't supported by this server (${response.status})`);
        return false;
      }
      if (response.status === 401 || response.status === 403) {
        this.disableFrames(`Frame upload was refused (${response.status})`);
        return false;
      }
      if (response.status === 429) {
        // Put it back at the head; the flush interval retries.
        this.frameQueue.unshift(frame);
        this.frameQueueBytes += frame.bytes.length;
        return false;
      }
      // Any other answer drops this frame; a later call that resends it can retry.
      this.sentFrames.delete(frame.sha256);
      if (this.options.debug) console.warn(`[costkey] Frame upload returned ${response.status}`);
      return true;
    } catch (err) {
      this.sentFrames.delete(frame.sha256);
      if (this.options.debug) console.warn("[costkey] Failed to upload a frame:", err);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private disableFrames(reason: string): void {
    this.framesDisabled = true;
    this.frameQueue = [];
    this.frameQueueBytes = 0;
    if (this.options.debug) console.warn(`[costkey] ${reason}; screen capture is off for this process`);
  }

  /** Send batches until the queue is empty or delivery should wait. */
  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      if (!(await this.sendBatch())) return;
    }
  }

  /**
   * Take events from the head of the queue until the next one would pass the
   * byte or count budget. The first event is always taken, so an oversized
   * event goes alone. Events that can't be serialized are dropped.
   */
  private takeBatch(): { events: CostKeyTelemetryEvent[]; body: string } | null {
    const maxBytes = this.options.maxBatchBytes ?? MAX_BATCH_BYTES;
    const header = JSON.stringify({ sdkVersion: SDK_VERSION, release: this.options.release, commit: this.options.commit, repository: this.options.repository });
    const prefix = `${header.slice(0, -1)},"events":[`;
    const suffix = "]}";
    let bytes = utf8Bytes(prefix) + utf8Bytes(suffix);
    const events: CostKeyTelemetryEvent[] = [];
    const parts: string[] = [];
    while (this.queue.length > 0 && events.length < this.options.maxBatchSize) {
      const event = this.queue[0]!;
      let json: string | undefined;
      try {
        json = JSON.stringify(event);
      } catch {
        json = undefined;
      }
      if (json === undefined) {
        this.queue.shift();
        if (this.options.debug) console.warn("[costkey] Dropping an event that can't be serialized");
        continue;
      }
      const added = utf8Bytes(json) + (parts.length > 0 ? 1 : 0);
      if (events.length > 0 && bytes + added > maxBytes) break;
      this.queue.shift();
      events.push(event);
      parts.push(json);
      bytes += added;
    }
    if (events.length === 0) return null;
    return { events, body: `${prefix}${parts.join(",")}${suffix}` };
  }

  /** POST one batch. Returns false when the rest of the queue should wait. */
  private async sendBatch(): Promise<boolean> {
    const taken = this.takeBatch();
    if (!taken) return false;
    const { events: batch, body } = taken;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.authKey}`,
          "User-Agent": `costkey-sdk/${SDK_VERSION}`,
        };
        const packed = await gzipBody(body);
        if (packed) headers["Content-Encoding"] = "gzip";
        const response = await withoutOtelTracing(() => fetch(this.options.endpoint, {
          method: "POST",
          headers,
          body: packed ?? body,
          signal: controller.signal,
        }));

        if (response.status === 429) {
          // Rate limited — put this batch back at the head (ahead of the
          // events it was split from) and let the interval retry.
          this.queue.unshift(...batch);
          if (this.options.debug) {
            console.warn("[costkey] Rate limited, will retry");
          }
          return false;
        }

        if (response.status === 401 || response.status === 403) {
          // Auth failures always log — developer needs to know their DSN is wrong
          console.warn(
            `[costkey] Authentication failed (${response.status}). Check the DSN under Settings, Projects in your CostKey console`,
          );
          return false;
        }

        if (!response.ok && this.options.debug) {
          console.warn(
            `[costkey] Ingest returned ${response.status}: ${response.statusText}`,
          );
        }

        // One-time connection confirmation on first successful delivery
        if (response.ok && !this.hasConfirmedConnection) {
          this.hasConfirmedConnection = true;
          console.log("[costkey] Connected. Tracking AI calls.");
        }
      } finally {
        clearTimeout(timeout);
      }

      return true;
    } catch (err) {
      // Network error — fire and forget. Never crash user's app.
      if (this.options.debug) {
        console.warn("[costkey] Failed to send events:", err);
      }
      return false;
    }
  }
}

/** The frames endpoint next to the events endpoint the DSN names. */
export function framesEndpoint(eventsEndpoint: string): string {
  return `${eventsEndpoint.replace(/\/api\/v1\/events\/?$/, "")}/api/v1/frames`;
}

/** UTF-8 length of a string, without allocating (works outside Node too). */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

const OTEL_API = Symbol.for("opentelemetry.js.api.1");
const OTEL_SUPPRESS_TRACING = Symbol.for("OpenTelemetry SDK Context Key SUPPRESS_TRACING");

/**
 * Deliver telemetry with OpenTelemetry tracing suppressed, so HTTP
 * instrumentation doesn't trace CostKey's own ingest requests (which the
 * OTel bridge would then send back as spans). No-op without OTel.
 */
function withoutOtelTracing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    const api = (globalThis as Record<symbol, unknown>)[OTEL_API] as
      | { context?: { active(): { setValue(key: symbol, value: unknown): unknown }; with<R>(context: unknown, fn: () => R): R } }
      | undefined;
    const context = api?.context;
    if (!context || typeof context.with !== "function") return fn();
    return context.with(context.active().setValue(OTEL_SUPPRESS_TRACING, true), fn);
  } catch {
    return fn();
  }
}

/** Bodies past this size go gzipped; prompts compress several times over. */
export const GZIP_MIN_BYTES = 1024;

/** The body gzipped, or null where the runtime has no CompressionStream (it is then sent as is). */
export async function gzipBody(body: string): Promise<Uint8Array | null> {
  if (body.length <= GZIP_MIN_BYTES || typeof CompressionStream === "undefined" || typeof Blob === "undefined") return null;
  try {
    const stream = new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}
