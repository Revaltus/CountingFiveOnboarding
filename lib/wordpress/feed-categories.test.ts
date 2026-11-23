import { beforeEach, describe, expect, it, vi } from 'vitest'

const repo = vi.hoisted(() => {
  class FileNotFoundError extends Error {}
  return {
    FileNotFoundError,
    readFile: vi.fn(),
    listTree: vi.fn(),
    readTextBlobs: vi.fn(),
  }
})

vi.mock('@/lib/github/repo-files', () => ({
  MAIN_BRANCH: 'main',
  FileNotFoundError: repo.FileNotFoundError,
  readFile: repo.readFile,
  listTree: repo.listTree,
  readTextBlobs: repo.readTextBlobs,
}))
vi.mock('@/lib/wordpress/sites', () => ({
  resolveSite: vi.fn(async () => ({ key: 'acme', github_repo: 'acme' })),
  verifyBearer: vi.fn(() => true),
}))

import { buildFeed } from './feed-builder'
import { GET } from '@/app/api/wp-feed/[site]/route'

const POST = ['---', 'title: T', 'slug: t', 'categories:', '  - c-a', '  - c-gone', '---', '', 'Body', ''].join('\n')
const FILE = JSON.stringify({
  version: 1,
  categories: [
    { id: 'c-a', name: 'A', slug: 'a', description: 'About A' },
    { id: 'c-b', name: 'B', slug: 'b' },
  ],
})

function setup(readFileImpl: () => Promise<{ content: string }>) {
  repo.readFile.mockImplementation(readFileImpl)
  repo.listTree.mockImplementation(async (_r: string, _b: string, prefix: string) =>
    prefix === 'content/posts/' ? [{ type: 'blob', path: 'content/posts/t.md', sha: 's' }] : []
  )
  repo.readTextBlobs.mockResolvedValue([{ path: 'content/posts/t.md', content: POST }])
}

async function routeBody() {
  const res = await GET(new Request('https://app.example.com/api/wp-feed/acme'), {
    params: Promise.resolve({ site: 'acme' }),
  })
  return (await res.json()) as Record<string, unknown>
}

const OPTS = { siteKey: 'acme', origin: 'https://app.example.com' }

describe('buildFeed categories', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the registry and filters post ids to known ones', async () => {
    setup(async () => ({ content: FILE }))
    const { posts, categories } = await buildFeed('acme', OPTS)
    expect(categories).toEqual([
      { id: 'c-a', name: 'A', slug: 'a', description: 'About A' },
      { id: 'c-b', name: 'B', slug: 'b', description: '' },
    ])
    expect(posts[0].categories).toEqual(['c-a'])
    expect(await routeBody()).toHaveProperty('categories')
  })

  it('missing file: null categories, ids unfiltered, no route key', async () => {
    setup(async () => {
      throw new repo.FileNotFoundError('x')
    })
    const { posts, categories } = await buildFeed('acme', OPTS)
    expect(categories).toBeNull()
    expect(posts[0].categories).toEqual(['c-a', 'c-gone'])
    expect(await routeBody()).not.toHaveProperty('categories')
  })

  it('invalid JSON: null categories and no route key', async () => {
    setup(async () => ({ content: '{not json' }))
    expect((await buildFeed('acme', OPTS)).categories).toBeNull()
    expect(await routeBody()).not.toHaveProperty('categories')
  })

  it('valid empty file: route emits categories: []', async () => {
    setup(async () => ({ content: JSON.stringify({ version: 1, categories: [] }) }))
    const body = await routeBody()
    expect(body.categories).toEqual([])
  })

  it('other read errors propagate (route 500)', async () => {
    setup(async () => {
      throw new Error('boom')
    })
    await expect(buildFeed('acme', OPTS)).rejects.toThrow('boom')
  })
})
