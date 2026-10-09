import type { SessionSchema } from '@/types/session-schema'
import { arr, str } from './schema-coerce'

// Words that describe a page rather than a topic ("Audit Protection service page").
const FILLER = new Set(['page', 'pages', 'service', 'services', 'the', 'a', 'an', 'our', 'section', 'content'])

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)

// The topic phrase of an exclusion, minus page/service filler.
export function exclusionCore(exclusion: string): string {
  return words(exclusion).filter(w => !FILLER.has(w)).join(' ')
}

// Exclusions the operator or client typed. Review drops are mirrored into
// contentExclusions too (tracked in _meta.review_exclusions); those name a
// dropped duplicate or sibling and must not ban the kept item they overlap.
export function operatorExclusions(schema: SessionSchema): string[] {
  const tracked = new Set(
    arr((schema._meta as { review_exclusions?: unknown } | undefined)?.review_exclusions as unknown[] | undefined)
      .map(x => str(x).trim().toLowerCase()),
  )
  return arr(schema.business?.contentExclusions)
    .map(x => str(x).trim())
    .filter(x => x && !tracked.has(x.toLowerCase()))
}

// The exclusion `text` falls under, if any: its core phrase (2+ words, so a
// lone word like "tax" never matches everything) appears in the text as whole words.
export function matchingExclusion(text: string, exclusions: string[]): string | null {
  const hay = ` ${words(text).join(' ')} `
  for (const ex of exclusions) {
    const core = exclusionCore(ex)
    if (core.split(' ').length < 2) continue
    if (hay.includes(` ${core} `)) return ex
  }
  return null
}

// Whether a kept item shares a topic word with any exclusion — the items a model
// might wrongly read as excluded, and so the only ones worth naming as in scope.
export function overlapsAnyExclusion(name: string, exclusions: string[]): boolean {
  const mine = new Set(words(name).filter(w => w.length >= 4 && !FILLER.has(w)))
  return exclusions.some(ex => words(ex).some(w => mine.has(w)))
}
