// Bridge between the run route and the pure engine. The route's atomic claim
// has already set the row to 'running', so every exit path here MUST write a
// terminal state (draft or error) — otherwise it waits for the cron sweep.
import { asJson } from '@/lib/supabase/json-typed'
import { createServerClient } from '@/lib/supabase/server'
import type { SessionSchema } from '@/types/session-schema'
import { runVisibilityReport } from './run'

const PROGRESS_WRITE_INTERVAL_MS = 1500
// Leaves ~40s of the route's 600s maxDuration for the final persist.
const REPORT_DEADLINE_MS = 560_000

export async function runVisibilityJob(reportId: string): Promise<void> {
  const supabase = createServerClient()
  let terminated = false

  const writeError = async (message: string) => {
    terminated = true
    await supabase
      .from('visibility_reports')
      .update({ status: 'error', status_detail: null, error: message, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', reportId)
  }

  const { data: row, error: rowErr } = await supabase
    .from('visibility_reports')
    .select('id, session_id, url, is_live_domain, created_by')
    .eq('id', reportId)
    .maybeSingle()
  if (rowErr || !row) {
    console.error('[visibility-worker] could not load report:', rowErr ?? reportId)
    await writeError('Could not load the report').catch(() => {})
    return
  }

  const { data: session, error: sessErr } = await supabase
    .from('sessions')
    .select('schema_data')
    .eq('id', row.session_id)
    .maybeSingle()
  if (sessErr || !session) {
    console.error('[visibility-worker] could not load session:', sessErr ?? row.session_id)
    await writeError('Could not load the client profile').catch(() => {})
    return
  }
  const schema = (session.schema_data ?? {}) as unknown as SessionSchema
  const firmName = schema.business?.name?.trim() || row.url

  let lastWrite = 0
  const onProgress = async (_stage: string, detail: string) => {
    if (terminated || Date.now() - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return
    lastWrite = Date.now()
    await supabase.from('visibility_reports').update({ status_detail: detail }).eq('id', reportId).eq('status', 'running')
  }

  try {
    const { result, narrative } = await runVisibilityReport({
      url: row.url,
      schema,
      firmName,
      isLiveDomain: row.is_live_domain,
      ctx: { task: 'audit', stage: 'visibility', sessionId: row.session_id, createdBy: row.created_by },
      deadline: Date.now() + REPORT_DEADLINE_MS,
      onProgress,
    })
    terminated = true
    const { error } = await supabase
      .from('visibility_reports')
      .update({
        status: 'draft',
        status_detail: null,
        error: null,
        rubric_version: result.rubricVersion,
        overall_score: result.overallScore,
        overall_grade: result.overallGrade,
        audience_scores: asJson(result.audienceScores),
        result: asJson(result),
        narrative: asJson(narrative),
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', reportId)
    if (error) throw error
  } catch (err) {
    console.error('[visibility-worker] report failed:', err)
    const message = err instanceof Error && /bot protection|Could not crawl/.test(err.message) ? err.message : 'The report could not be completed. Please try again.'
    await writeError(message).catch(() => {})
  }
}
