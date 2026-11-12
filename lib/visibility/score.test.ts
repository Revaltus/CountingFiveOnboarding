import { describe, expect, it } from 'vitest'
import { scoreAll, scoreAudience } from './score'
import type { AudienceKey, CheckResult, CheckStatus } from './types'

const check = (audience: AudienceKey, status: CheckStatus, weight = 1, id = `${audience}.${status}.${weight}`): CheckResult => ({
  id,
  audience,
  label: id,
  weight,
  status,
  detail: '',
  evidenceUrl: null,
  source: 'site',
})

describe('scoreAudience', () => {
  it('scores all passes as 100 / A', () => {
    expect(scoreAudience([check('prospects', 'pass', 2), check('prospects', 'pass', 1, 'b')], 'prospects')).toEqual({ score: 100, grade: 'A' })
  })

  it('weights pass and fail', () => {
    expect(scoreAudience([check('talent', 'pass', 2), check('talent', 'fail', 2)], 'talent').score).toBe(50)
  })

  it('counts partial as half', () => {
    expect(scoreAudience([check('ai', 'pass', 1), check('ai', 'partial', 1)], 'ai').score).toBe(75)
  })

  it('excludes n/a checks and returns null when nothing applies', () => {
    expect(scoreAudience([check('search', 'na', 3)], 'search')).toEqual({ score: null, grade: null })
    expect(scoreAudience([check('search', 'na', 3), check('search', 'fail', 1)], 'search').score).toBe(0)
  })

  it('ignores other audiences', () => {
    expect(scoreAudience([check('niche', 'fail'), check('prospects', 'pass')], 'prospects').score).toBe(100)
  })
})

describe('scoreAll', () => {
  it('averages the non-null audience scores', () => {
    const out = scoreAll([check('prospects', 'pass'), check('niche', 'fail'), check('talent', 'partial'), check('search', 'na')])
    expect(out.audienceScores.prospects.score).toBe(100)
    expect(out.audienceScores.search.score).toBeNull()
    expect(out.audienceScores.ai.score).toBeNull()
    expect(out.overallScore).toBe(50)
    expect(out.overallGrade).toBe('F')
  })

  it('returns null overall when no audience scores', () => {
    const out = scoreAll([])
    expect(out.overallScore).toBeNull()
    expect(out.overallGrade).toBeNull()
  })
})
