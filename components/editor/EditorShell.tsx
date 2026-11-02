'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import EditorTopBar, { type EditorStatus } from './EditorTopBar'
import FileTree, { MEDIA_VIEW, RESOURCES_VIEW, ONEOFF_VIEW, CHANGES_VIEW, THEME_VIEW, CLIENT_CENTER_VIEW, EDIT_STATS_VIEW, type TreeFile } from './FileTree'
import PageEditor from './PageEditor'
import NavEditor from './NavEditor'
import RestructureButton from './RestructureCompare'
import ContentChatModal from './ContentChatModal'
import MediaLibrary from './MediaLibrary'
import ResourcesPanel from './ResourcesPanel'
import OneOffPanel from './OneOffPanel'
import ChangesPanel from './ChangesPanel'
import EditStatsPanel from './EditStatsPanel'
import type { EditStatsResponse } from '@/lib/content/edit-stats'
import ThemeStudio, { type StudioTab } from './ThemeStudio'
import ClientCenterEditor from './ClientCenterEditor'
import NewPageDialog from './NewPageDialog'
import SiteAssistantChat from './SiteAssistantChat'
import dynamic from 'next/dynamic'
import { designPreviewRoute } from '@/lib/editor/design-drawer'
import { parseNavJson } from '@/lib/editor/nav-config'
import { toPathname, type Move } from '@/lib/editor/nav-urls'
import { navUrlToPagePath, pagePathToUrl } from '@/lib/editor/sidebar-nav-tree'
import { reconcileDirtyAfterSave } from '@/lib/ui/dirty-buffers'
import { readRedirectWarnings, redirectWarningMessage } from '@/lib/editor/redirect-warnings'
import { isStaleShaConflict, type ConflictResponse } from '@/lib/editor/conflict-response'
import type { LayoutPresets } from '@/lib/design/layout-presets'
import { REDIRECTS_CSV_PATH, redirectsCacheAction } from '@/lib/editor/redirect-cache'

const NAV_PATH = 'content/nav.json'

// Loaded on first open: the chat pulls in the AI SDK UI + annotate canvas.
const DesignDrawer = dynamic(() => import('./DesignDrawer'), { ssr: false })
const DesignPreviewPane = dynamic(() => import('./DesignPreviewPane'), { ssr: false })

type LoadedFile = { content: string; sha: string }

function withoutPath(set: ReadonlySet<string>, path: string): ReadonlySet<string> {
  if (!set.has(path)) return set
  const next = new Set(set)
  next.delete(path)
  return next
}

export default function EditorShell({
  sessionId,
  firmName,
  websiteUrl,
  initialPath,
  viewerIsOwner = false,
  viewerIsAdmin = false,
  viewerCanPublish = false,
  templateVersion = null,
  sitePresets = null,
}: {
  sessionId: string
  firmName: string
  websiteUrl: string
  // Optional deep-link target (e.g. a Batch Content "Open draft" link). Selected
  // once after the tree loads so the file resolves against a populated tree.
  initialPath?: string
  // True when the viewer is a Site Owner — locks the UI to their one site:
  // no theme, no site-wide assistant, no nav/config editing; they publish and
  // use per-page AI edit. Known server-side to avoid a flash of the full chrome.
  viewerIsOwner?: boolean
  // Resolved server-side by the page (no client /api/auth/me round-trip):
  // admin gates Theme Studio / edit stats / Site Assistant; canPublish gates
  // the publish + rollback affordances (the routes enforce both regardless).
  viewerIsAdmin?: boolean
  viewerCanPublish?: boolean
  // The DRAFT template's version (c5-template.json), read server-side; filters
  // the section layout picker. null = unreadable ⇒ baseline layouts only.
  templateVersion?: string | null
  // The draft design.json layout presets (template 2026.09.9), read
  // server-side; the Sections outline marks sections that follow one.
  sitePresets?: LayoutPresets | null
}) {
  const [tree, setTree] = useState<TreeFile[]>([])
  const [status, setStatus] = useState<EditorStatus | null>(null)
  // Theme Studio is admin-only; managers and owners never see the entry (the
  // route also 403s them).
  const isAdmin = viewerIsAdmin
  // Admin-only edit-activity stats (git-history derived). Fetched once the caller
  // is known to be an admin; drives the Edit Activity panel + per-file tree badges.
  const [editStats, setEditStats] = useState<EditStatsResponse | null>(null)
  const [editStatsLoading, setEditStatsLoading] = useState(false)
  const [editStatsError, setEditStatsError] = useState<string | null>(null)
  // Publishing to live is denied to editors — the publish/rollback routes 403
  // them, so hide those affordances. Admins, managers, and site owners may
  // publish (owner is known server-side, so seed the state true for them).
  const publishAllowed = viewerCanPublish || viewerIsOwner
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Map<string, LoadedFile>>(new Map())
  const [dirty, setDirty] = useState<Map<string, string>>(new Map())
  const [loadingTree, setLoadingTree] = useState(true)
  const [loadingFile, setLoadingFile] = useState(false)
  const [saving, setSaving] = useState(false)
  // Pending page relocations emitted by NavEditor (an item's url changed via
  // nesting). Applied by the /nav route on save; reset after each nav save.
  const [navMoves, setNavMoves] = useState<Move[]>([])
  const [publishing, setPublishing] = useState(false)
  const [pageActioning, setPageActioning] = useState(false)
  // Live progress line during a bulk move ("Moving 3 of 14…").
  const [bulkStatus, setBulkStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [publishResult, setPublishResult] = useState<string | null>(null)
  // New pages whose AI first draft is still running (the file holds the starter until it lands).
  const [draftingPaths, setDraftingPaths] = useState<ReadonlySet<string>>(() => new Set())
  const [conflictPrUrl, setConflictPrUrl] = useState<string | null>(null)
  const [draftBusy, setDraftBusy] = useState(false)
  const [newPageOpen, setNewPageOpen] = useState(false)
  // Site-structure assistant drawer — admin-only, page-independent (available
  // over any open file, like Theme Studio but as a slide-in panel).
  const [assistantOpen, setAssistantOpen] = useState(false)
  // Design drawer — admin-only quick design revisions (the Design Studio chat
  // without the concept workflow) beside a live draft preview of the page.
  const [designOpen, setDesignOpen] = useState(false)
  // Bumped after each design commit so the preview re-reads the draft theme.
  const [designVersion, setDesignVersion] = useState(0)
  const [themeTab, setThemeTab] = useState<StudioTab>('controls')
  // Set when a save hits a sha conflict (someone else saved the same file).
  // The admin chooses explicitly: overwrite with their version, or take the
  // server's — no silent last-writer-wins.
  const [conflict, setConflict] = useState<{
    path: string
    serverSha: string
    serverContent: string
  } | null>(null)

  const refreshStatus = useCallback(async () => {
    const res = await fetch(`/api/edit/${sessionId}/status`)
    if (!res.ok) return
    setStatus((await res.json()) as EditorStatus)
  }, [sessionId])

  const refreshTree = useCallback(async () => {
    setLoadingTree(true)
    try {
      const res = await fetch(`/api/edit/${sessionId}/tree`)
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `Tree load failed: ${res.status}`)
      }
      const data = (await res.json()) as { entries: TreeFile[] }
      setTree(data.entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file tree')
    } finally {
      setLoadingTree(false)
    }
  }, [sessionId])

  const refreshEditStats = useCallback(async () => {
    setEditStatsLoading(true)
    setEditStatsError(null)
    try {
      const res = await fetch(`/api/edit/${sessionId}/edit-stats`)
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `Failed to load edit activity: ${res.status}`)
      }
      setEditStats((await res.json()) as EditStatsResponse)
    } catch (err) {
      setEditStatsError(err instanceof Error ? err.message : 'Failed to load edit activity')
    } finally {
      setEditStatsLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    // Standard data-loading-on-mount pattern. setState happens only after
    // the async fetches resolve; ESLint's set-state-in-effect rule still
    // flags the indirect reference inside the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshTree()
    void refreshStatus()
  }, [refreshTree, refreshStatus])

  // Load edit activity once per editor open, for admins only. We intentionally
  // do NOT refetch on every new commit: the stats walk hits the GitHub API, and
  // refetching on each save/publish (which moves draft HEAD) turned normal
  // editing into a rate-limit storm. The panel's Refresh button covers staleness.
  useEffect(() => {
    if (!isAdmin) return
    // Data-loading effect; setState happens only after the fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshEditStats()
  }, [isAdmin, refreshEditStats])

  // Warn admin when navigating away with unsaved edits.
  useEffect(() => {
    if (dirty.size === 0) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty.size])

  // Publish/rollback results surface as a transient toast, not a permanent
  // top-bar item — auto-dismiss so the header stays uncluttered.
  useEffect(() => {
    if (!publishResult) return
    const t = setTimeout(() => setPublishResult(null), 6000)
    return () => clearTimeout(t)
  }, [publishResult])

  const select = useCallback(
    async (path: string) => {
      setError(null)
      setSelectedPath(path)
      if (
        path === MEDIA_VIEW ||
        path === RESOURCES_VIEW ||
        path === ONEOFF_VIEW ||
        path === CHANGES_VIEW ||
        path === THEME_VIEW ||
        path === CLIENT_CENTER_VIEW ||
        path === EDIT_STATS_VIEW
      )
        return // virtual view, nothing to fetch
      if (loaded.has(path)) return
      setLoadingFile(true)
      try {
        const res = await fetch(`/api/edit/${sessionId}/file?path=${encodeURIComponent(path)}`)
        if (!res.ok) {
          const data = (await res.json()) as { error?: string }
          throw new Error(data.error ?? `Load failed: ${res.status}`)
        }
        const blob = (await res.json()) as { path: string; content: string; sha: string }
        setLoaded((prev) => new Map(prev).set(path, { content: blob.content, sha: blob.sha }))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load file')
      } finally {
        setLoadingFile(false)
      }
    },
    [sessionId, loaded]
  )

  // Apply a deep-link target once, after the tree finishes loading so the file
  // resolves against a populated tree (a Batch Content "Open draft" link lands here).
  const [initialApplied, setInitialApplied] = useState(false)
  useEffect(() => {
    if (initialApplied || !initialPath || loadingTree) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInitialApplied(true)
    void select(initialPath)
  }, [initialApplied, initialPath, loadingTree, select])

  // Keep nav.json content in the loaded cache so the nav-aware Pages sidebar can
  // seed from it. Fetches once after the tree loads, and re-fetches whenever the
  // tree's nav.json sha diverges from the cached copy (external change). Skipped
  // for Site Owners (they use the plain page list). No selectedPath change.
  const navFetchRef = useRef<string | null>(null)
  const [navFetchFailedSha, setNavFetchFailedSha] = useState<string | null>(null)
  useEffect(() => {
    if (loadingTree || viewerIsOwner) return
    const navEntry = tree.find((e) => e.path === NAV_PATH)
    if (!navEntry) return
    const have = loaded.get(NAV_PATH)
    if (have && have.sha === navEntry.sha) return
    if (navFetchRef.current === navEntry.sha) return
    navFetchRef.current = navEntry.sha
    void (async () => {
      try {
        const res = await fetch(`/api/edit/${sessionId}/file?path=${encodeURIComponent(NAV_PATH)}`)
        if (!res.ok) {
          setNavFetchFailedSha(navEntry.sha)
          return
        }
        const blob = (await res.json()) as { content: string; sha: string }
        setLoaded((prev) => new Map(prev).set(NAV_PATH, { content: blob.content, sha: blob.sha }))
        setNavFetchFailedSha(null)
      } catch {
        /* non-fatal — the sidebar falls back to a plain page list */
        setNavFetchFailedSha(navEntry.sha)
      }
    })()
  }, [loadingTree, tree, loaded, viewerIsOwner, sessionId])

  // nav.json is fetched async after the tree loads; distinguish "still loading"
  // from "missing/malformed" so the sidebar doesn't flash a read-error warning
  // during the normal loading window.
  const navSha = tree.find((e) => e.path === NAV_PATH)?.sha ?? null
  const navLoading = navSha !== null && !loaded.has(NAV_PATH) && navFetchFailedSha !== navSha

  // Force-reload a file from the server, replacing the cached content + sha and
  // clearing any dirty state — used after the AI agent commits a new version.
  const reloadFile = useCallback(
    async (path: string) => {
      try {
        const res = await fetch(`/api/edit/${sessionId}/file?path=${encodeURIComponent(path)}`)
        if (!res.ok) return
        const blob = (await res.json()) as { content: string; sha: string }
        setLoaded((prev) => new Map(prev).set(path, { content: blob.content, sha: blob.sha }))
        setDirty((prev) => {
          const m = new Map(prev)
          m.delete(path)
          return m
        })
      } catch {
        /* non-fatal — a stale cache surfaces as a save conflict the admin resolves */
      }
    },
    [sessionId]
  )

  // A server write removed rows from redirects.csv (a page was created or
  // restored over a redirect): refresh an unedited cached copy so its next
  // save doesn't 409 on the old sha. Unsaved edits are never overwritten.
  const pendingRedirectNotice = useRef<string | null>(null)
  const loadedRef = useRef(loaded)
  const dirtyRef = useRef(dirty)
  useEffect(() => {
    loadedRef.current = loaded
    dirtyRef.current = dirty
  }, [loaded, dirty])
  const refreshRedirectsCache = useCallback(() => {
    if (redirectsCacheAction(loadedRef.current, dirtyRef.current) === 'reload') void reloadFile(REDIRECTS_CSV_PATH)
  }, [reloadFile])

  // After a single file is reverted from the Changes panel, drop its cached
  // blob so a later reopen pulls the reverted content, and refresh the tree +
  // publish status (the revert is a new draft commit; a removed file leaves the
  // tree).
  const handleReverted = useCallback(
    async (path: string) => {
      setLoaded((prev) => {
        const m = new Map(prev)
        m.delete(path)
        return m
      })
      setDirty((prev) => {
        const m = new Map(prev)
        m.delete(path)
        return m
      })
      await refreshTree()
      await refreshStatus()
    },
    [refreshTree, refreshStatus]
  )

  const currentContent = (): string | null => {
    if (!selectedPath) return null
    const draft = dirty.get(selectedPath)
    if (draft !== undefined) return draft
    return loaded.get(selectedPath)?.content ?? null
  }

  const onEdit = (next: string) => {
    if (!selectedPath) return
    const base = loaded.get(selectedPath)
    if (base && base.content === next) {
      setDirty((prev) => {
        const m = new Map(prev)
        m.delete(selectedPath)
        return m
      })
    } else {
      setDirty((prev) => new Map(prev).set(selectedPath, next))
    }
  }

  const save = async () => {
    if (!selectedPath) return
    const next = dirty.get(selectedPath)
    if (next === undefined) return
    const base = loaded.get(selectedPath)
    if (!base) return

    const isNavSave = selectedPath === NAV_PATH
    if (isNavSave) {
      try {
        parseNavJson(next)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid nav.json')
        return
      }
    }

    setSaving(true)
    setError(null)
    setPublishResult(null)
    try {
      // nav.json goes through /nav, which also relocates any page whose url
      // changed (nesting) and adds a 301. Other files use the generic writer.
      const res = isNavSave
        ? await fetch(`/api/edit/${sessionId}/nav`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: next, moves: navMoves, expectedSha: base.sha }),
          })
        : await fetch(`/api/edit/${sessionId}/files`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: selectedPath, contents: next, expectedSha: base.sha }),
          })
      if (res.status === 409) {
        const data = (await res.json()) as ConflictResponse
        // Only a stale sha on THIS file opens the conflict bar; any other 409
        // (e.g. the nav save's page file or redirects.csv went stale) is a
        // plain error, never another file's content loaded into this buffer.
        if (isStaleShaConflict(data)) {
          setConflict({ path: selectedPath, serverSha: data.currentSha, serverContent: data.currentContent })
        } else {
          setError(data.error ?? 'The save conflicted with another change. Reload to continue.')
        }
        return
      }
      if (res.status === 422) {
        // A page already lives at a target URL. Surface it and keep the edits so
        // the admin can rename the colliding item and retry (no data loss).
        const data = (await res.json()) as { error?: string; collision?: { to: string } }
        setError(data.error ?? `A page already exists at ${data.collision?.to ?? 'the destination'}.`)
        return
      }
      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        throw new Error(data.error ?? `Save failed: ${res.status}`)
      }
      const data = (await res.json()) as { commitSha: string; blobSha: string; contents?: string }
      // The server may normalize what it stores (redirects.csv sources lose a
      // trailing slash): show exactly what was committed under the new sha.
      const savedContent = typeof data.contents === 'string' ? data.contents : next
      // The nav save kept redirects.csv rows that still shadow a real page
      // (never removed automatically): shown once the save has settled.
      const redirectNotice = redirectWarningMessage('Saved', readRedirectWarnings(data))
      // Always adopt the new blob sha (the saved content is now the base), but
      // only clear the dirty buffer if it still equals what we sent — typing
      // that happened while the save was in flight stays dirty.
      setLoaded((prev) =>
        new Map(prev).set(selectedPath, { content: savedContent, sha: data.blobSha })
      )
      setDirty((prev) => reconcileDirtyAfterSave(prev, selectedPath, next))
      if (isNavSave) {
        setNavMoves([])
        // Pages were relocated on the draft branch — refresh the tree so the
        // moved files show at their new paths.
        await refreshTree()
      }
      await refreshStatus()
      if (redirectNotice) setError(redirectNotice)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const publish = async () => {
    if (dirty.size > 0) {
      setError('Save all unsaved changes before publishing.')
      return
    }
    if (
      !window.confirm(
        'Publish all draft changes to the live site? Visitors will see them once Vercel finishes deploying.'
      )
    ) {
      return
    }
    setPublishing(true)
    setError(null)
    setPublishResult(null)
    setConflictPrUrl(null)
    try {
      const res = await fetch(`/api/edit/${sessionId}/publish`, { method: 'POST' })
      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        throw new Error(data.error ?? `Publish failed: ${res.status}`)
      }
      const data = (await res.json()) as
        | { merged: true; mergeCommitSha: string }
        | { merged: false; prUrl: string }
      if (data.merged) {
        setPublishResult('Published to live — Vercel is deploying.')
        // Reload tree + status, since draft was reset to main.
        setLoaded(new Map())
        await refreshTree()
        await refreshStatus()
      } else {
        // A merge conflict needs manual resolution in GitHub — surface a
        // persistent, clickable link rather than a toast that auto-dismisses.
        setConflictPrUrl(data.prUrl)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed')
    } finally {
      setPublishing(false)
    }
  }

  const resolveConflictMine = async () => {
    if (!conflict) return
    const mine = dirty.get(conflict.path)
    if (mine === undefined) {
      setConflict(null)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const isNavConflict = conflict.path === NAV_PATH
      const res = isNavConflict
        ? await fetch(`/api/edit/${sessionId}/nav`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: mine, moves: navMoves, expectedSha: conflict.serverSha }),
          })
        : await fetch(`/api/edit/${sessionId}/files`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: conflict.path, contents: mine, expectedSha: conflict.serverSha }),
          })
      if (res.status === 409) {
        // The file moved AGAIN while the conflict bar was open — refresh the
        // conflict to the newest server state so the choice stays valid
        // (otherwise "keep mine" loops on a stale sha forever).
        const data = (await res.json()) as ConflictResponse
        if (isStaleShaConflict(data)) {
          setConflict({ path: conflict.path, serverSha: data.currentSha, serverContent: data.currentContent })
        } else {
          setConflict(null)
          setError(data.error ?? 'The save conflicted with another change. Reload to continue.')
        }
        return
      }
      if (res.status === 422) {
        const data = (await res.json()) as { error?: string; collision?: { to: string } }
        setError(data.error ?? `A page already exists at ${data.collision?.to ?? 'the destination'}.`)
        return
      }
      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        throw new Error(data.error ?? `Save failed: ${res.status}`)
      }
      const data = (await res.json()) as { commitSha: string; blobSha: string; contents?: string }
      const redirectNotice = redirectWarningMessage('Saved', readRedirectWarnings(data))
      const savedMine = typeof data.contents === 'string' ? data.contents : mine
      setLoaded((prev) => new Map(prev).set(conflict.path, { content: savedMine, sha: data.blobSha }))
      setDirty((prev) => reconcileDirtyAfterSave(prev, conflict.path, mine))
      setConflict(null)
      if (isNavConflict) {
        setNavMoves([])
        await refreshTree()
      }
      await refreshStatus()
      if (redirectNotice) setError(redirectNotice)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const resolveConflictTheirs = () => {
    if (!conflict) return
    setLoaded((prev) =>
      new Map(prev).set(conflict.path, { content: conflict.serverContent, sha: conflict.serverSha })
    )
    setDirty((prev) => {
      const m = new Map(prev)
      m.delete(conflict.path)
      return m
    })
    setConflict(null)
  }

  const rollback = async () => {
    if (
      !window.confirm(
        'Revert the last publish? The live site goes back to its previous state; your published changes stay in draft so you can fix and re-publish.'
      )
    ) {
      return
    }
    setPublishing(true)
    setError(null)
    setPublishResult(null)
    try {
      const res = await fetch(`/api/edit/${sessionId}/rollback`, { method: 'POST' })
      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        throw new Error(data.error ?? `Rollback failed: ${res.status}`)
      }
      setPublishResult('Live site reverted — Vercel is redeploying the previous version.')
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rollback failed')
    } finally {
      setPublishing(false)
    }
  }

  // Reload the branch's files after draft was rewritten server-side (sync/reset),
  // so the editor shows the new content instead of stale cached blobs.
  const reloadAfterDraftChange = async () => {
    setLoaded(new Map())
    setDirty(new Map())
    setNavMoves([])
    await refreshTree()
    await refreshStatus()
    if (selectedPath) await reloadFile(selectedPath)
  }

  // "Keep draft current": pull live (main) into the draft branch so publishing
  // won't conflict. Requires a clean editor (no unsaved edits) — the merge
  // rewrites files under you.
  const syncDraft = async () => {
    setDraftBusy(true)
    setError(null)
    setPublishResult(null)
    setConflictPrUrl(null)
    try {
      const res = await fetch(`/api/edit/${sessionId}/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync' }),
      })
      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        throw new Error(data.error ?? `Update failed: ${res.status}`)
      }
      const data = (await res.json()) as
        | { synced: true; alreadyCurrent: boolean }
        | { synced: false; reason: string }
      if (!data.synced) {
        setError(data.reason)
        return
      }
      if (data.alreadyCurrent) {
        setPublishResult('Draft is already up to date with live.')
        await refreshStatus()
      } else {
        setPublishResult('Draft updated from live — review, then publish.')
        await reloadAfterDraftChange()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setDraftBusy(false)
    }
  }

  // Self-heal a stale draft. When the draft is strictly behind live (every draft
  // commit already landed on main — e.g. after an operator hand-merged a publish
  // conflict PR on GitHub) and there is no local work to lose, fast-forward the
  // draft to live automatically so the "update from live"/conflict state clears
  // without a manual click. syncMainIntoDraft is a clean fast-forward here (draft
  // is an ancestor of main), so it never conflicts. Attempt at most once per
  // distinct behind-status so a transient failure can't spin.
  // Latest-ref so the heal effect can call syncDraft without re-subscribing to it
  // (syncDraft is re-created each render — depending on it would churn the effect).
  const syncDraftRef = useRef(syncDraft)
  useEffect(() => {
    syncDraftRef.current = syncDraft
  })
  const healSigRef = useRef<string | null>(null)
  useEffect(() => {
    if (!status) return
    if (!(status.draftAhead === 0 && status.draftBehind > 0)) return
    if (dirty.size > 0 || draftBusy) return
    const sig = `${status.lastCommitSha ?? ''}:${status.draftBehind}`
    if (healSigRef.current === sig) return
    healSigRef.current = sig
    void syncDraftRef.current()
  }, [status, dirty.size, draftBusy])

  // "Reset draft to live": discard the draft entirely and start from what's live.
  // Destructive — unpublished draft edits are lost.
  const resetDraft = async () => {
    if (
      !window.confirm(
        'Reset the draft to the live site? This DISCARDS all unpublished draft edits and starts fresh from what is currently live. This cannot be undone.'
      )
    ) {
      return
    }
    setDraftBusy(true)
    setError(null)
    setPublishResult(null)
    setConflictPrUrl(null)
    try {
      const res = await fetch(`/api/edit/${sessionId}/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      })
      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        throw new Error(data.error ?? `Reset failed: ${res.status}`)
      }
      setPublishResult('Draft reset to live — start editing fresh.')
      await reloadAfterDraftChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setDraftBusy(false)
    }
  }

  // Move the selected page between live (content/pages|posts) and drafts.
  // Staged on the draft branch — goes live on the next Publish.
  const setPageState = async (action: 'draft' | 'restore') => {
    if (!selectedPath) return
    const sha = loaded.get(selectedPath)?.sha
    if (!sha) return
    const prompt =
      action === 'draft'
        ? 'Set this page to draft (remove it from the live site)?'
        : 'Restore this page to the live site?'
    if (!window.confirm(`${prompt} The change goes live when you next Publish.`)) return

    setPageActioning(true)
    setError(null)
    setPublishResult(null)
    try {
      const res = await fetch(`/api/edit/${sessionId}/page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedPath, expectedSha: sha, action }),
      })
      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        throw new Error(data.error ?? `Failed: ${res.status}`)
      }
      const data = (await res.json()) as { newPath: string; redirectNotice?: string }
      if (data.redirectNotice) refreshRedirectsCache()
      const oldPath = selectedPath
      setLoaded((prev) => {
        const m = new Map(prev)
        m.delete(oldPath)
        return m
      })
      setDirty((prev) => {
        const m = new Map(prev)
        m.delete(oldPath)
        return m
      })
      await refreshTree()
      await refreshStatus()
      await select(data.newPath)
      setPublishResult(
        action === 'draft'
          ? 'Moved to drafts — Publish to take it off the live site.'
          : `Restored — Publish to put it back on the live site.${data.redirectNotice ? ` ${data.redirectNotice}` : ''}`
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setPageActioning(false)
    }
  }

  // Relocate the selected content file (page ↔ resource, or reparent). Staged on
  // the draft branch — goes live on the next Publish. Mirrors setPageState's
  // cache-eviction + reselect flow.
  const moveSelected = async (toUrl: string, navAction: 'retarget' | 'remove' | 'none') => {
    if (!selectedPath) return
    const sha = loaded.get(selectedPath)?.sha
    if (!sha) return
    setPageActioning(true)
    setError(null)
    setPublishResult(null)
    try {
      const res = await fetch(`/api/edit/${sessionId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromPath: selectedPath, toUrl, expectedSha: sha, navAction }),
      })
      if (res.status === 422) {
        const data = (await res.json()) as { error?: string; collision?: { to: string } }
        setError(data.error ?? `A page already exists at ${data.collision?.to ?? 'the destination'}.`)
        return
      }
      if (!res.ok) {
        const data = (await res.json()) as { error?: string; message?: string }
        throw new Error(data.error === 'stale_sha' ? (data.message ?? 'File changed on the server.') : (data.error ?? `Move failed: ${res.status}`))
      }
      const data = (await res.json()) as { toPath: string; warning?: string }
      const redirectNotice = redirectWarningMessage('Moved', readRedirectWarnings(data))
      const oldPath = selectedPath
      setLoaded((prev) => {
        const m = new Map(prev)
        m.delete(oldPath)
        return m
      })
      setDirty((prev) => {
        const m = new Map(prev)
        m.delete(oldPath)
        return m
      })
      await refreshTree()
      await refreshStatus()
      await select(data.toPath)
      setPublishResult(
        data.warning
          ? `Moved — Publish to update the live site. Heads up: ${data.warning}`
          : 'Moved — Publish to update the live site.'
      )
      // After select(), which clears the banner on load.
      if (redirectNotice) setError(redirectNotice)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Move failed')
    } finally {
      setPageActioning(false)
    }
  }

  // Bulk-relocate several pages at once (from the Pages multi-select). Each move
  // is an independent draft commit; a per-file failure is collected (with its
  // reason), not fatal. Reports live progress and returns true only when every
  // file moved. Fetches a missing sha on demand so unopened files can be moved.
  const bulkMove = async (
    paths: string[],
    dest: { type: 'resources' } | { type: 'under'; parentUrl: string }
  ): Promise<boolean> => {
    if (paths.length === 0) return false
    setPageActioning(true)
    setError(null)
    setPublishResult(null)
    setBulkStatus(`Moving 0 of ${paths.length}…`)
    const failures: { name: string; reason: string }[] = []
    const warnings: string[] = []
    const bulkRedirectWarnings: string[] = []
    let done = 0
    for (const p of paths) {
      const name = p.split('/').pop() ?? p
      let sha = loaded.get(p)?.sha
      if (!sha) {
        try {
          const r = await fetch(`/api/edit/${sessionId}/file?path=${encodeURIComponent(p)}`)
          if (r.ok) sha = ((await r.json()) as { sha: string }).sha
        } catch {
          /* fall through to failure */
        }
      }
      if (!sha) {
        failures.push({ name, reason: 'could not load the file' })
        setBulkStatus(`Moving ${++done} of ${paths.length}…`)
        continue
      }
      const lastSlug = name.replace(/\.md$/, '').split('--').pop() ?? ''
      // `/resources/<slug>` only names the post file here: the move route maps
      // it to the site's blog path (content/blog.json, e.g. /insights) for the
      // canonical and the 301.
      const toUrl = dest.type === 'resources' ? `/resources/${lastSlug}` : `${dest.parentUrl}/${lastSlug}`
      const navAction = dest.type === 'resources' ? 'remove' : 'retarget'
      try {
        const res = await fetch(`/api/edit/${sessionId}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromPath: p, toUrl, expectedSha: sha, navAction }),
        })
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
          const reason =
            data.error === 'stale_sha'
              ? (data.message ?? 'changed on the server')
              : (data.error ?? `HTTP ${res.status}`)
          failures.push({ name, reason })
        } else {
          const data = (await res.json().catch(() => ({}))) as { warning?: string }
          if (data.warning) warnings.push(name)
          bulkRedirectWarnings.push(...readRedirectWarnings(data))
        }
      } catch {
        failures.push({ name, reason: 'network error' })
      }
      setLoaded((prev) => {
        const m = new Map(prev)
        m.delete(p)
        return m
      })
      setBulkStatus(`Moving ${++done} of ${paths.length}…`)
    }
    if (selectedPath && paths.includes(selectedPath)) setSelectedPath(null)
    await refreshTree()
    await refreshStatus()
    setBulkStatus(null)
    setPageActioning(false)
    const bulkNotice = redirectWarningMessage('Redirects', bulkRedirectWarnings)
    // Posts that kept a generator trailer render it live: say so on EVERY path,
    // including a partial failure.
    const trailerNotice = warnings.length
      ? ` Heads up: ${warnings.join(', ')} still carry an SEO & AIO Metadata section with content after it; remove it by hand.`
      : ''
    if (failures.length > 0) {
      setError(
        `Moved ${paths.length - failures.length} of ${paths.length}. Failed: ${failures
          .map((f) => `${f.name} (${f.reason})`)
          .join('; ')}` +
          trailerNotice +
          (bulkNotice ? ` ${bulkNotice}` : '')
      )
      return false
    }
    setPublishResult(
      `Moved ${paths.length} ${dest.type === 'resources' ? 'to Resources' : 'under ' + dest.parentUrl} — Publish to update the live site.` +
        trailerNotice
    )
    if (bulkNotice) setError(redirectWarningMessage(`Moved ${paths.length}`, bulkRedirectWarnings))
    return true
  }

  // Persist an inline navigation change (reorder / nest / show-hide) from the
  // Pages sidebar immediately — mirrors moveSelected: POST /nav (which relocates
  // any page whose url changed + writes 301s), then refresh and reselect a
  // relocated open page. Returns false on failure so the sidebar snaps back.
  const commitNav = async (contents: string, moves: Move[]): Promise<boolean> => {
    const navEntry = tree.find((e) => e.path === NAV_PATH)
    if (!navEntry) {
      setError('Navigation file not found.')
      return false
    }

    // Guard: a nesting change relocates the page file. If the open page is being
    // moved and has unsaved edits, block — the move would orphan those edits.
    const openUrl = selectedPath ? toPathname(pagePathToUrl(selectedPath)) : null
    const openMove =
      openUrl && selectedPath && selectedPath.startsWith('content/pages/')
        ? moves.find((m) => toPathname(m.from) === openUrl)
        : undefined
    if (openMove && selectedPath && dirty.has(selectedPath)) {
      setError('Save or discard your edits to this page before reordering it in navigation.')
      return false
    }

    setPageActioning(true)
    setError(null)
    setPublishResult(null)
    try {
      const res = await fetch(`/api/edit/${sessionId}/nav`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, moves, expectedSha: navEntry.sha }),
      })
      if (res.status === 409) {
        setError('Navigation changed on the server. Reload to continue.')
        await refreshTree()
        return false
      }
      if (res.status === 422) {
        const data = (await res.json()) as { error?: string; collision?: { to: string } }
        setError(data.error ?? `A page already exists at ${data.collision?.to ?? 'the destination'}.`)
        return false
      }
      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        throw new Error(data.error ?? `Save failed: ${res.status}`)
      }
      const data = (await res.json()) as { commitSha: string; blobSha: string; moved: number }
      const redirectNotice = redirectWarningMessage('Saved', readRedirectWarnings(data))
      setLoaded((prev) => new Map(prev).set(NAV_PATH, { content: contents, sha: data.blobSha }))
      setNavMoves([])

      if (openMove && selectedPath) {
        // The open page was relocated — evict its stale cache and reselect the new path.
        const oldPath = selectedPath
        const newPath = navUrlToPagePath(openMove.to)
        setLoaded((prev) => {
          const m = new Map(prev)
          m.delete(oldPath)
          return m
        })
        setDirty((prev) => {
          const m = new Map(prev)
          m.delete(oldPath)
          return m
        })
        await refreshTree()
        await refreshStatus()
        if (newPath) await select(newPath)
      } else {
        await refreshTree()
        await refreshStatus()
      }
      // After any select(), which clears the banner on load.
      if (redirectNotice) setError(redirectNotice)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Navigation update failed')
      return false
    } finally {
      setPageActioning(false)
    }
  }

  const deletePage = async () => {
    if (!selectedPath) return
    const sha = loaded.get(selectedPath)?.sha
    if (!sha) return
    if (
      !window.confirm(
        'Delete this page permanently from the repo? The change goes live when you next Publish.'
      )
    ) {
      return
    }
    setPageActioning(true)
    setError(null)
    setPublishResult(null)
    try {
      const res = await fetch(
        `/api/edit/${sessionId}/page?path=${encodeURIComponent(selectedPath)}&sha=${encodeURIComponent(sha)}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        throw new Error(data.error ?? `Delete failed: ${res.status}`)
      }
      const oldPath = selectedPath
      setSelectedPath(null)
      setLoaded((prev) => {
        const m = new Map(prev)
        m.delete(oldPath)
        return m
      })
      setDirty((prev) => {
        const m = new Map(prev)
        m.delete(oldPath)
        return m
      })
      await refreshTree()
      await refreshStatus()
      setPublishResult('Page deleted — Publish to remove it from the live site.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setPageActioning(false)
    }
  }

  const content = currentContent()
  // The drawer never shows over Theme Studio (it hosts the same chat).
  const designActive = isAdmin && designOpen && selectedPath !== THEME_VIEW
  const designRoute = designPreviewRoute(selectedPath)
  const isNav = selectedPath === 'content/nav.json'
  const isLivePage =
    !!selectedPath &&
    (selectedPath.startsWith('content/pages/') || selectedPath.startsWith('content/posts/'))
  const isDraftPage =
    !!selectedPath && selectedPath.startsWith('content/drafts/') && selectedPath.endsWith('.md')
  // Blog posts (incl. those drafted from the Resources panel) get an inline
  // "Publish to live" so publishing is reachable right where the post is opened.
  const isPostPage = !!selectedPath && selectedPath.startsWith('content/posts/')
  const canPublish = (status?.draftAhead ?? 0) > 0 && dirty.size === 0 && !publishing
  const canPageAct = !!selectedPath && loaded.has(selectedPath) && !pageActioning

  // Move affordances for the selected content file. selName is the encoded
  // filename (e.g. "careers--foo"); selLastSlug its final segment ("foo").
  const selName = selectedPath?.split('/').pop()?.replace(/\.md$/, '') ?? ''
  const selLastSlug = selName.split('--').pop() ?? selName
  const selParentName = selName.split('--').slice(0, -1).join('--')
  const selPageIsFile = !!selectedPath?.startsWith('content/pages/')
  // A page with nested sub-pages can't be reclassified/reparented (it would
  // orphan them); the server refuses it too.
  const selHasChildren =
    selPageIsFile &&
    tree.some(
      (e) =>
        e.path.startsWith('content/pages/') &&
        e.path.endsWith('.md') &&
        e.path !== selectedPath &&
        e.path.slice('content/pages/'.length, -3).startsWith(selName + '--')
    )
  // Candidate parents for "Move under…": every other page except home, the
  // current parent (a no-op), and any descendant of the selected page.
  const moveUnderCandidates = selPageIsFile
    ? tree
        .filter(
          (e) =>
            e.path.startsWith('content/pages/') && e.path.endsWith('.md') && e.path !== selectedPath
        )
        .map((e) => e.path.slice('content/pages/'.length, -3))
        .filter(
          (name) => name !== 'home' && name !== selParentName && !name.startsWith(selName + '--')
        )
        .map((name) => ({ name, url: '/' + name.replace(/--/g, '/') }))
    : []

  return (
    // Admins/managers render under the admin shell's h-16 AdminTopBar, so the
    // editor fills the viewport minus 4rem — a full h-screen overflowed by 64px
    // and pushed the bottom of every panel (e.g. the Design Studio chat composer) below
    // the fold. Site Owners get no admin chrome, so they keep the full height.
    <div className={`flex flex-col ${viewerIsOwner ? 'h-screen' : 'h-[calc(100vh-4rem)]'} bg-surface-default`}>
      <EditorTopBar
        sessionId={sessionId}
        firmName={firmName}
        websiteUrl={websiteUrl}
        status={status}
        dirtyCount={dirty.size}
        selectedPath={selectedPath}
        canSave={!!selectedPath && dirty.has(selectedPath)}
        canPublishLive={publishAllowed}
        isOwner={viewerIsOwner}
        saving={saving}
        publishing={publishing}
        draftBusy={draftBusy}
        onSave={save}
        onPublish={publish}
        onRollback={rollback}
        onSyncDraft={syncDraft}
        onResetDraft={isAdmin ? resetDraft : undefined}
        onRepullDone={() => void refreshStatus()}
      />
      {(isLivePage || isDraftPage) && selectedPath && !designActive && (
        <div className="px-6 py-2 border-b border-border-default bg-surface-default flex items-center justify-end gap-2">
          {isPostPage && publishAllowed && (
            <button
              type="button"
              onClick={() => void publish()}
              disabled={!canPublish}
              title={
                canPublish
                  ? 'Publish all pending draft changes to the live site (including this post)'
                  : 'Nothing new to publish — or save your unsaved edits first'
              }
              className="rounded-pill bg-brand-navy px-3.5 py-1.5 font-heading font-semibold text-xs text-white hover:bg-brand-navy-dark transition-colors disabled:bg-surface-subtle disabled:text-text-muted disabled:cursor-not-allowed"
            >
              {publishing ? 'Publishing…' : 'Publish to live'}
            </button>
          )}
          {isLivePage && (
            <ContentChatModal
              sessionId={sessionId}
              path={selectedPath}
              isDirty={dirty.has(selectedPath)}
              allowed={isAdmin || viewerIsOwner}
              onSave={() => void save()}
              onEdited={() => {
                void reloadFile(selectedPath)
                void refreshStatus()
              }}
            />
          )}
          {isLivePage && selPageIsFile && (isAdmin || viewerIsOwner) && (
            <RestructureButton
              sessionId={sessionId}
              path={selectedPath}
              isDirty={dirty.has(selectedPath)}
              onAccepted={() => {
                void reloadFile(selectedPath)
                void refreshStatus()
              }}
            />
          )}
          {isLivePage && selPageIsFile && (
            <button
              type="button"
              onClick={() => void moveSelected(`/resources/${selLastSlug}`, 'remove')}
              disabled={!canPageAct || selHasChildren}
              title={
                selHasChildren
                  ? 'Move its sub-pages first'
                  : 'Reclassify this page as a blog post under Resources'
              }
              className="rounded-pill border border-brand-navy px-3.5 py-1.5 font-heading font-semibold text-xs text-brand-navy hover:bg-brand-navy/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Move to Resources
            </button>
          )}
          {isLivePage && isPostPage && (
            <button
              type="button"
              onClick={() => void moveSelected(`/${selLastSlug}`, 'none')}
              disabled={!canPageAct}
              title="Reclassify this blog post as a standalone page"
              className="rounded-pill border border-brand-navy px-3.5 py-1.5 font-heading font-semibold text-xs text-brand-navy hover:bg-brand-navy/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Move to Pages
            </button>
          )}
          {isLivePage && selPageIsFile && moveUnderCandidates.length > 0 && (
            <select
              aria-label="Move under another page"
              value=""
              disabled={!canPageAct || selHasChildren}
              onChange={(e) => {
                const url = e.target.value
                if (url) void moveSelected(`${url}/${selLastSlug}`, 'retarget')
              }}
              className="rounded-pill border border-brand-navy bg-surface-default px-3 py-1.5 font-heading font-semibold text-xs text-brand-navy disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">Move under…</option>
              {moveUnderCandidates.map((c) => (
                <option key={c.name} value={c.url}>
                  {c.url}
                </option>
              ))}
            </select>
          )}
          {isLivePage && (
            <button
              type="button"
              onClick={() => void setPageState('draft')}
              disabled={!canPageAct}
              className="rounded-pill border border-brand-navy px-3.5 py-1.5 font-heading font-semibold text-xs text-brand-navy hover:bg-brand-navy/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Take this page off the live site (keeps it in Drafts)"
            >
              Set to draft
            </button>
          )}
          {isDraftPage && (
            <button
              type="button"
              onClick={() => void setPageState('restore')}
              disabled={!canPageAct}
              className="rounded-pill border border-brand-navy px-3.5 py-1.5 font-heading font-semibold text-xs text-brand-navy hover:bg-brand-navy/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Put this page back on the live site"
            >
              Restore to live
            </button>
          )}
          <button
            type="button"
            onClick={() => void deletePage()}
            disabled={!canPageAct}
            aria-label="Delete this page"
            className="rounded-pill border border-error/40 px-3.5 py-1.5 font-heading font-semibold text-xs text-error hover:bg-error/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Delete this page from the repo"
          >
            {pageActioning ? 'Working…' : 'Delete'}
          </button>
        </div>
      )}
      {selectedPath && draftingPaths.has(selectedPath) && (
        <div
          role="status"
          className="px-6 py-2 bg-brand-cyan/10 border-b border-brand-cyan/30 text-brand-navy font-body text-xs"
        >
          AI is still writing this page — it will appear here automatically, usually within a minute or two.
          Edits made now will be replaced by the draft.
        </div>
      )}
      {bulkStatus && (
        <div
          role="status"
          className="px-6 py-2 bg-brand-cyan/10 border-b border-brand-cyan/30 text-brand-navy font-body text-xs"
        >
          {bulkStatus}
        </div>
      )}
      {error && (
        <div role="alert" className="px-6 py-2 bg-warning/10 border-b border-warning/30 text-warning-strong font-body text-xs">
          {error}
        </div>
      )}
      {conflict && (
        <div
          role="alert"
          className="px-6 py-3 bg-warning/10 border-b border-warning/30 font-body text-xs flex items-center gap-4 flex-wrap"
        >
          <span className="text-warning-strong">
            <strong>{conflict.path.split('/').pop()}</strong> was changed on the server while you
            were editing (another admin or a fresh package). Which version should win?
          </span>
          <button
            type="button"
            onClick={() => void resolveConflictMine()}
            disabled={saving}
            className="rounded-pill border border-brand-navy px-3 py-1 font-heading font-semibold text-brand-navy hover:bg-brand-navy/5 transition-colors disabled:opacity-50"
          >
            Keep mine (overwrite server)
          </button>
          <button
            type="button"
            onClick={resolveConflictTheirs}
            disabled={saving}
            className="rounded-pill border border-border-default px-3 py-1 font-heading font-semibold text-text-secondary hover:text-brand-navy transition-colors disabled:opacity-50"
          >
            Take server version (discard mine)
          </button>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        {loadingTree ? (
          <div className="w-64 border-r border-border-default p-4 text-xs text-text-muted">
            Loading files…
          </div>
        ) : (
          <FileTree
            entries={tree}
            selectedPath={selectedPath}
            dirtyPaths={new Set(dirty.keys())}
            changesCount={status?.draftAhead ?? 0}
            showTheme={isAdmin}
            showEditStats={isAdmin}
            editCounts={
              editStats
                ? Object.fromEntries(editStats.rows.map((r) => [r.path, r.editCount]))
                : undefined
            }
            showConfiguration={!viewerIsOwner}
            navContent={loaded.get(NAV_PATH)?.content ?? null}
            navSha={navSha}
            navLoading={navLoading}
            navEditable={!viewerIsOwner}
            navBusy={pageActioning}
            onSelect={(p) => {
              setThemeTab('controls')
              void select(p)
            }}
            onNewPage={() => setNewPageOpen(true)}
            onBulkMove={bulkMove}
            onNavCommit={commitNav}
          />
        )}
        {designActive ? (
          // Leaves room for the fixed 440px drawer on the right.
          <div className="flex min-w-0 flex-1 pr-[min(440px,92vw)]">
            <DesignPreviewPane sessionId={sessionId} route={designRoute} sourcesVersion={designVersion} />
          </div>
        ) : !selectedPath ? (
          <div className="flex-1 flex items-center justify-center text-sm font-body text-text-muted">
            Select a file from the left to begin editing.
          </div>
        ) : selectedPath === CHANGES_VIEW ? (
          <ChangesPanel
            sessionId={sessionId}
            draftBusy={draftBusy}
            onReverted={handleReverted}
            onDiscardAll={resetDraft}
          />
        ) : selectedPath === EDIT_STATS_VIEW ? (
          <EditStatsPanel
            rows={editStats?.rows ?? []}
            truncated={editStats?.truncated ?? false}
            rateLimited={editStats?.rateLimited ?? false}
            loading={editStatsLoading}
            error={editStatsError}
            onRefresh={() => void refreshEditStats()}
          />
        ) : selectedPath === THEME_VIEW ? (
          <ThemeStudio
            sessionId={sessionId}
            initialTab={themeTab}
            pendingCount={status?.draftAhead ?? 0}
            publishing={publishing}
            canPublish={!publishing && (status?.draftAhead ?? 0) > 0 && dirty.size === 0}
            onPublish={() => void publish()}
            // Theme edits commit straight to draft; refresh status so the
            // Publish button + Review changes count reflect them.
            onCommitted={() => void refreshStatus()}
          />
        ) : selectedPath === CLIENT_CENTER_VIEW ? (
          <ClientCenterEditor sessionId={sessionId} onSaved={() => void refreshStatus()} />
        ) : selectedPath === MEDIA_VIEW ? (
          <MediaLibrary sessionId={sessionId} onChanged={() => void refreshStatus()} />
        ) : selectedPath === ONEOFF_VIEW ? (
          <OneOffPanel sessionId={sessionId} />
        ) : selectedPath === RESOURCES_VIEW ? (
          <ResourcesPanel
            sessionId={sessionId}
            onPublish={() => publish()}
            publishing={publishing}
            canPublish={canPublish}
            canPublishLive={publishAllowed}
            onOpenPost={(path) => {
              // A freshly drafted post is a new commit on draft: refresh the
              // tree + status so it appears, then open it in the editor.
              void refreshTree()
              void refreshStatus()
              void select(path)
            }}
          />
        ) : loadingFile || content === null ? (
          <div className="flex-1 flex items-center justify-center text-sm font-body text-text-muted">
            Loading {selectedPath}…
          </div>
        ) : isNav ? (
          <NavEditor
            key={`nav-${loaded.get(NAV_PATH)?.sha ?? 'new'}`}
            path={selectedPath}
            contents={content}
            onChange={onEdit}
            onMovesChange={setNavMoves}
          />
        ) : (
          <PageEditor key={selectedPath} sessionId={sessionId} path={selectedPath} contents={content} websiteUrl={websiteUrl} onChange={onEdit} isAdmin={isAdmin} templateVersion={templateVersion} sitePresets={sitePresets} />
        )}
      </div>
      {publishResult && (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-50 flex max-w-sm items-start gap-3 rounded-lg border border-border-default border-l-4 border-l-brand-cyan bg-surface-card px-4 py-3 shadow-elevated"
        >
          <span className="text-xs font-body text-text-primary">{publishResult}</span>
          <button
            type="button"
            onClick={() => setPublishResult(null)}
            aria-label="Dismiss"
            className="ml-auto text-sm leading-none text-text-muted hover:text-brand-navy"
          >
            ×
          </button>
        </div>
      )}
      {newPageOpen && (
        <NewPageDialog
          sessionId={sessionId}
          onClose={() => {
            setNewPageOpen(false)
            const notice = pendingRedirectNotice.current
            pendingRedirectNotice.current = null
            if (notice) setPublishResult(notice)
          }}
          onCreated={(path, redirectNotice) => {
            // A redirect that shadowed the new url was removed with the page:
            // told once the dialog closes (it covers the toast, and an AI
            // draft keeps it open), and the cached redirects.csv is refreshed
            // so its next save doesn't 409 on the old sha.
            if (redirectNotice) {
              pendingRedirectNotice.current = redirectNotice
              refreshRedirectsCache()
            }
            // Starter file exists on the draft branch — surface it in the tree
            // and open it so the admin can edit (or watch the AI draft land).
            void (async () => {
              await refreshTree()
              await refreshStatus()
              await select(path)
            })()
          }}
          onGenerationStart={(path) => setDraftingPaths((prev) => new Set(prev).add(path))}
          onGenerated={(path) => {
            setDraftingPaths((prev) => withoutPath(prev, path))
            // AI draft replaced the starter — drop the cached blob and reopen.
            void reloadFile(path)
            void refreshStatus()
          }}
          onGenerationFailed={(path, message) => {
            setDraftingPaths((prev) => withoutPath(prev, path))
            setPublishResult(message)
          }}
        />
      )}
      {conflictPrUrl && (
        <div
          role="alert"
          className="fixed bottom-6 right-6 z-50 flex max-w-sm items-start gap-3 rounded-lg border border-border-default border-l-4 border-l-warning bg-surface-card px-4 py-3 shadow-elevated"
        >
          <div className="text-xs font-body text-text-primary">
            <p className="font-heading font-semibold text-warning-strong">Publish needs a manual merge</p>
            <p className="mt-1">
              Draft and live have conflicting changes. Resolve and merge the{' '}
              <a
                href={conflictPrUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-brand-cyan underline hover:text-brand-navy"
              >
                pull request on GitHub
              </a>{' '}
              to deploy.
            </p>
            <p className="mt-1 text-text-muted">
              Once you merge it, return here — the draft updates from live
              automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setConflictPrUrl(null)}
            aria-label="Dismiss"
            className="ml-auto text-sm leading-none text-text-muted hover:text-brand-navy"
          >
            ×
          </button>
        </div>
      )}
      {/* Hidden on the Theme view: it has its own assistant (the Design Studio
          chat), and this fixed button would sit over that composer's Send button. */}
      {isAdmin && !assistantOpen && !designActive && selectedPath !== THEME_VIEW && (
        <div className="fixed bottom-6 right-6 z-40 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDesignOpen(true)}
            className="rounded-pill bg-brand-navy px-4 py-2 font-heading text-xs font-semibold text-text-inverse shadow-elevated transition-all hover:bg-brand-navy-dark"
            title="Quick design revisions — colors, fonts, spacing — with a live preview of this page"
          >
            🎨 Design
          </button>
          <button
            type="button"
            onClick={() => setAssistantOpen(true)}
            className="rounded-pill bg-brand-cyan px-4 py-2 font-heading text-xs font-semibold text-text-inverse shadow-elevated transition-all hover:bg-brand-cyan-dark"
            title="Make site-wide changes — add/remove pages, edit navigation"
          >
            ✨ Site Assistant
          </button>
        </div>
      )}
      {designActive && (
        <DesignDrawer
          sessionId={sessionId}
          route={designRoute}
          onCommitted={() => {
            setDesignVersion((v) => v + 1)
            void refreshStatus()
          }}
          onOpenStudio={() => {
            setDesignOpen(false)
            setThemeTab('studio')
            void select(THEME_VIEW)
          }}
          onClose={() => setDesignOpen(false)}
        />
      )}
      {isAdmin && assistantOpen && (
        <aside className="fixed inset-y-0 right-0 z-40 flex w-[400px] max-w-[92vw] flex-col border-l border-border-default bg-surface-card shadow-elevated">
          <div className="flex items-start justify-between border-b border-border-default bg-surface-subtle px-4 py-3">
            <div>
              <h2 className="font-heading text-sm font-semibold text-text-primary">Site Assistant</h2>
              <p className="mt-0.5 font-body text-xs text-text-muted">
                Pages &amp; navigation — site-wide changes
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAssistantOpen(false)}
              aria-label="Close Site Assistant"
              className="text-lg leading-none text-text-muted hover:text-brand-navy"
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <SiteAssistantChat
              sessionId={sessionId}
              onEdited={() => {
                void refreshTree()
                void refreshStatus()
              }}
            />
          </div>
        </aside>
      )}
    </div>
  )
}
