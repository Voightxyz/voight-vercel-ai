# Changelog

All notable changes to `@voightxyz/vercel-ai` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] (2026-09-26)

Metadata only, no code changes. The package description now says
plainly what the package does, and the README ends with a link to
the company page (voight.xyz/company).

## [0.1.1] — 2026-05-22

Promoted from `0.1.1-beta.1` after a clean smoke cycle from the
beta registry — same shipping content, dropped the `-beta.1`
suffix and removed `publishConfig.tag` so `npm publish` defaults
to `@latest`. No code changes between beta and stable.

## [0.1.1-beta.1] — 2026-05-22

Dedup filter for wrapper-emitted spans. When `@voightxyz/openai` or
`@voightxyz/anthropic` is wrapped with `otel: true`, every captured
call goes out via two paths: the wrapper's own direct POST to
`api.voight.xyz`, plus an OpenTelemetry span destined for whichever
exporters the host process has registered. If `VoightExporter` is
one of those exporters (the common case for users adopting both
products), the same call would land twice in the Voight backend —
once via the wrapper and once via the exporter.

This release teaches `VoightExporter.export()` to recognise the
`voight.source: 'wrapper'` attribute the wrappers stamp on those
spans, and skip those spans cleanly (no POST, no error, callback
still SUCCESS). Other OTel exporters in the same process still
see the spans and forward them normally — the dedup is scoped to
the Voight-to-Voight loop.

Spans without that attribute (the canonical `streamText` /
`generateText` / `streamObject` / `generateObject` spans the Vercel
AI SDK emits) are unaffected and continue to flow.

Out as `@beta` for one cycle of registry validation before the
@latest promotion.

## [0.1.0] — 2026-05-21

First stable release. Validated end-to-end against the
[`vercel/ai-chatbot`](https://github.com/vercel/ai-chatbot) reference
app: multi-turn streaming, tool calls (`getWeather`,
`createDocument`, …), per-user attribution via guest sessions, and
full trace grouping all land cleanly in the Voight dashboard.

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
  GenAI + Vercel shapes, always emitted as JSON strings), token
  counts (input / output / cache_read / cache_creation), finish
  reason, streaming flag, duration, sessionId, outcome, error
  message.
- Per-user attribution via `experimental_telemetry.metadata`. The
  exporter lifts every `ai.telemetry.metadata.<key>` span attribute
  into `metadata.tags.<key>`, matching the contract that
  `@voightxyz/openai`'s `withTrace({ tags })` already emits.
  Passing `{ metadata: { userId, plan, … } }` to `streamText` /
  `generateText` activates the Voight Users sub-tab and the
  per-tag filter pills.
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
- Vercel AI SDK outer wrappers (`ai.streamText`, `ai.generateText`,
  `ai.streamObject`, `ai.generateObject`) are skipped at the
  mapper layer so each LLM call lands as a single event with
  complete token counts, not as duplicate events with `0/0`
  tokens.

### Out of scope (deferred)

- Direct middleware (`voightMiddleware()`) for users who prefer a
  zero-OTel-setup wrap — planned for `0.2`.
- `withTrace` / `log` async-context helpers — OTel context
  propagation already provides equivalent semantics; the helpers
  may return in `0.2` if real usage shows a gap.
- Batched / buffered ingest — the per-event POST is sufficient
  for the workloads we expect at this scale. Batching arrives
  with real-world failure-mode data to design against.
- Bedrock / Vertex provider-specific paths — the `gen_ai.*`
  normalisation is expected to cover them; will revisit if a user
  reports a missing attribute.

[0.1.0]: https://github.com/Voightxyz/voight-vercel-ai/releases/tag/v0.1.0
