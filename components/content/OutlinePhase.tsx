'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import OutlineCard from './OutlineCard'
import { nextPendingOutlineId } from '@/lib/content/outline-review'
import { mergePolledOutlines } from '@/lib/ui/outline-poll-merge'
import LibraryContentPanel from './LibraryContentPanel'
import ArticleImportPanel from './ArticleImportPanel'
import type { Json } from '@/types/database'

type Outline = {
  id: string
  page_url: string
  page_title: string
  h1: string | null
  sections: Json
  target_keyword: string | null
  admin_approved: boolean
  admin_notes: string | null
  angle: string | null
  cta: Json | null
  content_job_id: string
}

export default function OutlinePhase({
  contentJobId,
}: {
  contentJobId: string
}) {
  const [outlines, setOutlines] = useState<Outline[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [advancing, setAdvancing] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [approvingAll, setApprovingAll] = useState(false)
  const [regeneratingAll, setRegeneratingAll] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // The operator must make an explicit choice about including library content
  // before content generation can start (choosing "none" counts, once saved).
  const [libraryAcknowledged, setLibraryAcknowledged] = useState(false)
  // Same explicit-choice gate for importing the client's own existing articles.
  // Defaults acknowledged — a session with no discovered articles auto-clears via
  // the panel, and the server gate is the real enforcement.
  const [articlesAcknowledged, setArticlesAcknowledged] = useState(true)
  // Outline ids with unsaved local edits. The poll below must not overwrite
  // these rows (it would silently discard what the operator is typing); a ref
  // so the long-lived poll closure always sees the current set.
  const dirtyIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch(`/api/content-jobs/${contentJobId}/outlines`)
        if (cancelled) return
        if (!res.ok) {
          setError(`Failed to load outlines (${res.status})`)
          setLoading(false)
          // Auth/not-found won't fix itself — stop hammering the route.
          if (res.status === 401 || res.status === 403 || res.status === 404) clearInterval(intervalId)
          return
        }
        const data = await res.json()
        const current: Outline[] = data.outlines ?? []
        // Keep local copies of rows with unsaved edits; adopt everything else
        // (new rows, generated H1s, approval status) from the server.
        setOutlines(prev => mergePolledOutlines(prev, current, dirtyIdsRef.current, ['admin_approved']))
        setLoading(false)
        // Stop polling once all outlines have h1 (generation done)
        if (current.length > 0 && current.every((o: Outline) => o.h1)) {
          clearInterval(intervalId)
        }
      } catch {
        if (!cancelled) setError('Failed to load outlines')
        setLoading(false)
      }
    }

    const intervalId = setInterval(poll, 5000)
    poll()
    return () => { cancelled = true; clearInterval(intervalId) }
  }, [contentJobId, retryNonce])

  const retryGeneration = async () => {
    setRetrying(true)
    setError(null)
    try {
      const res = await fetch(`/api/content-jobs/${contentJobId}/outlines/generate`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Retry failed')
      }
      // Re-mount polling so it picks up newly-generating outlines.
      setRetryNonce(n => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed')
    } finally {
      setRetrying(false)
    }
  }

  const approveAll = async () => {
    setApprovingAll(true)
    setError(null)
    try {
      const res = await fetch(`/api/content-jobs/${contentJobId}/outlines/approve-all`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Approve all failed')
      }
      const { skipped } = (await res.json().catch(() => ({}))) as { skipped?: number }
      if (skipped) {
        setError(`${skipped} outline${skipped === 1 ? ' needs' : 's need'} review first — fix or regenerate ${skipped === 1 ? 'it' : 'them'}, then approve.`)
      }
      // Re-fetch so the approved flags (and the enabled "Start" button) update.
      setRetryNonce(n => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approve all failed')
    } finally {
      setApprovingAll(false)
    }
  }

  const regenerateAll = async () => {
    if (!window.confirm('Regenerate ALL outlines? Every outline will be cleared and rebuilt, and all approvals reset.')) return
    setRegeneratingAll(true)
    setError(null)
    try {
      const res = await fetch(`/api/content-jobs/${contentJobId}/outlines/regenerate-all`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Regenerate all failed')
      }
      // Every outline was rebuilt server-side — local edits no longer apply.
      dirtyIdsRef.current.clear()
      // Re-mount polling to track the rebuilding outlines.
      setRetryNonce(n => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Regenerate all failed')
    } finally {
      setRegeneratingAll(false)
    }
  }

  // `localEdit` = the operator changed a field (unsaved); otherwise `updated`
  // is the server's copy after a save/approve/regenerate and the row is clean.
  const handleUpdate = (updated: Outline, localEdit = false) => {
    if (localEdit) dirtyIdsRef.current.add(updated.id)
    else dirtyIdsRef.current.delete(updated.id)
    setOutlines(prev => prev.map(o => o.id === updated.id ? updated : o))
  }

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id))
  }, [])

  // After approving a card: collapse it, or (advance) jump to the next outline
  // that is generated and still pending, so a reviewer can walk the list.
  const handleApproved = useCallback((id: string, advance: boolean) => {
    if (!advance) {
      setExpandedId(prev => (prev === id ? null : prev))
      return
    }
    setOutlines(prev => {
      setExpandedId(nextPendingOutlineId(prev, id))
      return prev
    })
  }, [])

  const handleLibraryAck = useCallback((ack: boolean) => setLibraryAcknowledged(ack), [])
  const handleArticlesAck = useCallback((ack: boolean) => setArticlesAcknowledged(ack), [])

  const startContentGeneration = async () => {
    setAdvancing(true)
    setError(null)
    try {
      const res = await fetch(`/api/content-jobs/${contentJobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 5 }),
      })
      if (!res.ok) throw new Error('Failed to advance phase')
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to advance')
      setAdvancing(false)
    }
  }

  if (loading) {
    return (
      <div className="py-4 text-center">
        <div className="text-sm text-text-muted font-body">Loading outlines...</div>
      </div>
    )
  }

  const approvedCount = outlines.filter(o => o.admin_approved).length
  const allApproved = outlines.length > 0 && approvedCount === outlines.length
  const generatingCount = outlines.filter(o => !o.h1).length

  return (
    <div className="space-y-4">
      {/* Progress */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-body text-text-primary font-semibold">
          {approvedCount} of {outlines.length} pages approved
        </span>
        {generatingCount > 0 && (
          <span className="text-xs font-body text-info animate-pulse">
            {generatingCount} still generating...
          </span>
        )}
      </div>
      <div className="w-full h-2 bg-surface-subtle rounded-full overflow-hidden">
        <div
          className="h-full bg-brand-cyan rounded-full transition-all duration-500"
          style={{ width: `${outlines.length > 0 ? (approvedCount / outlines.length) * 100 : 0}%` }}
        />
      </div>

      {/* Bulk actions */}
      {outlines.length > 0 && (
        <div className="flex items-center gap-3">
          <button
            onClick={approveAll}
            disabled={approvingAll || allApproved || generatingCount > 0}
            className="border border-brand-cyan text-brand-navy font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:bg-brand-cyan hover:text-text-inverse disabled:opacity-50 disabled:cursor-not-allowed"
            title="Approve every generated outline at once. Outlines still being generated are left untouched."
          >
            {approvingAll ? 'Approving…' : 'Approve all'}
          </button>
          <button
            onClick={regenerateAll}
            disabled={regeneratingAll || generatingCount > 0}
            className="border border-border-default text-text-secondary font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:border-brand-cyan hover:text-brand-navy disabled:opacity-50 disabled:cursor-not-allowed"
            title="Clear and rebuild every outline from scratch. All approvals reset — use after major schema changes."
          >
            {regeneratingAll ? 'Regenerating…' : 'Regenerate all'}
          </button>
        </div>
      )}

      {/* Outline cards */}
      <div className="space-y-2">
        {outlines.map(outline => (
          <OutlineCard
            key={outline.id}
            outline={outline}
            contentJobId={contentJobId}
            onUpdate={handleUpdate}
            expanded={expandedId === outline.id}
            onToggleExpand={() => handleToggleExpand(outline.id)}
            onApproved={handleApproved}
            hasNextPending={outlines.some(o => o.id !== outline.id && o.h1 && !o.admin_approved)}
          />
        ))}
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error text-sm font-body rounded-lg px-4 py-2">
          {error}
        </div>
      )}

      {/* Include existing library content — shown once the outline is proofed. */}
      {allApproved && (
        <LibraryContentPanel contentJobId={contentJobId} onAcknowledgedChange={handleLibraryAck} />
      )}

      {/* Bring over the client's own existing articles verbatim. */}
      {allApproved && (
        <ArticleImportPanel contentJobId={contentJobId} onAcknowledgedChange={handleArticlesAck} />
      )}

      {/* Start content generation */}
      <div className="pt-2 flex items-center gap-3">
        <button
          onClick={startContentGeneration}
          disabled={!allApproved || !libraryAcknowledged || !articlesAcknowledged || advancing}
          className="bg-brand-cyan text-text-inverse font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:bg-brand-cyan-dark disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {advancing ? 'Starting...' : 'Start Content Generation →'}
        </button>
        {generatingCount > 0 && (
          <button
            onClick={retryGeneration}
            disabled={retrying}
            className="border border-border-default text-text-secondary font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:border-brand-cyan hover:text-brand-navy disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {retrying ? 'Retrying...' : `Retry ${generatingCount} stuck`}
          </button>
        )}
      </div>
      {!allApproved && outlines.length > 0 && generatingCount === 0 && (
        <p className="text-xs text-text-muted font-body">
          Approve all outlines to enable content generation.
        </p>
      )}
      {allApproved && !libraryAcknowledged && (
        <p className="text-xs text-text-muted font-body">
          Confirm your library-content choice above to enable content generation.
        </p>
      )}
      {allApproved && libraryAcknowledged && !articlesAcknowledged && (
        <p className="text-xs text-text-muted font-body">
          Confirm your existing-article import choice above to enable content generation.
        </p>
      )}
    </div>
  )
}
