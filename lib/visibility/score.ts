import { getGrade } from '@/lib/audit/scoring'
import type { Grade } from '@/types/audit-result'
import { AUDIENCE_KEYS } from './audiences'
import type { AudienceKey, AudienceScore, AudienceScores, CheckResult, CheckStatus } from './types'

const VALUE: Record<Exclude<CheckStatus, 'na'>, number> = { pass: 1, partial: 0.5, fail: 0 }

export function scoreAudience(checks: CheckResult[], audience: AudienceKey): AudienceScore {
  let earned = 0
  let total = 0
  for (const c of checks) {
    if (c.audience !== audience || c.status === 'na') continue
    earned += c.weight * VALUE[c.status]
    total += c.weight
  }
  if (total === 0) return { score: null, grade: null }
  const score = Math.round((100 * earned) / total)
  return { score, grade: getGrade(score) }
}

export function scoreAll(checks: CheckResult[]): {
  audienceScores: AudienceScores
  overallScore: number | null
  overallGrade: Grade | null
} {
  const audienceScores = Object.fromEntries(
    AUDIENCE_KEYS.map((key) => [key, scoreAudience(checks, key)]),
  ) as AudienceScores
  const scored = AUDIENCE_KEYS.map((k) => audienceScores[k].score).filter((s): s is number => s !== null)
  if (scored.length === 0) return { audienceScores, overallScore: null, overallGrade: null }
  const overallScore = Math.round(scored.reduce((a, b) => a + b, 0) / scored.length)
  return { audienceScores, overallScore, overallGrade: getGrade(overallScore) }
}
