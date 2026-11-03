import type { Finding } from '@/types/qa-review'
import { checkMediaAlternation } from './media-alternation'
import { checkCopy } from './copy-rules'
import { checkSeoFields } from './seo-fields'
import { checkPageStructure } from './page-structure'
import { structureTypeForUrl } from '@/lib/content/page-structure'
import type { PageIntentType } from '@/lib/content/page-intent'

export type RulesInput = {
  body: string
  pageUrl: string
  // Schema-aware page type (resolvePageIntent); URL-only when absent.
  pageType?: PageIntentType
  metaTitle: string | null
  metaDescription: string | null
  heroBlock: string | null
  heroVariant: string | null
  heroSubhead: string | null
  faqBlock: unknown
  noGoPhrases: string[]
  avoidPhrases: string[]
}

// Deterministic, free checks. Runs first so the specialists see the hits.
export function runRules(input: RulesInput): Finding[] {
  return [
    ...checkMediaAlternation(input.body, { block: input.heroBlock, variant: input.heroVariant }),
    ...checkCopy(input),
    ...checkSeoFields(input.metaTitle, input.metaDescription, input.body),
    ...checkPageStructure(input.body, input.pageType ?? structureTypeForUrl(input.pageUrl), input.faqBlock),
  ]
}
