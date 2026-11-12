import { AUDIENCES } from '@/lib/visibility/audiences'
import type { TrendPoint } from '@/lib/visibility/trend'
import { AudienceBadge } from './AudienceBadge'
import { AUD_BG_TINT } from './audience-styles'

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

// Oldest → newest columns; shown once there are at least two comparable reports.
export function TrendTable({ points }: { points: TrendPoint[] }) {
  if (points.length < 2) return null
  return (
    <div className="overflow-x-auto rounded-xl border border-border-default bg-surface-card shadow-subtle">
      <table className="w-full text-sm font-body">
        <thead className="bg-surface-header">
          <tr>
            <th className="px-4 py-2 text-left font-heading text-xs font-semibold text-text-secondary">Audience</th>
            {points.map((p) => (
              <th key={p.date} className="px-4 py-2 text-right font-heading text-xs font-semibold text-text-secondary">{fmt(p.date)}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-default">
          <tr>
            <td className="px-4 py-2 font-heading font-semibold text-brand-navy">Overall</td>
            {points.map((p) => <td key={p.date} className="px-4 py-2 text-right font-semibold text-brand-navy">{p.overall ?? '—'}</td>)}
          </tr>
          {AUDIENCES.map((a) => (
            <tr key={a.key} className={AUD_BG_TINT[a.key]}>
              <td className="px-4 py-2 text-text-primary">
                <span className="flex items-center gap-2">
                  <AudienceBadge audience={a.key} size="sm" />
                  {a.label}
                </span>
              </td>
              {points.map((p) => <td key={p.date} className="px-4 py-2 text-right text-text-primary">{p.audiences[a.key]?.score ?? '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
