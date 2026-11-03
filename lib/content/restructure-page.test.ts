import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { SessionSchema } from '@/types/session-schema'
import { splitFile } from '@/lib/editor/frontmatter'
import { getFaqBlock } from '@/lib/editor/structured-fields'
import { coerceVariants, composeProposal, existingImages, placeFaq, proposalErrors, splitOutFaq } from './restructure-page'
import { measurePageStructure } from './page-structure'

const file = readFileSync(path.join(__dirname, '__fixtures__', 'page-structure-zigzag.md'), 'utf8')
const PATH = 'content/pages/industries--optometry.md'
const schema = {} as SessionSchema

const faq = Array.from({ length: 6 }, (_, i) => ({
  question: `Question ${i}?`,
  answer: 'Answer text that is long enough to be a real answer for the reader.',
}))

const leanBody = `<!-- block: intro-text | variant: centered -->
## Accounting that fits an optometry practice

Short acknowledgement.

<!-- block: checklist-section | variant: standalone -->
## Where practices lose money

- Inventory
- Insurance timing
- Staffing swings

<!-- block: content-split | variant: image-right | image: optometry-intro-consult.jpg | alt: "Optometrist and practice manager reviewing financial reports together" | query: "optometrist reviewing financial documents office" -->
## What you get each month

Monthly reporting.

<!-- block: cta-banner | variant: color-bg -->
## Talk about your practice

[Book a practice review](/contact)`

describe('splitOutFaq', () => {
  it('reads the FAQ from frontmatter and removes the accordion from the body', () => {
    const { body, faq: items, heading } = splitOutFaq(file)
    expect(items.length).toBe(3)
    expect(heading).toMatch(/^Frequently Asked Questions/)
    expect(body).not.toContain('faq-accordion')
    expect(body).not.toContain('SEO & AIO Metadata')
  })
})

describe('placeFaq', () => {
  it('inserts the FAQ just before the final CTA', () => {
    const out = placeFaq(leanBody, 'FAQ heading', faq)
    expect(out.indexOf('faq-accordion')).toBeLessThan(out.indexOf('cta-banner'))
    expect(out.indexOf('faq-accordion')).toBeGreaterThan(out.indexOf('content-split'))
  })
  it('appends when there is no CTA', () => {
    const out = placeFaq('<!-- block: content-prose -->\n## A\n\nText.', 'FAQ', faq)
    expect(out.trimEnd().endsWith('A: ' + faq[5].answer)).toBe(true)
  })
})

describe('composeProposal', () => {
  const proposed = composeProposal(file, PATH, { body: leanBody, faq }, schema)

  it('keeps frontmatter SEO fields and the hidden trailer, and syncs faq_block', () => {
    const before = splitFile(file).frontmatter!
    const after = splitFile(proposed).frontmatter!
    expect(after.fields.meta_title).toBe(before.fields.meta_title)
    expect(after.fields.hero).toBe(before.fields.hero)
    expect(getFaqBlock(after)).toEqual(faq)
    expect(proposed).toContain('## SEO & AIO Metadata')
    expect(proposed).toContain('application/ld+json')
  })

  it('produces a page that meets the structure rules', () => {
    const m = measurePageStructure(proposed)
    expect(m.splitCount).toBe(1)
    expect(m.faqCount).toBe(6)
    expect(m.ctaLabel).toBe('Book a practice review')
    expect(m.contentAfterFaq).toBe(false)
  })

  it('drops an FAQ section the model wrote into the body anyway', () => {
    const sneaky = `${leanBody}\n\n<!-- block: faq-accordion -->\n## FAQ\n\n**Q: Dup?**\nA: Dup.`
    const out = composeProposal(file, PATH, { body: sneaky, faq }, schema)
    expect(out.match(/block: faq-accordion/g)).toHaveLength(1)
    expect(out).not.toContain('Dup?')
  })

  it('passes the safety checks', () => {
    expect(proposalErrors(file, proposed, { templateVersion: null, noGoPhrases: [] })).toEqual([])
  })
})

describe('proposalErrors', () => {
  it('rejects an invented image and a banned phrase', () => {
    const body = leanBody
      .replace('optometry-intro-consult.jpg', 'brand-new-photo.jpg')
      .replace('Monthly reporting.', 'Your trusted partner for monthly reporting.')
    const proposed = composeProposal(file, PATH, { body, faq }, schema)
    const errors = proposalErrors(file, proposed, { templateVersion: null, noGoPhrases: ['trusted partner'] })
    expect(errors.some((e) => e.includes('brand-new-photo.jpg'))).toBe(true)
    expect(errors.some((e) => e.includes('trusted partner'))).toBe(true)
  })

  it('rejects an unknown block id', () => {
    const proposed = composeProposal(file, PATH, { body: leanBody.replace('intro-text', 'mystery-block'), faq }, schema)
    expect(proposalErrors(file, proposed, { templateVersion: null, noGoPhrases: [] }).length).toBeGreaterThan(0)
  })
})

describe('existingImages', () => {
  it('lists every image annotation on the page', () => {
    expect(existingImages(splitFile(file).body).has('optometry-intro-consult.jpg')).toBe(true)
  })
})

describe('coerceVariants', () => {
  it('turns an invented variant into a valid one so the proposal passes the checks', () => {
    const body = leanBody.replace('intro-text | variant: centered', 'intro-text | variant: standard')
    expect(proposalErrors(file, composeProposal(file, PATH, { body, faq }, schema), { templateVersion: null, noGoPhrases: [] })).not.toEqual([])
    const fixed = coerceVariants(body, null)
    expect(fixed).toContain('<!-- block: intro-text | variant: centered -->')
    expect(proposalErrors(file, composeProposal(file, PATH, { body: fixed, faq }, schema), { templateVersion: null, noGoPhrases: [] })).toEqual([])
  })

  it('leaves valid variants and image fields alone', () => {
    expect(coerceVariants(leanBody, null)).toBe(leanBody)
  })
})
