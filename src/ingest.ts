/**
 * Fire-and-forget HTTP client for the Voight ingest endpoint.
 *
 * Why "fire and forget":
 *
 *   The wrapper is in the user's app's hot path. A failing or slow
 *   Voight backend must NEVER turn into a failing or slow OpenAI
 *   call for the user. `send` returns synchronously; the actual
 *   POST happens on the microtask queue and any error reaches the
 *   optional `onError` hook rather than the caller's stack.
 *
 *   We intentionally do not retry, batch, or buffer in beta.1.
 *   Those add state and complexity — we'd rather drop the
 *   occasional event than ship a half-implemented queue. Retry +
 *   buffer arrive in 0.2.0 once we have real-world failure-mode
 *   data to design against.
 *
 * Why inject `fetch`:
 *
 *   Lets unit tests assert request shape (URL, headers, body)
 *   without going to the network and without monkey-patching
 *   the global. In production the option is omitted and the
 *   runtime's `fetch` (Node 18+) is used.
 */

import type { EventPayload } from './types.js'

export interface IngestOptions {
  apiBase: string
  apiKey: string
  /**
   * Optional override for the network call. Tests inject a mock;
   * production callers leave this unset and `globalThis.fetch` is
   * used at dispatch time.
   */
  fetch?: typeof fetch | undefined
  /**
   * Called when a network error or non-2xx response would otherwise
   * be silently dropped. Useful for surfacing misconfiguration
   * (bad key, wrong apiBase) during development. Defaults to a
   * no-op so production stays quiet.
   */
  onError?: ((err: unknown) => void) | undefined
}

export interface IngestClient {
  send: (event: EventPayload) => void
}

/**
 * Build a client bound to a single apiBase + apiKey pair.
 *
 * The returned `send` is synchronous and never throws. Errors are
 * routed to `onError` (a no-op by default).
 */
export function createIngestClient(opts: IngestOptions): IngestClient {
  // Normalise the base URL once so callers can pass it with or
  // without a trailing slash and we don't end up with `//v1/events`.
  const base = opts.apiBase.replace(/\/+$/, '')
  const url = `${base}/v1/events`
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${opts.apiKey}`,
  }
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const onError = opts.onError ?? (() => {})

  return {
    send(event) {
      // Wrap the dispatch in an IIFE so a synchronous throw inside
      // `JSON.stringify` (e.g. circular structure) still ends up
      // at `onError` instead of bubbling to the user's hot path.
      void (async () => {
        try {
          const body = JSON.stringify(event)
          const res = await fetchImpl(url, {
            method: 'POST',
            headers,
            body,
          })
          if (!res.ok) {
            onError(
              new Error(
                `voight ingest failed: ${res.status} ${res.statusText}`,
              ),
            )
          }
        } catch (err) {
          onError(err)
        }
      })()
    },
  }
}
