import { AsyncLocalStorage } from "node:async_hooks";
import type { EventContext } from "./types.js";

const storage = new AsyncLocalStorage<EventContext>();

/**
 * Run a function with CostKey context. Any AI calls made inside
 * will be tagged with this context automatically.
 *
 * Contexts nest — inner contexts merge with outer contexts.
 *
 * @example
 * ```ts
 * await CostKey.withContext({ task: 'summarize', team: 'search' }, async () => {
 *   await openai.chat.completions.create({ ... })
 * })
 * ```
 */
export function withContext<T>(
  context: EventContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const parent = storage.getStore();
  const merged = parent ? { ...parent, ...context } : context;
  return storage.run(merged, fn);
}

/**
 * Start a trace — all AI calls within `fn` are grouped under one traceId.
 * Use this in request handlers, job runners, or any entry point.
 *
 * @example
 * ```ts
 * // Express middleware — auto-traces every request
 * app.use((req, res, next) => {
 *   CostKey.startTrace({ name: `${req.method} ${req.path}` }, next)
 * })
 *
 * // Manual trace for a background job
 * await CostKey.startTrace({ name: 'nightly-analysis' }, async () => {
 *   await analyzeData()  // any AI calls in here get traced
 * })
 * ```
 */
export function startTrace<T>(
  options: { name?: string; traceId?: string },
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const traceId = options.traceId ?? generateTraceId();
  return withContext(
    {
      traceId,
      traceName: options.name,
    },
    fn,
  );
}

/** Get the current context (from the nearest withContext scope) */
export function getCurrentContext(): EventContext {
  return storage.getStore() ?? {};
}

/** Get the current trace ID if inside a trace scope */
export function getCurrentTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
