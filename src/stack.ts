import type { CallSite, StackFrame } from "./types.js";

/** Frames from these packages are internal and should be stripped */
const INTERNAL_PATTERNS = [
  // CostKey
  "/costkey/packages/sdk/",
  "/node_modules/costkey/",
  // Node internals
  "node:internal/",
  "node:async_hooks",
  // AI SDKs (internal transport)
  "/node_modules/openai/",
  "/node_modules/@anthropic-ai/",
  "/node_modules/@google/generative-ai/",
  "/node_modules/@google/genai/",
  "/node_modules/cohere-ai/",
  // HTTP clients
  "/node_modules/node-fetch/",
  "/node_modules/undici/",
];

/**
 * Capture a stack trace at the current call site, stripping CostKey internals.
 * Returns null if stack traces are unavailable.
 */
export function captureCallSite(): CallSite | null {
  const err = new Error();
  const raw = err.stack;
  if (!raw) return null;

  const frames = parseStack(raw).filter(
    (frame) =>
      frame.fileName != null &&
      !INTERNAL_PATTERNS.some((p) => frame.fileName!.includes(p)),
  );

  if (frames.length === 0) return null;

  return { raw, frames };
}

/**
 * Parse a V8-style stack trace string into structured frames.
 *
 * V8 format:
 *   at functionName (fileName:lineNumber:columnNumber)
 *   at fileName:lineNumber:columnNumber
 *   at async functionName (fileName:lineNumber:columnNumber)
 */
function parseStack(stack: string): StackFrame[] {
  const lines = stack.split("\n");
  const frames: StackFrame[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;

    const frame = parseFrame(trimmed.slice(3)); // strip "at "
    if (frame) frames.push(frame);
  }

  return frames;
}

function parseFrame(frame: string): StackFrame | null {
  // Strip "async " prefix
  const cleaned = frame.startsWith("async ") ? frame.slice(6) : frame;

  // Format: functionName (fileName:line:col)
  const parenMatch = cleaned.match(/^(.+?)\s+\((.+):(\d+):(\d+)\)$/);
  if (parenMatch) {
    return {
      functionName: parenMatch[1] || null,
      fileName: parenMatch[2] || null,
      lineNumber: parseInt(parenMatch[3], 10),
      columnNumber: parseInt(parenMatch[4], 10),
    };
  }

  // Format: fileName:line:col (anonymous)
  const directMatch = cleaned.match(/^(.+):(\d+):(\d+)$/);
  if (directMatch) {
    return {
      functionName: null,
      fileName: directMatch[1] || null,
      lineNumber: parseInt(directMatch[2], 10),
      columnNumber: parseInt(directMatch[3], 10),
    };
  }

  return null;
}
