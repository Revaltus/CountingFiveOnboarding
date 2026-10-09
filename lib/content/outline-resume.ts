// An outline claim older than this is from a dead worker: the outline route's
// maxDuration (300s) plus a minute of slack. Shared by the runner's claim and
// the cron sweep so the two agree on what "stale" means.
export const OUTLINE_STALE_CLAIM_MS = 300_000 + 60_000

// Jobs whose outline generation stalled: at least one row still unwritten
// (h1 null) with no live claim. Pure, for the sweep. A chained outline run can
// die (function killed, lost after(), self-call 508), and nothing else brings
// those rows back — the card showed "N still generating" forever.
export function selectOutlineJobsToResume(
  rows: Array<{ content_job_id: string; h1: string | null; generation_claimed_at: string | null }>,
  nowMs: number,
  limit = 5,
): string[] {
  const staleBefore = nowMs - OUTLINE_STALE_CLAIM_MS
  const live = new Set<string>()
  const stalled = new Set<string>()
  for (const r of rows) {
    if (r.h1 !== null) continue
    const claimedAt = r.generation_claimed_at ? Date.parse(r.generation_claimed_at) : NaN
    if (Number.isFinite(claimedAt) && claimedAt > staleBefore) live.add(r.content_job_id)
    else stalled.add(r.content_job_id)
  }
  return [...stalled].filter(id => !live.has(id)).slice(0, limit)
}
