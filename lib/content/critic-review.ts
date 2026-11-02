// Pure types + parsing/summarizing for the advisory draft-gate critic. NO
// server-only imports here so this module is safe to pull into client bundles
// (the preview modal renders a CriticReview; the status route summarizes one).
// The server-side generator lives in ./draft-critic (createServerClient + AI).

// The advisory quality score stored on generated_pages.critic_review. Written in
// the background after a page completes; never gates approval or publishing.
export type CriticReview = {
  evidence_specificity: number // 0-10 — concrete facts/numbers vs vague filler
  information_gain: number // 0-10 — unique value vs the competitor reference
  brand_fidelity: number // 0-10 — matches the firm's voice + positioning
  promise_fulfillment: number // 0-10 — delivers what the approved outline promised
  // Extended positive-verification dimensions (added later; OPTIONAL so older
  // stored rows written before them still parse and display). Fresh reviews always
  // set all three.
  outline_coverage?: number // 0-10 — every approved outline section addressed at depth
  input_utilization?: number // 0-10 — used the firm's SPECIFIC niche/proof/differentiators available
  differentiation?: number // 0-10 — reads as THIS firm vs. generic-CPA boilerplate
  unsupported_claims: string[] // verbatim specifics not grounded in the firm profile
  missing_sections?: string[] // approved outline sections the draft skipped/under-developed
  notes: string // 1-3 sentence admin-readable summary
  critic_model: string
  scored_at: string // ISO
  // Auto-remediation bookkeeping (stored in the same JSON — no extra column).
  // The critic auto-regenerates a weak page once, then flags whatever remains for
  // a human. Older rows omit these; treat absent as false/0.
  needs_human_review?: boolean // still weak after the auto-regen budget was spent
  regenerated?: boolean // the critic triggered a targeted regeneration of this page
  critic_regen_attempts?: number // how many critic-driven regenerations have run (cap 1)
}

// The model-provided portion (critic_model + scored_at are stamped server-side).
export type ParsedCritic = Omit<CriticReview, 'critic_model' | 'scored_at'>

// The four original dimensions are REQUIRED: their presence is the null-guard in
// parseCritic, so a garbled answer records nothing. Kept as the required set for
// backward compatibility with rows stored before the extended dimensions existed.
const REQUIRED_SCORE_KEYS = [
  'evidence_specificity',
  'information_gain',
  'brand_fidelity',
  'promise_fulfillment',
] as const
// Extended dimensions — optional (absent on legacy rows), folded into scoring only
// when present so old rows keep their original 4-dimension overall.
const EXTENDED_SCORE_KEYS = ['outline_coverage', 'input_utilization', 'differentiation'] as const
const ALL_SCORE_KEYS = [...REQUIRED_SCORE_KEYS, ...EXTENDED_SCORE_KEYS] as const

// Every scored dimension with a display label, in presentation order. Exported so
// the content-quality dashboard can render per-dimension averages without
// re-declaring the key→label mapping.
export const CRITIC_DIMENSIONS: { key: (typeof ALL_SCORE_KEYS)[number]; label: string }[] = [
  { key: 'evidence_specificity', label: 'Evidence & specificity' },
  { key: 'information_gain', label: 'Information gain' },
  { key: 'brand_fidelity', label: 'Brand fidelity' },
  { key: 'promise_fulfillment', label: 'Promise fulfillment' },
  { key: 'outline_coverage', label: 'Outline coverage' },
  { key: 'input_utilization', label: 'Used firm inputs' },
  { key: 'differentiation', label: 'Differentiation' },
]

// Just the scored dimensions: the four required + any of the optional extended.
// criticOverall needs only these.
type ScoreDims = Pick<CriticReview, (typeof REQUIRED_SCORE_KEYS)[number]> &
  Partial<Pick<CriticReview, (typeof EXTENDED_SCORE_KEYS)[number]>>

// Shape accepted by the threshold helpers: the scored dimensions plus the two flag
// arrays that also drive the "is this weak" decision.
type ScoredCritic = ScoreDims &
  Pick<CriticReview, 'unsupported_claims'> &
  Partial<Pick<CriticReview, 'missing_sections'>>

export function clampScore(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(10, Math.round(n)))
}

// Parse a model answer OR a stored critic_review into ParsedCritic. Returns null
// when the four scores aren't all present as numbers — so a garbled/empty answer
// records nothing rather than a misleading all-zeros review.
// Coerce a JSONB array to a bounded string[] (verbatim snippets/section names).
function toStrArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        .map((c) => c.trim().slice(0, 300))
        .slice(0, 20)
    : []
}

export function parseCritic(parsed: unknown): ParsedCritic | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  // Null-guard on the four required dimensions only, so legacy rows (written
  // before the extended dimensions) still parse and render.
  for (const k of REQUIRED_SCORE_KEYS) {
    if (typeof p[k] !== 'number') return null
  }
  const out: ParsedCritic = {
    evidence_specificity: clampScore(p.evidence_specificity),
    information_gain: clampScore(p.information_gain),
    brand_fidelity: clampScore(p.brand_fidelity),
    promise_fulfillment: clampScore(p.promise_fulfillment),
    unsupported_claims: toStrArray(p.unsupported_claims),
    missing_sections: toStrArray(p.missing_sections),
    notes: typeof p.notes === 'string' ? p.notes.trim().slice(0, 1000) : '',
  }
  // Extended dimensions only when the model actually returned them as numbers.
  for (const k of EXTENDED_SCORE_KEYS) {
    if (typeof p[k] === 'number') out[k] = clampScore(p[k])
  }
  return out
}

// Average across every dimension PRESENT on the review — four for legacy rows,
// seven for fresh ones — so old rows keep a stable overall and new rows fold in
// the extended dimensions.
export function criticOverall(r: ScoreDims): number {
  const vals: number[] = []
  for (const k of ALL_SCORE_KEYS) {
    const v = r[k]
    if (typeof v === 'number') vals.push(v)
  }
  if (!vals.length) return 0
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
}

// A single dimension below this is "weak." One weak dimension alone is NOT enough
// to rewrite (a specific-but-imperfect page is normal); it takes two.
export const CRITIC_MIN_SCORE = 5
// Overall score below this → the whole draft is mediocre, worth one rewrite.
export const CRITIC_MIN_OVERALL = 6
// This many weak dimensions → worth one rewrite even if the average is okay.
export const CRITIC_WEAK_DIMS_FOR_REGEN = 2
// At most one critic-driven regeneration before flagging for a human. Kept here
// (not in the generator) so the pure decision logic is self-contained + testable.
export const MAX_CRITIC_REGEN = 1

// A page trips the auto-remediation threshold when the critic found a likely
// hallucination (any unsupported specific), OR the overall score is mediocre
// (< CRITIC_MIN_OVERALL), OR two-plus dimensions are weak. Deliberately NOT "any
// single dim < 5" — the critic flags specifics aggressively, so one low dimension
// on an otherwise-strong page shouldn't trigger a costly rewrite. Single source of
// truth for "this draft is weak."
export function criticFailsThreshold(r: ScoredCritic): boolean {
  if (r.unsupported_claims.length > 0) return true
  // A skipped/under-developed outline section is a broken promise → rewrite.
  if (r.missing_sections && r.missing_sections.length > 0) return true
  if (criticOverall(r) < CRITIC_MIN_OVERALL) return true
  const weak = ALL_SCORE_KEYS.filter((k) => {
    const v = r[k]
    return typeof v === 'number' && v < CRITIC_MIN_SCORE
  }).length
  return weak >= CRITIC_WEAK_DIMS_FOR_REGEN
}

// Pure decision for the auto-remediation orchestrator: accept a solid page,
// regenerate a weak one that still has budget, or flag a weak one that's out of
// budget. Isolated from the DB/generator so the branching is unit-testable.
export type CriticAction = 'accept' | 'regenerate' | 'flag'
export function decideCriticAction(review: ScoredCritic, priorAttempts: number): CriticAction {
  if (!criticFailsThreshold(review)) return 'accept'
  return priorAttempts >= MAX_CRITIC_REGEN ? 'flag' : 'regenerate'
}

// Turn a critic verdict into explicit "fix these" guidance for the regeneration
// prompt, so the rewrite is informed rather than a blind reroll.
export function buildCriticGuidance(
  r: Pick<CriticReview, 'unsupported_claims' | 'notes'> &
    Partial<Pick<CriticReview, 'missing_sections'>>,
): string {
  const parts: string[] = []
  if (r.unsupported_claims.length) {
    parts.push(
      `Remove or ground these unsupported specifics — they read as fabricated. Keep one ONLY if it is in the firm profile above; otherwise cut it or rephrase it generically without the invented number/claim: ${r.unsupported_claims.join(' | ')}`,
    )
  }
  if (r.missing_sections && r.missing_sections.length) {
    parts.push(
      `Cover these approved outline sections the draft skipped or under-developed. Give each real substance, as a short section, bullets or an FAQ answer, without lengthening the body past its limit: ${r.missing_sections.join(' | ')}`,
    )
  }
  const notes = r.notes.trim()
  if (notes) parts.push(`Editor notes to address in the rewrite: ${notes}`)
  return parts.join('\n')
}

// How many critic-driven regenerations have already run for a stored review.
// Tolerant of legacy/absent/garbled values (→ 0).
export function readCriticRegenAttempts(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0
  const n = (raw as Record<string, unknown>).critic_regen_attempts
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

// Compact per-page summary for the generation-status poll. Coerces a stored
// value defensively (older/partial rows → null). `needsReview` prefers the
// persisted flag (set after the auto-regen budget is spent) and falls back to
// the live threshold for legacy rows written before auto-remediation existed.
export function summarizeCritic(
  raw: unknown,
): { overall: number; hasFlags: boolean; needsReview: boolean; regenerated: boolean } | null {
  const parsed = parseCritic(raw)
  if (!parsed) return null
  const persistedFlag =
    raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>).needs_human_review
      : undefined
  const needsReview =
    typeof persistedFlag === 'boolean' ? persistedFlag : criticFailsThreshold(parsed)
  const regenerated =
    !!(raw && typeof raw === 'object' && (raw as Record<string, unknown>).regenerated)
  return {
    overall: criticOverall(parsed),
    hasFlags: parsed.unsupported_claims.length > 0,
    needsReview,
    regenerated,
  }
}
