import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __setSourceFsForTests,
  addSourceContext,
  captureCallSite,
  isInAppFile,
  scrubSourceLine,
} from "../stack.js";
import type { StackFrame } from "../types.js";

const frame = (fileName: string | null, lineNumber: number | null): StackFrame => ({
  functionName: "f",
  fileName,
  lineNumber,
  columnNumber: 1,
});

function fixture(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ck-src-"));
  const path = join(dir, "app.ts");
  writeFileSync(path, contents);
  return path;
}

afterEach(() => __setSourceFsForTests(undefined));

// Source context reads files through process.getBuiltinModule (Node 20.16+ and
// 22.3+). Older Node skips source context by design, so these have nothing to check.
const itWithFs = typeof (process as { getBuiltinModule?: unknown }).getBuiltinModule === "function" ? it : it.skip;

describe("source context on call-site frames", () => {
  itWithFs("attaches the call line and three lines either side to the caller's own frame", () => {
    const site = captureCallSite(); // THE CALL LINE
    const self = fileURLToPath(import.meta.url);
    const mine = site!.frames.find((f) => f.fileName === self || f.fileName === `file://${self}`);
    expect(mine).toBeDefined();
    expect(mine!.contextLine).toBe("    const site = captureCallSite(); // THE CALL LINE");
    expect(mine!.preContext).toHaveLength(3);
    expect(mine!.postContext).toHaveLength(3);
    expect(mine!.postContext![0]).toContain("const self");
  });

  it("does not attach context to CostKey's own frame or Node internals", () => {
    const site = captureCallSite();
    const own = site!.frames.find((f) => f.fileName?.includes("/src/stack.ts"));
    expect(own?.contextLine).toBeUndefined();
    for (const f of site!.frames.filter((f) => f.fileName?.startsWith("node:"))) {
      expect(f.contextLine).toBeUndefined();
    }
  });

  itWithFs("reads files once and slices around the line", () => {
    const path = fixture(["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n"));
    const frames = [frame(path, 1), frame(path, 5), frame(path, 8)];
    addSourceContext(frames);
    expect(frames[0]).toMatchObject({ contextLine: "one", preContext: [], postContext: ["two", "three", "four"] });
    expect(frames[1]).toMatchObject({ contextLine: "five", preContext: ["two", "three", "four"], postContext: ["six", "seven", "eight"] });
    expect(frames[2]).toMatchObject({ contextLine: "eight", postContext: [] });
  });

  itWithFs("caps each line at 500 chars and strips carriage returns", () => {
    const path = fixture(`a = 1\r\n${"x".repeat(2000)}\r\nb = 2\r\n`);
    const frames = [frame(path, 2)];
    addSourceContext(frames);
    expect(frames[0].contextLine).toBe("x".repeat(500));
    expect(frames[0].preContext).toEqual(["a = 1"]);
    expect(frames[0].postContext).toEqual(["b = 2", ""]);
  });

  itWithFs("only fills the first 8 in-app frames; dependency frames do not count", () => {
    const path = fixture("line\n".repeat(20));
    const dep = frame("/app/node_modules/openai/index.js", 1);
    const frames = [dep, ...Array.from({ length: 10 }, (_, i) => frame(path, i + 1))];
    addSourceContext(frames);
    expect(frames.filter((f) => f.contextLine !== undefined)).toHaveLength(8);
    expect(dep.contextLine).toBeUndefined();
    expect(frames[9].contextLine).toBeUndefined();
  });

  it("skips missing files, lines past the end and relative paths silently", () => {
    const path = fixture("only\n");
    const frames = [frame("/no/such/file.ts", 3), frame(path, 99), frame("relative/app.ts", 1), frame("node:internal/x", 1), frame(path, null)];
    expect(() => addSourceContext(frames)).not.toThrow();
    expect(frames.every((f) => f.contextLine === undefined)).toBe(true);
  });

  it("classifies in-app files", () => {
    expect(isInAppFile("/srv/app/src/agent.ts")).toBe(true);
    expect(isInAppFile("file:///srv/app/src/agent.mjs")).toBe(true);
    expect(isInAppFile("/srv/app/node_modules/openai/core.js")).toBe(false);
    expect(isInAppFile("node:internal/process/task_queues")).toBe(false);
    expect(isInAppFile("<anonymous>")).toBe(false);
    expect(isInAppFile(null)).toBe(false);
  });

  it("is a no-op without a filesystem (browsers and edge runtimes)", () => {
    __setSourceFsForTests(null);
    const path = fixture("one\ntwo\n");
    const frames = [frame(path, 1)];
    addSourceContext(frames);
    expect(frames[0].contextLine).toBeUndefined();
  });

  it("redacts secret shapes in source lines", () => {
    expect(scrubSourceLine('const c = new OpenAI({ apiKey: "sk-abcdefghijklmnopqrstuvwxyz" });')).toBe(
      'const c = new OpenAI({ apiKey: "[REDACTED]" });',
    );
    expect(scrubSourceLine("const password = 'hunter2';")).toBe("const password = '[REDACTED]';");
    expect(scrubSourceLine('fetch("https://u:p@host/v1?key=s&x=1")')).toBe('fetch("https://[REDACTED]@host/v1?[REDACTED]")');
    expect(scrubSourceLine("await fetch(`${base}?key=abc&x=1`, {")).toBe("await fetch(`${base}?key=[REDACTED]&x=1`, {");
    expect(scrubSourceLine("const r = await client.chat.completions.create({ model });")).toBe(
      "const r = await client.chat.completions.create({ model });",
    );
  });
});
