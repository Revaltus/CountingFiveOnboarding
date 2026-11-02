import { describe, it, expect } from 'vitest'
import { runRules, type RulesInput } from './index'

const base: RulesInput = {
  body: '<!-- block: content-split | variant: image-right -->\n## A\n\nText.\n',
  pageUrl: '/about',
  metaTitle: 'Tax Planning for Dental Practices in Austin | Firm Name',  // 55 chars
  metaDescription: 'x'.repeat(155),
  heroBlock: 'hero', heroVariant: 'image', heroSubhead: null, faqBlock: null,
  noGoPhrases: [], avoidPhrases: [],
}

describe('runRules', () => {
  it('returns nothing for a clean page', () => {
    expect(runRules(base)).toEqual([])
  })
  it('flags meta length and missing meta', () => {
    const kinds = runRules({ ...base, metaTitle: 'Short', metaDescription: null }).map(f => [f.kind, f.severity])
    expect(kinds).toContainEqual(['meta_length', 'med'])
    expect(kinds).toContainEqual(['meta_missing', 'high'])
  })
  it('flags a body H1 and a skipped heading level', () => {
    const body = '# Title\n\n## A\n\n#### Deep\n'
    const kinds = runRules({ ...base, body }).map(f => f.kind)
    expect(kinds).toContain('heading_h1')
    expect(kinds).toContain('heading_skip')
  })
  it('flags no-go and client avoid phrases with the phrase as quote', () => {
    const body = base.body + '\nWe are your trusted partner in growth.\n'
    const f = runRules({ ...base, body, noGoPhrases: ['trusted partner'] }).find(x => x.kind === 'copy_banned_phrase')
    expect(f?.quote.toLowerCase()).toContain('trusted partner')
    expect(f?.safety).toBe('flag')
  })
  it('includes media alternation findings', () => {
    const body = base.body + '\n<!-- block: content-split | variant: image-right -->\n## B\n\nMore.\n'
    expect(runRules({ ...base, body }).some(f => f.kind === 'media_side')).toBe(true)
  })
  it('still extracts the phrase verbatim for a no-go hit', () => {
    const body = base.body + '\nAsk about our acme referral program today.\n'
    const f = runRules({ ...base, body, noGoPhrases: ['acme referral program'] }).find(x => x.kind === 'copy_banned_phrase')
    expect(f?.quote).toBe('acme referral program')
    expect(f?.message).toContain('banned no-go phrase')
  })
  it('gives a page-level finding with no quote for a structural anti-slop message', () => {
    const body = base.body + '\nWe help dentists grow. We build trust fast. We file returns on time.\n'
    const structural = runRules({ ...base, body }).find(f => f.kind === 'copy_ai_pattern')
    expect(structural?.quote).toBe('')
    expect(structural?.message).toContain('Three or more consecutive sentences')
    expect(structural?.severity).toBe('med')
    expect(structural?.safety).toBe('flag')
  })
  it('flags page-structure problems on a niche page, flag-only and never failing QA severity', () => {
    const body = [1, 2, 3].map(i => `<!-- block: content-split | variant: image-${i % 2 ? 'right' : 'left'} -->\n## S${i}\n\nText.\n`).join('\n')
    const found = runRules({ ...base, body, pageUrl: '/industries/dental' }).filter(f => f.agent === 'rules' && f.kind !== 'media_side')
    const kinds = found.map(f => f.kind)
    expect(kinds).toEqual(expect.arrayContaining(['too_many_splits', 'consecutive_image_blocks', 'too_few_faqs', 'missing_cta']))
    expect(found.every(f => f.safety === 'flag' && f.severity !== 'high')).toBe(true)
  })
  it('counts the stored faq_block toward the FAQ check', () => {
    const faqBlock = Array.from({ length: 7 }, (_, i) => ({ question: `q${i}`, answer: 'a' }))
    const kinds = runRules({ ...base, pageUrl: '/industries/dental', faqBlock }).map(f => f.kind)
    expect(kinds).not.toContain('too_few_faqs')
  })
})
