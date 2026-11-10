'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ReportUrlSource } from '@/lib/visibility/report-url'

const SOURCE_COPY: Record<ReportUrlSource, string> = {
  live: 'saved live URL',
  preview: 'staging preview',
  website: 'website on file',
}

const inputCls =
  'w-full rounded-lg border border-border-default bg-surface-card px-3 py-2 font-body text-sm text-text-primary focus:border-brand-cyan focus:outline-none'
const primaryBtn =
  'bg-brand-cyan text-text-inverse font-heading font-semibold text-sm px-4 py-2 rounded-pill transition-all hover:bg-brand-cyan-dark disabled:opacity-50 disabled:cursor-not-allowed'
const secondaryBtn =
  'border border-border-strong text-text-secondary font-heading font-semibold text-sm px-4 py-2 rounded-pill transition-colors hover:border-brand-cyan hover:text-brand-cyan'

// Mirrors lib/visibility/live-host.ts for instant feedback while typing; the
// server re-derives it if the operator leaves the box untouched.
function looksLive(url: string): boolean {
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase()
    return host.includes('.') && !host.endsWith('.vercel.app') && host !== 'localhost' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  } catch {
    return false
  }
}

export function RunReportDialog({
  sessionId,
  suggestedUrl,
  suggestedSource,
  suggestedIsLive,
}: {
  sessionId: string
  suggestedUrl: string
  suggestedSource: ReportUrlSource
  suggestedIsLive: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState(suggestedUrl)
  const [isLive, setIsLive] = useState(suggestedIsLive)
  const [liveTouched, setLiveTouched] = useState(false)
  // Saving a staging address as the live URL would be wrong, so this follows
  // the live-domain box until the operator sets it themselves.
  const [saveChoice, setSaveChoice] = useState<boolean | null>(null)
  const save = saveChoice ?? isLive
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onUrl = (v: string) => {
    setUrl(v)
    if (!liveTouched) setIsLive(looksLive(v))
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/visibility-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, url, saveAsLiveUrl: save, isLiveDomain: isLive }),
      })
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string }
      if (!res.ok || !body.id) throw new Error(body.error ?? 'Could not start the report.')
      const run = await fetch(`/api/visibility-reports/${body.id}/run`, { method: 'POST' })
      if (!run.ok) {
        const r = (await run.json().catch(() => ({}))) as { error?: string }
        throw new Error(r.error ?? 'The report was created but could not start. Retry it from the list.')
      }
      setOpen(false)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the report.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={primaryBtn}>
        Run visibility report
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-navy/40 p-4" role="dialog" aria-modal="true" aria-labelledby="run-report-title">
      <div className="w-full max-w-lg rounded-xl border border-border-default bg-surface-card p-6 shadow-elevated">
        <h2 id="run-report-title" className="text-lg font-heading font-bold text-brand-navy">Run visibility report</h2>
        <p className="mt-1 text-sm font-body text-text-secondary">
          Crawls the site and scores it for each of the five audiences. Takes 2–8 minutes; you can leave this page.
        </p>

        <label htmlFor="report-url" className="mt-5 block text-xs font-heading font-semibold text-text-secondary mb-1">Site URL</label>
        <input id="report-url" value={url} onChange={(e) => onUrl(e.target.value)} placeholder="https://www.example.com" className={inputCls} />
        {suggestedUrl && url === suggestedUrl && (
          <p className="mt-1 text-xs font-body text-text-muted">From the {SOURCE_COPY[suggestedSource]}. Correct it if it isn&rsquo;t the rebuilt site.</p>
        )}

        <label className="mt-4 flex items-start gap-2 text-sm font-body text-text-primary">
          <input
            type="checkbox"
            checked={isLive}
            onChange={(e) => {
              setLiveTouched(true)
              setIsLive(e.target.checked)
            }}
            className="mt-0.5 accent-brand-cyan"
          />
          <span>This is the firm&rsquo;s live domain</span>
        </label>
        {!isLive && (
          <p className="mt-1 ml-6 rounded-lg bg-warning/10 px-3 py-2 text-xs font-body text-warning-strong">
            Staging addresses skip the Google ranking, Business Profile and AI-answer checks. Those audiences will score on site content only.
          </p>
        )}

        <label className="mt-3 flex items-start gap-2 text-sm font-body text-text-primary">
          <input type="checkbox" checked={save} onChange={(e) => setSaveChoice(e.target.checked)} className="mt-0.5 accent-brand-cyan" />
          <span>Save as this client&rsquo;s live site URL for future reports</span>
        </label>

        {error && <p className="mt-4 text-sm font-body text-error">{error}</p>}

        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={() => setOpen(false)} className={secondaryBtn} disabled={busy}>Cancel</button>
          <button type="button" onClick={submit} className={primaryBtn} disabled={busy || !url.trim()}>
            {busy ? 'Starting…' : 'Start report'}
          </button>
        </div>
      </div>
    </div>
  )
}
