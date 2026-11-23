import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class StaleShaError extends Error {}
  return { StaleShaError, loadCategories: vi.fn(), ensureSeeded: vi.fn(), backfillCategories: vi.fn() }
})

vi.mock('@/lib/github/repo-files', () => ({ StaleShaError: h.StaleShaError }))
vi.mock('@/lib/content/blog-categories-repo', () => ({ loadCategories: h.loadCategories, ensureSeeded: h.ensureSeeded }))
vi.mock('@/lib/content/blog-categories-backfill', () => ({ backfillCategories: h.backfillCategories }))
vi.mock('@/lib/supabase/server', () => ({ createServerClient: () => ({}) }))
vi.mock('../../_helpers', () => ({
  resolveEditContext: vi.fn(async () => ({ adminEmail: 'a@x.com', adminName: 'A', adminId: 'u1', sessionId: 's1', githubRepo: 'r' })),
}))

import { POST } from './route'
import { CategoriesFileError } from '@/lib/content/blog-categories'

const call = () => POST(new Request('http://x/api', { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: 's1' }) })
const FILE = { version: 1, categories: [{ id: 'c-aaaaaa', name: 'A', slug: 'a' }] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  h.loadCategories.mockResolvedValue({ file: FILE, sha: 'sha', corrupt: false })
})

describe('POST /categories/auto-assign', () => {
  it('422s on a corrupt file without classifying', async () => {
    h.loadCategories.mockResolvedValue({ file: null, sha: null, corrupt: true })
    const res = await call()
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/content\/categories\.json is invalid/)
    expect(h.backfillCategories).not.toHaveBeenCalled()
  })
  it('passes no schema to backfill and maps a missing file to 422', async () => {
    h.backfillCategories.mockRejectedValue(new CategoriesFileError('missing'))
    const res = await call()
    expect(res.status).toBe(422)
    expect(h.backfillCategories.mock.calls[0][0]).not.toHaveProperty('schema')
  })
  it('returns the backfill result', async () => {
    h.backfillCategories.mockResolvedValue({ categorized: 1, leftUncategorized: 0, remaining: 0, attempted: ['p'] })
    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).categorized).toBe(1)
  })
})
