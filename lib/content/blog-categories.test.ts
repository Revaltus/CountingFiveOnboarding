import { describe, expect, it, vi } from 'vitest'
import type { SessionSchema } from '@/types/session-schema'

const rb = vi.hoisted(() => ({ queue: [] as string[] }))
vi.mock('node:crypto', async (orig) => {
  const actual = await orig<typeof import('node:crypto')>()
  return {
    ...actual,
    randomBytes: (n: number) => {
      const next = rb.queue.shift()
      return next ? Buffer.from(next, 'hex') : actual.randomBytes(n)
    },
  }
})

import {
  CategoryValidationError,
  newCategoryId,
  parseCategoriesFile,
  readPostCategoryIds,
  replaceCategoryInPost,
  seedCategoriesFromSchema,
  serializeCategoriesFile,
  setPostCategoryIds,
  slugifyCategory,
  validateCategoryInput,
} from './blog-categories'

const POST = `---
title: Hello: World
slug: hello
tags: [x, y]
date: 2026-01-01
---
Body text.
`

describe('categories file', () => {
  it('returns null for bad JSON and round-trips a valid file', () => {
    expect(parseCategoriesFile('{bad')).toBeNull()
    const text = serializeCategoriesFile({
      version: 1,
      categories: [{ id: 'c-aaaaaa', name: 'A', slug: 'a', description: 'd' }],
    })
    expect(text.endsWith('}\n')).toBe(true)
    expect(serializeCategoriesFile(parseCategoriesFile(text)!)).toBe(text)
  })
  it('drops entries missing a slug', () => {
    const f = parseCategoriesFile(JSON.stringify({ version: 1, categories: [{ id: 'c-1', name: 'A' }, { id: 'c-2', name: 'B', slug: 'b' }] }))
    expect(f?.categories.map((c) => c.id)).toEqual(['c-2'])
  })
})

describe('slugifyCategory', () => {
  it('normalizes', () => {
    expect(slugifyCategory('S-Corp & LLC')).toBe('s-corp-llc')
    expect(slugifyCategory('Construcción')).toBe('construccion')
    expect(slugifyCategory('  ')).toBe('')
  })
})

describe('newCategoryId', () => {
  it('has the right shape and skips collisions', () => {
    expect(newCategoryId([])).toMatch(/^c-[0-9a-f]{6}$/)
    rb.queue.push('aaaaaa', 'bbbbbb')
    expect(newCategoryId(['c-aaaaaa'])).toBe('c-bbbbbb')
  })
})

describe('seedCategoriesFromSchema', () => {
  const schema = (niches: Array<{ name: string; status?: 'dropped' }>) => ({ niches }) as unknown as SessionSchema
  it('uses kept niches only', () => {
    const f = seedCategoriesFromSchema(schema([{ name: 'Construction' }, { name: 'Nonprofits', status: 'dropped' }, { name: 'Real Estate' }]))
    expect(f.categories.map((c) => c.slug)).toEqual(['construction', 'real-estate'])
    expect(f.categories.every((c) => /^c-[0-9a-f]{6}$/.test(c.id))).toBe(true)
  })
  it('dedupes colliding slugs', () => {
    expect(seedCategoriesFromSchema(schema([{ name: 'Real Estate' }, { name: 'real-estate!' }])).categories).toHaveLength(1)
  })
})

describe('post frontmatter', () => {
  it('sets, dedupes and caps, after tags, leaving other lines intact', () => {
    const out = setPostCategoryIds(POST, ['a', 'b', 'a', 'c', 'd'])
    expect(out).toBe(POST.replace('tags: [x, y]\n', 'tags: [x, y]\ncategories: [a, b, c]\n'))
    expect(readPostCategoryIds(out)).toEqual(['a', 'b', 'c'])
  })
  it('removes the key when empty', () => {
    const withCats = setPostCategoryIds(POST, ['a'])
    expect(setPostCategoryIds(withCats, [])).toBe(POST)
  })
  it('replaces a category', () => {
    const p = (ids: string[]) => setPostCategoryIds(POST, ids)
    expect(readPostCategoryIds(replaceCategoryInPost(p(['c-1', 'c-3']), 'c-1', 'c-2'))).toEqual(['c-2', 'c-3'])
    expect(readPostCategoryIds(replaceCategoryInPost(p(['c-2', 'c-1']), 'c-1', 'c-2'))).toEqual(['c-2'])
    expect(readPostCategoryIds(replaceCategoryInPost(p(['c-1', 'c-3']), 'c-1', null))).toEqual(['c-3'])
  })
})

describe('validateCategoryInput', () => {
  const status = (fn: () => unknown) => {
    try { fn() } catch (e) { return e instanceof CategoryValidationError ? e.status : -1 }
    return 0
  }
  it('validates', () => {
    expect(status(() => validateCategoryInput({ name: '  ' }, []))).toBe(400)
    expect(status(() => validateCategoryInput({ name: 'Tax' }, [{ id: 'c-1', name: 'Taxes', slug: 'tax' }]))).toBe(409)
    expect(status(() => validateCategoryInput({ name: 'X', slug: 'Bad Slug' }, []))).toBe(400)
    expect(validateCategoryInput({ name: 'X', slug: 'category' }, [])).toEqual({ name: 'X', slug: 'category' })
  })
})
