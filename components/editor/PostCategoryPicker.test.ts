import { describe, it, expect } from 'vitest'
import { pickerState, withPostCategories } from './PostCategoryPicker'
import type { Frontmatter } from '@/lib/editor/frontmatter'

const known = [
  { id: 'c-1', name: 'One', slug: 'one' },
  { id: 'c-2', name: 'Two', slug: 'two' },
  { id: 'c-3', name: 'Three', slug: 'three' },
  { id: 'c-4', name: 'Four', slug: 'four' },
]

describe('pickerState', () => {
  it('renders only known assigned ids, in assigned order', () => {
    const s = pickerState(['c-2', 'c-gone', 'c-1'], known)
    expect(s.chips.map((c) => c.id)).toEqual(['c-2', 'c-1'])
    expect(s.available.map((c) => c.id)).toEqual(['c-3', 'c-4'])
    expect(s.canAdd).toBe(true)
  })
  it('disables add at 3 assigned', () => {
    expect(pickerState(['c-1', 'c-2', 'c-3'], known).canAdd).toBe(false)
  })
  it('unknown ids do not count toward the cap', () => {
    expect(pickerState(['c-1', 'c-2', 'c-gone'], known).canAdd).toBe(true)
  })
  it('disables add when nothing is left to add', () => {
    expect(pickerState([], []).canAdd).toBe(false)
  })
})

const fm = (over: Partial<Frontmatter> = {}): Frontmatter => ({
  raw: '',
  fields: { title: 'T', tags: '' },
  arrayFields: { tags: ['a'] },
  order: ['title', 'tags', 'date'],
  ...over,
})

describe('withPostCategories', () => {
  it('sets the array field and inserts order after tags, immutably', () => {
    const base = fm()
    const next = withPostCategories(base, ['c-1', 'c-2'])
    expect(next.arrayFields.categories).toEqual(['c-1', 'c-2'])
    expect(next.order).toEqual(['title', 'tags', 'categories', 'date'])
    expect(base.arrayFields.categories).toBeUndefined()
    expect(base.order).toEqual(['title', 'tags', 'date'])
  })
  it('appends to order when there is no tags key', () => {
    expect(withPostCategories(fm({ order: ['title'] }), ['c-1']).order).toEqual(['title', 'categories'])
  })
  it('keeps position when categories is already in order', () => {
    const next = withPostCategories(fm({ order: ['title', 'categories', 'tags'] }), ['c-1'])
    expect(next.order).toEqual(['title', 'categories', 'tags'])
  })
  it('removes scalar/block entries for categories', () => {
    const next = withPostCategories(
      fm({ fields: { title: 'T', categories: 'x' }, blocks: { categories: { header: '', lines: ['- x'] } } }),
      ['c-1'],
    )
    expect(next.fields.categories).toBeUndefined()
    expect(next.blocks?.categories).toBeUndefined()
  })
  it('removes the key from arrayFields and order when empty', () => {
    const next = withPostCategories(
      fm({ arrayFields: { categories: ['c-1'] }, order: ['title', 'categories'] }),
      [],
    )
    expect(next.arrayFields.categories).toBeUndefined()
    expect(next.order).toEqual(['title'])
  })
})
