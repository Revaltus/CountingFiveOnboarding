import type { AudienceMeta } from '@/lib/visibility/audiences'
import type { AudienceScore, CheckResult, VisibilityNarrativeSection } from '@/lib/visibility/types'
import { AUD_BG, AUD_BORDER } from './audience-styles'
import { CheckList } from './CheckList'

export function AudienceSection({
  meta,
  score,
  section,
  checks,
  checksOpen = false,
}: {
  meta: AudienceMeta
  score: AudienceScore
  section: VisibilityNarrativeSection
  checks: CheckResult[]
  checksOpen?: boolean
}) {
  return (
    <section className={`rounded-xl border border-border-default border-l-4 ${AUD_BORDER[meta.key]} bg-surface-card p-6 shadow-subtle`}>
      <div className="flex items-start gap-4">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${AUD_BG[meta.key]} font-heading text-sm font-bold text-text-inverse`}>
          {meta.n}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-heading font-bold text-brand-navy">{meta.label}</h2>
          <p className="text-sm font-body text-text-secondary">{meta.question}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-heading font-bold text-brand-navy">{score.score ?? '—'}</p>
          {score.grade && <p className="text-xs font-body text-text-muted">Grade {score.grade}</p>}
        </div>
      </div>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <div>
          <h3 className="text-xs font-heading font-semibold uppercase tracking-wide text-success">What&rsquo;s working</h3>
          {section.wins.length ? (
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm font-body text-text-primary">
              {section.wins.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          ) : (
            <p className="mt-2 text-sm font-body text-text-muted">Nothing to highlight yet.</p>
          )}
        </div>
        <div>
          <h3 className="text-xs font-heading font-semibold uppercase tracking-wide text-brand-cyan">Next opportunities</h3>
          {section.opportunities.length ? (
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm font-body text-text-primary">
              {section.opportunities.map((o, i) => <li key={i}>{o}</li>)}
            </ul>
          ) : (
            <p className="mt-2 text-sm font-body text-text-muted">No open opportunities.</p>
          )}
        </div>
      </div>

      <details className="mt-5 group" open={checksOpen}>
        <summary className="cursor-pointer text-xs font-heading font-semibold text-text-secondary hover:text-brand-cyan">
          What we checked ({checks.length})
        </summary>
        <div className="mt-2">
          <CheckList checks={checks} />
        </div>
      </details>
    </section>
  )
}
