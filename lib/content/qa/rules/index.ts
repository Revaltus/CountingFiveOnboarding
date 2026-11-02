import type { Finding } from '@/types/qa-review'
import { checkMediaAlternation } from './media-alternation'
import { checkCopy } from './copy-rules'
import { checkSeoFields } from './seo-fields'
import { checkPageStructure } from './page-structure'

export type RulesInput = {
  body: string
  pageUrl: string
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
    ...checkPageStructure(input.body, input.pageUrl, input.faqBlock),
  ]
}
