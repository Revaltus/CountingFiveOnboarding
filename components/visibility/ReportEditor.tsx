'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AUDIENCES } from '@/lib/visibility/audiences'
import { NARRATIVE_LIMITS } from '@/lib/visibility/narrative'
import type { TrendPoint } from '@/lib/visibility/trend'
import type { AudienceKey, VisibilityNarrative, VisibilityResult } from '@/lib/visibility/types'
import { ReportBody } from './ReportBody'
import { AudienceBadge } from './AudienceBadge'
import { AUD_BG_TINT, AUD_BORDER } from './audience-styles'

const inputCls =
  'w-full rounded-lg border border-border-default bg-surface-card px-3 py-2 font-body text-sm text-text-primary focus:border-brand-cyan focus:outline-none'
const labelCls = 'block text-xs font-heading font-semibold text-text-secondary mb-1'
const primaryBtn =
  'bg-brand-cyan text-text-inverse font-heading font-semibold text-sm px-4 py-2 rounded-pill transition-all hover:bg-brand-cyan-dark disabled:opacity-50 disabled:cursor-not-allowed'
const secondaryBtn =
  'border border-brand-cyan text-brand-cyan font-heading font-semibold text-sm px-4 py-2 rounded-pill transition-colors hover:bg-brand-cyan/10 disabled:opacity-50 disabled:cursor-not-allowed'

const toLines = (items: string[]) => items.join('\n')
const fromLines = (text: string) => text.split('\n').map((s) => s.trim()).filter(Boolean)

type Drafts = { overview: string; audiences: Record<AudienceKey, { wins: string; opportunities: string }> }

function toDrafts(n: VisibilityNarrative): Drafts {
  return {
    overview: n.overview,
    audiences: Object.fromEntries(
      AUDIENCES.map((a) => [a.key, { wins: toLines(n.audiences[a.key].wins), opportunities: toLines(n.audiences[a.key].opportunities) }]),
    ) as Drafts['audiences'],
  }
}

function fromDrafts(d: Drafts): VisibilityNarrative {
  return {
    overview: d.overview.trim(),
    audiences: Object.fromEntries(
      AUDIENCES.map((a) => [a.key, { wins: fromLines(d.audiences[a.key].wins), opportunities: fromLines(d.audiences[a.key].opportunities) }]),
    ) as VisibilityNarrative['audiences'],
  }
}

export function ReportEditor({
  reportId,
  firmName,
  status,
  shareToken,
  result,
  narrative,
  trend,
  createdAt,
}: {
  reportId: string
  firmName: string
  status: string
  shareToken: string | null
  result: VisibilityResult
  narrative: VisibilityNarrative
  trend: TrendPoint[]
  createdAt: string
}) {
  const router = useRouter()
  const isDraft = status === 'draft'
  const [saved, setSaved] = useState(narrative)
  const [drafts, setDrafts] = useState<Drafts>(() => toDrafts(narrative))
  const [busy, setBusy] = useState<null | 'save' | 'publish' | 'unpublish'>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const current = fromDrafts(drafts)
  const dirty = JSON.stringify(current) !== JSON.stringify(saved)

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const call = async (kind: 'save' | 'publish' | 'unpublish') => {
    setBusy(kind)
    setMessage(null)
    try {
      const res =
        kind === 'save'
          ? await fetch(`/api/visibility-reports/${reportId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ narrative: current }) })
          : await fetch(`/api/visibility-reports/${reportId}/publish`, { method: kind === 'publish' ? 'POST' : 'DELETE' })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(body.error ?? 'Something went wrong. Please try again.')
      if (kind === 'save') {
        setSaved(current)
        setMessage({ kind: 'ok', text: 'Saved.' })
      } else {
        router.refresh()
      }
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Something went wrong.' })
    } finally {
      setBusy(null)
    }
  }

  const setAudience = (key: AudienceKey, field: 'wins' | 'opportunities', value: string) =>
    setDrafts((d) => ({ ...d, audiences: { ...d.audiences, [key]: { ...d.audiences[key], [field]: value } } }))

  return (
    <div className="mt-4 space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-heading font-bold text-brand-navy">Visibility report · {firmName}</h1>
          <p className="mt-1 text-sm font-body text-text-secondary">
            {result.domain} · run {new Date(createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} ·{' '}
            <span className="font-semibold">{isDraft ? 'Draft — not visible to the client' : 'Published'}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {message && <span className={`text-xs font-body ${message.kind === 'ok' ? 'text-success' : 'text-error'}`}>{message.text}</span>}
          {isDraft ? (
            <>
              <button type="button" onClick={() => call('save')} disabled={!dirty || busy !== null} className={secondaryBtn}>
                {busy === 'save' ? 'Saving…' : 'Save changes'}
              </button>
              <button type="button" onClick={() => call('publish')} disabled={dirty || busy !== null} className={primaryBtn} title={dirty ? 'Save your changes first' : undefined}>
                {busy === 'publish' ? 'Publishing…' : 'Publish'}
              </button>
            </>
          ) : (
            <>
              <a href={`/api/visibility-reports/${reportId}/pdf`} className={secondaryBtn}>Download PDF</a>
              {shareToken && (
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(`${window.location.origin}/visibility/${shareToken}`)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                  className={secondaryBtn}
                >
                  {copied ? 'Copied' : 'Copy share link'}
                </button>
              )}
              <button type="button" onClick={() => call('unpublish')} disabled={busy !== null} className={secondaryBtn}>
                {busy === 'unpublish' ? 'Unpublishing…' : 'Unpublish'}
              </button>
            </>
          )}
        </div>
      </div>

      {isDraft && (
        <section className="space-y-5 rounded-xl border border-border-default bg-surface-card p-6 shadow-subtle">
          <div>
            <h2 className="text-sm font-heading font-semibold text-brand-navy">Edit the client-facing text</h2>
            <p className="mt-0.5 text-xs font-body text-text-muted">One item per line. Scores and checks come from the crawl and can&rsquo;t be edited.</p>
          </div>
          <div>
            <label htmlFor="overview" className={labelCls}>Overview</label>
            <textarea
              id="overview"
              rows={5}
              maxLength={NARRATIVE_LIMITS.overview}
              value={drafts.overview}
              onChange={(e) => setDrafts((d) => ({ ...d, overview: e.target.value }))}
              className={inputCls}
            />
          </div>
          {AUDIENCES.map((a) => (
            <div key={a.key} className={`rounded-lg border-l-[6px] ${AUD_BORDER[a.key]} ${AUD_BG_TINT[a.key]} p-4`}>
              <p className="mb-3 flex items-center gap-2 text-sm font-heading font-semibold text-brand-navy">
                <AudienceBadge audience={a.key} size="sm" />
                {a.label}
                <span className="font-body font-normal text-text-secondary">— {a.summary}</span>
              </p>
              <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor={`${a.key}-wins`} className={labelCls}>What&rsquo;s working (max {NARRATIVE_LIMITS.wins})</label>
                <textarea id={`${a.key}-wins`} rows={4} value={drafts.audiences[a.key].wins} onChange={(e) => setAudience(a.key, 'wins', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label htmlFor={`${a.key}-opps`} className={labelCls}>Next opportunities (max {NARRATIVE_LIMITS.opportunities})</label>
                <textarea id={`${a.key}-opps`} rows={4} value={drafts.audiences[a.key].opportunities} onChange={(e) => setAudience(a.key, 'opportunities', e.target.value)} className={inputCls} />
              </div>
              </div>
            </div>
          ))}
        </section>
      )}

      <div>
        <h2 className="mb-4 text-xs font-heading font-semibold uppercase tracking-wide text-text-secondary">
          {isDraft ? 'Preview — what the client will see' : 'Published report'}
        </h2>
        <ReportBody result={result} narrative={current} trend={trend} />
      </div>
    </div>
  )
}
