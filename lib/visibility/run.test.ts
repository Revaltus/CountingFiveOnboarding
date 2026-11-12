import { beforeEach, describe, expect, it, vi } from 'vitest'
import { categoryScoresFixture, findingsFixture, schemaFixture } from './__fixtures__/rubric-fixtures'
import type { AuditResult, CrawledPage, PageAnalysis } from '@/types/audit-result'

const h = vi.hoisted(() => ({
  runAudit: vi.fn(),
  checkRanks: vi.fn(),
  lookupPlace: vi.fn(),
  runAiProbe: vi.fn(),
  runAiReview: vi.fn(),
}))

vi.mock('@/lib/audit/index', () => ({
  runAudit: h.runAudit,
  normalizeDomain: (u: string) => new URL(u).host.replace(/^www\./, ''),
}))
vi.mock('./ranks', async (orig) => ({ ...(await orig<typeof import('./ranks')>()), checkRanks: h.checkRanks }))
vi.mock('@/lib/audit/places-lookup', () => ({ lookupPlace: h.lookupPlace }))
vi.mock('./ai-probe', () => ({ runAiProbe: h.runAiProbe }))
vi.mock('./ai-review', () => ({ runAiReview: h.runAiReview }))

import { runVisibilityReport } from './run'

function auditResult(): AuditResult {
  const pages = [
    { url: 'https://firm.com/', status_code: 200, html: 'Subscribe', original_url: '', redirect_chain: [], redirect_count: 0, response_headers: {}, ssl_error: false, content_length: 1 },
    { url: 'https://firm.com/careers', status_code: 200, html: 'Apply now', original_url: '', redirect_chain: [], redirect_count: 0, response_headers: {}, ssl_error: false, content_length: 1 },
  ] as CrawledPage[]
  const analyzed = [
    { title: 'Home', h1_texts: ['Firm CPA'], page_text_sample: '', schema_types: [] },
    { title: 'Careers', h1_texts: ['Careers'], page_text_sample: '', schema_types: [] },
  ] as unknown as PageAnalysis[]
  return {
    pages_crawled: 2,
    findings: findingsFixture('good'),
    category_scores: categoryScoresFixture(85),
    sitemap: { page_entries: [] },
    raw: { pages, analyzed },
  } as unknown as AuditResult
}

const ctx = { task: 'audit' as const, stage: 'visibility' as const, sessionId: 's1' }

describe('runVisibilityReport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.runAudit.mockResolvedValue(auditResult())
    h.checkRanks.mockResolvedValue([{ query: 'q', position: 2, url: 'https://firm.com/' }])
    h.lookupPlace.mockResolvedValue({ name: 'Firm', rating: 4.9, reviewCount: 80, businessStatus: null, categories: [], hoursListed: true, mapsUri: 'm' })
    h.runAiProbe.mockResolvedValue([{ question: 'q', kind: 'discovery', mentioned: true, snippet: '', citedUrl: null }])
    h.runAiReview.mockResolvedValue(null)
  })

  it('runs the audit without prospect intelligence', async () => {
    await runVisibilityReport({ url: 'https://firm.com', schema: schemaFixture(), firmName: 'Firm CPA', isLiveDomain: true, ctx, deadline: Date.now() + 600_000 })
    expect(h.runAudit).toHaveBeenCalledWith(expect.objectContaining({ skipIntelligence: true }))
  })

  it('skips off-site evidence for a staging URL and still scores', async () => {
    const { result } = await runVisibilityReport({ url: 'https://firm.vercel.app', schema: schemaFixture(), firmName: 'Firm CPA', isLiveDomain: false, ctx, deadline: Date.now() + 600_000 })
    expect(h.checkRanks).not.toHaveBeenCalled()
    expect(h.lookupPlace).not.toHaveBeenCalled()
    expect(h.runAiProbe).not.toHaveBeenCalled()
    expect(result.ranks).toBeNull()
    expect(result.unavailable).toEqual(expect.arrayContaining(['ranks', 'gbp', 'probe', 'ai_review']))
    expect(result.audienceScores.talent.score).not.toBeNull()
    expect(result.rubricVersion).toBeTruthy()
  })

  it('collects live evidence and falls back to a check-based narrative without AI', async () => {
    const { result, narrative } = await runVisibilityReport({ url: 'https://firm.com', schema: schemaFixture(), firmName: 'Firm CPA', isLiveDomain: true, ctx, deadline: Date.now() + 600_000 })
    expect(result.gbp?.rating).toBe(4.9)
    expect(result.probe).toHaveLength(1)
    expect(result.unavailable).toEqual(['ai_review'])
    expect(narrative.overview).toMatch(/without AI commentary/)
  })

  it('uses AI judgments and narrative when the review succeeds', async () => {
    h.runAiReview.mockResolvedValue({
      judgments: [{ checkId: 't.story', status: 'pass', detail: 'Strong', evidenceUrl: null }],
      narrative: { overview: 'Your site is strong.', audiences: { prospects: { wins: [], opportunities: [] }, niche: { wins: [], opportunities: [] }, talent: { wins: ['x'], opportunities: [] }, search: { wins: [], opportunities: [] }, ai: { wins: [], opportunities: [] } } },
    })
    const { result, narrative } = await runVisibilityReport({ url: 'https://firm.com', schema: schemaFixture(), firmName: 'Firm CPA', isLiveDomain: true, ctx, deadline: Date.now() + 600_000 })
    expect(narrative.overview).toBe('Your site is strong.')
    expect(result.checks.find((c) => c.id === 't.story')?.status).toBe('pass')
    expect(result.unavailable).toEqual([])
  })
})
