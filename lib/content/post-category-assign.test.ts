import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/github/repo-files', () => {
  class FileNotFoundError extends Error {}
  return { DRAFT_BRANCH: 'draft', FileNotFoundError, readFile: vi.fn() }
})
vi.mock('./blog-categories-repo', () => ({ ensureSeeded: vi.fn() }))
vi.mock('./post-category-classifier', () => ({ classifyPostCategories: vi.fn() }))

import * as repo from '@/lib/github/repo-files'
import { ensureSeeded } from './blog-categories-repo'
import { classifyPostCategories } from './post-category-classifier'
import { resolvePostCategories, existingPostPath } from './post-category-assign'
import type { SessionSchema } from '@/types/session-schema'

const readFile = vi.mocked(repo.readFile)
const seed = vi.mocked(ensureSeeded)
const classify = vi.mocked(classifyPostCategories)

const cats = { version: 1 as const, categories: [{ id: 'c-1', name: 'Tax', slug: 'tax' }] }
const base = {
  githubRepo: 'org/site',
  schema: {} as SessionSchema,
  post: { title: 'T', excerpt: 'E', body: 'B' },
  sessionId: 's1',
  contentJobId: 'j1',
}

describe('existingPostPath', () => {
  it('is null for a first draft', () => {
    expect(existingPostPath({ slug: null, draft_path: null })).toBeNull()
  })
  it('prefers draft_path, else the slug path', () => {
    expect(existingPostPath({ slug: 'a', draft_path: 'content/posts/b.md' })).toBe('content/posts/b.md')
    expect(existingPostPath({ slug: 'a', draft_path: null })).toBe('content/posts/a.md')
  })
})

describe('resolvePostCategories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('re-draft keeps the existing post categories and skips classification', async () => {
    readFile.mockResolvedValue({ content: '---\ntitle: "T"\ncategories: [c-9]\n---\nBody\n', sha: 'x', path: 'content/posts/a.md' })
    const ids = await resolvePostCategories({ ...base, existingPath: 'content/posts/a.md' })
    expect(ids).toEqual(['c-9'])
    expect(readFile).toHaveBeenCalledWith('org/site', 'content/posts/a.md', 'draft')
    expect(seed).not.toHaveBeenCalled()
    expect(classify).not.toHaveBeenCalled()
  })

  it('re-draft of a post without categories (or a missing file) classifies', async () => {
    readFile.mockRejectedValueOnce(new repo.FileNotFoundError('nope'))
    seed.mockResolvedValue(cats)
    classify.mockResolvedValue(['c-1'])
    expect(await resolvePostCategories({ ...base, existingPath: 'content/posts/a.md' })).toEqual(['c-1'])

    readFile.mockResolvedValueOnce({ content: '---\ntitle: "T"\n---\nBody\n', sha: 'x', path: 'content/posts/a.md' })
    expect(await resolvePostCategories({ ...base, existingPath: 'content/posts/a.md' })).toEqual(['c-1'])
  })

  it('new draft seeds then classifies with the post content', async () => {
    seed.mockResolvedValue(cats)
    classify.mockResolvedValue(['c-1'])
    expect(await resolvePostCategories({ ...base, existingPath: null })).toEqual(['c-1'])
    expect(readFile).not.toHaveBeenCalled()
    expect(seed).toHaveBeenCalledWith('org/site', base.schema, { name: 'Revaltus', email: null })
    expect(classify).toHaveBeenCalledWith({
      title: 'T',
      excerpt: 'E',
      body: 'B',
      categories: cats.categories,
      sessionId: 's1',
      contentJobId: 'j1',
    })
  })

  it('returns [] when the classifier picks nothing', async () => {
    seed.mockResolvedValue(cats)
    classify.mockResolvedValue([])
    expect(await resolvePostCategories({ ...base, existingPath: null })).toEqual([])
  })

  it('an ensureSeeded failure is non-fatal: no categories + a warning', async () => {
    seed.mockRejectedValue(new Error('corrupt categories.json'))
    expect(await resolvePostCategories({ ...base, existingPath: null })).toEqual([])
    expect(classify).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()
  })
})
