import type { AudienceMeta } from '@/lib/visibility/audiences'
import type { AudienceScore, CheckResult, VisibilityNarrativeSection } from '@/lib/visibility/types'
import { AUD_BG, AUD_BG_TINT, AUD_BORDER, AUD_MARKER } from './audience-styles'
import { AudienceBadge } from './AudienceBadge'
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
  const listCls = `mt-2 list-disc space-y-1.5 pl-5 text-sm font-body text-text-primary ${AUD_MARKER[meta.key]}`
  return (
    <section className={`overflow-hidden rounded-xl border border-border-default border-l-[6px] ${AUD_BORDER[meta.key]} bg-surface-card shadow-subtle`}>
      <div className={`flex items-start gap-4 px-6 py-4 ${AUD_BG_TINT[meta.key]}`}>
        <AudienceBadge audience={meta.key} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-heading font-bold text-brand-navy">{meta.label}</h2>
          <p className="text-sm font-body text-text-primary">{meta.summary}</p>
          <p className="mt-0.5 text-xs font-body text-text-secondary">Content focus: {meta.focus}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-heading font-bold text-brand-navy">{score.score ?? '—'}</p>
          {score.grade && <p className="text-xs font-body text-text-secondary">Grade {score.grade}</p>}
        </div>
      </div>

      <div className="grid gap-5 px-6 py-5 md:grid-cols-2">
        <div>
          <h3 className="flex items-center gap-2 text-xs font-heading font-semibold uppercase tracking-wide text-brand-navy">
            <span aria-hidden="true" className={`h-1 w-5 rounded-full ${AUD_BG[meta.key]}`} />
            What&rsquo;s working
          </h3>
          {section.wins.length ? (
            <ul className={listCls}>{section.wins.map((w, i) => <li key={i}>{w}</li>)}</ul>
          ) : (
            <p className="mt-2 text-sm font-body text-text-muted">Nothing to highlight yet.</p>
          )}
        </div>
        <div>
          <h3 className="flex items-center gap-2 text-xs font-heading font-semibold uppercase tracking-wide text-brand-navy">
            <span aria-hidden="true" className={`h-1 w-5 rounded-full ${AUD_BG[meta.key]}`} />
            Next opportunities
          </h3>
          {section.opportunities.length ? (
            <ul className={listCls}>{section.opportunities.map((o, i) => <li key={i}>{o}</li>)}</ul>
          ) : (
            <p className="mt-2 text-sm font-body text-text-muted">No open opportunities.</p>
          )}
        </div>
      </div>

      <details className="border-t border-border-default px-6 py-3" open={checksOpen}>
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
