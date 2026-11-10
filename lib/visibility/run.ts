// Visibility Report orchestrator. Pure with respect to the DB (mirrors
// lib/audit/index.ts runAudit): the worker owns persistence and progress
// writes. Crawl + scores come from the shared audit engine; everything off-site
// (ranks, Business Profile, AI answers) runs only on the live domain and is
// non-fatal.
import { normalizeDomain, runAudit } from '@/lib/audit/index'
import { lookupPlace } from '@/lib/audit/places-lookup'
import type { TokenContext } from '@/lib/content/token-usage'
import type { AuditStage } from '@/types/audit-result'
import type { SessionSchema } from '@/types/session-schema'
import { runAiProbe } from './ai-probe'
import { runAiReview } from './ai-review'
import { fallbackNarrative } from './narrative'
import { checkRanks, primaryCity } from './ranks'
import { evaluateRubric, RUBRIC_VERSION, type RubricContext } from './rubric'
import { scoreAll } from './score'
import { buildSiteIndex } from './site-index'
import type { GbpEvidence, UnavailablePiece, VisibilityNarrative, VisibilityResult } from './types'

export type VisibilityStage = 'crawling' | 'analyzing' | 'evidence' | 'reviewing' | 'scoring'

const MAX_PAGES = 60
// Time kept back from the crawl for the evidence + AI stages that follow it.
const POST_CRAWL_RESERVE_MS = 270_000

export interface RunVisibilityInput {
  url: string
  schema: SessionSchema
  firmName: string
  isLiveDomain: boolean
  ctx: TokenContext
  deadline: number
  onProgress?: (stage: VisibilityStage, detail: string) => Promise<void>
}

const settle = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p
  } catch (err) {
    console.warn('[visibility] evidence step failed (non-fatal):', err)
    return null
  }
}

async function lookupGbp(schema: SessionSchema, firmName: string): Promise<GbpEvidence | null> {
  const place = await lookupPlace(firmName, { location: primaryCity(schema) ?? undefined })
  if (!place) return null
  return { rating: place.rating, reviewCount: place.reviewCount, mapsUri: place.mapsUri }
}

export async function runVisibilityReport(
  input: RunVisibilityInput,
): Promise<{ result: VisibilityResult; narrative: VisibilityNarrative }> {
  const report = input.onProgress ?? (async () => {})
  const domain = normalizeDomain(input.url)

  const audit = await runAudit({
    url: input.url,
    siteName: input.firmName,
    maxPages: MAX_PAGES,
    skipIntelligence: true,
    deadline: input.deadline - POST_CRAWL_RESERVE_MS,
    sessionId: input.ctx.sessionId ?? null,
    onProgress: async (stage: AuditStage, detail: string) => {
      await report(stage === 'crawling' ? 'crawling' : 'analyzing', detail)
    },
  })
  const index = buildSiteIndex(audit.raw?.pages ?? [], audit.raw?.analyzed ?? [])

  const unavailable: UnavailablePiece[] = []
  let ranks: VisibilityResult['ranks'] = null
  let gbp: GbpEvidence | null = null
  if (input.isLiveDomain) {
    await report('evidence', 'Checking Google rankings and Business Profile…')
    ;[ranks, gbp] = await Promise.all([settle(checkRanks(input.schema, domain)), settle(lookupGbp(input.schema, input.firmName))])
  }
  if (!ranks) unavailable.push('ranks')
  if (!gbp) unavailable.push('gbp')

  const base: RubricContext = {
    index,
    findings: audit.findings,
    categoryScores: audit.category_scores,
    schema: input.schema,
    sitemapEntries: audit.sitemap?.page_entries ?? [],
    isLiveDomain: input.isLiveDomain,
    now: new Date(),
    ranks,
    gbp,
    probe: null,
    ai: null,
  }
  const deterministic = evaluateRubric(base)

  await report('reviewing', 'Reviewing the site for each audience…')
  const [review, probe] = await Promise.all([
    settle(runAiReview({
      firmName: input.firmName,
      schema: input.schema,
      index,
      checks: deterministic,
      auditHints: (audit.recommendations ?? []).map((r) => `${r.title} — ${r.detail}`),
      ctx: input.ctx,
    })),
    input.isLiveDomain
      ? settle(runAiProbe({ schema: input.schema, firmName: input.firmName, domain, ctx: input.ctx }))
      : Promise.resolve(null),
  ])
  if (!probe) unavailable.push('probe')
  if (!review) unavailable.push('ai_review')

  await report('scoring', 'Scoring…')
  const checks = evaluateRubric({ ...base, probe, ai: review?.judgments ?? null })
  const { audienceScores, overallScore, overallGrade } = scoreAll(checks)

  const result: VisibilityResult = {
    rubricVersion: RUBRIC_VERSION,
    url: input.url,
    domain,
    isLiveDomain: input.isLiveDomain,
    auditedAt: new Date().toISOString(),
    pagesCrawled: audit.pages_crawled,
    checks,
    audienceScores,
    overallScore,
    overallGrade,
    categoryScores: audit.category_scores,
    ranks,
    gbp,
    probe,
    unavailable,
  }
  return { result, narrative: review?.narrative ?? fallbackNarrative(checks) }
}
