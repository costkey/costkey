# costkey

> Sentry for AI costs. One line of code sends raw telemetry for every AI call and agent step; the CostKey server works out cost, tokens and usage.

## Install

```bash
npm install costkey
```

## Quick Start

```typescript
import { CostKey } from 'costkey'

CostKey.init({
  dsn: 'http://ck_your_key@localhost:4100/your-project'
})

// Supported provider calls made through fetch are tracked automatically.
```

## How It Works

The SDK only sends telemetry. It does no processing in your app: no pricing,
no token counting, no model or provider detection, no usage normalization.
CostKey patches `globalThis.fetch`. When your code calls a provider host on
the capture list:

1. **Matches** the host (the capture filter is the only provider knowledge in the SDK)
2. **Records** the request and response as a *skeleton*: every key and number
   is kept, every string becomes its length (`{"$s": 42}`) unless it is an
   identifier such as `model` or `id`. Prompts and completions never leave
   your process unless you turn on body capture
3. **Passes streams through** untouched and records their chunks (as
   skeletons) with first- and last-chunk timing
4. **Captures** the full stack trace (every frame; the server picks the call site)
5. **Ships** the event asynchronously; the server identifies the provider and
   model, extracts usage and prices it

The one change the SDK makes to a request is `stream_options.include_usage`
on streamed Chat Completions calls to hosts that need it, so the final chunk
reports usage. Non-AI fetch calls pass through untouched. Capture and delivery
failures stay inside the SDK; provider errors remain visible to your
application.

### What a call event carries

```jsonc
"telemetry": {
  "v": 1,
  "request":  { "method": "POST", "url": "https://api.openai.com/v1/chat/completions",
                "headers": { "content-type": "application/json" },
                "body": { "model": "gpt-4o", "messages": [{ "role": { "$s": 4 }, "content": { "$s": 812 } }] },
                "bytes": 940 },
  "response": { "status": 200, "headers": { "x-request-id": "req_..." },
                "body": { "id": "chatcmpl-...", "model": "gpt-4o-2024-08-06",
                          "usage": { "prompt_tokens": 210, "completion_tokens": 41 } }, "bytes": 1022 },
  "stream": null,          // or { "format": "sse", "chunks": [...], "chunkCount": 214, "firstChunkMs": 412.5, "lastChunkMs": 3120.2 }
  "error": null,           // or { "name": "AbortError", "code": "ECONNRESET" } (never the message)
  "startedAt": "2026-10-11T09:00:00.000Z",
  "durationMs": 3121.4
}
```

Secrets are removed before anything is sent: `key`, `api_key`, `token`,
`auth*`, `sig`, `x-amz-*` and similar query parameters are dropped (the rest
of the query is kept), only a short allowlist of request headers is sent, and
cookies, authorization and API-key response headers are dropped. Arrays over
32 items keep 8 (embedding vectors don't ship), skeletons are capped at 64 KB
and streams over 200 chunks keep the first 20 and the last 50. The full
contract is in [`RAW_TELEMETRY.md`](../shared/RAW_TELEMETRY.md).

## Releases and commits

Every call carries the release it ran on, so the console can compare one
deploy with the one before it and link each release to its commit. Without a
`release`, the SDK uses `COSTKEY_RELEASE`, then the commit SHA it finds in
CI and hosting variables (`GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`,
`RENDER_GIT_COMMIT`, `RAILWAY_GIT_COMMIT_SHA`, `CI_COMMIT_SHA` and others) or
in `.git`. The repository comes from the same places, or `COSTKEY_REPOSITORY`.

Where the platform sets none of these (Cloud Run, a plain container), pass the
commit at deploy time:

```bash
gcloud run deploy app --update-env-vars COSTKEY_COMMIT=$GITHUB_SHA,COSTKEY_REPOSITORY=https://github.com/acme/app
```

## Sourcemaps

For minified production builds, set `release` and upload sourcemaps:

```typescript
CostKey.init({
  dsn: '...',
  release: process.env.GIT_SHA  // matches uploaded sourcemaps
})
```

```bash
# In CI/CD
npx costkey sourcemaps upload \
  --release $GIT_SHA \
  --auth-key $COSTKEY_AUTH_KEY \
  ./dist/*.map
```

## Tracing

```typescript
app.use((req, res, next) => {
  CostKey.startTrace({ name: `${req.method} ${req.path}` }, next)
})
```

`startTrace` emits explicit started/completed/failed lifecycle records. Trace
IDs are generated per invocation, so concurrent requests and nested boundaries
cannot be merged by their stack frames. If a trusted upstream carrier is
already in context, `startTrace()` joins that trace; pass `traceId` explicitly
when a nested boundary is intentionally part of an existing trace.

## Context

```typescript
await CostKey.withContext({ task: 'summarize', team: 'search' }, async () => {
  await openai.chat.completions.create({ ... })
})
```

## Agents

Record an agent run as a tree of spans. Model calls are attributed to the
innermost span, and the run page shows cost and latency at each level.

```typescript
await CostKey.agent('dash', async (span) => {
  span.setAttribute('model', 'gpt-5.1')
  await CostKey.tool('get_holdings', () => holdings(userId))
  await CostKey.step('answer', () => writeAnswer())
})

// Any framework whose tools expose `execute`: each call becomes a tool span
const tools = CostKey.instrumentTools({ getHoldings, searchFunds })
```

## Agent framework integrations

Most agents run on a framework. Each integration is a subpath export with an
optional peer dependency, so nothing is imported unless you use it. An
integration only opens and closes spans and attaches the framework's raw data
(a skeleton unless body capture is on). Model calls made in your process are
already recorded by the fetch patch and are attributed to the span they ran
in, so integrations never emit a second call event. The Claude Agent SDK is
the exception: its model calls run in a separate Claude Code process.

**OpenAI Agents SDK** (`@openai/agents`): agents, function tools, handoffs,
guardrails and turns.

```typescript
import { addTraceProcessor } from '@openai/agents'
import { CostKeyAgentsProcessor } from 'costkey/integrations/openai-agents'

addTraceProcessor(new CostKeyAgentsProcessor())
```

The Agents SDK disables tracing when `NODE_ENV=test`; call
`setTracingDisabled(false)` in tests.

**Vercel AI SDK** (`ai` 7+): `generateText` / `streamText` runs (and
`ToolLoopAgent`), their steps and tool executions, with no wrapping.

```typescript
import { registerTelemetry } from 'ai'
import { costkeyTelemetry } from 'costkey/integrations/ai-sdk'

registerTelemetry(costkeyTelemetry())
// Runs are named by `telemetry: { functionId }` when you set it.
```

AI SDK 4–6 have no telemetry-integration API: enable their
`experimental_telemetry` OpenTelemetry spans and use the OpenTelemetry bridge
below.

**Mastra** (`@mastra/core` 1.x with `@mastra/observability`): agent runs,
workflows, workflow steps and tool calls.

```typescript
import { Observability } from '@mastra/observability'
import { CostKeyMastraBridge } from 'costkey/integrations/mastra'

new Mastra({
  agents, workflows,
  observability: new Observability({
    configs: { default: { serviceName: 'api', bridge: new CostKeyMastraBridge() } },
  }),
})
```

If you already use another Mastra bridge, add `new CostKeyMastraExporter()` to
`exporters` instead (pass Mastra's `getCurrentSpan` to keep call attribution).

**LangChain.js and LangGraph.js**: chains, graphs, graph nodes, agents, tools
and retrievers.

```typescript
import { CostKeyCallbackHandler } from 'costkey/integrations/langchain'

const costkey = new CostKeyCallbackHandler()
await graph.invoke(input, { callbacks: [costkey] })
```

**Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): the run, tool uses
(PreToolUse/PostToolUse hooks) and subagents become spans, and every message
that carries usage is sent as a call event with
`telemetry.source = "claude-agent-sdk"` and the raw message skeleton. No cost
math happens in the SDK; your own `options.hooks` still run.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk'
import { instrumentClaudeAgentQuery } from 'costkey/integrations/claude-agent-sdk'

const tracedQuery = instrumentClaudeAgentQuery(query, { name: 'triage' })
for await (const message of tracedQuery({ prompt, options })) { /* ... */ }
```

**OpenTelemetry**: a `SpanProcessor` that forwards every OTel span (GenAI
semantic-convention spans included) as a CostKey span with `attributes.otel`
(raw attributes), `otelKind`, `otelName` and `otelScope`. Provider calls made
while an OTel span is active are attributed to it.

```typescript
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { CostKeySpanProcessor } from 'costkey/integrations/opentelemetry'

const provider = new BasicTracerProvider({ spanProcessors: [new CostKeySpanProcessor()] })
```

See [Agents and tools](https://costkey.dev/docs/agents).

## Grouped work and explicit usage

Use a stable group name with a fresh execution identity for batches,
experiments, or evals:

```ts
await CostKey.startExecution(
  {
    name: "nightly-document-import",
    kind: "batch",
    expectedItems: 100,
    completedItems: 98,
    failedItems: 2,
  },
  () => importDocuments(),
)
```

`expectedItems`, `completedItems` and `failedItems` are runner-supplied
counts copied onto both execution lifecycle events. CostKey does not infer
completion from inactivity or HTTP status. A nested `startExecution` receives
a fresh execution ID by default; pass `executionId` only when explicitly
resuming or joining an invocation.

For components not observed through supported HTTP integrations, report a
caller-owned component, unique event ID and revision. `delta` events are
increments; `cumulative` events replace the latest snapshot and are not
summed. The event is sent exactly as you pass it; the server dedupes repeated
IDs and stale revisions:

```ts
await CostKey.recordUsage({
  id: "voice-session-42:stt:r7",
  componentId: "voice-session-42:stt",
  provider: "deepgram",
  usage: { audioSeconds: 12.4 },
  aggregation: "cumulative",
  revision: 7,
})
```

For LiveKit Agents, subscribe to the documented `SessionUsageUpdated`
callback and pass each cumulative snapshot to `recordLiveKitUsage`. It sends
the snapshot's rows as a skeleton (provider, model, type and every number)
together with your options; the server separates STT/LLM/TTS components,
sums duplicate rows and converts LiveKit's milliseconds. Use `components` or
`excludeComponents` to name the source of charge, for example
`excludeComponents: ["llm"]` when automatic HTTP capture owns the LLM calls.
It does not intercept LiveKit audio or WebRTC traffic. If a session snapshot
is the verified source of charge for a provider request that would otherwise
be auto-captured, wrap that request in
`CostKey.withContext({ costkeyCapture: "manual" }, fn)`.

Known retry/fallback relationships are explicit. The SDK gives every attempt a
distinct `attemptId` (the provider's request id is in the raw telemetry).
When the application knows that one attempt replaces another, scope that
attempt with `CostKey.withContext({ attemptId, parentEventId }, fn)` or supply
the same fields to `recordUsage`. The SDK never links two calls merely because
they share a trace, model, function, or timestamp.

## Explicit enforcement

Installing or initializing CostKey does not block provider calls. To opt into
the DSN-authenticated admission endpoint, configure an explicit enforced
policy with a verified integration proof:

```ts
CostKey.init({
  dsn: process.env.COSTKEY_DSN,
  policy: {
    mode: "enforce",
    integration: {
      supported: true,
      admissionSupported: true,
      verified: true,
    },
  },
})
```

Before each captured call the SDK sends the request skeleton to `/admit`
(`telemetry.request`); the server estimates the usage bounds and answers
allow or refuse, and the SDK enforces that answer. A custom
`policy.admission` callback may decide instead (it is your code).

An unavailable decision, unknown required price, unsupported integration, or
exhausted allowance fails closed as `CostKeyPolicyRefused` in enforce mode.
The error carries the policy reason, allowance/window, and retry metadata when
the server provides them. The application owns its fallback; refusal is not
automatically retried as a provider failure. Monitor mode remains
observation-only and fails open on admission transport errors.

## Explicit context handoff

Context never leaks into unrelated outbound requests. For a trusted service or
queue, explicitly attach the allowlisted carrier:

```ts
const headers = CostKey.exportContextHeaders()
await fetch("https://internal-worker.example/run", { headers })
```

The destination can pass the serialized `x-costkey-context` value to
`CostKey.withContext(...)`. CostKey removes its carrier headers before a
provider request. Conversation and voice-session identities are included in
the explicit carrier allowlist; arbitrary context remains process-local.

Capture settings are negotiated asynchronously from the DSN project config.
The SDK starts metadata-only until that response is known, so startup never
adds provider latency. A remote metadata-only/off setting overrides local
`captureBody:true`; an explicit local `captureBody:false` remains an opt-out
even when remote text capture is enabled. Missing or revoked config fails
closed to metadata-only without blocking provider calls. Existing projects
that historically captured text keep that behavior only after the server
explicitly reports text capture enabled.
In metadata-only mode the raw telemetry is a skeleton: structure, numbers and
string lengths, never prompt, tool-definition, tool-call, or system
instruction text. Body capture adds the scrubbed `requestBody` and
`responseBody`, plus span input and output, all sent whole: text is never
truncated (only image and binary bytes are replaced by a size note). Large
events are split across ingest requests of at most 8 MB each, and an event
bigger than that is sent on its own.
A streamed response (SSE, NDJSON, a streamed JSON array or an AWS event
stream) is captured as every event in order:
`responseBody: {"__costkey_stream__": [...]}`. An SSE event with an `event:`
name is `{"event": "<name>", "data": <json>}`, otherwise the parsed JSON
itself; non-JSON data such as `[DONE]` is dropped. A Bedrock event is keyed by
its event type, as botocore delivers it: `{"contentBlockDelta": {...}}`, or
`{"chunk": {"bytes": <decoded model JSON>}}` for invoke-with-response-stream
(the `p` padding field is dropped). The caller's stream is passed through
unchanged.

## Supported Providers

| Provider | Hostname | Streaming |
|---|---|---|
| OpenAI | `api.openai.com` | Yes (requests `include_usage`) |
| Anthropic | `api.anthropic.com` | Yes |
| Google Gemini | `generativelanguage.googleapis.com` | Yes |
| Azure OpenAI | `*.openai.azure.com`, `*.services.ai.azure.com`, `*.cognitiveservices.azure.com` | Yes |
| Google Vertex AI | `aiplatform.googleapis.com`, `*-aiplatform.googleapis.com` | Yes |
| Groq | `api.groq.com` | Yes |
| xAI (Grok) | `api.x.ai` | Yes |
| Mistral | `api.mistral.ai` | Yes |
| DeepSeek | `api.deepseek.com` | Yes |
| Cohere | `api.cohere.com` | Yes |
| Together AI | `api.together.xyz` | Yes |
| Fireworks | `api.fireworks.ai` | Yes |
| Perplexity | `api.perplexity.ai` | Yes |
| Cerebras | `api.cerebras.ai` | Yes |
| OpenRouter | `openrouter.ai` | Yes |
| AWS Bedrock | `bedrock-runtime.*.amazonaws.com` | Yes (AWS event stream) |
| Typesafe | `api.typesafe.ai` | Yes |
| DeepInfra | `api.deepinfra.com` | Yes |
| NVIDIA NIM | `integrate.api.nvidia.com` | Yes |
| SambaNova | `api.sambanova.ai` | Yes |
| Novita | `api.novita.ai` | Yes |
| Hyperbolic | `api.hyperbolic.xyz` | Yes |
| Nebius | `api.studio.nebius.com`, `api.studio.nebius.ai`, `api.tokenfactory.nebius.com` | Yes |
| Alibaba (DashScope / Qwen) | `dashscope.aliyuncs.com`, `dashscope-intl.aliyuncs.com`, `dashscope-us.aliyuncs.com` | Yes |
| Moonshot (Kimi) | `api.moonshot.ai`, `api.moonshot.cn` | Yes |
| Z.ai (GLM) | `api.z.ai`, `open.bigmodel.cn` | Yes |
| MiniMax | `api.minimax.io`, `api.minimaxi.com`, `api.minimax.chat` | Yes |
| Hugging Face | `router.huggingface.co`, `api-inference.huggingface.co` | Yes |
| Baseten | `inference.baseten.co` | Yes |
| Lambda | `api.lambda.ai` | Yes |
| Featherless | `api.featherless.ai` | Yes |
| Friendli | `api.friendli.ai` | Yes |
| AI21 | `api.ai21.com` | Yes |
| Upstage | `api.upstage.ai` | Yes |
| Sarvam | `api.sarvam.ai` | Yes |
| Cloudflare Workers AI | `api.cloudflare.com` (`/ai/` routes only) | Yes |
| Vercel AI Gateway | `ai-gateway.vercel.sh` | Yes |
| Portkey, Helicone | `api.portkey.ai`, `oai.helicone.ai`, `gateway.helicone.ai`, `anthropic.helicone.ai` | Yes |
| Ollama | `localhost:11434`, `127.0.0.1:11434` (inference routes) | Yes (NDJSON and SSE) |
| ElevenLabs | `*.elevenlabs.io` | — |
| Rumik | `*.rumik.ai` | — |
| Deepgram | `api.deepgram.com` | — |
| AssemblyAI | `api.assemblyai.com`, `api.eu.assemblyai.com` | — |
| Cartesia | `api.cartesia.ai` | SSE |
| Voyage AI | `api.voyageai.com` | — |
| Jina AI | `api.jina.ai` | — |
| Exa | `api.exa.ai` | — |
| Firecrawl | `api.firecrawl.dev` | — |
| Tavily | `api.tavily.com` | — |

The SDK sends the same raw telemetry for every host; the server knows how each
provider reports usage (tokens, characters, audio seconds, search queries,
grounding, credits, pages) and prices it. Audio and image responses are never
read or buffered: their size comes from `content-length` or is counted as the
bytes pass through. Hosts configured as custom providers in your project
settings are added to the capture list at runtime; their extraction rules
live on the server.

### AWS SDK for JavaScript (Bedrock)

`@aws-sdk/client-bedrock-runtime` sends requests through Node's `http` module,
not `fetch`, so instrument the client once:

```typescript
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'

const bedrock = CostKey.instrumentBedrockClient(new BedrockRuntimeClient({ region: 'us-east-1' }))
```

Converse, ConverseStream, InvokeModel and InvokeModelWithResponseStream calls
are then recorded with the same raw telemetry (the serialized request, the
token-count headers and the output as a skeleton); streams are recorded when
your code finishes reading them. Bedrock calls made through `fetch` (for
example `@ai-sdk/amazon-bedrock`) need no setup.

## Options

| Option | Default | Description |
|---|---|---|
| `dsn` | required | `http://ck_key@localhost:4100/project` |
| `captureBody` | `true` | Also send request/response content (subject to the project's capture setting) |
| `captureScreens` | `false` (`COSTKEY_CAPTURE_SCREENS=true` with `costkey/register`) | Upload images sent to the model, such as an agent's screenshots, once each, so the console can replay the run. Needs screen capture turned on for the project too |
| `release` | `COSTKEY_RELEASE`, then the commit | Release version, for comparing deploys and sourcemap translation |
| `commit` | detected | Commit SHA of the running code (`COSTKEY_COMMIT`, CI variables, `.git`) |
| `repository` | detected | Repository URL the console links commits to (`COSTKEY_REPOSITORY`, CI variables, `.git`) |
| `beforeSend` | — | Hook to modify/filter events |
| `beforeSendEvent` | — | Hook to modify/filter lifecycle and usage events |
| `policy` | — | Explicit monitor/enforce admission configuration |
| `configRefreshInterval` | `60000` | Milliseconds between DSN capture-config refreshes |
| `maxBatchSize` | `50` | Events per batch |
| `flushInterval` | `5000` | Ms between flushes |
| `debug` | `false` | Enable debug logging |

## API

| Method | Description |
|---|---|
| `CostKey.init(options)` | Initialize. Call once at startup. |
| `CostKey.startTrace(opts, fn)` | Run fn inside a trace scope. |
| `CostKey.startExecution(opts, fn)` | Group repeatable work with a fresh execution ID. |
| `CostKey.recordUsage(event)` | Report external/native usage as passed (the server dedupes). |
| `CostKey.recordLiveKitUsage(event, opts)` | Send a LiveKit cumulative usage snapshot raw; `components` / `excludeComponents` name the source of charge. |
| `CostKey.withContext(ctx, fn)` | Run fn with custom tags. |
| `CostKey.agent / step / tool(name, fn)` | Run fn inside an agent, step or tool span. |
| `CostKey.startSpan(opts, fn)` | Run fn inside a span of any kind. |
| `CostKey.instrumentTools(tools)` | Wrap each tool's `execute` in a tool span. |
| `CostKey.exportContext()` / `exportContextHeaders()` | Explicit allowlisted cross-process carrier. |
| `CostKey.shutdown()` | Flush and restore original fetch. |
| `CostKey.instrumentBedrockClient(client)` | Record calls from an AWS SDK v3 `BedrockRuntimeClient`. |
| `CostKey.runEval({ dataset, task })` | Run your task on every item of a labelled dataset, in your environment and with your keys, and score it. |

### Evals on a labelled dataset

Label calls from a run in the console (**Add to dataset**), then replay them
against another model or prompt from your own code:

```ts
const summary = await CostKey.runEval({
  dataset: "checkout clicks",
  configuration: { model: "claude-haiku-4-5" },
  task: (item) => anthropic.messages.create({ ...item.input, model: "claude-haiku-4-5" }),
});
// summary: { executionId, total, scored, passed, failed, errors, results }
```

- The dataset is read with a personal access token (`ck_pat_…`, read-only):
  pass `apiToken` or set `COSTKEY_API_TOKEN`.
- `item.input` is the original request with its screenshots put back, so a
  computer-use step replays exactly. `item.incomplete` is true when a
  screenshot couldn't be restored.
- The run is one execution (kind `evaluation`). Each item runs in its own
  trace with `caseId` and `phase: "candidate"`, so its calls are priced as
  usual and the console compares the cost with the original calls.
- The default scorer (`defaultEvalScore`) compares computer actions: items
  labelled Good pass when the candidate takes the same action (clicks within
  `tolerance`, default 40 px), items labelled Bad pass when it doesn't repeat
  it, an `expected` action or text takes priority, and anything else is
  unscored. Pass `score: (item, output) => ({ pass, reason })` to use your own.

## 0.7.4

- With body capture on, streamed responses are captured too: every event of
  an SSE, NDJSON, streamed JSON array or Bedrock event stream (through fetch
  or `instrumentBedrockClient`) is sent in order, uncapped and scrubbed, as
  `responseBody: {"__costkey_stream__": [...]}`. Named SSE events become
  `{"event": "<name>", "data": <json>}`; Bedrock events are keyed by event
  type (`{"contentBlockDelta": {...}}`, `{"chunk": {"bytes": <json>}}`). With
  capture off nothing changes.

## 0.7.3

- With body capture on, content is no longer truncated: request and response
  bodies (previously 32 KB, strings 16K chars), span input and output
  (previously 2,000 chars) and raw framework attributes (previously 2,000-char
  strings, 12 levels deep, 64 KB) are sent whole.
- The transport batches by size: each POST to `/api/v1/events` holds at most
  `maxBatchSize` events and about 8 MB of JSON, an event over 8 MB is sent
  alone, and a flush drains the whole queue.

## Upgrading to 0.7.0

0.7.0 makes the SDK telemetry-only. The server keeps accepting 0.6.x events.

- Call events carry `telemetry` and no longer have `provider`, `model`,
  `usage`, `costUsd`, `streamTiming`, `requestModel`, `providerRequestId`,
  `chargeId`, `metadata` or `systemPrompt`. A `beforeSend` hook that read them
  should read `event.telemetry` instead.
- `CostKey.score()` and its types are removed: quality checks run on the server.
- `CostKey.registerExtractor()`, `ProviderExtractor` and `ExtractorCall` are
  removed: custom providers are project configuration on the server.
- `policy.usageBounds` and `policy.claimedCostUsd` are removed: `/admit`
  receives the request skeleton and the server estimates bounds. Settlement
  no longer carries `actualUsage` / `actualCostUsd`.
- `recordUsage` no longer dedupes, fences revisions, infers `unitValue` or
  derives `costUsd` from `amount`; `UsageConflictError` is removed.
- `recordLiveKitUsage` sends one raw event per snapshot (it returns one ID)
  instead of classified, summed per-component events.
- Errors carry the raw `errorName` (`AbortError`, `TypeError`...). A thrown
  AbortError ends a trace as `failed` with `errorName: "AbortError"` and a
  span with status `error`; the server maps it to cancelled.
- `callSite.frames` holds every frame, unfiltered.
- The legacy `Provider` enum is still exported but no longer used.

## Measuring overhead

The repository includes a reproducible loopback-only benchmark for the
application-visible fetch path and the optional policy admission hop:

```bash
npm run build --workspace=costkey
node benchmarks/sdk-overhead.mjs --iterations=500 --warmup=100
```

It reports p50/p95 timings and environment details. Results are
machine-specific synthetic evidence, not a provider-latency or production
overhead guarantee; see [`sdk-overhead.local.md`](../../docs/implementation/sdk-overhead.local.md)
for the recorded local run.

## Known Limitations

- **Async stack traces**: In heavily async environments (Cloudflare Workers, Next.js server components), stack traces may only show the async boundary rather than the full call chain. This is a runtime limitation — JavaScript engines discard stack frames across `await` points.

## License

MIT
