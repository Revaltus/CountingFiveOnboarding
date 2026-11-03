'use client'
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useDialog } from '@/components/ui/use-dialog'
import { FOCUS, PRIMARY_BTN, SECONDARY_BTN } from '@/components/design-studio/styles'
import { diffHunks } from '@/lib/design/design-md-ui'
import {
  DEFAULT_BODY_BUDGET,
  FAQ_QUESTIONS,
  INDUSTRY_BODY_BUDGET,
  MAX_CONTENT_SPLITS,
  MIN_SCANNABLE_SECTIONS,
  isGenericCtaLabel,
  splitSections,
  type BodyBudget,
  type PageStructureMetrics,
  type StructureSection,
} from '@/lib/content/page-structure'
import type { ContentCoverage, RestructureProposeResponse, RestructureStatus } from '@/lib/content/restructure-page'

// "Restructure to new layout": asks the server for a proposal (nothing is
// written), shows current vs proposed side by side with the page-structure
// metrics, and commits the proposal to the draft branch only on Accept.
// One restructure per page: once accepted the button locks; admins can
// override with "Restructure again…".

type State =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'ready'; data: RestructureProposeResponse }
  | { kind: 'accepting'; data: RestructureProposeResponse }
  | { kind: 'error'; message: string; data?: RestructureProposeResponse }

async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string }
    return j.error ?? fallback
  } catch {
    return fallback
  }
}

const formatDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : 'an earlier date')

export default function RestructureButton({
  sessionId,
  path,
  isDirty,
  isAdmin,
  onAccepted,
}: {
  sessionId: string
  path: string
  isDirty: boolean
  isAdmin: boolean
  onAccepted: () => void
}) {
  const [open, setOpen] = useState<null | { override: boolean }>(null)
  const [status, setStatus] = useState<RestructureStatus | null>(null)

  // EditorShell keys this per page, so status starts fresh for each file. An
  // unknown status leaves the button usable; the server still enforces the lock.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/edit/${sessionId}/restructure?path=${encodeURIComponent(path)}`)
      .then((res) => (res.ok ? (res.json() as Promise<RestructureStatus>) : null))
      .then((s) => {
        if (!cancelled && s) setStatus(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [sessionId, path])

  const locked = status?.restructured === true

  return (
    <>
      {locked ? (
        <>
          <button
            type="button"
            disabled
            title={`Restructured on ${formatDay(status.at)}${status.by ? ` by ${status.by}` : ''}`}
            className={SECONDARY_BTN}
          >
            Restructured ✓
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setOpen({ override: true })}
              title="Admin override: run Restructure on this page again"
              className={`font-heading text-[11px] font-semibold text-text-secondary underline-offset-2 hover:text-brand-navy hover:underline ${FOCUS}`}
            >
              Restructure again…
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          onClick={() => setOpen({ override: false })}
          title="Propose a leaner, reader-first version of this page and compare it with the current one before accepting"
          className={SECONDARY_BTN}
        >
          Restructure
        </button>
      )}
      {open && (
        <RestructureCompare
          sessionId={sessionId}
          path={path}
          isDirty={isDirty}
          override={open.override}
          restructuredAt={status?.at ?? null}
          onClose={() => setOpen(null)}
          onAccepted={() => {
            setOpen(null)
            setStatus({ restructured: true, at: new Date().toISOString(), by: null })
            onAccepted()
          }}
        />
      )}
    </>
  )
}

function RestructureCompare({
  sessionId,
  path,
  isDirty,
  override,
  restructuredAt,
  onClose,
  onAccepted,
}: {
  sessionId: string
  path: string
  isDirty: boolean
  override: boolean
  restructuredAt: string | null
  onClose: () => void
  onAccepted: () => void
}) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [showDiff, setShowDiff] = useState(false)
  const dialogRef = useDialog(onClose)
  const busy = state.kind === 'working' || state.kind === 'accepting'

  async function propose() {
    setState({ kind: 'working' })
    setShowDiff(false)
    try {
      const res = await fetch(`/api/edit/${sessionId}/restructure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, override }),
      })
      if (!res.ok) {
        setState({ kind: 'error', message: await errorText(res, "Couldn't build a proposal.") })
        return
      }
      setState({ kind: 'ready', data: (await res.json()) as RestructureProposeResponse })
    } catch {
      setState({ kind: 'error', message: "Couldn't reach the server. Try again." })
    }
  }

  async function accept(data: RestructureProposeResponse) {
    setState({ kind: 'accepting', data })
    try {
      const res = await fetch(`/api/edit/${sessionId}/restructure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'accept', path, proposed: data.proposed, expectedSha: data.currentSha, override }),
      })
      if (!res.ok) {
        setState({ kind: 'error', message: await errorText(res, "Couldn't save the new version."), data })
        return
      }
      onAccepted()
    } catch {
      setState({ kind: 'error', message: "Couldn't reach the server. Try again.", data })
    }
  }

  const data = state.kind === 'ready' || state.kind === 'accepting' || state.kind === 'error' ? state.data : undefined

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button aria-label="Close" onClick={busy ? undefined : onClose} className="absolute inset-0 cursor-default bg-brand-navy/40" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="restructure-title"
        tabIndex={-1}
        className="relative flex h-full max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-lg bg-surface-page shadow-elevated"
      >
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-border-default bg-surface-card px-5 py-3">
          <div className="min-w-0">
            <h2 id="restructure-title" className="font-heading text-sm font-semibold text-brand-navy">
              {override ? 'Restructure again' : 'Restructure to new layout'}
            </h2>
            <p className="truncate font-body text-xs text-text-muted">{path}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className={`text-lg leading-none text-text-muted transition-colors hover:text-brand-navy disabled:opacity-50 ${FOCUS}`}
          >
            &times;
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {state.kind === 'idle' && (
            <Intro
              isDirty={isDirty}
              override={override}
              restructuredAt={restructuredAt}
              onStart={() => void propose()}
            />
          )}
          {state.kind === 'working' && (
            <p role="status" className="py-16 text-center font-body text-sm text-text-secondary">
              Writing a leaner version of this page. This usually takes one to two minutes…
            </p>
          )}
          {state.kind === 'error' && (
            <p role="alert" className="mb-4 rounded-lg border border-error/30 bg-error/5 px-3 py-2 font-body text-xs text-error">
              {state.message}
            </p>
          )}
          {data && (
            <>
              {data.handEdited && (
                <p className="mb-4 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 font-body text-xs text-warning-strong">
                  This page has hand edits. Check that the proposal keeps anything you changed on purpose.
                </p>
              )}
              <MetricsStrip before={data.metrics.before} after={data.metrics.after} budget={data.budget} />
              <CoveragePanel coverage={data.coverage} />
              {showDiff ? (
                <DiffPanel data={data} />
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  <PageColumn label="Current" markdown={data.current} />
                  <PageColumn label="Proposed" markdown={data.proposed} highlight />
                </div>
              )}
            </>
          )}
        </div>

        {data && (
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-border-default bg-surface-card px-5 py-3">
            <button type="button" onClick={() => setShowDiff((v) => !v)} className={SECONDARY_BTN} disabled={busy}>
              {showDiff ? 'Show side by side' : 'Show text diff'}
            </button>
            <button type="button" onClick={() => void propose()} className={SECONDARY_BTN} disabled={busy}>
              Regenerate
            </button>
            <span className="flex-1" />
            <button type="button" onClick={onClose} className={SECONDARY_BTN} disabled={busy}>
              Keep current
            </button>
            <button type="button" onClick={() => void accept(data)} className={PRIMARY_BTN} disabled={busy}>
              {state.kind === 'accepting' ? 'Saving…' : 'Accept proposed'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function Intro({
  isDirty,
  override,
  restructuredAt,
  onStart,
}: {
  isDirty: boolean
  override: boolean
  restructuredAt: string | null
  onStart: () => void
}) {
  return (
    <div className="mx-auto max-w-xl space-y-3 py-8 font-body text-sm text-text-secondary">
      {override && (
        <p className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning-strong">
          This page was already restructured on {formatDay(restructuredAt)}. Running it again replaces the approved
          layout if you accept the new proposal.
        </p>
      )}
      <p>
        The AI rewrites this page into the reader-first layout for its page type (service or industry), with a
        page-specific call to action and an FAQ that carries the detail.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-xs">
        <li>
          Body copy of {DEFAULT_BODY_BUDGET.min}–{DEFAULT_BODY_BUDGET.max} words on service pages and{' '}
          {INDUSTRY_BODY_BUDGET.min}–{INDUSTRY_BODY_BUDGET.max} on industry pages, with bullets wherever a list
          reads faster.
        </li>
        <li>At most {MAX_CONTENT_SPLITS} image-beside-text sections, never back to back.</li>
        <li>
          {FAQ_QUESTIONS.min}–{FAQ_QUESTIONS.max} FAQ questions. Anything search engines and AI value that doesn&apos;t
          belong in the body moves there, so nothing is lost.
        </li>
        <li>Only facts already on the page or in the firm profile. Existing images and links are kept.</li>
      </ul>
      <p className="text-xs">
        Nothing is saved until you accept. Accepted changes go to the draft, where Review changes can still undo them
        before you publish. A page can be restructured once.
      </p>
      {isDirty ? (
        <p className="text-xs text-warning-strong">Save or discard your unsaved edits to this page first.</p>
      ) : (
        <button type="button" onClick={onStart} className={PRIMARY_BTN}>
          {override ? 'Run it again' : 'Propose a new layout'}
        </button>
      )}
    </div>
  )
}

type MetricRow = {
  label: string
  value: (m: PageStructureMetrics) => string
  ok: (m: PageStructureMetrics, budget: BodyBudget) => boolean
}

const METRICS: MetricRow[] = [
  { label: 'Body words', value: (m) => String(m.bodyWords), ok: (m, b) => m.bodyWords <= b.cap },
  {
    label: 'Image + text sections',
    value: (m) => String(m.splitCount),
    ok: (m) => m.splitCount <= MAX_CONTENT_SPLITS && m.consecutiveImageBlocks === 0,
  },
  { label: 'Bullets', value: (m) => String(m.bulletCount), ok: (m) => m.scannableSections >= MIN_SCANNABLE_SECTIONS },
  {
    label: 'FAQ questions',
    value: (m) => String(m.faqCount),
    ok: (m) => m.faqCount >= FAQ_QUESTIONS.min && m.faqCount <= FAQ_QUESTIONS.max,
  },
  {
    label: 'CTA button',
    value: (m) => m.ctaLabel ?? 'none',
    ok: (m) => !!m.ctaLabel && !isGenericCtaLabel(m.ctaLabel),
  },
]

function MetricsStrip({
  before,
  after,
  budget,
}: {
  before: PageStructureMetrics
  after: PageStructureMetrics
  budget: BodyBudget
}) {
  return (
    <dl className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {METRICS.map((row) => (
        <div key={row.label} className="rounded-lg border border-border-default bg-surface-card px-3 py-2">
          <dt className="font-heading text-[11px] text-text-muted">{row.label}</dt>
          <dd className="mt-0.5 flex flex-wrap items-baseline gap-1 font-body text-xs">
            <span className={row.ok(before, budget) ? 'text-text-secondary' : 'text-error'}>{row.value(before)}</span>
            <span aria-hidden="true" className="text-text-muted">→</span>
            <span className="sr-only">to</span>
            <span className={`font-semibold ${row.ok(after, budget) ? 'text-success' : 'text-error'}`}>
              {row.value(after)}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  )
}

// Where the current page's key terms went: nothing useful to search/LLMs should
// vanish. Terms moved out of the body should be in the FAQ.
function CoveragePanel({ coverage }: { coverage: ContentCoverage }) {
  const moved = coverage.terms.filter((t) => t.where === 'faq')
  const missing = coverage.terms.filter((t) => t.where === 'missing')
  const kept = coverage.terms.length - moved.length - missing.length
  if (!coverage.terms.length) return null
  return (
    <section
      aria-label="Where the content went"
      className="mb-4 rounded-lg border border-border-default bg-surface-card px-3 py-2 font-body text-xs"
    >
      <p className="text-text-secondary">
        <span className="font-heading font-semibold text-text-primary">Where the content went: </span>
        {kept} key term{kept === 1 ? '' : 's'} kept in the body, {moved.length} moved to the FAQ
        {missing.length ? `, ${missing.length} missing` : ', none lost'}.
      </p>
      {moved.length > 0 && (
        <p className="mt-1 text-text-muted">Moved to FAQ: {moved.map((t) => t.term).join(', ')}</p>
      )}
      {missing.length > 0 && (
        <p className="mt-1 text-warning-strong">
          Missing — check before accepting: {missing.map((t) => t.term).join(', ')}
        </p>
      )}
    </section>
  )
}

// Readable section view: a block chip, the heading, and the copy. Annotation
// item lines (icon:/photo:/query:) are layout data, not copy.
function sectionMarkdown(text: string): string {
  return text.replace(/^(icon|photo|query):.*$/gim, '').trim()
}

function PageColumn({ label, markdown, highlight = false }: { label: string; markdown: string; highlight?: boolean }) {
  const sections = useMemo(() => splitSections(markdown), [markdown])
  return (
    <section
      aria-label={`${label} page`}
      className={`rounded-lg border bg-surface-card ${highlight ? 'border-brand-cyan' : 'border-border-default'}`}
    >
      <h3 className="border-b border-border-default px-4 py-2 font-heading text-xs font-semibold text-brand-navy">
        {label} · {sections.length} sections
      </h3>
      <div className="divide-y divide-border-default">
        {sections.map((s, i) => (
          <SectionCard key={i} section={s} />
        ))}
      </div>
    </section>
  )
}

function SectionCard({ section }: { section: StructureSection }) {
  const isFaq = section.blockId === 'faq-accordion'
  const hasImage = section.blockId === 'content-split' || section.variant?.startsWith('with-image')
  const faqQuestions = isFaq ? [...section.text.matchAll(/^\*\*Q:\s*(.+?)\*\*/gm)].map((m) => m[1]) : []
  return (
    <div className="px-4 py-3">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="rounded-pill bg-brand-navy/10 px-2 py-0.5 font-mono text-[10px] text-brand-navy">
          {section.blockId}
          {section.variant ? ` · ${section.variant}` : ''}
        </span>
        {hasImage && (
          <span className="rounded-pill bg-brand-cyan/10 px-2 py-0.5 font-body text-[10px] text-brand-cyan-dark">image</span>
        )}
      </div>
      {section.heading && <h4 className="font-heading text-sm font-semibold text-text-primary">{section.heading}</h4>}
      {isFaq ? (
        <ul className="mt-1 space-y-0.5">
          {faqQuestions.map((q, i) => (
            <li key={i} className="font-body text-xs text-text-secondary">
              ▸ {q}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-1 font-body text-xs leading-relaxed text-text-secondary [&_a]:text-brand-cyan-dark [&_a]:underline [&_h3]:mt-2 [&_h3]:font-heading [&_h3]:font-semibold [&_h3]:text-text-primary [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_strong]:text-text-primary [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{sectionMarkdown(section.text)}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}

function DiffPanel({ data }: { data: RestructureProposeResponse }) {
  const hunks = useMemo(() => diffHunks(data.diff, 2, 1200), [data.diff])
  return (
    <pre
      aria-label="Text changes"
      tabIndex={0}
      className={`overflow-auto rounded-lg border border-border-default bg-surface-subtle p-3 font-mono text-[11px] leading-snug ${FOCUS}`}
    >
      {hunks.rows.map((r, i) =>
        r.op === 'gap' ? (
          <div key={i} className="text-text-muted">{`  … ${r.skipped} unchanged line${r.skipped === 1 ? '' : 's'}`}</div>
        ) : (
          <div
            key={i}
            className={`whitespace-pre-wrap ${r.op === 'add' ? 'bg-success/10 text-success' : r.op === 'del' ? 'bg-error/10 text-error' : 'text-text-secondary'}`}
          >
            <span aria-hidden="true">{r.op === 'add' ? '+ ' : r.op === 'del' ? '- ' : '  '}</span>
            <span className="sr-only">{r.op === 'add' ? 'Added: ' : r.op === 'del' ? 'Removed: ' : ''}</span>
            {r.text || ' '}
          </div>
        ),
      )}
      {hunks.truncated && <div className="text-text-muted">… more changes not shown</div>}
    </pre>
  )
}
