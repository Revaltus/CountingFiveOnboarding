import { describe, expect, it } from 'vitest'
import { buildSiteIndex, findPageMentioning, pagesOfKind, type IndexedPage } from './site-index'
import type { CrawledPage, PageAnalysis } from '@/types/audit-result'

function page(url: string, title: string, h1 = '', text = '', status = 200): [CrawledPage, PageAnalysis] {
  const crawled = {
    url,
    original_url: url,
    status_code: status,
    redirect_chain: [],
    redirect_count: 0,
    html: `<html><body>${text}</body></html>`,
    response_headers: {},
    ssl_error: false,
    content_length: 100,
  } satisfies CrawledPage
  const analyzed = {
    title,
    h1_texts: h1 ? [h1] : [],
    page_text_sample: text,
    schema_types: [],
    has_cta: false,
    has_phone: false,
  } as unknown as PageAnalysis
  return [crawled, analyzed]
}

function index(...pairs: Array<[CrawledPage, PageAnalysis]>): IndexedPage[] {
  return buildSiteIndex(pairs.map((p) => p[0]), pairs.map((p) => p[1]))
}

describe('buildSiteIndex', () => {
  it('skips error pages', () => {
    expect(index(page('https://a.com/x', 'X', '', '', 404))).toHaveLength(0)
  })

  it('derives the path', () => {
    expect(index(page('https://a.com/about-us/?q=1', 'About'))[0].path).toBe('/about-us/')
  })
})

describe('pagesOfKind', () => {
  const idx = index(
    page('https://a.com/careers', 'Careers'),
    page('https://a.com/about-us/our-team', 'Our Team'),
    page('https://a.com/opportunities', 'Join Our Team'),
    page('https://a.com/contact', 'Contact Us'),
    page('https://a.com/succession-planning', 'Practice Transition'),
    page('https://a.com/blog', 'Insights'),
  )

  it('classifies by path, title and h1', () => {
    expect(pagesOfKind(idx, 'careers').map((p) => p.path)).toEqual(['/careers', '/opportunities'])
    expect(pagesOfKind(idx, 'team').map((p) => p.path)).toEqual(['/about-us/our-team', '/opportunities'])
    expect(pagesOfKind(idx, 'about').map((p) => p.path)).toEqual(['/about-us/our-team'])
    expect(pagesOfKind(idx, 'contact')).toHaveLength(1)
    expect(pagesOfKind(idx, 'succession')).toHaveLength(1)
    expect(pagesOfKind(idx, 'resources')).toHaveLength(1)
  })
})

describe('findPageMentioning', () => {
  const idx = index(
    page('https://a.com/', 'Home', 'Welcome', 'We serve dental practices and more.'),
    page('https://a.com/industries/dental', 'Dentists', 'Accounting for Dental Practices'),
  )

  it('prefers a page whose heading names the phrase', () => {
    expect(findPageMentioning(idx, 'Dental Practices')?.path).toBe('/industries/dental')
  })

  it('falls back to body text', () => {
    const only = index(page('https://a.com/', 'Home', '', 'We serve dental practices and more.'))
    expect(findPageMentioning(only, 'dental practices')?.path).toBe('/')
  })

  it('headingOnly ignores body-text mentions', () => {
    const only = index(page('https://a.com/', 'Home', '', 'We serve dental practices and more.'))
    expect(findPageMentioning(only, 'dental practices', { headingOnly: true })).toBeNull()
  })

  it('returns null when absent or phrase is empty', () => {
    expect(findPageMentioning(idx, 'Construction')).toBeNull()
    expect(findPageMentioning(idx, '  ')).toBeNull()
  })
})
