import { describe, it, expect } from "vitest";
import { withContext, getCurrentContext } from "../context.js";

describe("AsyncLocalStorage Context", () => {
  it("returns empty context by default", () => {
    expect(getCurrentContext()).toEqual({});
  });

  it("sets context within withContext scope", async () => {
    await withContext({ task: "test", team: "eng" }, async () => {
      expect(getCurrentContext()).toEqual({ task: "test", team: "eng" });
    });
  });

  it("restores empty context after scope exits", async () => {
    await withContext({ task: "test" }, async () => {
      // Inside scope
    });
    expect(getCurrentContext()).toEqual({});
  });

  it("nests contexts (inner merges with outer)", async () => {
    await withContext({ task: "outer", team: "eng" }, async () => {
      await withContext({ task: "inner", user: "naman" }, async () => {
        const ctx = getCurrentContext();
        expect(ctx).toEqual({
          task: "inner", // overridden by inner
          team: "eng", // preserved from outer
          user: "naman", // added by inner
        });
      });
      // Back to outer
      expect(getCurrentContext()).toEqual({ task: "outer", team: "eng" });
    });
  });

  it("works with sync functions", () => {
    const result = withContext({ task: "sync" }, () => {
      expect(getCurrentContext()).toEqual({ task: "sync" });
      return 42;
    });
    expect(result).toBe(42);
  });
});
