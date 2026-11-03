import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'

const fixture = readFileSync(
  path.join(__dirname, '../../../../../lib/content/__fixtures__/page-structure-zigzag.md'),
  'utf8',
)

const h = vi.hoisted(() => ({
  ctx: null as unknown,
  schema: {} as Record<string, unknown>,
  readFile: vi.fn(),
  writeFile: vi.fn(async (..._args: unknown[]) => ({ commitSha: 'c', blobSha: 'b' })),
  listPathCommits: vi.fn(async (..._args: unknown[]) => [] as Array<{ message: string; date: string | null; authorName: string | null }>),
  proposeRestructure: vi.fn(),
  overLimit: null as unknown,
  reviewContentEdit: vi.fn(),
}))

vi.mock('../_helpers', () => ({ resolveEditContext: async () => h.ctx }))
vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { schema_data: h.schema }, error: null }) }) }),
    }),
  }),
}))
vi.mock('@/lib/ai/chat-spend-limit', () => ({ checkChatSpendLimit: async () => h.overLimit }))
vi.mock('@/lib/content/no-go-phrases', () => ({ loadNoGoPhrases: async () => [] }))
vi.mock('@/lib/design/capabilities-read', () => ({ readDraftTemplateVersion: async () => null }))
vi.mock('@/lib/content/content-edit-review', () => ({ reviewContentEdit: h.reviewContentEdit }))
vi.mock('@/lib/content/restructure-page', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/content/restructure-page')>()),
  proposeRestructure: h.proposeRestructure,
}))
vi.mock('@/lib/github/repo-files', () => ({
  DRAFT_BRANCH: 'draft',
  FileNotFoundError: class extends Error {},
  StaleShaError: class extends Error {},
  ensureDraftBranch: vi.fn(),
  listPathCommits: h.listPathCommits,
  readFile: h.readFile,
  writeFile: h.writeFile,
}))

import { GET, POST } from './route'
import { composeProposal } from '@/lib/content/restructure-page'

const PAGE = 'content/pages/industries--optometry.md'

function call(body: unknown) {
  return POST(new Request('http://x/api/edit/s/restructure', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: 's' }),
  })
}

const lean = composeProposal(
  fixture,
  PAGE,
  {
    body: `<!-- block: intro-text | variant: centered -->\n## Hi\n\nShort, with [outsourced accounting](/services/outsourced-accounting), [foundations](/services/business-foundation-services), [metrics](/industries/optometry/practice-management-metrics) and [our approach](/why-rootadvisors).\n\n<!-- block: cta-banner | variant: color-bg -->\n## Talk\n\n[Book a practice review](/contact)`,
    faq: [{ question: 'Q?', answer: 'A.' }],
  },
  {} as never,
)

describe('POST /api/edit/[id]/restructure', () => {
  beforeEach(() => {
    h.ctx = { githubRepo: 'repo', sessionId: 'sess', adminEmail: 'a@x.com', adminName: 'A', user: { id: 'u1', isAdmin: true } }
    h.schema = {}
    h.overLimit = null
    h.readFile.mockReset()
    h.readFile.mockResolvedValue({ path: PAGE, content: fixture, sha: 'sha-1' })
    h.writeFile.mockClear()
    h.proposeRestructure.mockReset()
    h.listPathCommits.mockReset()
    h.listPathCommits.mockResolvedValue([])
    h.reviewContentEdit.mockClear()
  })

  it('returns the access gate response untouched', async () => {
    h.ctx = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const res = await call({ path: PAGE })
    expect(res.status).toBe(403)
    expect(h.proposeRestructure).not.toHaveBeenCalled()
  })

  it('forbids managers and editors (admins and Site Owners only, like the AI editor)', async () => {
    h.ctx = { githubRepo: 'repo', sessionId: 'sess', user: { id: 'u2', isAdmin: false, capabilities: ['manager'] } }
    expect((await call({ path: PAGE })).status).toBe(403)
    h.ctx = { githubRepo: 'repo', sessionId: 'sess', user: { id: 'u3', isAdmin: false, capabilities: ['editor'] } }
    expect((await call({ action: 'accept', path: PAGE, proposed: lean, expectedSha: 'sha-1' })).status).toBe(403)
    expect(h.proposeRestructure).not.toHaveBeenCalled()
    expect(h.writeFile).not.toHaveBeenCalled()
  })

  it('lets a Site Owner propose', async () => {
    h.ctx = { githubRepo: 'repo', sessionId: 'sess', user: { id: 'u4', isAdmin: false, capabilities: ['owner'] } }
    h.proposeRestructure.mockResolvedValue({ ok: false, reason: 'model_failed', details: [] })
    expect((await call({ path: PAGE })).status).toBe(502)
    expect(h.proposeRestructure).toHaveBeenCalled()
  })

  it('rejects traversal and non-page paths', async () => {
    expect((await call({ path: 'content/pages/..%2F..%2Fetc%2Fpasswd.md' })).status).toBe(400)
    expect((await call({ path: 'content/posts/tax-tips.md' })).status).toBe(400)
    expect((await call({ path: 'content/nav.json' })).status).toBe(400)
    expect(h.readFile).not.toHaveBeenCalled()
  })

  it('refuses a verbatim client page before any AI call', async () => {
    h.schema = {
      operator_directives: [
        { kind: 'bring_page', verbatim: true, sourceUrl: '/industries/optometry', status: 'resolved', sourceText: 'keep it' },
      ],
    }
    const res = await call({ path: PAGE })
    expect(res.status).toBe(422)
    expect(h.proposeRestructure).not.toHaveBeenCalled()
  })

  it('stops at the spend limit', async () => {
    h.overLimit = NextResponse.json({ error: 'limit' }, { status: 429 })
    const res = await call({ path: PAGE })
    expect(res.status).toBe(429)
    expect(h.proposeRestructure).not.toHaveBeenCalled()
  })

  it('proposes without writing, with a diff and the hand-edit flag', async () => {
    h.listPathCommits.mockResolvedValue([{ message: 'Edit industries--optometry.md via admin (a@x.com)', date: null, authorName: 'A' }])
    h.proposeRestructure.mockResolvedValue({
      ok: true,
      proposal: { proposed: lean, before: {}, after: {}, violationsBefore: [], violationsAfter: [], coverage: { droppedLinks: [], terms: [] } },
    })
    const res = await call({ path: PAGE })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { currentSha: string; proposed: string; diff: unknown[]; handEdited: boolean }
    expect(data.currentSha).toBe('sha-1')
    expect(data.proposed).toBe(lean)
    expect(data.diff.length).toBeGreaterThan(0)
    expect(data.handEdited).toBe(true)
    expect(h.writeFile).not.toHaveBeenCalled()
  })

  it('maps an unusable proposal to a 422 with the first problem', async () => {
    h.proposeRestructure.mockResolvedValue({ ok: false, reason: 'invalid', details: ['Image "x.jpg" is not on the current page'] })
    const res = await call({ path: PAGE })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toContain('x.jpg')
  })

  it('accept refuses a stale sha', async () => {
    const res = await call({ action: 'accept', path: PAGE, proposed: lean, expectedSha: 'old-sha' })
    expect(res.status).toBe(409)
    expect(h.writeFile).not.toHaveBeenCalled()
  })

  it('accept re-validates what the client sent back', async () => {
    const tampered = lean.replace('intro-text', 'mystery-block')
    const res = await call({ action: 'accept', path: PAGE, proposed: tampered, expectedSha: 'sha-1' })
    expect(res.status).toBe(422)
    expect(h.writeFile).not.toHaveBeenCalled()
  })

  it('accept commits to draft as an AI edit with the sha lock', async () => {
    const res = await call({ action: 'accept', path: PAGE, proposed: lean, expectedSha: 'sha-1' })
    expect(res.status).toBe(200)
    const [repo, p, content, branch, message, opts] = h.writeFile.mock.calls[0]!
    expect([repo, p, content, branch]).toEqual(['repo', PAGE, lean, 'draft'])
    expect(message).toMatch(/via AI/)
    expect((opts as { expectedSha: string }).expectedSha).toBe('sha-1')
    expect(h.reviewContentEdit).toHaveBeenCalledWith('sess', PAGE, lean)
    expect(h.proposeRestructure).not.toHaveBeenCalled()
  })

  describe('one restructure per page', () => {
    const done = [{ message: 'Restructure industries--optometry.md via AI (h@x.com)', date: '2026-11-02T09:00:00Z', authorName: 'Hank' }]
    const statusOf = async () =>
      (await GET(new Request(`http://x/api/edit/s/restructure?path=${encodeURIComponent(PAGE)}`), { params: Promise.resolve({ id: 's' }) })).json()

    it('GET reports the lock with date and author', async () => {
      expect(await statusOf()).toEqual({ restructured: false, at: null, by: null })
      h.listPathCommits.mockResolvedValue(done)
      expect(await statusOf()).toEqual({ restructured: true, at: '2026-11-02T09:00:00Z', by: 'Hank' })
    })

    it('refuses to propose or accept again without an override', async () => {
      h.listPathCommits.mockResolvedValue(done)
      const propose = await call({ path: PAGE })
      expect(propose.status).toBe(409)
      expect(((await propose.json()) as { restructured: boolean }).restructured).toBe(true)
      expect((await call({ action: 'accept', path: PAGE, proposed: lean, expectedSha: 'sha-1' })).status).toBe(409)
      expect(h.proposeRestructure).not.toHaveBeenCalled()
      expect(h.writeFile).not.toHaveBeenCalled()
    })

    it('lets an admin override', async () => {
      h.listPathCommits.mockResolvedValue(done)
      expect((await call({ action: 'accept', path: PAGE, proposed: lean, expectedSha: 'sha-1', override: true })).status).toBe(200)
      expect(h.writeFile).toHaveBeenCalled()
    })

    it('never lets a Site Owner override', async () => {
      h.listPathCommits.mockResolvedValue(done)
      h.ctx = { githubRepo: 'repo', sessionId: 'sess', user: { id: 'u4', isAdmin: false, capabilities: ['owner'] } }
      expect((await call({ path: PAGE, override: true })).status).toBe(403)
      expect((await call({ path: PAGE })).status).toBe(409)
      expect(h.proposeRestructure).not.toHaveBeenCalled()
    })

    it('stamps the accept commit with the marker the lock reads', async () => {
      await call({ action: 'accept', path: PAGE, proposed: lean, expectedSha: 'sha-1' })
      const message = h.writeFile.mock.calls[0]![4] as string
      expect(message.startsWith('Restructure industries--optometry.md via AI')).toBe(true)
    })
  })
})
