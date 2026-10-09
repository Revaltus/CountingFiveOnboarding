import { after, NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { createServerClient } from '@/lib/supabase/server'
import { requireContentJobAccess } from '@/lib/auth/access'
import { runOutlineGeneration } from '@/lib/content/outline-generator'
import { resetStalePages } from '@/lib/content/stale-pages'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: _jobId } = await params
  const auth = await requireContentJobAccess(_jobId)
  if (auth instanceof NextResponse) return auth
  const { id } = await params
  const supabase = createServerClient()

  const { data: job } = await supabase
    .from('content_jobs')
    .select('session_id, phase')
    .eq('id', id)
    .single()

  if (!job) {
    return NextResponse.json({ error: 'Content job not found' }, { status: 404 })
  }

  // Reset every outline back to a pre-generation state. runOutlineGeneration
  // only (re)generates rows whose h1 is null, so clearing h1 is what makes a
  // full regenerate actually re-run Claude for the whole job.
  const { error: resetErr } = await supabase
    .from('page_outlines')
    .update({
      h1: null,
      sections: '[]',
      admin_approved: false,
      admin_notes: null,
      // Release any per-row claim so the fresh run can re-claim every outline.
      generation_claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('content_job_id', id)

  if (resetErr) {
    return internalError('outlines:regenerate-all', resetErr, "Couldn't reset outlines for regeneration")
  }

  if ((job.phase ?? 0) < 5) await resetStalePages(supabase, id)

  // after() guarantees the work runs to completion within maxDuration on
  // Vercel, unlike a bare fire-and-forget promise (see outlines/generate).
  after(async () => {
    try {
      await runOutlineGeneration(id, job.session_id)
    } catch (err) {
      console.error('[outline-gen] Regenerate-all trigger failed:', err)
    }
  })

  return NextResponse.json({ success: true })
}
