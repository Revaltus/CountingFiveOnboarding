// LOCKED 2026-11-03 — the service Restructure/generation shape is approved.
// These snapshots fail on ANY change to the service skeleton, its budget or the
// shared page rules. Update them (`npx vitest -u`) only with explicit sign-off.
import { describe, it, expect } from 'vitest'
import { PAGE_STRUCTURE_RULES, bodyBudgetFor, buildPageSkeleton, formatSkeleton } from './page-structure'

describe('service page structure (locked)', () => {
  it('service skeleton prompt', () => {
    for (const hasTestimonials of [false, true]) {
      expect(formatSkeleton(buildPageSkeleton('service', { hasTestimonials, hasNichePricing: false }), 'service')).toMatchSnapshot()
    }
  })

  it('location pages share the service skeleton', () => {
    const opts = { hasTestimonials: false, hasNichePricing: false }
    expect(formatSkeleton(buildPageSkeleton('location', opts), 'location')).toBe(
      formatSkeleton(buildPageSkeleton('service', opts), 'service'),
    )
  })

  it('service budget', () => {
    expect(bodyBudgetFor('service')).toMatchSnapshot()
  })

  it('shared page rules', () => {
    expect(PAGE_STRUCTURE_RULES).toMatchSnapshot()
  })
})
