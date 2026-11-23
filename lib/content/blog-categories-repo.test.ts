import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/github/repo-files', () => {
  class FileNotFoundError extends Error {}
  class StaleShaError extends Error {
    constructor(public path = '', public currentSha = '', public currentContent = '') {
      super('stale')
    }
  }
  return {
    DRAFT_BRANCH: 'draft',
    MAIN_BRANCH: 'main',
    FileNotFoundError,
    StaleShaError,
    readFile: vi.fn(),
    listTree: vi.fn(),
    readTextBlobs: vi.fn(),
    pushEntriesToBranch: vi.fn(),
    ensureDraftBranch: vi.fn(),
  }
})

import * as repo from '@/lib/github/repo-files'
import {
  loadCategories,
  ensureSeeded,
  saveCategories,
  deleteCategory,
  listCategoryCounts,
  requireCategories,
} from './blog-categories-repo'
import { CategoryValidationError, serializeCategoriesFile, type CategoriesFile } from './blog-categories'
import type { SessionSchema } from '@/types/session-schema'

const readFile = vi.mocked(repo.readFile)
const listTree = vi.mocked(repo.listTree)
const readTextBlobs = vi.mocked(repo.readTextBlobs)
const push = vi.mocked(repo.pushEntriesToBranch)

const actor = { name: 'A', email: 'a@x.com' }
const file: CategoriesFile = {
  version: 1,
  categories: [
    { id: 'c-111111', name: 'One', slug: 'one' },
    { id: 'c-222222', name: 'Two', slug: 'two' },
  ],
}
const blob = (content: string, sha = 'sha-1') => ({ path: 'content/categories.json', content, sha })
const post = (ids: string[]) => `---\ntitle: T\ncategories: [${ids.join(', ')}]\n---\nBody\n`

beforeEach(() => {
  vi.resetAllMocks()
})

describe('loadCategories', () => {
  it('prefers draft over main', async () => {
    readFile.mockResolvedValueOnce(blob(serializeCategoriesFile(file), 'draft-sha'))
    const r = await loadCategories('o/r')
    expect(r.sha).toBe('draft-sha')
    expect(r.file?.categories).toHaveLength(2)
    expect(readFile).toHaveBeenCalledTimes(1)
  })
  it('falls back to main with null sha', async () => {
    readFile.mockRejectedValueOnce(new repo.FileNotFoundError('x'))
    readFile.mockResolvedValueOnce(blob(serializeCategoriesFile(file), 'main-sha'))
    const r = await loadCategories('o/r')
    expect(r.file).not.toBeNull()
    expect(r.sha).toBeNull()
  })
  it('returns null when both 404', async () => {
    readFile.mockRejectedValue(new repo.FileNotFoundError('x'))
    expect(await loadCategories('o/r')).toEqual({ file: null, sha: null, corrupt: false })
  })
  it('returns null on invalid JSON without throwing', async () => {
    readFile.mockResolvedValueOnce(blob('{nope'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await loadCategories('o/r')).toEqual({ file: null, sha: null, corrupt: true })
  })
  it('treats a partially-corrupt draft file as corrupt (no fallback to main)', async () => {
    const partial = JSON.stringify({ version: 1, categories: [...file.categories, { id: 'bad', name: 'X', slug: 'x' }] })
    readFile.mockResolvedValueOnce(blob(partial))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await loadCategories('o/r')).toEqual({ file: null, sha: null, corrupt: true })
    expect(readFile).toHaveBeenCalledTimes(1)
  })
  it('treats a partially-corrupt main file as corrupt', async () => {
    const dup = JSON.stringify({ version: 1, categories: [...file.categories, { ...file.categories[0], slug: 'other' }] })
    readFile.mockRejectedValueOnce(new repo.FileNotFoundError('x'))
    readFile.mockResolvedValueOnce(blob(dup))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await loadCategories('o/r')).corrupt).toBe(true)
  })
})

describe('corrupt file is never rewritten', () => {
  const partial = JSON.stringify({ version: 1, categories: [...file.categories, { id: 'c-333333', name: '', slug: 'z' }] })
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  it('ensureSeeded throws CategoriesFileError(corrupt) without pushing', async () => {
    readFile.mockResolvedValue(blob(partial))
    await expect(ensureSeeded('o/r', {} as SessionSchema, actor)).rejects.toMatchObject({ name: 'CategoriesFileError', kind: 'corrupt' })
    expect(push).not.toHaveBeenCalled()
  })
  it('ensureSeeded does not seed over a corrupt main-only file', async () => {
    readFile.mockRejectedValueOnce(new repo.FileNotFoundError('x'))
    readFile.mockResolvedValueOnce(blob(partial))
    await expect(ensureSeeded('o/r', {} as SessionSchema, actor)).rejects.toMatchObject({ kind: 'corrupt' })
    expect(push).not.toHaveBeenCalled()
  })
  it('deleteCategory throws CategoriesFileError(corrupt) without pushing', async () => {
    readFile.mockResolvedValue(blob(partial))
    await expect(deleteCategory('o/r', 'c-111111', null, actor)).rejects.toMatchObject({ kind: 'corrupt' })
    expect(push).not.toHaveBeenCalled()
  })
  it('requireCategories distinguishes corrupt from missing', async () => {
    readFile.mockResolvedValueOnce(blob(partial))
    await expect(requireCategories('o/r')).rejects.toMatchObject({ kind: 'corrupt' })
    readFile.mockRejectedValue(new repo.FileNotFoundError('x'))
    await expect(requireCategories('o/r')).rejects.toMatchObject({ kind: 'missing' })
  })
})

describe('ensureSeeded', () => {
  it('returns the existing file without writing', async () => {
    readFile.mockResolvedValueOnce(blob(serializeCategoriesFile(file)))
    expect(await ensureSeeded('o/r', {} as SessionSchema, actor)).toEqual(file)
    expect(push).not.toHaveBeenCalled()
  })
  it('ensureSeeded is race-safe', async () => {
    readFile.mockRejectedValueOnce(new repo.FileNotFoundError('x'))
    readFile.mockRejectedValueOnce(new repo.FileNotFoundError('x'))
    push.mockRejectedValueOnce(new repo.StaleShaError('content/categories.json', 's', ''))
    readFile.mockResolvedValueOnce(blob(serializeCategoriesFile(file), 'other'))
    const out = await ensureSeeded('o/r', {} as SessionSchema, actor)
    expect(out).toEqual(file)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][2][0].expectedBlobSha).toBeNull()
    expect(push.mock.calls[0][3]).toBe('Seed blog categories')
  })
})

describe('saveCategories', () => {
  it('passes expectedBlobSha through and propagates StaleShaError', async () => {
    await saveCategories('o/r', file, 'sha-9', actor, 'Update blog categories')
    expect(push.mock.calls[0][2][0].expectedBlobSha).toBe('sha-9')
    expect(push.mock.calls[0][4]).toEqual({ authorName: 'A', authorEmail: 'a@x.com' })
    push.mockRejectedValueOnce(new repo.StaleShaError('p', 's', ''))
    await expect(saveCategories('o/r', file, 'sha-9', actor, 'm')).rejects.toBeInstanceOf(repo.StaleShaError)
  })
})

describe('deleteCategory', () => {
  it('issues one push with categories.json and only affected posts', async () => {
    readFile.mockResolvedValueOnce(blob(serializeCategoriesFile(file), 'cat-sha'))
    listTree.mockResolvedValueOnce([
      { path: 'content/posts/a.md', sha: 'sa', type: 'blob' },
      { path: 'content/posts/b.md', sha: 'sb', type: 'blob' },
    ])
    readTextBlobs.mockResolvedValueOnce([
      { path: 'content/posts/a.md', content: post(['c-111111']) },
      { path: 'content/posts/b.md', content: post(['c-222222']) },
    ])
    const r = await deleteCategory('o/r', 'c-111111', 'c-222222', actor)
    expect(r).toEqual({ postsChanged: 1 })
    expect(push).toHaveBeenCalledTimes(1)
    const entries = push.mock.calls[0][2]
    expect(entries.map((e) => e.path)).toEqual(['content/categories.json', 'content/posts/a.md'])
    expect(entries[0].expectedBlobSha).toBe('cat-sha')
    expect(entries[0].content).not.toContain('c-111111')
    expect(entries[1].expectedBlobSha).toBe('sa')
    expect(String(entries[1].content)).toContain('c-222222')
    expect(push.mock.calls[0][3]).toBe('Delete blog category One')
  })
  it('rejects a moveTo that is not in the list', async () => {
    readFile.mockResolvedValueOnce(blob(serializeCategoriesFile(file)))
    await expect(deleteCategory('o/r', 'c-111111', 'c-999999', actor)).rejects.toMatchObject({
      name: 'CategoryValidationError',
      status: 400,
    })
    expect(push).not.toHaveBeenCalled()
    expect(CategoryValidationError).toBeDefined()
  })
})

describe('listCategoryCounts', () => {
  it('counts draft posts per known id', async () => {
    readFile.mockResolvedValueOnce(blob(serializeCategoriesFile(file)))
    listTree.mockResolvedValueOnce([
      { path: 'content/posts/a.md', sha: 'sa', type: 'blob' },
      { path: 'content/posts/b.md', sha: 'sb', type: 'blob' },
    ])
    readTextBlobs.mockResolvedValueOnce([
      { path: 'content/posts/a.md', content: post(['c-111111', 'c-222222']) },
      { path: 'content/posts/b.md', content: post(['c-111111', 'zzz']) },
    ])
    expect(await listCategoryCounts('o/r')).toEqual({ 'c-111111': 2, 'c-222222': 1 })
  })
})
