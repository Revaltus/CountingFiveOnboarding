import { describe, expect, it } from 'vitest'
import type { SessionSchema } from '@/types/session-schema'
import { exclusionCore, matchingExclusion, operatorExclusions } from './exclusion-match'

describe('exclusion matching', () => {
  it('strips page/service filler from the core phrase', () => {
    expect(exclusionCore('Audit Protection service page')).toBe('audit protection')
    expect(exclusionCore('Business Management Services page')).toBe('business management')
  })

  it('matches a page title or URL that names the excluded topic', () => {
    const ex = ['Audit Protection service page', 'high-end restaurants']
    expect(matchingExclusion('Audit Protection /what-we-do/audit-protection', ex)).toBe('Audit Protection service page')
    expect(matchingExclusion('Advice / Business Management Services', ['Business Management Services page'])).toBe('Business Management Services page')
  })

  it('does not match a broader or different topic', () => {
    const ex = ['high-end restaurants', 'targeting high net worth individuals', 'General Small Business / Startups']
    expect(matchingExclusion('Bars and Restaurants', ex)).toBeNull()
    expect(matchingExclusion('Individuals and Households', ex)).toBeNull()
    expect(matchingExclusion('Businesses', ex)).toBeNull()
  })

  it('ignores single-word exclusions for matching', () => {
    expect(matchingExclusion('Tax planning', ['tax'])).toBeNull()
  })

  it('treats review-mirrored exclusions as non-operator', () => {
    const schema = {
      business: { contentExclusions: ['Estates & Trusts / Fiduciary Administration', 'Audit Protection service page'] },
      _meta: { review_exclusions: ['Estates & Trusts / Fiduciary Administration'] },
    } as unknown as SessionSchema
    expect(operatorExclusions(schema)).toEqual(['Audit Protection service page'])
  })
})
