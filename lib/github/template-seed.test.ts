import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestError } from '@octokit/request-error'

const getContent = vi.fn()
const reposGet = vi.fn()
const createOrUpdateFileContents = vi.fn()
const getRef = vi.fn()
const getCommit = vi.fn()
const getTree = vi.fn()
const getBlob = vi.fn()
const createBlob = vi.fn()
const createTree = vi.fn()
const createCommit = vi.fn()
const updateRef = vi.fn()
const ensureDraftBranch = vi.fn()
const syncMainIntoDraft = vi.fn()

vi.mock('./app-client', () => ({
  getOctokit: () => ({
    repos: { getContent, get: reposGet, createOrUpdateFileContents },
    git: { getRef, getCommit, getTree, getBlob, createBlob, createTree, createCommit, updateRef },
  }),
  resolveRepo: (slug: string) => {
    const [owner, repo] = slug.split('/')
    return { owner, repo }
  },
}))

vi.mock('./repo-files', () => ({
  MAIN_BRANCH: 'main',
  DRAFT_BRANCH: 'draft',
  ensureDraftBranch: (slug: string) => ensureDraftBranch(slug),
  syncMainIntoDraft: (slug: string) => syncMainIntoDraft(slug),
}))

vi.mock('./rate-limit', () => ({
  sleep: () => Promise.resolve(),
  withRateLimitRetry: <T>(fn: () => Promise<T>) => fn(),
}))

import { isInlineableText, isTemplateOnlyPath, seedRepoFromTemplate } from './template-seed'

function reqError(status: number, message: string): RequestError {
  return new RequestError(message, status, {
    request: { method: 'GET', url: 'https://api.github.com', headers: {} },
  })
}

const TEMPLATE = 'Revaltus/CountingFiveTemplate'
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

function stubTemplate() {
  reposGet.mockResolvedValue({ data: { default_branch: 'main' } })
  getRef.mockImplementation(async ({ owner }: { owner: string }) =>
    ({ data: { object: { sha: owner === 'Revaltus' ? 'tmpl-head' : 'main-head' } } })
  )
  getCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) =>
    ({ data: { tree: { sha: `${commit_sha}-tree` } } })
  )
  getTree.mockResolvedValue({
    data: {
      truncated: false,
      tree: [
        { path: 'package.json', sha: 'b1', type: 'blob', mode: '100644' },
        { path: 'public/hero.png', sha: 'b2', type: 'blob', mode: '100644' },
      ],
    },
  })
  getBlob.mockImplementation(async ({ file_sha }: { file_sha: string }) => ({
    data: { encoding: 'base64', content: (file_sha === 'b2' ? PNG_BYTES : Buffer.from('{"name":"site"}')).toString('base64') },
  }))
  createTree.mockResolvedValue({ data: { sha: 'new-tree' } })
  createCommit.mockResolvedValue({ data: { sha: 'seed-commit' } })
  updateRef.mockResolvedValue({ data: {} })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GITHUB_TEMPLATE_REPO = TEMPLATE
  ensureDraftBranch.mockResolvedValue(undefined)
  syncMainIntoDraft.mockResolvedValue({ synced: true, alreadyCurrent: true, mergeCommitSha: null })
})

describe('isTemplateOnlyPath', () => {
  it('excludes the template-default content marker', () => {
    expect(isTemplateOnlyPath('content/.template-default')).toBe(true)
  })

  it('keeps everything else, including look-alikes', () => {
    for (const p of [
      'package.json',
      'content/brand.json',
      'c5-template.json',
      'src/app/fonts.generated.ts',
      'content/.template-default.bak',
      'nested/content/.template-default',
    ]) {
      expect(isTemplateOnlyPath(p)).toBe(false)
    }
  })
})

describe('isInlineableText', () => {
  it('accepts UTF-8 text, including multi-byte characters', () => {
    expect(isInlineableText(Buffer.from('const a = "café — ✓"\n'))).toBe(true)
  })

  it('rejects bytes with NULs or invalid UTF-8', () => {
    expect(isInlineableText(PNG_BYTES)).toBe(false)
    expect(isInlineableText(Buffer.from([0x66, 0xff, 0xfe, 0x67]))).toBe(false)
  })
})

describe('seedRepoFromTemplate', () => {
  it('retries the transient "Git Repository is empty" 409 right after bootstrap', async () => {
    getContent.mockRejectedValue(reqError(404, 'Not Found'))
    stubTemplate()
    createBlob
      .mockRejectedValueOnce(reqError(409, 'Git Repository is empty.'))
      .mockRejectedValueOnce(reqError(409, 'Git Repository is empty.'))
      .mockResolvedValue({ data: { sha: 'copied' } })

    const result = await seedRepoFromTemplate('Revaltus/client')

    expect(result).toMatchObject({ seeded: true, fileCount: 2, commitSha: 'seed-commit' })
    expect(createBlob).toHaveBeenCalledTimes(3)
  })

  it('does not retry any other 409', async () => {
    getContent.mockRejectedValue(reqError(404, 'Not Found'))
    stubTemplate()
    createBlob.mockRejectedValue(reqError(409, 'Conflict'))

    await expect(seedRepoFromTemplate('Revaltus/client')).rejects.toThrow('Conflict')
    expect(createBlob).toHaveBeenCalledTimes(1)
  })

  it('inlines text files into the tree and uploads only binaries as blobs', async () => {
    getContent.mockRejectedValue(reqError(404, 'Not Found'))
    stubTemplate()
    createBlob.mockResolvedValue({ data: { sha: 'png-blob' } })

    await seedRepoFromTemplate('Revaltus/client')

    expect(createBlob).toHaveBeenCalledTimes(1)
    expect(createBlob.mock.calls[0][0].content).toBe(PNG_BYTES.toString('base64'))
    expect(createTree.mock.calls[0][0].tree).toEqual([
      { path: 'package.json', mode: '100644', type: 'blob', content: '{"name":"site"}' },
      { path: 'public/hero.png', mode: '100644', type: 'blob', sha: 'png-blob' },
    ])
  })

  it('gives up on the empty-repo 409 after the bounded retries', async () => {
    getContent.mockRejectedValue(reqError(404, 'Not Found'))
    stubTemplate()
    createBlob.mockRejectedValue(reqError(409, 'Git Repository is empty.'))

    await expect(seedRepoFromTemplate('Revaltus/client')).rejects.toThrow(/empty/)
  })

  it('merges the seeded main into a pre-existing draft', async () => {
    getContent.mockRejectedValue(reqError(404, 'Not Found'))
    stubTemplate()
    createBlob.mockResolvedValue({ data: { sha: 'copied' } })
    syncMainIntoDraft.mockResolvedValue({ synced: true, alreadyCurrent: false, mergeCommitSha: 'm' })

    await seedRepoFromTemplate('Revaltus/client')

    expect(ensureDraftBranch).toHaveBeenCalledWith('Revaltus/client')
    expect(syncMainIntoDraft).toHaveBeenCalledWith('Revaltus/client')
  })

  it('fails clearly when the draft conflicts with the seeded template', async () => {
    getContent.mockRejectedValue(reqError(404, 'Not Found'))
    stubTemplate()
    createBlob.mockResolvedValue({ data: { sha: 'copied' } })
    syncMainIntoDraft.mockResolvedValue({ synced: false, reason: 'conflict' })

    await expect(seedRepoFromTemplate('Revaltus/client')).rejects.toThrow(/Reset draft to live/)
  })

  it('heals an already-seeded repo whose draft lacks the template', async () => {
    getContent.mockImplementation(async ({ ref }: { ref: string }) => {
      if (ref === 'main') return { data: {} }
      throw reqError(404, 'Not Found')
    })

    const result = await seedRepoFromTemplate('Revaltus/client')

    expect(result).toEqual({ seeded: false, skipped: 'already-seeded', fileCount: 0 })
    expect(syncMainIntoDraft).toHaveBeenCalledWith('Revaltus/client')
    expect(createBlob).not.toHaveBeenCalled()
  })

  it('leaves a normal live client draft alone on the skip path', async () => {
    getContent.mockResolvedValue({ data: {} })

    await seedRepoFromTemplate('Revaltus/client')

    expect(ensureDraftBranch).not.toHaveBeenCalled()
    expect(syncMainIntoDraft).not.toHaveBeenCalled()
  })
})
