import { describe, expect, it } from 'vitest'
import { buildReviewPrompt, validateReview } from './ai-review'
import { buildProbeQuestions, detectMention } from './ai-probe'
import { coerceNarrative, fallbackNarrative, validateNarrativeInput } from './narrative'
import { evaluateRubric } from './rubric'
import { goodContext, goodIndex, schemaFixture } from './__fixtures__/rubric-fixtures'
import type { SessionSchema } from '@/types/session-schema'

const fullAudiences = {
  prospects: { wins: ['a'], opportunities: ['b'] },
  niche: { wins: [], opportunities: [] },
  talent: { wins: [], opportunities: [] },
  search: { wins: [], opportunities: [] },
  ai: { wins: [], opportunities: [] },
}

describe('validateReview', () => {
  it('accepts a well-formed review and drops unknown check ids', () => {
    const out = validateReview({
      judgments: [
        { checkId: 'p.answers_need', status: 'pass', detail: 'Clear', evidenceUrl: 'https://firm.com/x' },
        { checkId: 'made.up', status: 'pass', detail: 'x' },
        { checkId: 't.story', status: 'great', detail: 'x' },
      ],
      overview: 'Your site is strong.',
      audiences: { ...fullAudiences, prospects: { wins: ['1', '2', '3', '4', '5'], opportunities: ['x'] } },
    })
    expect(out?.judgments.map((j) => j.checkId)).toEqual(['p.answers_need'])
    expect(out?.narrative.audiences.prospects.wins).toHaveLength(4)
  })

  it('rejects garbage', () => {
    expect(validateReview(null)).toBeNull()
    expect(validateReview({ judgments: [] })).toBeNull()
  })
})

describe('buildReviewPrompt', () => {
  const checks = evaluateRubric({ ...goodContext(), ai: null })
  const schema = { ...schemaFixture(), _meta: { secret: 'internal-tracking' } } as unknown as SessionSchema
  const { prefix, suffix } = buildReviewPrompt({ firmName: 'Firm CPA', schema, index: goodIndex(), checks })

  it('keeps per-client data out of the cacheable prefix', () => {
    expect(prefix).not.toContain('Firm CPA')
    expect(prefix).not.toContain('firm.com')
    expect(prefix).toContain('p.answers_need')
  })

  it('carries the firm, pages and checks in the suffix, never _meta', () => {
    expect(suffix).toContain('Firm CPA')
    expect(suffix).toContain('https://firm.com/careers')
    expect(suffix).toContain('t.careers')
    expect(suffix).not.toContain('internal-tracking')
    expect(suffix).not.toContain('mbp_content')
  })
})

describe('buildProbeQuestions', () => {
  it('asks niche, service and understanding questions with the city', () => {
    const q = buildProbeQuestions(schemaFixture(), 'Firm CPA')
    expect(q).toHaveLength(3)
    expect(q[0].question).toMatch(/Dental Practices/)
    expect(q[0].question).toMatch(/Austin/)
    expect(q[1].question).toMatch(/Tax Planning/)
    expect(q[2].kind).toBe('understanding')
  })

  it('skips discovery questions it has no data for', () => {
    const q = buildProbeQuestions({} as SessionSchema, 'Firm CPA')
    expect(q.map((x) => x.kind)).toEqual(['understanding'])
  })
})

describe('detectMention', () => {
  it('matches the core firm name, ignoring legal suffixes and case', () => {
    expect(detectMention('Try Smith & Jones for dentists.', 'Smith & Jones CPAs, PLLC', 'smithjones.com')).toBe(true)
    expect(detectMention('See smithjones.com', 'Other Name LLC', 'smithjones.com')).toBe(true)
    expect(detectMention('Try Acme Accounting.', 'Smith & Jones CPAs', 'smithjones.com')).toBe(false)
  })
})

describe('narrative helpers', () => {
  it('coerceNarrative fills missing audiences and requires an overview', () => {
    expect(coerceNarrative({ overview: '' })).toBeNull()
    expect(coerceNarrative({ overview: 'x' })?.audiences.ai).toEqual({ wins: [], opportunities: [] })
  })

  it('validateNarrativeInput rejects over-limit edits instead of clamping', () => {
    const base = { overview: 'x', audiences: fullAudiences }
    expect(validateNarrativeInput(base).ok).toBe(true)
    const tooMany = { ...base, audiences: { ...fullAudiences, ai: { wins: ['1', '2', '3', '4', '5'], opportunities: [] } } }
    expect(validateNarrativeInput(tooMany).ok).toBe(false)
    expect(validateNarrativeInput({ overview: 'x' }).ok).toBe(false)
  })

  it('fallbackNarrative builds a draft from checks', () => {
    const n = fallbackNarrative(evaluateRubric(goodContext()))
    expect(n.audiences.talent.wins.length).toBeGreaterThan(0)
  })
})
