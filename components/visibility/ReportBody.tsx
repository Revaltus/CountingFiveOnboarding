import { AUDIENCES } from '@/lib/visibility/audiences'
import type { VisibilityNarrative, VisibilityResult } from '@/lib/visibility/types'
import { AudienceOverview } from './AudienceOverview'
import { AudienceSection } from './AudienceSection'
import type { TrendPoint } from '@/lib/visibility/trend'
import { TrendTable } from './TrendTable'

const UNAVAILABLE_COPY: Record<string, string> = {
  ranks: 'Google rankings',
  gbp: 'Google Business Profile',
  probe: 'AI answer check',
  ai_review: 'AI review',
}

// Shared by the public share page and the admin detail page (read-only view).
export function ReportBody({
  result,
  narrative,
  trend,
}: {
  result: VisibilityResult
  narrative: VisibilityNarrative
  trend: TrendPoint[]
}) {
  const skipped = result.unavailable.map((u) => UNAVAILABLE_COPY[u]).filter(Boolean)
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xs font-heading font-semibold uppercase tracking-wide text-brand-cyan">Overview</h2>
        <p className="mt-2 whitespace-pre-line text-base font-body leading-relaxed text-text-primary">{narrative.overview}</p>
      </div>

      <AudienceOverview scores={result.audienceScores} overall={result.overallScore} />

      {AUDIENCES.map((a) => (
        <AudienceSection
          key={a.key}
          meta={a}
          score={result.audienceScores[a.key]}
          section={narrative.audiences[a.key]}
          checks={result.checks.filter((c) => c.audience === a.key)}
        />
      ))}

      {trend.length >= 2 && (
        <div>
          <h2 className="mb-3 text-lg font-heading font-bold text-brand-navy">Progress over time</h2>
          <TrendTable points={trend} />
        </div>
      )}

      <p className="text-xs font-body text-text-muted">
        {result.pagesCrawled} pages reviewed on {result.domain}.
        {skipped.length > 0 && ` Not included in this report: ${skipped.join(', ')}${result.isLiveDomain ? '' : ' (available once the site is on its live domain)'}.`}
      </p>
    </div>
  )
}
