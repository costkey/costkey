/**
 * Vercel AI SDK (`ai` v7+): a telemetry integration that turns
 * generateText/streamText runs (and ToolLoopAgent runs, which use them),
 * their steps and their tool executions into CostKey spans, with no manual
 * wrapping.
 *
 *   import { registerTelemetry } from "ai";
 *   import { costkeyTelemetry } from "costkey/integrations/ai-sdk";
 *   registerTelemetry(costkeyTelemetry());
 *
 * The AI SDK runs each model call and tool execution through the
 * integration (`executeLanguageModelCall`, `executeTool`), so the provider
 * request the fetch patch records is attributed to its step, and a tool's
 * nested calls to its tool span. Usage is never re-emitted.
 *
 * AI SDK v4–v6 have no integration interface: use their
 * `experimental_telemetry` OpenTelemetry spans with
 * `costkey/integrations/opentelemetry` instead. `CostKey.instrumentTools()`
 * keeps working with every version.
 */
import { rawErrorName } from "../telemetry.js";
import { SpanTracker, pickKeys, stringOr } from "./shared.js";

type AnyEvent = Record<string, unknown>;

/** Operations whose runs are agent loops (model calls plus tool calls). */
const AGENT_OPERATIONS = new Set(["ai.generateText", "ai.streamText", "ai.generateObject", "ai.streamObject"]);

/** Non-content fields of run, step and tool events. */
const RUN_FIELDS = [
  "operationId", "functionId", "provider", "modelId", "maxRetries", "maxOutputTokens", "temperature",
  "topP", "topK", "presencePenalty", "frequencyPenalty", "seed", "stopSequences", "toolChoice", "activeTools",
] as const;
const STEP_FIELDS = ["stepNumber", "provider", "modelId", "toolChoice", "activeTools"] as const;
const STEP_END_FIELDS = [
  "stepNumber", "model", "finishReason", "rawFinishReason", "usage", "providerMetadata", "warnings", "response",
] as const;
const END_FIELDS = ["stepNumber", "model", "finishReason", "rawFinishReason", "usage", "totalUsage", "providerMetadata"] as const;

export interface CostKeyTelemetryOptions {
  /** Span name for runs without a `functionId` (default: the operation, e.g. `ai.generateText`). */
  defaultName?: string;
}

/** A Telemetry integration object for `registerTelemetry()` or `experimental_telemetry.integrations`. */
export interface CostKeyTelemetryIntegration {
  onStart(event: AnyEvent): void;
  onStepStart(event: AnyEvent): void;
  onStepEnd(event: AnyEvent): void;
  onToolExecutionStart(event: AnyEvent): void;
  onToolExecutionEnd(event: AnyEvent): void;
  onEnd(event: AnyEvent): void;
  onAbort(event: AnyEvent): void;
  onError(event: unknown): void;
  executeLanguageModelCall<T>(options: AnyEvent & { callId: string; execute: () => PromiseLike<T> }): PromiseLike<T>;
  executeTool<T>(options: AnyEvent & { callId: string; toolCallId: string; execute: () => PromiseLike<T> }): PromiseLike<T>;
}

export function costkeyTelemetry(options: CostKeyTelemetryOptions = {}): CostKeyTelemetryIntegration {
  const tracker = new SpanTracker("aiSdk");
  /** callId → key of its open step span. */
  const currentStep = new Map<string, string>();

  const stepKey = (callId: string, stepNumber: unknown): string => `${callId}:step:${String(stepNumber)}`;
  const toolKey = (callId: string, toolCallId: unknown): string => `${callId}:tool:${String(toolCallId)}`;
  const records = (event: AnyEvent, key: "recordInputs" | "recordOutputs"): boolean => event[key] !== false;
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // Telemetry never affects the generation.
    }
  };

  return {
    onStart(event) {
      safe(() => {
        const callId = String(event["callId"]);
        const operationId = stringOr(event["operationId"], "ai");
        tracker.start({
          key: callId,
          kind: AGENT_OPERATIONS.has(operationId) ? "agent" : "task",
          name: stringOr(event["functionId"], options.defaultName ?? operationId),
          attributes: { framework: "ai-sdk", operationId },
          raw: {
            ...pickKeys(event, RUN_FIELDS),
            ...(event["tools"] && typeof event["tools"] === "object" ? { tools: Object.keys(event["tools"] as object) } : {}),
          },
          input: records(event, "recordInputs")
            ? pickKeys(event, ["system", "instructions", "prompt", "messages", "value", "values"])
            : undefined,
        });
      });
    },

    onStepStart(event) {
      safe(() => {
        const callId = String(event["callId"]);
        const key = stepKey(callId, event["stepNumber"]);
        tracker.start({
          key,
          parentKey: callId,
          kind: "step",
          name: `step ${String(event["stepNumber"] ?? "")}`.trim(),
          attributes: { framework: "ai-sdk" },
          raw: pickKeys(event, STEP_FIELDS),
        });
        currentStep.set(callId, key);
      });
    },

    onStepEnd(event) {
      safe(() => {
        const callId = String(event["callId"]);
        const key = stepKey(callId, event["stepNumber"]);
        tracker.end(key, {
          raw: pickKeys(event, STEP_END_FIELDS),
          output: records(event, "recordOutputs") ? pickKeys(event, ["text", "toolCalls", "toolResults"]) : undefined,
        });
        if (currentStep.get(callId) === key) currentStep.delete(callId);
      });
    },

    onToolExecutionStart(event) {
      safe(() => {
        const callId = String(event["callId"]);
        const toolCall = (event["toolCall"] ?? {}) as AnyEvent;
        tracker.start({
          key: toolKey(callId, toolCall["toolCallId"]),
          parentKey: currentStep.get(callId) ?? callId,
          kind: "tool",
          name: stringOr(toolCall["toolName"], "tool"),
          attributes: { framework: "ai-sdk" },
          raw: pickKeys(toolCall, ["toolCallId", "toolName", "dynamic", "providerExecuted"]),
          input: records(event, "recordInputs") ? toolCall["input"] : undefined,
        });
      });
    },

    onToolExecutionEnd(event) {
      safe(() => {
        const callId = String(event["callId"]);
        const toolCall = (event["toolCall"] ?? {}) as AnyEvent;
        const toolOutput = (event["toolOutput"] ?? {}) as AnyEvent;
        const failed = toolOutput["type"] === "tool-error";
        tracker.end(toolKey(callId, toolCall["toolCallId"]), {
          failed,
          errorName: failed ? rawErrorName(toolOutput["error"]) : undefined,
          raw: {
            ...pickKeys(toolCall, ["toolCallId", "toolName", "dynamic", "providerExecuted"]),
            ...pickKeys(event, ["toolExecutionMs"]),
            outputType: toolOutput["type"],
          },
          output: !failed && records(event, "recordOutputs") ? toolOutput["output"] : undefined,
        });
      });
    },

    onEnd(event) {
      safe(() => {
        const callId = String(event["callId"]);
        tracker.end(callId, {
          raw: pickKeys(event, END_FIELDS),
          output: records(event, "recordOutputs") ? pickKeys(event, ["text", "object"]) : undefined,
        });
        currentStep.delete(callId);
      });
    },

    onAbort(event) {
      safe(() => {
        const callId = String(event["callId"]);
        const reason = event["reason"];
        const key = currentStep.get(callId);
        const errorName = rawErrorName(reason) ?? "AbortError";
        if (key) tracker.end(key, { errorName });
        tracker.end(callId, { errorName });
        currentStep.delete(callId);
      });
    },

    onError(event) {
      safe(() => {
        const record = (event ?? {}) as AnyEvent;
        const callId = String(record["callId"]);
        const errorName = rawErrorName(record["error"]);
        const key = currentStep.get(callId);
        if (key) tracker.end(key, { failed: true, errorName });
        tracker.end(callId, { failed: true, errorName });
        currentStep.delete(callId);
      });
    },

    executeLanguageModelCall(options) {
      const callId = String(options.callId);
      return tracker.run(currentStep.get(callId) ?? callId, () => options.execute());
    },

    executeTool(options) {
      const callId = String(options.callId);
      return tracker.run(toolKey(callId, options.toolCallId), () => options.execute());
    },
  };
}

/**
 * Register the integration globally. Pass the `ai` module (or any object
 * with `registerTelemetry`); without one, `ai` is imported.
 */
export async function instrumentAISDK(
  ai?: { registerTelemetry(...integrations: unknown[]): void },
  options?: CostKeyTelemetryOptions,
): Promise<CostKeyTelemetryIntegration> {
  const integration = costkeyTelemetry(options);
  const module = ai ?? (await import(/* webpackIgnore: true */ "ai" as string)) as {
    registerTelemetry(...integrations: unknown[]): void;
  };
  module.registerTelemetry(integration);
  return integration;
}
