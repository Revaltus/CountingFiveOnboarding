import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ReportList, type ReportListRow } from '@/components/visibility/ReportList'
import { RunReportDialog } from '@/components/visibility/RunReportDialog'
import { getAccessibleSessionIds, getCurrentUser, hasOnboardingAccess } from '@/lib/auth/access'
import { createServerClient } from '@/lib/supabase/server'
import { isLiveHost } from '@/lib/visibility/live-host'
import { resolveDefaultReportUrl } from '@/lib/visibility/report-url'
import type { AudienceScores } from '@/lib/visibility/types'
import type { SessionSchema } from '@/types/session-schema'

export default async function VisibilityReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // Same gate as the API: admins, plus managers assigned to this client.
  const user = await getCurrentUser()
  if (!user) redirect('/admin/login')
  if (!hasOnboardingAccess(user)) notFound()
  if (!user.isAdmin) {
    const allowed = await getAccessibleSessionIds(user)
    if (!allowed?.includes(id)) notFound()
  }

  const supabase = createServerClient()
  const [{ data: session }, { data: job }, { data: rows }] = await Promise.all([
    supabase.from('sessions').select('id, website_url, live_site_url, schema_data').eq('id', id).maybeSingle(),
    supabase.from('content_jobs').select('id, github_repo, phase').eq('session_id', id).maybeSingle(),
    supabase
      .from('visibility_reports')
      .select('id, url, status, status_detail, error, overall_score, overall_grade, audience_scores, rubric_version, created_at, published_at')
      .eq('session_id', id)
      .order('created_at', { ascending: false })
      .limit(50),
  ])
  if (!session) notFound()

  const firmName = (session.schema_data as SessionSchema | null)?.business?.name?.trim() || session.website_url
  // Content-ready clients (phase 6 + repo) live in the editor, so go back there.
  const backToEditor = !!job?.github_repo && (job?.phase ?? 0) >= 6
  const suggested = await resolveDefaultReportUrl({
    liveSiteUrl: session.live_site_url,
    websiteUrl: session.website_url,
    jobId: job?.id ?? null,
    githubRepo: job?.github_repo ?? null,
  })

  const reports: ReportListRow[] = (rows ?? []).map((r) => ({
    id: r.id,
    url: r.url,
    status: r.status,
    statusDetail: r.status_detail,
    error: r.error,
    overallScore: r.overall_score,
    audienceScores: (r.audience_scores as unknown as AudienceScores | null) ?? null,
    createdAt: r.created_at,
    publishedAt: r.published_at,
  }))

  return (
    <main className="p-8 max-w-[1100px] mx-auto">
      <div className="mb-8">
        <Link href={backToEditor ? `/admin/content/${id}/edit` : `/admin/content/${id}`} className="text-sm font-body text-text-muted hover:text-brand-cyan transition-colors">
          &larr; Back to {backToEditor ? 'content editor' : 'content workflow'}
        </Link>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-heading font-bold text-brand-navy">Visibility reports</h1>
            <p className="text-text-secondary font-body text-sm mt-1">
              {firmName} · how the rebuilt site serves prospective clients, ideal niche clients, future talent &amp; partners, Google search and AI discovery
            </p>
          </div>
          <RunReportDialog
            sessionId={id}
            suggestedUrl={suggested.url ?? ''}
            suggestedSource={suggested.source}
            suggestedIsLive={suggested.url ? isLiveHost(suggested.url) : true}
          />
        </div>
      </div>

      <ReportList sessionId={id} reports={reports} />
    </main>
  )
}
