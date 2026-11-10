import { AUDIENCES } from '@/lib/visibility/audiences'
import type { VisibilityNarrative, VisibilityResult } from '@/lib/visibility/types'
import { AudienceArc } from './AudienceArc'
import { AudienceBadge, AudienceScoreChip } from './AudienceBadge'
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
      <div className="grid items-center gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div>
          <h2 className="text-xs font-heading font-semibold uppercase tracking-wide text-brand-cyan">Overview</h2>
          <p className="mt-2 whitespace-pre-line text-base font-body leading-relaxed text-text-primary">{narrative.overview}</p>
          <ul className="mt-5 space-y-1.5">
            {AUDIENCES.map((a) => (
              <li key={a.key} className="flex items-center gap-3 text-sm font-body">
                <AudienceBadge audience={a.key} size="sm" />
                <span className="min-w-0 flex-1 text-text-primary">
                  <span className="font-heading font-semibold">{a.label}</span>{' '}
                  <span className="text-text-secondary">— {a.question}</span>
                </span>
                <AudienceScoreChip audience={a.key} score={result.audienceScores[a.key]?.score ?? null} />
              </li>
            ))}
          </ul>
        </div>
        <AudienceArc scores={result.audienceScores} overall={result.overallScore} className="w-full" />
      </div>

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
