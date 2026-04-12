import type { CostKeyEvent, TransportPayload } from "./types.js";
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
}

const MAX_QUEUE_SIZE = 500;
const MAX_RETRIES = 10;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Batched, async, non-blocking transport with retry + backoff.
 * Queues events in memory and flushes them periodically or when the batch is full.
 * On network failure, events stay in the queue and retry with exponential backoff.
 * Never throws into user code. Never blocks the event loop.
 */
export class Transport {
  private queue: CostKeyEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private backoffUntil = 0;
  private hasConfirmedConnection = false;

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
  enqueue(event: CostKeyEvent): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
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

  /** Flush all queued events. Best-effort with retry. Never throws. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    // Respect backoff
    if (Date.now() < this.backoffUntil) {
      if (this.options.debug) {
        const waitSec = Math.round((this.backoffUntil - Date.now()) / 1000);
        console.warn(`[costkey] Backing off, retry in ${waitSec}s`);
      }
      return;
    }

    const batch = this.queue.splice(0, this.options.maxBatchSize);
    const payload: TransportPayload = {
      sdkVersion: SDK_VERSION,
      release: this.options.release,
      events: batch,
    };

    try {
      const response = await fetch(this.options.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.authKey}`,
          "User-Agent": `costkey-sdk/${SDK_VERSION}`,
        },
        body: JSON.stringify(payload),
      });

      if (response.status === 429) {
        // Rate limited — put events back and let the interval retry
        this.queue.unshift(...batch);
        this.applyBackoff();
        if (this.options.debug) {
          console.warn("[costkey] Rate limited, will retry");
        }
        return;
      }

      if (response.status === 401 || response.status === 403) {
        // Auth failures always log — developer needs to know their DSN is wrong
        console.warn(
          `[costkey] Authentication failed (${response.status}). Check your DSN at https://app.costkey.dev/settings`,
        );
        return;
      }

      if (!response.ok) {
        // Server error — put events back and retry
        if (response.status >= 500) {
          this.queue.unshift(...batch);
          this.applyBackoff();
          if (this.options.debug) {
            console.warn(`[costkey] Server error ${response.status}, will retry (${this.consecutiveFailures} failures)`);
          }
          return;
        }

        // Client error (4xx except 429) — drop events, they won't succeed on retry
        if (this.options.debug) {
          console.warn(`[costkey] Ingest returned ${response.status}: ${response.statusText}`);
        }
      }

      // Success — reset backoff
      this.consecutiveFailures = 0;
      this.backoffUntil = 0;

      // One-time connection confirmation on first successful delivery
      if (response.ok && !this.hasConfirmedConnection) {
        this.hasConfirmedConnection = true;
        console.log("[costkey] Connected. Tracking AI calls.");
      }
    } catch {
      // Network error — put events back and retry with backoff
      this.queue.unshift(...batch);
      this.applyBackoff();

      if (this.options.debug) {
        console.warn(`[costkey] Network error, ${this.queue.length} events queued, retry in ${this.getBackoffMs()}ms`);
      }
    }
  }

  private applyBackoff(): void {
    this.consecutiveFailures++;
    const backoffMs = this.getBackoffMs();
    this.backoffUntil = Date.now() + backoffMs;

    // After too many failures, start dropping old events to prevent unbounded growth
    if (this.consecutiveFailures > MAX_RETRIES && this.queue.length > MAX_QUEUE_SIZE / 2) {
      const dropCount = Math.floor(this.queue.length / 4);
      this.queue.splice(0, dropCount);
      if (this.options.debug) {
        console.warn(`[costkey] Too many failures, dropped ${dropCount} oldest events`);
      }
    }
  }

  private getBackoffMs(): number {
    // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 60s, 60s...
    return Math.min(BASE_BACKOFF_MS * Math.pow(2, this.consecutiveFailures - 1), MAX_BACKOFF_MS);
  }
}
