/**
 * Tests for the PII scrubbing helpers in @voightxyz/openai.
 *
 * This module is a leaner port of the patterns proven in
 * @voightxyz/sdk's privacy.ts (12 patterns + Luhn). We keep the
 * same redaction surface so an OpenAI call going through this
 * wrapper produces the same scrub output a hook event would.
 *
 * Coverage philosophy:
 *   - One positive + one negative per pattern family.
 *   - Idempotency: scrubbing already-scrubbed text is stable.
 *   - Recursive walk: structural shapes (object / array / nested)
 *     are exercised by `scrubAnyValue`.
 *
 * Adversarial cases (false-positive bait) lifted verbatim from
 * the parent SDK's test suite.
 */

import { describe, it, expect } from 'vitest'

import { scrubPii, scrubAnyValue, luhnValid } from '../../src/privacy.js'

describe('scrubPii — API keys', () => {
  it('redacts an Anthropic key', () => {
    const key =
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfGhIjKl'
    expect(scrubPii(`auth=${key} done`)).toBe('auth=[REDACTED-API-KEY] done')
  })

  it('redacts a classic OpenAI key', () => {
    expect(
      scrubPii('OPENAI_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'),
    ).toBe('OPENAI_KEY=[REDACTED-API-KEY]')
  })

  it('redacts a project-scoped OpenAI key', () => {
    expect(
      scrubPii('export KEY=sk-proj-Abc123Def456Ghi789Jkl0_mn-opqrstuv'),
    ).toBe('export KEY=[REDACTED-API-KEY]')
  })

  it('does not match a bare `sk-ant` prefix with no body', () => {
    expect(scrubPii('comment about sk-ant prefix')).toBe(
      'comment about sk-ant prefix',
    )
  })

  it('redacts a Voight key (vk_...)', () => {
    expect(
      scrubPii('VOIGHT_KEY=vk_AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789'),
    ).toBe('VOIGHT_KEY=[REDACTED-API-KEY]')
  })
})

describe('scrubPii — JWTs', () => {
  it('redacts a JWT triplet', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    expect(scrubPii(`Bearer ${jwt}`)).toBe('Bearer [REDACTED-JWT]')
  })

  it('leaves plain dotted base64 alone (no `eyJ` header)', () => {
    expect(scrubPii('hash:abc.def.ghi')).toBe('hash:abc.def.ghi')
  })
})

describe('scrubPii — emails and phones', () => {
  it('redacts an email', () => {
    expect(scrubPii('Reply to user@example.com please')).toBe(
      'Reply to [REDACTED-EMAIL] please',
    )
  })

  it('leaves a missing-TLD address alone', () => {
    expect(scrubPii('support@app')).toBe('support@app')
  })

  it('redacts an E.164 phone number', () => {
    expect(scrubPii('Call +14155552671 now')).toBe(
      'Call [REDACTED-PHONE] now',
    )
  })

  it('leaves an unprefixed digit string alone', () => {
    expect(scrubPii('order 4155552671 status')).toBe(
      'order 4155552671 status',
    )
  })
})

describe('scrubPii — credit cards (Luhn)', () => {
  it('redacts a Visa-shaped Luhn-valid number', () => {
    // 4111 1111 1111 1111 — canonical test Visa, Luhn-valid.
    expect(scrubPii('card 4111 1111 1111 1111 charged')).toBe(
      'card [REDACTED-CARD] charged',
    )
  })

  it('leaves a non-Luhn 16-digit string alone', () => {
    // Not a valid card number — Luhn fails. Should pass through.
    expect(scrubPii('id 1234567890123456 ok')).toBe(
      'id 1234567890123456 ok',
    )
  })

  it('luhnValid: positive', () => {
    expect(luhnValid('4111111111111111')).toBe(true)
  })

  it('luhnValid: negative', () => {
    expect(luhnValid('4111111111111112')).toBe(false)
  })

  it('luhnValid: rejects empty string', () => {
    expect(luhnValid('')).toBe(false)
  })

  it('luhnValid: rejects non-digit content', () => {
    expect(luhnValid('41a1')).toBe(false)
  })
})

describe('scrubPii — idempotency', () => {
  it('scrubbing twice yields the same output', () => {
    const raw =
      'auth=sk-ant-api03-Abc123Def456Ghi789Jkl012Mno345Pqr678Stu and ' +
      'mail user@example.com'
    const once = scrubPii(raw)
    const twice = scrubPii(once)
    expect(once).toBe(twice)
    expect(once).toContain('[REDACTED-API-KEY]')
    expect(once).toContain('[REDACTED-EMAIL]')
  })

  it('returns empty string unchanged', () => {
    expect(scrubPii('')).toBe('')
  })

  it('returns non-string input unchanged via the runtime guard', () => {
    // The guard exists so the function is safe to call on
    // `unknown`-typed values inside `scrubAnyValue`.
    expect(scrubPii(123 as unknown as string)).toBe(123)
  })
})

describe('scrubAnyValue', () => {
  it('scrubs strings inside a flat object', () => {
    const input = {
      prompt: 'reach me at user@example.com',
      model: 'gpt-4o-mini',
    }
    const out = scrubAnyValue(input) as typeof input
    expect(out.prompt).toBe('reach me at [REDACTED-EMAIL]')
    expect(out.model).toBe('gpt-4o-mini')
  })

  it('walks arrays', () => {
    const out = scrubAnyValue([
      'plain',
      'auth=sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    ]) as string[]
    expect(out[0]).toBe('plain')
    expect(out[1]).toBe('auth=[REDACTED-API-KEY]')
  })

  it('walks nested objects + arrays together', () => {
    const out = scrubAnyValue({
      messages: [
        { role: 'user', content: 'email me at jane@acme.io' },
        { role: 'assistant', content: 'ok' },
      ],
    }) as { messages: { role: string; content: string }[] }
    expect(out.messages[0]!.content).toBe('email me at [REDACTED-EMAIL]')
    expect(out.messages[1]!.content).toBe('ok')
  })

  it('passes numbers / booleans / null / undefined through unchanged', () => {
    expect(scrubAnyValue(42)).toBe(42)
    expect(scrubAnyValue(true)).toBe(true)
    expect(scrubAnyValue(null)).toBe(null)
    expect(scrubAnyValue(undefined)).toBe(undefined)
  })

  it('does not mutate the original object', () => {
    const original = { content: 'mail x@y.com' }
    const out = scrubAnyValue(original) as typeof original
    expect(original.content).toBe('mail x@y.com')
    expect(out.content).toBe('mail [REDACTED-EMAIL]')
  })
})
