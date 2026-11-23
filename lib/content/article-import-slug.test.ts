import { describe, it, expect } from 'vitest'
import { pickImportSlug } from './article-import-generator'

describe('pickImportSlug', () => {
  it('dodges post slugs and page URL segments', () => {
    expect(
      pickImportSlug({ title: 'Tax Tips', importId: 'abcdef1234', postSlugs: ['tax-tips'], targetUrls: ['/services/tax-tips-2'] })
    ).toBe('tax-tips-3')
  })

  it("never mints a reserved slug (the /blog/category route)", () => {
    expect(pickImportSlug({ title: 'Category', importId: 'abcdef1234', postSlugs: [], targetUrls: [] })).toBe('category-2')
  })

  it('falls back to an id-derived slug for an unsluggable title', () => {
    expect(pickImportSlug({ title: '!!!', importId: 'abcdef1234', postSlugs: [], targetUrls: [] })).toBe('article-abcdef12')
  })
})
