'use client'

import { useCallback, useEffect, useState } from 'react'
import { slugifyCategory } from '@/lib/content/category-slug'
import { runAutoAssign } from '@/components/editor/run-auto-assign'
import type { BlogCategory } from '@/lib/content/blog-categories'
import type {
  CategoriesAutoAssignResponse,
  CategoriesGetResponse,
  CategoryDeleteResponse,
} from '@/types/blog-categories'

const inputCls =
  'w-full rounded-lg border border-border-default bg-surface-default px-3 py-2 font-body text-sm text-text-primary focus:border-brand-cyan focus:outline-none'
const labelCls = 'block text-xs font-heading font-semibold text-text-secondary mb-1'
const cardCls = 'border border-border-default bg-surface-card rounded-xl p-4 space-y-3'
const primaryBtn =
  'bg-brand-cyan text-text-inverse font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:bg-brand-cyan-dark disabled:opacity-50 disabled:cursor-not-allowed'
const secondaryBtn =
  'border border-brand-navy text-brand-navy font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:bg-brand-navy hover:text-text-inverse focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50 disabled:cursor-not-allowed'
const iconBtn =
  'border border-border-default text-brand-navy font-heading text-xs w-7 h-7 rounded-pill hover:border-brand-cyan hover:text-brand-cyan focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-40 disabled:cursor-not-allowed'
const linkBtn =
  'font-heading font-semibold text-xs text-text-muted hover:text-brand-cyan focus:outline-none focus-visible:underline'

const STALE_MSG = 'Categories changed elsewhere — reload'

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new ApiError(res.status === 409 ? STALE_MSG : (data.error ?? 'Request failed'), res.status)
  }
  return data as T
}

type Message = { kind: 'ok' | 'err'; text: string; stale?: boolean }

export default function BlogCategoriesEditor({ sessionId }: { sessionId: string }) {
  const base = `/api/edit/${sessionId}/categories`
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [serverCats, setServerCats] = useState<BlogCategory[]>([])
  const [rows, setRows] = useState<BlogCategory[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [sha, setSha] = useState<string | null>(null)
  const [templateOk, setTemplateOk] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const [newName, setNewName] = useState('')
  const [newSlug, setNewSlug] = useState('')
  const [newSlugTouched, setNewSlugTouched] = useState(false)
  const [newDesc, setNewDesc] = useState('')

  const [deleting, setDeleting] = useState<BlogCategory | null>(null)
  const [deleteMode, setDeleteMode] = useState<'move' | 'remove'>('remove')
  const [moveTo, setMoveTo] = useState('')

  const [progress, setProgress] = useState<string | null>(null)

  const apply = useCallback((data: CategoriesGetResponse) => {
    setServerCats(data.categories)
    setRows(data.categories)
    setCounts(data.counts)
    setSha(data.sha)
    setTemplateOk(data.templateSupportsCategories)
    setLoadError(null)
  }, [])

  const load = useCallback(async () => {
    try {
      apply(await api<CategoriesGetResponse>(base))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load categories')
    } finally {
      setLoading(false)
    }
  }, [base, apply])

  useEffect(() => {
    let cancelled = false
    api<CategoriesGetResponse>(base)
      .then((data) => { if (!cancelled) apply(data) })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load categories')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [base, apply])

  const dirty = JSON.stringify(rows) !== JSON.stringify(serverCats)

  function fail(err: unknown, fallback: string) {
    const text = err instanceof Error ? err.message : fallback
    setMessage({ kind: 'err', text, stale: err instanceof ApiError && err.status === 409 })
  }

  async function mutate(fn: () => Promise<string | null>) {
    setBusy(true)
    setMessage(null)
    try {
      const ok = await fn()
      await load()
      if (ok) setMessage({ kind: 'ok', text: ok })
    } catch (err) {
      fail(err, 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  function updateRow(id: string, patch: Partial<BlogCategory>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function move(index: number, delta: -1 | 1) {
    setRows((rs) => {
      const j = index + delta
      if (j < 0 || j >= rs.length) return rs
      const next = [...rs]
      ;[next[index], next[j]] = [next[j], next[index]]
      return next
    })
  }

  const saveChanges = () =>
    mutate(async () => {
      if (!sha) throw new Error(STALE_MSG)
      await api(base, {
        method: 'PATCH',
        body: JSON.stringify({
          categories: rows.map((r) => ({
            id: r.id,
            name: r.name,
            slug: r.slug,
            ...(r.description ? { description: r.description } : {}),
          })),
          sha,
        }),
      })
      return 'Saved to the draft. Publish from the content editor to go live.'
    })

  const addCategory = () =>
    mutate(async () => {
      await api(base, {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(),
          slug: newSlug.trim() || undefined,
          description: newDesc.trim() || undefined,
        }),
      })
      setNewName('')
      setNewSlug('')
      setNewSlugTouched(false)
      setNewDesc('')
      return 'Category added.'
    })

  function openDelete(cat: BlogCategory) {
    const others = rows.filter((r) => r.id !== cat.id)
    setDeleting(cat)
    setDeleteMode('remove')
    setMoveTo(others[0]?.id ?? '')
  }

  async function confirmDelete() {
    if (!deleting) return
    const cat = deleting
    setDeleting(null)
    await mutate(async () => {
      const qs = deleteMode === 'move' && moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ''
      const res = await api<CategoryDeleteResponse>(`${base}/${encodeURIComponent(cat.id)}${qs}`, {
        method: 'DELETE',
      })
      return `Deleted "${cat.name}"; ${res.postsChanged} post${res.postsChanged === 1 ? '' : 's'} updated.`
    })
  }

  async function autoCategorize() {
    setBusy(true)
    setMessage(null)
    setProgress('Starting…')
    try {
      const totals = await runAutoAssign(
        (attempted) =>
          api<CategoriesAutoAssignResponse>(`${base}/auto-assign`, {
            method: 'POST',
            body: JSON.stringify({ attempted }),
          }),
        (p) =>
          setProgress(`Categorized ${p.categorized} so far; ${p.remaining} left to check…`),
      )
      setMessage({
        kind: 'ok',
        text: `Categorized ${totals.categorized}; ${totals.leftUncategorized} left uncategorized`,
      })
    } catch (err) {
      fail(err, 'Auto-categorize failed')
    } finally {
      setProgress(null)
      await load()
      setBusy(false)
    }
  }

  if (loading) {
    return <p className="text-sm font-body text-text-muted">Loading categories…</p>
  }
  if (loadError) {
    return (
      <div className={cardCls}>
        <p className="text-sm font-body text-error" role="alert">{loadError}</p>
        <button type="button" className={secondaryBtn} onClick={() => { setLoading(true); void load() }}>
          Retry
        </button>
      </div>
    )
  }

  const locked = busy || dirty
  const others = deleting ? rows.filter((r) => r.id !== deleting.id) : []
  const deleteCount = deleting ? (counts[deleting.id] ?? 0) : 0

  return (
    <div className="space-y-4">
      {!templateOk && (
        <div className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-xs font-body text-warning-strong">
          Live-site filters need the latest site template.
        </div>
      )}

      {message && (
        <div
          role={message.kind === 'err' ? 'alert' : 'status'}
          className={`text-xs font-body ${message.kind === 'err' ? 'text-error' : 'text-success'}`}
        >
          {message.text}
          {message.stale && (
            <button type="button" className={`${linkBtn} ml-2 underline`} onClick={() => { setMessage(null); void load() }}>
              Reload
            </button>
          )}
        </div>
      )}

      <div className={cardCls}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-heading font-semibold text-brand-navy">Categories</h2>
            <p className="text-xs font-body text-text-muted mt-0.5">
              Posts can belong to up to three categories. Order here is the order on the live site.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            {dirty && (
              <button type="button" className={secondaryBtn} disabled={busy} onClick={() => setRows(serverCats)}>
                Discard
              </button>
            )}
            <button type="button" className={primaryBtn} disabled={!dirty || busy} onClick={saveChanges}>
              {busy && dirty ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs font-body text-text-muted">No categories yet. Add one below.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((r, i) => (
              <li key={r.id} className="border border-border-default rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="flex flex-col gap-1">
                    <button type="button" aria-label={`Move ${r.name} up`} className={iconBtn} disabled={busy || i === 0} onClick={() => move(i, -1)}>↑</button>
                    <button type="button" aria-label={`Move ${r.name} down`} className={iconBtn} disabled={busy || i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
                  </div>
                  <div className="grid grid-cols-2 gap-3 flex-1">
                    <div>
                      <label className={labelCls} htmlFor={`name-${r.id}`}>Name</label>
                      <input id={`name-${r.id}`} className={inputCls} value={r.name} disabled={busy} onChange={(e) => updateRow(r.id, { name: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelCls} htmlFor={`slug-${r.id}`}>Slug</label>
                      <input id={`slug-${r.id}`} className={inputCls} value={r.slug} disabled={busy} onChange={(e) => updateRow(r.id, { slug: e.target.value })} />
                    </div>
                    <div className="col-span-2">
                      <label className={labelCls} htmlFor={`desc-${r.id}`}>Description (optional)</label>
                      <input id={`desc-${r.id}`} className={inputCls} value={r.description ?? ''} disabled={busy} onChange={(e) => updateRow(r.id, { description: e.target.value })} />
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0 w-20">
                    <span className="text-xs font-body text-text-muted">
                      {counts[r.id] ?? 0} post{(counts[r.id] ?? 0) === 1 ? '' : 's'}
                    </span>
                    <button type="button" className={linkBtn} disabled={locked} onClick={() => openDelete(r)}>
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {dirty && (
          <p className="text-xs font-body text-text-muted">
            Save or discard your edits before adding, deleting or auto-categorizing.
          </p>
        )}
      </div>

      <div className={cardCls}>
        <h2 className="text-sm font-heading font-semibold text-brand-navy">Add category</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="new-name">Name</label>
            <input
              id="new-name"
              className={inputCls}
              value={newName}
              disabled={locked}
              onChange={(e) => {
                setNewName(e.target.value)
                if (!newSlugTouched) setNewSlug(slugifyCategory(e.target.value))
              }}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="new-slug">Slug</label>
            <input
              id="new-slug"
              className={inputCls}
              value={newSlug}
              disabled={locked}
              onChange={(e) => {
                setNewSlug(e.target.value)
                setNewSlugTouched(true)
              }}
            />
          </div>
          <div className="col-span-2">
            <label className={labelCls} htmlFor="new-desc">Description (optional)</label>
            <input id="new-desc" className={inputCls} value={newDesc} disabled={locked} onChange={(e) => setNewDesc(e.target.value)} />
          </div>
        </div>
        <button type="button" className={primaryBtn} disabled={locked || !newName.trim()} onClick={addCategory}>
          Add category
        </button>
      </div>

      <div className={cardCls}>
        <h2 className="text-sm font-heading font-semibold text-brand-navy">Auto-categorize</h2>
        <p className="text-xs font-body text-text-muted">
          Assigns categories to posts that have none, using the list above. Posts that already have categories are left alone.
        </p>
        <div className="flex items-center gap-3">
          <button type="button" className={primaryBtn} disabled={locked || rows.length === 0} onClick={autoCategorize}>
            Auto-categorize uncategorized posts
          </button>
          {progress && <span className="text-xs font-body text-text-muted" role="status">{progress}</span>}
        </div>
      </div>

      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-navy/40 p-4" role="dialog" aria-modal="true" aria-label={`Delete ${deleting.name}`}>
          <div className="w-full max-w-md rounded-xl bg-surface-card border border-border-default p-5 space-y-4">
            <h3 className="text-base font-heading font-bold text-brand-navy">Delete &ldquo;{deleting.name}&rdquo;?</h3>
            <p className="text-sm font-body text-text-secondary">
              {deleteCount} post{deleteCount === 1 ? '' : 's'} use this.
            </p>
            {deleteCount > 0 && (
              <fieldset className="space-y-2 text-sm font-body text-text-primary">
                <label className="flex items-center gap-2">
                  <input type="radio" name="delete-mode" checked={deleteMode === 'move'} disabled={others.length === 0} onChange={() => setDeleteMode('move')} />
                  Move them to
                  <select
                    className="rounded-lg border border-border-default bg-surface-default px-2 py-1 text-sm focus:border-brand-cyan focus:outline-none"
                    value={moveTo}
                    disabled={deleteMode !== 'move'}
                    onChange={(e) => setMoveTo(e.target.value)}
                    aria-label="Category to move posts to"
                  >
                    {others.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="delete-mode" checked={deleteMode === 'remove'} onChange={() => setDeleteMode('remove')} />
                  Just remove it from them
                </label>
              </fieldset>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={secondaryBtn} onClick={() => setDeleting(null)}>Cancel</button>
              <button type="button" className={primaryBtn} onClick={confirmDelete}>Delete category</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
