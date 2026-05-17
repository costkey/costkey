# CostKey for TypeScript

[![npm version](https://img.shields.io/npm/v/costkey.svg)](https://www.npmjs.com/package/costkey)
[![CI](https://github.com/costkey/costkey/actions/workflows/ci.yml/badge.svg)](https://github.com/costkey/costkey/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)

AI cost observability for Node.js. CostKey tracks every LLM call's cost, tokens, latency, prompts, tool calls, and code location without proxying your traffic.

```bash
npx costkey setup
```

Your OpenAI dashboard says you spent $2,000. CostKey tells you `generateSummary()` in `src/features/search.ts:47` spent $1,200 of that.

## Why CostKey

Most AI observability tools make you route traffic through a proxy or rewrite every provider call. CostKey patches `fetch` in-process, detects AI provider requests, captures the useful metadata, and ships events asynchronously to the CostKey dashboard.

- **No proxy** - zero added network hop and no provider migration.
- **No wrappers** - keep using OpenAI, Anthropic, Gemini, Vercel AI SDK, OpenRouter, or your own gateway.
- **Code attribution** - see function, file, line, release, and stack trace for expensive calls.
- **Prompt and tool visibility** - inspect system prompts, messages, tool definitions, tool calls, tool results, citations, and provider metadata.
- **Trace grouping** - group calls from the same user action, request, or agent run.
- **Budgets and rate limits** - enforce local caps or sync remote budget rules from CostKey.
- **Privacy controls** - credentials are scrubbed and `beforeSend` can redact or drop events.

## Quick Start

Run setup in your app:

```bash
npx costkey setup
```

The CLI opens browser auth, creates a project, writes `COSTKEY_DSN` to `.env`, detects common frameworks, and writes `.costkey/setup.md` with the exact entrypoint instructions.

Manual setup is still tiny:

```bash
npm install costkey
```

```ts
import { CostKey } from "costkey";

CostKey.init({
  dsn: process.env.COSTKEY_DSN,
});
```

Initialize CostKey before your first AI call. After that, provider calls made through `fetch` are tracked automatically.

## No-Code Preload

For server processes where you do not want to touch application code:

```bash
NODE_OPTIONS=--import costkey/register npm start
```

`costkey/register` reads:

- `COSTKEY_DSN`
- `COSTKEY_RELEASE`
- `COSTKEY_CAPTURE_BODY=false`
- `COSTKEY_DEBUG=true`

## What Shows Up

Every captured event can include:

| Data | Example |
| --- | --- |
| Cost | `$0.0184` for a single model call |
| Usage | input, output, cache, reasoning, total tokens |
| Latency | total duration, TTFT, tokens/sec for streams |
| Code location | `src/features/search.ts:47 generateSummary()` |
| Trace | `POST /api/search`, `agent:research-summary` |
| Prompt metadata | system/developer prompt, user messages, response text |
| Tool metadata | tool definitions, tool choice, tool calls, tool results |
| Provider metadata | citations, web search usage, raw provider fields |
| Release | deploy SHA or version for cost-per-deploy and sourcemaps |

## Frameworks

`costkey setup` detects and guides setup for:

- Next.js
- Vite
- Express
- Fastify
- Hono
- Koa
- NestJS
- Remix
- Astro
- SvelteKit
- plain Node.js / TypeScript

Bundled/minified server builds should upload sourcemaps so stack traces resolve back to original source. See [Sourcemaps](https://costkey.dev/docs/sourcemaps).

## Traces and Context

Group all calls from one user action:

```ts
await CostKey.startTrace({ name: "POST /api/search" }, async () => {
  const intent = await classifyIntent(query);
  const results = await searchProducts(query, intent);
  return summarizeResults(results);
});
```

Add business context for filtering and rollups:

```ts
await CostKey.withContext(
  { feature: "search", team: "growth", customerId: "cus_123" },
  async () => {
    await openai.chat.completions.create({ model: "gpt-4o", messages });
  },
);
```

## Budgets and Rate Limits

Use local protection for a process:

```ts
CostKey.init({
  dsn: process.env.COSTKEY_DSN,
  budget: {
    daily: 25,
    onExceed: "block",
  },
  rateLimit: {
    requestsPerMinute: 120,
  },
});
```

When dashboard budget rules are configured, the SDK fetches and refreshes them automatically.

## Privacy

CostKey never reads request headers, so API keys are not captured. Request and response bodies are captured by default because they power debugging and prompt/tool inspection.

Redact before anything leaves your process:

```ts
CostKey.init({
  dsn: process.env.COSTKEY_DSN,
  beforeSend(event) {
    if (event.requestBody?.customer_email) {
      event.requestBody.customer_email = "[redacted]";
    }
    return event;
  },
});
```

Disable body capture entirely:

```ts
CostKey.init({
  dsn: process.env.COSTKEY_DSN,
  captureBody: false,
});
```

## Providers

Built-in detection covers OpenAI, Anthropic, Google Gemini, Google Vertex AI, Azure OpenAI, Groq, xAI, Mistral, DeepSeek, Cohere, Together, Fireworks, Perplexity, Cerebras, OpenRouter, and AWS Bedrock.

Add your own provider or internal gateway:

```ts
import { CostKey, Provider } from "costkey";

CostKey.registerExtractor({
  provider: Provider.Unknown,
  match: (url) => url.hostname === "llm.internal.example.com",
  extractUsage: (body) => {
    const usage = body?.usage;
    if (!usage) return null;
    return {
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    };
  },
});
```

## API

| API | Purpose |
| --- | --- |
| `CostKey.init(options)` | Initialize once at process startup |
| `CostKey.shutdown()` | Flush and restore the original `fetch` |
| `CostKey.flush()` | Flush buffered events |
| `CostKey.withContext(context, fn)` | Attach metadata to all nested AI calls |
| `CostKey.startTrace(options, fn)` | Group calls into one trace |
| `CostKey.getCurrentContext()` | Read current async context |
| `CostKey.getCurrentTraceId()` | Read current trace id |
| `CostKey.registerExtractor(extractor)` | Add custom provider detection |
| `CostKey.registerPricing(model, pricing)` | Add custom model pricing |
| `CostKey.getUsage()` | Inspect local budget/rate-limit usage |

## Development

```bash
npm ci
npm test
npm run build
```

## Release

Publishing is done from GitHub Releases only.

1. Update `package.json` version.
2. Merge to `main`.
3. Create a GitHub Release tagged `vX.Y.Z`.
4. GitHub Actions runs tests, builds, verifies the tag matches the package version, and publishes to npm with provenance.

The npm package must have trusted publishing configured for `costkey/costkey` and the `npm` GitHub environment.

## Links

- Docs: https://costkey.dev/docs
- Dashboard: https://app.costkey.dev
- npm: https://www.npmjs.com/package/costkey
- Python SDK: https://github.com/costkey/costkey-python

If CostKey helps you understand your AI bill, starring the repo helps more developers find it.

## License

MIT
