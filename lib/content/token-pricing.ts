// Pure pricing + token typing. NO server-only imports here so this module is
// safe to pull into client bundles (e.g. via lib/tokens/aggregate.ts). The
// DB-writing recordTokenUsage lives in ./token-usage (server-only).

// High-level work category a Claude call belongs to. Drives the per-task
// rollup on the Token Usage dashboard.
export type TokenTask = 'onboarding' | 'audit' | 'content'

export type TokenStage =
  | 'keyword'
  | 'sitemap'
  | 'outline'
  | 'content'
  | 'idea'
  | 'resource'
  | 'social'
  | 'oneoff'
  | 'onboarding'
  | 'mbp'
  | 'mbp_edit'
  | 'mbp_synopsis'
  | 'audit'
  | 'audit_edit'
  | 'content_edit'
  | 'theme_edit'
  | 'site_structure_edit'
  | 'seo_fields'
  | 'brand'
  | 'new_page'
  | 'content_assistant'
  | 'critic'
  | 'qa_accuracy'
  | 'qa_copy'
  | 'qa_seo'
  | 'qa_structure'
  | 'qa_judge'
  | 'design_concept'
  | 'design_critique'
  | 'design_chat'

// Attribution context threaded into shared AI helpers (e.g. generateMbpJson)
// so each call records who/what it was for. Omitted fields record as null.
export type TokenContext = {
  task: TokenTask
  stage: TokenStage
  sessionId?: string | null
  contentJobId?: string | null
  auditId?: string | null
  pageUrl?: string | null
  // admins.id of the person this spend attributes to. Interactive routes pass it
  // directly; for background work recordTokenUsage resolves it from the audit /
  // content job when omitted.
  createdBy?: string | null
}

// USD per 1,000,000 tokens, keyed by model id. Verify against current
// Anthropic pricing before relying on cost_usd for actual billing — these
// are the published Sonnet/Haiku tier rates and may drift over time.
// A model id missing from this map silently prices at $0, so every model used
// anywhere in the app must have an entry here.
type Rate = { input: number; output: number; cacheRead?: number }
// `longPrompt`: a model priced by prompt length (Haiku 5.5) bills the whole
// request at the higher rates once its prompt — uncached + cache read + cache
// write — exceeds `threshold` tokens.
const PRICING: Record<string, Rate & { longPrompt?: Rate & { threshold: number } }> = {
  // Retired writing tier (kept so historical token_usage rows still price).
  'claude-opus-4-8': { input: 5, output: 25 },
  // Opus 5.5 bills cache hits at 0.05x input rather than the standard 0.1x.
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05 },
  // Fable 5.1 — 5x Sonnet 5 per the CLAUDE.md tier map. Only the design-model
  // A/B script calls it. Verify against Anthropic's price list before relying
  // on its recorded cost.
  'claude-fable-5-1': { input: 10, output: 50 },
  // $2/$10 launched as intro pricing and became the standard rate on 2026-09-01
  // (the scheduled rise to $3/$15 was cancelled).
  'claude-sonnet-5': { input: 2, output: 10 },
  // Sonnet 5.5 (2026-09-28) kept Sonnet 5's input/output rates, but bills cache
  // hits at 0.05x input ($0.10/MTok) like Opus 5.5.
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.05 },
  // Legacy interactive-chat tier (kept so historical token_usage rows still price).
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  // Haiku 5.5 (2026-10-07): $0.10/$0.50 up to a 100k-token prompt, $0.50/$2.50 above.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, longPrompt: { threshold: 100_000, input: 0.5, output: 2.5 } },
}

// Anthropic prompt-cache multipliers on the input rate: writing (creating) a
// cache entry costs 1.25x (2x with a 1h TTL), reading one costs 0.10x (unless the model's PRICING
// entry overrides cacheRead). `inputTokens` is the TOTAL
// input the AI SDK reports (uncached + read + write), so subtract the cache
// portions before pricing the uncached remainder. Both cache args default 0, so
// existing 3-arg callers price exactly as before.
export type CacheTtl = '5m' | '1h'
const CACHE_WRITE_MULTIPLIER: Record<CacheTtl, number> = { '5m': 1.25, '1h': 2 }
const CACHE_READ_MULTIPLIER = 0.1

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
  cacheTtl: CacheTtl = '5m',
): number {
  const rate = PRICING[model]
  if (!rate) {
    // A missing entry prices this call at $0 and silently under-reports spend on
    // the Token Usage dashboard. Surface it so a newly-added model id can't hide.
    console.error(`[token-pricing] unknown model "${model}" — recording $0; add it to PRICING`)
  }
  // inputTokens already includes the cache portions, so it IS the prompt length.
  const tier = rate?.longPrompt && inputTokens > rate.longPrompt.threshold ? rate.longPrompt : rate
  const { input, output, cacheRead = CACHE_READ_MULTIPLIER } = tier ?? { input: 0, output: 0 }
  const uncachedInput = Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens)
  return (
    (uncachedInput / 1_000_000) * input +
    (cacheCreationTokens / 1_000_000) * input * CACHE_WRITE_MULTIPLIER[cacheTtl] +
    (cacheReadTokens / 1_000_000) * input * cacheRead +
    (outputTokens / 1_000_000) * output
  )
}
