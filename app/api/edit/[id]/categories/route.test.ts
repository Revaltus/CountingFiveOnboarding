import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class StaleShaError extends Error {
    constructor(public path = 'p', public currentSha = 's', public currentContent = '') {
      super('stale')
    }
  }
  return {
    StaleShaError,
    gate: null as unknown,
    dbError: false,
    file: null as { version: 1; categories: Array<{ id: string; name: string; slug: string }> } | null,
    sha: 'sha-1' as string | null,
    ensureSeeded: vi.fn(),
    saveCategories: vi.fn(),
    listCategoryCounts: vi.fn(),
    loadCategories: vi.fn(),
  }
})

vi.mock('@/lib/github/repo-files', () => ({ StaleShaError: h.StaleShaError }))
vi.mock('@/lib/content/blog-categories-repo', async () => {
  const { CategoriesFileError } = await import('@/lib/content/blog-categories')
  return {
    ensureSeeded: h.ensureSeeded,
    saveCategories: h.saveCategories,
    listCategoryCounts: h.listCategoryCounts,
    loadCategories: h.loadCategories,
    requireCategories: async (repo: string) => {
      const l = await h.loadCategories(repo)
      if (l.corrupt) throw new CategoriesFileError('corrupt')
      if (!l.file) throw new CategoriesFileError('missing')
      return l
    },
  }
})
vi.mock('@/lib/design/capabilities-read', () => ({ readDraftTemplateVersion: vi.fn(async () => '2026.09.15') }))
vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ single: async () => (h.dbError ? { data: null, error: { message: 'pg boom' } } : { data: { schema_data: {} }, error: null }) }) }) }),
  }),
}))
vi.mock('../_helpers', () => ({
  resolveEditContext: vi.fn(async () => h.gate ?? { adminEmail: 'a@x.com', adminName: 'A', sessionId: 's1', githubRepo: 'r' }),
}))

import { GET, PATCH, POST } from './route'

const params = { params: Promise.resolve({ id: 'sess' }) }
const req = (method: string, body?: unknown) =>
  new Request('http://x/api', { method, body: body === undefined ? undefined : JSON.stringify(body) })

const A = { id: 'c-aaaaaa', name: 'A', slug: 'a' }
const B = { id: 'c-bbbbbb', name: 'B', slug: 'b' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  h.gate = null
  h.dbError = false
  h.file = { version: 1, categories: [A, B] }
  h.sha = 'sha-1'
  h.loadCategories.mockImplementation(async () => ({ file: h.file, sha: h.sha, corrupt: false }))
  h.ensureSeeded.mockResolvedValue(h.file)
  h.listCategoryCounts.mockResolvedValue({ [A.id]: 2, [B.id]: 0 })
  h.saveCategories.mockResolvedValue(undefined)
})

describe('gate pass-through', () => {
  it.each([401, 403])('returns %i from resolveEditContext', async (status) => {
    h.gate = NextResponse.json({ error: 'no' }, { status })
    for (const res of [await GET(req('GET'), params), await POST(req('POST', { name: 'x' }), params)]) {
      expect(res.status).toBe(status)
    }
    expect(h.saveCategories).not.toHaveBeenCalled()
  })
})

describe('GET', () => {
  it('returns categories, counts, sha and template support', async () => {
    const res = await GET(req('GET'), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      categories: [A, B],
      counts: { [A.id]: 2, [B.id]: 0 },
      sha: 'sha-1',
      seeded: false,
      templateSupportsCategories: true,
    })
  })

  it('422s (no seed) when categories.json is partially corrupt', async () => {
    h.loadCategories.mockResolvedValue({ file: null, sha: null, corrupt: true })
    const res = await GET(req('GET'), params)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/content\/categories\.json is invalid/)
    expect(h.ensureSeeded).not.toHaveBeenCalled()
  })

  it('422s when categories.json appears mid-seed and is invalid', async () => {
    h.loadCategories.mockResolvedValue({ file: null, sha: null, corrupt: false })
    h.ensureSeeded.mockRejectedValue(new h.StaleShaError())
    const res = await GET(req('GET'), params)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/content\/categories\.json is invalid/)
  })

  it('5xx and no seed push when the schema read fails', async () => {
    h.file = null
    h.dbError = true
    const res = await GET(req('GET'), params)
    expect(res.status).toBe(500)
    expect(h.ensureSeeded).not.toHaveBeenCalled()
  })

  it('does not read the schema when a file already exists', async () => {
    h.dbError = true
    expect((await GET(req('GET'), params)).status).toBe(200)
  })

  it('never leaks GitHub error text on 5xx', async () => {
    h.listCategoryCounts.mockRejectedValue(new Error('GitHub 500: secret-repo-token'))
    const res = await GET(req('GET'), params)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret-repo-token')
  })
})

describe('POST', () => {
  it('422 and no write when categories.json is corrupt', async () => {
    h.loadCategories.mockResolvedValue({ file: null, sha: null, corrupt: true })
    const res = await POST(req('POST', { name: 'Zed' }), params)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/content\/categories\.json is invalid/)
    expect(h.saveCategories).not.toHaveBeenCalled()
    expect(h.ensureSeeded).not.toHaveBeenCalled()
  })
  it('400 on empty name', async () => {
    expect((await POST(req('POST', { name: '  ' }), params)).status).toBe(400)
  })
  it('409 on colliding slug', async () => {
    expect((await POST(req('POST', { name: 'Other', slug: 'a' }), params)).status).toBe(409)
  })
  it('creates with 201 and saves with the loaded sha', async () => {
    const res = await POST(req('POST', { name: 'New Thing' }), params)
    expect(res.status).toBe(201)
    const { category } = await res.json()
    expect(category).toMatchObject({ name: 'New Thing', slug: 'new-thing' })
    expect(category.id).toMatch(/^c-/)
    expect(h.saveCategories.mock.calls[0][2]).toBe('sha-1')
    expect(h.saveCategories.mock.calls[0][1].categories).toHaveLength(3)
  })
  it('409 with reload message on stale sha', async () => {
    h.saveCategories.mockRejectedValue(new h.StaleShaError())
    const res = await POST(req('POST', { name: 'Zed' }), params)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Categories changed in another tab — reload')
  })
  it('never leaks GitHub error text on 5xx', async () => {
    h.saveCategories.mockRejectedValue(new Error('GitHub exploded: ghp_secret'))
    const res = await POST(req('POST', { name: 'Zed' }), params)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('ghp_secret')
  })
})

describe('PATCH', () => {
  it('422 and no write when categories.json is corrupt', async () => {
    h.loadCategories.mockResolvedValue({ file: null, sha: null, corrupt: true })
    const res = await PATCH(req('PATCH', { categories: [A, B], sha: 'sha-1' }), params)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/content\/categories\.json is invalid/)
    expect(h.saveCategories).not.toHaveBeenCalled()
  })
  it('400 when an id is missing from the list', async () => {
    const res = await PATCH(req('PATCH', { categories: [A], sha: 'sha-1' }), params)
    expect(res.status).toBe(400)
  })
  it('400 when an unknown id is added', async () => {
    const res = await PATCH(req('PATCH', { categories: [A, B, { id: 'c-zzzzzz', name: 'Z', slug: 'z' }], sha: 'sha-1' }), params)
    expect(res.status).toBe(400)
  })
  it('400 when a slug is empty or missing', async () => {
    for (const bad of [{ ...B, slug: '' }, { id: B.id, name: 'B' }]) {
      const res = await PATCH(req('PATCH', { categories: [A, bad], sha: 'sha-1' }), params)
      expect(res.status).toBe(400)
    }
    expect(h.saveCategories).not.toHaveBeenCalled()
  })
  it('409 on stale sha', async () => {
    const res = await PATCH(req('PATCH', { categories: [A, B], sha: 'old' }), params)
    expect(res.status).toBe(409)
  })
  it('409 on duplicate slugs in the list', async () => {
    const res = await PATCH(req('PATCH', { categories: [A, { ...B, slug: 'a' }], sha: 'sha-1' }), params)
    expect(res.status).toBe(409)
  })
  it('renames and reorders', async () => {
    const res = await PATCH(req('PATCH', { categories: [{ ...B, name: 'Bee' }, A], sha: 'sha-1' }), params)
    expect(res.status).toBe(200)
    expect(h.saveCategories.mock.calls[0][1].categories.map((c: { id: string }) => c.id)).toEqual([B.id, A.id])
    expect(h.saveCategories.mock.calls[0][2]).toBe('sha-1')
  })
})
