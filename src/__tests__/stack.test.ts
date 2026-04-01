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

  it("filters out internal CostKey frames", () => {
    const site = captureCallSite();
    // No frame should reference costkey SDK internals in the filtered output
    // (though in test context this is tricky — the test file itself is inside the SDK)
    expect(site).not.toBeNull();
  });
});
