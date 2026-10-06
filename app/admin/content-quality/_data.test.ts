import { describe, it, expect, vi } from 'vitest'

type Call = { table: string; ops: Array<[string, ...unknown[]]> }
const calls: Call[] = []
const rows: Record<string, unknown[]> = {}

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => ({
    from(table: string) {
      const call: Call = { table, ops: [] }
      calls.push(call)
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'not', 'or', 'in', 'eq']) {
        b[op] = (...args: unknown[]) => { call.ops.push([op, ...args]); return b }
      }
      b.then = (ok: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows[table] ?? [], error: null }).then(ok)
      return b
    },
  }),
}))

import { loadContentQuality } from './_data'

const critic = {
  evidence_specificity: 8, information_gain: 8, brand_fidelity: 8, promise_fulfillment: 8,
  unsupported_claims: [], notes: 'ok', critic_model: 'm', scored_at: '2026-10-01T00:00:00Z',
}
const qa = {
  mode: 'on', ran_at: '2026-10-01T00:00:00Z', findings: [],
  scores: { accuracy: 6, copy: 10, seo: 10, structure: 10 }, judge: null, passed: false,
}

describe('loadContentQuality', () => {
  it('includes judge-less QA reviews in QA stats without counting them as critic scores', async () => {
    rows.generated_pages = [
      { critic_review: critic, qa_review: null, page_url: '/a', content_job_id: 'j1' },
      { critic_review: null, qa_review: qa, page_url: '/b', content_job_id: 'j1' },
    ]
    const data = await loadContentQuality()
    const pagesCall = calls.find(c => c.table === 'generated_pages')!
    expect(pagesCall.ops).toContainEqual(['or', 'critic_review.not.is.null,qa_review.not.is.null'])
    expect(pagesCall.ops.some(([op]) => op === 'not')).toBe(false)
    expect(data.qa.pages).toBe(1)
    expect(data.slices[0].scored).toBe(1)
    expect(data.totalScored).toBe(1)
  })

  it('lists pages with open QA findings, most urgent first, linked to their preview', async () => {
    const finding = (id: string, agent: string, kind: string, severity: string, status = 'open') => ({
      id, agent, kind, severity, status, quote: 'q', message: 'm', safety: 'flag',
    })
    rows.content_jobs = [{ id: 'j1', session_id: 's1' }]
    rows.sessions = [{ id: 's1', website_url: 'https://acme.com/', schema_data: { business: { name: 'Acme CPA' } } }]
    rows.generated_pages = [
      { id: 'p-clean', critic_review: critic, qa_review: { ...qa, findings: [finding('f0', 'seo', 'question_heading', 'low', 'dismissed')] }, page_url: '/clean', content_job_id: 'j1' },
      { id: 'p-low', critic_review: critic, qa_review: { ...qa, findings: [finding('f1', 'seo', 'question_heading', 'low'), finding('f2', 'seo', 'question_heading', 'med')] }, page_url: '/low', content_job_id: 'j1' },
      { id: 'p-high', critic_review: critic, qa_review: { ...qa, findings: [finding('f3', 'judge', 'unsupported_claim', 'high')] }, page_url: '/high', content_job_id: 'j1' },
    ]
    const data = await loadContentQuality()
    expect(data.qaOpenPages.map(p => p.label)).toEqual(['/high', '/low'])
    expect(data.qaOpenPages[1]).toEqual({
      site: 'Acme CPA', label: '/low', open: 2, highOpen: 0,
      kinds: ['seo:question_heading'], href: '/admin/content/s1?preview=p-low',
    })
    expect(data.qaOpenPages[0].highOpen).toBe(1)
  })

  it('links a flagged site page to its preview and a blog draft to the editor', async () => {
    const flagged = { ...critic, evidence_specificity: 2, information_gain: 2, brand_fidelity: 2, promise_fulfillment: 2 }
    rows.content_jobs = [{ id: 'j1', session_id: 's1' }]
    rows.sessions = [{ id: 's1', website_url: 'https://acme.com', schema_data: {} }]
    rows.generated_pages = [{ id: 'p1', critic_review: flagged, qa_review: null, page_url: '/a', content_job_id: 'j1' }]
    rows.resource_ideas = [{ critic_review: flagged, title: 'Post', session_id: 's1', draft_path: 'content/resources/post.md' }]
    const data = await loadContentQuality()
    const page = data.recentFlagged.find(f => f.kind === 'Page')!
    const blog = data.recentFlagged.find(f => f.kind === 'Blog')!
    expect(page.href).toBe('/admin/content/s1?preview=p1')
    expect(blog.href).toBe('/admin/content/s1/edit?path=content%2Fresources%2Fpost.md')
  })
})
