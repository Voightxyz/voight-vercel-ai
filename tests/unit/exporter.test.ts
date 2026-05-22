/**
 * Tests for `VoightExporter` — the SpanExporter contract surface.
 *
 * Strategy:
 *
 *   - Inject a `fetch` mock so we can assert that the right requests
 *     are dispatched without going to the network.
 *   - Build synthetic ReadableSpan-shaped fixtures (not real OTel
 *     spans) — the mapper has its own thorough coverage, so here we
 *     only need spans with enough attributes to round-trip through
 *     the exporter.
 *
 * Contract under test:
 *
 *   1. Missing API key → no throw, no fetch, warns ONCE per exporter,
 *      callback still resolves SUCCESS.
 *   2. With API key + LLM span → ingest.send called once per span,
 *      each request carries the agent label and authorization header.
 *   3. Non-LLM spans (no model attr) → skipped silently, no fetch.
 *   4. Multiple spans in one batch → one fetch per LLM span.
 *   5. Result callback ALWAYS gets `{code: 0}` (SUCCESS).
 *   6. `shutdown()` and `forceFlush()` return resolved Promises.
 *   7. Agent label propagates onto every dispatched event.
 *   8. `sessionId` from options stamps `metadata.sessionId`.
 *   9. A mapper-time throw routes to `onError` and the batch
 *      continues; SUCCESS still emitted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  VoightExporter,
  type ExportResult,
  type ReadableSpanLike,
} from '../../src/exporter.js'

// ─── Fixture helpers ───────────────────────────────────────────────

function llmSpan(overrides: Partial<ReadableSpanLike> = {}): ReadableSpanLike {
  return {
    name: 'ai.generateText.doGenerate',
    attributes: {
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.usage.input_tokens': 120,
      'gen_ai.usage.output_tokens': 47,
    },
    startTime: [1700000000, 0],
    endTime: [1700000001, 0],
    status: { code: 1 },
    ...overrides,
  }
}

function nonLlmSpan(): ReadableSpanLike {
  return {
    name: 'http.client.request',
    attributes: { 'http.method': 'POST', 'http.status_code': 200 },
    startTime: [1700000000, 0],
    endTime: [1700000000, 500_000_000],
    status: { code: 1 },
  }
}

function captureCallback(): {
  result: ExportResult | null
  cb: (r: ExportResult) => void
} {
  const state: { result: ExportResult | null } = { result: null }
  return {
    result: state.result,
    cb: (r) => {
      state.result = r
    },
  } as unknown as ReturnType<typeof captureCallback>
}

function okFetch(): {
  spy: ReturnType<typeof vi.fn>
  fetch: typeof fetch
} {
  const spy = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), { status: 202 }),
  )
  return { spy, fetch: spy as unknown as typeof fetch }
}

// ─── Suite ─────────────────────────────────────────────────────────

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe('VoightExporter — no API key (no-op mode)', () => {
  // `resolveApiKey` falls back to process.env.VOIGHT_KEY when no
  // option is passed (or the option is blank). The test process
  // may have a real key configured (devs running suite locally
  // with env loaded), so we explicitly clear it for these cases.
  beforeEach(() => {
    vi.stubEnv('VOIGHT_KEY', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not throw at construction time', () => {
    expect(
      () => new VoightExporter({ agent: 'x', voightApiKey: '' }),
    ).not.toThrow()
  })

  it('warns ONCE on first export when no API key is set', () => {
    const exporter = new VoightExporter({ agent: 'x', voightApiKey: '' })
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    exporter.export([llmSpan()], cb1)
    exporter.export([llmSpan()], cb2)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(cb1).toHaveBeenCalledWith({ code: 0 })
    expect(cb2).toHaveBeenCalledWith({ code: 0 })
  })

  it('never calls fetch when no API key is set', () => {
    const { spy, fetch } = okFetch()
    const exporter = new VoightExporter({
      agent: 'x',
      voightApiKey: '',
      fetch,
    })
    exporter.export([llmSpan(), llmSpan()], vi.fn())
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('VoightExporter — happy path', () => {
  it('dispatches one POST per LLM span', async () => {
    const { spy, fetch } = okFetch()
    const exporter = new VoightExporter({
      agent: 'demo-app',
      voightApiKey: 'vk_test_abc',
      fetch,
    })
    const cb = vi.fn()
    exporter.export([llmSpan(), llmSpan(), llmSpan()], cb)
    // ingest is fire-and-forget on the microtask queue.
    await new Promise((r) => setImmediate(r))
    expect(spy).toHaveBeenCalledTimes(3)
    expect(cb).toHaveBeenCalledWith({ code: 0 })
  })

  it('skips non-LLM spans silently', async () => {
    const { spy, fetch } = okFetch()
    const exporter = new VoightExporter({
      agent: 'demo-app',
      voightApiKey: 'vk_test_abc',
      fetch,
    })
    exporter.export([nonLlmSpan(), llmSpan(), nonLlmSpan()], vi.fn())
    await new Promise((r) => setImmediate(r))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('targets <apiBase>/v1/events with Bearer auth', async () => {
    const { spy, fetch } = okFetch()
    const exporter = new VoightExporter({
      agent: 'demo-app',
      voightApiKey: 'vk_test_abc',
      apiBase: 'https://example.test/api',
      fetch,
    })
    exporter.export([llmSpan()], vi.fn())
    await new Promise((r) => setImmediate(r))
    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0]!
    expect(url).toBe('https://example.test/api/v1/events')
    expect((init as RequestInit).method).toBe('POST')
    expect(
      ((init as RequestInit).headers as Record<string, string>).authorization,
    ).toBe('Bearer vk_test_abc')
  })

  it('stamps the agent label onto every event', async () => {
    const { spy, fetch } = okFetch()
    const exporter = new VoightExporter({
      agent: 'demo-app',
      voightApiKey: 'vk_test_abc',
      fetch,
    })
    exporter.export([llmSpan(), llmSpan()], vi.fn())
    await new Promise((r) => setImmediate(r))
    expect(spy).toHaveBeenCalledTimes(2)
    for (const call of spy.mock.calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string)
      expect(body.agentId).toBe('demo-app')
    }
  })

  it('stamps the provided sessionId on every event', async () => {
    const { spy, fetch } = okFetch()
    const exporter = new VoightExporter({
      agent: 'demo-app',
      voightApiKey: 'vk_test_abc',
      sessionId: 'sess-fixed-001',
      fetch,
    })
    exporter.export([llmSpan(), llmSpan()], vi.fn())
    await new Promise((r) => setImmediate(r))
    for (const call of spy.mock.calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string)
      expect(body.metadata.sessionId).toBe('sess-fixed-001')
    }
  })

  it('auto-generates a sessionId when not provided', async () => {
    const { spy, fetch } = okFetch()
    const exporter = new VoightExporter({
      agent: 'demo-app',
      voightApiKey: 'vk_test_abc',
      fetch,
    })
    exporter.export([llmSpan()], vi.fn())
    await new Promise((r) => setImmediate(r))
    const body = JSON.parse(
      (spy.mock.calls[0]![1] as RequestInit).body as string,
    )
    expect(typeof body.metadata.sessionId).toBe('string')
    expect(body.metadata.sessionId.length).toBeGreaterThanOrEqual(36)
  })

  it('reuses the same auto sessionId across exports of one exporter', async () => {
    const { spy, fetch } = okFetch()
    const exporter = new VoightExporter({
      agent: 'demo-app',
      voightApiKey: 'vk_test_abc',
      fetch,
    })
    exporter.export([llmSpan()], vi.fn())
    exporter.export([llmSpan()], vi.fn())
    await new Promise((r) => setImmediate(r))
    expect(spy).toHaveBeenCalledTimes(2)
    const a = JSON.parse(
      (spy.mock.calls[0]![1] as RequestInit).body as string,
    )
    const b = JSON.parse(
      (spy.mock.calls[1]![1] as RequestInit).body as string,
    )
    expect(a.metadata.sessionId).toBe(b.metadata.sessionId)
  })
})

describe('VoightExporter — result callback', () => {
  it('always resolves with SUCCESS, even on empty batches', () => {
    const exporter = new VoightExporter({
      agent: 'x',
      voightApiKey: 'vk_test',
      fetch: okFetch().fetch,
    })
    const cb = vi.fn()
    exporter.export([], cb)
    expect(cb).toHaveBeenCalledWith({ code: 0 })
  })

  it('resolves SUCCESS even when only non-LLM spans were given', () => {
    const exporter = new VoightExporter({
      agent: 'x',
      voightApiKey: 'vk_test',
      fetch: okFetch().fetch,
    })
    const cb = vi.fn()
    exporter.export([nonLlmSpan(), nonLlmSpan()], cb)
    expect(cb).toHaveBeenCalledWith({ code: 0 })
  })
})

describe('VoightExporter — dedup with wrapper-emitted spans', () => {
  // These tests guard the contract between this exporter and the
  // `@voightxyz/openai` + `@voightxyz/anthropic` wrappers running
  // with `otel: true`. Those wrappers stamp
  // `voight.source: 'wrapper'` on every span they emit (in
  // addition to POSTing the same event directly to /v1/events).
  // The exporter MUST skip those spans, otherwise the dashboard
  // sees every wrapper call twice.

  function wrapperSpan(
    overrides: Partial<ReadableSpanLike> = {},
  ): ReadableSpanLike {
    return llmSpan({
      name: 'voight.openai.chat',
      attributes: {
        'gen_ai.system': 'openai',
        'gen_ai.request.model': 'gpt-4o-mini',
        'gen_ai.usage.input_tokens': 120,
        'gen_ai.usage.output_tokens': 47,
        'voight.source': 'wrapper',
        'voight.package': '@voightxyz/openai',
      },
      ...overrides,
    })
  }

  it("drops spans tagged with voight.source='wrapper'", async () => {
    const { spy, fetch } = okFetch()
    const exporter = new VoightExporter({
      agent: 'demo-app',
      voightApiKey: 'vk_test_abc',
      fetch,
    })
    exporter.export([wrapperSpan()], vi.fn())
    await new Promise((r) => setImmediate(r))
    // The wrapper already POSTed this event directly; the exporter
    // must not POST it again.
    expect(spy).not.toHaveBeenCalled()
  })

  it('still POSTs spans that lack the wrapper marker (Vercel AI SDK path stays intact)', async () => {
    const { spy, fetch } = okFetch()
    const exporter = new VoightExporter({
      agent: 'demo-app',
      voightApiKey: 'vk_test_abc',
      fetch,
    })
    // A regular Vercel AI SDK span — no voight.source attribute.
    // Must be POSTed normally; the dedup only kicks in when the
    // marker is explicitly present.
    exporter.export([llmSpan()], vi.fn())
    await new Promise((r) => setImmediate(r))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('only dedups the wrapper marker — other voight.source values pass through', async () => {
    const { spy, fetch } = okFetch()
    const exporter = new VoightExporter({
      agent: 'demo-app',
      voightApiKey: 'vk_test_abc',
      fetch,
    })
    // Hypothetical future source — must NOT be filtered. The dedup
    // is exact-string match against 'wrapper'; only the two
    // direct-wrapper packages set that exact value.
    exporter.export(
      [
        llmSpan({
          attributes: {
            'gen_ai.system': 'openai',
            'gen_ai.request.model': 'gpt-4o-mini',
            'gen_ai.usage.input_tokens': 1,
            'gen_ai.usage.output_tokens': 1,
            'voight.source': 'something-else',
          },
        }),
      ],
      vi.fn(),
    )
    await new Promise((r) => setImmediate(r))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('correctly partitions a mixed batch — wrapper spans dropped, Vercel spans POSTed', async () => {
    const { spy, fetch } = okFetch()
    const exporter = new VoightExporter({
      agent: 'demo-app',
      voightApiKey: 'vk_test_abc',
      fetch,
    })
    // Realistic batch: 2 wrapper spans + 2 Vercel AI spans
    // interleaved. Expect 2 POSTs (the Vercel ones), wrapper ones
    // skipped.
    exporter.export(
      [wrapperSpan(), llmSpan(), wrapperSpan(), llmSpan()],
      vi.fn(),
    )
    await new Promise((r) => setImmediate(r))
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe('VoightExporter — lifecycle', () => {
  it('shutdown() resolves immediately', async () => {
    const exporter = new VoightExporter({ agent: 'x', voightApiKey: 'vk_test' })
    await expect(exporter.shutdown()).resolves.toBeUndefined()
  })

  it('forceFlush() resolves immediately', async () => {
    const exporter = new VoightExporter({ agent: 'x', voightApiKey: 'vk_test' })
    await expect(exporter.forceFlush()).resolves.toBeUndefined()
  })
})
