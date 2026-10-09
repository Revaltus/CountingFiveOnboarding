import { NextResponse } from 'next/server'
import { Resend } from 'resend'
import { createServerClient } from '@/lib/supabase/server'
import { resumePlan } from '@/lib/content/resume-targets'
import { runWhoisLookup } from '@/lib/whois/lookup'
import { selectResumableContentJobs, ORPHAN_RECLAIM_MS, MAX_GENERATION_ATTEMPTS, maybeCompleteAfterQa } from '@/lib/content/content-generator'
import { triggerQa } from '@/lib/content/qa/trigger'
import { qaMode, QA_MAX_ATTEMPTS } from '@/lib/content/qa/mode'
import { normalizeQaHolds } from '@/lib/content/qa/sweep'
import { reconcileStuckTarget, finalizeBlogBatchIfDone } from '@/lib/content/blog-batch-runner'
import { MAX_LIBRARY_ATTEMPTS } from '@/lib/content/library-inclusion'
import { MAX_IMPORT_ATTEMPTS } from '@/lib/content/article-import-inclusion'
import { sweepStuckDesignRows } from '@/lib/design/sweep'
import { nudgeStalledDesignRuns } from '@/lib/design/run-nudge'
import { requireCronBearer } from '@/lib/auth/cron-bearer'
import { selectOutlineJobsToResume } from '@/lib/content/outline-resume'

export const runtime = 'nodejs'
export const maxDuration = 300

// One 15-minute threshold used to cover every table, which meant a page whose
// worker died sat unworkable for up to 15 minutes — and since the UI warns at 4
// minutes, the operator was the only thing that could act in the 11-minute gap.
// Now that every model call carries a hard abort, each pipeline has a knowable
// ceiling for a single in-flight attempt, so each table gets its own threshold
// derived from that ceiling rather than one worst-case number for all of them.
const STUCK_THRESHOLD_MS = 15 * 60 * 1000

// Page generation: bounded by ORPHAN_RECLAIM_MS (the generate/regenerate
// function cap plus slack). Past it the worker is provably gone. The chained runner
// also reclaims its own orphans now, so this is the backstop for a job whose
// chain died entirely rather than the primary recovery path.
const PAGE_STUCK_THRESHOLD_MS = ORPHAN_RECLAIM_MS

// Per-item drafting (library articles, article imports): a smaller unit of work
// than a page body (measured output p50 3,468 tokens vs 8,424), but the runner
// walks several items per invocation, so allow a full function's worth.
const DRAFT_STUCK_THRESHOLD_MS = 10 * 60 * 1000

export async function GET(req: Request) {
  const denied = requireCronBearer(req)
  if (denied) return denied
  // Non-empty here (requireCronBearer fails closed); reused for self-calls.
  const cronSecret = process.env.CRON_SECRET as string

  const supabase = createServerClient()
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString()
  const pageCutoff = new Date(Date.now() - PAGE_STUCK_THRESHOLD_MS).toISOString()
  const draftCutoff = new Date(Date.now() - DRAFT_STUCK_THRESHOLD_MS).toISOString()

  // research_results sweeps on `updated_at` (stamped when a runner claims the
  // row) — created_at is set at sitemap-confirm, so it would falsely error a
  // healthy run on any job confirmed >15 min before research started. generated_pages sweeps on
  // `generation_started_at` (stamped when the page is claimed) — NOT created_at,
  // which is set at sitemap-confirm and made long jobs falsely error their
  // healthy in-flight pages every cron tick.
  // resource_ideas sweeps on updated_at: the draft lock bumps it when claimed,
  // so it reflects when the in-flight run actually started (rows are created
  // at brainstorm time, long before drafting).
  // audit_runs: a row stuck in a running state with started_at older than the
  // cutoff means the worker died mid-run. Reset it to 'error' so the UI stops
  // polling and the admin can re-run.
  // 'researching' is the AI-intelligence stage — the longest one and the most
  // likely place for a worker to die; omitting it stranded audits forever.
  const RUNNING_AUDIT_STATES = ['crawling', 'analyzing', 'researching', 'scoring', 'rendering']
  // Supabase queries resolve {data,error} rather than rejecting, so this only
  // rejects on a network-level throw — but if it does, we must still reach the
  // WHOIS retry + content/batch/audit auto-resume below (the important self-
  // heal). Swallow to null and default every swept count to 0.
  const sweep = await (async () => {
    try {
      return await Promise.all([
        supabase
          .from('research_results')
          .update({ research_status: 'error' })
          .eq('research_status', 'running')
          .lt('updated_at', cutoff)
          .select('id'),
        supabase
          .from('generated_pages')
          .update({ generation_status: 'error', generation_error: '[timeout] Generation worker stopped mid-run (swept by cron)' })
          .eq('generation_status', 'running')
          // Primary key is generation_started_at (stamped on claim). Also catch
          // rows with a NULL start (never stamped) that are old by created_at —
          // `.lt` alone never matches NULL, so those would otherwise orphan.
          .or(`generation_started_at.lt.${pageCutoff},and(generation_started_at.is.null,created_at.lt.${pageCutoff})`)
          .select('id'),
        supabase
          .from('resource_ideas')
          .update({ draft_status: 'error', draft_error: 'Draft timed out (swept by cron)' })
          .eq('draft_status', 'running')
          .lt('updated_at', cutoff)
          .select('id'),
        supabase
          .from('resource_ideas')
          .update({ social_status: 'error' })
          .eq('social_status', 'running')
          .lt('updated_at', cutoff)
          .select('id'),
        // 'pending' rows are swept too: a row stuck in pending means the
        // after() worker never ran (deploy restart, crash before claim).
        supabase
          .from('oneoff_generations')
          .update({ status: 'error', error: 'Generation timed out (swept by cron)' })
          .in('status', ['pending', 'running'])
          .lt('updated_at', cutoff)
          .select('id'),
        supabase
          .from('audit_runs')
          .update({ audit_status: 'error', error_message: 'Audit timed out (swept by cron)' })
          .in('audit_status', RUNNING_AUDIT_STATES)
          .lt('started_at', cutoff)
          .select('id'),
        // new_page_generations: same 'pending'-never-claimed risk as oneoffs.
        // generateNewPage writes a terminal 'error' on any throw, so the only
        // way a row stays non-terminal is the after() worker never firing.
        supabase
          .from('new_page_generations')
          .update({ status: 'error', error: 'Generation timed out (swept by cron)' })
          .in('status', ['pending', 'running'])
          .lt('updated_at', cutoff)
          .select('id'),
        // QA Desk: a QA worker that died mid-run (STUCK_THRESHOLD_MS = 15 min,
        // judged by qa_started_at, stamped on claim). 'error' is retriable
        // below while qa_attempts is under the cap.
        supabase
          .from('generated_pages')
          .update({ qa_status: 'error' })
          .eq('qa_status', 'running')
          .lt('qa_started_at', cutoff)
          .select('id'),
      ])
    } catch (err) {
      console.error('[sweep-stuck-jobs] sweep queries failed:', err)
      return null
    }
  })()
  const [research, pages, ideas, socials, oneoffs, audits, newPages, qaStuck] =
    sweep ?? [null, null, null, null, null, null, null, null]

  // Design Studio runs whose self-chain stopped (Vercel's recursion protection
  // refuses a deployment's ~5th self-call per chain with 508) are nudged
  // FIRST — a step call from here starts a fresh chain, so a run finishes even
  // with no Studio tab open. Only runs where a step would act and none holds
  // a claim (isRunStalled), so nothing in progress is double-run. Fail-soft.
  // The primary nudger is the every-minute /api/cron/nudge-design-runs; this
  // pass stays as a fallback (and to know which runs to spare from the stale
  // sweep below). A duplicate nudge is a no-op — every step unit is claimed.
  const designNudge = await nudgeStalledDesignRuns(supabase)
  if (designNudge.nudged.length || designNudge.refused) {
    console.warn(`[sweep-stuck-jobs] design runs nudged=${designNudge.nudged.length} refused=${designNudge.refused}`)
  }

  // Design Studio (migration 078): captures, runs and concepts whose worker
  // died mid-flight — except the runs just nudged (resumed, not dead).
  // Fail-soft — the helper logs and counts 0, never throws, so the self-heal
  // steps below always run.
  const designSwept = await sweepStuckDesignRows(supabase, Date.now(), { skipRunIds: designNudge.nudged })
  if (designSwept.inputs || designSwept.runs || designSwept.concepts) {
    console.warn(
      `[sweep-stuck-jobs] design inputs=${designSwept.inputs} runs=${designSwept.runs} concepts=${designSwept.concepts}`
    )
  }
  // Design Studio storage orphans (unreferenced /design/render outputs,
  // never-sent chat attachments, and the renders of runs that failed or were
  // cancelled over a week ago), once an hour, bounded per invocation. Lazy:
  // storage pulls in sharp. Fail-soft like the row sweep.
  let designOrphans = { renders: 0, attachments: 0, runRenders: 0 }
  try {
    const { isStorageSweepSlot, sweepDesignStorageOrphans, designStorageSweepDeps } = await import('@/lib/design/storage-sweep')
    if (isStorageSweepSlot(Date.now())) {
      designOrphans = await sweepDesignStorageOrphans(designStorageSweepDeps(supabase))
      if (designOrphans.renders || designOrphans.attachments || designOrphans.runRenders) {
        console.warn(
          `[sweep-stuck-jobs] design storage orphans removed renders=${designOrphans.renders} attachments=${designOrphans.attachments} runRenders=${designOrphans.runRenders}`
        )
      }
    }
  } catch (err) {
    console.error('[sweep-stuck-jobs] design storage sweep unavailable:', err)
  }

  // blog_batch_targets stuck at 'generating' (worker died between claim and
  // terminal write) are invisible to future chained runs, which only select
  // 'pending' — so the parent batch never completes. Settle each against its
  // idea's REAL draft_status instead of blindly resetting to 'pending': a
  // target whose article was actually drafted is complete (a blind reset
  // re-drafted it), one whose idea is still running is left alone, and the
  // rest retry only while under the attempts cap (else error — no endless loop).
  let batchTargetsSwept = 0
  const { data: stuckTargets } = await supabase
    .from('blog_batch_targets')
    .select('id, batch_id, resource_idea_id, attempts')
    .eq('status', 'generating')
    .lt('updated_at', cutoff)
    .limit(200)
  // Batches whose targets this pass settled to a terminal status.
  const settledBatchIds = new Set<string>()
  if (stuckTargets?.length) {
    const ideaIds = stuckTargets.map((t) => t.resource_idea_id).filter((x): x is string => !!x)
    const { data: stuckIdeas } = ideaIds.length
      ? await supabase.from('resource_ideas').select('id, draft_status').in('id', ideaIds)
      : { data: [] }
    const ideaStatus = new Map((stuckIdeas ?? []).map((i) => [i.id, i.draft_status]))
    for (const t of stuckTargets) {
      const next = reconcileStuckTarget(
        t.resource_idea_id ? ideaStatus.get(t.resource_idea_id) : null,
        t.attempts ?? 0
      )
      if (next === 'leave') continue
      const { data: moved } = await supabase
        .from('blog_batch_targets')
        .update({
          status: next,
          ...(next === 'error' ? { error: 'Draft worker stopped mid-run repeatedly — gave up (retry manually)' } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', t.id)
        .eq('status', 'generating')
        .select('id')
      batchTargetsSwept += moved?.length ?? 0
      if (moved?.length && next !== 'pending') settledBatchIds.add(t.batch_id)
    }
  }
  // A batch whose last live target was just settled here has no runner coming
  // back to finalize it (the resume below only re-runs batches with pending
  // targets) — settle its status now so it doesn't read "generating" forever.
  for (const batchId of settledBatchIds) {
    try {
      await finalizeBlogBatchIfDone(supabase, batchId)
    } catch (err) {
      console.error('[sweep-stuck-jobs] batch finalize failed for', batchId, err)
    }
  }

  // content_job_library_selections stuck at 'drafting' (worker died mid-draft —
  // the resource_ideas sweep above already reset the underlying idea to error)
  // hold the publish gate at 409 forever. Reset them to 'error' so the library
  // auto-resume below re-drafts them; a still-live idea is re-claimed idempotently.
  const { data: libSelections } = await supabase
    .from('content_job_library_selections')
    .update({ status: 'error', error: '[timeout] Draft worker stopped mid-run (swept by cron)', updated_at: new Date().toISOString() })
    .eq('status', 'drafting')
    .lt('updated_at', draftCutoff)
    .select('id')
  const librarySelectionsSwept = libSelections?.length ?? 0
  if (librarySelectionsSwept) {
    console.warn(`[sweep-stuck-jobs] library-selections reset to error=${librarySelectionsSwept}`)
  }

  // content_job_article_imports stuck at 'drafting' (worker died mid-import) hold
  // the publish gate at 409 forever. Reset to 'error' so the imports auto-resume
  // below re-runs them; importArticleAsIs re-claims idempotently.
  const { data: articleImports } = await supabase
    .from('content_job_article_imports')
    .update({ status: 'error', error: '[timeout] Import worker stopped mid-run (swept by cron)', updated_at: new Date().toISOString() })
    .eq('status', 'drafting')
    .lt('updated_at', draftCutoff)
    .select('id')
  const articleImportsSwept = articleImports?.length ?? 0
  if (articleImportsSwept) {
    console.warn(`[sweep-stuck-jobs] article-imports reset to error=${articleImportsSwept}`)
  }

  // Prune rate-limiter events older than 24h (largest window is 1h; 24h keeps
  // the table tiny without racing any active window).
  await supabase
    .from('rate_limit_events')
    .delete()
    .lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())

  // Prune task_progress rows older than 7 days — they only back a live progress
  // bar while an operation is in flight; nothing reads them afterward.
  await supabase
    .from('task_progress')
    .delete()
    .lt('updated_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

  // Sessions stranded at Phase 2: the WHOIS after()-task never completed (cold
  // kill, network drop). Re-run the lookup — it advances them to Phase 3 (and is
  // a no-op for any that have since moved on). Bounded to keep the cron quick.
  const { data: stuckSessions } = await supabase
    .from('sessions')
    .select('id, website_url')
    .eq('current_phase', 2)
    .in('status', ['pending', 'in_progress'])
    .lt('last_activity_at', cutoff)
    .limit(10)

  let whoisRetried = 0
  for (const s of stuckSessions ?? []) {
    if (!s.website_url) continue
    try {
      await runWhoisLookup(s.id, s.website_url)
      whoisRetried++
    } catch (err) {
      console.error('[sweep-stuck-jobs] WHOIS retry failed for', s.id, err)
    }
  }

  // Auto-resume content generation that stalled (Vercel killed the function
  // before the self-chain fired, or the chain's progress-guard stopped it).
  // Mirror the WHOIS retry: re-trigger /generate for any job with resumable work
  // (never-attempted `pending` pages, OR `error` pages still under the attempt
  // cap) and nothing currently running. Crucially this includes the page THIS
  // sweep just flipped `running → error` a few lines above — without it, a job
  // whose worker died mid-run strands forever at phase 5 (all pages terminal
  // except one retriable error, which the old `pending`-only filter ignored),
  // and Deliverables never unlocks. Capped-out errors are excluded so the loop
  // stays finite. The atomic per-page claim + complete-skip keep re-triggers
  // idempotent for healthy runs.
  //
  // Only jobs actually IN generation (content_jobs.phase = 5) are candidates:
  // generated_pages rows are seeded as `pending` at sitemap confirm, so a
  // phase-3/4 job (outlines still being proofed) looked resumable and got
  // /generate fired at it every 5 minutes. Scoping to phase-5 jobs first also
  // bounds the page query (was an unbounded table scan). Capped-out errors are
  // filtered in SQL so they never inflate the result.
  const { data: genJobs } = await supabase
    .from('content_jobs')
    .select('id')
    .eq('phase', 5)
    .order('updated_at', { ascending: true })
    .limit(50)
  const genJobIds = (genJobs ?? []).map((j) => j.id)
  const { data: liveGen } = genJobIds.length
    ? await supabase
        .from('generated_pages')
        .select('content_job_id, page_url, generation_status, generation_attempts')
        .in('content_job_id', genJobIds)
        .or(
          `generation_status.in.(pending,running),and(generation_status.eq.error,generation_attempts.lt.${MAX_GENERATION_ATTEMPTS})`
        )
        .limit(5000)
    : { data: [] }

  // Only approved outlines are ever generated; an unapproved `pending` row made a
  // job look resumable forever and burned a resume slot every tick.
  const { data: approvedOutlines } = genJobIds.length
    ? await supabase
        .from('page_outlines')
        .select('content_job_id, page_url')
        .in('content_job_id', genJobIds)
        .eq('admin_approved', true)
        .limit(5000)
    : { data: [] }
  const approvedKeys = new Set((approvedOutlines ?? []).map((o) => `${o.content_job_id}|${o.page_url}`))
  const resumableJobs = selectResumableContentJobs(
    (liveGen ?? []).filter((p) => approvedKeys.has(`${p.content_job_id}|${p.page_url}`)),
  ).slice(0, 5)

  let generationResumed = 0
  const resumeBase = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL
  if (resumeBase && resumableJobs.length) {
    const url = resumeBase.startsWith('http') ? resumeBase : `https://${resumeBase}`
    for (const jobId of resumableJobs) {
      try {
        const res = await fetch(`${url}/api/content-jobs/${jobId}/generate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cronSecret}` },
        })
        if (res.ok) generationResumed++
      } catch (err) {
        console.error('[sweep-stuck-jobs] content auto-resume failed for', jobId, err)
      }
    }
    if (generationResumed) {
      console.warn(`[sweep-stuck-jobs] content-generation auto-resumed jobs=${generationResumed}`)
    }
  }

  // QA Desk: re-fire pages whose QA trigger was lost (queued for 5+ min since
  // the page finished generating — generation_started_at, NOT created_at, which
  // is set at sitemap confirm and would re-fire every freshly queued page), or
  // a retriable error. The worker's atomic claim makes a duplicate fire a no-op.
  // Then finish jobs that were only waiting on QA (`on` mode holds phase 6).
  let qaRetriggered = 0
  let qaJobsFinalized = 0
  let qaApprovedSkipped = 0
  let qaQueuedTimedOut = 0
  if (qaMode() !== 'off') {
    // First unwedge the phase-6 hold: approved pages → skipped, and queued rows
    // no worker claimed in 30 min → terminal error (attempts at the cap).
    const holds = await normalizeQaHolds(supabase)
    qaApprovedSkipped = holds.approvedSkipped
    qaQueuedTimedOut = holds.queuedTimedOut + holds.errorTimedOut
    if (qaApprovedSkipped || qaQueuedTimedOut) {
      console.warn(`[sweep-stuck-jobs] qa holds normalised approvedSkipped=${qaApprovedSkipped} queuedTimedOut=${holds.queuedTimedOut} errorTimedOut=${holds.errorTimedOut}`)
    }
    const qaCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const { data: qaStale } = await supabase
      .from('generated_pages')
      .select('id, content_job_id')
      .eq('generation_status', 'complete')
      .eq('admin_approved_content', false)
      .lt('qa_attempts', QA_MAX_ATTEMPTS)
      .or(`and(qa_status.eq.queued,generation_started_at.lt.${qaCutoff}),qa_status.eq.error`)
      .order('generation_started_at', { ascending: true })
      .limit(20)
    for (const p of qaStale ?? []) {
      if (await triggerQa(p.content_job_id, p.id)) qaRetriggered++
    }
    if (qaRetriggered) console.warn(`[sweep-stuck-jobs] qa re-triggered pages=${qaRetriggered}`)
  }
  if (qaMode() === 'on') {
    for (const jobId of genJobIds) {
      try {
        if (await maybeCompleteAfterQa(supabase, jobId)) qaJobsFinalized++
      } catch (err) {
        console.error('[sweep-stuck-jobs] QA-held job finalize failed for', jobId, err)
      }
    }
    if (qaJobsFinalized) console.warn(`[sweep-stuck-jobs] qa-held jobs finalized=${qaJobsFinalized}`)
  }

  // Outlines: a phase-4 job with unwritten outlines (h1 null) and no live claim
  // lost its worker — re-trigger /outlines/generate. The runner's per-row claim
  // makes an overlapping re-trigger a no-op.
  const { data: outlineJobs } = await supabase
    .from('content_jobs')
    .select('id')
    .eq('phase', 4)
    .order('updated_at', { ascending: true })
    .limit(50)
  let outlinesResumed = 0
  if (resumeBase && outlineJobs?.length) {
    const { data: oRows } = await supabase
      .from('page_outlines')
      .select('content_job_id, h1, generation_claimed_at')
      .in('content_job_id', outlineJobs.map((j) => j.id))
      .is('h1', null)
      .limit(2000)
    const url = resumeBase.startsWith('http') ? resumeBase : `https://${resumeBase}`
    for (const jobId of selectOutlineJobsToResume(oRows ?? [], Date.now())) {
      try {
        const res = await fetch(`${url}/api/content-jobs/${jobId}/outlines/generate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cronSecret}` },
        })
        if (res.ok) outlinesResumed += 1
      } catch (err) {
        console.error('[sweep-stuck-jobs] outline auto-resume failed for', jobId, err)
      }
    }
    if (outlinesResumed) console.warn(`[sweep-stuck-jobs] outline generation auto-resumed jobs=${outlinesResumed}`)
  }

  // Research: a phase-3 job with pending/error research rows, nothing running,
  // and no activity for 10+ minutes has lost its worker (the pipeline's chain
  // died or the function was killed). Re-trigger /research/continue.
  const { data: researchJobs } = await supabase
    .from('content_jobs')
    .select('id')
    .eq('phase', 3)
    .lt('updated_at', draftCutoff)
    .limit(20)
  let researchResumed = 0
  if (resumeBase && researchJobs?.length) {
    const ids = researchJobs.map((j) => j.id)
    const { data: rRows } = await supabase
      .from('research_results')
      .select('content_job_id, research_status, updated_at')
      .in('content_job_id', ids)
      .in('research_status', ['pending', 'running', 'error'])
    const byJob = new Map<string, { open: number; running: number; fresh: boolean }>()
    for (const r of rRows ?? []) {
      const c = byJob.get(r.content_job_id) ?? { open: 0, running: 0, fresh: false }
      if (r.research_status === 'running') c.running += 1
      else c.open += 1
      if (r.updated_at > draftCutoff) c.fresh = true
      byJob.set(r.content_job_id, c)
    }
    const url = resumeBase.startsWith('http') ? resumeBase : `https://${resumeBase}`
    for (const [jobId, c] of byJob) {
      if (c.open === 0 || c.running > 0 || c.fresh) continue
      if (researchResumed >= 5) break
      try {
        const res = await fetch(`${url}/api/content-jobs/${jobId}/research/continue`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cronSecret}` },
        })
        if (res.ok) researchResumed += 1
      } catch (err) {
        console.error('[sweep-stuck-jobs] research auto-resume failed for', jobId, err)
      }
    }
    if (researchResumed) console.warn(`[sweep-stuck-jobs] research auto-resumed jobs=${researchResumed}`)
  }

  // Library selections: a job with non-terminal selections (pending/error) and
  // none currently drafting has no worker coming back for it — re-trigger
  // /library/run (idempotent: it reconciles in-flight rows and retries the rest).
  // Without this a stalled library draft blocks publish permanently.
  // Oldest-updated first so the 5-job limit rotates across jobs; capped-out
  // errors (MAX_LIBRARY_ATTEMPTS) no longer drive an endless /retry every tick.
  const { data: liveSelections } = await supabase
    .from('content_job_library_selections')
    .select('content_job_id, status, attempts')
    .in('status', ['pending', 'drafting', 'error'])
    .order('updated_at', { ascending: true })
    .limit(2000)

  // Route each job to /retry when it has failed items (the only path that can
  // reset them) and /run when it only has fresh work. See resume-targets.ts —
  // always calling /run made this whole block a silent no-op for all-error jobs.
  const libraryPlan = resumePlan(liveSelections ?? [], 5, MAX_LIBRARY_ATTEMPTS)

  let librarySelectionsResumed = 0
  if (resumeBase && libraryPlan.length) {
    const url = resumeBase.startsWith('http') ? resumeBase : `https://${resumeBase}`
    for (const { jobId, endpoint } of libraryPlan) {
      try {
        const res = await fetch(`${url}/api/content-jobs/${jobId}/library/${endpoint}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cronSecret}` },
        })
        if (res.ok) librarySelectionsResumed += 1
      } catch (err) {
        console.error('[sweep-stuck-jobs] library auto-resume failed for', jobId, err)
      }
    }
    if (librarySelectionsResumed) {
      console.warn(`[sweep-stuck-jobs] library-selections auto-resumed jobs=${librarySelectionsResumed}`)
    }
  }

  // Article imports: same recovery as library selections — a job with open
  // (pending/error) imports and none drafting has no worker; re-trigger
  // /imports/run (idempotent). Without this a stalled import blocks publish.
  const { data: liveImports } = await supabase
    .from('content_job_article_imports')
    .select('content_job_id, status, attempts')
    .in('status', ['pending', 'drafting', 'error'])
    .order('updated_at', { ascending: true })
    .limit(2000)

  const importPlan = resumePlan(liveImports ?? [], 5, MAX_IMPORT_ATTEMPTS)

  let articleImportsResumed = 0
  if (resumeBase && importPlan.length) {
    const url = resumeBase.startsWith('http') ? resumeBase : `https://${resumeBase}`
    for (const { jobId, endpoint } of importPlan) {
      try {
        const res = await fetch(`${url}/api/content-jobs/${jobId}/imports/${endpoint}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cronSecret}` },
        })
        if (res.ok) articleImportsResumed += 1
      } catch (err) {
        console.error('[sweep-stuck-jobs] article-import auto-resume failed for', jobId, err)
      }
    }
    if (articleImportsResumed) {
      console.warn(`[sweep-stuck-jobs] article-imports auto-resumed jobs=${articleImportsResumed}`)
    }
  }

  // Blog batches: a target reset to 'pending' above (or a chain that died
  // before firing) has no worker coming back for it — re-trigger the batch
  // runner the same way content generation is auto-resumed.
  const { data: liveBatchTargets } = await supabase
    .from('blog_batch_targets')
    .select('batch_id, status')
    .in('status', ['pending', 'generating'])
    .order('updated_at', { ascending: true })
    .limit(2000)

  const batchCounts = new Map<string, { pending: number; generating: number }>()
  for (const t of liveBatchTargets ?? []) {
    const c = batchCounts.get(t.batch_id) ?? { pending: 0, generating: 0 }
    if (t.status === 'generating') c.generating++
    else c.pending++
    batchCounts.set(t.batch_id, c)
  }
  const resumableBatches = [...batchCounts.entries()]
    .filter(([, c]) => c.pending > 0 && c.generating === 0)
    .map(([batchId]) => batchId)
    .slice(0, 5)

  let batchesResumed = 0
  if (resumeBase && resumableBatches.length) {
    const url = resumeBase.startsWith('http') ? resumeBase : `https://${resumeBase}`
    for (const batchId of resumableBatches) {
      try {
        const res = await fetch(`${url}/api/blog-batches/${batchId}/generate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cronSecret}` },
        })
        if (res.ok) batchesResumed++
      } catch (err) {
        console.error('[sweep-stuck-jobs] blog-batch auto-resume failed for', batchId, err)
      }
    }
    if (batchesResumed) {
      console.warn(`[sweep-stuck-jobs] blog-batches auto-resumed=${batchesResumed}`)
    }
  }

  // Audit batches: the runner self-chains via after(), which Vercel may kill
  // before the next hop fires. The audit_runs sweep above already reset any
  // >15-min-stuck run to 'error', so a stalled batch now shows queued rows and
  // nothing running — re-trigger its sequential runner the same way.
  const { data: runningBatches } = await supabase
    .from('audit_batches')
    .select('id')
    .eq('status', 'running')
    .limit(50)

  let auditBatchesResumed = 0
  if (resumeBase && runningBatches?.length) {
    const batchIds = runningBatches.map((b) => b.id)
    const { data: batchRuns } = await supabase
      .from('audit_runs')
      .select('audit_batch_id, audit_status')
      .in('audit_batch_id', batchIds)

    const RUNNING_AUDIT = new Set(RUNNING_AUDIT_STATES)
    const auditBatchCounts = new Map<string, { queued: number; running: number }>()
    for (const r of batchRuns ?? []) {
      if (!r.audit_batch_id) continue
      const c = auditBatchCounts.get(r.audit_batch_id) ?? { queued: 0, running: 0 }
      if (r.audit_status === 'queued') c.queued += 1
      else if (RUNNING_AUDIT.has(r.audit_status)) c.running += 1
      auditBatchCounts.set(r.audit_batch_id, c)
    }
    const resumableAuditBatches = [...auditBatchCounts.entries()]
      .filter(([, c]) => c.queued > 0 && c.running === 0)
      .map(([batchId]) => batchId)
      .slice(0, 5)

    const url = resumeBase.startsWith('http') ? resumeBase : `https://${resumeBase}`
    for (const batchId of resumableAuditBatches) {
      try {
        const res = await fetch(`${url}/api/audit-batches/${batchId}/run`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cronSecret}` },
        })
        if (res.ok) auditBatchesResumed += 1
      } catch (err) {
        console.error('[sweep-stuck-jobs] audit-batch auto-resume failed for', batchId, err)
      }
    }
    if (auditBatchesResumed) {
      console.warn(`[sweep-stuck-jobs] audit-batches auto-resumed=${auditBatchesResumed}`)
    }
  }

  const researchSwept = research?.data?.length ?? 0
  const pagesSwept = pages?.data?.length ?? 0
  const ideasSwept = ideas?.data?.length ?? 0
  const socialsSwept = socials?.data?.length ?? 0
  const oneoffsSwept = oneoffs?.data?.length ?? 0
  const auditsSwept = audits?.data?.length ?? 0
  const newPagesSwept = newPages?.data?.length ?? 0
  const qaSwept = qaStuck?.data?.length ?? 0
  if (qaSwept) console.warn(`[sweep-stuck-jobs] qa runs reset to error=${qaSwept} cutoff=${cutoff}`)
  if (batchTargetsSwept) {
    console.warn(`[sweep-stuck-jobs] blog-batch-targets reset to pending=${batchTargetsSwept}`)
  }

  if (whoisRetried) {
    console.warn(`[sweep-stuck-jobs] whois-retried=${whoisRetried} cutoff=${cutoff}`)
  }

  if (researchSwept || pagesSwept || ideasSwept || socialsSwept || oneoffsSwept || auditsSwept || newPagesSwept) {
    console.warn(
      `[sweep-stuck-jobs] research=${researchSwept} pages=${pagesSwept} ideas=${ideasSwept} socials=${socialsSwept} oneoffs=${oneoffsSwept} audits=${auditsSwept} newPages=${newPagesSwept} cutoff=${cutoff}`
    )

    // Stuck rows mean a pipeline run died mid-flight — tell the admin instead
    // of resetting silently. Fail-soft: a mail hiccup must not fail the cron.
    const adminEmail = process.env.ADMIN_EMAIL
    const fromEmail = process.env.RESEND_FROM_EMAIL
    if (adminEmail && fromEmail && process.env.RESEND_API_KEY) {
      try {
        const parts = [
          researchSwept && `${researchSwept} research`,
          pagesSwept && `${pagesSwept} page generation(s)`,
          ideasSwept && `${ideasSwept} blog draft(s)`,
          socialsSwept && `${socialsSwept} social generation(s)`,
          oneoffsSwept && `${oneoffsSwept} one-off generation(s)`,
          auditsSwept && `${auditsSwept} site audit(s)`,
          newPagesSwept && `${newPagesSwept} new-page draft(s)`,
        ].filter(Boolean)
        const resend = new Resend(process.env.RESEND_API_KEY)
        await resend.emails.send({
          from: fromEmail,
          to: adminEmail,
          subject: `[Revaltus] Stuck jobs swept — ${parts.join(', ')}`,
          html: `
            <h2>Stuck Pipeline Jobs Reset</h2>
            <p>The sweep cron reset rows stuck in 'running' for over 15 minutes: ${parts.join(', ')}.</p>
            <p>They're now marked as errors — check the affected jobs and retry from the admin UI.</p>
            <p><a href="${process.env.NEXT_PUBLIC_APP_URL ?? ''}/admin/dashboard">Open dashboard →</a></p>
          `,
        })
      } catch (err) {
        console.error('[sweep-stuck-jobs] alert email failed:', err)
      }
    }
  }

  return NextResponse.json({ researchSwept, pagesSwept, ideasSwept, socialsSwept, oneoffsSwept, auditsSwept, batchTargetsSwept, newPagesSwept, librarySelectionsSwept, articleImportsSwept, whoisRetried, generationResumed, outlinesResumed, batchesResumed, auditBatchesResumed, librarySelectionsResumed, articleImportsResumed,
    researchResumed, qaSwept, qaRetriggered, qaJobsFinalized, qaApprovedSkipped, qaQueuedTimedOut, designInputsSwept: designSwept.inputs, designRunsSwept: designSwept.runs, designConceptsSwept: designSwept.concepts, designRendersRemoved: designOrphans.renders, designAttachmentsRemoved: designOrphans.attachments, designRunRendersRemoved: designOrphans.runRenders, cutoff })
}
