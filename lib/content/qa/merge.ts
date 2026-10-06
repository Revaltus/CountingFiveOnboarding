// Folds QA findings into the page. Only `auto` findings change anything; every
// failure degrades to a human flag instead of a wrong edit. Pure.
import { applyFindReplace, checkEditAnnotations } from '@/lib/editor/apply-edit'
import { setSectionVariant } from '@/lib/editor/section-layout'
import type { Finding } from '@/types/qa-review'

export type PageFields = { body: string; metaTitle: string | null; metaDescription: string | null }

const toFlag = (f: Finding, why: string): Finding => ({ ...f, safety: 'flag', status: 'open', message: `${f.message} ${why}`.trim() })

// Every (start, end) span where `needle` occurs in `haystack` (overlapping
// matches are not possible for a literal substring scan, so a simple advance
// by 1 is enough to find each occurrence).
function spansOf(haystack: string, needle: string): Array<[number, number]> {
  if (!needle) return []
  const spans: Array<[number, number]> = []
  let i = haystack.indexOf(needle)
  while (i >= 0) {
    spans.push([i, i + needle.length])
    i = haystack.indexOf(needle, i + 1)
  }
  return spans
}

const intersects = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1]

// True span-overlap check: a `find` that merely shares characters with a
// protected string at a boundary (contains neither it nor is contained by
// it) must still be refused — the naive containment check misses that case.
export function overlapsProtected(body: string, find: string, protectedTexts: string[]): boolean {
  const findSpans = spansOf(body, find)
  if (!findSpans.length) return false
  return protectedTexts.some((p) => {
    if (!p) return false
    const protectedSpans = spansOf(body, p)
    return findSpans.some((fs) => protectedSpans.some((ps) => intersects(fs, ps)))
  })
}

function patchField(current: string | null, find: string, replace: string): string | null {
  const cur = current ?? ''
  if (find === cur) return replace
  const first = cur.indexOf(find)
  if (!find || first < 0 || cur.indexOf(find, first + 1) >= 0) return null
  return cur.slice(0, first) + replace + cur.slice(first + find.length)
}

export function mergeFindings(
  fields: PageFields,
  findings: Finding[],
  opts: { apply: boolean; protectedTexts: string[]; templateVersion?: string | null },
): { fields: PageFields; findings: Finding[] } {
  if (!opts.apply) return { fields, findings: findings.map(f => ({ ...f, status: f.status === 'applied' ? 'open' : f.status })) }

  let { body, metaTitle, metaDescription } = fields
  const out = new Map<string, Finding>(findings.map(f => [f.id, f]))

  // 1. Variant fixes (rules) — index-based, so run before text patches move anything.
  for (const f of findings) {
    if (f.safety !== 'auto' || !f.variantFix) continue
    const r = setSectionVariant(body, f.variantFix.sectionIndex, f.variantFix.variant, { templateVersion: opts.templateVersion })
    if (r.ok) { body = r.body; out.set(f.id, { ...f, status: 'applied' }) }
    else out.set(f.id, toFlag(f, `(${r.reason})`))
  }

  // 2. Meta patches.
  for (const f of findings) {
    if (f.safety !== 'auto' || !f.patch || f.patch.target === 'body') continue
    if (f.patch.target === 'meta_title') {
      const next = patchField(metaTitle, f.patch.find, f.patch.replace)
      if (next === null) out.set(f.id, toFlag(f, '(could not locate the text to change)'))
      else { metaTitle = next; out.set(f.id, { ...f, status: 'applied' }) }
    } else {
      const next = patchField(metaDescription, f.patch.find, f.patch.replace)
      if (next === null) out.set(f.id, toFlag(f, '(could not locate the text to change)'))
      else { metaDescription = next; out.set(f.id, { ...f, status: 'applied' }) }
    }
  }

  // 3. Body patches. Checked against protectedTexts on the pre-patch body,
  // then applied ONE AT A TIME on a running snapshot — two findings sharing
  // an identical `find` must not both be judged against the original text:
  // the first to land consumes that text, so a second identical find
  // correctly fails to locate it afterward. The annotation check still runs
  // once over the whole batch; any introduced error reverts every patch that
  // had landed (a patch that already failed to apply keeps its own flag).
  const bodyFindings = findings.filter(f => f.safety === 'auto' && f.patch?.target === 'body')
  const toApply: Finding[] = []
  for (const f of bodyFindings) {
    if (overlapsProtected(body, f.patch!.find, opts.protectedTexts)) out.set(f.id, toFlag(f, '(touches protected verbatim text)'))
    else toApply.push(f)
  }
  if (toApply.length) {
    const before = body
    let running = before
    const appliedIds: string[] = []
    for (const f of toApply) {
      const res = applyFindReplace(running, f.patch!.find, f.patch!.replace)
      if (res.ok) {
        running = res.next
        appliedIds.push(f.id)
      } else {
        out.set(f.id, toFlag(f, '(could not locate the text to change)'))
      }
    }
    const check = checkEditAnnotations(before, running, { templateVersion: opts.templateVersion })
    if (check.errors.length) {
      for (const id of appliedIds) out.set(id, toFlag(out.get(id)!, '(would break a section annotation)'))
      // body stays `before` — none of this batch's changes land.
    } else {
      body = running
      for (const id of appliedIds) out.set(id, { ...out.get(id)!, status: 'applied' })
    }
  }

  // 4. auto findings with nothing to apply become flags.
  for (const f of findings) {
    if (f.safety === 'auto' && !f.patch && !f.variantFix) out.set(f.id, toFlag(f, ''))
  }

  return { fields: { body, metaTitle, metaDescription }, findings: findings.map(f => out.get(f.id)!) }
}
