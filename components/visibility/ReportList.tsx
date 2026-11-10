'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AUDIENCES } from '@/lib/visibility/audiences'
import type { AudienceScores } from '@/lib/visibility/types'
import { AudienceScoreChip } from './AudienceBadge'

export interface ReportListRow {
  id: string
  url: string
  status: string
  statusDetail: string | null
  error: string | null
  overallScore: number | null
  audienceScores: AudienceScores | null
  createdAt: string
  publishedAt: string | null
}

const POLL_MS = 4000

const STATUS_CHIP: Record<string, string> = {
  queued: 'bg-surface-subtle text-text-secondary',
  running: 'bg-info/10 text-info',
  draft: 'bg-warning/15 text-warning-strong',
  published: 'bg-success/10 text-success',
  error: 'bg-error/10 text-error',
}

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export function ReportList({ sessionId, reports }: { sessionId: string; reports: ReportListRow[] }) {
  const router = useRouter()
  const [details, setDetails] = useState<Record<string, string | null>>({})
  const [retrying, setRetrying] = useState<string | null>(null)
  const running = reports.filter((r) => r.status === 'running' || r.status === 'queued').map((r) => r.id)
  const runningKey = running.join(',')

  useEffect(() => {
    if (!runningKey) return
    const ids = runningKey.split(',')
    const timer = setInterval(async () => {
      let finished = false
      for (const id of ids) {
        const res = await fetch(`/api/visibility-reports/${id}`).catch(() => null)
        if (!res?.ok) continue
        const { report } = (await res.json()) as { report: { status: string; status_detail: string | null } }
        if (report.status !== 'running' && report.status !== 'queued') finished = true
        setDetails((d) => ({ ...d, [id]: report.status_detail }))
      }
      if (finished) router.refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [runningKey, router])

  const retry = async (id: string) => {
    setRetrying(id)
    await fetch(`/api/visibility-reports/${id}/run`, { method: 'POST' }).catch(() => null)
    setRetrying(null)
    router.refresh()
  }

  if (!reports.length) {
    return (
      <div className="rounded-xl border border-dashed border-border-strong bg-surface-card p-10 text-center">
        <p className="text-sm font-body text-text-secondary">No visibility reports yet. Run the first one to set this client&rsquo;s baseline.</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border-default bg-surface-card shadow-subtle">
      <table className="w-full text-sm font-body">
        <thead className="bg-surface-header">
          <tr className="text-left">
            <th className="px-4 py-2 font-heading text-xs font-semibold text-text-secondary">Date</th>
            <th className="px-4 py-2 font-heading text-xs font-semibold text-text-secondary">Site</th>
            <th className="px-4 py-2 font-heading text-xs font-semibold text-text-secondary">Status</th>
            <th className="px-4 py-2 text-right font-heading text-xs font-semibold text-text-secondary">Overall</th>
            <th className="px-4 py-2 font-heading text-xs font-semibold text-text-secondary">Audiences</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border-default">
          {reports.map((r) => {
            const live = r.status === 'running' || r.status === 'queued'
            return (
              <tr key={r.id}>
                <td className="whitespace-nowrap px-4 py-3 text-text-primary">{fmt(r.publishedAt ?? r.createdAt)}</td>
                <td className="max-w-[240px] truncate px-4 py-3 text-text-secondary" title={r.url}>{r.url.replace(/^https?:\/\//, '')}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-badge px-2 py-0.5 text-[11px] font-heading font-semibold ${STATUS_CHIP[r.status] ?? STATUS_CHIP.queued}`}>
                    {r.status}
                  </span>
                  {live && <p className="mt-1 text-xs text-text-muted">{details[r.id] ?? r.statusDetail ?? 'Waiting to start…'}</p>}
                  {r.status === 'error' && <p className="mt-1 max-w-[260px] text-xs text-error">{r.error}</p>}
                </td>
                <td className="px-4 py-3 text-right font-heading font-bold text-brand-navy">{r.overallScore ?? '—'}</td>
                <td className="px-4 py-3">
                  {r.audienceScores && (
                    <div className="flex gap-1.5">
                      {AUDIENCES.map((a) => (
                        <AudienceScoreChip key={a.key} audience={a.key} score={r.audienceScores?.[a.key]?.score ?? null} />
                      ))}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  {r.status === 'error' ? (
                    <button type="button" onClick={() => retry(r.id)} disabled={retrying === r.id} className="text-xs font-heading font-semibold text-brand-cyan hover:underline disabled:opacity-50">
                      {retrying === r.id ? 'Retrying…' : 'Retry'}
                    </button>
                  ) : r.status === 'draft' || r.status === 'published' ? (
                    <Link href={`/admin/content/${sessionId}/visibility/${r.id}`} className="text-xs font-heading font-semibold text-brand-cyan hover:underline">
                      {r.status === 'draft' ? 'Review & publish' : 'Open'}
                    </Link>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
