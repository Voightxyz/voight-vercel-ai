/**
 * Tests for `mapAttributes` — the heart of the exporter.
 *
 * Coverage targets:
 *
 *   1. Primary path (`gen_ai.*`) populates every field correctly.
 *   2. Fallback path (`ai.*`) populates the same fields when the
 *      primary attributes are absent.
 *   3. When both namespaces are present, primary wins.
 *   4. Per-field defensive defaults (missing tokens = 0, missing
 *      provider = `'unknown'`, malformed JSON = passthrough).
 *   5. Streaming detection from span name.
 *   6. Status mapping: UNSET / OK → `'success'`; ERROR → `'failed'`.
 *   7. HrTime delta arithmetic, including a malformed-tuple fallback.
 *   8. Privacy fan-out at each of the three levels.
 *   9. Non-LLM spans return `null` (so the exporter skips them).
 */

import { describe, it, expect } from 'vitest'

import {
  mapAttributes,
  extractBaseProvider,
  hrTimeDeltaMs,
  type SpanLike,
} from '../../src/attribute-mapper.js'

// ─── Fixture helpers ───────────────────────────────────────────────

function span(overrides: Partial<SpanLike> = {}): SpanLike {
  return {
    name: 'ai.generateText.doGenerate',
    attributes: {},
    startTime: [1700000000, 0],
    endTime: [1700000001, 500_000_000], // +1.5s
    status: { code: 1 }, // OK
    ...overrides,
  }
}

const GEN_AI_MIN_ATTRS = {
  'gen_ai.system': 'openai',
  'gen_ai.request.model': 'gpt-4o-mini',
  'gen_ai.usage.input_tokens': 120,
  'gen_ai.usage.output_tokens': 47,
}

const AI_MIN_ATTRS = {
  'ai.model.id': 'gpt-4o-mini',
  'ai.model.provider': 'openai.chat',
  'ai.usage.promptTokens': 120,
  'ai.usage.completionTokens': 47,
}

// ─── extractBaseProvider ───────────────────────────────────────────

describe('extractBaseProvider', () => {
  it('strips a sub-namespace (Vercel format)', () => {
    expect(extractBaseProvider('openai.responses')).toBe('openai')
    expect(extractBaseProvider('anthropic.messages')).toBe('anthropic')
    expect(extractBaseProvider('aws.bedrock.converse')).toBe('aws')
  })

  it('passes plain provider names through unchanged', () => {
    expect(extractBaseProvider('openai')).toBe('openai')
    expect(extractBaseProvider('anthropic')).toBe('anthropic')
  })

  it("returns 'unknown' for null / empty / whitespace", () => {
    expect(extractBaseProvider(null)).toBe('unknown')
    expect(extractBaseProvider('')).toBe('unknown')
    expect(extractBaseProvider('   ')).toBe('unknown')
  })
})

// ─── hrTimeDeltaMs ─────────────────────────────────────────────────

describe('hrTimeDeltaMs', () => {
  it('handles whole-second deltas', () => {
    expect(hrTimeDeltaMs([1000, 0], [1002, 0])).toBe(2000)
  })

  it('handles sub-second nanosecond components', () => {
    expect(hrTimeDeltaMs([1000, 0], [1000, 500_000_000])).toBe(500)
  })

  it('handles mixed second + nanosecond components', () => {
    // 1.5s + 250ms = 1750ms
    expect(hrTimeDeltaMs([1000, 0], [1001, 750_000_000])).toBe(1750)
  })

  it('returns 0 on malformed tuples (defensive, never NaN)', () => {
    // @ts-expect-error - intentional bad shape
    expect(hrTimeDeltaMs([1000], [1001, 0])).toBe(0)
    // @ts-expect-error - intentional bad shape
    expect(hrTimeDeltaMs(null, [1001, 0])).toBe(0)
    // @ts-expect-error - intentional bad shape
    expect(hrTimeDeltaMs(['x', 0], [1001, 0])).toBe(0)
  })

  it('returns 0 for a negative delta (clock-skew defence)', () => {
    expect(hrTimeDeltaMs([1001, 0], [1000, 0])).toBe(0)
  })
})

// ─── mapAttributes — primary gen_ai.* path ─────────────────────────

describe('mapAttributes — gen_ai.* primary', () => {
  it('extracts model + provider + tokens', () => {
    const event = mapAttributes(span({ attributes: GEN_AI_MIN_ATTRS }))
    expect(event).not.toBeNull()
    expect(event!.model).toBe('gpt-4o-mini')
    expect(event!.metadata!.provider).toBe('openai')
    expect((event!.metadata!.tokens as Record<string, number>).input).toBe(120)
    expect((event!.metadata!.tokens as Record<string, number>).output).toBe(47)
  })

  it('includes cache tokens only when > 0', () => {
    const ev = mapAttributes(
      span({
        attributes: {
          ...GEN_AI_MIN_ATTRS,
          'gen_ai.usage.cache_read_input_tokens': 99,
          'gen_ai.usage.cache_write_input_tokens': 0,
        },
      }),
    )
    const tokens = ev!.metadata!.tokens as Record<string, number>
    expect(tokens.cache_read).toBe(99)
    expect('cache_creation' in tokens).toBe(false)
  })

  it('parses gen_ai.prompt JSON-stringified arrays', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    const ev = mapAttributes(
      span({
        attributes: {
          ...GEN_AI_MIN_ATTRS,
          'gen_ai.prompt': JSON.stringify(messages),
        },
      }),
    )
    expect((ev!.input as Record<string, unknown>).messages).toEqual(messages)
  })

  it('extracts finishReason from finish_reasons[0]', () => {
    const ev = mapAttributes(
      span({
        attributes: {
          ...GEN_AI_MIN_ATTRS,
          'gen_ai.response.finish_reasons': ['stop', 'length'],
        },
      }),
    )
    expect(ev!.metadata!.finishReason).toBe('stop')
  })
})

// ─── mapAttributes — fallback ai.* path ────────────────────────────

describe('mapAttributes — ai.* fallback', () => {
  it('extracts model + provider + tokens from Vercel attrs only', () => {
    const ev = mapAttributes(span({ attributes: AI_MIN_ATTRS }))
    expect(ev).not.toBeNull()
    expect(ev!.model).toBe('gpt-4o-mini')
    expect(ev!.metadata!.provider).toBe('openai')
    expect(ev!.metadata!.providerSurface).toBe('openai.chat')
    expect((ev!.metadata!.tokens as Record<string, number>).input).toBe(120)
  })

  it('extracts responseText + finishReason from ai.* fields', () => {
    const ev = mapAttributes(
      span({
        attributes: {
          ...AI_MIN_ATTRS,
          'ai.response.text': 'hello world',
          'ai.response.finishReason': 'stop',
        },
      }),
    )
    expect(ev!.metadata!.responseText).toBe('hello world')
    expect(ev!.metadata!.finishReason).toBe('stop')
  })

  it('normalises Vercel-shape toolCalls to {id, name, arguments}', () => {
    const ev = mapAttributes(
      span({
        attributes: {
          ...AI_MIN_ATTRS,
          'ai.response.toolCalls': JSON.stringify([
            { toolCallId: 'c1', toolName: 'get_weather', args: { city: 'Tokyo' } },
          ]),
        },
      }),
    )
    const calls = ev!.metadata!.toolCalls as Array<Record<string, unknown>>
    expect(calls).toHaveLength(1)
    expect(calls[0]!.id).toBe('c1')
    expect(calls[0]!.name).toBe('get_weather')
    expect(calls[0]!.arguments).toEqual({ city: 'Tokyo' })
    expect(ev!.toolExecuted).toBe('get_weather')
  })
})

// ─── mapAttributes — primary wins over fallback ────────────────────

describe('mapAttributes — namespace priority', () => {
  it('prefers gen_ai.* values when both namespaces are populated', () => {
    const ev = mapAttributes(
      span({
        attributes: {
          ...AI_MIN_ATTRS, // model=gpt-4o-mini, provider=openai.chat
          'gen_ai.request.model': 'gpt-4o',
          'gen_ai.system': 'openai',
        },
      }),
    )
    expect(ev!.model).toBe('gpt-4o')
    expect(ev!.metadata!.provider).toBe('openai')
    // providerSurface only set when raw differs from extracted base;
    // here raw = 'openai' so the field is absent.
    expect('providerSurface' in (ev!.metadata as object)).toBe(false)
  })
})

// ─── mapAttributes — defensive defaults ────────────────────────────

describe('mapAttributes — defensive defaults', () => {
  it('returns null for spans with no LLM attributes (non-LLM leak)', () => {
    const ev = mapAttributes(
      span({ attributes: { 'http.method': 'POST' } }),
    )
    expect(ev).toBeNull()
  })

  it('returns 0 for missing token counts', () => {
    const ev = mapAttributes(
      span({
        attributes: {
          'gen_ai.request.model': 'gpt-4o',
          // No usage attrs.
        },
      }),
    )
    const tokens = ev!.metadata!.tokens as Record<string, number>
    expect(tokens.input).toBe(0)
    expect(tokens.output).toBe(0)
  })

  it("falls back to 'unknown' provider when neither namespace has it", () => {
    const ev = mapAttributes(
      span({ attributes: { 'gen_ai.request.model': 'gpt-4o' } }),
    )
    expect(ev!.metadata!.provider).toBe('unknown')
  })

  it('coerces string-typed token counts to numbers', () => {
    const ev = mapAttributes(
      span({
        attributes: {
          'gen_ai.request.model': 'gpt-4o',
          'gen_ai.usage.input_tokens': '120',
          'gen_ai.usage.output_tokens': '47',
        },
      }),
    )
    const tokens = ev!.metadata!.tokens as Record<string, number>
    expect(tokens.input).toBe(120)
    expect(tokens.output).toBe(47)
  })

  it('passes through malformed JSON prompts as-is rather than crashing', () => {
    const ev = mapAttributes(
      span({
        attributes: {
          ...GEN_AI_MIN_ATTRS,
          'gen_ai.prompt': '{not valid json',
        },
      }),
    )
    expect((ev!.input as Record<string, unknown>).messages).toBe(
      '{not valid json',
    )
  })
})

// ─── mapAttributes — streaming detection ───────────────────────────

describe('mapAttributes — streaming detection', () => {
  it("sets metadata.streaming=true for 'ai.streamText.doStream'", () => {
    const ev = mapAttributes(
      span({
        name: 'ai.streamText.doStream',
        attributes: GEN_AI_MIN_ATTRS,
      }),
    )
    expect(ev!.metadata!.streaming).toBe(true)
  })

  it("sets metadata.streaming=false for 'ai.generateText.doGenerate'", () => {
    const ev = mapAttributes(
      span({
        name: 'ai.generateText.doGenerate',
        attributes: GEN_AI_MIN_ATTRS,
      }),
    )
    expect(ev!.metadata!.streaming).toBe(false)
  })
})

// ─── mapAttributes — Vercel outer-wrapper filter ───────────────────

describe('mapAttributes — Vercel outer-wrapper filter', () => {
  it("returns null for the 'ai.generateText' outer wrapper", () => {
    expect(
      mapAttributes(
        span({ name: 'ai.generateText', attributes: GEN_AI_MIN_ATTRS }),
      ),
    ).toBeNull()
  })

  it("returns null for the 'ai.streamText' outer wrapper", () => {
    expect(
      mapAttributes(
        span({ name: 'ai.streamText', attributes: GEN_AI_MIN_ATTRS }),
      ),
    ).toBeNull()
  })

  it("returns null for the 'ai.generateObject' outer wrapper", () => {
    expect(
      mapAttributes(
        span({ name: 'ai.generateObject', attributes: GEN_AI_MIN_ATTRS }),
      ),
    ).toBeNull()
  })

  it('keeps inner Vercel spans (.doGenerate / .doStream)', () => {
    expect(
      mapAttributes(
        span({
          name: 'ai.generateText.doGenerate',
          attributes: GEN_AI_MIN_ATTRS,
        }),
      ),
    ).not.toBeNull()
    expect(
      mapAttributes(
        span({
          name: 'ai.streamText.doStream',
          attributes: GEN_AI_MIN_ATTRS,
        }),
      ),
    ).not.toBeNull()
  })

  it('keeps non-Vercel spans whose names do not start with ai.', () => {
    // A LangChain or LiteLLM auto-instrumentation span using
    // `gen_ai.*` semconv directly. No `ai.` prefix → no skip.
    expect(
      mapAttributes(
        span({
          name: 'gen_ai.client.request',
          attributes: GEN_AI_MIN_ATTRS,
        }),
      ),
    ).not.toBeNull()
  })
})

// ─── mapAttributes — outcome / status ──────────────────────────────

describe('mapAttributes — outcome + status', () => {
  it("returns outcome='success' for UNSET / OK status", () => {
    expect(
      mapAttributes(
        span({ attributes: GEN_AI_MIN_ATTRS, status: { code: 0 } }),
      )!.outcome,
    ).toBe('success')
    expect(
      mapAttributes(
        span({ attributes: GEN_AI_MIN_ATTRS, status: { code: 1 } }),
      )!.outcome,
    ).toBe('success')
  })

  it("returns outcome='failed' + errorMessage for ERROR status", () => {
    const ev = mapAttributes(
      span({
        attributes: GEN_AI_MIN_ATTRS,
        status: { code: 2, message: 'rate limited' },
      }),
    )
    expect(ev!.outcome).toBe('failed')
    expect(ev!.errorMessage).toBe('rate limited')
  })

  it("uses 'unknown' as the errorMessage when message is absent", () => {
    const ev = mapAttributes(
      span({ attributes: GEN_AI_MIN_ATTRS, status: { code: 2 } }),
    )
    expect(ev!.outcome).toBe('failed')
    expect(ev!.errorMessage).toBe('unknown')
  })
})

// ─── mapAttributes — privacy fan-out ───────────────────────────────

describe('mapAttributes — privacy levels', () => {
  const attrs = {
    ...GEN_AI_MIN_ATTRS,
    'gen_ai.prompt': JSON.stringify([
      { role: 'user', content: 'email me at alice@example.com' },
    ]),
    'gen_ai.completion': 'sent confirmation to alice@example.com',
    'gen_ai.tool_calls': JSON.stringify([
      {
        id: 'c1',
        name: 'send_email',
        arguments: { to: 'alice@example.com' },
      },
    ]),
  }

  it("'standard' (default) scrubs PII from messages, response, tool args", () => {
    const ev = mapAttributes(span({ attributes: attrs }))
    const msgs = (ev!.input as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >
    expect(msgs[0]!.content).not.toContain('alice@example.com')
    expect(ev!.metadata!.responseText).not.toContain('alice@example.com')
    const call = (ev!.metadata!.toolCalls as Array<Record<string, unknown>>)[0]!
    expect(JSON.stringify(call.arguments)).not.toContain('alice@example.com')
  })

  it("'full' leaves content untouched", () => {
    const ev = mapAttributes(span({ attributes: attrs }), { privacy: 'full' })
    const msgs = (ev!.input as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >
    expect(msgs[0]!.content).toBe('email me at alice@example.com')
    expect(ev!.metadata!.responseText).toBe(
      'sent confirmation to alice@example.com',
    )
  })

  it("'minimal' strips messages + responseText, keeps tool names", () => {
    const ev = mapAttributes(span({ attributes: attrs }), {
      privacy: 'minimal',
    })
    expect(ev!.input).toBeUndefined()
    expect('responseText' in (ev!.metadata as object)).toBe(false)
    const calls = ev!.metadata!.toolCalls as Array<Record<string, unknown>>
    expect(calls[0]!.name).toBe('send_email')
    expect(calls[0]!.arguments).toBeNull()
  })
})

// ─── mapAttributes — sessionId pass-through ────────────────────────

describe('mapAttributes — sessionId option', () => {
  it('stamps metadata.sessionId when provided', () => {
    const ev = mapAttributes(span({ attributes: GEN_AI_MIN_ATTRS }), {
      sessionId: 'sess-abc',
    })
    expect(ev!.metadata!.sessionId).toBe('sess-abc')
  })

  it('omits metadata.sessionId when not provided', () => {
    const ev = mapAttributes(span({ attributes: GEN_AI_MIN_ATTRS }))
    expect('sessionId' in (ev!.metadata as object)).toBe(false)
  })
})

// ─── mapAttributes — providerSurface preservation ──────────────────

describe('mapAttributes — providerSurface debug field', () => {
  it("emits providerSurface when raw provider includes a sub-namespace", () => {
    const ev = mapAttributes(
      span({
        attributes: {
          ...AI_MIN_ATTRS,
          'ai.model.provider': 'openai.responses',
        },
      }),
    )
    expect(ev!.metadata!.provider).toBe('openai')
    expect(ev!.metadata!.providerSurface).toBe('openai.responses')
  })

  it('omits providerSurface when raw == base provider', () => {
    const ev = mapAttributes(
      span({
        attributes: {
          ...AI_MIN_ATTRS,
          'ai.model.provider': 'openai',
        },
      }),
    )
    expect('providerSurface' in (ev!.metadata as object)).toBe(false)
  })
})

// ─── mapAttributes — always-present metadata fields ────────────────

describe('mapAttributes — always-present metadata', () => {
  it("stamps source='vercel-ai-sdk', api='vercel-ai', privacyLevel", () => {
    const ev = mapAttributes(span({ attributes: GEN_AI_MIN_ATTRS }))
    expect(ev!.metadata!.source).toBe('vercel-ai-sdk')
    expect(ev!.metadata!.api).toBe('vercel-ai')
    expect(ev!.metadata!.privacyLevel).toBe('standard')
  })
})
