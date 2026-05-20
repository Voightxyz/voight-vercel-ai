/**
 * Tests for identity resolution.
 *
 * `resolveApiKey` and `resolveAgent` are pure functions: they take
 * options + env and return a result. No global state, no I/O. This
 * keeps the wrapper deterministic — the same options + env produce
 * the same identity, every time.
 */

import { describe, it, expect } from 'vitest'

import { resolveApiKey, resolveAgent } from '../../src/identity.js'

describe('resolveApiKey', () => {
  it('prefers an explicit option over env', () => {
    expect(
      resolveApiKey(
        { voightApiKey: 'vk_explicit' },
        { VOIGHT_KEY: 'vk_env' },
      ),
    ).toBe('vk_explicit')
  })

  it('falls back to VOIGHT_KEY env when no option is supplied', () => {
    expect(resolveApiKey({}, { VOIGHT_KEY: 'vk_env' })).toBe('vk_env')
  })

  it('returns null when neither option nor env is set', () => {
    expect(resolveApiKey({}, {})).toBeNull()
  })

  it('treats empty / whitespace-only values as missing', () => {
    expect(resolveApiKey({ voightApiKey: '' }, {})).toBeNull()
    expect(resolveApiKey({ voightApiKey: '   ' }, {})).toBeNull()
    expect(resolveApiKey({}, { VOIGHT_KEY: '' })).toBeNull()
    expect(resolveApiKey({}, { VOIGHT_KEY: '   ' })).toBeNull()
  })

  it('trims whitespace around an otherwise valid value', () => {
    expect(
      resolveApiKey({ voightApiKey: '  vk_test  ' }, {}),
    ).toBe('vk_test')
  })
})

describe('resolveAgent', () => {
  it('prefers an explicit option', () => {
    expect(
      resolveAgent(
        { agent: 'explicit-agent' },
        { VOIGHT_AGENT: 'env-agent', HOSTNAME: 'box.local' },
      ),
    ).toBe('explicit-agent')
  })

  it('falls back to VOIGHT_AGENT env', () => {
    expect(
      resolveAgent(
        {},
        { VOIGHT_AGENT: 'env-agent', HOSTNAME: 'box.local' },
      ),
    ).toBe('env-agent')
  })

  it('falls back to HOSTNAME when VOIGHT_AGENT is unset', () => {
    expect(resolveAgent({}, { HOSTNAME: 'box.local' })).toBe('box.local')
  })

  it('falls back to `unknown-agent` when nothing is set', () => {
    expect(resolveAgent({}, {})).toBe('unknown-agent')
  })

  it('skips empty values during fallback', () => {
    // An empty `agent` option should fall through to VOIGHT_AGENT;
    // an empty VOIGHT_AGENT should fall through to HOSTNAME.
    expect(
      resolveAgent(
        { agent: '' },
        { VOIGHT_AGENT: '', HOSTNAME: 'box.local' },
      ),
    ).toBe('box.local')
  })

  it('trims whitespace around an otherwise valid value', () => {
    expect(resolveAgent({ agent: '  my-agent  ' }, {})).toBe('my-agent')
  })
})
