import type { Finding, QaReview } from '@/types/qa-review'
import { mergeFindings, overlapsProtected, type PageFields } from './merge'
import { agentScores, qaPasses } from './judge'

const PROTECTED_ERROR =
  'This fix would change word-for-word text (a verbatim page or a team bio). Edit it by hand if the change is intended.'

const hasFix = (f: Finding) => !!f.patch || !!f.variantFix

function withFindings(review: QaReview, findings: Finding[]): QaReview {
  return {
    ...review,
    findings,
    scores: agentScores(findings),
    passed: qaPasses(review.judge, findings),
    // Optimistic-lock counter for the server-side CAS (qa_apply_page_update),
    // bumped on every apply/dismiss.
    rev: (review.rev ?? 0) + 1,
  }
}

// Apply or dismiss ONE QA finding on a human's request. Pure — the route
// loads/saves the page; this just computes the next fields + review.
// protectedTexts (verbatim page body / team bios) are never patched, even on a
// human click: Apply is a one-click machine edit, not a hand edit.
export function applyOneFinding(
  fields: PageFields,
  review: QaReview,
  findingId: string,
  action: 'apply' | 'dismiss',
  protectedTexts: string[],
  templateVersion?: string | null,
): { ok: true; fields: PageFields; review: QaReview } | { ok: false; error: string } {
  const finding = review.findings.find(f => f.id === findingId)
  if (!finding || finding.status !== 'open') return { ok: false, error: 'That finding is no longer open.' }

  let nextFields = fields
  let status: 'dismissed' | 'accepted' = 'dismissed'
  if (action === 'apply') {
    if (!hasFix(finding)) return { ok: false, error: 'This finding has no automatic fix — edit the page by hand.' }
    if (finding.patch?.target === 'body' && overlapsProtected(fields.body, finding.patch.find, protectedTexts)) {
      return { ok: false, error: PROTECTED_ERROR }
    }
    // Forced to `safety: 'auto'` so mergeFindings actually attempts it.
    const r = mergeFindings(fields, [{ ...finding, safety: 'auto' }], { apply: true, protectedTexts, templateVersion })
    if (r.findings[0].status !== 'applied') return { ok: false, error: 'The text this fix targets has changed — edit it by hand.' }
    nextFields = r.fields
    status = 'accepted'
  }
  return { ok: true, fields: nextFields, review: withFindings(review, review.findings.map(f => (f.id === findingId ? { ...f, status } : f))) }
}

// Bulk sibling for the one-time backfill of shadow-mode reports: applies every
// OPEN `auto` finding that carries a fix — exactly what `on` mode would have
// applied at generation time. Flags stay open for a human. A fix that can't
// land (protected text, text moved, would break an annotation) degrades to an
// open flag, same as in `on` mode. Landed fixes are `accepted` (a human
// approved this batch), so dashboard dismiss rates stay honest.
export function applyOpenAutoFindings(
  fields: PageFields,
  review: QaReview,
  protectedTexts: string[],
  templateVersion?: string | null,
): { fields: PageFields; review: QaReview; applied: Finding[]; failed: Finding[] } {
  const targets = review.findings.filter(f => f.status === 'open' && f.safety === 'auto' && hasFix(f))
  if (!targets.length) return { fields, review, applied: [], failed: [] }
  const merged = mergeFindings(fields, targets, { apply: true, protectedTexts, templateVersion })
  const byId = new Map(merged.findings.map(f => [f.id, f]))
  const applied: Finding[] = []
  const failed: Finding[] = []
  const findings = review.findings.map(f => {
    const m = byId.get(f.id)
    if (!m) return f
    if (m.status === 'applied') {
      const accepted: Finding = { ...f, status: 'accepted' }
      applied.push(accepted)
      return accepted
    }
    failed.push(m)
    return m
  })
  return { fields: merged.fields, review: withFindings(review, findings), applied, failed }
}
