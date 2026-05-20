// Public types for @voightxyz/vercel-ai. Kept in a single file so
// the public surface is auditable at a glance — anything not
// exported from `index.ts` is implementation detail.

/**
 * Capture aggressiveness for prompts and responses.
 *
 * - `minimal`: model, tokens, latency, errors only. Zero content.
 * - `standard` (default): + prompts/responses redacted of common
 *   PII (emails, phone numbers, credit cards, API keys, JWTs).
 * - `full`: everything raw, no redaction.
 */
export type PrivacyLevel = 'minimal' | 'standard' | 'full'

/**
 * Constructor options for {@link VoightExporter}. Mirrors the option
 * surface of `@voightxyz/openai` / `@voightxyz/anthropic` so users
 * coming from a wrapper-based setup find a familiar contract.
 */
export interface VoightExporterOptions {
  /** Voight API key. Falls back to `process.env.VOIGHT_KEY`. */
  voightApiKey?: string

  /** Voight API base URL. Defaults to `https://api.voight.xyz`. */
  apiBase?: string

  /**
   * Stable agent identifier surfaced in the dashboard. Falls back
   * to `process.env.VOIGHT_AGENT`, then `process.env.HOSTNAME`,
   * then `'unknown-agent'`.
   */
  agent?: string

  /** Default `'standard'`. See {@link PrivacyLevel}. */
  privacy?: PrivacyLevel

  /**
   * Trace grouping identifier stamped on `metadata.sessionId` of
   * every event the exporter emits. When omitted, an auto-generated
   * UUID v4 is reused for the life of the exporter instance.
   *
   * In an OpenTelemetry setup the natural session identifier is
   * the OTel `traceId` (one trace per request boundary), so most
   * users won't need to set this. The option exists for callers
   * who want to group across traces (per-user, per-conversation).
   */
  sessionId?: string

  /**
   * Optional override for the network call. Tests inject a mock;
   * production callers leave this unset and `globalThis.fetch` is
   * used at dispatch time.
   */
  fetch?: typeof fetch

  /**
   * Called when a network error or non-2xx response would otherwise
   * be silently dropped. Useful for surfacing misconfiguration
   * (bad key, wrong apiBase) during development. Defaults to a
   * no-op so production stays quiet.
   */
  onError?: (err: unknown) => void
}

/**
 * Wire-format event posted to `POST /v1/events`. Mirrors the schema
 * accepted by the Voight backend (see `apps/api/src/routes/events.ts`
 * in the monorepo): the exporter only populates a subset of these
 * fields, but the type stays wide so future capture paths (embeddings,
 * audio, image generation) can extend it without a breaking change.
 */
export interface EventPayload {
  agentId?: string
  timestamp?: number | string
  type?: 'reasoning' | 'tool' | 'tx' | 'decision' | 'action' | 'error'
  input?: Record<string, unknown>
  reasoning?: string
  toolsConsidered?: string[]
  toolExecuted?: string
  transaction?: string | null
  amount?: { token: string; value: number } | null
  outcome?: 'pending' | 'success' | 'failed'
  durationMs?: number
  errorMessage?: string
  model?: string
  metadata?: Record<string, unknown>
}
