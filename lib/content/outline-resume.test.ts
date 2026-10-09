import { describe, expect, it } from 'vitest'
import { OUTLINE_STALE_CLAIM_MS, selectOutlineJobsToResume } from './outline-resume'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('selectOutlineJobsToResume', () => {
  it('resumes a job with an unclaimed or stale-claimed unwritten outline', () => {
    expect(selectOutlineJobsToResume([
      { content_job_id: 'a', h1: null, generation_claimed_at: null },
      { content_job_id: 'b', h1: null, generation_claimed_at: ago(OUTLINE_STALE_CLAIM_MS + 1000) },
    ], NOW)).toEqual(['a', 'b'])
  })

  it('leaves a job alone while a worker holds a live claim', () => {
    expect(selectOutlineJobsToResume([
      { content_job_id: 'a', h1: null, generation_claimed_at: ago(60_000) },
      { content_job_id: 'a', h1: null, generation_claimed_at: null },
    ], NOW)).toEqual([])
  })

  it('ignores written outlines and caps the batch', () => {
    expect(selectOutlineJobsToResume([{ content_job_id: 'a', h1: 'Done', generation_claimed_at: null }], NOW)).toEqual([])
    const many = Array.from({ length: 8 }, (_, i) => ({ content_job_id: `j${i}`, h1: null, generation_claimed_at: null }))
    expect(selectOutlineJobsToResume(many, NOW, 5)).toHaveLength(5)
  })
})
