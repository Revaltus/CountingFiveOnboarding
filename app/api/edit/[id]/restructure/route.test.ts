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
  listPathCommitMessages: vi.fn(async (..._args: unknown[]) => [] as string[]),
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
  listPathCommitMessages: h.listPathCommitMessages,
  readFile: h.readFile,
  writeFile: h.writeFile,
}))

import { POST } from './route'
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
    body: `<!-- block: intro-text | variant: centered -->\n## Hi\n\nShort.\n\n<!-- block: cta-banner | variant: color-bg -->\n## Talk\n\n[Book a practice review](/contact)`,
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
    h.listPathCommitMessages.mockReset()
    h.listPathCommitMessages.mockResolvedValue([])
    h.reviewContentEdit.mockClear()
  })

  it('returns the access gate response untouched', async () => {
    h.ctx = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const res = await call({ path: PAGE })
    expect(res.status).toBe(403)
    expect(h.proposeRestructure).not.toHaveBeenCalled()
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
    h.listPathCommitMessages.mockResolvedValue(['Edit industries--optometry.md via admin (a@x.com)'])
    h.proposeRestructure.mockResolvedValue({
      ok: true,
      proposal: { proposed: lean, before: {}, after: {}, violationsBefore: [], violationsAfter: [] },
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
})
