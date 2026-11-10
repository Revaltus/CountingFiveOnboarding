import { describe, expect, it } from 'vitest'
import { AI_CHECKS, evaluateRubric, RUBRIC_VERSION } from './rubric'
import { scoreAll } from './score'
import { emptyContext, goodContext, NOW } from './__fixtures__/rubric-fixtures'

const byId = (checks: ReturnType<typeof evaluateRubric>) => new Map(checks.map((c) => [c.id, c]))

describe('evaluateRubric', () => {
  it('has a version and unique check ids covering every AI check', () => {
    expect(RUBRIC_VERSION).toMatch(/^\d{4}\.\d{2}\.\d+$/)
    const checks = evaluateRubric(goodContext())
    const ids = checks.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const ai of AI_CHECKS) expect(ids).toContain(ai.id)
  })

  it('scores a strong site highly in every audience', () => {
    const checks = evaluateRubric(goodContext())
    const { audienceScores } = scoreAll(checks)
    expect(audienceScores.prospects.score).toBeGreaterThanOrEqual(85)
    expect(audienceScores.clients.score).toBeGreaterThanOrEqual(85)
    expect(audienceScores.talent.score).toBeGreaterThanOrEqual(85)
    expect(audienceScores.search.score).toBeGreaterThanOrEqual(85)
    expect(audienceScores.ai.score).toBeGreaterThanOrEqual(85)
  })

  it('cites evidence pages for site checks', () => {
    const c = byId(evaluateRubric(goodContext()))
    expect(c.get('t.careers')?.evidenceUrl).toBe('https://firm.com/careers')
    expect(c.get('p.niche_pages')?.evidenceUrl).toBe('https://firm.com/industries/dental-practices')
  })

  it('handles an empty site without throwing and marks unrun evidence n/a', () => {
    const checks = evaluateRubric(emptyContext())
    const c = byId(checks)
    for (const id of ['s.ranks', 's.gbp', 'a.probe', 'p.answers_need', 'c.what_else', 't.story', 'a.entity_clarity']) {
      expect(c.get(id)?.status).toBe('na')
    }
    expect(c.get('t.careers')?.status).toBe('fail')
    expect(c.get('a.crawlers')?.status).toBe('fail')
    const { audienceScores } = scoreAll(checks)
    expect(audienceScores.talent.score).toBe(0)
  })

  it('marks AI checks n/a with an explanation when the review is unavailable', () => {
    const ctx = { ...goodContext(), ai: null }
    const check = byId(evaluateRubric(ctx)).get('p.answers_need')
    expect(check?.status).toBe('na')
    expect(check?.detail).toMatch(/unavailable/i)
  })

  it('applies the 60-day freshness boundary', () => {
    const at = (days: number) => {
      const d = new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10)
      const ctx = { ...goodContext(), sitemapEntries: [{ url: 'https://firm.com/blog/p', lastmod: d, type: 'post' }] }
      return byId(evaluateRubric(ctx)).get('c.fresh_content')?.status
    }
    expect(at(60)).toBe('pass')
    expect(at(61)).toBe('partial')
    expect(at(181)).toBe('fail')
  })

  it('scores ranks by top-10 share', () => {
    const ctx = {
      ...goodContext(),
      ranks: [
        { query: 'a', position: 2, url: null },
        { query: 'b', position: null, url: null },
        { query: 'c', position: 40, url: null },
        { query: 'd', position: null, url: null },
      ],
    }
    expect(byId(evaluateRubric(ctx)).get('s.ranks')?.status).toBe('partial')
  })

  it('scores succession only for firms open to a deal', () => {
    const open = goodContext()
    open.index = open.index.filter((p) => p.path !== '/succession-planning')
    expect(byId(evaluateRubric(open)).get('t.succession')?.status).toBe('fail')

    const closed = goodContext()
    closed.schema = { ...closed.schema, business: { ...closed.schema.business!, growthGoals: 'Grow advisory work.' } }
    const c = byId(evaluateRubric(closed)).get('t.succession')
    expect(c?.status).toBe('na')
    expect(c?.detail).toMatch(/stated goals/)
  })

  it('fails the portal check when portals are listed but not linked', () => {
    const ctx = goodContext()
    ctx.index = ctx.index.map((p) => ({ ...p, html: p.html.replace('sharefile', 'nothing') }))
    expect(byId(evaluateRubric(ctx)).get('c.portal')?.status).toBe('fail')
  })
})
