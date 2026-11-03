// Page-structure rule: the deterministic half of the user-first page skeleton
// (lib/content/page-structure.ts). Flag-only — a restructure is a whole-page
// rewrite, which no QA patch can make; the editor's Restructure compare does it.
import { randomUUID } from 'node:crypto'
import type { Finding, QaSeverity } from '@/types/qa-review'
import type { PageIntentType } from '@/lib/content/page-intent'
import {
  measurePageStructure,
  structureViolations,
  type StructureViolationCode,
} from '@/lib/content/page-structure'

const SEVERITY: Record<StructureViolationCode, QaSeverity> = {
  body_too_long: 'med',
  too_many_splits: 'low',
  consecutive_image_blocks: 'low',
  too_few_faqs: 'med',
  too_many_faqs: 'low',
  not_scannable: 'med',
  generic_cta: 'med',
  missing_cta: 'med',
  content_after_faq: 'low',
}

export function checkPageStructure(body: string, pageType: PageIntentType, faqBlock: unknown): Finding[] {
  const faqCount = Array.isArray(faqBlock) ? faqBlock.length : 0
  const metrics = measurePageStructure(body, { faqCount })
  return structureViolations(metrics, pageType).map((v) => ({
    id: randomUUID(),
    agent: 'rules',
    severity: SEVERITY[v.code],
    kind: v.code,
    quote: '',
    message: v.message,
    safety: 'flag',
    status: 'open',
  }))
}
