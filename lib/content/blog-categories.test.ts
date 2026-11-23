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
  CATEGORY_ID_RE,
  parseCategoriesFile,
  parseCategoriesFileDetailed,
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
  it('reports entries missing a slug as dropped; strict parse treats the file as corrupt', () => {
    const text = JSON.stringify({ version: 1, categories: [{ id: 'c-111111', name: 'A' }, { id: 'c-222222', name: 'B', slug: 'b' }] })
    const d = parseCategoriesFileDetailed(text)
    expect(d.dropped).toBe(1)
    expect(d.file?.categories.map((c) => c.id)).toEqual(['c-222222'])
    expect(parseCategoriesFile(text)).toBeNull()
  })
})

describe('parseCategoriesFile duplicates', () => {
  it('counts repeated ids or slugs as dropped (file is corrupt)', () => {
    const text = JSON.stringify({ version: 1, categories: [
      { id: 'c-111111', name: 'A', slug: 'a' },
      { id: 'c-111111', name: 'B', slug: 'b' },
      { id: 'c-222222', name: 'C', slug: 'a' },
      { id: 'c-333333', name: 'D', slug: 'd' },
    ] })
    const d = parseCategoriesFileDetailed(text)
    expect(d.dropped).toBe(2)
    expect(d.file?.categories.map((c) => c.id)).toEqual(['c-111111', 'c-333333'])
    expect(parseCategoriesFile(text)).toBeNull()
  })
})

describe('parseCategoriesFile validity', () => {
  it('treats a non-empty array with no valid entries as invalid, but [] as valid', () => {
    expect(parseCategoriesFile(JSON.stringify({ version: 1, categories: [{ id: 'c-111111', name: 'A' }] }))).toBeNull()
    expect(parseCategoriesFile(JSON.stringify({ version: 1, categories: [] }))).toEqual({ version: 1, categories: [] })
    expect(parseCategoriesFileDetailed('{bad')).toEqual({ file: null, dropped: 0 })
  })
  it('requires ids to match the template rule ^c-[0-9a-f]{6}$', () => {
    for (const id of ['c-1', 'c-ABCDEF', 'x-aaaaaa', 'c-aaaaaaa', '']) {
      const text = JSON.stringify({ version: 1, categories: [{ id: 'c-aaaaaa', name: 'A', slug: 'a' }, { id, name: 'B', slug: 'b' }] })
      expect(parseCategoriesFileDetailed(text).dropped).toBe(1)
      expect(parseCategoriesFile(text)).toBeNull()
    }
    expect(CATEGORY_ID_RE.test(newCategoryId([]))).toBe(true)
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

describe('block-style and absent categories', () => {
  const BLOCK = POST.replace('tags: [x, y]\n', 'tags: [x, y]\ncategories:\n  - c-1\n  - c-2\n')
  it('reads a block list and preserves it when rewriting', () => {
    expect(readPostCategoryIds(BLOCK)).toEqual(['c-1', 'c-2'])
    expect(readPostCategoryIds(replaceCategoryInPost(BLOCK, 'c-1', null))).toEqual(['c-2'])
  })
  it('reads a JSON-quoted inline array', () => {
    const q = POST.replace('tags: [x, y]\n', 'tags: [x, y]\ncategories: ["c-1","c-2"]\n')
    expect(readPostCategoryIds(q)).toEqual(['c-1', 'c-2'])
  })
  it('leaves text unchanged when the id is absent', () => {
    expect(replaceCategoryInPost(POST, 'c-9', 'c-1')).toBe(POST)
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
