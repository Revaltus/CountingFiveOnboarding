import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  shouldChainGeneration,
  selectResumableContentJobs,
  finalizeGenerationIfComplete,
  completeContentJob,
  maybeCompleteAfterQa,
  MAX_GENERATION_ATTEMPTS,
  isStubBody,
} from './content-generator'

afterEach(() => { vi.unstubAllEnvs() })

describe('shouldChainGeneration', () => {
  it('finalizes when every page is complete', () => {
    // Nothing left to do — advance to phase 6, no chain.
    expect(
      shouldChainGeneration({ allDone: true, retriableErrorCount: 0, completedThisRun: 5 })
    ).toBe(false)
  })

  it('chains when pending work remains and progress was made', () => {
    // Soft-deadline hit mid-job with pending pages left.
    expect(
      shouldChainGeneration({ allDone: false, retriableErrorCount: 0, completedThisRun: 3 })
    ).toBe(true)
  })

  it('chains to retry a lone transient error while progress was made', () => {
    // 56 complete, 1 error still retriable → progress this run, so chain and retry.
    expect(
      shouldChainGeneration({ allDone: false, retriableErrorCount: 1, completedThisRun: 56 })
    ).toBe(true)
  })

  it('chains immediately when never-attempted (pending) pages remain', () => {
    // Soft-deadline left pending work even though this batch completed nothing new.
    expect(
      shouldChainGeneration({ allDone: false, retriableErrorCount: 0, completedThisRun: 0, pendingCount: 4 })
    ).toBe(true)
  })

  it('backs off (defers to cron) when only retriable errors remain and no progress', () => {
    // A retry invocation that only re-ran error pages and they failed again — the
    // signature of a sustained provider outage. Don't hammer it; the 5-min cron
    // sweep resumes it, giving the provider time to recover.
    expect(
      shouldChainGeneration({ allDone: false, retriableErrorCount: 1, completedThisRun: 0, pendingCount: 0 })
    ).toBe(false)
  })

  it('finalizes once all remaining errors are capped out (allDone)', () => {
    // Every page is complete or a capped-out error → stop, finalize into
    // ERRORS.md. This is what makes the retry loop terminate.
    expect(
      shouldChainGeneration({ allDone: true, retriableErrorCount: 0, completedThisRun: 0 })
    ).toBe(false)
  })
})

describe('selectResumableContentJobs', () => {
  it('resumes a job with never-attempted pending pages and nothing running', () => {
    const jobs = selectResumableContentJobs([
      { content_job_id: 'a', generation_status: 'complete' },
      { content_job_id: 'a', generation_status: 'pending' },
    ])
    expect(jobs).toEqual(['a'])
  })

  it('resumes a job whose only remaining work is a retriable error (the stranded-page case)', () => {
    // The exact hang: a page died mid-'running', got swept to 'error' under the
    // attempt cap. Every other page is complete → old pending-only filter missed
    // it and the job hung at phase 5 forever.
    const jobs = selectResumableContentJobs([
      { content_job_id: 'a', generation_status: 'complete' },
      { content_job_id: 'a', generation_status: 'error', generation_attempts: 1 },
    ])
    expect(jobs).toEqual(['a'])
  })

  it('does NOT resume while a page is still running (a live worker owns it)', () => {
    const jobs = selectResumableContentJobs([
      { content_job_id: 'a', generation_status: 'running', generation_attempts: 1 },
      { content_job_id: 'a', generation_status: 'error', generation_attempts: 1 },
    ])
    expect(jobs).toEqual([])
  })

  it('does NOT resume a capped-out error — it is terminal, so the job finalizes instead', () => {
    const jobs = selectResumableContentJobs([
      { content_job_id: 'a', generation_status: 'complete' },
      { content_job_id: 'a', generation_status: 'error', generation_attempts: MAX_GENERATION_ATTEMPTS },
    ])
    expect(jobs).toEqual([])
  })

  it('does NOT resume a fully-complete job', () => {
    const jobs = selectResumableContentJobs([
      { content_job_id: 'a', generation_status: 'complete' },
      { content_job_id: 'a', generation_status: 'complete' },
    ])
    expect(jobs).toEqual([])
  })

  it('scopes running/work independently per job', () => {
    const jobs = selectResumableContentJobs([
      // job a: a running page blocks resume even though b is ready
      { content_job_id: 'a', generation_status: 'running', generation_attempts: 1 },
      { content_job_id: 'b', generation_status: 'error', generation_attempts: 1 },
      { content_job_id: 'b', generation_status: 'complete' },
    ])
    expect(jobs).toEqual(['b'])
  })
})

// Minimal chainable Supabase stub: from().select().eq() resolves to {data},
// from().update() records the write, from().select().eq().single() for the
// phase read. Enough to exercise finalizeGenerationIfComplete's branches.
function makeSupabaseStub(opts: {
  pages: Array<{ page_url?: string; generation_status: string; generation_attempts?: number; qa_status?: string | null; qa_attempts?: number | null }>
  phase: number
  approvedUrls?: string[]
}) {
  const updates: Array<Record<string, unknown>> = []
  const supabase = {
    from(table: string) {
      if (table === 'generated_pages') {
        return { select: () => ({ eq: () => Promise.resolve({ data: opts.pages }) }) }
      }
      if (table === 'page_outlines') {
        // null → the outline read "failed" and finalize judges every page.
        const data = opts.approvedUrls ? opts.approvedUrls.map(page_url => ({ page_url })) : null
        return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data }) }) }) }
      }
      if (table === 'sessions') {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { schema_data: {} } }) }) }) }
      }
      if (table === 'audit_runs') {
        return { select: () => ({ eq: () => Promise.resolve({ data: [] }) }) }
      }
      // content_jobs — finalize goes through completeContentJob's fenced
      // update(...).eq('id').eq('phase', 5).select().
      return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { phase: opts.phase, session_id: 'sess-1' } }) }) }),
        update: (vals: Record<string, unknown>) => {
          updates.push(vals)
          const chain: Record<string, unknown> = {
            eq: () => chain,
            select: () => Promise.resolve({ data: opts.phase === 5 ? [{ id: 'job-1' }] : [], error: null }),
          }
          return chain
        },
      }
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { supabase: supabase as any, updates }
}

describe('finalizeGenerationIfComplete', () => {
  it('advances a phase-5 job to 6 when every page is complete', async () => {
    const { supabase, updates } = makeSupabaseStub({
      pages: [{ generation_status: 'complete' }, { generation_status: 'complete' }],
      phase: 5,
    })
    const advanced = await finalizeGenerationIfComplete(supabase, 'job-1')
    expect(advanced).toBe(true)
    expect(updates[0]).toMatchObject({ phase: 6 })
  })

  it('advances when the only non-complete page is a capped-out error', async () => {
    const { supabase, updates } = makeSupabaseStub({
      pages: [
        { generation_status: 'complete' },
        { generation_status: 'error', generation_attempts: MAX_GENERATION_ATTEMPTS },
      ],
      phase: 5,
    })
    expect(await finalizeGenerationIfComplete(supabase, 'job-1')).toBe(true)
    expect(updates[0]).toMatchObject({ phase: 6 })
  })

  it('does NOT advance while an error is still retriable (work should resume, not finalize)', async () => {
    const { supabase, updates } = makeSupabaseStub({
      pages: [
        { generation_status: 'complete' },
        { generation_status: 'error', generation_attempts: 1 },
      ],
      phase: 5,
    })
    expect(await finalizeGenerationIfComplete(supabase, 'job-1')).toBe(false)
    expect(updates).toHaveLength(0)
  })

  it('is a no-op when the job is already at phase 6', async () => {
    const { supabase, updates } = makeSupabaseStub({
      pages: [{ generation_status: 'complete' }],
      phase: 6,
    })
    expect(await finalizeGenerationIfComplete(supabase, 'job-1')).toBe(false)
    expect(updates).toHaveLength(0)
  })

  it('does not advance a job with no pages', async () => {
    const { supabase, updates } = makeSupabaseStub({ pages: [], phase: 5 })
    expect(await finalizeGenerationIfComplete(supabase, 'job-1')).toBe(false)
    expect(updates).toHaveLength(0)
  })

  it('ignores pending rows for UNAPPROVED outlines (they are never generated)', async () => {
    const { supabase, updates } = makeSupabaseStub({
      pages: [
        { page_url: '/a', generation_status: 'complete' },
        { page_url: '/never-approved', generation_status: 'pending' },
      ],
      phase: 5,
      approvedUrls: ['/a'],
    })
    expect(await finalizeGenerationIfComplete(supabase, 'job-1')).toBe(true)
    expect(updates[0]).toMatchObject({ phase: 6 })
  })

  it('does not finalize a job that is not in generation (phase < 5)', async () => {
    const { supabase, updates } = makeSupabaseStub({
      pages: [{ page_url: '/a', generation_status: 'complete' }],
      phase: 4,
      approvedUrls: ['/a'],
    })
    expect(await finalizeGenerationIfComplete(supabase, 'job-1')).toBe(false)
    expect(updates).toHaveLength(0)
  })
})

describe('finalizeGenerationIfComplete — QA gate', () => {
  it('holds phase 6 in QA on mode while a complete page is still queued for QA', async () => {
    vi.stubEnv('CONTENT_QA_MODE', 'on')
    const { supabase, updates } = makeSupabaseStub({
      pages: [{ generation_status: 'complete', qa_status: 'done' }, { generation_status: 'complete', qa_status: 'queued' }],
      phase: 5,
    })
    expect(await finalizeGenerationIfComplete(supabase, 'job-1')).toBe(false)
    expect(updates).toHaveLength(0)
  })

  it('does not wait on QA in shadow mode', async () => {
    vi.stubEnv('CONTENT_QA_MODE', 'shadow')
    const { supabase, updates } = makeSupabaseStub({
      pages: [{ generation_status: 'complete', qa_status: 'running' }],
      phase: 5,
    })
    expect(await finalizeGenerationIfComplete(supabase, 'job-1')).toBe(true)
    expect(updates[0]).toMatchObject({ phase: 6 })
  })
})

// Stub for completeContentJob / maybeCompleteAfterQa: the fenced phase update
// lands only while `phase` is still 5 (and flips it), like the real row.
function makeCompletionStub(opts: {
  pages: Array<{ page_url: string; generation_status: string; generation_attempts?: number; qa_status?: string | null; qa_attempts?: number | null }>
  phase: number
}) {
  const state = { phase: opts.phase, phaseWrites: 0 }
  const resolved = (data: unknown) => {
    const p = Promise.resolve({ data, error: null })
    // Thenable chain that tolerates any number of .eq() calls.
    const chain: Record<string, unknown> = {
      eq: () => chain,
      single: () => p,
      then: p.then.bind(p),
    }
    return chain
  }
  const supabase = {
    from(table: string) {
      if (table === 'generated_pages') return { select: () => resolved(opts.pages) }
      if (table === 'page_outlines') return { select: () => resolved(opts.pages.map(p => ({ page_url: p.page_url }))) }
      if (table === 'sessions') return { select: () => resolved({ schema_data: { business: { name: 'Acme CPA' } } }) }
      if (table === 'audit_runs') return { select: () => resolved([]) }
      // content_jobs
      return {
        select: () => resolved({ phase: state.phase, session_id: 'sess-1' }),
        update: () => {
          const filters: Record<string, unknown> = {}
          const chain = {
            eq: (col: string, val: unknown) => { filters[col] = val; return chain },
            select: () => {
              const lands = filters.phase === 5 && state.phase === 5
              if (lands) { state.phase = 6; state.phaseWrites += 1 }
              return Promise.resolve({ data: lands ? [{ id: 'job-1' }] : [], error: null })
            },
          }
          return chain
        },
      }
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { supabase: supabase as any, state }
}

describe('completeContentJob', () => {
  it('advances phase 5→6 once; a second (racing) caller is a no-op', async () => {
    const { supabase, state } = makeCompletionStub({
      pages: [{ page_url: '/a', generation_status: 'complete' }],
      phase: 5,
    })
    expect(await completeContentJob(supabase, 'job-1', 'sess-1')).toBe(true)
    expect(await completeContentJob(supabase, 'job-1', 'sess-1')).toBe(false)
    expect(state.phaseWrites).toBe(1)
  })

  it('does nothing for a job not in generation', async () => {
    const { supabase, state } = makeCompletionStub({ pages: [], phase: 6 })
    expect(await completeContentJob(supabase, 'job-1', 'sess-1')).toBe(false)
    expect(state.phaseWrites).toBe(0)
  })
})

describe('maybeCompleteAfterQa', () => {
  it('waits while QA is outstanding in on mode', async () => {
    vi.stubEnv('CONTENT_QA_MODE', 'on')
    const { supabase, state } = makeCompletionStub({
      pages: [
        { page_url: '/a', generation_status: 'complete', qa_status: 'done' },
        { page_url: '/b', generation_status: 'complete', qa_status: 'running' },
      ],
      phase: 5,
    })
    expect(await maybeCompleteAfterQa(supabase, 'job-1')).toBe(false)
    expect(state.phaseWrites).toBe(0)
  })

  it('finishes the job once every page is done and QA has settled', async () => {
    vi.stubEnv('CONTENT_QA_MODE', 'on')
    const { supabase, state } = makeCompletionStub({
      pages: [
        { page_url: '/a', generation_status: 'complete', qa_status: 'done' },
        { page_url: '/b', generation_status: 'complete', qa_status: 'error', qa_attempts: 2 },
        { page_url: '/c', generation_status: 'complete', qa_status: 'skipped' },
      ],
      phase: 5,
    })
    expect(await maybeCompleteAfterQa(supabase, 'job-1')).toBe(true)
    expect(state.phase).toBe(6)
  })

  it('waits on a retriable QA error (attempts below the cap) in on mode', async () => {
    vi.stubEnv('CONTENT_QA_MODE', 'on')
    const { supabase, state } = makeCompletionStub({
      pages: [
        { page_url: '/a', generation_status: 'complete', qa_status: 'done' },
        { page_url: '/b', generation_status: 'complete', qa_status: 'error', qa_attempts: 1 },
      ],
      phase: 5,
    })
    expect(await maybeCompleteAfterQa(supabase, 'job-1')).toBe(false)
    expect(state.phaseWrites).toBe(0)
  })

  it('finishes despite a retriable QA error in shadow mode', async () => {
    vi.stubEnv('CONTENT_QA_MODE', 'shadow')
    const { supabase, state } = makeCompletionStub({
      pages: [
        { page_url: '/a', generation_status: 'complete', qa_status: 'error', qa_attempts: 1 },
      ],
      phase: 5,
    })
    expect(await maybeCompleteAfterQa(supabase, 'job-1')).toBe(true)
    expect(state.phase).toBe(6)
  })

  it('waits while generation still has work, whatever QA says', async () => {
    vi.stubEnv('CONTENT_QA_MODE', 'on')
    const { supabase, state } = makeCompletionStub({
      pages: [
        { page_url: '/a', generation_status: 'complete', qa_status: 'done' },
        { page_url: '/b', generation_status: 'pending', qa_status: null },
      ],
      phase: 5,
    })
    expect(await maybeCompleteAfterQa(supabase, 'job-1')).toBe(false)
    expect(state.phaseWrites).toBe(0)
  })
})

describe('isStubBody', () => {
  it('flags a refusal-length body on a normal page', () => {
    expect(isStubBody(40, 1000)).toBe(true)
    expect(isStubBody(0, null)).toBe(true)
  })

  it('passes a real page and a short-target page', () => {
    expect(isStubBody(900, 1000)).toBe(false)
    // contact/privacy pages: a 300-word target only trips under 75 words
    expect(isStubBody(110, 300)).toBe(false)
    expect(isStubBody(60, 300)).toBe(true)
  })
})
