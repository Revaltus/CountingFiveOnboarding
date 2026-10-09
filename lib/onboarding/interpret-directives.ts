import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { OperatorDirective, SessionSchema } from '@/types/session-schema'
import type { TokenContext } from '@/lib/content/token-pricing'
import { generateMbpJson } from '@/lib/mbp/generate-json'
import { FAST_MODEL, FAST_PROVIDER_OPTIONS, OUTLINE_PROVIDER_OPTIONS, PUBLISHED_CONTENT_MODEL } from '@/lib/content/generation-tuning'
import {
  MAX_DIRECTIVES,
  coerceDirective,
  crawledPages,
  hasCrawledPage,
  needsSnapshot,
  isVerbatimSubstring,
  notesWithoutDirectives,
  resolveDirectiveStatus,
  type CrawledPageRef,
} from './directives'
import { captureSnapshot } from './page-snapshot'

export interface InterpretResult {
  directives: OperatorDirective[]
  remainderNotes: string
}

type RawDirective = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

function validateRaw(parsed: unknown): RawDirective[] | null {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { directives?: unknown }).directives)
      ? (parsed as { directives: unknown[] }).directives
      : null
  if (!list) return null
  return list.filter((d): d is RawDirective => !!d && typeof d === 'object').slice(0, MAX_DIRECTIVES)
}

function buildPrompt(notes: string, pages: CrawledPageRef[], schema: SessionSchema): string {
  const team = (schema.team ?? []).filter((m) => m?.name).map((m) => m.name)
  const services = (schema.services ?? []).filter((s) => s?.name).map((s) => s.name)
  const niches = (schema.niches ?? []).filter((n) => n?.name).map((n) => n.name)
  return `An account rep is onboarding a CPA firm's website rebuild. Their notes mix FACTS about the firm with INSTRUCTIONS about what the new site must do. Extract ONLY the instructions as typed directives.

Kinds:
- "bring_page": keep an existing page on the new site. "verbatim": true when they want its wording kept as-is (word-for-word, exactly, don't change); "keepLinks": true when they say to keep/include its links, documents or forms.
- "verbatim_content": a specific passage (usually a team member's bio) reproduced word-for-word. Set "teamMember" when it's a person's bio, and "sourceUrl" to the crawled page most likely to hold that text (their bio page, else the team/about page).
- "add_offering": a NEW service or industry to add. "offering": { "type": "service"|"niche", "name": string, "treatment": "page"|"block" } — "page" unless they say it's a section of another page.
- "merge_page": fold one existing page's content into another. "sourceUrl" = the page being folded in, "targetUrl" = the destination.
- "drop_page": leave an existing page off the new site.
- "other": any other instruction about the new site's content or structure.

Rules:
- "sourceText" MUST be copied character-for-character from the notes: the shortest complete sentence(s) carrying the instruction.
- "sourceUrl"/"targetUrl" MUST be a url from CRAWLED PAGES exactly as listed. Match by title or meaning ("Forms, Documents & Links" → the page with that title). If nothing plausibly matches, omit the field — never invent a url.
- "teamMember" MUST be a name from TEAM exactly as listed, when the person is on it; otherwise use the name as written in the notes.
- Facts (history, differentiators, tone, ideal clients) are NOT directives — skip them.
- Return {"directives": []} when there are no instructions.

CRAWLED PAGES (url — title):
${pages.map((p) => `${p.url} — ${p.title}`).join('\n') || '(none)'}

TEAM: ${team.join('; ') || '(none)'}
EXISTING SERVICES: ${services.join('; ') || '(none)'}
EXISTING INDUSTRIES: ${niches.join('; ') || '(none)'}

Return JSON: {"directives": [{"kind": string, "sourceText": string, "sourceUrl"?: string, "targetUrl"?: string, "verbatim"?: boolean, "keepLinks"?: boolean, "teamMember"?: string, "offering"?: {"type": string, "name": string, "treatment": string}}]}

NOTES:
${notes}`
}

function validatePassage(parsed: unknown): { passage: string } | null {
  if (!parsed || typeof parsed !== 'object') return null
  const passage = str((parsed as { passage?: unknown }).passage)
  return { passage }
}

// Locates the exact passage (e.g. one person's bio on a shared team page) in the
// captured markdown. The caller rejects anything that isn't a verbatim substring,
// so a paraphrasing model yields an unresolved card, never altered client text.
async function locatePassage(
  markdown: string,
  d: OperatorDirective,
  ctx: TokenContext,
): Promise<string | null> {
  const what = d.teamMember
    ? `the full biography of ${d.teamMember} (all of their bio paragraphs; not other people's)`
    : `the passage this instruction refers to: "${d.sourceText}"`
  const res = await generateMbpJson<{ passage: string }>(
    `Copy ${what} from the PAGE below EXACTLY as written — same words, punctuation and markdown, no edits, no summary. If it isn't on the page, return {"passage": ""}.

Return JSON: {"passage": string}

PAGE:
${markdown.slice(0, 60_000)}`,
    validatePassage,
    4000,
    ctx,
    { model: FAST_MODEL, providerOptions: FAST_PROVIDER_OPTIONS },
  )
  const passage = res?.passage ?? ''
  return passage && isVerbatimSubstring(passage, markdown) ? passage : null
}

const absoluteUrl = (websiteUrl: string, path: string): string =>
  `${websiteUrl.replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'https://')}${path}`

// Turns the rep's free-text notes into confirmable directive cards. One parse
// call, then deterministic resolution against the session's real crawled pages
// and team, plus a live snapshot of every page/passage that must be kept
// verbatim. Persists nothing to schema_data — the cards are confirmed in the UI
// and saved with the Audit Review submit.
export async function interpretDirectives(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  websiteUrl: string,
  schema: SessionSchema,
  notes: string,
  ctx: TokenContext,
): Promise<InterpretResult | null> {
  const pages = crawledPages(schema)
  const raw = await generateMbpJson<RawDirective[]>(
    buildPrompt(notes, pages, schema),
    validateRaw,
    4000,
    ctx,
    { model: PUBLISHED_CONTENT_MODEL, providerOptions: OUTLINE_PROVIDER_OPTIONS },
  )
  if (!raw) return null

  const now = new Date().toISOString()
  const directives = raw
    .map((r) => coerceDirective({ ...r, id: crypto.randomUUID(), createdAt: now, snapshot: undefined, verbatimText: undefined }, sessionId))
    .filter((d): d is OperatorDirective => !!d)

  const captured = await Promise.all(
    directives.map((d) => captureForDirective(supabase, sessionId, websiteUrl, schema, d, ctx)),
  )
  return { directives: captured, remainderNotes: notesWithoutDirectives(notes, captured) }
}

// (Re)captures the live snapshot a verbatim card depends on and re-resolves its
// status. Used per card at interpret time and when the rep re-points a card at a
// different page or person. Clears any stale snapshot/passage first, so a card
// can never carry text captured from a page it no longer points at.
export async function captureForDirective(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  websiteUrl: string,
  schema: SessionSchema,
  directive: OperatorDirective,
  ctx: TokenContext,
): Promise<OperatorDirective> {
  const pages = crawledPages(schema)
  const teamNames = (schema.team ?? []).filter((m) => m?.name).map((m) => m.name)
  const d: OperatorDirective = { ...directive }
  delete d.snapshot
  delete d.verbatimText

  if (needsSnapshot(d) && d.sourceUrl && hasCrawledPage(pages, d.sourceUrl)) {
    const snap = await captureSnapshot(supabase, sessionId, absoluteUrl(websiteUrl, d.sourceUrl))
    if (snap) {
      const { markdown, ...meta } = snap
      d.snapshot = meta
      if (d.kind === 'verbatim_content') {
        const passage = await locatePassage(markdown, d, ctx)
        if (passage) d.verbatimText = passage
      }
    }
  }
  d.status = resolveDirectiveStatus(d, pages, teamNames)
  return d
}
