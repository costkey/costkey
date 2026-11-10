import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { extractFrames, MAX_FRAME_BYTES, type FrameUpload } from "../frames.js";
import { flushPendingCaptures, patchFetch, unpatchFetch } from "../fetch-patch.js";
import { Transport, framesEndpoint } from "../transport.js";
import { CostKey } from "../index.js";
import { addCaptureTarget } from "../providers/registry.js";
import type { BeforeSendHook } from "../types.js";
import { wireBody } from "./wireBody";

type Event = Record<string, any>;

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A fake PNG: the real signature plus filler, so sniffing and hashing see distinct images. */
function png(fill: number, size = 200): { base64: string; sha256: string; bytes: number } {
  const bytes = Buffer.concat([PNG_HEADER, Buffer.alloc(size, fill)]);
  return { base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("extractFrames", () => {
  it("finds images in each provider's request shape, in order", () => {
    const a = png(1), b = png(2), c = png(3), d = png(4);
    const frames = extractFrames({
      // Anthropic: base64 source part
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: a.base64 } }] },
        // OpenAI chat: data URI
        { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${b.base64}` } }] },
      ],
      // OpenAI Responses: input_image with a data URI; Gemini: inline_data
      input: [{ type: "computer_call_output", output: { type: "input_image", image_url: `data:image/png;base64,${c.base64}` } }],
      contents: [{ parts: [{ inline_data: { mime_type: "image/png", data: d.base64 } }] }],
    });
    expect(frames.refs.map((ref) => ref.sha256)).toEqual([a.sha256, b.sha256, c.sha256, d.sha256]);
    expect(frames.refs[0]).toEqual({ sha256: a.sha256, mediaType: "image/png", bytes: a.bytes });
    expect([...frames.uploads.keys()]).toEqual([a.sha256, b.sha256, c.sha256, d.sha256]);
    expect(Buffer.from(frames.uploads.get(a.sha256)!.bytes).toString("base64")).toBe(a.base64);
  });

  it("sniffs the type of an image part that doesn't declare one, and ignores other media", () => {
    const a = png(5);
    const frames = extractFrames({
      parts: [
        { type: "image", data: a.base64 },
        { type: "input_audio", input_audio: { data: Buffer.alloc(300, 7).toString("base64"), format: "wav" } },
        { data: Buffer.alloc(300, 8).toString("base64"), mime_type: "audio/wav" },
      ],
    });
    expect(frames.refs).toEqual([{ sha256: a.sha256, mediaType: "image/png", bytes: a.bytes }]);
  });

  it("lists a history image every time it appears but uploads it once", () => {
    const a = png(9), b = png(10);
    const part = (image: { base64: string }) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: image.base64 } });
    const frames = extractFrames({ messages: [{ content: [part(a)] }, { content: [part(a)] }, { content: [part(b)] }] });
    expect(frames.refs.map((ref) => ref.sha256)).toEqual([a.sha256, a.sha256, b.sha256]);
    expect(frames.uploads.size).toBe(2);
  });

  it("lists an image over the size cap without uploading it", () => {
    const big = png(11, MAX_FRAME_BYTES + 1);
    const frames = extractFrames({ image_url: `data:image/png;base64,${big.base64}` });
    expect(frames.refs).toEqual([{ sha256: big.sha256, mediaType: "image/png", bytes: big.bytes, omitted: "too_large" }]);
    expect(frames.uploads.size).toBe(0);
  });
});

describe("screen capture through fetch", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    unpatchFetch();
    globalThis.fetch = originalFetch;
  });

  async function call(body: unknown, options: { screens: boolean; captureBody?: boolean; beforeSend?: BeforeSendHook }) {
    globalThis.fetch = vi.fn(async () => json({ id: "msg_1" })) as unknown as typeof fetch;
    const events: Event[] = [];
    const frames: FrameUpload[] = [];
    const transport = {
      enqueue: (event: Event) => events.push(event),
      enqueueFrame: (frame: FrameUpload) => frames.push(frame),
      start: () => {},
      stop: () => {},
      flush: async () => {},
    } as unknown as Transport;
    patchFetch({
      transport,
      projectId: "screens",
      captureBody: options.captureBody ?? false,
      captureScreensRef: { current: options.screens },
      beforeSend: options.beforeSend ?? null,
      defaultContext: {},
      debug: false,
    });
    await globalThis.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify(body) });
    await flushPendingCaptures();
    return { event: events[0]!, frames };
  }

  const screenshotRequest = (image: { base64: string }) => ({
    model: "claude-sonnet-4-5",
    messages: [{
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: image.base64 } }] }],
    }],
  });

  it("lists the request's images on the call and queues their bytes", async () => {
    const shot = png(20);
    const { event, frames } = await call(screenshotRequest(shot), { screens: true });
    expect(event["frames"]).toEqual([{ sha256: shot.sha256, mediaType: "image/png", bytes: shot.bytes }]);
    expect(frames.map((frame) => frame.sha256)).toEqual([shot.sha256]);
    expect(frames[0]!.mediaType).toBe("image/png");
    // The skeleton still carries only the length of the image data.
    expect(JSON.stringify(event["telemetry"])).not.toContain(shot.base64);
  });

  it("names the frame in a captured body's placeholder", async () => {
    const shot = png(21);
    const { event } = await call(screenshotRequest(shot), { screens: true, captureBody: true });
    const body = JSON.stringify(event["requestBody"]);
    expect(body).toContain(`[image data omitted: image/png; ~`);
    expect(body).toContain(`; frame ${shot.sha256}]`);
    expect(body).not.toContain(shot.base64);
  });

  it("sends no frames when screen capture is off", async () => {
    const shot = png(22);
    const { event, frames } = await call(screenshotRequest(shot), { screens: false, captureBody: true });
    expect(event).not.toHaveProperty("frames");
    expect(frames).toEqual([]);
    expect(JSON.stringify(event["requestBody"])).not.toContain("; frame ");
  });

  it("uploads only the frames beforeSend leaves on the event", async () => {
    const shot = png(23);
    const { event, frames } = await call(screenshotRequest(shot), {
      screens: true,
      beforeSend: (built) => ({ ...built, frames: [] }),
    });
    expect(event["frames"]).toEqual([]);
    expect(frames).toEqual([]);
  });

  it("strips a frame list a hook adds while screen capture is off", async () => {
    const { event, frames } = await call({ model: "claude-sonnet-4-5", messages: [] }, {
      screens: false,
      beforeSend: (built) => ({ ...built, frames: [{ sha256: "a".repeat(64), mediaType: "image/png", bytes: 1 }] }),
    });
    expect(event).not.toHaveProperty("frames");
    expect(frames).toEqual([]);
  });
});

describe("frame uploads in the transport", () => {
  let originalFetch: typeof globalThis.fetch;
  let requests: Array<{ url: string; init: RequestInit }>;
  let respond: (url: string) => Response | Promise<Response>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requests = [];
    respond = () => new Response(null, { status: 201 });
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init: init ?? {} });
      return respond(url);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const transport = () => new Transport({
    endpoint: "https://costkey.dev/api/v1/events",
    authKey: "ck_test",
    maxBatchSize: 50,
    flushInterval: 60_000,
    debug: false,
  });
  const upload = (image: { base64: string; sha256: string }): FrameUpload =>
    ({ sha256: image.sha256, mediaType: "image/png", bytes: Buffer.from(image.base64, "base64") });

  it("derives the frames endpoint from the events endpoint", () => {
    expect(framesEndpoint("https://costkey.dev/api/v1/events")).toBe("https://costkey.dev/api/v1/frames");
    expect(framesEndpoint("https://self.host/ck/api/v1/events/")).toBe("https://self.host/ck/api/v1/frames");
  });

  it("PUTs each image's bytes once, keyed by hash", async () => {
    const t = transport();
    const shot = png(30);
    t.enqueueFrame(upload(shot));
    t.enqueueFrame(upload(shot));
    await t.flush();
    t.enqueueFrame(upload(shot));
    await t.flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`https://costkey.dev/api/v1/frames/${shot.sha256}`);
    expect(requests[0]!.init.method).toBe("PUT");
    const headers = requests[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("image/png");
    expect(headers["Authorization"]).toBe("Bearer ck_test");
    expect(Buffer.from(requests[0]!.init.body as Uint8Array).toString("base64")).toBe(shot.base64);
  });

  it("stops uploading for the process when the server doesn't take frames", async () => {
    respond = () => new Response(null, { status: 404 });
    const t = transport();
    t.enqueueFrame(upload(png(31)));
    await t.flush();
    t.enqueueFrame(upload(png(32)));
    await t.flush();
    expect(requests).toHaveLength(1);
  });

  it("retries a rate-limited frame on the next flush", async () => {
    let status = 429;
    respond = () => new Response(null, { status });
    const t = transport();
    const shot = png(33);
    t.enqueueFrame(upload(shot));
    await t.flush();
    status = 201;
    await t.flush();
    expect(requests.map((request) => request.url)).toEqual([
      `https://costkey.dev/api/v1/frames/${shot.sha256}`,
      `https://costkey.dev/api/v1/frames/${shot.sha256}`,
    ]);
  });

  it("forgets a frame that failed to send, so a later resend uploads it", async () => {
    respond = () => { throw new Error("offline"); };
    const t = transport();
    const shot = png(34);
    t.enqueueFrame(upload(shot));
    await t.flush();
    respond = () => new Response(null, { status: 201 });
    t.enqueueFrame(upload(shot));
    await t.flush();
    expect(requests).toHaveLength(2);
  });
});

// A real local HTTP endpoint added to the capture filter.
addCaptureTarget({
  label: "fake-screens",
  match: (url) => url.hostname === "127.0.0.1" && url.pathname === "/fake-vision",
});

describe("screen capture settings", () => {
  let originalFetch: typeof globalThis.fetch;
  let provider: Server;
  let providerUrl: string;
  let events: Event[];
  let frameUrls: string[];

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    events = [];
    frameUrls = [];
    provider = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id: "msg_1" }));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("fake provider did not bind");
    providerUrl = `http://127.0.0.1:${address.port}/fake-vision`;
  });

  afterEach(async () => {
    await CostKey.shutdown();
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });

  async function run(project: string, captureScreens: boolean | undefined, screenCaptureEnabled: boolean | undefined) {
    let configRequests = 0;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `https://costkey.dev/api/v1/projects/${project}/config`) {
        configRequests++;
        return new Response(JSON.stringify({
          projectId: project,
          capture: {
            mode: "metadata",
            bodyCaptureEnabled: false,
            redactionEnabled: true,
            ...(screenCaptureEnabled === undefined ? {} : { screenCaptureEnabled }),
          },
          providers: [],
        }), { status: 200 });
      }
      if (url === "https://costkey.dev/api/v1/events") {
        const text = wireBody(init);
        events.push(...((text ? JSON.parse(text) : { events: [] }) as { events: Event[] }).events);
        return new Response("{}", { status: 202 });
      }
      if (url.startsWith("https://costkey.dev/api/v1/frames/")) {
        frameUrls.push(url);
        return new Response(null, { status: 201 });
      }
      return originalFetch(input, init);
    };
    CostKey.init({ dsn: `https://ck_test@costkey.dev/${project}`, captureScreens, maxBatchSize: 100 });
    const started = Date.now();
    while (configRequests < 1 && Date.now() - started < 250) await new Promise((resolve) => setTimeout(resolve, 2));
    await new Promise((resolve) => setTimeout(resolve, 2));
    const shot = png(40);
    await fetch(providerUrl, {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: shot.base64 } }] }] }),
    });
    await CostKey.flush();
    return { call: events.find((event) => event["eventType"] === "call"), shot };
  }

  it("uploads frames when the app opts in and the project allows it, even in metadata mode", async () => {
    const { call, shot } = await run("screens-on", true, true);
    expect(call?.["frames"]).toEqual([{ sha256: shot.sha256, mediaType: "image/png", bytes: shot.bytes }]);
    expect(call?.["requestBody"]).toBeNull();
    expect(frameUrls).toEqual([`https://costkey.dev/api/v1/frames/${shot.sha256}`]);
  });

  it("stays off when the project hasn't turned screen capture on", async () => {
    const { call } = await run("screens-project-off", true, undefined);
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("frames");
    expect(frameUrls).toEqual([]);
  });

  it("stays off when the app hasn't opted in", async () => {
    const { call } = await run("screens-local-off", undefined, true);
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("frames");
    expect(frameUrls).toEqual([]);
  });
});
