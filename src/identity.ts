/**
 * Identity resolution: API key + agent label.
 *
 * Both helpers are pure — they take the user's options and an `env`
 * record, and return a result. `env` defaults to `process.env` when
 * called bare; passing it explicitly lets tests exercise every
 * fallback path without mutating global state.
 *
 * Resolution priority is fixed and documented at each call site:
 *
 *   resolveApiKey:  options.voightApiKey  →  env.VOIGHT_KEY  →  null
 *   resolveAgent:   options.agent  →  env.VOIGHT_AGENT
 *                                   →  env.HOSTNAME  →  'unknown-agent'
 *
 * Empty and whitespace-only values are treated as missing so a
 * misconfigured env (`VOIGHT_KEY=`) falls through cleanly instead
 * of being mistaken for a real key.
 */

export interface IdentityOptions {
  voightApiKey?: string | undefined
  agent?: string | undefined
}

type Env = Record<string, string | undefined>

/**
 * Trim and return the value, or `null` if it's missing / blank.
 * Centralises the "empty counts as missing" rule that both helpers
 * apply at every layer.
 */
function nonBlank(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Resolve the Voight API key for outgoing events.
 *
 * Returns `null` when nothing usable is configured. Callers decide
 * how to react — `wrapOpenAI` logs a one-time warning and falls
 * back to a no-op transport, so a missing key never crashes the
 * host app.
 */
export function resolveApiKey(
  options: IdentityOptions = {},
  env: Env = process.env,
): string | null {
  return nonBlank(options.voightApiKey) ?? nonBlank(env.VOIGHT_KEY)
}

/**
 * Resolve the agent label that groups events in the dashboard.
 *
 * Always returns a non-empty string: when nothing else resolves we
 * emit `'unknown-agent'` so the event is still ingestable and the
 * misconfiguration shows up on screen instead of being silently
 * dropped.
 */
export function resolveAgent(
  options: IdentityOptions = {},
  env: Env = process.env,
): string {
  return (
    nonBlank(options.agent) ??
    nonBlank(env.VOIGHT_AGENT) ??
    nonBlank(env.HOSTNAME) ??
    'unknown-agent'
  )
}
