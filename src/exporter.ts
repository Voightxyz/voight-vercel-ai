/**
 * `VoightExporter` — the public SpanExporter that ships GenAI spans
 * to the Voight ingest API.
 *
 * Usage with @vercel/otel:
 *
 *   ```ts
 *   import { registerOTel } from '@vercel/otel'
 *   import { VoightExporter } from '@voightxyz/vercel-ai'
 *
 *   registerOTel({
 *     serviceName: 'my-app',
 *     traceExporter: new VoightExporter({ agent: 'my-app' }),
 *   })
 *   ```
 *
 * The exporter is a thin coordinator over three existing pieces:
 *
 *   - `resolveApiKey` / `resolveAgent` (identity.ts) — figure out
 *     credentials + the agent label at construction time.
 *   - `createIngestClient` (ingest.ts) — fire-and-forget POST.
 *   - `mapAttributes` (attribute-mapper.ts) — span → EventPayload.
 *
 * `export()` is the only hot-path method; it walks the batch, maps
 * each LLM-shaped span, and dispatches each EventPayload. Spans
 * with no LLM attributes (HTTP clients, DB queries, framework noise)
 * return `null` from the mapper and are silently skipped.
 *
 * The exporter never throws to the OTel runtime: the result callback
 * is always invoked with `SUCCESS`, and any per-span error reaches
 * the user's `onError` hook instead of bubbling. This is the same
 * "Voight must never break your app" contract the wrapper packages
 * follow.
 */

import { resolveAgent, resolveApiKey } from './identity.js'
import { createIngestClient, type IngestClient } from './ingest.js'
import { mapAttributes, type SpanLike, type HrTime } from './attribute-mapper.js'
import type {
  EventPayload,
  PrivacyLevel,
  VoightExporterOptions,
} from './types.js'

// ─── Minimal SpanExporter contract ─────────────────────────────────
//
// The real interface lives in `@opentelemetry/sdk-trace-base`. We
// don't import it because that would force a value-time dep on a
// package whose only value-time export we need is a status-code
// enum (and we hardcode that, see `ExportResultCode` below). Keeping
// the contract local + structural makes the exporter testable
// without a runtime SDK and shrinks the install footprint.

/** OTel ExportResultCode: SUCCESS=0, FAILED=1. We always emit 0. */
const EXPORT_RESULT_SUCCESS = 0 as const

export interface ExportResult {
  code: 0 | 1
  error?: Error
}

/**
 * Structural shape of `ReadableSpan` — only the fields the exporter
 * reads. The real type has many more; this keeps the dependency
 * surface tight and lets unit tests build synthetic spans without
 * importing the OTel SDK.
 */
export interface ReadableSpanLike {
  name: string
  attributes: Record<string, unknown>
  startTime: HrTime
  endTime: HrTime
  status: { code: number; message?: string | undefined }
}

const DEFAULT_API_BASE = 'https://api.voight.xyz'

/**
 * Generate a UUID v4 using the Node 14.17+ built-in (also available
 * in modern browser runtimes). Fallback path uses Math.random — not
 * cryptographically strong, but adequate for grouping non-secret
 * trace IDs in worst-case constrained environments.
 */
function newUuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  // Fallback — kept simple and obviously non-cryptographic.
  return 'sxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export class VoightExporter {
  /** Resolved agent label (always non-empty). */
  private readonly agent: string
  /** Resolved API key, or `null` when the exporter is in no-op mode. */
  private readonly apiKey: string | null
  private readonly privacy: PrivacyLevel
  private readonly sessionId: string
  private readonly ingest: IngestClient | null
  private readonly onError: (err: unknown) => void
  /** Set to `true` after the no-op warning has been logged once. */
  private warned = false

  constructor(options: VoightExporterOptions = {}) {
    this.agent = resolveAgent({ agent: options.agent })
    this.apiKey = resolveApiKey({ voightApiKey: options.voightApiKey })
    this.privacy = options.privacy ?? 'standard'
    this.sessionId = options.sessionId ?? newUuid()
    this.onError = options.onError ?? (() => {})

    if (this.apiKey === null) {
      // Defer the warning to first `export()` call so unit tests
      // constructing one exporter per case don't drown stdout. We
      // still want it visible in real apps, where a single warning
      // line at first traffic is informative without being noisy.
      this.ingest = null
    } else {
      this.ingest = createIngestClient({
        apiBase: options.apiBase ?? DEFAULT_API_BASE,
        apiKey: this.apiKey,
        fetch: options.fetch,
        onError: this.onError,
      })
    }
  }

  /**
   * OTel calls this with a batch of completed spans. We walk the
   * batch synchronously, dispatch each LLM-shaped EventPayload via
   * the fire-and-forget ingest client, and ALWAYS resolve the
   * callback with SUCCESS — failures are surfaced via `onError`,
   * never the OTel result code, so a flaky Voight backend can't
   * stop the user's tracer pipeline.
   */
  export(
    spans: readonly ReadableSpanLike[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    try {
      if (this.ingest === null) {
        if (!this.warned) {
          this.warned = true
          // eslint-disable-next-line no-console
          console.warn(
            '[voight] VoightExporter has no API key (set VOIGHT_KEY env or pass voightApiKey). Spans will be dropped.',
          )
        }
        resultCallback({ code: EXPORT_RESULT_SUCCESS })
        return
      }

      for (const span of spans) {
        // Dedup filter for spans that originated from a Voight
        // wrapper (`@voightxyz/openai` or `@voightxyz/anthropic`
        // with `otel: true`). Those wrappers already POSTed the
        // event directly to /v1/events at capture time, so
        // forwarding the span here would land a duplicate.
        //
        // Other OTel exporters in the same process don't run this
        // filter and process the span normally — by design. They
        // need the full span to ship to Langfuse / Datadog / etc.,
        // and they don't carry our dedup obligation.
        const attrs = (span as SpanLike).attributes ?? {}
        if (attrs['voight.source'] === 'wrapper') continue

        // mapAttributes returns null for non-LLM spans (HTTP clients,
        // DB queries, framework spans). We silently skip them — the
        // OTel runtime may have other exporters that want them.
        let event: EventPayload | null
        try {
          event = mapAttributes(span as SpanLike, {
            privacy: this.privacy,
            sessionId: this.sessionId,
          })
        } catch (err) {
          // A mapper exception (defensive — shouldn't happen given
          // the mapper's pure functions, but cheap insurance) is
          // routed to onError and the span dropped.
          this.onError(err)
          continue
        }
        if (event === null) continue

        // Stamp the agent identity on every outgoing event. The
        // mapper deliberately doesn't know about the exporter's
        // identity config — that responsibility lives here.
        event.agentId = this.agent
        this.ingest.send(event)
      }
    } catch (err) {
      // Catch-all so a malformed `spans` array can't tear down the
      // OTel runtime. Still resolve SUCCESS.
      this.onError(err)
    } finally {
      resultCallback({ code: EXPORT_RESULT_SUCCESS })
    }
  }

  /**
   * Called once during graceful shutdown. We have no in-flight
   * buffer to drain (ingest is fire-and-forget per call), so resolve
   * immediately. A future v0.2 with batching would `await` the
   * outstanding queue here.
   */
  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Same story as `shutdown()` for v0.1 — no buffer to flush. Kept
   * because the OTel runtime checks for the method's presence on
   * the exporter and calls it on every span end when paired with
   * `SimpleSpanProcessor`.
   */
  forceFlush(): Promise<void> {
    return Promise.resolve()
  }
}
