# @voightxyz/vercel-ai

> **0.1.1.** Stable + dedup filter for wrapper-emitted spans. Bug reports + feature requests welcome on the [issues page](https://github.com/Voightxyz/voight-vercel-ai/issues).

Voight observability for the [Vercel AI SDK](https://sdk.vercel.ai). An OpenTelemetry `SpanExporter` that ingests the `experimental_telemetry` spans produced by `streamText` / `generateText` / `streamObject` / `generateObject` — prompts, tokens, tool calls, cache reads, latency, errors — surfaced live in the [Voight dashboard](https://voight.xyz).

Same backend and dashboard as [`@voightxyz/openai`](https://www.npmjs.com/package/@voightxyz/openai) + [`@voightxyz/anthropic`](https://www.npmjs.com/package/@voightxyz/anthropic). Events from any of the three packages land side-by-side under the same agent.

## Why an OTel SpanExporter (not a middleware)

The Vercel AI SDK emits OpenTelemetry spans natively when you flip `experimental_telemetry: { isEnabled: true }` on a call. That's the same wire format every other LLM-observability tool listed in the [Vercel AI SDK docs](https://sdk.vercel.ai/providers/observability) consumes — Langfuse, Helicone, Arize Phoenix, Braintrust, Datadog, Sentry, Weights & Biases. We follow the same contract so you can:

- Wire Voight alongside one of those tools (`MultiSpanProcessor`), or
- Drop in Voight as the sole observability provider,

with the same code path either way. No vendor lock, no custom middleware.

## Install

```bash
npm install ai @ai-sdk/openai @vercel/otel @voightxyz/vercel-ai
```

`@voightxyz/vercel-ai` has `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` as peer dependencies and `ai` as an optional peer (the exporter reads OTel GenAI semantic-convention attributes, which any OTel-instrumented LLM library can emit). Bring your own provider package (`@ai-sdk/openai`, `@ai-sdk/anthropic`, …).

## Quick start

1. **Register the exporter** in your Next.js app's `instrumentation.ts`:

   ```ts
   // instrumentation.ts
   import { registerOTel } from '@vercel/otel'
   import { VoightExporter } from '@voightxyz/vercel-ai'

   export function register() {
     registerOTel({
       serviceName: 'my-app',
       traceExporter: new VoightExporter({
         agent: 'my-app',
         // voightApiKey: process.env.VOIGHT_KEY  ← read from env by default
       }),
     })
   }
   ```

2. **Enable telemetry on each LLM call** in your route handlers:

   ```ts
   // app/api/chat/route.ts
   import { openai } from '@ai-sdk/openai'
   import { streamText } from 'ai'

   export async function POST(req: Request) {
     const { messages } = await req.json()
     const result = streamText({
       model: openai('gpt-4o-mini'),
       messages,
       experimental_telemetry: { isEnabled: true },
     })
     return result.toUIMessageStreamResponse()
   }
   ```

3. **Set `VOIGHT_KEY`** in `.env.local`. That's it — every call is captured automatically. Visit your [Voight dashboard](https://voight.xyz/dashboard/ai-apps) to see them in real time.

## What's captured

| Signal | Where it lands |
|---|---|
| Model id (request) | `model` |
| Response model (when different from request) | `metadata.responseModel` |
| Provider (base, e.g. `'openai'`) | `metadata.provider` |
| Provider surface (e.g. `'openai.responses'`) | `metadata.providerSurface` (debug) |
| Prompt messages | `input.messages` |
| Response text | `metadata.responseText` |
| Token counts (input / output) | `metadata.tokens.input` / `metadata.tokens.output` |
| Cache reads | `metadata.tokens.cache_read` |
| Cache creation (Anthropic ephemeral) | `metadata.tokens.cache_creation` |
| Tool / function calls | `metadata.toolCalls` + `toolExecuted` |
| Streaming flag | `metadata.streaming` |
| Trace grouping | `metadata.sessionId` |
| Finish reason | `metadata.finishReason` |
| Latency (ms) | `durationMs` |
| Errors | `errorMessage` + `outcome: 'failed'` |

Every event carries `metadata.source = 'vercel-ai-sdk'` so dashboard filters can isolate Vercel AI events from those emitted by the direct wrappers.

## Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `voightApiKey` | `string` | `process.env.VOIGHT_KEY` | Required to ingest. Missing key → exporter no-ops with a one-time console warning. |
| `apiBase` | `string` | `'https://api.voight.xyz'` | Override for self-hosted Voight. |
| `agent` | `string` | env `VOIGHT_AGENT` → `HOSTNAME` → `'unknown-agent'` | Stable label that groups events in the dashboard. |
| `privacy` | `'minimal' \| 'standard' \| 'full'` | `'standard'` | Capture aggressiveness — see below. |
| `sessionId` | `string` | auto UUID v4 (per exporter instance) | Stamped on `metadata.sessionId` of every event. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Inject a custom client (testing, proxying). |
| `onError` | `(err: unknown) => void` | `() => {}` | Surface ingest failures during development. |

## Privacy levels

- `'minimal'` — model, tokens, latency, errors, tool *names*. Zero prompt content, zero response content, zero tool arguments.
- `'standard'` (default) — adds prompts/responses/tool-arguments scrubbed of common PII (emails, phones, credit cards, API keys, JWTs). 12 patterns + Luhn-validated cards. Same catalogue as `@voightxyz/openai` / `@voightxyz/anthropic`.
- `'full'` — everything raw, no redaction. Useful in local dev or staging.

## Pairing with other exporters

The Vercel AI SDK supports a single `traceExporter` per OTel registration. To run Voight alongside another provider, wire a `MultiSpanProcessor`:

```ts
import { registerOTel } from '@vercel/otel'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { VoightExporter } from '@voightxyz/vercel-ai'
import { LangfuseExporter } from 'langfuse-vercel'

registerOTel({
  serviceName: 'my-app',
  spanProcessors: [
    new BatchSpanProcessor(new VoightExporter({ agent: 'my-app' })),
    new BatchSpanProcessor(new LangfuseExporter()),
  ],
})
```

Each exporter sees the same span batch independently.

## Pairing with Voight direct wrappers

If your app also uses [`@voightxyz/openai`](https://www.npmjs.com/package/@voightxyz/openai) or [`@voightxyz/anthropic`](https://www.npmjs.com/package/@voightxyz/anthropic) with `otel: true`, both packages will emit OpenTelemetry spans for every LLM call. Since `VoightExporter` is registered as an OTel exporter, those wrapper-emitted spans would normally hit the Voight backend twice (once via the wrapper's own direct POST, once via the exporter).

Starting in `0.1.1`, the exporter recognises the `voight.source: 'wrapper'` attribute the wrappers stamp on those spans and skips them cleanly — no POST, callback still SUCCESS. Other OTel exporters in the same process (Langfuse, Datadog, Sentry) still see the spans and forward them normally. The dedup is scoped to the Voight-to-Voight loop.

Spans without that marker — the canonical `streamText` / `generateText` / `streamObject` / `generateObject` spans the Vercel AI SDK emits — are unaffected.

## Status

| Capability | Status |
|---|---|
| `streamText` / `generateText` capture | ✅ Verified (0.1.0) |
| `streamObject` / `generateObject` capture | ✅ Same code path (no extra config) |
| OpenAI provider attribution | ✅ |
| Anthropic provider attribution | ✅ |
| Tool calls (OpenAI + Anthropic) | ✅ |
| Cache tokens (OpenAI cached_input, Anthropic cache_read + cache_creation) | ✅ |
| Privacy fan-out (3 levels) | ✅ |
| Dedup with `@voightxyz/openai` + `@voightxyz/anthropic` `otel: true` | ✅ 0.1.1 — skips wrapper-emitted spans (`voight.source: 'wrapper'`) |
| Per-request `withTrace` / `log` helpers | Deferred — OTel context already provides equivalent semantics; the helpers may return in 0.2 if real usage shows a gap. |
| Direct middleware (`voightMiddleware()`) | Deferred — planned for 0.2 for users who want a 1-line wrap without OTel setup. |

## Links

- [Voight dashboard](https://voight.xyz/dashboard/ai-apps)
- [Voight docs](https://docs.voight.xyz)
- [Source](https://github.com/Voightxyz/voight-vercel-ai)
- [Issues](https://github.com/Voightxyz/voight-vercel-ai/issues)
- [`@voightxyz/openai`](https://www.npmjs.com/package/@voightxyz/openai)
- [`@voightxyz/anthropic`](https://www.npmjs.com/package/@voightxyz/anthropic)

## License

Apache 2.0. See [LICENSE](./LICENSE).
