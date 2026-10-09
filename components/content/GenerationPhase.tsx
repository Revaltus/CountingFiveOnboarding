'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import MarkdownPreviewModal from './MarkdownPreviewModal'
import { classifyAiErrorText, ANTHROPIC_STATUS_URL } from '@/lib/ai/ai-error-text'
import { pickPageChips, needsReviewBannerCopy } from '@/lib/content/qa/chip'
import type { QaSummary } from '@/types/qa-review'

type PageStatus = {
  id: string
  url: string
  title: string
  status: string
  errorMessage?: string | null
  startedAt?: string | null
  parent?: string
  outlineApproved?: boolean
  approved?: boolean
  needsClientReview?: boolean
  clientApproved?: boolean
  wordCountActual?: number | null
  wordCountTarget?: number | null
  critic?: { overall: number; hasFlags: boolean; needsReview?: boolean; regenerated?: boolean } | null
  qa?: QaSummary | null
  qaStatus?: string | null
}

// Depth in the sitemap tree, capped to guard against accidental cycles.
function depthOf(url: string, parentByUrl: Map<string, string | undefined>): number {
  let d = 0
  let cur = parentByUrl.get(url)
  while (cur && d < 8) {
    d++
    cur = parentByUrl.get(cur)
  }
  return d
}

type GenStatus = {
  total: number
  complete: number
  running: number
  error: number
  approved: number
  needsClientReview: number
  clientApproved: number
  // Live CONTENT_QA_MODE, so queued/running rows (no stored review yet) know
  // whether the QA chip replaces the critic chip. Absent on older responses.
  qaMode?: 'off' | 'shadow' | 'on'
  pages: PageStatus[]
}

const STATUS_ICONS: Record<string, { icon: string; cls: string; title: string }> = {
  pending:  { icon: '○', cls: 'text-text-muted', title: 'Pending — not yet generated' },
  running:  { icon: '◌', cls: 'text-info animate-pulse', title: 'Running — Claude is generating this page now' },
  complete: { icon: '●', cls: 'text-success', title: 'Complete — content has been generated' },
  error:    { icon: '✗', cls: 'text-error', title: 'Error — generation failed; check server logs and re-run' },
}

// A page still 'running' past this is almost certainly orphaned (a worker died
// mid-call). The cron sweep only clears it at 15 min; surface it far sooner so
// the operator can unstick it instead of staring at a spinner.
const STALE_RUNNING_MS = 4 * 60 * 1000

function wordCountBadge(actual: number | null | undefined, target: number | null | undefined): { label: string; cls: string; title: string } | null {
  if (actual == null) return null
  if (!target) {
    return {
      label: `${actual} words`,
      cls: 'text-text-muted bg-surface-subtle',
      title: `${actual} words generated (no target was set for this outline)`,
    }
  }
  const variance = (actual - target) / target
  const pct = Math.round(variance * 100)
  if (Math.abs(variance) > 0.25) {
    return {
      label: `⚠ ${actual} / ${target} (${pct >= 0 ? '+' : ''}${pct}%)`,
      cls: 'text-warning-strong bg-warning/10',
      title: `${actual} words generated vs target of ${target} (${pct >= 0 ? '+' : ''}${pct}% off target). Flagged when actual is more than ±25% from target — review whether the content is too thin or too verbose.`,
    }
  }
  return {
    label: `${actual} / ${target}`,
    cls: 'text-text-muted bg-surface-subtle',
    title: `${actual} words generated vs target of ${target} (${pct >= 0 ? '+' : ''}${pct}%). Within the acceptable ±25% range.`,
  }
}

export default function GenerationPhase({
  contentJobId,
  jobPhase,
  initialPreviewPageId = null,
}: {
  contentJobId: string
  jobPhase: number
  initialPreviewPageId?: string | null
}) {
  const router = useRouter()
  // Fires the phase-finalize/refresh once per "generation just finished"
  // transition so a stranded phase-5 job unlocks Deliverables without a manual
  // hard reload. Reset when a restart puts work back in flight (pollNonce bump).
  const finalizedRef = useRef(false)
  const [status, setStatus] = useState<GenStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [pollNonce, setPollNonce] = useState(0)
  const [pendingActions, setPendingActions] = useState<Set<string>>(new Set())
  const [previewPageId, setPreviewPageId] = useState<string | null>(initialPreviewPageId)
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // url→parent lookup for the page tree's indentation — memoized so it isn't
  // rebuilt on every render (was recreated inside the render IIFE below).
  const parentByUrl = useMemo(
    () => new Map((status?.pages ?? []).map(p => [p.url, p.parent])),
    [status?.pages],
  )
  // Count of pages stuck 'running' past the stale threshold. Computed in the
  // poll (reading the clock is a side effect, not allowed during render).
  const [staleCount, setStaleCount] = useState(0)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch(`/api/content-jobs/${contentJobId}/generation-status`)
        if (cancelled) return
        if (!res.ok) {
          setLoadError(`Couldn't load generation status (${res.status}).`)
          setLoading(false)
          // Auth / not-found won't recover by polling.
          if (intervalId && (res.status === 401 || res.status === 403 || res.status === 404)) {
            clearInterval(intervalId)
          }
          return
        }
        const data = await res.json()
        if (cancelled) return
        setLoadError(null)
        setStatus(data)
        setLoading(false)
        const nowTs = Date.now()
        setStaleCount(
          (data.pages ?? []).filter(
            (p: PageStatus) =>
              p.status === 'running' &&
              p.startedAt != null &&
              nowTs - new Date(p.startedAt).getTime() > STALE_RUNNING_MS,
          ).length,
        )
        const generationDone =
          data.total > 0 && data.complete + data.error >= data.total && data.running === 0
        // Re-arm the finalize trigger whenever work is back in flight (e.g. a
        // restart/retry), so it fires again when generation next settles.
        if (!generationDone) finalizedRef.current = false
        if (generationDone) {
          if (intervalId) clearInterval(intervalId)
          // The Deliverables step is gated on the server-rendered content_jobs.phase.
          // When generation finishes it should be 6, but the phase can lag behind
          // the live status shown here — the batch runner never advanced it (a page
          // was stranded 'running' then swept to 'error'), completion came through a
          // per-page retry, or this browser is holding a stale server render. If the
          // phase prop says we're not there yet, ask the server to reconcile (idempotent
          // — advances the phase / retries any straggler) and re-render so the lock lifts.
          if (jobPhase < 6 && !finalizedRef.current) {
            finalizedRef.current = true
            try {
              await fetch(`/api/content-jobs/${contentJobId}/generate`, { method: 'POST' })
            } catch {
              // Non-fatal — the refresh below still picks up any phase the server
              // has already advanced; the cron sweep is the backstop.
            }
            if (!cancelled) router.refresh()
          }
        }
      } catch {
        // Network blip — retry on next poll, but don't leave the spinner up.
        if (!cancelled) setLoading(false)
      }
    }

    // Once the job has advanced to Deliverables (phase ≥ 6), generation is done
    // and DeliverablesPhase owns the live generation-status poll — a one-shot
    // fetch populates this view without a second recurring interval.
    const intervalId = jobPhase < 6 ? setInterval(poll, 5000) : null
    poll()
    return () => { cancelled = true; if (intervalId) clearInterval(intervalId) }
  }, [contentJobId, pollNonce, jobPhase, router])

  const setAction = (key: string, on: boolean) => {
    setPendingActions(prev => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const errorFrom = async (res: Response, fallback: string) => {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    return data.error ?? `${fallback} (${res.status})`
  }

  const toggleApprove = async (page: PageStatus, next: boolean) => {
    setAction(`approve:${page.id}`, true)
    setActionError(null)
    try {
      const res = await fetch(`/api/content-jobs/${contentJobId}/pages/${page.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_approved_content: next }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `Couldn't update approval (${res.status})`)
      }
      setPollNonce(n => n + 1)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't update approval")
    } finally {
      setAction(`approve:${page.id}`, false)
    }
  }

  const restartGeneration = async () => {
    setRestarting(true)
    setRestartError(null)
    try {
      const res = await fetch(`/api/content-jobs/${contentJobId}/generate`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Restart failed')
      }
      setPollNonce(n => n + 1)
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : 'Restart failed')
    } finally {
      setRestarting(false)
    }
  }

  const copyReviewLink = async () => {
    const base = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '') || (typeof window !== 'undefined' ? window.location.origin : '')
    const link = `${base}/review/${contentJobId}`
    try {
      await navigator.clipboard.writeText(link)
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
    } catch {
      // Ignore — most likely the user denied clipboard permission
    }
  }

  const toggleClientReviewFlag = async (page: PageStatus, next: boolean) => {
    setAction(`flag:${page.id}`, true)
    setActionError(null)
    try {
      const res = await fetch(`/api/content-jobs/${contentJobId}/pages/${page.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ needs_client_review: next }),
      })
      if (!res.ok) throw new Error(await errorFrom(res, "Couldn't update the client-review flag"))
      setPollNonce(n => n + 1)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't update the client-review flag")
    } finally {
      setAction(`flag:${page.id}`, false)
    }
  }

  // Retry a failed page: same regenerate endpoint, but no "replace approved
  // content" confirm since an errored page has nothing worth keeping.
  const retryPage = async (page: PageStatus) => {
    setAction(`regen:${page.id}`, true)
    setActionError(null)
    try {
      const res = await fetch(`/api/content-jobs/${contentJobId}/pages/${page.id}/regenerate`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error(await errorFrom(res, "Couldn't retry this page"))
      setPollNonce(n => n + 1)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't retry this page")
    } finally {
      setAction(`regen:${page.id}`, false)
    }
  }

  const regenerate = async (page: PageStatus) => {
    const warning =
      jobPhase === 6
        ? `This client's content is already COMPLETE. Regenerating "${page.title}" will replace the finished content and reset approval — you'll need to re-publish. Continue?`
        : page.approved
          ? `Regenerate "${page.title}"? The current approved content will be replaced and approval reset.`
          : `Regenerate "${page.title}"? The current draft will be replaced.`
    if (!window.confirm(warning)) return
    setAction(`regen:${page.id}`, true)
    setActionError(null)
    try {
      const res = await fetch(`/api/content-jobs/${contentJobId}/pages/${page.id}/regenerate`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error(await errorFrom(res, "Couldn't regenerate this page"))
      setPollNonce(n => n + 1)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't regenerate this page")
    } finally {
      setAction(`regen:${page.id}`, false)
    }
  }

  if (loading) {
    return (
      <div className="py-4 text-center">
        <div className="text-sm text-text-muted font-body">Loading generation status...</div>
      </div>
    )
  }

  if (!status && loadError) {
    return (
      <div className="bg-error/10 border border-error/20 text-error text-sm font-body rounded-lg px-4 py-2">
        {loadError}
      </div>
    )
  }

  if (!status || status.total === 0) {
    return (
      <div className="py-4 text-center">
        <div className="text-sm text-text-muted font-body">No pages queued for generation.</div>
      </div>
    )
  }

  const pct = status.total > 0 ? Math.round((status.complete / status.total) * 100) : 0
  const isRunning = status.running > 0 || (status.complete + status.error < status.total)
  const allAdminApproved = status.approved === status.complete && status.complete > 0
  const allClientApproved = status.needsClientReview === 0 || status.clientApproved === status.needsClientReview
  const allApproved = allAdminApproved && allClientApproved

  const runningPages = status.pages.filter(p => p.status === 'running')

  // Pages the critic still judged weak after its one auto-rewrite, OR that the
  // QA desk flagged with a high-priority open finding (facts/missing sections),
  // AND that the operator hasn't approved yet — the short list worth proofing
  // closely, so the operator scrutinizes these instead of re-reading every page.
  const needsReviewPages = status.pages.filter(
    p => p.status === 'complete' && !p.approved && (p.critic?.needsReview || (p.qa?.mode === 'on' && (p.qa.highOpen ?? 0) > 0)),
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-body text-text-muted">
          {status.needsClientReview > 0
            ? `${status.clientApproved} of ${status.needsClientReview} flagged pages approved by client`
            : 'No pages flagged for client review'}
        </div>
        <button
          type="button"
          onClick={copyReviewLink}
          disabled={status.needsClientReview === 0}
          className="text-xs font-heading font-semibold text-brand-cyan hover:text-brand-navy transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {linkCopied ? 'Copied!' : 'Copy review link'}
        </button>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-body text-text-primary font-semibold">
            {status.complete} of {status.total} pages generated
            <span className="ml-3 text-text-muted font-normal">
              {status.approved} of {status.complete} approved
            </span>
          </span>
          <span className="text-xs font-body text-text-muted">
            {isRunning ? 'Generating...' : 'Complete'}
            {status.error > 0 && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => setShowErrors(v => !v)}
                  className="text-error font-semibold hover:underline"
                  title="Show why these pages failed and retry them"
                >
                  {status.error} error{status.error !== 1 ? 's' : ''} {showErrors ? '▲' : '▾'}
                </button>
              </>
            )}
          </span>
        </div>
        <div className="w-full h-2 bg-surface-subtle rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              status.error > 0 && !isRunning ? 'bg-warning' : 'bg-brand-cyan'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {runningPages.length > 0 && (
          <p className="mt-1.5 text-xs font-body text-text-muted truncate" title={runningPages.map(p => p.title).join(', ')}>
            <span className="text-info animate-pulse">◌</span>{' '}
            Generating now: {runningPages.slice(0, 4).map(p => p.title).join(', ')}
            {runningPages.length > 4 ? ` +${runningPages.length - 4} more` : ''}
          </p>
        )}
      </div>

      {needsReviewPages.length > 0 && (
        <div className="border border-error/30 bg-error/5 rounded-lg p-3 space-y-1.5">
          <span className="text-xs font-heading font-semibold text-error">
            {needsReviewPages.length} page{needsReviewPages.length !== 1 ? 's need' : ' needs'} a closer look
          </span>
          <p className="text-xs font-body text-text-muted">
            {needsReviewBannerCopy(needsReviewPages.length, needsReviewPages.some(p => p.qa?.mode === 'on' && (p.qa.highOpen ?? 0) > 0))}
          </p>
          {needsReviewPages.map(page => {
            const chips = pickPageChips(page.qa ?? null, page.qaStatus ?? null, page.critic, status.qaMode)
            return (
              <div key={page.id} className="flex items-center gap-2 text-xs font-body border-t border-error/15 pt-1.5 first:border-t-0 first:pt-0">
                <span className="font-semibold text-text-primary flex-1 truncate" title={page.title}>{page.title}</span>
                {[chips.primary, chips.secondary].map(q => q && (
                  <span key={q.label} className={`font-mono px-1.5 py-0.5 rounded ${q.cls}`} title={q.title}>{q.label}</span>
                ))}
                <button
                  type="button"
                  onClick={() => setPreviewPageId(page.id)}
                  className="text-brand-cyan hover:text-brand-navy font-heading font-semibold transition-colors flex-shrink-0"
                >
                  View
                </button>
              </div>
            )
          })}
        </div>
      )}

      {staleCount > 0 && (
        <div className="bg-warning/10 border border-warning/30 text-warning-strong text-sm font-body rounded-lg px-4 py-2">
          {staleCount} page{staleCount !== 1 ? 's have' : ' has'} been generating for over 4 minutes and
          may be stuck (a worker likely stopped mid-run). Click <span className="font-semibold">Restart generation
          (unstick)</span> below — finished pages are skipped, so it&apos;s safe to re-run.
        </div>
      )}

      {showErrors && status.error > 0 && (
        <div className="border border-error/30 bg-error/5 rounded-lg p-3 space-y-2">
          {status.pages.some(p => p.status === 'error' && classifyAiErrorText(p.errorMessage).isProviderIssue) && (
            <div className="rounded-md bg-warning/10 border border-warning/30 px-3 py-2 text-xs font-body text-warning-strong">
              This looks like a Claude API issue (likely a temporary outage), not a problem with your content. Wait a minute, then use “Retry all failed”. If it keeps happening, check {ANTHROPIC_STATUS_URL}.
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs font-heading font-semibold text-error">
              Failed pages ({status.error})
            </span>
            <button
              type="button"
              onClick={restartGeneration}
              disabled={restarting}
              className="text-xs font-heading font-semibold text-brand-cyan hover:text-brand-navy transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Re-run generation for every failed page at once"
            >
              {restarting ? 'Retrying…' : 'Retry all failed'}
            </button>
          </div>
          {status.pages.filter(p => p.status === 'error').map(page => {
            const retryBusy = pendingActions.has(`regen:${page.id}`)
            return (
              <div
                key={page.id}
                className="text-xs font-body border-t border-error/15 pt-2 first:border-t-0 first:pt-0"
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-text-primary flex-1 truncate" title={page.title}>
                    {page.title}
                  </span>
                  <span className="font-mono text-text-muted truncate max-w-[40%]" title={page.url}>
                    {page.url}
                  </span>
                  <button
                    type="button"
                    onClick={() => retryPage(page)}
                    disabled={retryBusy}
                    className="text-brand-cyan hover:text-brand-navy font-heading font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                  >
                    {retryBusy ? '…' : 'Retry'}
                  </button>
                </div>
                <p className="text-error mt-0.5 font-mono break-words whitespace-pre-wrap">
                  {page.errorMessage || 'No error detail recorded (page failed before error tracking — retry to capture the reason).'}
                </p>
              </div>
            )
          })}
        </div>
      )}

      <div className="max-h-[400px] overflow-y-auto space-y-1">
        {(() => {
          return status.pages.map(page => {
            const awaitingOutline = page.status === 'pending' && page.outlineApproved === false
            const s = awaitingOutline
              ? { ...STATUS_ICONS.pending, title: 'Awaiting outline approval — approve it in Outlines above' }
              : STATUS_ICONS[page.status] ?? STATUS_ICONS.pending
            const depth = depthOf(page.url, parentByUrl)
            const wcBadge = page.status === 'complete' ? wordCountBadge(page.wordCountActual, page.wordCountTarget) : null
            const chips = page.status === 'complete'
              ? pickPageChips(page.qa ?? null, page.qaStatus ?? null, page.critic, status.qaMode)
              : { primary: null, secondary: null }
            const approveBusy = pendingActions.has(`approve:${page.id}`)
            const regenBusy = pendingActions.has(`regen:${page.id}`)
            const flagBusy = pendingActions.has(`flag:${page.id}`)
            return (
              <div
                key={page.id}
                className="rounded hover:bg-surface-subtle transition-colors"
                style={{ paddingLeft: `${0.75 + depth * 1.25}rem`, paddingRight: '0.75rem' }}
              >
                <div className="flex items-center gap-2 py-1.5">
                  <span className={`text-sm ${s.cls}`} title={s.title}>{s.icon}</span>
                  <span className="text-sm font-body text-text-primary flex-1 truncate">{page.title}</span>
                  {awaitingOutline && (
                    <span
                      className="text-xs font-mono px-1.5 py-0.5 rounded text-warning-strong bg-warning/10"
                      title="Generation only runs approved outlines. Approve (or fix) this page's outline in the Outlines step above."
                    >
                      Outline not approved
                    </span>
                  )}
                  {wcBadge && (
                    <span
                      className={`text-xs font-mono px-1.5 py-0.5 rounded ${wcBadge.cls}`}
                      title={wcBadge.title}
                    >
                      {wcBadge.label}
                    </span>
                  )}
                  {[chips.primary, chips.secondary].map(qBadge => qBadge && (
                    <span
                      key={qBadge.label}
                      className={`text-xs font-mono px-1.5 py-0.5 rounded ${qBadge.cls}`}
                      title={qBadge.title}
                    >
                      {qBadge.label}
                    </span>
                  ))}
                  {page.needsClientReview && (
                    <span
                      className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                        page.clientApproved
                          ? 'text-success bg-success/10'
                          : 'text-warning-strong bg-warning/10'
                      }`}
                      title={
                        page.clientApproved
                          ? 'Client has reviewed and approved this page via the client review URL.'
                          : 'This page is flagged for client review. The deliverable cannot be assembled until the client approves it via the review URL.'
                      }
                    >
                      {page.clientApproved ? 'Client ✓' : 'Awaiting client'}
                    </span>
                  )}
                  <span className="text-xs font-mono text-text-muted flex-shrink-0">{page.url}</span>
                  {page.status === 'complete' && (
                    <>
                      <button
                        type="button"
                        onClick={() => setPreviewPageId(page.id)}
                        className="text-xs font-body text-text-secondary hover:text-brand-cyan transition-colors"
                        title="Open the rendered + raw view of this page; edit metadata or markdown inline"
                      >
                        View
                      </button>
                      <label
                        className="flex items-center gap-1 text-xs font-body text-text-secondary cursor-pointer"
                        title="Flag this page for client review. Flagged pages appear in the public review URL and gate the deliverable until the client approves."
                      >
                        <input
                          type="checkbox"
                          checked={page.needsClientReview ?? false}
                          disabled={flagBusy}
                          onChange={e => toggleClientReviewFlag(page, e.target.checked)}
                          className="accent-brand-cyan"
                        />
                        Client review
                      </label>
                      <label
                        className={`flex items-center gap-1 text-xs font-heading cursor-pointer px-1.5 py-0.5 rounded transition-colors ${
                          page.approved
                            ? 'font-semibold text-success bg-success/10'
                            : 'font-semibold text-text-secondary hover:bg-surface-subtle'
                        }`}
                        title="Admin approval. Required before the deliverable package can be assembled. Resets to false whenever content or the outline is edited."
                      >
                        <input
                          type="checkbox"
                          checked={page.approved ?? false}
                          disabled={approveBusy}
                          onChange={e => toggleApprove(page, e.target.checked)}
                          className="accent-success"
                        />
                        {page.approved ? 'Approved ✓' : 'Approve'}
                      </label>
                      <button
                        type="button"
                        onClick={() => regenerate(page)}
                        disabled={regenBusy || page.status !== 'complete'}
                        className="text-xs font-body text-text-secondary hover:text-brand-cyan transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Re-run Claude to generate fresh content for this page. Approval (both admin and client) resets to false on regeneration."
                      >
                        {regenBusy ? '…' : 'Regen'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })
        })()}
      </div>

      {status.error > 0 && !isRunning && (
        <div className="bg-warning/10 border border-warning/30 text-warning-strong text-sm font-body rounded-lg px-4 py-2">
          {status.complete} pages generated · {status.error} failed — deliverables will include an ERRORS.md noting skipped pages.
        </div>
      )}

      {!isRunning && status.complete > 0 && allApproved && (
        <div className="bg-success/10 border border-success/30 text-success text-sm font-body rounded-lg px-4 py-2">
          All pages approved. Proceed to Deliverables to download the content package.
        </div>
      )}

      {!isRunning && status.complete > 0 && !allApproved && (
        <div className="bg-info/10 border border-info/20 text-info text-sm font-body rounded-lg px-4 py-2">
          {!allAdminApproved
            ? <>Review each page above and check &quot;Approved&quot; before assembling the deliverable. {status.complete - status.approved} of {status.complete} still need review.</>
            : <>{status.needsClientReview - status.clientApproved} of {status.needsClientReview} flagged pages still awaiting client approval. Copy the review link above and send it to the client.</>
          }
        </div>
      )}

      {restartError && (
        <div className="bg-error/10 border border-error/20 text-error text-sm font-body rounded-lg px-4 py-2">
          {restartError}
        </div>
      )}

      {actionError && (
        <div role="alert" className="bg-error/10 border border-error/20 text-error text-sm font-body rounded-lg px-4 py-2">
          {actionError}
        </div>
      )}

      {/* Stuck-recovery: any time some pages haven't reached a terminal state,
          allow restart. Includes the "running" case because Vercel may have
          killed the pipeline mid-call, leaving rows orphaned in running.
          The pipeline itself skips already-complete rows, so re-running is
          idempotent for the work that's already done. */}
      {status.pages.some(p => p.status === 'pending' && p.outlineApproved === false) && (
        <p className="text-xs text-text-muted font-body">
          Pages marked &quot;Outline not approved&quot; won&apos;t generate until their outline is approved in the Outlines step — restarting won&apos;t pick them up.
        </p>
      )}
      {status.complete + status.error < status.total && (
        <button
          onClick={restartGeneration}
          disabled={restarting}
          className="bg-brand-cyan text-white font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:bg-brand-cyan/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {restarting ? 'Restarting...' : status.running > 0 ? 'Restart generation (unstick)' : 'Restart generation'}
        </button>
      )}

      {previewPageId && (
        <MarkdownPreviewModal
          contentJobId={contentJobId}
          pageId={previewPageId}
          onClose={() => {
            // Drop a ?preview= deep link so a refresh doesn't reopen the modal.
            if (initialPreviewPageId) router.replace(window.location.pathname, { scroll: false })
            setPreviewPageId(null)
          }}
          onApprovalChange={() => setPollNonce(n => n + 1)}
        />
      )}
    </div>
  )
}
