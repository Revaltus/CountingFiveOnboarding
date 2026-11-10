import { NextResponse } from 'next/server'
import { normalizeDomain, normalizeInputUrl } from '@/lib/audit/index'
import { isUrlPubliclyFetchable } from '@/lib/audit/ssrf-guard'
import { internalError } from '@/lib/api/errors'
import { requireOnboardingSessionAccess } from '@/lib/auth/access'
import { isUuid } from '@/lib/design/input-validation'
import { createServerClient } from '@/lib/supabase/server'
import { isLiveHost } from '@/lib/visibility/live-host'

export const runtime = 'nodejs'

interface CreateReportBody {
  sessionId: string
  url: string
  saveAsLiveUrl: boolean
  isLiveDomain?: boolean
}

function parseBody(raw: unknown): CreateReportBody | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  if (typeof b.sessionId !== 'string' || typeof b.url !== 'string') return null
  return {
    sessionId: b.sessionId,
    url: b.url,
    saveAsLiveUrl: b.saveAsLiveUrl === true,
    isLiveDomain: typeof b.isLiveDomain === 'boolean' ? b.isLiveDomain : undefined,
  }
}

// POST /api/visibility-reports — queue a Visibility Report for one client.
export async function POST(req: Request) {
  const body = parseBody(await req.json().catch(() => null))
  if (!body || !isUuid(body.sessionId)) return NextResponse.json({ error: 'sessionId and url are required' }, { status: 400 })

  const gate = await requireOnboardingSessionAccess(body.sessionId)
  if (gate instanceof NextResponse) return gate

  const url = normalizeInputUrl(body.url)
  if (url.length > 2048 || !(await isUrlPubliclyFetchable(url))) {
    return NextResponse.json({ error: 'Enter a public website address (https://…)' }, { status: 400 })
  }

  const supabase = createServerClient()
  const { data: session, error: sessErr } = await supabase.from('sessions').select('id').eq('id', body.sessionId).maybeSingle()
  if (sessErr) return internalError('visibility-reports:create', sessErr)
  if (!session) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  if (body.saveAsLiveUrl) {
    const { error } = await supabase.from('sessions').update({ live_site_url: url }).eq('id', body.sessionId)
    if (error) return internalError('visibility-reports:save-live-url', error)
  }

  const { data: row, error } = await supabase
    .from('visibility_reports')
    .insert({
      session_id: body.sessionId,
      url,
      domain: normalizeDomain(url),
      is_live_domain: body.isLiveDomain ?? isLiveHost(url),
      created_by: gate.user.id,
    })
    .select('id')
    .single()
  if (error || !row) return internalError('visibility-reports:create', error)

  return NextResponse.json({ id: row.id }, { status: 201 })
}
