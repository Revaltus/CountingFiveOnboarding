import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { SessionSchema } from '@/types/session-schema'
import {
  BODY_MAX_WORDS,
  bodyBudgetFor,
  buildPageSkeleton,
  formatSkeleton,
  isCarouselBlock,
  isGenericCtaLabel,
  measurePageStructure,
  renderedBody,
  skeletonOptionsFor,
  structureTypeForUrl,
  structureViolations,
} from './page-structure'

const zigzag = readFileSync(path.join(__dirname, '__fixtures__', 'page-structure-zigzag.md'), 'utf8')

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')

const lean = `---
title: "Lean page"
---

<!-- block: intro-text | variant: centered -->
## We know contractor books

${words(50)}

<!-- block: checklist-section | variant: standalone -->
## Where cash goes missing

- One
- Two
- Three

<!-- block: content-split | variant: image-right | image: a.jpg | alt: "A" | query: "q" -->
## What you get

${words(80)}

<!-- block: process-steps | variant: vertical -->
## How we work

### Call
Short.

### Close
Short.

<!-- block: faq-accordion -->
## Frequently Asked Questions

${Array.from({ length: 6 }, (_, i) => `**Q: Question ${i}?**\nA: ${words(45)}`).join('\n\n')}

<!-- block: cta-banner | variant: color-bg -->
## Book a review

Short pitch.

[Book a job-costing review](/contact)
`

describe('measurePageStructure', () => {
  it('flags the zigzag rhythm and thin FAQ on a real generated page', () => {
    const m = measurePageStructure(zigzag)
    expect(m.splitCount).toBe(4)
    expect(m.consecutiveImageBlocks).toBeGreaterThan(0)
    expect(m.faqCount).toBe(3)
    expect(m.ctaLabel).toBe('Schedule a consultation')
    const codes = structureViolations(m, 'niche').map((v) => v.code)
    expect(codes).toEqual(expect.arrayContaining(['too_many_splits', 'consecutive_image_blocks', 'too_few_faqs']))
  })

  it('never counts the hidden SEO / structured-data trailer as copy', () => {
    expect(renderedBody(zigzag)).not.toContain('SEO & AIO Metadata')
    expect(renderedBody(zigzag)).not.toContain('application/ld+json')
  })

  it('passes a lean page built to the skeleton', () => {
    const m = measurePageStructure(lean)
    expect(m.splitCount).toBe(1)
    expect(m.faqCount).toBe(6)
    expect(m.scannableSections).toBeGreaterThanOrEqual(2)
    expect(m.contentAfterFaq).toBe(false)
    expect(structureViolations(m, 'niche')).toEqual([])
  })

  it('uses the supplied FAQ count when the FAQ is not in the markdown yet', () => {
    const body = lean.replace(/<!-- block: faq-accordion -->[\s\S]*?(?=<!-- block: cta-banner)/, '')
    expect(measurePageStructure(body, { faqCount: 8 }).faqCount).toBe(8)
  })

  it('flags an over-long body and content after the FAQ', () => {
    const long = lean.replace(words(80), words(BODY_MAX_WORDS)) + `\n<!-- block: content-prose -->\n## After\n\nMore.\n`
    const codes = structureViolations(measurePageStructure(long), 'service').map((v) => v.code)
    expect(codes).toContain('body_too_long')
    expect(codes).toContain('content_after_faq')
  })

  it('applies FAQ / scannability / CTA checks only to skeleton page types', () => {
    const bare = '<!-- block: content-prose -->\n## About us\n\nPlain text.\n'
    expect(structureViolations(measurePageStructure(bare), 'about')).toEqual([])
    expect(structureViolations(measurePageStructure(bare), 'niche').map((v) => v.code)).toEqual(
      expect.arrayContaining(['too_few_faqs', 'not_scannable', 'missing_cta']),
    )
  })
})

describe('isGenericCtaLabel', () => {
  it('catches generic labels in any casing and punctuation', () => {
    expect(isGenericCtaLabel('Learn More')).toBe(true)
    expect(isGenericCtaLabel('Contact us!')).toBe(true)
    expect(isGenericCtaLabel('Book a job-costing review')).toBe(false)
  })
})

describe('structureTypeForUrl', () => {
  it('maps URL shapes to page types', () => {
    expect(structureTypeForUrl('/')).toBe('home')
    expect(structureTypeForUrl('/industries/construction')).toBe('niche')
    expect(structureTypeForUrl('https://x.com/services/tax-planning/')).toBe('service')
    expect(structureTypeForUrl('/locations/austin')).toBe('location')
    expect(structureTypeForUrl('/industries')).toBe('generic')
    expect(structureTypeForUrl('/about')).toBe('about')
    expect(structureTypeForUrl('/what-we-do/income-tax')).toBe('service')
    expect(structureTypeForUrl('/who-we-serve/dentists')).toBe('niche')
  })
})

describe('buildPageSkeleton', () => {
  it('gives service/location pages Wade’s order and nothing to other types', () => {
    const slots = buildPageSkeleton('service', { hasTestimonials: false, hasNichePricing: false })
    expect(slots.map((s) => s.role)).toEqual([
      'Acknowledgement',
      'Problem and solution',
      'How it is delivered',
      'Validation',
      'How we do it',
      'Call to action',
    ])
    expect(buildPageSkeleton('about', { hasTestimonials: true, hasNichePricing: false })).toEqual([])
    expect(formatSkeleton([])).toBe('')
  })

  it('uses real testimonials only when the firm has them, and adds packages only with niche pricing', () => {
    const withProof = buildPageSkeleton('service', { hasTestimonials: true, hasNichePricing: true })
    expect(withProof.find((s) => s.role === 'Validation')?.blocks).toBe('testimonials')
    expect(withProof.some((s) => s.role === 'Packages')).toBe(true)
    const without = buildPageSkeleton('service', { hasTestimonials: false, hasNichePricing: false })
    expect(without.find((s) => s.role === 'Validation')?.blocks).not.toContain('testimonials')
  })

  it('reads testimonial availability from the schema', () => {
    const schema = { business: { clientSuccessStories: ['Saved a client $40k'] } } as unknown as SessionSchema
    expect(skeletonOptionsFor(schema).hasTestimonials).toBe(true)
    expect(skeletonOptionsFor({} as SessionSchema)).toEqual({ hasTestimonials: false, hasNichePricing: false })
  })
})

describe('isCarouselBlock', () => {
  it('marks testimonial carousels and hero sliders only', () => {
    expect(isCarouselBlock('testimonials', 'carousel')).toBe(true)
    expect(isCarouselBlock('hero', 'slider')).toBe(true)
    expect(isCarouselBlock('testimonials', 'grid')).toBe(false)
    expect(isCarouselBlock('content-split', 'image-right')).toBe(false)
  })
})

describe('industry skeleton (Prime flow)', () => {
  const slots = buildPageSkeleton('niche', { hasTestimonials: true, hasNichePricing: false })

  it('follows the prime.cpa industry order', () => {
    expect(slots.map((s) => s.role)).toEqual([
      'Acknowledgement',
      'Common challenges',
      'The solution',
      'How we help',
      'Validation',
      'Our model',
      'Call to action',
    ])
  })

  it('asks for exactly 4 challenges and 5 cards, with only two image sections, never adjacent', () => {
    expect(slots.find((s) => s.role === 'Common challenges')?.guidance).toContain('Exactly 4')
    expect(slots.find((s) => s.role === 'How we help')?.guidance).toContain('Exactly 5')
    const imageIdx = slots.map((s, i) => (s.blocks.startsWith('content-split') ? i : -1)).filter((i) => i >= 0)
    expect(imageIdx).toHaveLength(2)
    expect(imageIdx[1] - imageIdx[0]).toBeGreaterThan(1)
  })

  it('has its own, longer body budget and states it in the prompt', () => {
    expect(bodyBudgetFor('niche')).toEqual({ min: 750, max: 950, cap: 1100 })
    expect(bodyBudgetFor('service')).toEqual({ min: 500, max: 650, cap: 800 })
    const text = formatSkeleton(slots, 'niche')
    expect(text).toContain('Body budget: 750-950 words before the FAQ, never over 1100.')
    expect(text).toContain('keyword-rich detail')
  })

  it('judges industry pages against the industry cap, services against theirs', () => {
    const m = { ...measurePageStructure('<!-- block: intro-text -->\n## A\n\nx\n'), bodyWords: 900 }
    expect(structureViolations(m, 'niche').map((v) => v.code)).not.toContain('body_too_long')
    expect(structureViolations(m, 'service').map((v) => v.code)).toContain('body_too_long')
  })
})
