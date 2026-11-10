import { describe, it, expect } from "vitest";
import { captureCallSite } from "../stack.js";

describe("Stack Trace Capture", () => {
  it("captures a call site with frames", () => {
    const site = captureCallSite();
    expect(site).not.toBeNull();
    expect(site!.raw).toContain("captureCallSite");
    expect(site!.frames.length).toBeGreaterThan(0);
  });

  it("frames have file and line info", () => {
    const site = captureCallSite();
    // At least one frame should have file info
    const frameWithFile = site!.frames.find((f) => f.fileName !== null);
    expect(frameWithFile).toBeDefined();
    expect(frameWithFile!.lineNumber).toBeGreaterThan(0);
  });

  it("sends every frame unfiltered, CostKey and Node internals included", () => {
    const site = captureCallSite();
    expect(site).not.toBeNull();
    // The SDK's own frame (stack.ts) is kept: the server picks the call site.
    expect(site!.frames.some((frame) => frame.fileName?.includes("/src/stack.ts"))).toBe(true);
    expect(site!.frames[0]?.functionName).toBe("captureCallSite");
    expect(site!.frames.some((frame) => frame.fileName?.startsWith("node:"))).toBe(true);
    // Every "at" line of the raw stack is a parsed frame.
    const atLines = site!.raw.split("\n").filter((line) => line.trim().startsWith("at ")).length;
    expect(site!.frames).toHaveLength(atLines);
  });

  it("captures deeper than V8's default 10 frames and restores the limit", () => {
    const before = Error.stackTraceLimit;
    const nest = (depth: number): ReturnType<typeof captureCallSite> =>
      depth === 0 ? captureCallSite() : nest(depth - 1);
    const site = nest(30);
    expect(site!.frames.length).toBeGreaterThan(30);
    expect(Error.stackTraceLimit).toBe(before);
  });
});
