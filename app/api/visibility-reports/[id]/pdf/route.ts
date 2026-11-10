import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { isUuid } from '@/lib/design/input-validation'
import { createServerClient } from '@/lib/supabase/server'
import { loadReportForUser } from '@/lib/visibility/access'

export const runtime = 'nodejs'

// GET /api/visibility-reports/[id]/pdf[?token=<share_token>] — redirect to a
// short-lived signed URL for the published PDF. With a token (the public share
// page) the token must match this published report; without one, the staff
// client gate applies.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const token = new URL(req.url).searchParams.get('token')
  const supabase = createServerClient()

  let pdfPath: string | null
  if (token !== null) {
    if (!isUuid(id) || !isUuid(token)) return NextResponse.json({ error: 'Report not found' }, { status: 404 })
    const { data, error } = await supabase
      .from('visibility_reports')
      .select('pdf_path')
      .eq('id', id)
      .eq('share_token', token)
      .eq('status', 'published')
      .maybeSingle()
    if (error) return internalError('visibility-reports:pdf', error)
    if (!data) return NextResponse.json({ error: 'Report not found' }, { status: 404 })
    pdfPath = data.pdf_path
  } else {
    const loaded = await loadReportForUser(id)
    if (loaded instanceof NextResponse) return loaded
    pdfPath = loaded.report.pdf_path
  }
  if (!pdfPath) return NextResponse.json({ error: 'No PDF yet — publish the report first.' }, { status: 404 })

  const { data: signed, error } = await supabase.storage.from('session-assets').createSignedUrl(pdfPath, 3600, { download: true })
  if (error || !signed?.signedUrl) return internalError('visibility-reports:pdf-sign', error)
  return NextResponse.redirect(signed.signedUrl, 302)
}
