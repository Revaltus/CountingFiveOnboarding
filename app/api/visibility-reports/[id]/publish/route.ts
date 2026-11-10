import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { renderVisibilityPdf } from '@/lib/pdf/visibility/render'
import { createServerClient } from '@/lib/supabase/server'
import { loadReportForUser } from '@/lib/visibility/access'
import { coerceNarrative } from '@/lib/visibility/narrative'
import type { VisibilityResult } from '@/lib/visibility/types'
import type { SessionSchema } from '@/types/session-schema'

export const runtime = 'nodejs'
export const maxDuration = 60

// POST /api/visibility-reports/[id]/publish — freeze the draft: render + store
// the PDF, then issue a fresh share token. A PDF failure leaves it a draft.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const loaded = await loadReportForUser(id)
  if (loaded instanceof NextResponse) return loaded
  const { report, user } = loaded
  if (report.status !== 'draft') return NextResponse.json({ error: 'Only a draft report can be published.' }, { status: 409 })

  const narrative = coerceNarrative(report.narrative)
  if (!report.result || !narrative) return NextResponse.json({ error: 'This report has no content to publish.' }, { status: 409 })
  const result = report.result as unknown as VisibilityResult

  const supabase = createServerClient()
  const { data: session } = await supabase.from('sessions').select('schema_data').eq('id', report.session_id).maybeSingle()
  const firmName = (session?.schema_data as SessionSchema | null)?.business?.name?.trim() || result.domain

  const pdfPath = `pdfs/${report.session_id}/visibility-${report.id}.pdf`
  try {
    const pdf = await renderVisibilityPdf(result, narrative, firmName)
    const { error: upErr } = await supabase.storage
      .from('session-assets')
      .upload(pdfPath, pdf, { contentType: 'application/pdf', upsert: true })
    if (upErr) return internalError('visibility-reports:publish-upload', upErr, 'Could not save the PDF. Please try again.')
  } catch (err) {
    return internalError('visibility-reports:publish-render', err, 'Could not build the PDF. Please try again.')
  }

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('visibility_reports')
    .update({ status: 'published', share_token: crypto.randomUUID(), published_at: now, published_by: user.id, pdf_path: pdfPath, updated_at: now })
    .eq('id', id)
    .eq('status', 'draft')
    .select('share_token')
  if (error) return internalError('visibility-reports:publish', error)
  if (!data?.length) return NextResponse.json({ error: 'Only a draft report can be published.' }, { status: 409 })
  return NextResponse.json({ shareToken: data[0].share_token })
}

// DELETE /api/visibility-reports/[id]/publish — unpublish: back to draft, the
// share link stops working immediately.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const loaded = await loadReportForUser(id)
  if (loaded instanceof NextResponse) return loaded
  if (loaded.report.status !== 'published') return NextResponse.json({ error: 'This report is not published.' }, { status: 409 })

  const { error } = await createServerClient()
    .from('visibility_reports')
    .update({ status: 'draft', share_token: null, published_at: null, published_by: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'published')
  if (error) return internalError('visibility-reports:unpublish', error)
  return NextResponse.json({ status: 'draft' })
}
