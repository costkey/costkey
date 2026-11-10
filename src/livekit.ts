import type { EventContext, RecordUsageEvent } from "./types.js";
import { TELEMETRY_VERSION, skeleton } from "./telemetry.js";

/** Structural subset of LiveKit Agents' cumulative model-usage rows. */
export interface LiveKitModelUsage {
  type?: string;
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

export type LiveKitUsageComponent = "interruption" | "llm" | "stt" | "tts";

/** Structural subset of the documented `session_usage_updated` event. */
export interface LiveKitSessionUsageUpdatedEvent {
  type?: "session_usage_updated" | string;
  createdAt?: number | string;
  created_at?: number | string;
  usage?: {
    modelUsage?: readonly LiveKitModelUsage[];
    model_usage?: readonly LiveKitModelUsage[];
  };
  modelUsage?: readonly LiveKitModelUsage[];
  model_usage?: readonly LiveKitModelUsage[];
  [key: string]: unknown;
}

export interface LiveKitUsageOptions {
  sessionId: string;
  revision: number;
  conversationId?: string;
  traceId?: string;
  executionId?: string;
  groupName?: string;
  groupKind?: string;
  phase?: string;
  eventPrefix?: string;
  /** Components the session is expected to report; sent as given. */
  expectedComponents?: readonly string[];
  /** Session components that own the charge; sent as given, applied on the server. */
  components?: readonly LiveKitUsageComponent[];
  /** Components whose charge another integration supplies; sent as given, applied on the server. */
  excludeComponents?: readonly LiveKitUsageComponent[];
}

/**
 * Send one LiveKit cumulative session snapshot as it is. The rows go out as a
 * skeleton (provider, model and type names and every number kept, no text);
 * the server classifies STT/LLM/TTS rows, sums duplicates and converts units.
 * This is an explicit callback adapter: it does not intercept WebRTC/audio
 * traffic. Returns the id of the usage event sent.
 */
export async function recordLiveKitUsage(
  update: LiveKitSessionUsageUpdatedEvent,
  options: LiveKitUsageOptions,
): Promise<string[]> {
  const sessionId = nonEmpty(options?.sessionId);
  if (!sessionId) throw new TypeError("recordLiveKitUsage requires sessionId");
  if (!Number.isSafeInteger(options.revision) || options.revision < 0) {
    throw new RangeError("recordLiveKitUsage requires a non-negative revision");
  }
  if (options.components !== undefined && options.excludeComponents !== undefined) {
    throw new TypeError("recordLiveKitUsage accepts components or excludeComponents, not both");
  }

  const prefix = nonEmpty(options.eventPrefix) ?? `livekit:${sessionId}`;
  const context: EventContext = {
    voiceSessionId: sessionId,
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    ...(options.traceId ? { traceId: options.traceId } : {}),
    ...(options.executionId ? { executionId: options.executionId } : {}),
    ...(options.groupName ? { groupName: options.groupName } : {}),
    ...(options.groupKind ? { groupKind: options.groupKind } : {}),
    ...(options.phase ? { phase: options.phase } : {}),
  };
  // The options as passed (0.6.1 names) plus the raw snapshot as a skeleton;
  // the server classifies rows, sums duplicates, converts units and applies
  // the component selection.
  const livekit: Record<string, unknown> = {
    sessionId,
    revision: options.revision,
    update: skeleton(update ?? null),
  };
  for (const key of [
    "conversationId", "traceId", "executionId", "groupName", "groupKind", "phase", "eventPrefix",
  ] as const) {
    if (options[key] !== undefined) livekit[key] = options[key];
  }
  for (const key of ["expectedComponents", "components", "excludeComponents"] as const) {
    if (options[key] !== undefined) livekit[key] = [...options[key]!];
  }
  const record: RecordUsageEvent = {
    id: `${prefix}:r${options.revision}`,
    componentId: prefix,
    chargeId: prefix,
    provider: "livekit",
    aggregation: "cumulative",
    revision: options.revision,
    context,
    telemetry: { v: TELEMETRY_VERSION, source: "livekit", livekit },
  };

  // Resolve the facade only when the adapter is called. A static import would
  // create an ESM cycle (`index -> livekit -> index`).
  const { CostKey } = await import("./index.js");
  await CostKey.recordUsage(record);
  return [record.id];
}

export const recordLiveKitSessionUsage = recordLiveKitUsage;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
