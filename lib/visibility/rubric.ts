// The versioned Visibility Report rubric: one list of weighted checks per
// audience, evaluated from the shared audit engine's findings, the crawled-page
// index, the client's MBP, external evidence and the AI review's judgments.
// Pure — every input arrives in RubricContext. Changing a check's id, weight or
// status rule changes scores, so it MUST bump RUBRIC_VERSION (trends only
// compare reports with an equal version).
import { activeNiches } from '@/lib/content/active-niches'
import { activeServices } from '@/lib/content/active-services'
import { activeTeam } from '@/lib/content/active-team'
import type { CategoryKey, CategoryScoreMap, Findings, SitemapEntry } from '@/types/audit-result'
import type { SessionSchema } from '@/types/session-schema'
import { findPageMentioning, pagesOfKind, type IndexedPage } from './site-index'
import type { AudienceKey, CheckResult, CheckStatus, GbpEvidence, ProbeResult, RankResult } from './types'

export const RUBRIC_VERSION = '2026.11.3'

export interface AiJudgment {
  checkId: string
  status: Exclude<CheckStatus, 'na'>
  detail: string
  evidenceUrl: string | null
}

export interface RubricContext {
  index: IndexedPage[]
  findings: Findings
  categoryScores: CategoryScoreMap
  schema: SessionSchema
  sitemapEntries: SitemapEntry[]
  isLiveDomain: boolean
  now: Date
  ranks: RankResult[] | null
  gbp: GbpEvidence | null
  probe: ProbeResult[] | null
  ai: AiJudgment[] | null
}

export const AI_CHECKS: ReadonlyArray<{ id: string; audience: AudienceKey; label: string; question: string }> = [
  {
    id: 'p.answers_need',
    audience: 'prospects',
    label: 'Pages explain your services, who you help, and how to begin',
    question:
      'For the firm\'s main services, does a prospect landing on the relevant page quickly learn what the firm does, whom it helps, and how to take the next step?',
  },
  {
    id: 'n.understands_industry',
    audience: 'niche',
    label: 'Industry pages show you understand their business',
    question:
      'Do the firm\'s industry pages show real knowledge of each industry: its specific challenges, and the specific work the firm does for businesses in it?',
  },
  {
    id: 't.story',
    audience: 'talent',
    label: 'Clear story for future team members and partners',
    question:
      'Does the site give a future employee, partner, or acquirer a clear sense of the firm\'s culture, people, growth, and how to start a conversation?',
  },
  {
    id: 'a.entity_clarity',
    audience: 'ai',
    label: 'Firm is described consistently and unambiguously',
    question:
      'Do the home and about pages describe who the firm is, whom it serves, where, and what it is known for in plain, consistent terms that match the firm profile — so an AI model would summarize it correctly?',
  },
]

type Partial3 = Omit<CheckResult, 'audience' | 'id' | 'label' | 'weight' | 'source'>

function make(
  id: string,
  audience: AudienceKey,
  label: string,
  weight: number,
  source: CheckResult['source'],
  r: Partial3,
): CheckResult {
  return { id, audience, label, weight, source, ...r }
}

const res = (status: CheckStatus, detail: string, evidenceUrl: string | null = null): Partial3 => ({ status, detail, evidenceUrl })

const tiered = (value: number, passAt: number, partialAt: number): CheckStatus =>
  value >= passAt ? 'pass' : value >= partialAt ? 'partial' : 'fail'

function coverage(names: string[], index: IndexedPage[], headingOnly: boolean, noun: string, foundPhrase?: string): Partial3 {
  if (names.length === 0) return res('na', `No ${noun} in the firm profile`)
  const found = names.map((n) => ({ n, page: findPageMentioning(index, n, { headingOnly }) }))
  const hits = found.filter((f) => f.page)
  const share = hits.length / names.length
  const missing = found.filter((f) => !f.page).map((f) => f.n)
  const detail =
    `${hits.length} of ${names.length} ${noun} ${foundPhrase ?? (headingOnly ? 'have a dedicated page' : 'are mentioned on the site')}` +
    (missing.length ? ` — missing: ${missing.slice(0, 5).join(', ')}` : '')
  return res(tiered(share, 0.8, headingOnly ? 0.4 : 0.6), detail, hits[0]?.page?.url ?? null)
}

function categoryCheck(scores: CategoryScoreMap, key: CategoryKey, name: string): Partial3 {
  const s = scores[key]?.score
  if (s === null || s === undefined) return res('na', `${name} could not be measured`)
  return res(tiered(s, 80, 60), `${name} score ${s}/100`)
}

function aiCheck(ctx: RubricContext, id: string): Partial3 {
  if (!ctx.ai) return res('na', 'AI review unavailable for this report')
  const j = ctx.ai.find((a) => a.checkId === id)
  if (!j) return res('na', 'AI review did not assess this check')
  return res(j.status, j.detail, j.evidenceUrl)
}

const RESOURCE_URL = /blog|resource|insight|article|news|post/i

const DEAL_INTENT = /succession|merg|acqui|\bm&a\b|investment|investor|sell (the|our) (firm|practice)|practice (sale|transition)|join forces|tuck-?in/i

// The succession check only applies to firms that have said they're open to a
// deal — in their growth goals or the content they asked us to feature.
function openToDeals(schema: SessionSchema): boolean {
  const b = schema.business
  const text = [b?.growthGoals, b?.firmHistory, ...(Array.isArray(b?.contentEmphasis) ? b.contentEmphasis : [])]
    .filter((x): x is string => typeof x === 'string')
    .join(' ')
  return DEAL_INTENT.test(text)
}

function prospects(ctx: RubricContext): CheckResult[] {
  const a: AudienceKey = 'prospects'
  const f = ctx.findings
  const contact = pagesOfKind(ctx.index, 'contact')[0] ?? null
  const mobile = f.performance.mobile_score
  return [
    make('p.service_pages', a, 'Each service has its own page', 3, 'site',
      coverage(activeServices(ctx.schema).map((s) => s.name), ctx.index, true, 'services')),
    make('p.cta', a, 'Pages invite the next step', 2, 'audit',
      res(tiered(f.content.pct_has_cta, 70, 40), `${Math.round(f.content.pct_has_cta)}% of pages carry a call to action`)),
    make('p.contact', a, 'Easy to get in touch', 2, 'site',
      f.content.homepage_has_contact && contact
        ? res('pass', 'Contact details on the homepage and a contact page', contact.url)
        : f.content.homepage_has_contact || contact
          ? res('partial', contact ? 'Contact page found, but no contact details on the homepage' : 'Homepage shows contact details, but there is no contact page', contact?.url ?? null)
          : res('fail', 'No contact page and no contact details on the homepage')),
    make('p.mobile', a, 'Fast on mobile', 1, 'audit',
      typeof mobile === 'number'
        ? res(tiered(mobile, 80, 50), `Mobile performance ${mobile}/100`)
        : res('na', 'Mobile performance could not be measured')),
    make('p.answers_need', a, AI_CHECKS[0].label, 3, 'ai', aiCheck(ctx, 'p.answers_need')),
  ]
}

function niche(ctx: RubricContext): CheckResult[] {
  const a: AudienceKey = 'niche'
  const niches = activeNiches(ctx.schema).map((n) => n.name)
  const nichePages = niches
    .map((n) => findPageMentioning(ctx.index, n, { headingOnly: true }))
    .filter((p): p is IndexedPage => !!p)
  const resourcePages = ctx.index.filter((p) => RESOURCE_URL.test(p.path))

  const dated = ctx.sitemapEntries
    .filter((e) => RESOURCE_URL.test(e.url) && e.lastmod)
    .map((e) => ({ e, t: Date.parse(e.lastmod) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((x, y) => y.t - x.t)
  let fresh: Partial3
  if (!dated.length) {
    fresh = res('na', 'No dated articles in the sitemap')
  } else {
    const days = Math.floor((ctx.now.getTime() - dated[0].t) / 86_400_000)
    fresh = res(days <= 60 ? 'pass' : days <= 180 ? 'partial' : 'fail', `Newest article is ${days} days old`, dated[0].e.url)
  }

  const members = activeTeam(ctx.schema)
  let experts: Partial3
  if (!niches.length) {
    experts = res('na', 'No industries in the firm profile')
  } else if (!members.length) {
    experts = res('na', 'No team members in the firm profile')
  } else if (!nichePages.length) {
    experts = res('fail', 'No industry pages to connect your experts to')
  } else {
    const names = members.map((m) => m.name.trim().toLowerCase())
    const withExpert = nichePages.filter((p) => {
      const hay = `${p.html} ${p.text}`.toLowerCase()
      return names.some((n) => hay.includes(n))
    })
    experts = res(tiered(withExpert.length / nichePages.length, 0.8, 0.4),
      `${withExpert.length} of ${nichePages.length} industry pages name a team member`, withExpert[0]?.url ?? null)
  }

  const stories =
    pagesOfKind(ctx.index, 'testimonials')[0] ??
    ctx.index.find((p) => p.schemaTypes.some((t) => /review|testimonial/i.test(t))) ??
    null

  return [
    make('n.niche_pages', a, 'Each industry you serve has its own page', 3, 'site',
      coverage(niches, ctx.index, true, 'industries')),
    make('n.niche_content', a, 'Articles written for each industry', 2, 'site',
      coverage(niches, resourcePages, false, 'industries', 'are covered in articles or resources')),
    make('n.fresh_content', a, 'Fresh insights and resources', 1, 'site', fresh),
    make('n.niche_experts', a, 'Industry pages connect to your experts', 1, 'site', experts),
    make('n.case_studies', a, 'Client success stories', 1, 'site',
      stories ? res('pass', 'Success stories or testimonials found', stories.url) : res('fail', 'No testimonials or success stories found')),
    make('n.understands_industry', a, AI_CHECKS[1].label, 3, 'ai', aiCheck(ctx, 'n.understands_industry')),
  ]
}

function talent(ctx: RubricContext): CheckResult[] {
  const a: AudienceKey = 'talent'
  const careers = pagesOfKind(ctx.index, 'careers')
  const careersPage = careers[0] ?? null
  const jobSchema = ctx.index.find((p) => p.schemaTypes.includes('JobPosting')) ?? null
  const applyPage = careers.find((p) => /apply|open position|opening|r[eé]sum[eé]|job ?posting/i.test(`${p.text} ${p.html}`)) ?? jobSchema

  const teamPage = pagesOfKind(ctx.index, 'team')[0] ?? null
  const members = activeTeam(ctx.schema)
  let bios: Partial3
  if (!teamPage) {
    bios = res('fail', 'No team or people page found')
  } else if (!members.length) {
    bios = res('pass', 'Team page found', teamPage.url)
  } else {
    const allHtml = ctx.index.map((p) => `${p.html} ${p.text}`.toLowerCase()).join('\n')
    const named = members.filter((m) => allHtml.includes(m.name.trim().toLowerCase())).length
    bios = res(tiered(named / members.length, 0.8, 0.4), `Team page found; ${named} of ${members.length} team members are named on the site`, teamPage.url)
  }

  const cultureScope = [...careers, ...pagesOfKind(ctx.index, 'about')]
  const culture = cultureScope.find((p) => /culture|values|why work|benefits/i.test(`${p.text} ${p.html} ${p.title}`)) ?? null

  const partnerPage = pagesOfKind(ctx.index, 'partners')[0] ?? null
  const affiliations = (ctx.schema.business?.affiliations ?? []).filter((x) => typeof x === 'string' && x.trim())
  const namedAffiliation = affiliations.length ? findPageMentioning(ctx.index, affiliations[0]) : null
  const partners = partnerPage ?? namedAffiliation

  const succession = pagesOfKind(ctx.index, 'succession')[0] ?? null

  return [
    make('t.careers', a, 'A careers page', 3, 'site',
      careersPage ? res('pass', 'Careers page found', careersPage.url) : res('fail', 'No careers or join-our-team page found')),
    make('t.apply_path', a, 'Open roles or a way to apply', 2, 'site',
      applyPage
        ? res('pass', jobSchema ? 'Job postings are marked up for Google Jobs' : 'Careers page explains how to apply', applyPage.url)
        : res('fail', 'No open roles or application path found')),
    make('t.team_bios', a, 'Team bios that show depth', 2, 'site', bios),
    make('t.culture', a, 'Culture and values are visible', 1, 'site',
      culture ? res('pass', 'Culture or values content found', culture.url) : res('fail', 'No culture or values content found')),
    make('t.partners', a, 'Partners, alliances and affiliations', 1, 'site',
      partners ? res('pass', 'Partner or affiliation content found', partners.url) : res('fail', 'No partner, alliance or affiliation content found')),
    make('t.succession', a, 'Open to succession, mergers or investment', 1, 'site',
      !openToDeals(ctx.schema)
        ? res('na', 'Not among the firm\'s stated goals')
        : succession
          ? res('pass', 'Succession / M&A content found', succession.url)
          : res('fail', 'The firm is open to succession, mergers or investment, but the site doesn\'t say so')),
    make('t.story', a, AI_CHECKS[2].label, 2, 'ai', aiCheck(ctx, 't.story')),
  ]
}

function search(ctx: RubricContext): CheckResult[] {
  const a: AudienceKey = 'search'
  let ranks: Partial3
  if (!ctx.ranks) {
    ranks = res('na', ctx.isLiveDomain ? 'Keyword rankings unavailable' : 'Available once the site is on its live domain')
  } else if (!ctx.ranks.length) {
    ranks = res('na', 'No target keywords in the firm profile')
  } else {
    const top = ctx.ranks.filter((r) => r.position !== null && r.position <= 10)
    const share = top.length / ctx.ranks.length
    const best = top.sort((x, y) => (x.position ?? 99) - (y.position ?? 99))[0]
    ranks = res(tiered(share, 0.5, 0.2), `${top.length} of ${ctx.ranks.length} target searches show the firm on page one`, best?.url ?? null)
  }

  let gbp: Partial3
  if (!ctx.gbp || ctx.gbp.rating === null) {
    gbp = res('na', ctx.isLiveDomain ? 'Google Business Profile not found' : 'Available once the site is on its live domain')
  } else {
    const { rating, reviewCount } = ctx.gbp
    const count = reviewCount ?? 0
    const status: CheckStatus = rating >= 4.5 && count >= 25 ? 'pass' : rating >= 4.0 ? 'partial' : 'fail'
    gbp = res(status, `${rating.toFixed(1)}★ from ${count} Google reviews`, ctx.gbp.mapsUri)
  }

  return [
    make('s.onpage', a, 'Titles, descriptions and headings', 2, 'audit', categoryCheck(ctx.categoryScores, 'onpage_seo', 'On-page SEO')),
    make('s.indexable', a, 'Google can find every page', 2, 'audit', categoryCheck(ctx.categoryScores, 'indexability', 'Indexability')),
    make('s.technical', a, 'Secure, healthy technical foundation', 1, 'audit', categoryCheck(ctx.categoryScores, 'technical', 'Technical health')),
    make('s.local', a, 'Local search signals', 2, 'audit', categoryCheck(ctx.categoryScores, 'local_seo', 'Local SEO')),
    make('s.ranks', a, 'Ranking for target searches', 3, 'external', ranks),
    make('s.gbp', a, 'Google Business Profile reputation', 2, 'external', gbp),
  ]
}

function ai(ctx: RubricContext): CheckResult[] {
  const a: AudienceKey = 'ai'
  const f = ctx.findings
  const blocked = f.ai_llm.ai_crawlers_blocked
  const hasEntity = f.schema.has_organization || f.schema.has_local_business
  const hasDepth = f.schema.types_found.some((t) => t === 'Person' || t === 'FAQPage')

  let probe: Partial3
  if (!ctx.probe) {
    probe = res('na', ctx.isLiveDomain ? 'AI answer check unavailable' : 'Available once the site is on its live domain')
  } else if (!ctx.probe.length) {
    probe = res('na', 'Not enough firm profile detail to ask buyer questions')
  } else {
    const hits = ctx.probe.filter((p) => p.mentioned)
    probe = res(tiered(hits.length / ctx.probe.length, 2 / 3, 1 / 3),
      `Named in ${hits.length} of ${ctx.probe.length} AI answers to buyer questions`, hits[0]?.citedUrl ?? null)
  }

  return [
    make('a.llms', a, 'An llms.txt guide for AI models', 1, 'audit',
      f.ai_llm.llms_txt_present ? res('pass', 'llms.txt published', f.ai_llm.llms_txt_url) : res('fail', 'No llms.txt file')),
    make('a.crawlers', a, 'AI crawlers are allowed', 2, 'audit',
      blocked.length ? res('fail', `Blocked in robots.txt: ${blocked.join(', ')}`) : res('pass', 'No AI crawlers blocked')),
    make('a.entity_schema', a, 'Structured data describes the firm', 2, 'audit',
      hasEntity && hasDepth
        ? res('pass', `Structured data: ${f.schema.types_found.slice(0, 6).join(', ')}`)
        : hasEntity
          ? res('partial', 'Organization data present; no people or FAQ markup')
          : res('fail', 'No Organization or LocalBusiness structured data')),
    make('a.faq', a, 'Questions answered in FAQ markup', 1, 'audit',
      f.ai_llm.has_faq_schema ? res('pass', 'FAQ structured data found') : res('fail', 'No FAQ structured data')),
    make('a.entity_clarity', a, AI_CHECKS[3].label, 2, 'ai', aiCheck(ctx, 'a.entity_clarity')),
    make('a.probe', a, 'Named in AI answers to buyer questions', 3, 'external', probe),
  ]
}

export function evaluateRubric(ctx: RubricContext): CheckResult[] {
  return [...prospects(ctx), ...niche(ctx), ...talent(ctx), ...search(ctx), ...ai(ctx)]
}
