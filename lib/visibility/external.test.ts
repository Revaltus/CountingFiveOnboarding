import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isLiveHost } from './live-host'
import { buildRankQueries, primaryCity } from './ranks'
import { rankFor } from '@/lib/audit/serper-search'
import type { SessionSchema } from '@/types/session-schema'

describe('isLiveHost', () => {
  it.each([
    ['https://firm.com', true],
    ['https://www.firm-cpa.co.uk/about', true],
    ['https://firm-site.vercel.app', false],
    ['https://firm-git-main-revaltus.vercel.app/', false],
    ['http://localhost:3000', false],
    ['http://192.168.1.4', false],
    ['http://[::1]:3000', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isLiveHost(url)).toBe(expected)
  })
})

const schema = (business: Record<string, unknown>, locations?: unknown[]): SessionSchema =>
  ({ business, locations }) as unknown as SessionSchema

describe('primaryCity', () => {
  it('prefers the primary service area', () => {
    expect(primaryCity(schema({ serviceAreas: [{ city: 'Round Rock', state: 'TX' }, { city: 'Austin', state: 'TX', primary: true }] }))).toBe('Austin, TX')
  })
  it('falls back to the first location, then the first service area', () => {
    expect(primaryCity(schema({}, [{ city: 'Dallas', state: 'TX' }]))).toBe('Dallas, TX')
    expect(primaryCity(schema({ serviceAreas: [{ city: 'Waco' }] }))).toBe('Waco')
  })
  it('returns null with no geography', () => {
    expect(primaryCity(schema({}))).toBeNull()
  })
})

describe('buildRankQueries', () => {
  it('dedupes, appends the city once, and caps at 10', () => {
    const kws = ['Dental CPA', 'dental cpa', 'tax planning austin', ...Array.from({ length: 12 }, (_, i) => `kw${i}`)]
    const q = buildRankQueries(schema({ targetKeywords: kws, serviceAreas: [{ city: 'Austin', state: 'TX', primary: true }] }))
    expect(q).toHaveLength(10)
    expect(q[0]).toBe('Dental CPA Austin')
    expect(q[1]).toBe('tax planning austin')
  })
  it('returns [] with no keywords', () => {
    expect(buildRankQueries(schema({}))).toEqual([])
  })
})

describe('rankFor', () => {
  const realKey = process.env.SERPER_API_KEY
  beforeEach(() => {
    process.env.SERPER_API_KEY = 'k'
  })
  afterEach(() => {
    process.env.SERPER_API_KEY = realKey
    vi.unstubAllGlobals()
  })

  const stubResults = (links: string[]) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ organic: links.map((link, i) => ({ position: i + 1, link })) }))))

  it('finds the domain position, matching www and subdomains', async () => {
    stubResults(['https://other.com/', 'https://x.com', 'https://www.firm.com/dental'])
    expect(await rankFor('dental cpa', 'firm.com')).toEqual({ position: 3, url: 'https://www.firm.com/dental' })
  })

  it('reports not-ranked distinctly from could-not-run', async () => {
    stubResults(['https://other.com/'])
    expect(await rankFor('dental cpa', 'firm.com')).toEqual({ position: null, url: null })
    delete process.env.SERPER_API_KEY
    expect(await rankFor('dental cpa', 'firm.com')).toBeNull()
  })

  it('does not match a lookalike domain', async () => {
    stubResults(['https://notfirm.com/'])
    expect(await rankFor('q', 'firm.com')).toEqual({ position: null, url: null })
  })
})
