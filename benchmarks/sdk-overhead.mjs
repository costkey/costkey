#!/usr/bin/env node

/**
 * Local-only CostKey SDK overhead benchmark.
 *
 * This intentionally measures the application-visible latency of a local
 * supported-provider-shaped request, not a real provider or network path.
 * Build the SDK first (`npm run build --workspace=costkey`), then run:
 *
 *   node packages/sdk/benchmarks/sdk-overhead.mjs
 *
 * Optional flags:
 *   --iterations=500  timed samples per mode
 *   --warmup=100      untimed warmup samples per mode
 */

import { createServer } from "node:http";
import { once } from "node:events";
import { versions } from "node:process";
import { CostKey } from "../dist/index.js";
import { addCaptureTarget } from "../dist/providers/registry.js";

const args = parseArgs(process.argv.slice(2));
const iterations = positiveInteger(args.iterations, 500);
const warmup = nonNegativeInteger(args.warmup, 100);

const servers = [];
const state = {
  configRequests: 0,
  ingestRequests: 0,
  policyRequests: 0,
  providerRequests: 0,
  invalidPolicyRequests: 0,
};

let originalFetch = globalThis.fetch;
let safeFetch;
const originalConsoleLog = console.log;
console.log = () => {};

try {
  const provider = createServer((_request, response) => {
    state.providerRequests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "benchmark-provider-request",
      model: "benchmark-model",
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { input_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    }));
  });
  await listen(provider);
  servers.push(provider);
  const providerUrl = `http://127.0.0.1:${address(provider).port}/benchmark-provider`;

  const api = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (requestUrl.pathname === "/api/v1/projects/benchmark-project/config" && request.method === "GET") {
      state.configRequests++;
      writeJson(response, 200, {
        projectId: "benchmark-project",
        capture: {
          mode: "metadata",
          bodyCaptureEnabled: false,
          redactionEnabled: true,
          bodyRetentionDays: 7,
          metadataRetentionDays: 30,
        },
        providers: [],
      });
      return;
    }
    if (requestUrl.pathname === "/api/v1/events" && request.method === "POST") {
      state.ingestRequests++;
      await readBody(request);
      writeJson(response, 202, { accepted: true });
      return;
    }
    if (requestUrl.pathname === "/api/v1/sdk/policy/admit" && request.method === "POST") {
      const body = await readJson(request);
      if (body?.requestBody !== undefined || body?.providerRequest !== undefined) {
        state.invalidPolicyRequests++;
      }
      state.policyRequests++;
      writeJson(response, 200, {
        decision: "allow",
        replay: false,
        providerCallAllowed: true,
        reservationId: null,
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await listen(api);
  servers.push(api);
  const apiUrl = `http://127.0.0.1:${address(api).port}`;

  safeFetch = async (input, init) => {
    const target = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const targetUrl = new URL(target);
    if (targetUrl.hostname !== "127.0.0.1") {
      throw new Error(`benchmark attempted a non-loopback request: ${targetUrl.hostname}`);
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = safeFetch;

  // The loopback provider joins the capture filter (the SDK only matches hosts).
  addCaptureTarget({
    label: "benchmark",
    match: (url) => url.hostname === "127.0.0.1" && url.pathname === "/benchmark-provider",
  });

  const unpatched = await sampleMode(
    "unpatched fetch",
    () => originalFetch(providerUrl, requestInit()),
    iterations,
    warmup,
  );

  CostKey.init({
    dsn: `http://ck_benchmark_local@127.0.0.1:${address(api).port}/benchmark-project`,
    captureBody: false,
    maxBatchSize: 100_000,
    flushInterval: 60_000,
    configRefreshInterval: 60_000,
  });
  await waitFor(() => state.configRequests > 0);
  const observation = await sampleMode(
    "initialized metadata-only observation",
    () => globalThis.fetch(providerUrl, requestInit()),
    iterations,
    warmup,
  );
  await CostKey.flush();
  await CostKey.shutdown();

  CostKey.init({
    dsn: `http://ck_benchmark_local@127.0.0.1:${address(api).port}/benchmark-project`,
    captureBody: false,
    maxBatchSize: 100_000,
    flushInterval: 60_000,
    configRefreshInterval: 60_000,
    policy: {
      mode: "monitor",
      endpoint: `${apiUrl}/api/v1/sdk/policy/admit`,
      timeout: 2_000,
    },
  });
  await waitFor(() => state.configRequests > 1);
  const policy = await sampleMode(
    "initialized metadata-only observation plus local policy admission",
    () => globalThis.fetch(providerUrl, requestInit()),
    iterations,
    warmup,
  );
  await CostKey.flush();
  await CostKey.shutdown();

  if (state.invalidPolicyRequests !== 0) {
    throw new Error("policy benchmark observed a body-bearing admission request");
  }

  const output = {
    benchmark: "costkey-sdk-overhead",
    generatedAt: new Date().toISOString(),
    environment: {
      node: versions.node,
      platform: process.platform,
      arch: process.arch,
      sdk: "packages/sdk/dist/index.js",
    },
    configuration: { iterations, warmup },
    modes: [unpatched, observation, policy],
    localCounters: state,
    boundary: {
      provider: "loopback-only synthetic supported-provider response",
      ingest: "loopback-only synthetic 202 endpoint",
      policy: "loopback-only synthetic allow endpoint; no reservation",
      externalNetwork: "forbidden by benchmark fetch guard",
      interpretation: "machine-specific timing evidence, not real-provider or deployed-service performance",
    },
  };
  process.stdout.write(`${renderMarkdown(output)}\n`);
} finally {
  await Promise.resolve(CostKey.shutdown()).catch(() => undefined);
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
  await Promise.all(servers.map((server) => close(server)));
}

function requestInit() {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "benchmark-model", messages: [{ role: "user", content: "benchmark" }] }),
  };
}

async function sampleMode(name, request, count, warmupCount) {
  for (let index = 0; index < warmupCount; index++) await consume(request());
  const samples = [];
  for (let index = 0; index < count; index++) {
    const started = process.hrtime.bigint();
    await consume(request());
    samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
  }
  samples.sort((left, right) => left - right);
  return {
    name,
    samples: samples.length,
    milliseconds: {
      p50: percentile(samples, 0.50),
      p95: percentile(samples, 0.95),
      min: samples[0],
      max: samples[samples.length - 1],
      mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    },
  };
}

async function consume(promise) {
  const response = await promise;
  if (!response.ok) throw new Error(`local benchmark request failed: HTTP ${response.status}`);
  await response.json();
}

function percentile(samples, quantile) {
  const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * quantile) - 1));
  return round(samples[index]);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function parseArgs(values) {
  const result = {};
  for (const value of values) {
    const match = /^--([a-z]+)=(.+)$/.exec(value);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("--iterations must be a positive integer");
  return parsed;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("--warmup must be a non-negative integer");
  return parsed;
}


function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  for await (const _chunk of request) {
    // Consume the request without retaining or logging its contents.
  }
}

async function readJson(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

function address(server) {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("benchmark server failed to bind");
  return value;
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor(check) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for local SDK config request");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function renderMarkdown(output) {
  const lines = [
    "# CostKey SDK overhead benchmark",
    "",
    `Generated: ${output.generatedAt}`,
    "",
    "This is local, machine-specific timing evidence. It uses loopback-only synthetic provider, ingest, and policy endpoints; it is not representative-provider, deployed-service, or marketing performance evidence.",
    "",
    `Environment: Node ${output.environment.node}; ${output.environment.platform}/${output.environment.arch}; source ${output.environment.sdk}.`,
    `Configuration: ${output.configuration.samples ?? output.configuration.iterations} timed iterations per mode; ${output.configuration.warmup} warmup iterations per mode.`,
    "",
    "| Mode | Samples | p50 ms | p95 ms | Mean ms | Min ms | Max ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const mode of output.modes) {
    lines.push(`| ${mode.name} | ${mode.samples} | ${mode.milliseconds.p50} | ${mode.milliseconds.p95} | ${round(mode.milliseconds.mean)} | ${mode.milliseconds.min} | ${mode.milliseconds.max} |`);
  }
  lines.push(
    "",
    "## Boundary",
    "",
    `- Provider: ${output.boundary.provider}.`,
    `- Ingest: ${output.boundary.ingest}.`,
    `- Policy: ${output.boundary.policy}.`,
    `- External network: ${output.boundary.externalNetwork}.`,
    `- Interpretation: ${output.boundary.interpretation}.`,
    "",
    "## Counters",
    "",
    `- Provider requests: ${output.localCounters.providerRequests}.`,
    `- Runtime config requests: ${output.localCounters.configRequests}.`,
    `- Ingest requests: ${output.localCounters.ingestRequests}.`,
    `- Policy admission requests: ${output.localCounters.policyRequests}.`,
    `- Body-bearing policy requests detected: ${output.localCounters.invalidPolicyRequests}.`,
    "",
    "The benchmark script prints a fresh report on each run. Do not compare runs across machines, Node versions, SDK builds, load conditions, or network environments without recording those changes.",
  );
  return lines.join("\n");
}
