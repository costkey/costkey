# costkey

> Sentry for AI costs. Track every LLM call's cost, tokens, and latency with one line of code.

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

## How It Works

CostKey patches `globalThis.fetch` — like Sentry does for error tracking. When your code calls any AI provider API, CostKey automatically:

1. **Detects** the AI provider from the URL
2. **Extracts** token usage from the response
3. **Captures** a stack trace (which function, which file, which line)
4. **Computes** cost using built-in pricing for 30+ models
5. **Ships** the event to your CostKey dashboard (async, non-blocking)

**Zero overhead.** Non-AI fetch calls pass through untouched. AI calls get cloned responses — your code gets the original response at the same time, unmodified.

**Zero risk.** The SDK never throws into your code. Every error is swallowed. Your app works even if CostKey is completely down.

## Tracing

Group all AI calls within a request into a single trace:

```typescript
// Express middleware
app.use((req, res, next) => {
  CostKey.startTrace({ name: `${req.method} ${req.path}` }, next)
})

// Now one user request = one trace in your dashboard
// POST /api/chat → generateResponse + moderateContent + generateTitle
// All grouped, with total cost per request
```

## Manual Context

Add custom tags to any AI call:

```typescript
await CostKey.withContext({ task: 'summarize', team: 'search' }, async () => {
  await openai.chat.completions.create({ ... })
})
```

## Privacy & Security

- **Never captures API keys.** Request headers are never read.
- **Auto-scrubs credentials** from request/response bodies (OpenAI keys, JWTs, tokens, etc.)
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
| OpenAI | `api.openai.com` | Yes (auto-injects `include_usage`) | — |
| Anthropic | `api.anthropic.com` | Yes | Yes |
| Google Gemini | `generativelanguage.googleapis.com` | Yes | Yes |
| Azure OpenAI | `*.openai.azure.com` | Yes | — |
| Google Vertex AI | `*-aiplatform.googleapis.com` | Yes | Yes |

## API

### `CostKey.init(options)`
Initialize the SDK. Call once at app startup.

### `CostKey.startTrace(options, fn)`
Run `fn` inside a trace scope. All AI calls get grouped under one trace ID.

### `CostKey.withContext(context, fn)`
Run `fn` with additional context tags.

### `CostKey.shutdown()`
Flush pending events and restore original `fetch`. Call before process exit.

### `CostKey.registerExtractor(extractor)`
Add support for a custom AI provider.

### `CostKey.registerPricing(model, pricing)`
Add custom model pricing.

## License

MIT
