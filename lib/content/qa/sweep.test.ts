import { describe, it, expect } from 'vitest'
import { normalizeQaHolds, QA_QUEUED_TIMEOUT_MS, QA_SWEEP_BATCH } from './sweep'
import { makeFakeSupabase } from './test-fake-supabase'
import { QA_MAX_ATTEMPTS } from './mode'

const NOW = Date.parse('2026-10-01T12:00:00.000Z')

describe('normalizeQaHolds', () => {
  it('skips QA on approved pages and time-boxes unclaimable queued rows to a terminal error', async () => {
    const supabase = makeFakeSupabase({
      generated_pages: [
        { id: 'p1', admin_approved_content: true, qa_status: 'error' },
        { id: 'p2', admin_approved_content: true, qa_status: 'running' },
        { id: 'p3', admin_approved_content: false, qa_status: 'queued' },
      ],
    })
    // The fake narrows reads by .eq() only; the other bounds are asserted
    // through the recorded filters below.
    const r = await normalizeQaHolds(supabase, NOW)
    // The fake's update() echoes every fixture row (it doesn't re-filter
    // writes), so only assert the skip ran; the id set is checked below.
    expect(r.approvedSkipped).toBeGreaterThan(0)
    expect(r.queuedTimedOut).toBe(1)

    const reads = supabase.selectFilters('generated_pages')
    expect(reads[0]).toEqual(expect.arrayContaining([
      ['eq', 'admin_approved_content', true],
      ['in', 'qa_status', ['queued', 'running', 'error']],
      ['limit', '', QA_SWEEP_BATCH],
    ]))
    const cutoff = new Date(NOW - QA_QUEUED_TIMEOUT_MS).toISOString()
    expect(reads[1]).toEqual(expect.arrayContaining([
      ['eq', 'qa_status', 'queued'],
      ['lt', 'generation_started_at', cutoff],
      ['limit', '', QA_SWEEP_BATCH],
    ]))

    const payloads = supabase.updates('generated_pages')
    const filters = supabase.updateFilters('generated_pages')
    expect(payloads[0]).toEqual({ qa_status: 'skipped' })
    expect(filters[0]).toEqual(expect.arrayContaining([
      ['in', 'id', ['p1', 'p2']],
      ['eq', 'admin_approved_content', true],
      ['in', 'qa_status', ['queued', 'running', 'error']],
    ]))
    // Per-row time-box: error + attempts at the cap, fenced on still-queued.
    expect(payloads.slice(1)).toEqual([{ qa_status: 'error', qa_attempts: QA_MAX_ATTEMPTS }])
    expect(filters[1]).toEqual(expect.arrayContaining([['eq', 'id', 'p3'], ['eq', 'qa_status', 'queued']]))
    expect(QA_QUEUED_TIMEOUT_MS).toBe(30 * 60 * 1000)
  })

  it('does nothing when no rows match', async () => {
    const supabase = makeFakeSupabase({ generated_pages: [] })
    expect(await normalizeQaHolds(supabase, NOW)).toEqual({ approvedSkipped: 0, queuedTimedOut: 0, errorTimedOut: 0 })
    expect(supabase.updates('generated_pages')).toEqual([])
  })

  it('caps a retriable QA error that no worker has claimed for 30 minutes', async () => {
    const supabase = makeFakeSupabase({
      generated_pages: [{ id: 'p4', admin_approved_content: false, qa_status: 'error', qa_attempts: 1 }],
    })
    const r = await normalizeQaHolds(supabase, NOW)
    expect(r.errorTimedOut).toBe(1)
    const cutoff = new Date(NOW - QA_QUEUED_TIMEOUT_MS).toISOString()
    const reads = supabase.selectFilters('generated_pages')
    expect(reads[2]).toEqual(expect.arrayContaining([
      ['eq', 'qa_status', 'error'],
      ['lt', 'qa_attempts', QA_MAX_ATTEMPTS],
      ['lt', 'qa_started_at', cutoff],
    ]))
    expect(supabase.updates('generated_pages')).toEqual([{ qa_attempts: QA_MAX_ATTEMPTS }])
  })
})
