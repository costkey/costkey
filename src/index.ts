import type {
  CostKeyOptions,
  EventContext,
  BeforeSendHook,
  ProviderExtractor,
} from "./types.js";
import { parseDSN } from "./dsn.js";
import { patchFetch, unpatchFetch } from "./fetch-patch.js";
import { Transport } from "./transport.js";
import { withContext, getCurrentContext, startTrace, getCurrentTraceId } from "./context.js";
import { registerExtractor } from "./providers/registry.js";

export type { CostKeyOptions, EventContext, BeforeSendHook, ProviderExtractor };
export { Provider } from "./types.js";
export type {
  CostKeyEvent,
  NormalizedUsage,
  CallSite,
  StreamTiming,
} from "./types.js";

let transport: Transport | null = null;
let initialized = false;

/**
 * Initialize CostKey. Call this once at app startup.
 *
 * @example
 * ```ts
 * import { CostKey } from 'costkey'
 *
 * CostKey.init({
 *   dsn: 'https://ck_abc123@costkey.dev/my-project'
 * })
 *
 * // That's it. Every AI call is now tracked.
 * ```
 */
function init(options: CostKeyOptions): void {
  if (initialized) {
    if (options.debug) {
      console.warn("[costkey] Already initialized, skipping");
    }
    return;
  }

  // Support COSTKEY_DSN env var as fallback
  const dsnString = options.dsn || (typeof process !== "undefined" ? process.env?.["COSTKEY_DSN"] : undefined);

  // Test mode: if no DSN is provided (or explicitly set to empty), silently no-op
  if (!dsnString) {
    initialized = true;
    return;
  }

  const dsn = parseDSN(dsnString);

  transport = new Transport({
    endpoint: dsn.endpoint,
    authKey: dsn.authKey,
    maxBatchSize: options.maxBatchSize ?? 50,
    flushInterval: options.flushInterval ?? 5000,
    debug: options.debug ?? false,
    release: options.release,
  });

  patchFetch({
    transport,
    projectId: dsn.projectId,
    captureBody: options.captureBody ?? true,
    beforeSend: options.beforeSend ?? null,
    defaultContext: options.defaultContext ?? {},
    debug: options.debug ?? false,
  });

  transport.start();
  initialized = true;

  if (options.debug) {
    console.log(`[costkey] Initialized for project ${dsn.projectId}`);
  }
}

/** Alias for init — familiar to MLflow users */
const autolog = init;

/**
 * Flush all pending events and shut down the SDK.
 * Call this before process exit to ensure all events are sent.
 */
async function shutdown(): Promise<void> {
  if (transport) {
    await transport.flush();
    transport.stop();
    transport = null;
  }
  unpatchFetch();
  initialized = false;
}

/** Flush all pending events without shutting down. */
async function flush(): Promise<void> {
  if (transport) {
    await transport.flush();
  }
}

export const CostKey = {
  init,
  autolog,
  shutdown,
  flush,
  withContext,
  startTrace,
  getCurrentContext,
  getCurrentTraceId,
  registerExtractor,
} as const;

// Default export for convenience
export default CostKey;
