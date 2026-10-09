import type { createServerClient } from '@/lib/supabase/server'
import { QA_FENCED_STATUSES } from './fence'
import { QA_MAX_ATTEMPTS } from './mode'

type Supabase = ReturnType<typeof createServerClient>

// A queued row that no worker has claimed for this long is treated as
// unclaimable (e.g. triggers never reach the QA route) and made terminal.
export const QA_QUEUED_TIMEOUT_MS = 30 * 60 * 1000
export const QA_SWEEP_BATCH = 100

// Sweep-cron normalisation that keeps 'on' mode from wedging a job in phase 5:
//  (a) an approved page can never be QA'd (the claim requires unapproved), so
//      any lingering queued/running/error state on it is flipped to 'skipped'
//      — the human-edit fence is fail-soft and can miss one;
//  (b) a queued row older than QA_QUEUED_TIMEOUT_MS since generation finished
//      becomes 'error' with qa_attempts at the cap, so it's terminal and the
//      phase-6 hold (qaOutstanding) releases;
//  (c) a retriable error row no worker has claimed for QA_QUEUED_TIMEOUT_MS
//      (qa_started_at is stamped on every claim) gets the same treatment — when
//      triggers never reach the QA route, qa_attempts never rises and the
//      retriable error held phase 5 forever.
// Both are bounded to QA_SWEEP_BATCH rows per sweep. Errors are logged, never
// thrown — the sweep's other work must continue.
export async function normalizeQaHolds(
  supabase: Supabase,
  nowMs: number = Date.now(),
): Promise<{ approvedSkipped: number; queuedTimedOut: number; errorTimedOut: number }> {
  let approvedSkipped = 0
  let queuedTimedOut = 0
  let errorTimedOut = 0

  const { data: approved, error: approvedErr } = await supabase
    .from('generated_pages')
    .select('id')
    .eq('admin_approved_content', true)
    .in('qa_status', [...QA_FENCED_STATUSES])
    .limit(QA_SWEEP_BATCH)
  if (approvedErr) {
    console.error('[qa-sweep] approved-page read failed:', approvedErr)
  } else if (approved?.length) {
    const { data: skipped, error } = await supabase
      .from('generated_pages')
      .update({ qa_status: 'skipped' })
      .in('id', approved.map(r => r.id))
      .eq('admin_approved_content', true)
      .in('qa_status', [...QA_FENCED_STATUSES])
      .select('id')
    if (error) console.error('[qa-sweep] approved-page skip failed:', error)
    else approvedSkipped = skipped?.length ?? 0
  }

  const cutoff = new Date(nowMs - QA_QUEUED_TIMEOUT_MS).toISOString()
  const { data: stale, error: staleErr } = await supabase
    .from('generated_pages')
    .select('id')
    .eq('qa_status', 'queued')
    .lt('generation_started_at', cutoff)
    .limit(QA_SWEEP_BATCH)
  if (staleErr) {
    console.error('[qa-sweep] queued time-box read failed:', staleErr)
  } else {
    for (const r of stale ?? []) {
      // Fenced on still-queued so a worker that claimed it meanwhile wins.
      const { data: hit, error } = await supabase
        .from('generated_pages')
        .update({ qa_status: 'error', qa_attempts: QA_MAX_ATTEMPTS })
        .eq('id', r.id)
        .eq('qa_status', 'queued')
        .select('id')
      if (error) console.error(`[qa-sweep] queued time-box failed for page ${r.id}:`, error)
      else if (hit?.length) queuedTimedOut++
    }
  }

  const { data: stuckErr, error: stuckErrErr } = await supabase
    .from('generated_pages')
    .select('id')
    .eq('qa_status', 'error')
    .eq('admin_approved_content', false)
    .lt('qa_attempts', QA_MAX_ATTEMPTS)
    .lt('qa_started_at', cutoff)
    .limit(QA_SWEEP_BATCH)
  if (stuckErrErr) {
    console.error('[qa-sweep] error time-box read failed:', stuckErrErr)
  } else if (stuckErr?.length) {
    // Fenced on still-error and the same stale claim, so a worker that claims
    // it meanwhile (fresh qa_started_at) wins.
    const { data: hit, error } = await supabase
      .from('generated_pages')
      .update({ qa_attempts: QA_MAX_ATTEMPTS })
      .in('id', stuckErr.map(r => r.id))
      .eq('qa_status', 'error')
      .lt('qa_started_at', cutoff)
      .select('id')
    if (error) console.error('[qa-sweep] error time-box failed:', error)
    else errorTimedOut = hit?.length ?? 0
  }

  return { approvedSkipped, queuedTimedOut, errorTimedOut }
}
