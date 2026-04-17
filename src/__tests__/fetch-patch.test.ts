import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { patchFetch, unpatchFetch } from "../fetch-patch.js";
import { Transport } from "../transport.js";

// Mock transport that captures enqueued events
function createMockTransport() {
  const events: unknown[] = [];
  return {
    transport: {
      enqueue: (event: unknown) => events.push(event),
      start: () => {},
      stop: () => {},
      flush: async () => {},
    } as unknown as Transport,
    events,
  };
}

describe("Fetch Patch", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    unpatchFetch();
    // Restore in case unpatch didn't work
    globalThis.fetch = originalFetch;
  });

  it("passes through non-AI URLs without modification", async () => {
    const mockResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
    });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);
    const fakeFetch = globalThis.fetch;

    const { transport } = createMockTransport();
    patchFetch({
      transport,
      projectId: "test",
      captureBody: true,
      beforeSend: null,
      defaultContext: {},
      debug: false,
    });

    await globalThis.fetch("https://api.example.com/data");

    // The original fetch should have been called
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://api.example.com/data",
      undefined,
    );
  });

  it("intercepts OpenAI calls and captures usage", async () => {
    const openaiResponse = {
      id: "chatcmpl-abc",
      model: "gpt-4o",
      choices: [{ message: { content: "Hello!" } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(openaiResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { transport, events } = createMockTransport();
    patchFetch({
      transport,
      projectId: "test-proj",
      captureBody: true,
      beforeSend: null,
      defaultContext: {},
      debug: false,
    });

    const response = await globalThis.fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      },
    );

    // Response should still work for the user
    const body = await response.json();
    expect((body as Record<string, unknown>).model).toBe("gpt-4o");

    // Wait a tick for async processing
    await new Promise((r) => setTimeout(r, 50));

    // Event should have been captured
    expect(events.length).toBe(1);
    const event = events[0] as Record<string, unknown>;
    expect(event["provider"]).toBe("openai");
    expect(event["model"]).toBe("gpt-4o");
    expect(event["projectId"]).toBe("test-proj");

    const usage = event["usage"] as Record<string, unknown>;
    expect(usage["inputTokens"]).toBe(10);
    expect(usage["outputTokens"]).toBe(5);

    expect(event["costUsd"]).toBeNull(); // Server calculates cost now, SDK sends null
    expect(event["callSite"]).not.toBeNull();
  });

  it("intercepts Anthropic calls", async () => {
    const anthropicResponse = {
      id: "msg_abc",
      model: "claude-sonnet-4-0-20250514",
      content: [{ text: "Hello!" }],
      usage: {
        input_tokens: 20,
        output_tokens: 10,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(anthropicResponse), { status: 200 }),
    );

    const { transport, events } = createMockTransport();
    patchFetch({
      transport,
      projectId: "test",
      captureBody: true,
      beforeSend: null,
      defaultContext: {},
      debug: false,
    });

    await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-0-20250514", messages: [] }),
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(events.length).toBe(1);
    const event = events[0] as Record<string, unknown>;
    expect(event["provider"]).toBe("anthropic");
  });

  it("injects stream_options for OpenAI streaming requests", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("data: [DONE]\n\n", { status: 200 }),
    );
    const fakeFetch = globalThis.fetch;

    const { transport } = createMockTransport();
    patchFetch({
      transport,
      projectId: "test",
      captureBody: true,
      beforeSend: null,
      defaultContext: {},
      debug: false,
    });

    await globalThis.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [] }),
    });

    // Check that the request body was modified
    const callArgs = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse(callArgs[1].body as string);
    expect(sentBody.stream_options).toEqual({ include_usage: true });
  });

  it("respects beforeSend hook", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "gpt-4o",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 },
      ),
    );

    const { transport, events } = createMockTransport();
    patchFetch({
      transport,
      projectId: "test",
      captureBody: true,
      beforeSend: (event) => {
        // Scrub request body
        event.requestBody = null;
        return event;
      },
      defaultContext: {},
      debug: false,
    });

    await globalThis.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "secret" }] }),
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(events.length).toBe(1);
    expect((events[0] as Record<string, unknown>)["requestBody"]).toBeNull();
  });

  it("drops event when beforeSend returns null", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "gpt-4o",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 },
      ),
    );

    const { transport, events } = createMockTransport();
    patchFetch({
      transport,
      projectId: "test",
      captureBody: true,
      beforeSend: () => null, // Drop all events
      defaultContext: {},
      debug: false,
    });

    await globalThis.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(events.length).toBe(0);
  });

  it("never throws even when transport fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "gpt-4o",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 },
      ),
    );

    const transport = {
      enqueue: () => {
        throw new Error("Transport exploded!");
      },
      start: () => {},
      stop: () => {},
      flush: async () => {},
    } as unknown as Transport;

    patchFetch({
      transport,
      projectId: "test",
      captureBody: true,
      beforeSend: null,
      defaultContext: {},
      debug: false,
    });

    // Should NOT throw
    const response = await globalThis.fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      },
    );

    // User still gets their response
    const body = await response.json();
    expect((body as Record<string, unknown>).model).toBe("gpt-4o");
  });

  it("blocks AI calls when daily budget is exceeded (throw policy)", async () => {
    const openaiResponse = {
      id: "chatcmpl-abc",
      model: "gpt-4o",
      choices: [{ message: { content: "Hello!" } }],
      // Large usage so the FIRST call blows the $0.01 budget
      usage: {
        prompt_tokens: 10_000,
        completion_tokens: 5_000,
        total_tokens: 15_000,
      },
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(openaiResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { transport } = createMockTransport();
    patchFetch({
      transport,
      projectId: "test",
      captureBody: true,
      beforeSend: null,
      defaultContext: {},
      debug: false,
      budget: { daily: 0.01, onExceed: "throw" },
    });

    // First call succeeds (budget starts at $0), but records ~$0.075 of spend
    // (10k input * $2.50/M + 5k output * $10/M = $0.025 + $0.050 = $0.075)
    await globalThis.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });

    // Wait for the async record() to commit (processNonStreamingResponse is fire-and-forget)
    await new Promise((r) => setTimeout(r, 50));

    // Second call should throw because budget is now blown
    await expect(
      globalThis.fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
    ).rejects.toThrow(/budget exceeded/i);
  });

  it("returns synthetic 429 when budget exceeded and policy is 'block'", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ usage: { prompt_tokens: 10_000, completion_tokens: 5_000, total_tokens: 15_000 }, model: "gpt-4o" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { transport } = createMockTransport();
    patchFetch({
      transport,
      projectId: "test",
      captureBody: true,
      beforeSend: null,
      defaultContext: {},
      debug: false,
      budget: { daily: 0.01, onExceed: "block" },
    });

    await globalThis.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    await new Promise((r) => setTimeout(r, 50));

    const second = await globalThis.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(second.status).toBe(429);
    expect(second.headers.get("X-CostKey-Blocked")).toBe("1");
    const body = await second.json() as { error: { type: string } };
    expect(body.error.type).toBe("costkey_blocked");
  });

  it("patched fetch has a distinctive name so bundlers can't hide the SDK frame", () => {
    // Regression: pre-v0.3.1 the wrapper was an inline `async function
    // costKeyFetchWrapper`. Webpack minified the inner name to a single letter
    // and V8 displayed the frame as `G.globalThis.fetch` — the server's frame
    // filter couldn't distinguish it from user code, so our own SDK appeared
    // in users' "cost by function" dashboards.
    const { transport } = createMockTransport();
    patchFetch({
      transport,
      projectId: "test",
      captureBody: true,
      beforeSend: null,
      defaultContext: {},
      debug: false,
    });
    expect(globalThis.fetch.name).toBe("__ck_patched_fetch__");
  });
});
