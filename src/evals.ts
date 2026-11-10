import { getCallContext, startExecution, startTrace } from "./context.js";
import type { CostKeyTelemetryEvent } from "./types.js";

/**
 * Evals that run in your environment: `runEval` reads a labelled dataset from
 * CostKey, runs your task (your model call, with your keys) on every item as
 * one tracked execution, scores each answer and reports the results. The
 * calls are captured like any others, so the console shows what the
 * candidate cost next to the original.
 */

export interface EvalItem {
  id: string;
  label: string;
  note: string | null;
  expected: unknown;
  /** The original call's request body, with its screenshots put back. */
  input: unknown;
  /** The original call's response body. */
  output: unknown;
  model: string | null;
  provider: string | null;
  traceId: string | null;
  sourceEventId: string;
  /** Some screenshots in the input couldn't be restored (not uploaded, or expired). */
  incomplete: boolean;
}

export interface EvalVerdict {
  /** null when there's nothing to compare against: the item is reported unscored. */
  pass: boolean | null;
  reason?: string;
}

export interface RunEvalOptions<T> {
  /** Dataset name or id. */
  dataset: string;
  /** Your model call for one item; return the response. */
  task: (item: EvalItem) => T | Promise<T>;
  /** Your own scorer. The default compares computer actions (see `defaultEvalScore`). */
  score?: (item: EvalItem, output: T) => EvalVerdict | Promise<EvalVerdict>;
  /** Name of this run in the console (default: "eval: <dataset>"). */
  name?: string;
  /** What you changed, e.g. { model: "claude-haiku-4-5" }; shown on the run. */
  configuration?: Record<string, unknown>;
  /** A CostKey personal access token (ck_pat_…) to read the dataset; default COSTKEY_API_TOKEN. */
  apiToken?: string;
  /** Items run at once (default 2). */
  concurrency?: number;
  /** Pixels two clicks may differ by and still match (default 40). */
  tolerance?: number;
}

export interface EvalResult {
  itemId: string;
  traceId: string;
  pass: boolean | null;
  reason: string | null;
  error: string | null;
}

export interface EvalSummary {
  executionId: string;
  dataset: { id: string; name: string; revision: number };
  total: number;
  scored: number;
  passed: number;
  failed: number;
  errors: number;
  results: EvalResult[];
}

/** What `runEval` needs from the initialized SDK. */
export interface EvalClient {
  apiBase: string;
  projectId: string;
  enqueue: (event: CostKeyTelemetryEvent) => void;
  flush: () => Promise<void>;
}

interface DatasetRow { id: string; name: string; revision: number }

const PLACEHOLDER = /^\[image data omitted: ([^;\]]+); ~\d+ bytes; frame ([0-9a-f]{64})\]$/;

export async function runEval<T>(client: EvalClient | null, options: RunEvalOptions<T>): Promise<EvalSummary> {
  if (!client) throw new Error("CostKey.runEval() needs CostKey.init() with a DSN first");
  if (!options || typeof options.task !== "function" || !options.dataset) {
    throw new TypeError("CostKey.runEval() needs { dataset, task }");
  }
  const token = options.apiToken ?? (typeof process !== "undefined" ? process.env?.["COSTKEY_API_TOKEN"] : undefined);
  if (!token) {
    throw new Error("CostKey.runEval() reads the dataset with a personal access token: pass apiToken or set COSTKEY_API_TOKEN (create one in the console under Settings, MCP & coding agents)");
  }
  const api = async (path: string): Promise<Response> => {
    const response = await fetch(`${client.apiBase}/projects/${encodeURIComponent(client.projectId)}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`CostKey dataset request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
    return response;
  };

  const listed = await (await api("/datasets")).json() as { datasets?: DatasetRow[] };
  const datasets = listed.datasets ?? [];
  const dataset = datasets.find((row) => row.id === options.dataset)
    ?? datasets.find((row) => row.name === options.dataset)
    ?? datasets.find((row) => row.name.toLowerCase() === options.dataset.toLowerCase());
  if (!dataset) throw new Error(`No dataset named "${options.dataset}" in this project`);
  const exported = await (await api(`/datasets/${encodeURIComponent(dataset.id)}/export`)).text();
  const rows = exported.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

  const frames = new Map<string, Promise<string | null>>();
  const frame = (sha256: string): Promise<string | null> => {
    let pending = frames.get(sha256);
    if (!pending) {
      pending = api(`/frames/${sha256}`)
        .then(async (response) => response.ok ? Buffer.from(await response.arrayBuffer()).toString("base64") : null)
        .catch(() => null);
      frames.set(sha256, pending);
    }
    return pending;
  };
  const items: EvalItem[] = [];
  for (const row of rows) {
    const restored = { incomplete: false };
    const input = await restoreImages(row["input"] ?? null, undefined, frame, restored);
    items.push({
      id: String(row["id"]),
      label: String(row["label"] ?? ""),
      note: typeof row["note"] === "string" ? row["note"] : null,
      expected: row["expected"] ?? null,
      input,
      output: row["output"] ?? null,
      model: typeof row["model"] === "string" ? row["model"] : null,
      provider: typeof row["provider"] === "string" ? row["provider"] : null,
      traceId: typeof row["traceId"] === "string" ? row["traceId"] : null,
      sourceEventId: String(row["sourceEventId"] ?? ""),
      incomplete: restored.incomplete,
    });
  }

  const name = (options.name ?? `eval: ${dataset.name}`).slice(0, 120);
  const tolerance = options.tolerance ?? 40;
  const concurrency = Math.max(1, Math.min(16, Math.floor(options.concurrency ?? 2)));
  const results: EvalResult[] = [];
  let executionId = "";

  await startExecution({
    name,
    kind: "evaluation",
    datasetRevision: `${dataset.id}@${dataset.revision}`,
    configuration: options.configuration,
    expectedItems: items.length,
  }, async () => {
    executionId = String(getCallContext().executionId ?? "");
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const item = items[next++]!;
        await startTrace({ name, context: { caseId: item.id, phase: "candidate" } }, async () => {
          const traceId = String(getCallContext().traceId ?? "");
          let verdict: EvalVerdict;
          let error: string | null = null;
          try {
            const output = await options.task(item);
            verdict = options.score ? await options.score(item, output) : defaultEvalScore(item, output, tolerance);
          } catch (reason) {
            error = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
            verdict = { pass: false, reason: `The task failed (${reason instanceof Error ? reason.name : "error"})` };
          }
          results.push({ itemId: item.id, traceId, pass: verdict.pass, reason: verdict.reason ?? null, error });
          if (verdict.pass !== null && traceId) {
            client.enqueue({
              id: `eval_${executionId}_${item.id}`,
              eventType: "score",
              source: "code",
              timestamp: new Date().toISOString(),
              projectId: client.projectId,
              traceId,
              name,
              value: verdict.pass ? 1 : 0,
              label: verdict.pass ? "pass" : "fail",
              ...(verdict.reason ? { comment: verdict.reason } : {}),
              context: { caseId: item.id, phase: "candidate", executionId },
            } as unknown as CostKeyTelemetryEvent);
          }
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  });
  await client.flush();

  const scored = results.filter((result) => result.pass !== null);
  return {
    executionId,
    dataset: { id: dataset.id, name: dataset.name, revision: dataset.revision },
    total: results.length,
    scored: scored.length,
    passed: scored.filter((result) => result.pass).length,
    failed: scored.filter((result) => !result.pass).length,
    errors: results.filter((result) => result.error).length,
    results,
  };
}

/** Put uploaded screenshots back where the captured body has their placeholder. */
async function restoreImages(
  value: unknown,
  key: string | undefined,
  frame: (sha256: string) => Promise<string | null>,
  state: { incomplete: boolean },
): Promise<unknown> {
  if (typeof value === "string") {
    if (!value.startsWith("[image data omitted:")) return value;
    const match = value.match(PLACEHOLDER);
    if (!match) { state.incomplete = true; return value; }
    const data = await frame(match[2]!);
    if (!data) { state.incomplete = true; return value; }
    return key === "data" ? data : `data:${match[1]};base64,${data}`;
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => restoreImages(item, key, frame, state)));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
      result[entryKey] = await restoreImages(entry, entryKey, frame, state);
    }
    return result;
  }
  return value;
}

export interface ComputerAction { type: string; x?: number; y?: number; text?: string }

const ACTION_ALIASES: Record<string, string> = { left_click: "click", click: "click", keypress: "key", key: "key" };

/** The computer action in a response: Anthropic's computer tool or OpenAI's computer_call. */
export function computerAction(body: unknown): ComputerAction | null {
  const response = parseObject(body);
  if (!response) return null;
  const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  for (const block of Array.isArray(response["content"]) ? response["content"] : []) {
    const input = parseObject((block as Record<string, unknown>)?.["input"]);
    if ((block as Record<string, unknown>)?.["type"] !== "tool_use" || typeof input?.["action"] !== "string") continue;
    const coordinate = Array.isArray(input["coordinate"]) ? input["coordinate"] : [];
    return { type: input["action"], x: finite(coordinate[0]), y: finite(coordinate[1]), ...(typeof input["text"] === "string" ? { text: input["text"] } : {}) };
  }
  for (const entry of Array.isArray(response["output"]) ? response["output"] : []) {
    const action = parseObject((entry as Record<string, unknown>)?.["action"]);
    if ((entry as Record<string, unknown>)?.["type"] !== "computer_call" || typeof action?.["type"] !== "string") continue;
    const keys = Array.isArray(action["keys"]) ? action["keys"].join("+") : undefined;
    const text = typeof action["text"] === "string" ? action["text"] : keys;
    return { type: action["type"], x: finite(action["x"]), y: finite(action["y"]), ...(text ? { text } : {}) };
  }
  return null;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

function expectedAction(expected: unknown): ComputerAction | null {
  const object = parseObject(expected);
  if (!object) return null;
  const type = typeof object["action"] === "string" ? object["action"] : typeof object["type"] === "string" ? object["type"] : null;
  if (!type) return null;
  const coordinate = Array.isArray(object["coordinate"]) ? object["coordinate"] : [];
  const x = typeof object["x"] === "number" ? object["x"] : typeof coordinate[0] === "number" ? coordinate[0] : undefined;
  const y = typeof object["y"] === "number" ? object["y"] : typeof coordinate[1] === "number" ? coordinate[1] : undefined;
  return { type, x, y, ...(typeof object["text"] === "string" ? { text: object["text"] } : {}) };
}

function sameAction(a: ComputerAction, b: ComputerAction, tolerance: number): boolean {
  const kind = (value: string) => ACTION_ALIASES[value] ?? value;
  if (kind(a.type) !== kind(b.type)) return false;
  if (a.x !== undefined && a.y !== undefined && b.x !== undefined && b.y !== undefined) {
    if (Math.hypot(a.x - b.x, a.y - b.y) > tolerance) return false;
  }
  if (a.text !== undefined && b.text !== undefined && a.text.trim().toLowerCase() !== b.text.trim().toLowerCase()) return false;
  return true;
}

function describe(action: ComputerAction): string {
  return `${action.type}${action.x !== undefined && action.y !== undefined ? ` at ${Math.round(action.x)}, ${Math.round(action.y)}` : ""}`;
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  const object = parseObject(output);
  const parts: string[] = [];
  for (const block of Array.isArray(object?.["content"]) ? object!["content"] as unknown[] : []) {
    const text = (block as Record<string, unknown>)?.["text"];
    if (typeof text === "string") parts.push(text);
  }
  const choices = Array.isArray(object?.["choices"]) ? object!["choices"] as Array<Record<string, unknown>> : [];
  for (const choice of choices) {
    const content = parseObject(choice["message"])?.["content"];
    if (typeof content === "string") parts.push(content);
  }
  if (typeof object?.["output_text"] === "string") parts.push(object["output_text"] as string);
  return parts.join("\n");
}

/**
 * The default scorer:
 * - with an expected action, the candidate must take it (same kind; clicks within `tolerance` px);
 * - for an item labelled Good, it must take the original action;
 * - for an item labelled Bad, it must not repeat the original action;
 * - with expected text, the answer must contain it;
 * - otherwise the item is unscored.
 */
export function defaultEvalScore(item: EvalItem, output: unknown, tolerance = 40): EvalVerdict {
  const candidate = computerAction(output);
  const expected = expectedAction(item.expected);
  if (expected) {
    if (!candidate) return { pass: false, reason: `Expected ${describe(expected)}, got no action` };
    return sameAction(candidate, expected, tolerance)
      ? { pass: true, reason: `Took the expected action (${describe(candidate)})` }
      : { pass: false, reason: `Expected ${describe(expected)}, got ${describe(candidate)}` };
  }
  const original = computerAction(item.output);
  const label = item.label.trim().toLowerCase();
  if (original && label === "good") {
    if (!candidate) return { pass: false, reason: `Expected ${describe(original)}, got no action` };
    return sameAction(candidate, original, tolerance)
      ? { pass: true, reason: `Matched the good action (${describe(candidate)})` }
      : { pass: false, reason: `Expected ${describe(original)}, got ${describe(candidate)}` };
  }
  if (original && label === "bad") {
    if (!candidate) return { pass: true, reason: "Didn't repeat the bad action" };
    return sameAction(candidate, original, tolerance)
      ? { pass: false, reason: `Repeated the bad action (${describe(candidate)})` }
      : { pass: true, reason: `Avoided the bad action: ${describe(candidate)} instead of ${describe(original)}` };
  }
  if (typeof item.expected === "string" && item.expected.trim()) {
    return outputText(output).toLowerCase().includes(item.expected.trim().toLowerCase())
      ? { pass: true, reason: "The answer contains the expected text" }
      : { pass: false, reason: "The answer doesn't contain the expected text" };
  }
  return { pass: null, reason: "Nothing to compare with: label it Good or Bad, or give it an expected action" };
}
