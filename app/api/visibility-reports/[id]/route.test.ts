import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  loaded: null as null | { status: number } | { report: { id: string; status: string } },
  updated: [] as Array<Record<string, unknown>>,
  matched: true,
}))

vi.mock('@/lib/visibility/access', () => ({
  loadReportForUser: vi.fn(async () =>
    h.loaded && 'status' in h.loaded && typeof h.loaded.status === 'number'
      ? NextResponse.json({ error: 'x' }, { status: h.loaded.status })
      : { user: { id: 'u' }, ...(h.loaded as object) },
  ),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {
        update: (p: Record<string, unknown>) => {
          h.updated.push(p)
          return b
        },
        eq: () => b,
        select: async () => ({ data: h.matched ? [{ id: 'r' }] : [], error: null }),
      }
      return b
    },
  }),
}))

import { PATCH } from './route'

const narrative = {
  overview: 'Your site is strong.',
  audiences: {
    prospects: { wins: ['a'], opportunities: ['b'] },
    niche: { wins: [], opportunities: [] },
    talent: { wins: [], opportunities: [] },
    search: { wins: [], opportunities: [] },
    ai: { wins: [], opportunities: [] },
  },
}

const patch = (body: unknown) =>
  PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'r' }) })

describe('PATCH /api/visibility-reports/[id]', () => {
  beforeEach(() => {
    h.loaded = { report: { id: 'r', status: 'draft' } }
    h.updated = []
    h.matched = true
  })

  it('saves a valid narrative on a draft', async () => {
    const res = await patch({ narrative })
    expect(res.status).toBe(200)
    expect(h.updated[0].narrative).toEqual(narrative)
  })

  it('refuses edits to a published report', async () => {
    h.loaded = { report: { id: 'r', status: 'published' } }
    expect((await patch({ narrative })).status).toBe(409)
    expect(h.updated).toHaveLength(0)
  })

  it('returns 409 when the report was published mid-edit', async () => {
    h.matched = false
    expect((await patch({ narrative })).status).toBe(409)
  })

  it('rejects a malformed narrative', async () => {
    expect((await patch({ narrative: { overview: '' } })).status).toBe(400)
  })

  it('passes through the gate response', async () => {
    h.loaded = { status: 403 }
    expect((await patch({ narrative })).status).toBe(403)
  })
})
