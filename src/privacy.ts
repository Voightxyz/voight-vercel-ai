/**
 * PII scrubbing utilities. Ports the regex catalogue proven in
 * @voightxyz/sdk's privacy.ts (12 patterns + Luhn-validated cards),
 * trimmed to the surface this package needs.
 *
 * `scrubPii` and `scrubAnyValue` are pure: same input produces same
 * output, no I/O, no randomness. Safe to call in a hot path.
 *
 * Why duplicate the catalogue here (rather than depend on the SDK)?
 *
 *   v0.1.0-beta.1 ships standalone — no runtime dependency on
 *   `@voightxyz/sdk` — so a user installing only `@voightxyz/openai`
 *   gets a complete package. If duplication ever becomes painful
 *   (a third copy under @voightxyz/anthropic, say), the right move
 *   is to extract a private `@voightxyz/core` package; until then,
 *   the cost of a 12-pattern table is lower than the cost of a
 *   peer-dep + version-skew matrix.
 */

// ─── PII patterns ──────────────────────────────────────────────────
//
// Order matters. Multi-line / most-specific patterns run FIRST so
// that once a span is consumed (e.g. a PEM block), later patterns
// can't re-match its insides. JWTs run before generic API-key
// patterns to avoid partial matches.
//
// Each pattern has a `name` for unit-test traceability and a `re`
// that uses the global flag (so `replaceAll` semantics apply).

type Pattern = {
  name: string
  re: RegExp
  replacement: string
}

const RE_PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g

const RE_JWT =
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g

// Anthropic must precede the generic OpenAI rule so `sk-ant-...`
// doesn't get partially consumed as `sk-...`.
const RE_ANTHROPIC = /\bsk-ant-[A-Za-z0-9_-]{40,}\b/g

const RE_OPENAI = /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g

const RE_STRIPE_LIVE = /\b(?:sk|pk)_live_[A-Za-z0-9]{20,}\b/g

const RE_GITHUB_FINE = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g
const RE_GITHUB_CLASSIC = /\bghp_[A-Za-z0-9]{36}\b/g

const RE_AWS_ACCESS_KEY = /\bAKIA[A-Z0-9]{16}\b/g

const RE_SLACK = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g

// Voight's own keys. Defense-in-depth: even if the user accidentally
// pastes their `vk_…` into a prompt, it never leaves the process in
// the clear under standard privacy.
const RE_VOIGHT = /\bvk_[A-Za-z0-9_-]{32,}\b/g

// Strict email: requires a TLD with ≥2 letters. `support@app`
// (no TLD) and `email_template` (no @) do not match.
const RE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

// Phone in E.164. Looser variants produce too many false positives
// over order numbers and identifiers.
const RE_PHONE_E164 = /\+\d{10,15}\b/g

const KEY_PATTERNS: readonly Pattern[] = [
  { name: 'pem-private-key', re: RE_PEM_PRIVATE_KEY, replacement: '[REDACTED-PRIVATE-KEY]' },
  { name: 'jwt', re: RE_JWT, replacement: '[REDACTED-JWT]' },
  { name: 'anthropic-key', re: RE_ANTHROPIC, replacement: '[REDACTED-API-KEY]' },
  { name: 'openai-key', re: RE_OPENAI, replacement: '[REDACTED-API-KEY]' },
  { name: 'stripe-live-key', re: RE_STRIPE_LIVE, replacement: '[REDACTED-API-KEY]' },
  { name: 'github-fine-pat', re: RE_GITHUB_FINE, replacement: '[REDACTED-API-KEY]' },
  { name: 'github-classic-pat', re: RE_GITHUB_CLASSIC, replacement: '[REDACTED-API-KEY]' },
  { name: 'aws-access-key', re: RE_AWS_ACCESS_KEY, replacement: '[REDACTED-API-KEY]' },
  { name: 'slack-token', re: RE_SLACK, replacement: '[REDACTED-API-KEY]' },
  { name: 'voight-key', re: RE_VOIGHT, replacement: '[REDACTED-API-KEY]' },
  { name: 'email', re: RE_EMAIL, replacement: '[REDACTED-EMAIL]' },
  { name: 'phone-e164', re: RE_PHONE_E164, replacement: '[REDACTED-PHONE]' },
]

// ─── Credit cards ─────────────────────────────────────────────────
//
// Credit-card numbers need Luhn validation to avoid false positives
// over long numeric ID strings, so they don't fit the simple
// {re, replacement} table.

/**
 * Validate a digit string against the Luhn checksum used by all
 * major card brands. Returns false on empty / non-digit input.
 */
export function luhnValid(digits: string): boolean {
  if (digits.length === 0) return false
  let sum = 0
  let alternate = false
  for (let i = digits.length - 1; i >= 0; i--) {
    const ch = digits.charCodeAt(i)
    if (ch < 48 || ch > 57) return false
    let n = ch - 48
    if (alternate) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alternate = !alternate
  }
  return sum > 0 && sum % 10 === 0
}

// 13–19 digits, optionally with single spaces or dashes between
// groups. Anchored with \b so we don't match the middle of a longer
// digit string.
const RE_CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g

function scrubCreditCards(input: string): string {
  return input.replace(RE_CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, '')
    if (digits.length < 13 || digits.length > 19) return match
    if (!luhnValid(digits)) return match
    return '[REDACTED-CARD]'
  })
}

/**
 * Run the credential / PII patterns over a string. Pure, idempotent
 * (already-scrubbed text stays stable), no I/O. Non-string input
 * is returned unchanged so this function is safe to call inside
 * the recursive walker.
 */
export function scrubPii(input: string): string {
  // The non-string branch matters: `scrubAnyValue` calls this on
  // unknown values, and we'd rather return the raw value than crash.
  if (typeof input !== 'string' || input.length === 0) return input
  let out = input
  for (const { re, replacement } of KEY_PATTERNS) {
    // Pin a fresh RegExp instance per call: `g`-flagged regexes
    // carry mutable `lastIndex` state, and although `replace` does
    // not depend on it, future Worker-based callers might.
    out = out.replace(new RegExp(re.source, re.flags), replacement)
  }
  out = scrubCreditCards(out)
  return out
}

/**
 * Recursively scrub every string leaf in a JSON-like value.
 * Non-string primitives, undefined, arrays, and plain objects are
 * walked structurally. Anything else (Date, Map, Set, etc.) is
 * returned unchanged — this package never serialises those.
 *
 * Returns a fresh value; the input is never mutated.
 */
export function scrubAnyValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubPii(value)
  if (Array.isArray(value)) return value.map(scrubAnyValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubAnyValue(v)
    }
    return out
  }
  return value
}
