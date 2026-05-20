/**
 * Translate an OpenTelemetry span emitted by an LLM library into a
 * Voight {@link EventPayload}.
 *
 * Reads two parallel attribute namespaces:
 *
 *   - Primary:  OTel GenAI semconv (`gen_ai.*`). Used by most modern
 *               LLM SDKs when OTel auto-instrumentation is active
 *               (OpenAI Python, Anthropic Python, LangChain, …).
 *   - Fallback: Vercel AI SDK (`ai.*`). Used by spans from
 *               `streamText` / `generateText` / `streamObject` /
 *               `generateObject` with `experimental_telemetry`
 *               enabled.
 *
 * Each field independently prefers the primary value when present
 * and falls back to the Vercel value otherwise. A span that has
 * **neither** namespace populated (a non-LLM span that leaked into
 * the exporter) returns `null` so the exporter can skip it.
 *
 * The mapper is pure: same input, same output. No I/O. Safe to call
 * inside the exporter's hot path.
 */

import {
  GEN_AI_SYSTEM,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_PROMPT,
  GEN_AI_COMPLETION,
  GEN_AI_TOOL_CALLS,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
} from './conventions.js'
import {
  AI_MODEL_ID,
  AI_MODEL_PROVIDER,
  AI_PROMPT_MESSAGES,
  AI_RESPONSE_TEXT,
  AI_RESPONSE_TOOL_CALLS,
  AI_RESPONSE_FINISH_REASON,
  AI_USAGE_PROMPT_TOKENS,
  AI_USAGE_COMPLETION_TOKENS,
  AI_USAGE_CACHED_INPUT_TOKENS,
  AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
} from './vercel-conventions.js'
import { scrubAnyValue, scrubPii } from './privacy.js'
import type { EventPayload, PrivacyLevel } from './types.js'

// ─── Input shape ───────────────────────────────────────────────────
//
// We don't import `ReadableSpan` from `@opentelemetry/sdk-trace-base`
// here, because that would force a value-import dep on the mapper.
// Instead the mapper accepts a structurally-compatible "span-like"
// object — the exporter is the only place that touches the real
// `ReadableSpan` and it adapts.

/** OTel HrTime tuple: [seconds, nanoseconds]. */
export type HrTime = [number, number]

export interface SpanLike {
  /** Span name, e.g. `'ai.streamText.doStream'`. */
  name: string
  /** Flat attribute bag. Values can be any OTel-supported primitive. */
  attributes: Record<string, unknown>
  /** Start time as an HrTime tuple. */
  startTime: HrTime
  /** End time as an HrTime tuple. */
  endTime: HrTime
  /**
   * OTel SpanStatus: code 0=UNSET, 1=OK, 2=ERROR. `message` carries
   * the human-readable failure description when code===2.
   */
  status: { code: number; message?: string | undefined }
}

export interface MapAttributesOptions {
  privacy?: PrivacyLevel
  /**
   * Session identifier stamped on `metadata.sessionId`. The exporter
   * resolves this once per instance and passes it through unchanged
   * — the mapper does not consult `process.env`.
   */
  sessionId?: string
}

// ─── Primitive helpers ─────────────────────────────────────────────

/**
 * Coerce an attribute value to a finite number, or return 0.
 *
 * OTel attribute values are typed as `AttributeValue` (string, number,
 * boolean, or arrays of those). Token counts come through as numbers
 * in well-behaved exporters but we've seen string-coerced values from
 * older instrumentation; this helper accepts both without crashing.
 */
function numberOrZero(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/**
 * Return a non-empty string from the attribute bag, or `null`.
 * Whitespace-only values count as missing.
 */
function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Pick the first defined attribute from a priority list. Returns
 * `null` when none of the candidates is present (or all are
 * whitespace).
 */
function pickString(
  attrs: Record<string, unknown>,
  candidates: readonly string[],
): string | null {
  for (const k of candidates) {
    const v = stringOrNull(attrs[k])
    if (v !== null) return v
  }
  return null
}

/**
 * Pick the first **numeric-coercible** attribute from a priority
 * list. Returns the value, or 0 if none of the candidates is set.
 */
function pickNumber(
  attrs: Record<string, unknown>,
  candidates: readonly string[],
): number {
  for (const k of candidates) {
    if (attrs[k] !== undefined && attrs[k] !== null) {
      return numberOrZero(attrs[k])
    }
  }
  return 0
}

/**
 * Try to parse a JSON string; return the original value if it can't
 * be parsed. Used because both `gen_ai.prompt` / `ai.prompt.messages`
 * arrive as JSON-stringified arrays in practice but the spec allows
 * either shape.
 */
function parseJsonLoose(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

// ─── Provider extraction ───────────────────────────────────────────

/**
 * Reduce a Vercel-style provider string like `'openai.responses'` to
 * its base provider `'openai'`. The full surface is preserved as
 * `metadata.providerSurface` so dashboards / debugging can still
 * tell the chat-completions and Responses API calls apart.
 *
 * - `'openai.responses'`   → `'openai'`
 * - `'anthropic.messages'` → `'anthropic'`
 * - `'openai'`             → `'openai'` (unchanged)
 * - `''`                   → `'unknown'`
 */
export function extractBaseProvider(raw: string | null): string {
  if (raw === null) return 'unknown'
  const trimmed = raw.trim()
  if (trimmed.length === 0) return 'unknown'
  const dot = trimmed.indexOf('.')
  return dot === -1 ? trimmed : trimmed.slice(0, dot)
}

// ─── Timing ────────────────────────────────────────────────────────

/**
 * Convert an OTel HrTime delta to milliseconds. Both inputs are
 * `[seconds, nanoseconds]` tuples. Returns 0 if either tuple is
 * malformed (the mapper would rather report `durationMs=0` than
 * propagate a `NaN` to the backend).
 */
export function hrTimeDeltaMs(start: HrTime, end: HrTime): number {
  if (!Array.isArray(start) || !Array.isArray(end)) return 0
  if (start.length !== 2 || end.length !== 2) return 0
  const [ss, sn] = start
  const [es, en] = end
  if (
    typeof ss !== 'number' ||
    typeof sn !== 'number' ||
    typeof es !== 'number' ||
    typeof en !== 'number'
  ) {
    return 0
  }
  const ms = (es - ss) * 1000 + (en - sn) / 1_000_000
  // The Voight backend Zod schema requires `durationMs` to be a
  // non-negative integer; OTel HrTime arithmetic naturally produces
  // a float (e.g. 1234.567ms). Round to the nearest millisecond —
  // sub-ms precision is well below the noise floor of any real
  // network-bound LLM call so we lose nothing meaningful.
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0
}

// ─── Streaming detection ───────────────────────────────────────────

/**
 * Derive whether the span describes a streaming call from its name.
 * Falls back to `false` so a span name we don't recognise (a future
 * SDK release adding a new entry-point) defaults to non-streaming —
 * an under-report rather than a misleading over-report.
 */
function isStreaming(spanName: string): boolean {
  return spanName.includes('stream')
}

// ─── Outer-wrapper detection ───────────────────────────────────────

/**
 * Vercel AI SDK emits two spans per LLM call: an outer wrapper
 * (`ai.generateText` / `ai.streamText` / `ai.generateObject` /
 * `ai.streamObject`) and an inner provider span (`*.doGenerate` /
 * `*.doStream`). The outer wrapper carries duplicated copies of
 * some attributes (model, prompt, finish reason) but **not** the
 * token counts — those live exclusively on the inner span. If we
 * emit both, the dashboard ends up with two events per call, one
 * of which has `tokens: 0/0` and looks broken.
 *
 * We skip the outer wrapper by name pattern: any span whose name
 * starts with `ai.` and does *not* contain a `.do` segment is an
 * outer wrapper. Non-Vercel sources (LangChain / LiteLLM auto-
 * instrumentation using `gen_ai.*` directly) don't match this
 * prefix and pass through unchanged.
 *
 * - `ai.generateText`           → outer (skip)
 * - `ai.generateText.doGenerate` → inner (keep)
 * - `gen_ai.client.request`     → non-Vercel, no `ai.` prefix (keep)
 */
function isOuterVercelWrapper(spanName: string): boolean {
  if (!spanName.startsWith('ai.')) return false
  return !spanName.includes('.do')
}

// ─── Tool calls normalisation ──────────────────────────────────────

/**
 * Normalise the tool-calls array to the Voight backend shape:
 * `{ id, name, arguments }`. Accepts either the OTel GenAI spec
 * shape `{ id, name, arguments }` directly, or the Vercel SDK shape
 * `{ toolCallId, toolName, args }`.
 */
function normaliseToolCalls(
  raw: unknown,
): Array<{ id?: string; name: string; arguments: unknown }> | null {
  const parsed = parseJsonLoose(raw)
  if (!Array.isArray(parsed)) return null
  const out: Array<{ id?: string; name: string; arguments: unknown }> = []
  for (const call of parsed) {
    if (call === null || typeof call !== 'object') continue
    const c = call as Record<string, unknown>
    const name =
      stringOrNull(c.name) ??
      stringOrNull(c.toolName) ??
      stringOrNull(c.function as unknown as string)
    if (name === null) continue
    const id =
      stringOrNull(c.id) ??
      stringOrNull(c.toolCallId) ??
      undefined
    const args =
      c.arguments !== undefined
        ? c.arguments
        : c.args !== undefined
          ? c.args
          : null
    const entry: { id?: string; name: string; arguments: unknown } = {
      name,
      arguments: args,
    }
    if (id !== undefined) entry.id = id
    out.push(entry)
  }
  return out.length === 0 ? null : out
}

// ─── Privacy fan-out ───────────────────────────────────────────────

function applyPrivacyMessages(
  messages: unknown,
  level: PrivacyLevel,
): unknown {
  if (level === 'minimal') return null
  if (level === 'full') return messages
  return scrubAnyValue(messages)
}

function applyPrivacyText(text: string | null, level: PrivacyLevel): string | null {
  if (text === null) return null
  if (level === 'minimal') return null
  if (level === 'full') return text
  return scrubPii(text)
}

function applyPrivacyToolCalls(
  toolCalls: Array<{ id?: string; name: string; arguments: unknown }> | null,
  level: PrivacyLevel,
): Array<{ id?: string; name: string; arguments: unknown }> | null {
  if (toolCalls === null) return null
  if (level === 'minimal') {
    // Names alone are tags — keep them so the dashboard can still
    // show "called search_docs" even at minimal privacy. Drop the
    // arguments (user-data shaped).
    return toolCalls.map(({ id, name }) =>
      id !== undefined
        ? { id, name, arguments: null }
        : { name, arguments: null },
    )
  }
  if (level === 'full') return toolCalls
  return toolCalls.map((call) => ({
    ...call,
    arguments: scrubAnyValue(call.arguments),
  }))
}

// ─── Main entry ────────────────────────────────────────────────────

/**
 * Map an OTel span to a Voight {@link EventPayload}, or `null` when
 * the span has no LLM-shaped attributes (so the exporter can skip it
 * cleanly instead of emitting noise).
 */
export function mapAttributes(
  span: SpanLike,
  options: MapAttributesOptions = {},
): EventPayload | null {
  const attrs = span.attributes
  const privacy: PrivacyLevel = options.privacy ?? 'standard'

  // ── Filter: drop Vercel outer wrappers ───────────────────────────
  // See `isOuterVercelWrapper`: keeping these would duplicate every
  // call in the dashboard with a broken sibling event missing tokens.
  if (isOuterVercelWrapper(span.name)) return null

  // ── Detect: is this an LLM span at all? ──────────────────────────
  // Cheap pre-check: at least one of the two canonical model-id keys
  // must be present. If neither, this is a span from some other
  // instrumentation (HTTP client, DB query, …) that leaked through.
  const model = pickString(attrs, [GEN_AI_REQUEST_MODEL, AI_MODEL_ID])
  if (model === null) return null

  // ── Provider ─────────────────────────────────────────────────────
  const providerRaw = pickString(attrs, [GEN_AI_SYSTEM, AI_MODEL_PROVIDER])
  const provider = extractBaseProvider(providerRaw)

  // ── Response model (when distinct from request model) ────────────
  const responseModel = pickString(attrs, [GEN_AI_RESPONSE_MODEL])

  // ── Tokens ───────────────────────────────────────────────────────
  const inputTokens = pickNumber(attrs, [
    GEN_AI_USAGE_INPUT_TOKENS,
    AI_USAGE_PROMPT_TOKENS,
  ])
  const outputTokens = pickNumber(attrs, [
    GEN_AI_USAGE_OUTPUT_TOKENS,
    AI_USAGE_COMPLETION_TOKENS,
  ])
  const cacheReadTokens = pickNumber(attrs, [
    GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
    AI_USAGE_CACHED_INPUT_TOKENS,
  ])
  const cacheCreationTokens = pickNumber(attrs, [
    GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
    AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ])

  // ── Messages + response text + tool calls ────────────────────────
  const messagesRaw =
    attrs[GEN_AI_PROMPT] !== undefined
      ? parseJsonLoose(attrs[GEN_AI_PROMPT])
      : attrs[AI_PROMPT_MESSAGES] !== undefined
        ? parseJsonLoose(attrs[AI_PROMPT_MESSAGES])
        : null

  const responseTextRaw =
    pickString(attrs, [GEN_AI_COMPLETION, AI_RESPONSE_TEXT]) ?? null

  const toolCallsRaw =
    attrs[GEN_AI_TOOL_CALLS] ?? attrs[AI_RESPONSE_TOOL_CALLS] ?? null
  const toolCalls = normaliseToolCalls(toolCallsRaw)

  // ── Finish reason ────────────────────────────────────────────────
  let finishReason: string | null = null
  const finishReasonsArr = attrs[GEN_AI_RESPONSE_FINISH_REASONS]
  if (Array.isArray(finishReasonsArr) && finishReasonsArr.length > 0) {
    const first = finishReasonsArr[0]
    if (typeof first === 'string' && first.length > 0) finishReason = first
  }
  if (finishReason === null) {
    finishReason = pickString(attrs, [AI_RESPONSE_FINISH_REASON])
  }

  // ── Privacy filtering ────────────────────────────────────────────
  const messages = applyPrivacyMessages(messagesRaw, privacy)
  const responseText = applyPrivacyText(responseTextRaw, privacy)
  const toolCallsFiltered = applyPrivacyToolCalls(toolCalls, privacy)

  // ── Outcome + error ──────────────────────────────────────────────
  // OTel SpanStatusCode: 0=UNSET, 1=OK, 2=ERROR. UNSET and OK are
  // both treated as success — only an explicitly ERROR'd span turns
  // into `outcome: 'failed'`.
  const outcome: 'success' | 'failed' =
    span.status.code === 2 ? 'failed' : 'success'
  const errorMessage =
    outcome === 'failed' ? (span.status.message ?? 'unknown') : undefined

  // ── Duration ─────────────────────────────────────────────────────
  const durationMs = hrTimeDeltaMs(span.startTime, span.endTime)

  // ── Assemble ─────────────────────────────────────────────────────
  const metadata: Record<string, unknown> = {
    source: 'vercel-ai-sdk',
    provider,
    api: 'vercel-ai',
    streaming: isStreaming(span.name),
    privacyLevel: privacy,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      ...(cacheReadTokens > 0 ? { cache_read: cacheReadTokens } : {}),
      ...(cacheCreationTokens > 0
        ? { cache_creation: cacheCreationTokens }
        : {}),
    },
  }
  if (providerRaw !== null && providerRaw !== provider) {
    metadata.providerSurface = providerRaw
  }
  if (responseModel !== null && responseModel !== model) {
    metadata.responseModel = responseModel
  }
  if (responseText !== null) metadata.responseText = responseText
  if (toolCallsFiltered !== null) metadata.toolCalls = toolCallsFiltered
  if (finishReason !== null) metadata.finishReason = finishReason
  if (options.sessionId !== undefined) metadata.sessionId = options.sessionId

  const event: EventPayload = {
    type: 'reasoning',
    model,
    durationMs,
    outcome,
    metadata,
  }
  if (messages !== null) event.input = { messages }
  if (toolCallsFiltered !== null && toolCallsFiltered.length > 0) {
    event.toolExecuted = toolCallsFiltered[0]!.name
  }
  if (errorMessage !== undefined) event.errorMessage = errorMessage

  return event
}
