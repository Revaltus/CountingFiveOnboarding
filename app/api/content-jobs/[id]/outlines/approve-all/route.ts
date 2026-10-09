import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { createServerClient } from '@/lib/supabase/server'
import { requireContentJobAccess } from '@/lib/auth/access'
import { isApprovableOutline } from '@/lib/content/outline-fallback'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: _jobId } = await params
  const auth = await requireContentJobAccess(_jobId)
  if (auth instanceof NextResponse) return auth
  const { id } = await params
  const supabase = createServerClient()

  // Only approve real outlines. Rows still generating (h1 null) and review-flagged
  // placeholders are left for the operator — approving a placeholder shipped a
  // generic "Add content here" page.
  const { data: rows, error: loadErr } = await supabase
    .from('page_outlines')
    .select('id, h1, sections, admin_notes')
    .eq('content_job_id', id)
    .eq('admin_approved', false)
  if (loadErr) {
    return internalError('outlines:approve-all', loadErr, "Couldn't approve outlines")
  }
  const ids = (rows ?? []).filter(isApprovableOutline).map(r => r.id)
  const skipped = (rows ?? []).length - ids.length

  if (ids.length) {
    const { error } = await supabase
      .from('page_outlines')
      .update({ admin_approved: true, updated_at: new Date().toISOString() })
      .eq('content_job_id', id)
      .in('id', ids)
    if (error) {
      return internalError('outlines:approve-all', error, "Couldn't approve outlines")
    }
  }

  return NextResponse.json({ approved: ids.length, skipped })
}
