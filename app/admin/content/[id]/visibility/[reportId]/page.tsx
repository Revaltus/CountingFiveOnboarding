import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ReportEditor } from '@/components/visibility/ReportEditor'
import { getAccessibleSessionIds, getCurrentUser, hasOnboardingAccess } from '@/lib/auth/access'
import { isUuid } from '@/lib/design/input-validation'
import { createServerClient } from '@/lib/supabase/server'
import { coerceNarrative } from '@/lib/visibility/narrative'
import { loadTrend } from '@/lib/visibility/trend'
import type { VisibilityResult } from '@/lib/visibility/types'
import type { SessionSchema } from '@/types/session-schema'

export default async function VisibilityReportPage({ params }: { params: Promise<{ id: string; reportId: string }> }) {
  const { id, reportId } = await params
  if (!isUuid(reportId)) notFound()

  const user = await getCurrentUser()
  if (!user) redirect('/admin/login')
  if (!hasOnboardingAccess(user)) notFound()
  if (!user.isAdmin) {
    const allowed = await getAccessibleSessionIds(user)
    if (!allowed?.includes(id)) notFound()
  }

  const supabase = createServerClient()
  const [{ data: report }, { data: session }] = await Promise.all([
    supabase.from('visibility_reports').select('*').eq('id', reportId).eq('session_id', id).maybeSingle(),
    supabase.from('sessions').select('website_url, schema_data').eq('id', id).maybeSingle(),
  ])
  const narrative = coerceNarrative(report?.narrative)
  if (!report || !session || !report.result || !narrative || (report.status !== 'draft' && report.status !== 'published')) notFound()

  const trend = await loadTrend(supabase, id, report.rubric_version)
  const firmName = (session.schema_data as SessionSchema | null)?.business?.name?.trim() || session.website_url

  return (
    <main className="p-8 max-w-[1000px] mx-auto">
      <Link href={`/admin/content/${id}/visibility`} className="text-sm font-body text-text-muted hover:text-brand-cyan transition-colors">
        &larr; All visibility reports
      </Link>
      <ReportEditor
        reportId={report.id}
        firmName={firmName}
        status={report.status}
        shareToken={report.share_token}
        result={report.result as unknown as VisibilityResult}
        narrative={narrative}
        trend={trend}
        createdAt={report.created_at}
      />
    </main>
  )
}
