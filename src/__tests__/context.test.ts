import { afterEach, describe, it, expect } from "vitest";
import {
  getCurrentContext,
  exportContext,
  resetLifecycleState,
  setLifecycleEmitter,
  startExecution,
  startTrace,
  withContext,
} from "../context.js";

afterEach(() => {
  setLifecycleEmitter(null);
  resetLifecycleState();
});

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

  it("keeps nested traces fresh unless the caller explicitly joins", async () => {
    const records: Array<{ entityType: string; entityId: string; lifecycle: string }> = [];
    setLifecycleEmitter((record) => records.push(record));
    let outerTrace = "";
    let innerTrace = "";
    await startTrace({ name: "outer" }, async () => {
      outerTrace = getCurrentContext().traceId ?? "";
      await startTrace({ name: "inner" }, () => {
        innerTrace = getCurrentContext().traceId ?? "";
      });
      await startTrace({ name: "joined", traceId: outerTrace }, () => {
        expect(getCurrentContext().traceId).toBe(outerTrace);
      });
    });
    expect(innerTrace).not.toBe(outerTrace);
    expect(records.filter((record) => record.entityType === "trace" && record.lifecycle === "started").map((record) => record.entityId)).toEqual([outerTrace, innerTrace]);
  });

  it("joins an imported trace outside a boundary but freshens nested boundaries", async () => {
    await withContext({ traceId: "upstream-trace" }, async () => {
      await startTrace({ name: "joined" }, () => {
        expect(getCurrentContext().traceId).toBe("upstream-trace");
        return startTrace({ name: "nested" }, () => {
          expect(getCurrentContext().traceId).not.toBe("upstream-trace");
        });
      });
    });
  });

  it("emits runner supplied execution item counts", async () => {
    const records: Array<Record<string, unknown>> = [];
    setLifecycleEmitter((record) => records.push(record as unknown as Record<string, unknown>));
    await startExecution({
      name: "nightly",
      expectedItems: 10,
      completedItems: 8,
      failedItems: 2,
    }, () => undefined);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ expectedItems: 10, completedItems: 8, failedItems: 2 });
    expect(records[1]).toMatchObject({ expectedItems: 10, completedItems: 8, failedItems: 2 });
  });

  it("keeps nested execution invocations fresh unless an ID is explicit", async () => {
    let outerExecution = "";
    let innerExecution = "";
    await startExecution({ name: "outer" }, async () => {
      outerExecution = getCurrentContext().executionId ?? "";
      await startExecution({ name: "inner" }, () => {
        innerExecution = getCurrentContext().executionId ?? "";
      });
      await startExecution({ name: "joined", executionId: outerExecution }, () => {
        expect(getCurrentContext().executionId).toBe(outerExecution);
      });
    });
    expect(innerExecution).not.toBe(outerExecution);
  });

  it("allowlists conversation and voice identities for explicit carriers", async () => {
    await withContext({
      conversationId: "conversation-1",
      voiceSessionId: "voice-1",
      privateLabel: "stay-local",
    }, () => {
      const carrier = exportContext();
      expect(carrier).toMatchObject({
        conversationId: "conversation-1",
        voiceSessionId: "voice-1",
      });
      expect(carrier).not.toHaveProperty("privateLabel");
    });
  });
});
