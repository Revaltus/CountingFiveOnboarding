import { describe, expect, it } from 'vitest'
import { renderVisibilityPdf } from './render'
import { evaluateRubric } from '@/lib/visibility/rubric'
import { fallbackNarrative } from '@/lib/visibility/narrative'
import { scoreAll } from '@/lib/visibility/score'
import { categoryScoresFixture, goodContext } from '@/lib/visibility/__fixtures__/rubric-fixtures'
import type { VisibilityResult } from '@/lib/visibility/types'

describe('renderVisibilityPdf', () => {
  it('renders a report to a real PDF buffer', async () => {
    const checks = evaluateRubric(goodContext())
    const scores = scoreAll(checks)
    const result: VisibilityResult = {
      rubricVersion: 'x',
      url: 'https://firm.com',
      domain: 'firm.com',
      isLiveDomain: true,
      auditedAt: '2026-11-10T12:00:00Z',
      pagesCrawled: 10,
      checks,
      ...scores,
      categoryScores: categoryScoresFixture(90),
      ranks: null,
      gbp: null,
      probe: null,
      unavailable: [],
    }
    const buf = await renderVisibilityPdf(result, fallbackNarrative(checks), 'Firm & Co. CPA')
    expect(buf.length).toBeGreaterThan(2000)
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)
})
