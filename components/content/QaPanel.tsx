'use client'

import { useEffect, useState } from 'react'
import { parseQaReview, type Finding, type PatchTarget, type QaSeverity } from '@/types/qa-review'
import { criticOverall } from '@/lib/content/critic-review'

const SEVERITY_ORDER: Record<QaSeverity, number> = { high: 0, med: 1, low: 2 }
const SEVERITY_DOT: Record<QaSeverity, string> = { high: 'bg-error', med: 'bg-warning', low: 'bg-info' }
const AGENT_LABEL: Record<string, string> = {
  rules: 'Rules',
  accuracy: 'Accuracy',
  copy: 'Copy',
  seo: 'SEO & GEO',
  structure: 'Structure',
  judge: 'Judge',
}

const PATCH_TARGET_LABEL: Record<PatchTarget, string> = {
  body: 'Body',
  meta_title: 'Meta title',
  meta_description: 'Meta description',
}

// The QA Desk's human review surface: a background multi-agent pass already
// auto-fixed what it safely could and left the rest here as "needs you"
// findings. Apply/Dismiss call the per-finding PATCH route; this component
// never writes to Supabase directly. Renders nothing until a QaReview parses.
export default function QaPanel({
  jobId,
  pageId,
  review,
  onPageUpdated,
}: {
  jobId: string
  pageId: string
  review: unknown
  onPageUpdated: (page: unknown) => void
}) {
  const [qaReview, setQaReview] = useState(() => parseQaReview(review))
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [changedOpen, setChangedOpen] = useState(false)

  // Re-sync when the parent reloads/replaces the page (e.g. a fresh GET after
  // this panel's own write round-trips back through onPageUpdated).
  useEffect(() => {
    setQaReview(parseQaReview(review))
  }, [review])

  if (!qaReview) return null

  const open = qaReview.findings
    .filter(f => f.status === 'open')
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  // "What QA changed" covers both the background pass's own auto-applied
  // fixes (`applied`) and a human's just-clicked Apply (`accepted`) — both
  // represent a patch or variant fix that actually landed in the content.
  const changed = qaReview.findings.filter(f => f.status === 'applied' || f.status === 'accepted')
  const judgeOverall = qaReview.judge ? criticOverall(qaReview.judge) : null

  const act = async (finding: Finding, action: 'apply' | 'dismiss') => {
    setPending(prev => new Set(prev).add(finding.id))
    setRowErrors(prev => {
      if (!(finding.id in prev)) return prev
      const next = { ...prev }
      delete next[finding.id]
      return next
    })
    try {
      const res = await fetch(`/api/content-jobs/${jobId}/pages/${pageId}/qa-findings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findingId: finding.id, action }),
      })
      const data = (await res.json().catch(() => ({}))) as { page?: unknown; qaReview?: unknown; error?: string }
      if (!res.ok) {
        setRowErrors(prev => ({ ...prev, [finding.id]: data.error ?? `Couldn't ${action} this finding (${res.status})` }))
        return
      }
      setQaReview(parseQaReview(data.qaReview))
      onPageUpdated(data.page)
    } catch (err) {
      setRowErrors(prev => ({ ...prev, [finding.id]: err instanceof Error ? err.message : `Couldn't ${action} this finding` }))
    } finally {
      setPending(prev => {
        const next = new Set(prev)
        next.delete(finding.id)
        return next
      })
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-border-default bg-surface-subtle">
      <div className="px-3 py-2 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-heading font-semibold text-text-secondary uppercase tracking-wide">
            Automated QA
          </span>
          <ScorePill label="Accuracy" value={qaReview.scores.accuracy} />
          <ScorePill label="Copy" value={qaReview.scores.copy} />
          <ScorePill label="SEO & GEO" value={qaReview.scores.seo} />
          <ScorePill label="Structure" value={qaReview.scores.structure} />
          {judgeOverall != null && <ScorePill label="Judge overall" value={judgeOverall} />}
        </div>
        {qaReview.mode === 'shadow' && (
          <span className="text-xs font-mono px-1.5 py-0.5 rounded text-info bg-info/10">
            Shadow mode
          </span>
        )}
      </div>

      {qaReview.mode === 'shadow' && open.length > 0 && (
        <p className="px-3 pb-2 text-xs font-body text-text-muted">
          Shadow mode: QA didn&apos;t change this page. Review the suggestions below and apply the ones you want.
        </p>
      )}

      {open.length > 0 && (
        <div className="border-t border-border-default px-3 py-2 space-y-2">
          <div className="text-xs font-heading font-semibold text-text-secondary uppercase tracking-wide">
            {qaReview.mode === 'shadow' ? 'Findings' : 'Needs you'} ({open.length})
          </div>
          {open.map(f => (
            <FindingRow
              key={f.id}
              finding={f}
              busy={pending.has(f.id)}
              error={rowErrors[f.id]}
              onApply={() => act(f, 'apply')}
              onDismiss={() => act(f, 'dismiss')}
            />
          ))}
        </div>
      )}

      {changed.length > 0 && (
        <div className="border-t border-border-default">
          <button
            type="button"
            onClick={() => setChangedOpen(o => !o)}
            className="w-full flex items-center justify-between px-3 py-2 text-left"
            aria-expanded={changedOpen}
          >
            <span className="text-xs font-heading font-semibold text-text-secondary uppercase tracking-wide">
              What QA changed ({changed.length})
            </span>
            <span className="text-text-muted text-xs">{changedOpen ? '▲' : '▾'}</span>
          </button>
          {changedOpen && (
            <div className="px-3 pb-3 space-y-2 text-xs font-body">
              {changed.map(f => (
                <div key={f.id} className="border-t border-border-default pt-2 first:border-t-0 first:pt-0">
                  <div className="text-text-secondary">
                    <span className="font-heading font-semibold">{AGENT_LABEL[f.agent] ?? f.agent}</span>: {f.message}
                  </div>
                  <FixPreview finding={f} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {open.length === 0 && changed.length === 0 && (
        <p className="px-3 pb-3 text-xs font-body text-text-muted">No findings — this page passed clean.</p>
      )}
    </div>
  )
}

function ScorePill({ label, value }: { label: string; value: number }) {
  const cls =
    value >= 8 ? 'text-success bg-success/10'
      : value >= 6 ? 'text-warning-strong bg-warning/10'
        : 'text-error bg-error/10'
  return (
    <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${cls}`} title={`${label}: ${value}/10`}>
      {label} {value}/10
    </span>
  )
}

function FindingRow({
  finding,
  busy,
  error,
  onApply,
  onDismiss,
}: {
  finding: Finding
  busy: boolean
  error?: string
  onApply: () => void
  onDismiss: () => void
}) {
  const canApply = !!(finding.patch || finding.variantFix)
  return (
    <div className="border-t border-border-default pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-2">
        <span
          className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${SEVERITY_DOT[finding.severity]}`}
          aria-hidden="true"
          title={`${finding.severity} priority`}
        />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-body text-text-primary">
            <span className="font-heading font-semibold text-text-secondary">{AGENT_LABEL[finding.agent] ?? finding.agent}</span>{' '}
            <span className="font-mono text-[10px] px-1 py-0.5 rounded bg-surface-card border border-border-default text-text-muted">{finding.kind}</span>{' '}
            {finding.message}
          </div>
          {finding.quote && (
            <blockquote className="mt-1 border-l-2 border-border-default bg-surface-subtle pl-2 py-1 text-[11px] font-mono text-text-muted italic">
              &ldquo;{finding.quote}&rdquo;
            </blockquote>
          )}
          {canApply ? (
            <div className="mt-1 text-[11px] font-body text-text-secondary">
              <span className="font-heading font-semibold">Suggested change</span>
              {finding.patch && <span className="text-text-muted"> · {PATCH_TARGET_LABEL[finding.patch.target]}</span>}
              <FixPreview finding={finding} />
            </div>
          ) : (
            <div className="mt-1 text-[11px] font-body text-text-muted">No automatic fix — edit the page by hand, or dismiss.</div>
          )}
          {error && (
            <div role="alert" className="mt-1 text-[11px] font-body text-error">
              {error}
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-2">
            {canApply && (
              <button
                type="button"
                onClick={onApply}
                disabled={busy}
                className="px-3 py-1 text-xs font-heading font-semibold bg-brand-cyan text-text-inverse rounded-pill hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? '…' : 'Apply'}
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              disabled={busy}
              className="px-3 py-1 text-xs font-heading font-semibold border border-border-default rounded-pill text-text-secondary hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? '…' : 'Dismiss'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function FixPreview({ finding }: { finding: Finding }) {
  if (finding.patch) {
    return (
      <div className="mt-1 font-mono text-[11px] space-y-0.5">
        <div className="text-error bg-error/5 rounded px-1.5 py-0.5 break-words">− {finding.patch.find}</div>
        <div className="text-success bg-success/5 rounded px-1.5 py-0.5 break-words">+ {finding.patch.replace}</div>
      </div>
    )
  }
  if (finding.variantFix) {
    return (
      <div className="mt-1 text-text-muted">
        Section {finding.variantFix.sectionIndex + 1} layout variant → {finding.variantFix.variant}
      </div>
    )
  }
  return null
}
