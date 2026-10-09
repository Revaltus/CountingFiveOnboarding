'use client'

import { useState } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import OutlineSectionRow from './OutlineSectionRow'
import { isApprovableOutline, isFallbackOutline } from '@/lib/content/outline-fallback'
import type { Json } from '@/types/database'

type Section = { h2: string; description: string; word_count: number }

// Client-only row ids for outline sections (never persisted). A module counter
// keeps them unique across cards without touching refs during render.
let sectionIdSeq = 0
const makeIds = (n: number) => Array.from({ length: n }, () => `sec-${++sectionIdSeq}`)

type Cta = { text: string; url: string }

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
  // Set at sitemap confirm from the session's operator directives (migration 082).
  generation_mode?: string
  merge_source_urls?: string[]
}

export default function OutlineCard({
  outline,
  contentJobId,
  onUpdate,
  expanded,
  onToggleExpand,
  onApproved,
  hasNextPending = false,
}: {
  outline: Outline
  contentJobId: string
  // `localEdit` = an unsaved operator edit (parent protects it from the poll);
  // omitted/false = the server's saved copy.
  onUpdate: (updated: Outline, localEdit?: boolean) => void
  expanded: boolean
  onToggleExpand: () => void
  // Called after a successful approve. `advance` = the operator asked to jump to
  // the next pending outline; otherwise the parent just collapses this card.
  onApproved: (id: string, advance: boolean) => void
  hasNextPending?: boolean
}) {
  const [saving, setSaving] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Defensive: outline.sections is jsonb and has been seen as a string ("[]")
  // due to upstream model output occasionally returning sections as a string.
  // Treat anything that isn't an array as empty here so the page can render
  // without crashing; the corrupted shape gets repaired on the next Save Edits.
  const sections: Section[] = Array.isArray(outline.sections)
    ? (outline.sections as Section[])
    : []
  const totalWords = sections.reduce((sum, s) => sum + (s.word_count || 0), 0)

  // Stable client-side ids for section rows (sections carry no id of their
  // own). Index keys made React/dnd-kit reuse the wrong row's DOM + focus after
  // a reorder or delete. Kept in lockstep with `sections` by the edit helpers;
  // if the array is replaced externally (save/regenerate/poll) with a different
  // length, the ids are regenerated.
  const [sectionIds, setSectionIds] = useState<string[]>(() => makeIds(sections.length))
  if (sectionIds.length !== sections.length) {
    setSectionIds(makeIds(sections.length))
  }
  const editLocal = (next: Outline) => onUpdate(next, true)

  // PointerSensor with a small activation distance lets the input fields inside
  // a section card still accept clicks without accidentally triggering a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = sectionIds.indexOf(String(active.id))
    const newIndex = sectionIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const newSections = arrayMove(sections, oldIndex, newIndex)
    setSectionIds(ids => arrayMove(ids, oldIndex, newIndex))
    editLocal({ ...outline, sections: newSections as unknown as Json })
  }

  const needsReview = !outline.admin_approved && isFallbackOutline(outline.admin_notes)
  const canApprove = !outline.admin_approved && isApprovableOutline(outline)

  const statusBadge = outline.admin_approved
    ? { label: 'Approved', cls: 'bg-success/10 text-success' }
    : needsReview
      ? { label: 'Needs review', cls: 'bg-warning/10 text-warning-strong' }
      : outline.h1
        ? { label: 'Pending', cls: 'bg-warning/10 text-warning-strong' }
        : { label: 'Generating...', cls: 'bg-info/10 text-info' }

  const saveEdits = async () => {
    setSaving(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/content-jobs/${contentJobId}/outlines/${outline.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          h1: outline.h1,
          sections: outline.sections,
          admin_notes: outline.admin_notes,
          angle: outline.angle,
          cta: outline.cta,
        }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `Save failed (${res.status})`)
      }
      const data = await res.json()
      onUpdate(data.outline)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const cta = (outline.cta as Cta | null) ?? null
  const updateCta = (next: Cta | null) => {
    editLocal({ ...outline, cta: next as unknown as Json })
  }

  const approve = async (advance = false) => {
    setSaving(true)
    setActionError(null)
    try {
      // Save-then-approve in one PATCH: include the current (possibly edited but
      // not-yet-saved) fields so the quick ✓ can never silently discard an in-flight
      // edit. Unchanged fields are a no-op server-side; an actual edit is persisted.
      // `sections` is omitted when it isn't a clean array (rare corrupted data) so
      // approval still succeeds — the server rejects a non-array sections with 400.
      const payload: Record<string, unknown> = {
        admin_approved: true,
        h1: outline.h1,
        admin_notes: outline.admin_notes,
        angle: outline.angle,
        cta: outline.cta,
      }
      if (Array.isArray(outline.sections)) payload.sections = outline.sections
      const res = await fetch(`/api/content-jobs/${contentJobId}/outlines/${outline.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `Approve failed (${res.status})`)
      }
      const data = await res.json()
      onUpdate(data.outline)
      // Parent owns expansion: collapse this card, or advance to the next
      // pending outline so the operator can review the list without hunting.
      onApproved(outline.id, advance)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Approve failed')
    } finally {
      setSaving(false)
    }
  }

  const regenerate = async () => {
    setRegenerating(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/content-jobs/${contentJobId}/outlines/${outline.id}/regenerate`, {
        method: 'POST',
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `Regenerate failed (${res.status})`)
      }
      const data = await res.json()
      onUpdate(data.outline)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Regenerate failed')
    } finally {
      setRegenerating(false)
    }
  }

  const updateSection = (index: number, updated: Section) => {
    const newSections = [...sections]
    newSections[index] = updated
    editLocal({ ...outline, sections: newSections as unknown as Json })
  }

  const removeSection = (index: number) => {
    setSectionIds(ids => ids.filter((_, i) => i !== index))
    editLocal({ ...outline, sections: sections.filter((_, i) => i !== index) as unknown as Json })
  }

  const addSection = () => {
    setSectionIds(ids => [...ids, ...makeIds(1)])
    editLocal({
      ...outline,
      sections: [...sections, { h2: '', description: '', word_count: 150 }] as unknown as Json,
    })
  }

  return (
    <div className={`border rounded-lg overflow-hidden ${outline.admin_approved ? 'border-success/30' : 'border-border-default'}`}>
      <div className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-subtle transition-colors">
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex items-center gap-3 min-w-0 flex-1 text-left"
        >
          <svg
            aria-hidden="true"
            className={`w-4 h-4 text-text-muted transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <div className="text-left min-w-0">
            <div className="text-sm font-heading font-semibold text-text-primary truncate">{outline.page_title}</div>
            <div className="text-xs font-mono text-text-muted">{outline.page_url}</div>
            {(outline.generation_mode === 'verbatim' || (outline.merge_source_urls?.length ?? 0) > 0) && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {outline.generation_mode === 'verbatim' && (
                  <span
                    title="Operator instruction: this page reproduces the client’s current page word-for-word. Only SEO fields are AI-written."
                    className="inline-flex items-center rounded-pill border border-brand-navy/30 bg-brand-navy/10 text-brand-navy px-2 py-0.5 text-[11px] font-heading font-semibold"
                  >
                    Verbatim
                  </span>
                )}
                {outline.merge_source_urls?.map((u) => (
                  <span
                    key={u}
                    title="Operator instruction: this page absorbs that page’s content."
                    className="inline-flex items-center rounded-pill border border-info/40 bg-info/10 text-info px-2 py-0.5 text-[11px] font-heading font-semibold"
                  >
                    Merged from {u}
                  </span>
                ))}
              </div>
            )}
          </div>
        </button>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          {/* Inline approve so a ready outline can be signed off without expanding. */}
          {canApprove && (
            <button
              type="button"
              onClick={() => approve(false)}
              disabled={saving}
              className="inline-flex items-center gap-1 bg-success text-white font-heading font-semibold text-xs px-3 py-1 rounded-pill transition-all hover:bg-brand-cyan-dark disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg aria-hidden="true" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              {saving ? 'Saving…' : 'Approve'}
            </button>
          )}
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-heading font-semibold ${statusBadge.cls}`}>
            {statusBadge.label}
          </span>
        </div>
      </div>

      {expanded && outline.h1 && (
        <div className="px-4 pb-4 pt-2 border-t border-border-default space-y-3">
          {needsReview && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs font-body text-warning-strong">
              {outline.admin_notes?.trim()
                ? outline.admin_notes
                : 'This outline is an auto-generated placeholder because generation failed. Edit the sections, then clear this note before approving.'}
            </div>
          )}
          {/* H1 */}
          <div>
            <label className="text-xs font-heading font-semibold text-text-secondary">H1</label>
            <input
              type="text"
              value={outline.h1 ?? ''}
              onChange={e => editLocal({ ...outline, h1: e.target.value })}
              className="w-full mt-1 px-3 py-2 text-sm font-body bg-surface-subtle border border-border-default rounded focus:border-brand-cyan focus:outline-none"
            />
          </div>

          {/* Sections */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-heading font-semibold text-text-secondary">Sections</label>
              <span className="text-xs font-mono text-text-muted">{totalWords} words total</span>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext
                items={sectionIds}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-2">
                  {sections.map((section, i) => (
                    <OutlineSectionRow
                      key={sectionIds[i] ?? i}
                      id={sectionIds[i] ?? String(i)}
                      index={i}
                      section={section}
                      onChange={updated => updateSection(i, updated)}
                      onRemove={() => removeSection(i)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            <button
              type="button"
              onClick={addSection}
              className="mt-2 text-sm font-body text-brand-cyan hover:text-brand-navy transition-colors px-2 py-1"
            >
              + Add Section
            </button>
          </div>

          {/* Keyword */}
          <div className="text-xs font-body text-text-muted">
            Target keyword: <span className="font-mono">{outline.target_keyword ?? '—'}</span>
          </div>

          {/* CTA */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-heading font-semibold text-text-secondary">Call to Action</label>
              {cta && (
                <button
                  type="button"
                  onClick={() => updateCta(null)}
                  className="text-xs font-body text-text-muted hover:text-error transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={cta?.text ?? ''}
                onChange={e => updateCta({ text: e.target.value, url: cta?.url ?? '/contact' })}
                placeholder="Schedule a consultation"
                className="flex-1 px-3 py-2 text-sm font-body bg-surface-subtle border border-border-default rounded focus:border-brand-cyan focus:outline-none"
              />
              <input
                type="text"
                value={cta?.url ?? ''}
                onChange={e => updateCta({ text: cta?.text ?? '', url: e.target.value })}
                placeholder="/contact"
                className="w-40 px-3 py-2 text-sm font-mono bg-surface-subtle border border-border-default rounded focus:border-brand-cyan focus:outline-none"
              />
            </div>
            <p className="mt-1 text-xs font-body text-text-muted">
              Closes every page. Leave empty for the default (&quot;Schedule a consultation&quot; → /contact).
            </p>
          </div>

          {/* Angle / POV */}
          <div>
            <label className="text-xs font-heading font-semibold text-text-secondary">Angle / point of view</label>
            <textarea
              value={outline.angle ?? ''}
              onChange={e => editLocal({ ...outline, angle: e.target.value })}
              rows={2}
              className="w-full mt-1 px-3 py-2 text-sm font-body bg-surface-subtle border border-border-default rounded focus:border-brand-cyan focus:outline-none resize-none"
              placeholder="Optional. The unique take or information-gain for this page — what it argues or emphasizes that competitors don't."
            />
            <p className="mt-1 text-xs font-body text-text-muted">
              Steers generation. Save Edits, then Regenerate to apply. An angle-only change won&apos;t reset approved content.
            </p>
          </div>

          {/* Notes */}
          <div>
            <label className="text-xs font-heading font-semibold text-text-secondary">Notes</label>
            <textarea
              value={outline.admin_notes ?? ''}
              onChange={e => editLocal({ ...outline, admin_notes: e.target.value })}
              rows={2}
              className="w-full mt-1 px-3 py-2 text-sm font-body bg-surface-subtle border border-border-default rounded focus:border-brand-cyan focus:outline-none resize-none"
              placeholder="Notes for the copywriter..."
            />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            {canApprove && (
              <button
                onClick={() => approve(false)}
                disabled={saving}
                className="bg-success text-white font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:bg-brand-cyan-dark disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving...' : 'Approve'}
              </button>
            )}
            {canApprove && hasNextPending && (
              <button
                onClick={() => approve(true)}
                disabled={saving}
                className="bg-brand-navy text-white font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:bg-brand-cyan-dark disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving...' : 'Approve & next →'}
              </button>
            )}
            <button
              onClick={saveEdits}
              disabled={saving}
              className="border border-border-default text-text-secondary font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:border-brand-cyan hover:text-brand-navy disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Save Edits
            </button>
            <button
              onClick={regenerate}
              disabled={regenerating}
              className="border border-border-default text-text-secondary font-heading font-semibold text-xs px-3.5 py-1.5 rounded-pill transition-all hover:border-brand-cyan hover:text-brand-navy disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {regenerating ? 'Regenerating...' : 'Regenerate'}
            </button>
          </div>
        </div>
      )}
      {actionError && (
        <div role="alert" className="mx-4 mb-3 bg-error/10 border border-error/20 text-error text-xs font-body rounded-lg px-3 py-2">
          {actionError}
        </div>
      )}
    </div>
  )
}
