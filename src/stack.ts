import type { CallSite, StackFrame } from "./types.js";

const MIN_STACK_FRAMES = 50;

/**
 * Capture the stack at the current call site. Every frame is sent, CostKey's
 * own and Node's included, along with the raw stack text: the server decides
 * which frame is the application's call site. Returns null only when the
 * runtime has no stack traces.
 */
export function captureCallSite(): CallSite | null {
  // CostKey and HTTP-client frames take slots too, so capture deeper than
  // V8's default of 10 for this one stack.
  const limit = Error.stackTraceLimit;
  let raw: string | undefined;
  try {
    if (typeof limit === "number" && limit < MIN_STACK_FRAMES) Error.stackTraceLimit = MIN_STACK_FRAMES;
    raw = new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
  if (!raw) return null;
  const frames = parseStack(raw);
  addSourceContext(frames);
  return { raw, frames };
}

// Source context: the call line and a few lines around it, for the first
// in-app frames. Node only; a no-op wherever there is no filesystem.
export const MAX_CONTEXT_FRAMES = 8;
const CONTEXT_LINES = 3;
const MAX_LINE_CHARS = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

type FsLike = {
  readFileSync(path: string, encoding: "utf8"): string;
  statSync(path: string): { isFile(): boolean; size: number };
};

let fsModule: FsLike | null | undefined;
function nodeFs(): FsLike | null {
  if (fsModule !== undefined) return fsModule;
  fsModule = null;
  try {
    const g = globalThis as { process?: { versions?: { node?: string }; getBuiltinModule?: (id: string) => unknown }; EdgeRuntime?: unknown };
    if (typeof g.EdgeRuntime === "string" || !g.process?.versions?.node) return fsModule;
    const fs = g.process.getBuiltinModule?.("node:fs") as FsLike | undefined;
    if (fs && typeof fs.readFileSync === "function" && typeof fs.statSync === "function") fsModule = fs;
  } catch {
    fsModule = null;
  }
  return fsModule;
}

/** Test hook: swap the filesystem (null disables source context). */
export function __setSourceFsForTests(fs: FsLike | null | undefined): void {
  fsModule = fs;
  fileCache.clear();
}

const OWN_DIR = (() => {
  try {
    const path = toPath(import.meta.url);
    return path ? path.slice(0, path.lastIndexOf("/") + 1) : null;
  } catch {
    return null;
  }
})();

function toPath(fileName: string): string | null {
  if (fileName.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(fileName).pathname);
    } catch {
      return null;
    }
  }
  return fileName;
}

/** True for the application's own files: absolute, not dependencies, not CostKey. */
export function isInAppFile(fileName: string | null): boolean {
  if (!fileName) return false;
  const path = toPath(fileName);
  if (!path || !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) return false;
  const norm = path.replace(/\\/g, "/");
  if (norm.includes("/node_modules/")) return false;
  if (OWN_DIR && norm.startsWith(OWN_DIR) && !norm.slice(OWN_DIR.length).startsWith("__tests__/")) return false;
  return true;
}

const fileCache = new Map<string, string[] | null>();
const FILE_CACHE_LIMIT = 200;

function readLines(fs: FsLike, path: string): string[] | null {
  if (fileCache.has(path)) return fileCache.get(path)!;
  let lines: string[] | null = null;
  try {
    const stat = fs.statSync(path);
    if (stat.isFile() && stat.size <= MAX_FILE_BYTES) lines = fs.readFileSync(path, "utf8").split("\n");
  } catch {
    lines = null;
  }
  if (fileCache.size >= FILE_CACHE_LIMIT) fileCache.clear();
  fileCache.set(path, lines);
  return lines;
}

// Source lines can hold hardcoded secrets. Redact the common shapes before
// they leave the process: provider keys and tokens, URL credentials and query
// strings, and string literals assigned to secret-looking names.
const TOKEN =
  /sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]*){0,2}|xox[bpras]-[A-Za-z0-9-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|(?<=Bearer )[A-Za-z0-9._-]{20,}/g;
const URL_USERINFO = /(:\/\/)[^/\s'"`@]+@/g;
const URL_QUERY = /(:\/\/[^\s'"`?#]*\?)[^\s'"`#]*/g;
const QUERY_SECRET = /([?&](?:key|api[_-]?key|token|access[_-]?token|secret|sig|signature|password|auth)=)[^&\s'"`#]+/gi;
const SECRET_ASSIGN =
  /((?:api[_-]?key|secret(?:[_-]?key)?|token|access[_-]?token|refresh[_-]?token|password|passwd|credential|authorization|private[_-]?key)['"]?\s*[:=]\s*)(['"`])(?:(?!\2).)+\2/gi;

export function scrubSourceLine(line: string): string {
  return line
    .replace(TOKEN, "[REDACTED]")
    .replace(URL_USERINFO, "$1[REDACTED]@")
    .replace(URL_QUERY, "$1[REDACTED]")
    .replace(QUERY_SECRET, "$1[REDACTED]")
    .replace(SECRET_ASSIGN, (_m, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]${quote}`);
}

function clip(line: string): string {
  const cut = line.replace(/\r$/, "").slice(0, MAX_LINE_CHARS);
  try {
    return scrubSourceLine(cut);
  } catch {
    return cut;
  }
}

/** Attach source lines to the first in-app frames. Never throws. */
export function addSourceContext(frames: StackFrame[]): void {
  const fs = nodeFs();
  if (!fs) return;
  let seen = 0;
  for (const frame of frames) {
    if (seen >= MAX_CONTEXT_FRAMES) break;
    try {
      if (!isInAppFile(frame.fileName)) continue;
      seen++;
      const lineNumber = frame.lineNumber;
      if (!lineNumber || lineNumber < 1) continue;
      const lines = readLines(fs, toPath(frame.fileName!)!);
      if (!lines || lineNumber > lines.length) continue;
      const idx = lineNumber - 1;
      frame.contextLine = clip(lines[idx]);
      frame.preContext = lines.slice(Math.max(0, idx - CONTEXT_LINES), idx).map(clip);
      frame.postContext = lines.slice(idx + 1, idx + 1 + CONTEXT_LINES).map(clip);
    } catch {
      continue;
    }
  }
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

  // Frames without a position: `new Promise (<anonymous>)`, `Array.map (native)`, `<anonymous>`.
  const bareMatch = cleaned.match(/^(.+?)\s+\((.+)\)$/);
  if (bareMatch) {
    return { functionName: bareMatch[1] || null, fileName: bareMatch[2] || null, lineNumber: null, columnNumber: null };
  }
  return { functionName: null, fileName: cleaned || null, lineNumber: null, columnNumber: null };
}
