import type {
  BeforeSendEventHook,
  BeforeSendHook,
  ContextCarrier,
  CostKeyEvent,
  CostKeyLifecycleEvent,
  CostKeyUsageEvent,
  CostKeySpanEvent,
  CostKeyAdditiveEvent,
  EventContext,
  ExecutionOptions,
  RecordUsageEvent,
  TraceOptions,
  RuntimeCaptureConfig,
  UsageAmount,
  UsageUnits,
} from "./types.js";
import { parseDSN } from "./dsn.js";
import { flushPendingCaptures, flushPendingPolicy, patchFetch, unpatchFetch } from "./fetch-patch.js";
import { Transport } from "./transport.js";
import {
  exportContext,
  exportContextHeaders,
  getCurrentContext,
  getCurrentTraceId,
  importContext,
  resetLifecycleState,
  setLifecycleEmitter,
  setSpanEmitter,
  startExecution,
  startSpan,
  startTrace,
  agent,
  step,
  tool,
  instrumentTools,
  withContext,
  type LifecycleRecord,
  type SpanRecord,
} from "./context.js";
import { addCaptureTarget, hostnameTarget, removeCaptureTarget, type CaptureTarget } from "./providers/registry.js";
import { skeleton } from "./telemetry.js";
import { randomBytes } from "node:crypto";
import { CostKeyPolicyClient, CostKeyPolicyRefused, type PolicyAdmissionClient } from "./policy.js";
import { recordLiveKitUsage, recordLiveKitSessionUsage } from "./livekit.js";
import { instrumentBedrockClient } from "./bedrock-client.js";
import { detectSource } from "./release.js";

export type {
  BeforeSendEventHook,
  CostKeyOptions,
  EventContext,
  BeforeSendHook,
  ContextCarrier,
  TraceOptions,
  ExecutionOptions,
  RecordUsageEvent,
  UsageAmount,
  UsageUnits,
  CostKeyTelemetryEvent,
  CostKeyLifecycleEvent,
  CostKeyUsageEvent,
  CostKeySpanEvent,
  CostKeyAdditiveEvent,
  SpanKind,
  SpanStatus,
  SpanOptions,
  SpanHandle,
  SpanAttributeValue,
  PolicyMode,
  PolicyRefusalReason,
  PolicyIntegrationProof,
  PolicyAdmissionRequest,
  PolicyAdmissionResult,
  PolicySettlementRequest,
  PolicyAdmissionHandler,
  PolicyOptions,
  RuntimeCaptureConfig,
} from "./types.js";
export { Provider } from "./types.js";
export { CostKeyPolicyClient, CostKeyPolicyRefused } from "./policy.js";
export type { PolicyAdmissionClient } from "./policy.js";
export type {
  CostKeyEvent,
  CallTelemetry,
  NormalizedUsage,
  CallSite,
  StackFrame,
  UsageAggregation,
  TransportPayload,
} from "./types.js";
export type {
  TelemetryRequest,
  TelemetryResponse,
  TelemetryStream,
  TelemetryError,
  StreamFormat,
} from "./telemetry.js";

let transport: Transport | null = null;
let initialized = false;
let projectId: string | null = null;
let defaultContext: EventContext = {};
let additiveBeforeSend: BeforeSendEventHook | null = null;
let policyClient: PolicyAdmissionClient | null = null;
let debugEnabled = false;
let captureBodyRef: { current: boolean } | null = null;
let localCaptureBodyDisabled = false;
let localCaptureBody = true;
let configRefreshTimer: ReturnType<typeof setInterval> | null = null;
let configRequest: Promise<void> | null = null;
let configSyncActive = false;
let configGeneration = 0;
// Custom provider hosts from the project's runtime configuration (capture filter only).
const runtimeTargets: CaptureTarget[] = [];
const additivePending = new Set<Promise<void>>();

/**
 * Initialize CostKey. Call this once at app startup.
 */
function init(options: import("./types.js").CostKeyOptions): void {
  if (initialized) {
    if (options.debug) {
      console.warn("[costkey] Already initialized, skipping");
    }
    return;
  }

  const dsnString =
    options.dsn ||
    (typeof process !== "undefined" ? process.env?.["COSTKEY_DSN"] : undefined);

  // Test mode: if no DSN is provided (or explicitly set to empty), silently no-op.
  if (!dsnString) {
    initialized = true;
    return;
  }

  const dsn = parseDSN(dsnString);
  projectId = dsn.projectId;
  defaultContext = { ...(options.defaultContext ?? {}) };
  additiveBeforeSend = options.beforeSendEvent ?? null;
  debugEnabled = options.debug ?? false;
  localCaptureBodyDisabled = options.captureBody === false;
  localCaptureBody = options.captureBody ?? true;
  // Fail closed until the DSN-authenticated runtime configuration is known.
  captureBodyRef = { current: false };
  configSyncActive = true;
  policyClient = options.policy
    ? new CostKeyPolicyClient({
        endpoint:
          options.policy.endpoint ??
          dsn.endpoint.replace(/\/api\/v1\/events\/?$/, "/api/v1/sdk/policy/admit"),
        authKey: dsn.authKey,
        policy: options.policy,
      })
    : null;

  // The deploy: the commit and repository link a release to its code in the console.
  const source = detectSource({ commit: options.commit, repository: options.repository });
  const envRelease = typeof process !== "undefined" ? process.env?.["COSTKEY_RELEASE"] : undefined;
  transport = new Transport({
    endpoint: dsn.endpoint,
    authKey: dsn.authKey,
    maxBatchSize: options.maxBatchSize ?? 50,
    flushInterval: options.flushInterval ?? 5000,
    debug: options.debug ?? false,
    release: options.release || envRelease || source.commit,
    commit: source.commit,
    repository: source.repository,
  });

  setLifecycleEmitter((record) => {
    const currentTransport = transport;
    const currentProjectId = projectId;
    if (!currentTransport || !currentProjectId) return;
    const event = buildLifecycleEvent(record, currentProjectId, defaultContext);
    trackAdditiveEvent(event, currentTransport, additiveBeforeSend, options.debug ?? false);
  });
  setSpanEmitter((record) => {
    const currentTransport = transport;
    const currentProjectId = projectId;
    if (!currentTransport || !currentProjectId) return;
    const event = buildSpanEvent(record, currentProjectId, defaultContext, captureBodyRef?.current === true);
    trackAdditiveEvent(event, currentTransport, additiveBeforeSend, options.debug ?? false);
  });

  patchFetch({
    transport,
    projectId: dsn.projectId,
    captureBody: false,
    captureBodyRef,
    beforeSend: options.beforeSend ?? null,
    defaultContext,
    debug: options.debug ?? false,
    policy: policyClient,
  });

  transport.start();
  initialized = true;

  startRuntimeConfigSync(
    dsn.endpoint,
    dsn.authKey,
    dsn.projectId,
    options.configRefreshInterval,
    options.debug ?? false,
  );

  if (options.debug) {
    console.log(`[costkey] Initialized for project ${dsn.projectId}`);
  }
}

function startRuntimeConfigSync(
  eventsEndpoint: string,
  authKey: string,
  project: string,
  refreshInterval: number | undefined,
  debug: boolean,
): void {
  stopRuntimeConfigSync();
  const generation = ++configGeneration;
  const target = eventsEndpoint.replace(/\/api\/v1\/events\/?$/, "")
    + `/api/v1/projects/${encodeURIComponent(project)}/config`;
  void refreshRuntimeConfig(target, authKey, project, debug, generation);

  const interval = Number.isFinite(refreshInterval) && (refreshInterval ?? 0) > 0
    ? refreshInterval as number
    : 60_000;
  configRefreshTimer = setInterval(() => {
    void refreshRuntimeConfig(target, authKey, project, debug, generation);
  }, interval);
  if (typeof configRefreshTimer === "object" && "unref" in configRefreshTimer) {
    configRefreshTimer.unref();
  }
}

function stopRuntimeConfigSync(): void {
  if (configRefreshTimer) {
    clearInterval(configRefreshTimer);
    configRefreshTimer = null;
  }
  configRequest = null;
}

async function refreshRuntimeConfig(
  target: string,
  authKey: string,
  project: string,
  debug: boolean,
  generation: number,
): Promise<void> {
  if (!configSyncActive || generation !== configGeneration || configRequest) return;
  const request = fetchRuntimeConfig(target, authKey, project, debug, generation);
  configRequest = request;
  try {
    await request;
  } finally {
    if (configRequest === request) configRequest = null;
  }
}

async function fetchRuntimeConfig(
  target: string,
  authKey: string,
  project: string,
  debug: boolean,
  generation: number,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
  try {
    const response = await fetch(target, {
      headers: { Authorization: `Bearer ${authKey}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`runtime config HTTP ${response.status}`);
    const config = normalizeRuntimeConfig(await response.json(), project);
    if (!config) throw new Error("runtime config response is invalid");
    if (!configSyncActive || generation !== configGeneration || projectId !== project || !captureBodyRef) return;

    // Remote metadata-only is always stronger than a local true/default. An
    // explicit local false remains the strongest opt-out when remote text is on.
    const remoteAllowsBodies =
      config.capture.mode === "text" && config.capture.bodyCaptureEnabled;
    captureBodyRef.current =
      !localCaptureBodyDisabled && localCaptureBody && remoteAllowsBodies;
    applyRuntimeProviders(config.providers ?? []);
  } catch (error) {
    if (configSyncActive && generation === configGeneration && projectId === project && captureBodyRef) {
      // A missing/revoked config fails closed for payload content but does not
      // block provider execution or discard metadata/usage observations.
      captureBodyRef.current = false;
    }
    if (debug) console.warn("[costkey] runtime capture config unavailable; using metadata-only capture");
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRuntimeConfig(
  value: unknown,
  project: string,
): RuntimeCaptureConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (object["projectId"] !== project) return null;
  const capture = object["capture"];
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) return null;
  const captureObject = capture as Record<string, unknown>;
  if (
    (captureObject["mode"] !== "metadata" && captureObject["mode"] !== "text") ||
    typeof captureObject["bodyCaptureEnabled"] !== "boolean" ||
    typeof captureObject["redactionEnabled"] !== "boolean"
  ) return null;
  const providers = object["providers"];
  return {
    projectId: project,
    capture: {
      mode: captureObject["mode"],
      bodyCaptureEnabled: captureObject["bodyCaptureEnabled"],
      redactionEnabled: captureObject["redactionEnabled"],
      ...(typeof captureObject["bodyRetentionDays"] === "number"
        ? { bodyRetentionDays: captureObject["bodyRetentionDays"] }
        : {}),
      ...(typeof captureObject["metadataRetentionDays"] === "number"
        ? { metadataRetentionDays: captureObject["metadataRetentionDays"] }
        : {}),
    },
    providers: Array.isArray(providers)
      ? providers.filter((provider): provider is Record<string, unknown> =>
          !!provider && typeof provider === "object" && !Array.isArray(provider))
      : [],
  };
}

/**
 * Custom providers configured for the project add hosts to the capture
 * filter. Extraction (usage and model paths) is server configuration.
 */
function applyRuntimeProviders(providers: Array<Record<string, unknown>>): void {
  clearRuntimeProviders();
  for (const provider of providers) {
    const hostname = typeof provider["hostname"] === "string" ? provider["hostname"] : null;
    const target = hostname ? hostnameTarget(hostname) : null;
    if (!target) continue;
    runtimeTargets.push(target);
    addCaptureTarget(target);
  }
}

function clearRuntimeProviders(): void {
  for (const target of runtimeTargets) removeCaptureTarget(target);
  runtimeTargets.length = 0;
}

/** Alias for init — familiar to MLflow users. */
const autolog = init;

/**
 * Record usage from a provider/framework component that CostKey cannot observe
 * automatically. The caller owns identity and revision; the event is sent as
 * passed (the server dedupes revisions). Delivery is async.
 */
function recordUsage(input: RecordUsageEvent): Promise<void> {
  const event = buildUsageEvent(input, projectId, defaultContext);
  if (!transport || !projectId) return Promise.resolve();
  return trackAdditiveEvent(event, transport, additiveBeforeSend, false);
}

/** Flush all pending events and shut down the SDK. */
async function shutdown(): Promise<void> {
  configSyncActive = false;
  configGeneration++;
  stopRuntimeConfigSync();
  setLifecycleEmitter(null);
  setSpanEmitter(null);
  await flushPendingCaptures();
  await flushPendingPolicy();
  const droppedAdditive = await drainAdditiveEvents();
  if (droppedAdditive > 0 && debugEnabled) {
    console.warn(`[costkey] Dropped ${droppedAdditive} additive event(s) after bounded hook wait`);
  }
  if (transport) {
    await transport.flush();
    transport.stop();
    transport = null;
  }
  unpatchFetch();
  projectId = null;
  defaultContext = {};
  additiveBeforeSend = null;
  policyClient = null;
  debugEnabled = false;
  captureBodyRef = null;
  localCaptureBodyDisabled = false;
  localCaptureBody = true;
  clearRuntimeProviders();
  resetLifecycleState();
  initialized = false;
}

/** Flush all pending events without shutting down. */
async function flush(): Promise<void> {
  await flushPendingCaptures();
  await flushPendingPolicy();
  const droppedAdditive = await drainAdditiveEvents();
  if (droppedAdditive > 0 && debugEnabled) {
    console.warn(`[costkey] Dropped ${droppedAdditive} additive event(s) after bounded hook wait`);
  }
  if (transport) await transport.flush();
}

/** Span input/output are content: sent whole, and only when capture is on. */
function spanPayload(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    return undefined;
  }
}

/**
 * An integration's raw framework payload: verbatim when body capture is on
 * (strings whole, no depth or size cap; only cycles are cut), otherwise a
 * skeleton whose allowlist also matches a dotted key's last segment
 * (`gen_ai.request.model`).
 */
function rawAttributes(value: unknown, capture: boolean): unknown {
  if (!capture) return skeleton(value, undefined, { leafKeys: true });
  return verbatimRaw(value, new Set());
}

function verbatimRaw(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (value === null || typeof value !== "object") return typeof value === "boolean" ? value : null;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return { $bytes: value.byteLength };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  // A reference cycle can't be serialized; mark where it was cut.
  if (ancestors.has(value)) return { $trunc: true };
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => verbatimRaw(item, ancestors));
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
      result[key] = verbatimRaw(entry, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function buildSpanEvent(
  record: SpanRecord,
  currentProjectId: string,
  currentDefaultContext: EventContext,
  capture: boolean,
): CostKeySpanEvent {
  const attributes: Record<string, unknown> = { ...record.attributes };
  if (record.raw) attributes[record.raw.namespace] = rawAttributes(record.raw.value, capture);
  if (capture) {
    const input = spanPayload(record.input);
    const output = spanPayload(record.output);
    if (input !== undefined) attributes["input"] = input;
    if (output !== undefined) attributes["output"] = output;
  }
  return {
    id: record.id,
    timestamp: record.endedAt ?? record.startedAt,
    projectId: currentProjectId,
    eventType: "span",
    source: "explicit",
    kind: record.kind,
    name: record.name,
    status: record.status,
    traceId: record.traceId,
    ...(record.traceName ? { traceName: record.traceName } : {}),
    ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
    ...(record.executionId ? { executionId: record.executionId } : {}),
    startedAt: record.startedAt,
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.errorName ? { errorName: record.errorName, errorType: record.errorName } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(record.callSite ? { callSite: record.callSite } : {}),
    context: { ...currentDefaultContext, ...record.context },
  };
}

function buildLifecycleEvent(
  record: LifecycleRecord,
  currentProjectId: string,
  currentDefaultContext: EventContext,
): CostKeyLifecycleEvent {
  return {
    id: generateId("lc"),
    timestamp: record.endedAt ?? record.startedAt,
    projectId: currentProjectId,
    eventType: "lifecycle",
    source: "explicit",
    entityType: record.entityType,
    entityId: record.entityId,
    lifecycle: record.lifecycle,
    sequence: record.sequence,
    traceId: record.traceId,
    traceName: record.traceName,
    groupId: record.groupId,
    groupName: record.groupName,
    groupKind: record.groupKind,
    executionId: record.executionId,
    phase: typeof record.context.phase === "string" ? record.context.phase : undefined,
    datasetRevision: typeof record.context.datasetRevision === "string" ? record.context.datasetRevision : undefined,
    caseId: typeof record.context.caseId === "string" ? record.context.caseId : undefined,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs ?? 0,
    ...(record.errorName ? { errorName: record.errorName, errorType: record.errorName } : {}),
    expectedItems: record.expectedItems,
    completedItems: record.completedItems,
    failedItems: record.failedItems,
    configuration: record.configuration,
    context: { ...currentDefaultContext, ...record.context },
    provider: "unknown",
    model: null,
    url: "",
    method: "POST",
    statusCode: null,
    usage: null,
    costUsd: null,
    streaming: false,
    callSite: null,
    requestBody: null,
    responseBody: null,
  };
}

function buildUsageEvent(
  input: RecordUsageEvent,
  currentProjectId: string | null,
  currentDefaultContext: EventContext,
): CostKeyUsageEvent {
  if (!input || typeof input !== "object") {
    throw new TypeError("CostKey.recordUsage() requires an event object");
  }
  if (typeof input.id !== "string" || !input.id.trim()) {
    throw new TypeError("CostKey.recordUsage() requires a caller-supplied id");
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new RangeError("CostKey.recordUsage() revision must be a non-negative integer");
  }
  if (input.aggregation !== "delta" && input.aggregation !== "cumulative") {
    throw new TypeError("CostKey.recordUsage() aggregation must be delta or cumulative");
  }
  if (
    input.amountKind !== undefined &&
    input.amountKind !== "reported" &&
    input.amountKind !== "estimated"
  ) {
    throw new TypeError("CostKey.recordUsage() amountKind must be reported or estimated");
  }
  const provider = nonEmpty(input.provider) ?? "unknown";
  if (!provider) throw new TypeError("CostKey.recordUsage() provider is invalid");

  const rawInput = input as RecordUsageEvent & Record<string, unknown>;
  const componentId = nonEmpty(input.componentId) ?? nonEmpty(input.component);
  if (!componentId) {
    throw new TypeError("CostKey.recordUsage() requires componentId");
  }
  const chargeId = nonEmpty(input.chargeId) ?? componentId;
  const usage = normalizeUsageUnits(input.usage ?? input.nativeUsage ?? input.nativeUnits);
  const billingUnits = normalizeUsageUnits(input.billingUnits);
  const amount = normalizeAmount(
    (input.amount ?? input.cost) as UsageAmount | number | null | undefined,
    rawInput,
  );
  const currency = amount?.currency ?? normalizeCurrency(input.currency ?? "USD");
  const context = {
    ...currentDefaultContext,
    ...getCurrentContext(),
    ...(input.context ? importContextForUsage(input.context) : {}),
  };
  if (input.traceId !== undefined) context.traceId = input.traceId;
  if (input.executionId !== undefined) context.executionId = input.executionId;

  const timestamp = normalizeTimestamp(input.timestamp);
  const metadata = normalizeMetadata(input.metadata);
  const usageEvent: Record<string, unknown> = {
    component: componentId,
    componentId,
    chargeId,
    providerRequestId: nonEmpty(input.providerRequestId),
    attemptId: nonEmpty(input.attemptId),
    parentEventId: nonEmpty(input.parentEventId),
    provider,
    model: input.model ?? null,
    unitKind: nonEmpty(input.unitKind) ?? nonEmpty(input.unit),
    unit: nonEmpty(input.unit),
    amount: amount?.value,
    currency,
    aggregation: input.aggregation,
    revision: input.revision,
    pricingId: nonEmpty(input.pricingId),
    ...(billingUnits ? { billingUnits } : {}),
  };
  if (input.unitValue !== undefined) {
    if (
      typeof input.unitValue !== "number" ||
      !Number.isFinite(input.unitValue) ||
      input.unitValue < 0
    ) {
      throw new TypeError("CostKey.recordUsage() unitValue must be a non-negative number");
    }
    usageEvent.unitValue = input.unitValue;
  }
  return {
    id: input.id,
    timestamp,
    projectId: currentProjectId ?? "",
    eventType: "usage",
    source: "explicit",
    component: componentId,
    componentId,
    chargeId,
    revision: input.revision,
    aggregation: input.aggregation,
    provider,
    model: input.model ?? null,
    providerRequestId: nonEmpty(input.providerRequestId) ?? null,
    attemptId: nonEmpty(input.attemptId) ?? null,
    parentEventId: nonEmpty(input.parentEventId) ?? null,
    usage,
    nativeUsage: usage,
    ...(billingUnits ? { billingUnits } : {}),
    ...(amount ? { amount } : {}),
    costUsd: typeof input.costUsd === "number" ? input.costUsd : null,
    currency,
    amountKind: input.amountKind ?? "reported",
    unitKind: nonEmpty(input.unitKind) ?? nonEmpty(input.unit),
    unitValue: input.unitValue,
    pricingId: nonEmpty(input.pricingId),
    unit: nonEmpty(input.unit),
    traceId: context.traceId,
    executionId: context.executionId,
    context,
    metadata,
    usageEvent,
    groupId: typeof context.groupId === "string" ? context.groupId : undefined,
    groupName: typeof context.groupName === "string" ? context.groupName : undefined,
    groupKind: typeof context.groupKind === "string" ? context.groupKind : undefined,
    phase: typeof context.phase === "string" ? context.phase : undefined,
    datasetRevision: typeof context.datasetRevision === "string" ? context.datasetRevision : undefined,
    caseId: typeof context.caseId === "string" ? context.caseId : undefined,
    url: "",
    method: "POST",
    statusCode: null,
    durationMs: 0,
    streaming: false,
    callSite: null,
    requestBody: null,
    responseBody: null,
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
  };
}

async function sendAdditiveEvent(
  event: CostKeyAdditiveEvent,
  currentTransport: Transport,
  hook: BeforeSendEventHook | null,
  debug: boolean,
): Promise<void> {
  try {
    let finalEvent: CostKeyAdditiveEvent | null = event;
    if (hook) {
      try {
        finalEvent = await hook(event);
      } catch {
        if (debug) console.warn("[costkey] beforeSendEvent hook failed; dropping event");
        return;
      }
    }
    if (finalEvent && transport === currentTransport) currentTransport.enqueue(finalEvent);
  } catch {
    if (debug) console.warn("[costkey] failed to enqueue event; dropping event");
  }
}

function trackAdditiveEvent(
  event: CostKeyAdditiveEvent,
  currentTransport: Transport,
  hook: BeforeSendEventHook | null,
  debug: boolean,
): Promise<void> {
  const pending = sendAdditiveEvent(event, currentTransport, hook, debug);
  additivePending.add(pending);
  void pending.finally(() => additivePending.delete(pending));
  return pending;
}

async function drainAdditiveEvents(): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (additivePending.size > 0) {
    const pending = [...additivePending];
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return dropPendingAdditive(pending);
    }
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
          }, remaining);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (timedOut) {
      return dropPendingAdditive(pending);
    }
  }
  return 0;
}

function dropPendingAdditive(pending: readonly Promise<void>[]): number {
  let dropped = 0;
  for (const promise of pending) {
    if (additivePending.delete(promise)) dropped++;
  }
  return dropped;
}

function normalizeUsageUnits(value: unknown): UsageUnits | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("CostKey.recordUsage() usage must be an object");
  }
  const result: UsageUnits = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (candidate === null) {
      result[key] = null;
      continue;
    }
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
      throw new TypeError(`CostKey.recordUsage() usage.${key} must be a non-negative number or null`);
    }
    result[key] = candidate;
  }
  return result;
}

function normalizeAmount(
  value: UsageAmount | number | null | undefined,
  aliases: Record<string, unknown>,
): UsageAmount | null {
  let candidate: unknown = value;
  if (candidate == null) return null;
  if (typeof candidate === "number") {
    // A bare number is the caller's amount in the currency they named.
    candidate = { value: candidate, currency: aliases["currency"] ?? "USD" };
  }
  if (typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("CostKey.recordUsage() amount must include value and currency");
  }
  const object = candidate as Record<string, unknown>;
  const amount = object["value"] ?? object["amount"];
  const currency = object["currency"];
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new TypeError("CostKey.recordUsage() amount.value must be a non-negative number");
  }
  if (typeof currency !== "string" || !currency.trim()) {
    throw new TypeError("CostKey.recordUsage() amount.currency is required");
  }
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{2,9}$/.test(normalizedCurrency)) {
    throw new TypeError("CostKey.recordUsage() amount.currency must be an ISO-like code");
  }
  return { value: amount, currency: normalizedCurrency };
}

function normalizeCurrency(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("CostKey.recordUsage() currency is required");
  }
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{2,9}$/.test(currency)) {
    throw new TypeError("CostKey.recordUsage() currency must be an ISO-like code");
  }
  return currency;
}

function normalizeTimestamp(timestamp: string | Date | undefined): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError("CostKey.recordUsage() timestamp is invalid");
  return date.toISOString();
}

function normalizeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("CostKey.recordUsage() metadata must be an object");
  }
  try {
    const safe = JSON.parse(JSON.stringify(value)) as unknown;
    return safe && typeof safe === "object" && !Array.isArray(safe)
      ? safe as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function importContextForUsage(input: EventContext | ContextCarrier): EventContext {
  return importContext(input);
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export const CostKey = {
  init,
  autolog,
  shutdown,
  flush,
  withContext,
  startTrace,
  startExecution,
  startSpan,
  agent,
  step,
  tool,
  instrumentTools,
  recordUsage,
  exportContext,
  exportContextHeaders,
  getCurrentContext,
  getCurrentTraceId,
  recordLiveKitUsage,
  recordLiveKitSessionUsage,
  instrumentBedrockClient,
} as const;

export default CostKey;

export { recordLiveKitUsage, recordLiveKitSessionUsage } from "./livekit.js";
export { instrumentBedrockClient } from "./bedrock-client.js";
export type { BedrockClientLike } from "./bedrock-client.js";
export type {
  LiveKitModelUsage,
  LiveKitSessionUsageUpdatedEvent,
  LiveKitUsageOptions,
  LiveKitUsageComponent,
} from "./livekit.js";
