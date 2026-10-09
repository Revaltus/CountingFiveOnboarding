import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  job: {
    phase: 4,
    session_id: 'sess-1',
    library_reviewed_at: '2026-08-27T00:00:00Z',
    articles_reviewed_at: '2026-08-27T00:00:00Z',
  } as {
    phase: number
    session_id: string
    library_reviewed_at: string | null
    articles_reviewed_at: string | null
    palette?: unknown
    design_tokens?: unknown
  },
  outlines: [] as Array<{ admin_approved: boolean; h1?: string; sections?: unknown[]; admin_notes?: string | null }>,
  firmName: 'Acme CPA' as string | null,
  importableArticles: [] as Array<{ url: string }>,
  after: vi.fn(),
  runContentGeneration: vi.fn(),
}))

vi.mock('@/lib/auth/access', () => ({
  requireContentJobAccess: vi.fn(async () => ({ user: { id: 'u' }, sessionId: 'sess-1' })),
}))
vi.mock('@/lib/content/content-generator', () => ({
  runContentGeneration: (...a: unknown[]) => h.runContentGeneration(...a),
}))
vi.mock('@/lib/content/article-import-discovery', () => ({
  discoverImportableArticles: vi.fn(async () => ({ auditRunId: null, articles: h.importableArticles, syndicationAssessment: '' })),
}))
vi.mock('next/server', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, after: (fn: () => void) => h.after(fn) }
})
vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          // page_outlines is awaited directly after .eq(); the others call .single().
          then: (resolve: (v: unknown) => void) => resolve({ data: h.outlines, error: null }),
          single: async () =>
            table === 'sessions'
              ? { data: { schema_data: { business: { name: h.firmName } } } }
              : { data: h.job },
        }),
      }),
      update: () => ({
        eq: () => ({
          select: () => ({ single: async () => ({ data: { session_id: h.job.session_id }, error: null }) }),
        }),
      }),
    }),
  }),
}))

import { PATCH } from './route'

const REAL_OUTLINE = { admin_approved: true, h1: 'A page', sections: [{ h2: 'One' }], admin_notes: null }

const params = Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' })
const patchPhase5 = () =>
  PATCH(new Request('http://test', { method: 'PATCH', body: JSON.stringify({ phase: 5 }) }), { params })

beforeEach(() => {
  h.outlines = [REAL_OUTLINE]
  h.job = {
    phase: 4,
    session_id: 'sess-1',
    library_reviewed_at: '2026-08-27T00:00:00Z',
    articles_reviewed_at: '2026-08-27T00:00:00Z',
  }
  h.firmName = 'Acme CPA'
  h.importableArticles = []
  h.after.mockReset()
  h.runContentGeneration.mockReset()
})

describe('PATCH /api/content-jobs/[id] — phase 5 gates', () => {
  it('blocks the phase 4→5 advance (422) when the library choice was never confirmed', async () => {
    h.job.library_reviewed_at = null
    const res = await patchPhase5()
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/library-content choice/i)
    expect(h.after).not.toHaveBeenCalled()
  })

  it('still blocks (422) when the MBP has no firm name, even after library review', async () => {
    h.firmName = '   '
    const res = await patchPhase5()
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/firm name/i)
  })

  it('blocks (422) when importable articles exist but the import choice was never confirmed', async () => {
    h.job.articles_reviewed_at = null
    h.importableArticles = [{ url: 'https://x.com/blog/a' }]
    const res = await patchPhase5()
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/existing-article import choice/i)
    expect(h.after).not.toHaveBeenCalled()
  })

  it('auto-clears the article gate (advances) when no importable articles were discovered', async () => {
    h.job.articles_reviewed_at = null
    h.importableArticles = []
    const res = await patchPhase5()
    expect(res.status).toBe(200)
    expect(h.after).toHaveBeenCalledOnce()
  })

  it('advances and triggers generation when library is reviewed and the firm is named', async () => {
    const res = await patchPhase5()
    expect(res.status).toBe(200)
    expect(h.after).toHaveBeenCalledOnce()
  })

  it('blocks (422) crossing into phase 5 while any outline is unapproved', async () => {
    h.outlines = [REAL_OUTLINE, { ...REAL_OUTLINE, admin_approved: false }]
    const res = await patchPhase5()
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/Approve every outline/i)
    expect(h.after).not.toHaveBeenCalled()
  })

  it('blocks (422) when an approved outline is still a review-flagged placeholder', async () => {
    h.outlines = [REAL_OUTLINE, { ...REAL_OUTLINE, admin_notes: '⚠ Needs review — the outline generator declined this page: excluded.' }]
    const res = await patchPhase5()
    expect(res.status).toBe(422)
    expect(h.after).not.toHaveBeenCalled()
  })

  it('refuses (409) a phase jump that skips steps', async () => {
    h.job.phase = 2
    const res = await patchPhase5()
    expect(res.status).toBe(409)
    expect(h.after).not.toHaveBeenCalled()
  })

  it('rejects a malformed nav_config (400)', async () => {
    const res = await PATCH(
      new Request('http://test', { method: 'PATCH', body: JSON.stringify({ nav_config: { primary: 'nope' } }) }),
      { params },
    )
    expect(res.status).toBe(400)
  })
})

const PALETTE = Object.fromEntries(
  ['primary', 'secondary', 'complementary', 'action', 'nearBlack', 'nearWhite'].map((r) => [r, { hex: '#123456', name: r }]),
)
const TOKENS = { typePairing: { id: 'x', headingFont: 'Inter', bodyFont: 'Inter', label: 'Inter' }, roundness: 'soft', density: 'balanced', visualFeel: 'modern' }
const patch = (body: unknown) =>
  PATCH(new Request('http://test', { method: 'PATCH', body: JSON.stringify(body) }), { params })

describe('PATCH /api/content-jobs/[id] — Design System gate on leaving phase 1', () => {
  it('refuses (409) phase 1→2 when no palette/tokens are saved or sent', async () => {
    h.job = { ...h.job, phase: 1, palette: null, design_tokens: null }
    const res = await patch({ phase: 2 })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toMatch(/palette and type pairing/i)
  })

  it('advances when the same PATCH saves the palette + tokens (the Lock button)', async () => {
    h.job = { ...h.job, phase: 1, palette: null, design_tokens: null }
    const res = await patch({ phase: 2, palette: PALETTE, design_tokens: TOKENS })
    expect(res.status).toBe(200)
  })

  it('advances when both are already stored', async () => {
    h.job = { ...h.job, phase: 1, palette: PALETTE, design_tokens: TOKENS }
    expect((await patch({ phase: 2 })).status).toBe(200)
  })
})
