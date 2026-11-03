import { describe, it, expect } from 'vitest'
import { resolvePageIntent } from './page-intent'
import type { SessionSchema } from '@/types/session-schema'

const schema = {
  business: {
    name: 'Merrimack CPA',
    clientSuccessStories: [
      'Helped a healthcare practice cut its tax bill and clean up billing.',
      'Guided a construction contractor through bonding and WIP tracking.',
    ],
    serviceAreas: [{ city: 'Tyngsborough', county: 'Middlesex', state: 'MA', primary: true }],
  },
  services: [
    { name: 'Tax Planning', description: 'Proactive tax planning', offerings: ['Estimated payments', 'Entity elections'], keywords: ['tax planning'] },
  ],
  niches: [
    {
      name: 'Construction Contractors',
      description: 'Contractors',
      icp: 'Owner-operators pricing their own jobs',
      painPoints: 'Profitable on paper but cash-poor from bad job costing',
      valueProp: 'Job costing and estimated taxes that survive an audit',
      customerTrigger: 'A surprise tax bill in a lumpy-revenue year',
      decisionMaker: 'Owner / GM',
      businessStage: 'Established, scaling',
      keywords: ['construction accounting', 'job costing'],
    },
    {
      name: 'Healthcare Practices',
      description: 'Medical',
      icp: 'Practice owners',
      painPoints: 'Billing complexity',
      valueProp: 'Clean books and tax strategy',
      status: 'dropped',
    },
  ],
} as unknown as SessionSchema

describe('resolvePageIntent', () => {
  it('classifies the home page and returns no focus block', () => {
    expect(resolvePageIntent('/', 'Home', schema).type).toBe('home')
    expect(resolvePageIntent('', 'Home', schema).focusBlock).toBe('')
  })

  it('classifies about/contact pages', () => {
    expect(resolvePageIntent('/about', 'About', schema).type).toBe('about')
    expect(resolvePageIntent('/contact', 'Contact', schema).type).toBe('contact')
  })

  it('matches a niche page by slug and builds a persona-focused block', () => {
    const intent = resolvePageIntent('/industries/construction-contractors', 'Construction', schema)
    expect(intent.type).toBe('niche')
    expect(intent.niche?.name).toBe('Construction Contractors')
    expect(intent.focusBlock).toContain('Construction Contractors')
    expect(intent.focusBlock).toContain('job costing') // pain point content
    expect(intent.focusBlock).toContain('Owner / GM') // decision maker
  })

  it('cites the most relevant success story for the niche', () => {
    const intent = resolvePageIntent('/industries/construction-contractors', 'Construction', schema)
    expect(intent.focusBlock).toContain('bonding') // the construction story, not the healthcare one
  })

  it('never resolves a dropped niche', () => {
    const intent = resolvePageIntent('/industries/healthcare-practices', 'Healthcare', schema)
    expect(intent.type).toBe('niche')
    expect(intent.niche).toBeUndefined() // dropped → excluded by activeNiches
    expect(intent.focusBlock).toBe('')
  })

  it('matches a service page by slug', () => {
    const intent = resolvePageIntent('/services/tax-planning', 'Tax Planning', schema)
    expect(intent.type).toBe('service')
    expect(intent.service?.name).toBe('Tax Planning')
    expect(intent.focusBlock).toContain('Estimated payments')
  })

  it('matches service and niche pages under alternate hub paths', () => {
    const service = resolvePageIntent('/what-we-do/tax-planning', 'Tax Planning', schema)
    expect(service.type).toBe('service')
    expect(service.focusBlock).toContain('Estimated payments')
    expect(resolvePageIntent('/who-we-serve/construction-contractors', 'Contractors', schema).type).toBe('niche')
  })

  it('treats a top-level page named after a service or niche as that page', () => {
    const service = resolvePageIntent('/tax-planning', 'Tax Planning', schema)
    expect(service.type).toBe('service')
    expect(service.focusBlock).toContain('Estimated payments')
    expect(resolvePageIntent('/construction-contractors', 'Contractors', schema).type).toBe('niche')
  })

  it('needs an exact name match at the top level (no /tax or /team surprises)', () => {
    expect(resolvePageIntent('/tax', 'Tax', schema).type).toBe('generic')
    expect(resolvePageIntent('/team', 'Team', schema).type).toBe('generic')
  })

  it('classifies a location page and names the city', () => {
    const intent = resolvePageIntent('/locations/tyngsborough', 'Tyngsborough', schema)
    expect(intent.type).toBe('location')
    expect(intent.city).toBe('Tyngsborough')
    expect(intent.focusBlock).toContain('Tyngsborough')
  })

  it('handles absolute URLs and trailing slashes', () => {
    const intent = resolvePageIntent('https://merrimackcpa.com/Industries/Construction-Contractors/', 'x', schema)
    expect(intent.type).toBe('niche')
    expect(intent.niche?.name).toBe('Construction Contractors')
  })

  it('falls back to generic for unknown paths', () => {
    expect(resolvePageIntent('/resources/some-post', 'Post', schema).type).toBe('generic')
  })

  it('folds content-block items into the parent page focus as ALSO INCLUDE sections', () => {
    const blockSchema = {
      services: [
        { name: 'Tax Prep', description: '', offerings: [] },
        { name: 'Audit Protection', description: '', offerings: [], pageTreatment: 'block' },
      ],
    } as unknown as SessionSchema
    // The /services hub (otherwise a generic page) picks up its block service.
    const hub = resolvePageIntent('/services', 'Services', blockSchema)
    expect(hub.focusBlock).toContain('ALSO INCLUDE')
    expect(hub.focusBlock).toContain('Audit Protection')
    // A page whose parent isn't the block's target gets no directive.
    const other = resolvePageIntent('/about', 'About', blockSchema)
    expect(other.focusBlock).toBe('')
  })
})
