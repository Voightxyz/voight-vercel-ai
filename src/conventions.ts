/**
 * OpenTelemetry GenAI semantic-convention attribute names.
 *
 * These constants are the **primary** path the attribute mapper
 * reads from. They follow the OTel GenAI semconv spec (incubating
 * as of 2026-05) — see
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/ — which most
 * modern LLM libraries (OpenAI's Python SDK, Anthropic's Python SDK,
 * LangChain, LlamaIndex, …) emit when OTel auto-instrumentation is
 * active.
 *
 * The Vercel AI SDK emits the parallel `ai.*` namespace today, which
 * the mapper falls back to via the constants in
 * `./vercel-conventions.ts`. If a future Vercel release migrates to
 * `gen_ai.*` natively, the primary path here automatically takes
 * over — no caller change needed.
 *
 * Constants are inlined rather than imported from
 * `@opentelemetry/semantic-conventions` because the GenAI subset
 * lives in the `/incubating` entrypoint of that package, which is
 * versioned independently and historically less stable than the
 * stable spans. Pinning the names here keeps the contract obvious
 * and lets us drop the `/incubating` dep entirely.
 */

// ─── Request side ──────────────────────────────────────────────────

/** Provider system: `'openai'`, `'anthropic'`, `'aws.bedrock'`, … */
export const GEN_AI_SYSTEM = 'gen_ai.system'

/** Requested model identifier, e.g. `'gpt-4o-mini'`. */
export const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model'

/** Prompt messages, typically a JSON-stringified array. */
export const GEN_AI_PROMPT = 'gen_ai.prompt'

// ─── Response side ─────────────────────────────────────────────────

/**
 * Response model (may differ from request — e.g. an OpenAI alias
 * resolves to a dated version on the response).
 */
export const GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model'

/** Response text, typically a JSON-stringified array of completions. */
export const GEN_AI_COMPLETION = 'gen_ai.completion'

/** Tool calls emitted by the model, typically a JSON-stringified array. */
export const GEN_AI_TOOL_CALLS = 'gen_ai.tool_calls'

/**
 * Stop reasons, an array (OpenAI returns one per choice). Examples:
 * `['stop']`, `['length']`, `['tool_calls']`.
 */
export const GEN_AI_RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons'

// ─── Token usage ───────────────────────────────────────────────────

/** Tokens in the prompt. */
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens'

/** Tokens in the completion. */
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens'

/**
 * Tokens served from cache on the input side (OpenAI prompt-caching,
 * Anthropic ephemeral cache_read).
 */
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS =
  'gen_ai.usage.cache_read_input_tokens'

/**
 * Tokens billed to write the cache on this request (Anthropic
 * ephemeral cache_creation; OpenAI does not currently expose this
 * separately).
 */
export const GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS =
  'gen_ai.usage.cache_write_input_tokens'
