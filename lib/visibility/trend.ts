import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { AudienceScores } from './types'

export interface TrendPoint {
  date: string
  overall: number | null
  audiences: AudienceScores
}

const MAX_POINTS = 8

// Published reports for one client scored on the same rubric, oldest → newest.
// A different rubric version is a different scale, so it never mixes in.
export async function loadTrend(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  rubricVersion: string | null,
): Promise<TrendPoint[]> {
  if (!rubricVersion) return []
  const { data, error } = await supabase
    .from('visibility_reports')
    .select('published_at, overall_score, audience_scores')
    .eq('session_id', sessionId)
    .eq('status', 'published')
    .eq('rubric_version', rubricVersion)
    .order('published_at', { ascending: false })
    .limit(MAX_POINTS)
  if (error) {
    console.warn('[visibility] trend lookup failed (non-fatal):', error.message)
    return []
  }
  return (data ?? [])
    .filter((r) => r.published_at && r.audience_scores)
    .map((r) => ({
      date: r.published_at as string,
      overall: r.overall_score,
      audiences: r.audience_scores as unknown as AudienceScores,
    }))
    .reverse()
}
