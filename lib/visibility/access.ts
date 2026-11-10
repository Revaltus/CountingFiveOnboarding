import { NextResponse } from 'next/server'
import { requireOnboardingSessionAccess, type CurrentUser } from '@/lib/auth/access'
import { isUuid } from '@/lib/design/input-validation'
import { createServerClient } from '@/lib/supabase/server'
import type { Database } from '@/types/database'

export type VisibilityReportRow = Database['public']['Tables']['visibility_reports']['Row']

// Resolve a report's client, then apply the client gate (admins + managers
// assigned to that client). A missing or malformed id is a 404 either way.
export async function loadReportForUser(
  reportId: string,
): Promise<{ user: CurrentUser; report: VisibilityReportRow } | NextResponse> {
  if (!isUuid(reportId)) return NextResponse.json({ error: 'Report not found' }, { status: 404 })
  const { data: report, error } = await createServerClient()
    .from('visibility_reports')
    .select('*')
    .eq('id', reportId)
    .maybeSingle()
  if (error) {
    console.error('[visibility] report lookup failed:', error)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
  if (!report) return NextResponse.json({ error: 'Report not found' }, { status: 404 })
  const gate = await requireOnboardingSessionAccess(report.session_id)
  if (gate instanceof NextResponse) return gate
  return { user: gate.user, report }
}
