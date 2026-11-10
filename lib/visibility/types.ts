import type { CategoryScoreMap, Grade } from '@/types/audit-result'

export type AudienceKey = 'prospects' | 'clients' | 'talent' | 'search' | 'ai'

export type CheckStatus = 'pass' | 'partial' | 'fail' | 'na'

export interface CheckResult {
  id: string
  audience: AudienceKey
  label: string
  weight: number
  status: CheckStatus
  detail: string
  evidenceUrl: string | null
  source: 'site' | 'audit' | 'external' | 'ai'
}

export interface AudienceScore {
  score: number | null
  grade: Grade | null
}

export type AudienceScores = Record<AudienceKey, AudienceScore>

export interface RankResult {
  query: string
  position: number | null
  url: string | null
}

export interface ProbeResult {
  question: string
  mentioned: boolean
  snippet: string
  citedUrl: string | null
}

export interface GbpEvidence {
  rating: number | null
  reviewCount: number | null
  mapsUri: string | null
}

export interface VisibilityNarrativeSection {
  wins: string[]
  opportunities: string[]
}

export interface VisibilityNarrative {
  overview: string
  audiences: Record<AudienceKey, VisibilityNarrativeSection>
}

export type UnavailablePiece = 'ranks' | 'gbp' | 'probe' | 'ai_review'

export interface VisibilityResult {
  rubricVersion: string
  url: string
  domain: string
  isLiveDomain: boolean
  auditedAt: string
  pagesCrawled: number
  checks: CheckResult[]
  audienceScores: AudienceScores
  overallScore: number | null
  overallGrade: Grade | null
  // From the shared audit engine; shown in the appendix only.
  categoryScores: CategoryScoreMap
  // null = not run (staging host, no API key, or the lookup failed).
  ranks: RankResult[] | null
  gbp: GbpEvidence | null
  probe: ProbeResult[] | null
  unavailable: UnavailablePiece[]
}
