import type { SessionSchema } from '@/types/session-schema'
import type { PageIntentType } from './page-intent'
import { activeTeam } from './active-team'
import { objArr } from './schema-coerce'
import { FAQ_ANSWER_WORDS } from './page-structure'

type Niche = NonNullable<SessionSchema['niches']>[number]
type Service = NonNullable<SessionSchema['services']>[number]

// Deterministic post-generation checks for page metadata. These catch the small,
// mechanical defects a human would otherwise fix by hand — an over-long hero
// subhead, a bloated FAQ answer, a link-stuffed page, an invalid schema.org type,
// a fabricated-looking credential. Two kinds of output:
//  - "writing" checks (subhead/FAQ length) return flag strings that feed the
//    EXISTING anti-slop flagged→retry path (one combined retry, no new loop).
//  - "coercion" checks (links, schema type, eeat) return a corrected value applied
//    deterministically — no model round-trip needed.
// All pure + side-effect free so they unit-test in isolation.

// Count words in a plain string (visible prose only — callers pass metadata, not markdown).
function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

// Hero subhead should be a punchy 12-18 words. Only checks when a subhead is
// present (page-header pages have none). Returns a flag string for the retry note,
// or null when it's in range / absent.
export function validateHeroSubhead(subhead: string | null | undefined): string | null {
  const text = subhead?.trim()
  if (!text) return null
  const n = wordCount(text)
  if (n < 12) return `Hero subhead is too short (${n} words) — expand to 12-18 words that speak to the reader's outcome: "${text}"`
  if (n > 18) return `Hero subhead is too long (${n} words) — tighten to 12-18 words: "${text}"`
  return null
}

// Each FAQ answer should be a substantive FAQ_ANSWER_WORDS long — the FAQ carries
// the page's depth now (page-structure.ts) but each answer must stay scannable.
// Returns one flag per out-of-range answer.
export function validateFaqAnswers(
  faq: Array<{ question: string; answer: string }> | null | undefined,
): string[] {
  if (!Array.isArray(faq)) return []
  const flags: string[] = []
  for (const item of faq) {
    const answer = item?.answer?.trim()
    if (!answer) continue
    const n = wordCount(answer)
    const q = (item.question ?? '').slice(0, 60)
    const { min, max } = FAQ_ANSWER_WORDS
    if (n < min) flags.push(`FAQ answer too short (${n} words) for "${q}" — expand to ${min}-${max} words with a concrete specific.`)
    else if (n > max) flags.push(`FAQ answer too long (${n} words) for "${q}" — tighten to ${min}-${max} words.`)
  }
  return flags
}

// Cap internal links to at most `max`, preserving order (earlier links in the body
// are generally the more relevant ones the model chose first). The link-stuffing
// failure mode — 12 links in a 1,200-word post — reads as spammy and always got
// hand-trimmed. Returns the kept subset (never mutates input).
export function capInternalLinks<T>(links: T[] | null | undefined, max = 4): T[] {
  if (!Array.isArray(links)) return []
  return links.slice(0, max)
}

// Allowed schema.org @type values for a page. Anything outside this set (the model
// occasionally invents "WebPage2" or picks something nonsensical) is clamped to the
// page-intent default so the JSON-LD the builder emits is always valid.
const ALLOWED_SCHEMA_TYPES = new Set([
  'LocalBusiness',
  'ProfessionalService',
  'Service',
  'Organization',
  'WebPage',
  'AboutPage',
  'ContactPage',
  'FAQPage',
  'Article',
  'BlogPosting',
])

const SCHEMA_DEFAULT_BY_INTENT: Record<PageIntentType, string> = {
  niche: 'Service',
  service: 'Service',
  location: 'LocalBusiness',
  home: 'ProfessionalService',
  about: 'AboutPage',
  contact: 'ContactPage',
  generic: 'WebPage',
}

// Clamp a model-provided schema_markup_type to a known-valid value. Keeps a valid
// choice as-is; replaces an unknown one with the sensible default for this page type.
export function validateSchemaType(type: string | null | undefined, intent: PageIntentType): string {
  const t = type?.trim()
  if (t && ALLOWED_SCHEMA_TYPES.has(t)) return t
  return SCHEMA_DEFAULT_BY_INTENT[intent] ?? 'WebPage'
}

// A lowercased bag of the firm's real, verifiable facts — credentials, affiliations,
// founding year, team certs, niche/service names — used to sanity-check specific
// EEAT claims against something the firm actually stated.
function buildFirmFactCorpus(schema: SessionSchema): string {
  const parts: string[] = []
  const b = schema.business
  if (b) {
    if (typeof b.foundingYear === 'string') parts.push(b.foundingYear)
    if (typeof b.differentiators === 'string') parts.push(b.differentiators)
    if (Array.isArray(b.affiliations)) parts.push(...b.affiliations)
    if (Array.isArray(b.clientSuccessStories)) parts.push(...b.clientSuccessStories)
  }
  for (const m of activeTeam(schema)) {
    if (Array.isArray(m.certifications)) parts.push(...m.certifications)
    if (Array.isArray(m.specializations)) parts.push(...m.specializations)
    if (typeof m.bio === 'string') parts.push(m.bio)
  }
  for (const n of objArr<Niche>(schema.niches)) if (typeof n.name === 'string') parts.push(n.name)
  for (const sv of objArr<Service>(schema.services)) if (typeof sv.name === 'string') parts.push(sv.name)
  return parts.join(' | ').toLowerCase()
}

// A specific-claim trigger: a year, a count of years/clients, a percentage, or an
// award word. Only claims like these are risky to fabricate; a generic signal
// ("CPA firm", "personal service") is fine and is never dropped.
const SPECIFIC_CLAIM_RE = /\b(19|20)\d{2}\b|\b\d+\+?\s*(years?|clients?|businesses?|%|percent)\b|\b(award|awarded|ranked|#1|number one|best of)\b/i

// Drop EEAT signals that make a SPECIFIC quantified/award claim not backed anywhere
// in the firm's stated facts — these read as fabricated and get hand-removed. A
// generic signal, or a specific one whose key number/word appears in the corpus, is
// kept. Deliberately narrow (only specific claims are ever dropped) to avoid
// stripping legitimate experiential signals.
export function groundEeatSignals(
  signals: string[] | null | undefined,
  schema: SessionSchema,
): string[] {
  if (!Array.isArray(signals)) return []
  const corpus = buildFirmFactCorpus(schema)
  return signals.filter((sig) => {
    if (typeof sig !== 'string' || !sig.trim()) return false
    const m = sig.match(SPECIFIC_CLAIM_RE)
    if (!m) return true // no specific claim → keep
    // A specific claim survives only if its salient token is somewhere in the firm's facts.
    return corpus.includes(m[0].toLowerCase())
  })
}
