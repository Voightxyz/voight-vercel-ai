# Changelog

All notable changes to `@voightxyz/vercel-ai` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta.1] — 2026-05-20

First public release. Ships as `@beta` on npm — promotion to `@latest`
follows a Stage 2 soak with [`vercel/ai-chatbot`](https://github.com/vercel/ai-chatbot).

### Added

- `VoightExporter` — OpenTelemetry `SpanExporter` that consumes
  `experimental_telemetry` spans from the Vercel AI SDK and ships
  them to the Voight ingest API.
- Attribute mapper that reads OTel GenAI semantic conventions
  (`gen_ai.*`) as the primary path and falls back to Vercel's
  `ai.*` namespace per-field. Spans that satisfy either get full
  capture; spans that satisfy neither are silently skipped so
  non-LLM spans (HTTP, DB) don't pollute the event stream.
- Captured fields: `model`, `metadata.provider`,
  `metadata.providerSurface`, `metadata.responseModel`, prompt
  messages, response text, tool calls (normalised across OTel
  GenAI + Vercel shapes), token counts (input / output /
  cache_read / cache_creation), finish reason, streaming flag,
  duration, sessionId, outcome, error message.
- Three privacy levels (`'minimal'` / `'standard'` / `'full'`)
  sharing the 12-pattern PII catalogue used by
  `@voightxyz/openai` and `@voightxyz/anthropic`.
- Auto-generated UUID v4 `sessionId` per exporter instance,
  reusable across spans of the same instance. Explicit override
  via `options.sessionId`.
- Fire-and-forget ingest dispatch — the exporter never blocks the
  OTel runtime or surfaces errors via the result callback.
  Network failures route to the optional `onError` hook.
- `metadata.source = 'vercel-ai-sdk'` constant on every event so
  the dashboard provider filter can distinguish Vercel AI events
  from those emitted by the direct wrappers.

### Out of scope (deferred)

- Direct middleware (`voightMiddleware()`) for users who prefer a
  zero-OTel-setup wrap — planned for `0.2`.
- `withTrace` / `log` async-context helpers — OTel context
  propagation already provides equivalent semantics; the helpers
  may return in `0.2` if real usage shows a gap.
- Batched / buffered ingest — the per-event POST is sufficient
  for the workloads we expect at beta volume. Batching arrives
  with real-world failure-mode data to design against.
- Bedrock / Vertex provider-specific paths — the `gen_ai.*`
  normalisation is expected to cover them; will revisit if a
  user reports a missing attribute.

[0.1.0-beta.1]: https://github.com/Voightxyz/voight-vercel-ai/releases/tag/v0.1.0-beta.1
