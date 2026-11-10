import { AUDIENCE_KEYS } from './audiences'
import type { AudienceKey, CheckResult, VisibilityNarrative, VisibilityNarrativeSection } from './types'

export const NARRATIVE_LIMITS = { overview: 2000, item: 400, wins: 4, opportunities: 3 } as const

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])

// Lenient: for model output. Trims, drops blanks, clamps lengths and counts.
// null when there is no usable overview.
export function coerceNarrative(raw: unknown): VisibilityNarrative | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const overview = str(obj.overview).slice(0, NARRATIVE_LIMITS.overview)
  if (!overview) return null
  const src = (obj.audiences && typeof obj.audiences === 'object' ? obj.audiences : {}) as Record<string, unknown>
  const clip = (s: string) => s.slice(0, NARRATIVE_LIMITS.item)
  const audiences = Object.fromEntries(
    AUDIENCE_KEYS.map((k) => {
      const sec = (src[k] && typeof src[k] === 'object' ? src[k] : {}) as Record<string, unknown>
      return [k, {
        wins: strList(sec.wins).slice(0, NARRATIVE_LIMITS.wins).map(clip),
        opportunities: strList(sec.opportunities).slice(0, NARRATIVE_LIMITS.opportunities).map(clip),
      }]
    }),
  ) as Record<AudienceKey, VisibilityNarrativeSection>
  return { overview, audiences }
}

// Strict: for operator edits (PATCH). Rejects instead of clamping, so nothing
// the operator typed is silently cut.
export function validateNarrativeInput(raw: unknown): { ok: true; value: VisibilityNarrative } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'narrative must be an object' }
  const obj = raw as Record<string, unknown>
  if (typeof obj.overview !== 'string' || !obj.overview.trim()) return { ok: false, error: 'overview is required' }
  if (obj.overview.length > NARRATIVE_LIMITS.overview) return { ok: false, error: `overview exceeds ${NARRATIVE_LIMITS.overview} characters` }
  if (!obj.audiences || typeof obj.audiences !== 'object') return { ok: false, error: 'audiences is required' }
  const src = obj.audiences as Record<string, unknown>
  const audiences = {} as Record<AudienceKey, VisibilityNarrativeSection>
  for (const k of AUDIENCE_KEYS) {
    const sec = src[k] as Record<string, unknown> | undefined
    if (!sec || typeof sec !== 'object') return { ok: false, error: `audiences.${k} is required` }
    const lists: Array<['wins' | 'opportunities', number]> = [['wins', NARRATIVE_LIMITS.wins], ['opportunities', NARRATIVE_LIMITS.opportunities]]
    const out = { wins: [] as string[], opportunities: [] as string[] }
    for (const [field, max] of lists) {
      const v = sec[field]
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return { ok: false, error: `audiences.${k}.${field} must be a list of text` }
      const items = (v as string[]).map((s) => s.trim()).filter(Boolean)
      if (items.length > max) return { ok: false, error: `audiences.${k}.${field} allows at most ${max} items` }
      if (items.some((s) => s.length > NARRATIVE_LIMITS.item)) return { ok: false, error: `audiences.${k}.${field} items are limited to ${NARRATIVE_LIMITS.item} characters` }
      out[field] = items
    }
    audiences[k] = out
  }
  return { ok: true, value: { overview: obj.overview.trim(), audiences } }
}

// Used when the AI review is unavailable: wins/opportunities straight from the
// check results so the operator has a starting draft.
export function fallbackNarrative(checks: CheckResult[]): VisibilityNarrative {
  const audiences = Object.fromEntries(
    AUDIENCE_KEYS.map((k) => {
      const mine = checks.filter((c) => c.audience === k)
      return [k, {
        wins: mine.filter((c) => c.status === 'pass').slice(0, 3).map((c) => `${c.label}: ${c.detail}`),
        opportunities: mine.filter((c) => c.status === 'fail').slice(0, 3).map((c) => `${c.label}: ${c.detail}`),
      }]
    }),
  ) as Record<AudienceKey, VisibilityNarrativeSection>
  return { overview: 'This report was generated without AI commentary. Edit this overview before publishing.', audiences }
}
