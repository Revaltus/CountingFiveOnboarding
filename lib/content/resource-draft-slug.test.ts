import { describe, it, expect } from 'vitest'
import { pickPostSlug, reserveIdeaSlug, canStartDraftStep } from './resource-draft-generator'

describe('pickPostSlug', () => {
  it('reuses the idea slug on a re-draft even though the index lists it (no slug-2 duplicate)', () => {
    // Regression: the cross-link index contains this idea's OWN post, so the old
    // collision loop always minted `<slug>-2` and left the original behind.
    expect(
      pickPostSlug({
        title: 'Year End Tax Planning',
        ideaId: 'abcdef12-0000',
        existingSlug: 'year-end-tax-planning',
        takenSlugs: ['year-end-tax-planning', 'other-post'],
      })
    ).toBe('year-end-tax-planning')
  })

  it('dodges other posts on a first draft', () => {
    expect(
      pickPostSlug({ title: 'Year End Tax Planning', ideaId: 'abcdef12', existingSlug: null, takenSlugs: ['year-end-tax-planning'] })
    ).toBe('year-end-tax-planning-2')
  })

  it('falls back to an id-derived slug for an unsluggable title', () => {
    expect(pickPostSlug({ title: '!!!', ideaId: 'abcdef1234', existingSlug: null, takenSlugs: [] })).toBe('post-abcdef12')
  })

  it("never mints a reserved slug (the /blog/category route)", () => {
    expect(pickPostSlug({ title: 'Category', ideaId: 'abcdef12', existingSlug: null, takenSlugs: [] })).toBe('category-2')
  })
})

type SlugStubOpts = { reservedRows: Array<{ slug: string }>; currentSlug: string | null; error?: { message: string } }

// Chainable stand-in for the two resource_ideas queries reserveIdeaSlug makes.
function slugStub(opts: SlugStubOpts) {
  const calls: Array<{ op: 'update' | 'select'; filters: Array<[string, string, unknown]> }> = []
  const from = () => {
    const call: { op: 'update' | 'select'; filters: Array<[string, string, unknown]> } = { op: 'select', filters: [] }
    calls.push(call)
    const api = {
      update: () => { call.op = 'update'; return api },
      select: () => api,
      eq: (c: string, v: unknown) => { call.filters.push(['eq', c, v]); return api },
      is: (c: string, v: unknown) => { call.filters.push(['is', c, v]); return api },
      single: async () => ({ data: { slug: opts.currentSlug }, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ data: opts.error ? null : opts.reservedRows, error: opts.error ?? null })),
    }
    return api
  }
  return { supabase: { from } as unknown as Parameters<typeof reserveIdeaSlug>[0], calls }
}

describe('reserveIdeaSlug', () => {
  it('persists a new idea slug before the commit, fenced on slug IS NULL', async () => {
    const { supabase, calls } = slugStub({ reservedRows: [{ slug: 'year-end' }], currentSlug: null })
    await expect(reserveIdeaSlug(supabase, 'idea-1', 'year-end')).resolves.toBe('year-end')
    expect(calls[0].op).toBe('update')
    expect(calls[0].filters).toEqual([['eq', 'id', 'idea-1'], ['is', 'slug', null]])
  })

  it('a retry after a lost status write reuses the reserved slug instead of minting -2', () => {
    // Attempt 1 reserved + committed `year-end`, then its status write failed.
    // Attempt 2 reads the idea with slug set, so pickPostSlug keeps it even
    // though the cross-link index now lists the committed post.
    expect(
      pickPostSlug({ title: 'Year End', ideaId: 'idea-1', existingSlug: 'year-end', takenSlugs: ['year-end'] })
    ).toBe('year-end')
  })

  it('adopts the slug another worker reserved first', async () => {
    const { supabase } = slugStub({ reservedRows: [], currentSlug: 'year-end' })
    await expect(reserveIdeaSlug(supabase, 'idea-1', 'year-end-2')).resolves.toBe('year-end')
  })

  it('throws (so the claim is released as a retriable error) when the reservation fails', async () => {
    const { supabase } = slugStub({ reservedRows: [], currentSlug: null, error: { message: 'boom' } })
    await expect(reserveIdeaSlug(supabase, 'idea-1', 'year-end')).rejects.toThrow('Could not reserve the post slug')
  })
})

describe('canStartDraftStep', () => {
  it('only starts a step that fits before the deadline', () => {
    expect(canStartDraftStep(1_000 + 150_000, 150_000, 1_000)).toBe(true)
    expect(canStartDraftStep(1_000 + 149_999, 150_000, 1_000)).toBe(false)
  })
})
