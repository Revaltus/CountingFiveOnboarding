import type { AnthropicProviderOptions } from '@ai-sdk/anthropic'
import { AUTO_CACHE_OPTIONS } from './cache-control'

// Model + sampling tuning shared by the async (non-interactive) generation
// pipeline. Kept here so the published-content model and the thinking/effort
// settings live in one place rather than drifting across generator modules.

// Sonnet 5.5 is the writing tier for client-facing published deliverables (page
// bodies and the audit→session draft). It replaced Sonnet 5 on 2026-09-30 after
// scripts/compare-content-models.ts: critic mean 7.64 vs 7.36, unsupported claims
// per page 3.0 vs 6.5, 97s vs 184s per page, $0.16 vs $0.22 per page (same list
// price). It supports adaptive thinking + effort, so GENERATION_PROVIDER_OPTIONS
// applies. It rejects forced tool use — structured output goes through native
// structured outputs (SDK ≥ 3.0.125 handles generateObject).
export const PUBLISHED_CONTENT_MODEL = 'claude-sonnet-5-5'

// The draft critic grades pages the Sonnet 5 writer produced. A different,
// stronger tier avoids self-grading bias, and its verdict gates the one
// auto-regeneration and the unsupported-claims (hallucination) flags. Input is
// capped (~6k-token page) and output is small JSON, so the premium is cents/page.
export const CRITIC_MODEL = 'claude-opus-5-5'

// QA Desk specialists (Accuracy / Copy Editor / SEO-GEO / Structure). Same tier
// as the writer; the judge stays CRITIC_MODEL so nothing grades its own tier.
export const QA_SPECIALIST_MODEL = PUBLISHED_CONTENT_MODEL

// Design Studio concept generation + revision (admin-only, a few runs per
// client). Sonnet 5.5 replaced Opus 5.5 on 2026-09-30 after
// scripts/compare-design-models.ts (bblcpa, 3 concepts each, Sonnet 5 judge):
// critic mean 3.89 vs 3.94, 3/3 pass for both, 50s vs 127s per concept,
// generation $0.34 vs $1.17. Like Opus 5.5 it rejects forced toolChoice — use
// generateText → extractJson → zod (see draft-critic.ts).
export const DESIGN_MODEL = 'claude-sonnet-5-5'

// Design Studio's vision critique, which gates keep/revise, is a separate, stronger
// tier than DESIGN_MODEL so the generator never grades its own concepts (same
// reason CRITIC_MODEL differs from the page writer). Critique calls are a small
// share of Studio spend.
export const DESIGN_CRITIC_MODEL = 'claude-opus-5-5'

// Only for scripts/compare-design-models.ts (A/B vs DESIGN_MODEL). Not used by
// any route — the tier map keeps Fable out of production paths until the A/B
// says otherwise.
// A/B 2026-09-26 (bblcpa): Opus 5.5 kept as DESIGN_MODEL — Fable 5.1 scored +0.09 mean at 2.3× the cost and 24% slower.
// (DESIGN_MODEL has since moved to Sonnet 5.5 — see above.)
export const DESIGN_AB_CHALLENGER_MODEL = 'claude-fable-5-1'

// Sonnet 5.5 (released 2026-09-28) is the challenger in the compare-*-models.ts
// A/B scripts. No route uses it until those runs justify a tier change.
export const SONNET_5_5_CHALLENGER = 'claude-sonnet-5-5'

// The previous fast tier — kept as the legacy baseline in
// scripts/compare-fast-models.ts until Anthropic retires it.
export const HAIKU_4_5_LEGACY = 'claude-haiku-4-5-20251001'

// Interactive (streaming, operator-facing) chats. Sonnet 5.5 (replaced Sonnet 5 on
// 2026-09-30) defaults to effort 'high', which is too slow for chat — every chat
// route must pass chatProviderOptions() to pick its effort explicitly.
export const INTERACTIVE_CHAT_MODEL = 'claude-sonnet-5-5'

// Fast/cheap tier for classification helpers and the lightweight intake phases.
// Haiku 5.5 replaced Haiku 4.5 on 2026-10-09 (scripts/compare-fast-models.ts,
// brand-fit over 5 clients × 8 directions, thinking disabled): 39/40 agreement,
// 0 failures, 1.9s vs 2.6s per call, ~$0.0002 vs $0.0018. Adaptive thinking at
// effort low had 3 failures and was slower. Every call MUST pass
// FAST_PROVIDER_OPTIONS (or FAST_CHAT_PROVIDER_OPTIONS): Haiku 5.5 thinks
// adaptively by default, which adds latency and eats small maxOutputTokens caps.
export const FAST_MODEL = 'claude-haiku-5-5'

// Thinking off — the fast tier's calls are short classification/extraction jobs
// (Haiku 4.5 ran them without thinking). fast-model-options.test.ts enforces it.
export const FAST_PROVIDER_OPTIONS = {
  anthropic: { thinking: { type: 'disabled' } } satisfies AnthropicProviderOptions,
}

// Every chat also turns on automatic prompt caching (AUTO_CACHE_OPTIONS): tool
// loops resend tools + system + history on each step, which is most of chat spend.
// `display: 'summarized'`: Sonnet 5.5 returns its notes between tool calls as
// thinking blocks, so with 'omitted' a multi-step edit streamed nothing until the
// final answer. The UI shows the latest note (lib/ai/progress-note.ts), and
// trimMessages() strips reasoning before it is replayed.
export function chatProviderOptions(effort: 'low' | 'medium') {
  return {
    anthropic: {
      thinking: { type: 'adaptive', display: 'summarized' },
      effort,
      ...AUTO_CACHE_OPTIONS,
    } satisfies AnthropicProviderOptions,
  }
}

// Haiku chat branch: caching + thinking off (see FAST_PROVIDER_OPTIONS).
export const FAST_CHAT_PROVIDER_OPTIONS = {
  anthropic: { thinking: { type: 'disabled' }, ...AUTO_CACHE_OPTIONS } satisfies AnthropicProviderOptions,
}

// Adaptive thinking + high effort raises quality on reasoning-heavy generation.
// `display: 'omitted'` keeps the reasoning out of the response (these callers
// only parse the final JSON/text). Never apply this to a fast-tier call (use
// FAST_PROVIDER_OPTIONS) or to latency-sensitive interactive chat.
export const GENERATION_PROVIDER_OPTIONS = {
  anthropic: {
    thinking: { type: 'adaptive', display: 'omitted' },
    effort: 'high',
  } satisfies AnthropicProviderOptions,
}

// Page-body generation: a large markdown+metadata JSON answer. High effort for
// best writing quality on the published deliverable. The earlier truncation
// (effort:'high' starving an 8000-token budget) is solved by the generous
// maxOutputTokens at the call site (24000) plus a low-effort retry safety net,
// NOT by lowering effort. Identical to GENERATION_PROVIDER_OPTIONS — aliased
// rather than duplicated so the two can't silently drift apart.
export const CONTENT_PROVIDER_OPTIONS = GENERATION_PROVIDER_OPTIONS

// Outline generation is the structural GATE for every downstream page body — a
// weak or placeholder outline cascades into weak copy. The outline model runs
// high effort (like the body generator) so its section plan is genuinely
// reasoned. The earlier truncation (high effort starving a tight budget →
// single-section fallback) is solved the same way the body generator solved it:
// a generous maxOutputTokens at the call site (12000) plus a low-effort retry
// safety net, NOT by lowering effort on the primary attempt.
export const OUTLINE_PRIMARY_PROVIDER_OPTIONS = {
  anthropic: {
    thinking: { type: 'adaptive', display: 'omitted' },
    effort: 'high',
  } satisfies AnthropicProviderOptions,
}

// Low-effort fallback for the outline retry: if the high-effort primary attempt
// still truncates the JSON, less thinking leaves more of the budget for the
// answer. Also reused by the page-body generator's own truncation retry.
export const OUTLINE_PROVIDER_OPTIONS = {
  anthropic: {
    thinking: { type: 'adaptive', display: 'omitted' },
    effort: 'low',
  } satisfies AnthropicProviderOptions,
}

// Medium-effort background option for generateMbpJson callers whose output
// meaningfully affects audit scoring/narrative quality but isn't the
// published-content writer (which stays at GENERATION_PROVIDER_OPTIONS/high).
// Sits between OUTLINE_PROVIDER_OPTIONS (low, cheap classification/extraction)
// and the high-effort writer tiers — used by audit-intelligence passes whose
// judgment feeds a client-facing score or the final narrative.
export const BACKGROUND_MEDIUM_PROVIDER_OPTIONS = {
  anthropic: {
    thinking: { type: 'adaptive', display: 'omitted' },
    effort: 'medium',
  } satisfies AnthropicProviderOptions,
}

// Effort ladder for RETRIES. A first attempt keeps today's quality exactly —
// high effort, unchanged. What changes is what a *failed* page gets next.
//
// Previously every retry repeated the identical expensive high-effort call, so a
// page that timed out at high effort timed out again the same way. Production
// bears this out: one page finally succeeded only when it fell through to the
// low-effort path (2,971 output tokens in ~34s, against 12–17k tokens and 80–190s
// for the high-effort attempts that had been failing). Stepping effort DOWN per
// attempt makes each retry both faster and likelier to land, which is the most
// direct lever on the measured 16.7% multi-attempt rate — a finished good page
// beats a missing perfect one.
const EFFORT_LADDER = ['high', 'medium', 'low'] as const

export function providerOptionsForAttempt(attempt: number): typeof GENERATION_PROVIDER_OPTIONS {
  // attempt is 1-based; anything past the ladder stays at its cheapest rung.
  const idx = Math.min(Math.max(1, attempt), EFFORT_LADDER.length) - 1
  return {
    anthropic: {
      thinking: { type: 'adaptive', display: 'omitted' },
      effort: EFFORT_LADDER[idx],
    },
  } as typeof GENERATION_PROVIDER_OPTIONS
}
