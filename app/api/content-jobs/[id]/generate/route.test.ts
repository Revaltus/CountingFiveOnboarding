import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  job: { session_id: 'sess-1', created_by: 'u', phase: 5 } as { session_id: string; created_by: string | null; phase: number },
  cron: false,
  after: vi.fn(),
  runContentGeneration: vi.fn(),
  maybeCompleteAfterQa: vi.fn(async () => false),
  updates: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/auth/access', () => ({
  requireContentJobAccess: vi.fn(async () => ({ user: { id: 'u' }, sessionId: 'sess-1' })),
}))
vi.mock('@/lib/auth/cron-bearer', () => ({ isCronBearer: () => h.cron }))
vi.mock('@/lib/content/content-generator', () => ({
  runContentGeneration: (...a: unknown[]) => h.runContentGeneration(...a),
  maybeCompleteAfterQa: () => h.maybeCompleteAfterQa(),
}))
vi.mock('next/server', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, after: (fn: () => void) => h.after(fn) }
})
vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: h.job }) }) }),
      update: (vals: Record<string, unknown>) => {
        h.updates.push(vals)
        const chain: Record<string, unknown> = { eq: () => chain, neq: () => chain, then: (r: (v: unknown) => void) => r({ error: null }) }
        return chain
      },
    }),
  }),
}))

import { POST } from './route'

const params = Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' })
const post = (query = '') => POST(new Request(`http://test/generate${query}`, { method: 'POST' }), { params })

beforeEach(() => {
  h.job = { session_id: 'sess-1', created_by: 'u', phase: 5 }
  h.cron = false
  h.after.mockReset()
  h.maybeCompleteAfterQa.mockReset()
  h.maybeCompleteAfterQa.mockResolvedValue(false)
  h.updates = []
})

describe('POST /api/content-jobs/[id]/generate', () => {
  it('refuses (409) to generate while the job is still on Outlines', async () => {
    h.job.phase = 4
    const res = await post()
    expect(res.status).toBe(409)
    expect(h.after).not.toHaveBeenCalled()
    expect(h.updates).toEqual([])
  })

  it('a human Restart resets attempts and runs generation', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(h.updates).toContainEqual({ generation_attempts: 0 })
    expect(h.after).toHaveBeenCalledOnce()
  })

  it('reconcile never resets attempts; it finishes a done job without re-running', async () => {
    h.maybeCompleteAfterQa.mockResolvedValue(true)
    const res = await post('?reconcile=1')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ reconciled: true })
    expect(h.updates).toEqual([])
    expect(h.after).not.toHaveBeenCalled()
  })

  it('reconcile resumes remaining work at phase 5 without resetting attempts', async () => {
    const res = await post('?reconcile=1')
    expect(res.status).toBe(200)
    expect(h.updates).toEqual([])
    expect(h.after).toHaveBeenCalledOnce()
  })

  it('the internal chain does not reset attempts', async () => {
    h.cron = true
    await post()
    expect(h.updates).toEqual([])
    expect(h.after).toHaveBeenCalledOnce()
  })
})
