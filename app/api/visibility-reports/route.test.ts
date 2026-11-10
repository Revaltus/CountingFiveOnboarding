import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const SESSION = '11111111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  gate: null as null | { status: number },
  publicUrl: true,
  writes: [] as Array<{ table: string; op: string; payload: Record<string, unknown> }>,
}))

vi.mock('@/lib/auth/access', () => ({
  requireOnboardingSessionAccess: vi.fn(async () =>
    h.gate ? NextResponse.json({ error: 'x' }, { status: h.gate.status }) : { user: { id: 'admin-1', isAdmin: true, capabilities: [] } },
  ),
}))
vi.mock('@/lib/audit/ssrf-guard', () => ({ isUrlPubliclyFetchable: vi.fn(async () => h.publicUrl) }))
vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => ({
    from: (table: string) => {
      let op = 'select'
      let payload: Record<string, unknown> = {}
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        update: (p: Record<string, unknown>) => {
          op = 'update'
          payload = p
          h.writes.push({ table, op, payload })
          return b
        },
        insert: (p: Record<string, unknown>) => {
          op = 'insert'
          payload = p
          h.writes.push({ table, op, payload })
          return b
        },
        maybeSingle: async () => ({ data: { id: SESSION }, error: null }),
        single: async () => ({ data: { id: 'report-1' }, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      }
      void payload
      void op
      return b
    },
  }),
}))

import { POST } from './route'

const post = (body: unknown) =>
  POST(new Request('http://x/api/visibility-reports', { method: 'POST', body: JSON.stringify(body) }))

describe('POST /api/visibility-reports', () => {
  beforeEach(() => {
    h.gate = null
    h.publicUrl = true
    h.writes = []
  })

  it('creates a queued report and returns its id', async () => {
    const res = await post({ sessionId: SESSION, url: 'firm.com', saveAsLiveUrl: false })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'report-1' })
    const insert = h.writes.find((w) => w.op === 'insert')
    expect(insert?.payload).toMatchObject({ session_id: SESSION, url: 'https://firm.com', domain: 'firm.com', is_live_domain: true, created_by: 'admin-1' })
    expect(h.writes.some((w) => w.table === 'sessions')).toBe(false)
  })

  it('saves the live URL when asked and flags staging hosts', async () => {
    await post({ sessionId: SESSION, url: 'https://firm.vercel.app', saveAsLiveUrl: true })
    expect(h.writes.find((w) => w.table === 'sessions')?.payload).toEqual({ live_site_url: 'https://firm.vercel.app' })
    expect(h.writes.find((w) => w.op === 'insert')?.payload.is_live_domain).toBe(false)
  })

  it('passes through the gate response (editor / unassigned manager)', async () => {
    h.gate = { status: 403 }
    const res = await post({ sessionId: SESSION, url: 'firm.com', saveAsLiveUrl: false })
    expect(res.status).toBe(403)
    expect(h.writes).toHaveLength(0)
  })

  it('rejects private or malformed input', async () => {
    h.publicUrl = false
    expect((await post({ sessionId: SESSION, url: 'http://localhost:3000', saveAsLiveUrl: false })).status).toBe(400)
    expect((await post({ sessionId: 'not-a-uuid', url: 'firm.com' })).status).toBe(400)
    expect((await post(null)).status).toBe(400)
    expect(h.writes).toHaveLength(0)
  })
})
