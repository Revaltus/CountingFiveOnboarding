import Link from 'next/link'
import { requirePageAccess } from '@/lib/auth/page-guards'
import { loadContentQuality } from './_data'

// Content-quality dashboard: the measurement loop for the generation-quality
// changes. Admin-only (a global operator view, like Token Usage). Always fresh so
// newly scored drafts show immediately.
export const dynamic = 'force-dynamic'

const QA_OPEN_PAGE_CAP = 50

export default async function ContentQualityPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string | string[] }>
}) {
  await requirePageAccess('admin')
  const data = await loadContentQuality()
  // ?kind=<agent>:<kind> narrows the open-findings list to one finding kind.
  const { kind } = await searchParams
  const kindFilter = typeof kind === 'string' && kind ? kind : null
  const openPagesAll = kindFilter ? data.qaOpenPages.filter((p) => p.kinds.includes(kindFilter)) : data.qaOpenPages
  const openPages = openPagesAll.slice(0, QA_OPEN_PAGE_CAP)

  return (
    <div className="px-6 py-8 max-w-[1200px] mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-heading font-bold text-brand-navy">Content Quality</h1>
        <p className="text-sm font-body text-text-secondary mt-1">
          Advisory critic scores across generated site pages and blog/resource drafts. Higher is
          better; a high flag rate or a persistently low dimension is a signal to tune the prompts or
          the MBP inputs.
        </p>
      </header>

      {data.totalScored === 0 ? (
        <div className="bg-surface-card border border-border-default rounded-xl shadow-subtle px-4 py-10 text-center text-text-muted font-body text-sm">
          No critic scores yet. They appear here after content is generated.
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3 mb-6">
            <StatTile label="Scored" value={String(data.totalScored)} sub="pages + drafts" />
            <StatTile
              label="Flagged for review"
              value={`${data.totalFlagged}`}
              sub={`${data.flaggedPct}% of scored`}
              tone={data.flaggedPct >= 40 ? 'warn' : 'default'}
            />
            <StatTile label="Avg overall" value={`${data.avgOverall}/10`} sub="all dimensions" />
          </div>

          <section className="mb-6">
            <h2 className="text-lg font-heading font-bold text-brand-navy mb-3">Average by dimension</h2>
            <div className="bg-surface-card border border-border-default rounded-xl shadow-subtle p-5 space-y-3">
              {data.dims.map((d) => (
                <div key={d.key} className="flex items-center gap-3">
                  <span className="w-44 shrink-0 text-sm font-body text-text-secondary">{d.label}</span>
                  <div className="flex-1 h-2.5 rounded-full bg-surface-subtle overflow-hidden">
                    <div
                      className={`h-full rounded-full ${d.avg >= 7 ? 'bg-success' : d.avg >= 5 ? 'bg-warning' : 'bg-error'}`}
                      style={{ width: `${(d.avg / 10) * 100}%` }}
                    />
                  </div>
                  <span className="w-20 shrink-0 text-right font-mono text-xs text-text-primary tabular-nums">
                    {d.n ? `${d.avg}/10` : '—'}
                  </span>
                </div>
              ))}
              <p className="text-text-muted text-[11px] pt-1">
                Extended dimensions (outline coverage, used firm inputs, differentiation) only appear on
                content scored after they were added, so their sample size may be smaller.
              </p>
            </div>
          </section>

          <section className="mb-6">
            <h2 className="text-lg font-heading font-bold text-brand-navy mb-3">By content type</h2>
            <div className="bg-surface-card border border-border-default rounded-xl shadow-subtle overflow-hidden">
              <table className="w-full text-sm font-body">
                <thead>
                  <tr className="border-b border-border-default bg-surface-header text-left">
                    <th className="px-4 py-3 font-heading font-semibold text-xs uppercase tracking-wide text-text-secondary">Type</th>
                    <th className="px-4 py-3 font-heading font-semibold text-xs uppercase tracking-wide text-text-secondary">Scored</th>
                    <th className="px-4 py-3 font-heading font-semibold text-xs uppercase tracking-wide text-text-secondary">Flagged</th>
                    <th className="px-4 py-3 font-heading font-semibold text-xs uppercase tracking-wide text-text-secondary">Avg overall</th>
                  </tr>
                </thead>
                <tbody>
                  {data.slices.map((s) => (
                    <tr key={s.label} className="border-b border-border-default last:border-0">
                      <td className="px-4 py-3 text-text-primary font-semibold">{s.label}</td>
                      <td className="px-4 py-3 tabular-nums">{s.scored}</td>
                      <td className="px-4 py-3 tabular-nums">
                        {s.flagged}
                        {s.scored > 0 && (
                          <span className="text-text-muted"> ({Math.round((s.flagged / s.scored) * 100)}%)</span>
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums">{s.scored ? `${s.avgOverall}/10` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {data.qa.pages > 0 && (
            <section className="mb-6">
              <h2 className="text-lg font-heading font-bold text-brand-navy mb-3">QA Desk</h2>
              <div className="grid gap-4 sm:grid-cols-5 mb-4">
                <StatTile label="Pass rate" value={`${Math.round(data.qa.passRate * 100)}%`} sub={`${data.qa.pages} page(s) QA'd`} />
                <StatTile label="Avg accuracy" value={`${data.qa.avgScores.accuracy}/10`} sub="accuracy score" />
                <StatTile label="Avg copy" value={`${data.qa.avgScores.copy}/10`} sub="copy score" />
                <StatTile label="Avg SEO" value={`${data.qa.avgScores.seo}/10`} sub="SEO/GEO score" />
                <StatTile label="Avg structure" value={`${data.qa.avgScores.structure}/10`} sub="structure score" />
              </div>
              <div className="bg-surface-card border border-border-default rounded-xl shadow-subtle overflow-hidden">
                <table className="w-full text-sm font-body">
                  <thead>
                    <tr className="border-b border-border-default bg-surface-header text-left">
                      <th className="px-4 py-3 font-heading font-semibold text-xs uppercase tracking-wide text-text-secondary">Agent</th>
                      <th className="px-4 py-3 font-heading font-semibold text-xs uppercase tracking-wide text-text-secondary">Kind</th>
                      <th className="px-4 py-3 font-heading font-semibold text-xs uppercase tracking-wide text-text-secondary">Applied</th>
                      <th className="px-4 py-3 font-heading font-semibold text-xs uppercase tracking-wide text-text-secondary">Open</th>
                      <th className="px-4 py-3 font-heading font-semibold text-xs uppercase tracking-wide text-text-secondary">Accepted</th>
                      <th className="px-4 py-3 font-heading font-semibold text-xs uppercase tracking-wide text-text-secondary">Dismissed</th>
                      <th className="px-4 py-3 font-heading font-semibold text-xs uppercase tracking-wide text-text-secondary">Dismiss rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.qa.byKind.map((k) => (
                      <tr key={`${k.agent}-${k.kind}`} className="border-b border-border-default last:border-0">
                        <td className="px-4 py-3 text-text-primary font-semibold">{k.agent}</td>
                        <td className="px-4 py-3 text-text-secondary">
                          {k.open > 0 ? (
                            <Link
                              href={`/admin/content-quality?kind=${encodeURIComponent(`${k.agent}:${k.kind}`)}#qa-open`}
                              className="text-brand-cyan hover:underline"
                              title="Show pages with this open finding"
                            >
                              {k.kind}
                            </Link>
                          ) : (
                            k.kind
                          )}
                        </td>
                        <td className="px-4 py-3 tabular-nums">{k.applied}</td>
                        <td className="px-4 py-3 tabular-nums">{k.open}</td>
                        <td className="px-4 py-3 tabular-nums">{k.accepted}</td>
                        <td className="px-4 py-3 tabular-nums">{k.dismissed}</td>
                        <td
                          className={`px-4 py-3 tabular-nums ${k.dismissRate > 0.4 ? 'text-warning-strong font-semibold' : ''}`}
                        >
                          {Math.round(k.dismissRate * 100)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-text-muted text-[11px] pt-2">
                High dismiss rate = QA is wrong here too often; demote this kind to flag-only or fix its prompt.
                Click a kind to list the pages that have it open.
              </p>
            </section>
          )}

          {data.qaOpenPages.length > 0 && (
            <section id="qa-open" className="mb-6 scroll-mt-6">
              <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
                <h2 className="text-lg font-heading font-bold text-brand-navy">
                  Pages with open QA findings
                  {kindFilter && <span className="font-mono text-sm text-text-secondary"> · {kindFilter}</span>}
                </h2>
                {kindFilter && (
                  <Link href="/admin/content-quality#qa-open" className="text-xs font-body text-brand-cyan hover:underline">
                    Clear filter
                  </Link>
                )}
              </div>
              <div className="bg-surface-card border border-border-default rounded-xl shadow-subtle overflow-hidden">
                {openPages.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm font-body text-text-muted">No pages have this finding open.</p>
                ) : (
                  <ul className="divide-y divide-border-default">
                    {openPages.map((p) => (
                      <li key={p.href ?? `${p.site}-${p.label}`} className="flex items-center gap-3 px-4 py-2.5">
                        <span className="w-48 shrink-0 truncate text-sm font-body font-semibold text-text-primary">
                          {p.site ?? 'Unknown site'}
                        </span>
                        <span className="flex-1 min-w-0 truncate text-sm font-body text-text-secondary">
                          {p.href ? (
                            <Link href={p.href} className="hover:underline">
                              {p.label}
                            </Link>
                          ) : (
                            p.label
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                          {p.open} open
                          {p.highOpen > 0 && <span className="text-error font-semibold"> · {p.highOpen} high</span>}
                        </span>
                        {p.href && (
                          <Link
                            href={p.href}
                            className="shrink-0 px-3 py-1 text-xs font-heading font-semibold bg-brand-cyan text-text-inverse rounded-pill hover:opacity-90 transition-opacity"
                          >
                            Review
                          </Link>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {openPagesAll.length > openPages.length && (
                <p className="text-text-muted text-[11px] pt-2">
                  Showing the {openPages.length} most urgent of {openPagesAll.length} pages.
                </p>
              )}
            </section>
          )}

          {data.recentFlagged.length > 0 && (
            <section>
              <h2 className="text-lg font-heading font-bold text-brand-navy mb-3">
                Recently flagged for review
              </h2>
              <div className="bg-surface-card border border-border-default rounded-xl shadow-subtle overflow-hidden">
                <ul className="divide-y divide-border-default">
                  {data.recentFlagged.map((f, i) => (
                    <li key={`${f.label}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="inline-flex shrink-0 items-center rounded-full bg-brand-navy/10 px-2 py-0.5 text-[10px] font-heading font-semibold text-brand-navy">
                        {f.kind}
                      </span>
                      <span className="w-48 shrink-0 truncate text-sm font-body font-semibold text-text-primary">
                        {f.href ? (
                          <Link href={f.href} className="hover:underline">
                            {f.site ?? 'Unknown site'}
                          </Link>
                        ) : (
                          f.site ?? 'Unknown site'
                        )}
                      </span>
                      <span className="flex-1 truncate text-sm font-body text-text-secondary">{f.label}</span>
                      <span className="shrink-0 font-mono text-xs text-text-muted tabular-nums">{f.overall}/10</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function StatTile({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string
  value: string
  sub: string
  tone?: 'default' | 'warn'
}) {
  return (
    <div className="bg-surface-card border border-border-default rounded-xl shadow-subtle p-5">
      <p className="text-xs font-heading font-semibold text-text-muted uppercase tracking-wide truncate">{label}</p>
      <p
        className={`text-2xl font-heading font-bold mt-1 tabular-nums ${tone === 'warn' ? 'text-warning-strong' : 'text-brand-navy'}`}
      >
        {value}
      </p>
      <p className="text-sm font-body text-text-secondary mt-1 tabular-nums">{sub}</p>
    </div>
  )
}
