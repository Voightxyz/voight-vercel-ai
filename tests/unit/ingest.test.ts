/**
 * Tests for the fire-and-forget HTTP ingest client.
 *
 * The contract: `send(event)` is synchronous to the caller (returns
 * `undefined` immediately) and never throws. Errors are swallowed
 * through the `onError` hook so a flaky network or backend can
 * never affect the user's OpenAI call timing or error path.
 *
 * `fetch` is injected so we can assert request shape without going
 * to the network. Production callers omit the option and the
 * runtime's global `fetch` is used.
 */

import { describe, it, expect, vi } from 'vitest'

import { createIngestClient } from '../../src/ingest.js'

function eventFixture() {
  return {
    agentId: 'my-agent',
    type: 'reasoning' as const,
    model: 'gpt-4o-mini',
    durationMs: 42,
    metadata: { source: 'openai-sdk' },
  }
}

describe('createIngestClient.send', () => {
  it('POSTs to <apiBase>/v1/events with Bearer auth', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    )

    const client = createIngestClient({
      apiBase: 'https://api.example.test',
      apiKey: 'vk_test',
      fetch: fetchMock,
    })

    client.send(eventFixture())

    // Send is sync to the caller, but the fetch is dispatched on
    // the microtask queue. Await a tick before asserting.
    await new Promise((r) => setTimeout(r, 0))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.test/v1/events')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer vk_test',
      },
    })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toMatchObject({
      agentId: 'my-agent',
      type: 'reasoning',
      model: 'gpt-4o-mini',
      durationMs: 42,
    })
  })

  it('returns undefined synchronously (does not block the caller)', () => {
    const fetchMock = vi.fn(
      async () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response('{}', { status: 202 })), 50),
        ),
    )

    const client = createIngestClient({
      apiBase: 'https://api.example.test',
      apiKey: 'vk_test',
      fetch: fetchMock,
    })

    const t0 = Date.now()
    const out = client.send(eventFixture())
    const elapsed = Date.now() - t0

    expect(out).toBeUndefined()
    // Sub-10ms is overkill; we just want to assert the caller is
    // not awaiting the slow fetch.
    expect(elapsed).toBeLessThan(10)
  })

  it('does not throw when fetch rejects', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })

    const onError = vi.fn()
    const client = createIngestClient({
      apiBase: 'https://api.example.test',
      apiKey: 'vk_test',
      fetch: fetchMock,
      onError,
    })

    expect(() => client.send(eventFixture())).not.toThrow()

    await new Promise((r) => setTimeout(r, 0))
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]![0] as Error).message).toBe('network down')
  })

  it('does not throw on a non-2xx response', async () => {
    const fetchMock = vi.fn(
      async () => new Response('forbidden', { status: 403 }),
    )

    const onError = vi.fn()
    const client = createIngestClient({
      apiBase: 'https://api.example.test',
      apiKey: 'vk_test',
      fetch: fetchMock,
      onError,
    })

    expect(() => client.send(eventFixture())).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    // Non-2xx is still surfaced via onError so the caller can debug
    // a misconfigured key without crashing the host app.
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('strips a trailing slash from apiBase', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))

    const client = createIngestClient({
      apiBase: 'https://api.example.test/',
      apiKey: 'vk_test',
      fetch: fetchMock,
    })

    client.send(eventFixture())
    await new Promise((r) => setTimeout(r, 0))

    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.example.test/v1/events',
    )
  })
})
