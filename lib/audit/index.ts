// Orchestration entrypoint. crawl → fetch meta/ssl/psi/index + 404 probe →
// analyze pages → score → recommend → assemble AuditResult, reporting progress
// via onProgress. Pure with respect to the DB: the worker (lib/audit/worker.ts)
// owns persistence and supplies onProgress.
import { analyzePage } from './analyze-page'
import { extractBusinessSignals } from './business-signals'
import { crawlSite, safeGet } from './crawl'
import { fetchLlmsTxt, fetchRobots, fetchSitemap } from './fetch-meta'
import { checkGoogleIndex } from './index-check'
import { buildIntelligence } from './intelligence'
import { checkPageSpeed } from './pagespeed'
import {
  buildPageSummary,
  generateRecommendations,
  generateSocialRecommendations,
  generateTeamSocialRecommendations,
  sortRecommendations,
} from './recommendations'
import { computeOverall, computeScores, getGrade } from './scoring'
import { checkSsl } from './ssl'
import type {
  AuditResult,
  CategoryKey,
  CategoryScoreMap,
  CategoryScores,
  Grade,
  PageAnalysis,
  RunAuditInput,
} from './types'

const VERSION = '1.0'
const CATEGORY_KEYS: CategoryKey[] = [
  'performance',
  'technical',
  'onpage_seo',
  'ux',
  'content',
  'indexability',
  'schema',
  'ai_llm',
  'analytics',
  'local_seo',
]

/** Normalize a user-supplied URL: ensure scheme, strip trailing slash. */
export function normalizeInputUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  return url
}

/** Normalized host: lowercased, no leading www., no trailing slash. */
export function normalizeDomain(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '')
  } catch {
    return url.toLowerCase()
  }
}

async function probe404(baseUrl: string): Promise<boolean> {
  const testUrl = `${baseUrl.replace(/\/+$/, '')}/this-page-definitely-does-not-exist-audit-check`
  const r = await safeGet(testUrl)
  return r !== null && r.status === 404 && r.body.length > 500
}

export async function runAudit(input: RunAuditInput): Promise<AuditResult> {
  const url = normalizeInputUrl(input.url)
  const domain = normalizeDomain(url)
  const siteName = input.siteName || domain
  const maxPages = input.maxPages ?? 80
  const auditDate = new Date().toISOString().slice(0, 10)
  const report = input.onProgress ?? (async () => {})

  // ── Crawl ────────────────────────────────────────────────────────────────
  await report('crawling', `Crawling ${domain}…`, 0)
  const { pages, errors } = await crawlSite(
    url,
    maxPages,
    async (count) => {
      await report('crawling', `Crawled ${count} page${count === 1 ? '' : 's'}…`, count)
    },
    input.deadline,
  )
  if (!pages.length) {
    const first = errors[0]
    const status = first?.status
    // A 401/403/429/503 on the homepage is almost always bot protection (e.g.
    // Cloudflare) refusing our server's IP — not a bad URL. Say so plainly so the
    // operator knows re-running won't help and it isn't a bug in the audit.
    if (status && [401, 403, 429, 503].includes(status)) {
      throw new Error(
        `The site's bot protection blocked our audit crawler (HTTP ${status}). Sites behind Cloudflare/WAF can deny requests from cloud servers even though they load fine in a browser — re-running won't change this.`,
      )
    }
    const detail = first
      ? status
        ? `homepage returned HTTP ${status}`
        : (first.error ?? 'request failed')
      : 'no reachable HTML pages'
    throw new Error(`Could not crawl any pages (${detail}). Check the URL and try again.`)
  }

  // ── Supporting fetchers (independent → parallel) ───────────────────────────
  await report('analyzing', 'Fetching robots, sitemap, SSL, PageSpeed…', pages.length)
  const robots = await fetchRobots(url)
  const [sitemap, ssl, llms, psiMobile, psiDesktop, indexCheck, has404] = await Promise.all([
    fetchSitemap(url, robots.sitemaps),
    checkSsl(url),
    fetchLlmsTxt(url),
    checkPageSpeed(url, 'mobile'),
    checkPageSpeed(url, 'desktop'),
    checkGoogleIndex(domain),
    probe404(pages[0].url),
  ])

  // ── Per-page analysis ──────────────────────────────────────────────────────
  await report('analyzing', `Analyzing ${pages.length} pages…`, pages.length)
  const analyzed: PageAnalysis[] = pages.map((p) => analyzePage(p))

  // ── Scoring ────────────────────────────────────────────────────────────────
  await report('scoring', 'Computing scores…', pages.length)
  const googleIndexCount =
    indexCheck.google_index_count === 'unverified' ? null : indexCheck.google_index_count
  const { scores, findings } = computeScores({
    pages,
    analyzed,
    robots,
    sitemap,
    ssl,
    psiMobile,
    psiDesktop,
    llms,
    errors,
    has404,
    googleIndexCount,
  })
  const overallScore = computeOverall(scores)
  const overallGrade = getGrade(overallScore)
  const categoryScores = buildCategoryScoreMap(scores)

  // ── Recommendations + summaries ─────────────────────────────────────────────
  await report('rendering', 'Generating recommendations…', pages.length)
  const recommendations = generateRecommendations(findings)
  const pageAnalysisSummary = pages.map((p, i) => buildPageSummary(p, analyzed[i], siteName))
  const businessSignals = extractBusinessSignals(pages)

  const result: AuditResult = {
    version: VERSION,
    domain,
    site_name: siteName,
    url,
    audit_date: auditDate,
    max_pages: maxPages,
    pages_crawled: pages.length,
    crawl_errors_count: errors.length,
    overall_score: overallScore,
    overall_grade: overallGrade,
    scores,
    category_scores: categoryScores,
    findings,
    recommendations,
    page_analysis_summary: pageAnalysisSummary,
    google_indexed_urls: indexCheck.google_indexed_urls,
    sitemap,
    business_signals: businessSignals,
    raw: {
      pages,
      analyzed,
      psi_mobile: psiMobile,
      psi_desktop: psiDesktop,
      robots,
      ssl,
      llms,
      crawl_errors: errors,
    },
  }

  if (input.skipIntelligence) return result

  // ── Intelligence (AI + off-site research) ───────────────────────────────────
  // Best-effort and non-fatal (mirrors the WHOIS rule): a failure here leaves
  // `intelligence` undefined and the audit still completes. Runs on the
  // in-memory result while raw HTML/headers are still present (the worker strips
  // them only at persist time).
  await report('researching', 'Researching niches, competitors & reputation…', pages.length)
  try {
    result.intelligence = await buildIntelligence(
      result,
      {
        sessionId: input.sessionId,
        auditId: input.auditId,
      },
      input.deadline,
    )
  } catch (err) {
    console.warn('[audit] intelligence stage failed (non-fatal):', err)
  }

  // Merge social/local presence recommendations into the findings-based list and
  // re-sort. Social presence never feeds scoring — this is display/recs only.
  const socialPresence = result.intelligence?.social_presence
  if (socialPresence) {
    const socialRecs = generateSocialRecommendations(socialPresence)
    if (socialRecs.length) {
      result.recommendations = sortRecommendations([...result.recommendations, ...socialRecs])
    }
  }

  // Team social footprint / niche-expertise recs — same merge, display/recs only.
  const teamSocial = result.intelligence?.team_social
  if (teamSocial) {
    const teamRecs = generateTeamSocialRecommendations(teamSocial)
    if (teamRecs.length) {
      result.recommendations = sortRecommendations([...result.recommendations, ...teamRecs])
    }
  }

  return result
}

function buildCategoryScoreMap(scores: CategoryScores): CategoryScoreMap {
  const map = {} as CategoryScoreMap
  for (const key of CATEGORY_KEYS) {
    const score = scores[key]
    const grade: Grade | null = score === null ? null : getGrade(score)
    map[key] = { score, grade }
  }
  return map
}

export type { AuditResult, RunAuditInput } from './types'
