import type { Metadata } from 'next'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import { ReportBody } from '@/components/visibility/ReportBody'
import { isUuid } from '@/lib/design/input-validation'
import { createServerClient } from '@/lib/supabase/server'
import { coerceNarrative } from '@/lib/visibility/narrative'
import { loadTrend } from '@/lib/visibility/trend'
import type { VisibilityResult } from '@/lib/visibility/types'
import type { SessionSchema } from '@/types/session-schema'

export const runtime = 'nodejs'

// Semi-private share link — keep it out of search indexes.
export const metadata: Metadata = { title: 'Visibility Report', robots: { index: false, follow: false } }

export default async function PublicVisibilityReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!isUuid(token)) notFound()
  const supabase = createServerClient()

  // Lookup is by random share token only — never by the internal id.
  const { data: report } = await supabase
    .from('visibility_reports')
    .select('id, session_id, status, result, narrative, rubric_version, published_at')
    .eq('share_token', token)
    .maybeSingle()
  const narrative = coerceNarrative(report?.narrative)
  // Fail closed: unknown token, not published, or no content → 404 (no leak).
  if (!report || report.status !== 'published' || !report.result || !narrative) notFound()
  const result = report.result as unknown as VisibilityResult

  const [{ data: session }, trend] = await Promise.all([
    supabase.from('sessions').select('schema_data').eq('id', report.session_id).maybeSingle(),
    loadTrend(supabase, report.session_id, report.rubric_version),
  ])
  const firmName = (session?.schema_data as SessionSchema | null)?.business?.name?.trim() || result.domain
  const date = new Date(report.published_at ?? result.auditedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <main className="min-h-screen bg-surface-page">
      <header className="bg-brand-navy">
        <div className="mx-auto flex max-w-[1000px] items-center justify-between px-6 py-5">
          <Image src="/logo-white.png" alt="Revaltus" width={140} height={36} className="h-8 w-auto" priority />
          <a
            href={`/api/visibility-reports/${report.id}/pdf?token=${token}`}
            className="rounded-pill border border-text-inverse/40 px-4 py-1.5 font-heading text-xs font-semibold text-text-inverse transition-colors hover:bg-text-inverse/10"
          >
            Download PDF
          </a>
        </div>
      </header>
      <div className="mx-auto max-w-[1000px] px-6 py-10">
        <p className="text-xs font-heading font-semibold uppercase tracking-wide text-brand-cyan">Visibility Report</p>
        <h1 className="mt-1 text-3xl font-heading font-bold text-brand-navy">{firmName}</h1>
        <p className="mt-1 text-sm font-body text-text-secondary">{result.domain} · {date}</p>
        <div className="mt-8">
          <ReportBody result={result} narrative={narrative} trend={trend} />
        </div>
      </div>
    </main>
  )
}
