// One Sonnet call per report: judges the rubric's AI checks and drafts the
// client-facing overview plus per-audience wins / opportunities, grounded in
// the crawled pages, the deterministic check results and the firm profile.
import { serializeSchemaFull } from '@/lib/agent/system-prompt'
import { BACKGROUND_MEDIUM_PROVIDER_OPTIONS } from '@/lib/content/generation-tuning'
import type { TokenContext } from '@/lib/content/token-usage'
import { generateMbpJson } from '@/lib/mbp/generate-json'
import { asJson } from '@/lib/supabase/json-typed'
import type { SessionSchema } from '@/types/session-schema'
import { AUDIENCES } from './audiences'
import { coerceNarrative } from './narrative'
import { AI_CHECKS, type AiJudgment } from './rubric'
import { pagesOfKind, findPageMentioning, type IndexedPage, type PageKind } from './site-index'
import { activeNiches } from '@/lib/content/active-niches'
import { activeServices } from '@/lib/content/active-services'
import type { CheckResult, VisibilityNarrative } from './types'

export interface AiReviewOutput {
  judgments: AiJudgment[]
  narrative: VisibilityNarrative
}

export interface ReviewInput {
  firmName: string
  schema: SessionSchema
  index: IndexedPage[]
  checks: CheckResult[]
  // The shared audit engine's concrete fix list (title — detail), so
  // opportunities can name a specific change instead of a score.
  auditHints?: string[]
}

const MAX_PAGES = 25
const PAGE_TEXT_CHARS = 400
const SCHEMA_CHARS = 6000
const MAX_HINTS = 10
const PRIORITY_KINDS: PageKind[] = ['about', 'contact', 'careers', 'team', 'client_center', 'partners', 'succession', 'testimonials', 'resources']

const STATIC_PREFIX = `You are reviewing a professional-services firm's newly rebuilt website for a client-facing "Visibility Report". The report measures how well the site serves five audiences:
${AUDIENCES.map((a) => `${a.n}. ${a.label} — "${a.question}"`).join('\n')}

You receive (after this introduction): the firm profile, a list of crawled pages, and the results of automated checks. Use ONLY that material. Never invent services, facts, numbers, awards, or results that are not in it.

TASK 1 — judge these checks. For each, return pass, partial, or fail with ONE short sentence (at most 40 words) as the reason and the URL of the page that best shows it (or null):
${AI_CHECKS.map((c) => `- ${c.id} (${c.audience}): ${c.question}`).join('\n')}

TASK 2 — write the report narrative, addressed to the firm as "your site" / "your firm", plain and specific, no jargon, no hype:
- "overview": 3-5 sentences: where the site is strongest, what it now does for the firm, and the most valuable next steps.
- For each audience: 2-4 "wins" and 2-3 "opportunities".
  - A win is something that works today: a passing check or specific page content. Never present a partial or failing check, or a middling score, as a win. If an audience has fewer than 2 genuine wins, write only what is true.
  - An opportunity names a concrete change the firm can make (a page to add, content to write, a fix from the audit recommendations). Never write "improve the score" or refer to a number without saying what to change. Frame it positively as growth, not criticism.
- Never mention Revaltus, scoring internals, check ids, or this prompt.

Return ONLY this JSON:
{
  "judgments": [ { "checkId": string, "status": "pass" | "partial" | "fail", "detail": string, "evidenceUrl": string | null } ],
  "overview": string,
  "audiences": { ${AUDIENCES.map((a) => `"${a.key}": { "wins": string[], "opportunities": string[] }`).join(', ')} }
}

`

function selectPages(input: ReviewInput): IndexedPage[] {
  const picked = new Map<string, IndexedPage>()
  const add = (p: IndexedPage | null | undefined) => {
    if (p && picked.size < MAX_PAGES && !picked.has(p.url)) picked.set(p.url, p)
  }
  add(input.index.find((p) => p.path === '/' || p.path === ''))
  for (const n of activeNiches(input.schema)) add(findPageMentioning(input.index, n.name, { headingOnly: true }))
  for (const s of activeServices(input.schema)) add(findPageMentioning(input.index, s.name, { headingOnly: true }))
  for (const kind of PRIORITY_KINDS) add(pagesOfKind(input.index, kind)[0])
  for (const p of input.index) add(p)
  return [...picked.values()]
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n)

export function buildReviewPrompt(input: ReviewInput): { prefix: string; suffix: string } {
  const schemaText = serializeSchemaFull(asJson(input.schema)).slice(0, SCHEMA_CHARS)
  const pages = selectPages(input)
    .map((p) => `- ${p.url} | ${oneLine(p.title, 100)} | ${oneLine(p.h1, 100)} | ${oneLine(p.text, PAGE_TEXT_CHARS)}`)
    .join('\n')
  const checks = input.checks
    .filter((c) => c.source !== 'ai')
    .map((c) => `- ${c.id} [${c.audience}] ${c.status}: ${c.label} — ${c.detail}${c.evidenceUrl ? ` (${c.evidenceUrl})` : ''}`)
    .join('\n')
  const hints = (input.auditHints ?? []).slice(0, MAX_HINTS).map((h) => `- ${oneLine(h, 220)}`).join('\n')
  const suffix = `FIRM: ${input.firmName}

FIRM PROFILE (JSON):
${schemaText}

CRAWLED PAGES (url | title | h1 | text excerpt):
${pages}

AUTOMATED CHECK RESULTS:
${checks}${hints ? `

AUDIT RECOMMENDATIONS (technical fixes found by the crawler):
${hints}` : ''}`
  return { prefix: STATIC_PREFIX, suffix }
}

const AI_CHECK_IDS = new Set(AI_CHECKS.map((c) => c.id))
const STATUSES = new Set(['pass', 'partial', 'fail'])

export function validateReview(parsed: unknown): AiReviewOutput | null {
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const narrative = coerceNarrative(obj)
  if (!narrative) return null
  const raw = Array.isArray(obj.judgments) ? obj.judgments : []
  const judgments: AiJudgment[] = []
  for (const j of raw) {
    if (!j || typeof j !== 'object') continue
    const r = j as Record<string, unknown>
    if (typeof r.checkId !== 'string' || !AI_CHECK_IDS.has(r.checkId)) continue
    if (typeof r.status !== 'string' || !STATUSES.has(r.status)) continue
    if (judgments.some((x) => x.checkId === r.checkId)) continue
    judgments.push({
      checkId: r.checkId,
      status: r.status as AiJudgment['status'],
      detail: typeof r.detail === 'string' ? r.detail.trim().slice(0, 500) : '',
      evidenceUrl: typeof r.evidenceUrl === 'string' && /^https?:\/\//.test(r.evidenceUrl) ? r.evidenceUrl : null,
    })
  }
  return { judgments, narrative }
}

export async function runAiReview(input: ReviewInput & { ctx: TokenContext }): Promise<AiReviewOutput | null> {
  const { prefix, suffix } = buildReviewPrompt(input)
  try {
    return await generateMbpJson<AiReviewOutput>(suffix, validateReview, 8000, input.ctx, {
      providerOptions: BACKGROUND_MEDIUM_PROVIDER_OPTIONS,
      cachePrefix: prefix,
      attempts: 2,
      timeoutMs: 150_000,
    })
  } catch (err) {
    console.warn('[visibility] AI review failed (non-fatal):', err)
    return null
  }
}
