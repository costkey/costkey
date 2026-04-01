# costkey

> AI cost observability. Track every LLM call's cost, tokens, and latency with one line of code.

## Install

```bash
npm install costkey
```

## Quick Start

```typescript
import { CostKey } from 'costkey'

CostKey.init({
  dsn: 'https://ck_your_key@costkey.dev/your-project'
})

// That's it. Every AI call is now tracked automatically.
// Works with OpenAI, Anthropic, Google Gemini, Azure OpenAI.
```

**No wrapping. No per-client setup. No manual tagging.** CostKey patches `fetch` globally and auto-detects AI provider calls.

## What You Get (Zero Config)

All of these work automatically after `init()`:

- **Cost tracking** — per-call cost computed from built-in pricing (30+ models)
- **Stack trace attribution** — see which function, file, and line made each AI call
- **Auto-tracing** — AI calls from the same request are grouped into traces automatically
- **Feature detection** — call chains are analyzed to detect logical "features" in your code
- **Streaming metrics** — TTFT, tokens/sec, chunk timing for streaming responses
- **Microservice propagation** — trace IDs auto-propagate across services via headers
- **Credential scrubbing** — API keys, JWTs, and secrets are auto-redacted from captured bodies
- **Anomaly detection** — alerts when a function's cost spikes vs its 7-day baseline

## How It Works

CostKey patches `globalThis.fetch`. When your code calls any AI provider:

1. **Detects** the provider from the URL (OpenAI, Anthropic, Google, Azure)
2. **Extracts** token usage from the response
3. **Captures** a stack trace for automatic code attribution
4. **Auto-generates** a trace ID from shared parent frames (zero-config tracing)
5. **Computes** cost using built-in model pricing
6. **Ships** the event async to your CostKey dashboard

Non-AI fetch calls pass through untouched with zero overhead.

## Auto-Tracing (Zero Config)

Multiple AI calls from the same request handler are automatically grouped:

```typescript
// No wrapping needed — these calls auto-group into one trace
async function handleSearchRequest(query: string) {
  const intent = await classifyIntent(query)        // AI call 1
  const results = await search(query, intent)
  const summary = await summarizeResults(results)    // AI call 2
  const reranked = await rerankResults(results)      // AI call 3
  return { summary, reranked }
}

// Dashboard shows:
// Trace: handleSearchRequest — 3 AI calls — $0.0043 — 1.2s
//   ├── classifyIntent()        $0.0008   gpt-4o-mini
//   ├── summarizeResults()      $0.0025   gpt-4o
//   └── rerankResults()         $0.0010   gpt-4o-mini
```

### Microservice Tracing

If Service A calls Service B via `fetch`, CostKey auto-injects a trace header. Service B's CostKey picks it up — all AI calls appear in one trace across services. Zero config.

```
Service A: classifyIntent()  ──┐
  fetch("http://svc-b/summarize")  → x-costkey-trace-id: tr_auto_xxx
Service B: summarizeDoc()    ──┤── All in one trace
Service A: rerankResults()   ──┘
```

## Manual Context (Optional)

```typescript
await CostKey.withContext({ task: 'summarize', team: 'search' }, async () => {
  await openai.chat.completions.create({ ... })
})
```

## Privacy & Security

- **Never captures API keys** — request headers are never read
- **Auto-scrubs credentials** from captured bodies (OpenAI keys, JWTs, tokens, etc.)
- **`beforeSend` hook** for custom PII scrubbing:

```typescript
CostKey.init({
  dsn: '...',
  beforeSend: (event) => {
    event.requestBody = null // strip prompts entirely
    return event
  }
})
```

## Supported Providers

| Provider | Auto-detected | Streaming | Cache Tokens |
|---|---|---|---|
| OpenAI | `api.openai.com` | Yes | — |
| Anthropic | `api.anthropic.com` | Yes | Yes |
| Google Gemini | `generativelanguage.googleapis.com` | Yes | Yes |
| Azure OpenAI | `*.openai.azure.com` | Yes | — |
| Google Vertex AI | `*-aiplatform.googleapis.com` | Yes | Yes |

## API

### `CostKey.init(options)` — Initialize. Call once at startup.
### `CostKey.withContext(context, fn)` — Tag calls with custom context.
### `CostKey.startTrace(options, fn)` — Manual trace (optional, tracing is automatic).
### `CostKey.shutdown()` — Flush and restore original fetch.
### `CostKey.registerExtractor(extractor)` — Add custom AI provider.
### `CostKey.registerPricing(model, pricing)` — Add custom model pricing.

## Also available for Python

```bash
pip install costkey
```

```python
import costkey
costkey.init(dsn="https://ck_...@costkey.dev/proj")
```

## License

MIT
