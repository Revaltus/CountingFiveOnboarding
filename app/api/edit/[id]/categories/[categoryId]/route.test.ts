import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class StaleShaError extends Error {}
  return { StaleShaError, gate: null as unknown, deleteCategory: vi.fn() }
})

vi.mock('@/lib/github/repo-files', () => ({ StaleShaError: h.StaleShaError }))
vi.mock('@/lib/content/blog-categories-repo', () => ({ deleteCategory: h.deleteCategory }))
vi.mock('@/lib/supabase/server', () => ({ createServerClient: () => ({}) }))
vi.mock('../../_helpers', () => ({
  resolveEditContext: vi.fn(async () => h.gate ?? { adminEmail: 'a@x.com', adminName: 'A', sessionId: 's1', githubRepo: 'r' }),
}))

import { DELETE } from './route'
import { CategoryValidationError } from '@/lib/content/blog-categories'

const call = (qs = '') =>
  DELETE(new Request(`http://x/api${qs}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id: 'sess', categoryId: 'c-aaaaaa' }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  h.gate = null
})

describe('DELETE /categories/[categoryId]', () => {
  it('passes through gate 403', async () => {
    h.gate = NextResponse.json({ error: 'no' }, { status: 403 })
    expect((await call()).status).toBe(403)
    expect(h.deleteCategory).not.toHaveBeenCalled()
  })
  it('returns postsChanged and forwards moveTo', async () => {
    h.deleteCategory.mockResolvedValue({ postsChanged: 3 })
    const res = await call('?moveTo=c-bbbbbb')
    expect(await res.json()).toEqual({ postsChanged: 3 })
    expect(h.deleteCategory.mock.calls[0].slice(1, 3)).toEqual(['c-aaaaaa', 'c-bbbbbb'])
  })
  it('400 for unknown moveTo', async () => {
    h.deleteCategory.mockRejectedValue(new CategoryValidationError('Move-to category does not exist', 400))
    expect((await call('?moveTo=c-nope')).status).toBe(400)
  })
  it('409 on stale', async () => {
    h.deleteCategory.mockRejectedValue(new h.StaleShaError())
    expect((await call()).status).toBe(409)
  })
  it('never leaks GitHub error text on 5xx', async () => {
    h.deleteCategory.mockRejectedValue(new Error('GitHub: ghp_secret'))
    const res = await call()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('ghp_secret')
  })
})
