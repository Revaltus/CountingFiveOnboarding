import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/github/repo-files', () => ({
  DRAFT_BRANCH: 'draft',
  readTextBlobs: vi.fn(),
  pushEntriesToBranch: vi.fn(),
  ensureDraftBranch: vi.fn(),
}))
vi.mock('./blog-categories-repo', () => ({ ensureSeeded: vi.fn(), listDraftPosts: vi.fn() }))
vi.mock('./post-category-classifier', () => ({ classifyPostCategories: vi.fn() }))

import * as gh from '@/lib/github/repo-files'
import * as repo from './blog-categories-repo'
import { classifyPostCategories } from './post-category-classifier'
import { backfillCategories, BACKFILL_BATCH } from './blog-categories-backfill'
import { readPostCategoryIds } from './blog-categories'
import type { SessionSchema } from '@/types/session-schema'

const push = vi.mocked(gh.pushEntriesToBranch)
const classify = vi.mocked(classifyPostCategories)
const cats = { version: 1 as const, categories: [{ id: 'c-1', name: 'One', slug: 'one' }, { id: 'c-2', name: 'Two', slug: 'two' }] }
const base = { githubRepo: 'r', sessionId: 's', schema: {} as SessionSchema, actor: {}, createdBy: 'u', attempted: [] as string[] }

function setup(n: number, categorized = 0) {
  const posts = Array.from({ length: n }, (_, i) => ({
    path: `content/posts/p${i}.md`,
    content: `---\ntitle: "Post ${i}"\nexcerpt: Ex ${i}\n${i < categorized ? 'categories: [c-2]\n' : ''}---\nBody ${i}\n`,
    sha: `sha-${i}`,
  }))
  vi.mocked(repo.listDraftPosts).mockResolvedValue(posts.map((p) => ({ path: p.path, sha: p.sha })))
  vi.mocked(gh.readTextBlobs).mockResolvedValue(posts.map((p) => ({ path: p.path, content: p.content })))
  return posts
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(repo.ensureSeeded).mockResolvedValue(cats)
  push.mockResolvedValue({ commitSha: 'x', fileCount: 1 })
})

describe('backfillCategories', () => {
  it('classifies 25 uncategorized of 30 in one sha-guarded commit, skipping categorized posts', async () => {
    setup(30, 5)
    classify.mockResolvedValue(['c-1'])
    const res = await backfillCategories(base)
    expect(classify).toHaveBeenCalledTimes(BACKFILL_BATCH)
    expect(res).toMatchObject({ categorized: 25, leftUncategorized: 0, remaining: 0 })
    expect(res.attempted).toHaveLength(25)
    expect(push).toHaveBeenCalledTimes(1)
    const entries = push.mock.calls[0][2]
    expect(entries).toHaveLength(25)
    expect(entries.some((e) => e.path === 'content/posts/p0.md')).toBe(false)
    expect(entries[0].expectedBlobSha).toMatch(/^sha-/)
    expect(readPostCategoryIds(entries[0].content!)).toEqual(['c-1'])
    expect(classify.mock.calls[0][0]).toMatchObject({ title: 'Post 5', excerpt: 'Ex 5', createdBy: 'u', sessionId: 's' })
  })

  it('reports remaining beyond the batch and honors attempted', async () => {
    setup(30)
    classify.mockResolvedValue(['c-1'])
    const first = await backfillCategories(base)
    expect(first).toMatchObject({ categorized: 25, remaining: 5 })
    const second = await backfillCategories({ ...base, attempted: ['content/posts/p0.md'] })
    expect(second.attempted).not.toContain('content/posts/p0.md')
  })

  it('counts [] as leftUncategorized and makes no commit when nothing changed', async () => {
    setup(3)
    classify.mockResolvedValue([])
    const res = await backfillCategories(base)
    expect(res).toMatchObject({ categorized: 0, leftUncategorized: 3, remaining: 0 })
    expect(push).not.toHaveBeenCalled()
  })

  it('drops unknown ids from the classifier', async () => {
    setup(1)
    classify.mockResolvedValue(['nope'])
    expect((await backfillCategories(base)).leftUncategorized).toBe(1)
    expect(push).not.toHaveBeenCalled()
  })

  it('propagates a stale-sha commit failure', async () => {
    setup(1)
    classify.mockResolvedValue(['c-1'])
    push.mockRejectedValue(new Error('stale'))
    await expect(backfillCategories(base)).rejects.toThrow('stale')
  })
})
