'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { MAX_POST_CATEGORIES } from '@/lib/content/category-slug'
import type { Frontmatter } from '@/lib/editor/frontmatter'
import type { BlogCategory } from '@/lib/content/blog-categories'
import type { CategoriesGetResponse, CategoryCreateResponse } from '@/types/blog-categories'

const inputCls =
  'w-full rounded-lg border border-border-default bg-surface-default px-3 py-2 font-body text-sm text-text-primary focus:border-brand-cyan focus:outline-none'
const secondaryBtn =
  'border border-brand-navy text-brand-navy font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:bg-brand-navy hover:text-text-inverse focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50 disabled:cursor-not-allowed'
const primaryBtn =
  'bg-brand-cyan text-text-inverse font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:bg-brand-cyan-dark disabled:opacity-50 disabled:cursor-not-allowed'

export interface PickerState {
  /** Assigned ids that exist in the category list, in assigned order. */
  chips: BlogCategory[]
  /** Categories not yet assigned. */
  available: BlogCategory[]
  canAdd: boolean
}

/** Pure view-model: unknown assigned ids are dropped; add is capped at MAX_POST_CATEGORIES. */
export function pickerState(assigned: string[], known: BlogCategory[]): PickerState {
  const byId = new Map(known.map((c) => [c.id, c]))
  const chips: BlogCategory[] = []
  for (const id of assigned) {
    const c = byId.get(id)
    if (c && !chips.includes(c)) chips.push(c)
  }
  const used = new Set(chips.map((c) => c.id))
  const available = known.filter((c) => !used.has(c.id))
  return { chips, available, canAdd: chips.length < MAX_POST_CATEGORIES && available.length > 0 }
}

/** Ids to emit after inline-creating a category: keeps the known assigned ids. */
export function idsAfterCreate(chipIds: string[], newId: string): string[] {
  return chipIds.includes(newId) ? chipIds : [...chipIds, newId]
}

/** Immutable: sets (or removes, when empty) the post's `categories` array field. */
export function withPostCategories(fm: Frontmatter, ids: string[]): Frontmatter {
  const fields = { ...fm.fields }
  delete fields.categories
  const arrayFields = { ...fm.arrayFields }
  const blocks = fm.blocks ? { ...fm.blocks } : undefined
  if (blocks) delete blocks.categories
  let order = fm.order.filter((k) => k !== 'categories')
  if (ids.length > 0) {
    arrayFields.categories = [...ids]
    const tagsAt = order.indexOf('tags')
    if (fm.order.includes('categories')) {
      const prev = fm.order.indexOf('categories')
      order = [...order.slice(0, prev), 'categories', ...order.slice(prev)]
    } else if (tagsAt >= 0) {
      order = [...order.slice(0, tagsAt + 1), 'categories', ...order.slice(tagsAt + 1)]
    } else {
      order = [...order, 'categories']
    }
  } else {
    delete arrayFields.categories
  }
  return { ...fm, fields, arrayFields, order, ...(blocks ? { blocks } : {}) }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Request failed')
  return data as T
}

export default function PostCategoryPicker({
  sessionId,
  assigned,
  onChange,
}: {
  sessionId: string
  assigned: string[]
  onChange: (ids: string[]) => void
}) {
  const base = `/api/edit/${sessionId}/categories`
  const [known, setKnown] = useState<BlogCategory[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api<CategoriesGetResponse>(base)
      setKnown(data.categories)
      setLoadFailed(false)
      setError(null)
    } catch (e) {
      setLoadFailed(true)
      setError(e instanceof Error ? e.message : 'Could not load categories')
    } finally {
      setLoaded(true)
    }
  }, [base])

  useEffect(() => {
    void load()
  }, [load])

  const { chips, available, canAdd } = pickerState(assigned, known)
  const chipIds = chips.map((c) => c.id)

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    try {
      const { category } = await api<CategoryCreateResponse>(base, {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      setNewName('')
      setCreating(false)
      setError(null)
      setKnown((prev) => (prev.some((c) => c.id === category.id) ? prev : [...prev, category]))
      onChange(idsAfterCreate(chipIds, category.id))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create category')
    } finally {
      setBusy(false)
    }
  }

  const atMax = chips.length >= MAX_POST_CATEGORIES
  const locked = loadFailed

  return (
    <div className="space-y-2">
      <span className="block text-xs font-heading text-text-secondary">categories</span>
      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <li
              key={c.id}
              className="inline-flex items-center gap-1.5 rounded-pill border border-border-default bg-surface-default pl-3 pr-1 py-0.5 font-body text-xs text-text-primary"
            >
              {c.name}
              <button
                type="button"
                aria-label={`Remove ${c.name}`}
                disabled={locked}
                onClick={() => onChange(chipIds.filter((id) => id !== c.id))}
                className="w-5 h-5 rounded-pill text-text-muted hover:text-brand-cyan focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {loaded && !error && known.length === 0 && !creating && (
        <p className="text-xs font-body text-text-muted">
          No categories yet — manage them in{' '}
          <Link
            href={`/admin/content/${sessionId}/blog-categories`}
            className="font-heading font-semibold text-brand-cyan hover:underline"
          >
            Blog categories
          </Link>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {available.length > 0 && (
          <select
            aria-label="Add category"
            value=""
            disabled={!canAdd || locked}
            onChange={(e) => {
              if (e.target.value) onChange([...chipIds, e.target.value])
            }}
            className={`${inputCls} !w-auto`}
          >
            <option value="">{atMax ? `Max ${MAX_POST_CATEGORIES} categories` : 'Add category'}</option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {!creating && (
          <button
            type="button"
            className={secondaryBtn}
            disabled={atMax || !loaded || locked}
            onClick={() => setCreating(true)}
          >
            + New category
          </button>
        )}
      </div>
      {creating && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newName}
            autoFocus
            placeholder="Category name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void create()
              }
            }}
            className={`${inputCls} !w-auto`}
          />
          <button type="button" className={primaryBtn} disabled={busy || !newName.trim()} onClick={() => void create()}>
            {busy ? 'Adding…' : 'Add'}
          </button>
          <button
            type="button"
            className={secondaryBtn}
            disabled={busy}
            onClick={() => {
              setCreating(false)
              setNewName('')
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs font-body text-error">
          {error}
          {loadFailed && (
            <button
              type="button"
              onClick={() => void load()}
              className="ml-2 font-heading font-semibold underline hover:text-brand-cyan"
            >
              Retry
            </button>
          )}
        </p>
      )}
    </div>
  )
}
