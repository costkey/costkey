/**
 * Shared harness for framework integration tests: the real framework runs,
 * only the HTTP layer is mocked. Provider routes answer model requests; the
 * CostKey ingest endpoint collects what the SDK sends.
 */
import { CostKey } from "../../index.js";
import { wireBody } from "../wireBody";

export type Event = Record<string, any>;
export type Route = (url: URL, init: RequestInit | undefined, body: unknown) => Response | Promise<Response> | null | undefined;

export interface Harness {
  events(): Event[];
  /** Forget events collected so far (one harness can serve several tests). */
  reset(): void;
  calls(): Event[];
  spans(): Event[];
  /** End records of spans (status != running), in end order. */
  endedSpans(): Event[];
  lifecycle(): Event[];
  providerRequests: Array<{ url: string; body: unknown }>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function sse(records: unknown[]): Response {
  return new Response(records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Install the mock network, then init CostKey so its fetch patch wraps it. */
export function startHarness(route: Route, options: { captureBody?: boolean; project?: string } = {}): Harness {
  const original = globalThis.fetch;
  const payloads: Event[] = [];
  const providerRequests: Array<{ url: string; body: unknown }> = [];
  const project = options.project ?? "integration-test";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.hostname === "costkey.dev") {
      if (url.pathname === "/api/v1/events") {
        payloads.push(...(JSON.parse(wireBody(init)) as { events: Event[] }).events);
        return json({ accepted: true }, 202);
      }
      if (url.pathname.endsWith("/config")) {
        return json({
          projectId: project,
          capture: { mode: options.captureBody ? "text" : "metadata", bodyCaptureEnabled: !!options.captureBody, redactionEnabled: true },
          providers: [],
        });
      }
      return json({}, 404);
    }
    let text: string | null = null;
    if (typeof init?.body === "string") text = init.body;
    else if (input instanceof Request && !init?.body) text = await input.clone().text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    providerRequests.push({ url: url.href, body });
    const response = await route(url, init, body);
    if (!response) throw new Error(`unexpected request in test: ${url.href}`);
    return response;
  }) as typeof fetch;
  CostKey.init({ dsn: `https://ck_test@costkey.dev/${project}`, captureBody: options.captureBody ?? false, maxBatchSize: 500 });
  const events = () => payloads;
  return {
    events,
    reset() {
      payloads.length = 0;
      providerRequests.length = 0;
    },
    calls: () => payloads.filter((event) => event["eventType"] === "call"),
    spans: () => payloads.filter((event) => event["eventType"] === "span"),
    endedSpans: () => payloads.filter((event) => event["eventType"] === "span" && event["status"] !== "running"),
    lifecycle: () => payloads.filter((event) => event["eventType"] === "lifecycle"),
    providerRequests,
    flush: () => CostKey.flush(),
    async close() {
      await CostKey.shutdown();
      globalThis.fetch = original;
    },
  };
}

/** Wait until runtime config has been applied (it gates content capture). */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
