'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import ProgressBar from '@/components/ui/ProgressBar'
import { useTaskProgress } from '@/components/ui/use-task-progress'
import { signOut } from '@/app/admin/dashboard/actions'

export type EditorStatus = {
  draftAhead: number
  draftBehind: number
  lastCommitSha: string | null
  lastCommitMessage: string | null
  lastCommitAt: string | null
  canRevertPublish: boolean
  repo: string
  repoUrl: string
}

// Vercel's stable branch-preview URL: {project}-git-{branch}-{team}.vercel.app.
// Assumes the Vercel project name matches the repo name (our convention).
// Hidden when the team slug env var isn't configured.
function previewUrl(repo: string): string | null {
  const team = process.env.NEXT_PUBLIC_VERCEL_TEAM_SLUG
  if (!team) return null
  const name = repo.split('/').pop()
  if (!name) return null
  return `https://${name}-git-draft-${team}.vercel.app`
}

// Compact draft/save state shown as a single dotted pill instead of a sentence.
function statusPill(
  status: EditorStatus | null,
  dirtyCount: number
): { text: string; dot: string } {
  if (status === null) return { text: 'Loading…', dot: 'bg-text-muted' }
  const ahead = status.draftAhead
  if (dirtyCount > 0) {
    const prefix = ahead > 0 ? `${ahead} to publish · ` : ''
    return { text: `${prefix}${dirtyCount} unsaved`, dot: 'bg-warning' }
  }
  if (ahead > 0) return { text: `${ahead} to publish`, dot: 'bg-brand-navy' }
  return { text: 'Up to date with live', dot: 'bg-brand-cyan' }
}

function OverflowMenu({
  sessionId,
  websiteUrl,
  status,
  publishing,
  draftBusy,
  dirtyCount,
  canPublishLive,
  isOwner,
  onRollback,
  onSyncDraft,
  onResetDraft,
  onRepullDone,
}: {
  sessionId: string
  websiteUrl: string
  status: EditorStatus
  publishing: boolean
  draftBusy: boolean
  dirtyCount: number
  canPublishLive: boolean
  isOwner: boolean
  onRollback: () => void
  onSyncDraft: () => void
  // Admin-only (the draft route rejects reset for everyone else); omitted →
  // the "Reset draft to live" item is hidden.
  onResetDraft?: () => void
  onRepullDone?: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const preview = previewUrl(status.repo)

  // Re-pull all images: re-fetch every stock/hero photo and commit any missing
  // ones to the draft branch. The menu stays open during the (slow) op so the
  // result shows inline; on success we refresh the editor's publish count.
  const [repull, setRepull] = useState<{ state: 'idle' | 'working' | 'done' | 'error'; msg: string }>({
    state: 'idle',
    msg: '',
  })
  const [repullTaskId, setRepullTaskId] = useState<string | null>(null)
  const [repullStartedAt, setRepullStartedAt] = useState<number | null>(null)
  const repullProgress = useTaskProgress(repullTaskId, repull.state === 'working')

  const repullImages = async () => {
    const taskId = crypto.randomUUID()
    setRepullTaskId(taskId)
    setRepullStartedAt(Date.now())
    setRepull({ state: 'working', msg: '' })
    try {
      const res = await fetch(`/api/edit/${sessionId}/repull-images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? 'Image re-pull failed')
      const pushed: number = data.pushed ?? 0
      const stillMissing: string[] = Array.isArray(data.stillMissing) ? data.stillMissing : []
      setRepull({
        state: 'done',
        msg:
          pushed > 0
            ? `Pushed ${pushed} image(s) to draft${stillMissing.length ? ` · ${stillMissing.length} still missing` : ''}. Publish to go live.`
            : stillMissing.length
              ? `No images resolved · ${stillMissing.length} still missing. Check PEXELS_API_KEY in prod.`
              : 'All images already present — nothing to re-pull.',
      })
      onRepullDone?.()
    } catch (err) {
      setRepull({ state: 'error', msg: err instanceof Error ? err.message : 'Image re-pull failed' })
    } finally {
      setRepullTaskId(null)
    }
  }

  // Divi export: builds a WordPress import bundle from the live repo. Can take a
  // while (dozens of GitHub reads + time-boxed Pexels lookups), so we fetch as a
  // blob with an inline working/error state instead of a bare download link —
  // otherwise a slow build or a failure looks like "nothing happened".
  const [divi, setDivi] = useState<{ state: 'idle' | 'working' | 'error'; msg: string }>({
    state: 'idle',
    msg: '',
  })
  const exportDivi = async () => {
    setDivi({ state: 'working', msg: '' })
    try {
      const res = await fetch(`/api/edit/${sessionId}/export-divi`)
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error ?? `Export failed (${res.status})`)
      }
      const blob = await res.blob()
      const cd = res.headers.get('content-disposition') ?? ''
      const filename = cd.match(/filename="([^"]+)"/)?.[1] ?? 'divi-export.zip'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setDivi({ state: 'idle', msg: '' })
    } catch (err) {
      setDivi({ state: 'error', msg: err instanceof Error ? err.message : 'Export failed' })
    }
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const itemClass =
    'block w-full text-left px-3 py-2 text-xs font-heading rounded transition-colors hover:bg-surface-subtle'

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => setOpen((v) => !v)}
        className="rounded-pill border border-border-default text-text-secondary hover:bg-surface-subtle font-heading font-semibold text-xs px-3 py-1.5 transition-colors"
      >
        •••
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-60 bg-surface-card border border-border-default rounded-lg shadow-elevated z-50 p-1"
        >
          <div className="px-3 py-2">
            <div className="text-[11px] font-body text-text-secondary truncate">{websiteUrl}</div>
            <div className="text-[10px] font-mono text-text-muted truncate">{status.repo}</div>
          </div>
          <div className="border-t border-border-default my-1" />
          {preview && (
            <a
              href={preview}
              target="_blank"
              rel="noreferrer"
              role="menuitem"
              className={`${itemClass} text-brand-cyan hover:text-brand-navy`}
              onClick={() => setOpen(false)}
            >
              Preview draft ↗
            </a>
          )}
          <a
            href={status.repoUrl}
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            className={`${itemClass} text-text-secondary hover:text-brand-cyan`}
            onClick={() => setOpen(false)}
          >
            Open on GitHub ↗
          </a>
          {/* Add a pricing page to a live client after the fact: configure here,
              Save pushes it to the draft branch, then Publish to live. */}
          {!isOwner && (
            <>
              <div className="border-t border-border-default my-1" />
              {/* Admins + managers, matching the visibility-reports route gate. */}
              {canPublishLive && (
              <Link
                href={`/admin/content/${sessionId}/visibility`}
                role="menuitem"
                className={`${itemClass} text-text-secondary hover:text-brand-cyan`}
                title="Score this site for the five audiences (prospective clients, existing clients, future talent & partners, Google search, AI discovery) and share a report with the client."
                onClick={() => setOpen(false)}
              >
                Visibility reports →
              </Link>
              )}
              <Link
                href={`/admin/content/${sessionId}/plans`}
                role="menuitem"
                className={`${itemClass} text-text-secondary hover:text-brand-cyan`}
                title="Configure the plans/pricing page (tier cards). Saving pushes it to the draft branch; publish to add /pricing to the live site."
                onClick={() => setOpen(false)}
              >
                Add / edit pricing plans →
              </Link>
              <Link
                href={`/admin/content/${sessionId}/pricing-calculator`}
                role="menuitem"
                className={`${itemClass} text-text-secondary hover:text-brand-cyan`}
                title="Configure the interactive pricing calculator. Saving pushes it to the draft branch; publish to add /pricing-calculator to the live site."
                onClick={() => setOpen(false)}
              >
                Add / edit pricing calculator →
              </Link>
              {canPublishLive && (
              <Link
                href={`/admin/content/${sessionId}/blog-landing`}
                role="menuitem"
                className={`${itemClass} text-text-secondary hover:text-brand-cyan`}
                title="Set where the articles / blog index lives and what it's called (e.g. move it to /insights so /resources can stay a regular page). Saving pushes it to the draft branch; publish to go live."
                onClick={() => setOpen(false)}
              >
                Blog landing settings →
              </Link>
              )}
            </>
          )}
          <div className="border-t border-border-default my-1" />
          <a
            href={`/api/edit/${sessionId}/document`}
            download
            role="menuitem"
            className={`${itemClass} text-text-secondary hover:text-brand-cyan`}
            title="Download the whole site (content, structure, SEO) as a .docx — opens in Word, Pages, or Google Docs"
            onClick={() => setOpen(false)}
          >
            Download doc ↓
          </a>
          {/* Whole-site export: admins + managers only (canPublishLive minus Site
              Owners); the route enforces the same gate. */}
          {canPublishLive && !isOwner && (
          <button
            type="button"
            role="menuitem"
            disabled={divi.state === 'working'}
            onClick={exportDivi}
            className={`${itemClass} text-text-secondary hover:text-brand-cyan disabled:opacity-50 disabled:cursor-not-allowed`}
            title="Export the live site (pages, nav, header/footer) as a WordPress/Divi import bundle (.wxr + Divi library). Temporary bridge for standing sites up on the shared Divi boilerplate."
          >
            {divi.state === 'working' ? 'Building Divi export…' : 'Export to Divi ↓'}
          </button>
          )}
          {divi.state === 'error' && divi.msg && (
            <p className="px-3 py-1.5 text-[11px] font-body text-error">{divi.msg}</p>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={repull.state === 'working'}
            onClick={repullImages}
            className={`${itemClass} text-text-secondary hover:text-brand-cyan disabled:opacity-50 disabled:cursor-not-allowed`}
            title="Re-fetch every stock &amp; hero photo from Pexels and commit any missing ones to the draft branch. Fixes pages showing “Image not found.” Publish afterward to go live."
          >
            {repull.state === 'working' ? 'Re-pulling images…' : 'Re-pull all images ⟳'}
          </button>
          {repull.state === 'working' && (
            <div className="px-3 py-1.5">
              <ProgressBar
                phase={repullProgress?.phase ?? 'Starting…'}
                current={repullProgress?.current ?? 0}
                total={repullProgress?.total ?? 0}
                startedAt={repullStartedAt}
              />
            </div>
          )}
          {repull.state !== 'working' && repull.msg && (
            <p
              className={`px-3 py-1.5 text-[11px] font-body ${repull.state === 'error' ? 'text-error' : 'text-text-secondary'}`}
            >
              {repull.msg}
            </p>
          )}
          <div className="border-t border-border-default my-1" />
          {status.draftBehind > 0 && (
            <button
              type="button"
              role="menuitem"
              disabled={draftBusy || dirtyCount > 0}
              onClick={() => {
                setOpen(false)
                onSyncDraft()
              }}
              className={`${itemClass} text-brand-cyan hover:text-brand-navy disabled:opacity-50 disabled:cursor-not-allowed`}
              title={
                dirtyCount > 0
                  ? 'Save or discard unsaved changes first'
                  : 'Pull the latest live changes into your draft so publishing won’t conflict.'
              }
            >
              Update draft from live ({status.draftBehind})
            </button>
          )}
          {onResetDraft && (
          <button
            type="button"
            role="menuitem"
            disabled={draftBusy}
            onClick={() => {
              setOpen(false)
              onResetDraft()
            }}
            className={`${itemClass} text-error hover:bg-error/5 disabled:opacity-50 disabled:cursor-not-allowed`}
            title="Discard all unpublished draft edits and start fresh from the live site."
          >
            Reset draft to live
          </button>
          )}
          {status.canRevertPublish && canPublishLive && (
            <>
              <div className="border-t border-border-default my-1" />
              <button
                type="button"
                role="menuitem"
                disabled={publishing}
                onClick={() => {
                  setOpen(false)
                  onRollback()
                }}
                className={`${itemClass} text-error hover:bg-error/5 disabled:opacity-50 disabled:cursor-not-allowed`}
                title="Force the live site back to its pre-publish state. Draft keeps the changes for fixing."
              >
                Revert last publish
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function EditorTopBar({
  sessionId,
  firmName,
  websiteUrl,
  status,
  dirtyCount,
  selectedPath,
  canSave,
  canPublishLive,
  isOwner = false,
  saving,
  publishing,
  draftBusy,
  onSave,
  onPublish,
  onRollback,
  onSyncDraft,
  onResetDraft,
  onRepullDone,
}: {
  sessionId: string
  firmName: string
  websiteUrl: string
  status: EditorStatus | null
  dirtyCount: number
  selectedPath: string | null
  canSave: boolean
  canPublishLive: boolean
  // Site Owners have no admin workspace to go back to — show a sign-out control
  // in place of the "← Dashboard/Content" back link.
  isOwner?: boolean
  saving: boolean
  publishing: boolean
  draftBusy: boolean
  onSave: () => void
  onPublish: () => void
  onRollback: () => void
  onSyncDraft: () => void
  // Admin-only (the draft route rejects reset for everyone else); omitted →
  // the "Reset draft to live" item is hidden.
  onResetDraft?: () => void
  onRepullDone?: () => void
}) {
  const pill = statusPill(status, dirtyCount)
  const behind = status?.draftBehind ?? 0

  return (
    <header className="flex items-center justify-between gap-4 px-6 py-3 border-b border-border-default bg-surface-card">
      <div className="flex items-center gap-3 min-w-0">
        {isOwner ? (
          <form action={signOut}>
            <button
              type="submit"
              className="text-text-muted hover:text-brand-cyan font-heading text-xs whitespace-nowrap"
            >
              Sign out
            </button>
          </form>
        ) : (
          <Link
            href={canPublishLive ? '/admin/dashboard' : '/admin/content'}
            className="text-text-muted hover:text-brand-cyan font-heading text-xs whitespace-nowrap"
          >
            ← {canPublishLive ? 'Dashboard' : 'Content'}
          </Link>
        )}
        <h1 className="font-heading font-semibold text-sm text-brand-navy truncate max-w-[18rem]">
          {firmName}
        </h1>
        <span className="inline-flex items-center gap-1.5 text-xs font-body text-text-secondary whitespace-nowrap">
          <span aria-hidden className={`w-1.5 h-1.5 rounded-full ${pill.dot}`} />
          {pill.text}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {behind > 0 && (
          <button
            onClick={onSyncDraft}
            disabled={draftBusy || dirtyCount > 0 || publishing || saving}
            className="bg-warning/15 text-warning-strong border border-warning/40 disabled:opacity-50 font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:bg-warning/25 disabled:cursor-not-allowed whitespace-nowrap"
            title={
              dirtyCount > 0
                ? 'Save or discard unsaved changes first'
                : `Live has ${behind} change(s) your draft is missing — pull them in so publishing won’t conflict.`
            }
          >
            {draftBusy ? 'Updating…' : `Update draft from live (${behind})`}
          </button>
        )}
        <button
          onClick={onSave}
          disabled={!canSave || saving}
          className="bg-brand-cyan disabled:bg-surface-subtle disabled:text-text-muted text-text-inverse font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:bg-brand-cyan-dark disabled:cursor-not-allowed whitespace-nowrap"
          title={selectedPath ? `Save ${selectedPath}` : 'Select a file to save'}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {canPublishLive ? (
          <button
            onClick={onPublish}
            disabled={publishing || (status?.draftAhead ?? 0) === 0 || dirtyCount > 0}
            className="bg-brand-navy disabled:bg-surface-subtle disabled:text-text-muted text-text-inverse font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:bg-brand-navy-dark disabled:cursor-not-allowed whitespace-nowrap"
            title={
              dirtyCount > 0
                ? 'Save your unsaved changes first'
                : (status?.draftAhead ?? 0) === 0
                  ? 'Nothing new to publish'
                  : 'Deploy your saved draft changes to the live site'
            }
          >
            {publishing ? 'Publishing…' : 'Publish to live'}
          </button>
        ) : (
          (status?.draftAhead ?? 0) > 0 && (
            <span
              className="inline-flex items-center gap-1.5 rounded-pill border border-border-default bg-surface-subtle px-3.5 py-1.5 font-heading font-semibold text-xs text-text-secondary whitespace-nowrap"
              title="Your changes are staged on the draft. An admin or manager publishes them to the live site."
            >
              {status?.draftAhead} staged for review
            </span>
          )
        )}
        {status && (
          <OverflowMenu
            sessionId={sessionId}
            websiteUrl={websiteUrl}
            status={status}
            publishing={publishing}
            draftBusy={draftBusy}
            dirtyCount={dirtyCount}
            canPublishLive={canPublishLive}
            isOwner={isOwner}
            onRollback={onRollback}
            onSyncDraft={onSyncDraft}
            onResetDraft={onResetDraft}
            onRepullDone={onRepullDone}
          />
        )}
      </div>
    </header>
  )
}
