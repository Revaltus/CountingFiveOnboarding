import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { asJson } from '@/lib/supabase/json-typed'
import { createServerClient } from '@/lib/supabase/server'
import { loadReportForUser } from '@/lib/visibility/access'
import { validateNarrativeInput } from '@/lib/visibility/narrative'

export const runtime = 'nodejs'

// GET /api/visibility-reports/[id] — status polling + report detail.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const loaded = await loadReportForUser(id)
  if (loaded instanceof NextResponse) return loaded
  return NextResponse.json({ report: loaded.report })
}

// PATCH /api/visibility-reports/[id] — operator edits to the draft narrative.
// Published reports are frozen; unpublish first.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const loaded = await loadReportForUser(id)
  if (loaded instanceof NextResponse) return loaded
  if (loaded.report.status !== 'draft') {
    return NextResponse.json({ error: 'Only draft reports can be edited. Unpublish it first.' }, { status: 409 })
  }

  const body = (await req.json().catch(() => null)) as { narrative?: unknown } | null
  const parsed = validateNarrativeInput(body?.narrative)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await createServerClient()
    .from('visibility_reports')
    .update({ narrative: asJson(parsed.value), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'draft')
    .select('id')
  if (error) return internalError('visibility-reports:patch', error)
  if (!data?.length) return NextResponse.json({ error: 'Only draft reports can be edited. Unpublish it first.' }, { status: 409 })
  return NextResponse.json({ narrative: parsed.value })
}
