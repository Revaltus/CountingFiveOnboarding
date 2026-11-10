import { after, NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { createServerClient } from '@/lib/supabase/server'
import { loadReportForUser } from '@/lib/visibility/access'
import { runVisibilityJob } from '@/lib/visibility/worker'

export const runtime = 'nodejs'
export const maxDuration = 600

const MAX_ATTEMPTS = 5

// POST /api/visibility-reports/[id]/run — run a queued (or failed) report in
// the background. The claim is atomic so a double-click can't start two runs.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const loaded = await loadReportForUser(id)
  if (loaded instanceof NextResponse) return loaded
  if (loaded.report.attempts >= MAX_ATTEMPTS) {
    return NextResponse.json({ error: 'This report has failed too many times. Start a new one.' }, { status: 409 })
  }

  const { data: claimed, error } = await createServerClient()
    .from('visibility_reports')
    .update({
      status: 'running',
      status_detail: 'Starting…',
      error: null,
      attempts: loaded.report.attempts + 1,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .in('status', ['queued', 'error'])
    .select('id')
  if (error) return internalError('visibility-reports:run', error)
  if (!claimed?.length) return NextResponse.json({ status: 'skipped' })

  after(async () => {
    try {
      await runVisibilityJob(id)
    } catch (err) {
      console.error('[visibility] worker crashed:', err)
    }
  })
  return NextResponse.json({ status: 'started' })
}
