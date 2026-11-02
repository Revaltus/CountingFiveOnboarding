import { describe, it, expect } from 'vitest'
import {
  validateHeroSubhead,
  validateFaqAnswers,
  capInternalLinks,
  validateSchemaType,
  groundEeatSignals,
} from './output-validators'
import type { SessionSchema } from '@/types/session-schema'

describe('validateHeroSubhead', () => {
  it('accepts a 12-18 word subhead (returns null)', () => {
    expect(validateHeroSubhead('Know your tax exposure before year end so a surprise bill never derails your cash flow')).toBeNull()
  })
  it('flags a too-short subhead', () => {
    expect(validateHeroSubhead('Expert tax help')).toContain('too short')
  })
  it('flags a too-long subhead', () => {
    const long = Array(25).fill('word').join(' ')
    expect(validateHeroSubhead(long)).toContain('too long')
  })
  it('ignores an absent subhead (page-header pages)', () => {
    expect(validateHeroSubhead(null)).toBeNull()
    expect(validateHeroSubhead('   ')).toBeNull()
  })
})

describe('validateFaqAnswers', () => {
  it('flags answers outside the 40-80 word band', () => {
    const flags = validateFaqAnswers([
      { question: 'Too short?', answer: 'It depends on your situation.' },
      { question: 'Just right?', answer: Array(50).fill('word').join(' ') },
      { question: 'Too long?', answer: Array(95).fill('word').join(' ') },
    ])
    expect(flags).toHaveLength(2)
    expect(flags[0]).toContain('too short')
    expect(flags[1]).toContain('too long')
  })
  it('returns nothing for a valid or empty list', () => {
    expect(validateFaqAnswers([])).toEqual([])
    expect(validateFaqAnswers(null)).toEqual([])
    expect(validateFaqAnswers([{ question: 'q', answer: Array(45).fill('w').join(' ') }])).toEqual([])
  })
})

describe('capInternalLinks', () => {
  it('caps to at most 4, preserving order', () => {
    const links = Array.from({ length: 9 }, (_, i) => ({ url: `/p${i}` }))
    const kept = capInternalLinks(links, 4)
    expect(kept).toHaveLength(4)
    expect(kept[0].url).toBe('/p0')
  })
  it('leaves a short list untouched and handles non-arrays', () => {
    expect(capInternalLinks([{ url: '/a' }], 4)).toHaveLength(1)
    expect(capInternalLinks(null, 4)).toEqual([])
  })
})

describe('validateSchemaType', () => {
  it('keeps a valid schema.org type', () => {
    expect(validateSchemaType('FAQPage', 'generic')).toBe('FAQPage')
  })
  it('replaces an unknown type with the page-intent default', () => {
    expect(validateSchemaType('WebPage2', 'service')).toBe('Service')
    expect(validateSchemaType('nonsense', 'location')).toBe('LocalBusiness')
    expect(validateSchemaType(null, 'contact')).toBe('ContactPage')
  })
})

describe('groundEeatSignals', () => {
  const schema = {
    business: { foundingYear: '1998', differentiators: 'Niche focus on contractors', affiliations: ['AICPA'] },
    team: [{ certifications: ['CPA', 'PFS'] }],
    niches: [{ name: 'Construction' }],
    services: [{ name: 'Tax Planning' }],
  } as unknown as SessionSchema

  it('keeps generic (non-specific) signals', () => {
    expect(groundEeatSignals(['CPA-led firm', 'Personal service'], schema)).toEqual(['CPA-led firm', 'Personal service'])
  })
  it('keeps a specific claim that IS supported by firm facts', () => {
    expect(groundEeatSignals(['Serving clients since 1998'], schema)).toEqual(['Serving clients since 1998'])
  })
  it('drops a specific claim not backed anywhere in the firm facts', () => {
    expect(groundEeatSignals(['Ranked #1 in the state', 'Over 500 clients served'], schema)).toEqual([])
  })
  it('drops blanks and handles non-arrays', () => {
    expect(groundEeatSignals(['', '  '], schema)).toEqual([])
    expect(groundEeatSignals(null, schema)).toEqual([])
  })
})

describe('groundEeatSignals with dirty schema shapes', () => {
  it('survives null holes in niches (Berg: "Cannot read properties of null")', () => {
    const schema = {
      business: { differentiators: 'Woodard Top 50 firm' },
      niches: [{ name: 'Family Offices' }, null, { name: 'E-commerce' }],
      services: [null, { name: 'Tax' }],
    } as unknown as SessionSchema
    expect(groundEeatSignals(['Woodard Top 50 firm'], schema)).toEqual(['Woodard Top 50 firm'])
  })

  it('survives niches stored as a string', () => {
    const schema = { niches: 'Family Offices', services: null } as unknown as SessionSchema
    expect(groundEeatSignals(['Licensed CPA'], schema)).toEqual(['Licensed CPA'])
  })
})
