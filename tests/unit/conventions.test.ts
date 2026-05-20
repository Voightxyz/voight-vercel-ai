/**
 * Tests for the attribute-name constant tables.
 *
 * These look like trivial string-equality tests, and they are — on
 * purpose. The whole point of having the names extracted into
 * constants is so that a typo in one place can't silently misroute
 * an attribute lookup at runtime. The test catches the typo at the
 * point where the constant is defined: if a refactor accidentally
 * changes `'gen_ai.usage.input_tokens'` to
 * `'gen_ai.usage.inputTokens'`, this file fails before the mapper
 * does and the diff stays focused on the convention layer.
 *
 * Both namespaces are pinned: `gen_ai.*` from the OTel GenAI
 * semconv (incubating, 2026-05), `ai.*` from a real Vercel AI SDK
 * 6.x `streamText` span. Anchoring them here also makes the spec
 * version reviewed explicit in source control history.
 */

import { describe, it, expect } from 'vitest'

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
} from '../../src/conventions.js'

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
} from '../../src/vercel-conventions.js'

describe('OTel GenAI semconv constants', () => {
  it('uses the spec attribute names verbatim', () => {
    expect(GEN_AI_SYSTEM).toBe('gen_ai.system')
    expect(GEN_AI_REQUEST_MODEL).toBe('gen_ai.request.model')
    expect(GEN_AI_RESPONSE_MODEL).toBe('gen_ai.response.model')
    expect(GEN_AI_PROMPT).toBe('gen_ai.prompt')
    expect(GEN_AI_COMPLETION).toBe('gen_ai.completion')
    expect(GEN_AI_TOOL_CALLS).toBe('gen_ai.tool_calls')
    expect(GEN_AI_RESPONSE_FINISH_REASONS).toBe(
      'gen_ai.response.finish_reasons',
    )
  })

  it('uses snake_case for usage subfields, matching the spec', () => {
    expect(GEN_AI_USAGE_INPUT_TOKENS).toBe('gen_ai.usage.input_tokens')
    expect(GEN_AI_USAGE_OUTPUT_TOKENS).toBe('gen_ai.usage.output_tokens')
    expect(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS).toBe(
      'gen_ai.usage.cache_read_input_tokens',
    )
    expect(GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS).toBe(
      'gen_ai.usage.cache_write_input_tokens',
    )
  })
})

describe('Vercel AI SDK ai.* constants', () => {
  it('uses camelCase under the ai.model / ai.response namespaces', () => {
    expect(AI_MODEL_ID).toBe('ai.model.id')
    expect(AI_MODEL_PROVIDER).toBe('ai.model.provider')
    expect(AI_PROMPT_MESSAGES).toBe('ai.prompt.messages')
    expect(AI_RESPONSE_TEXT).toBe('ai.response.text')
    expect(AI_RESPONSE_TOOL_CALLS).toBe('ai.response.toolCalls')
    expect(AI_RESPONSE_FINISH_REASON).toBe('ai.response.finishReason')
  })

  it('uses camelCase under ai.usage (Vercel-specific naming)', () => {
    expect(AI_USAGE_PROMPT_TOKENS).toBe('ai.usage.promptTokens')
    expect(AI_USAGE_COMPLETION_TOKENS).toBe('ai.usage.completionTokens')
    expect(AI_USAGE_CACHED_INPUT_TOKENS).toBe('ai.usage.cachedInputTokens')
    expect(AI_USAGE_CACHE_CREATION_INPUT_TOKENS).toBe(
      'ai.usage.cacheCreationInputTokens',
    )
  })
})

describe('namespace isolation', () => {
  it('keeps gen_ai.* and ai.* disjoint (no accidental collision)', () => {
    const genAi = [
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
    ]
    const ai = [
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
    ]
    expect(genAi.every((k) => k.startsWith('gen_ai.'))).toBe(true)
    expect(ai.every((k) => k.startsWith('ai.'))).toBe(true)
    expect(genAi.some((k) => ai.includes(k))).toBe(false)
  })
})
