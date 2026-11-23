import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class FileNotFoundError extends Error {}
  return { FileNotFoundError, readFile: vi.fn() }
})
vi.mock('@/lib/github/repo-files', () => ({
  MAIN_BRANCH: 'main',
  FileNotFoundError: h.FileNotFoundError,
  readFile: h.readFile,
}))

import { readExportCategories } from './export-categories'

const A = { id: 'c-aaaaaa', name: 'A', slug: 'a' }
const B = { id: 'c-bbbbbb', name: 'B', slug: 'b', description: 'Bee' }
const text = (categories: unknown[]) => ({ content: JSON.stringify({ version: 1, categories }), sha: 's' })

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('readExportCategories', () => {
  it('reads categories.json from MAIN (as last published), not draft', async () => {
    h.readFile.mockResolvedValue(text([A, B]))
    expect(await readExportCategories('o/r')).toEqual([A, B])
    expect(h.readFile).toHaveBeenCalledWith('o/r', 'content/categories.json', 'main')
  })
  it('exports none (+ warning) when one entry is invalid — never a partial set', async () => {
    h.readFile.mockResolvedValue(text([A, B, { id: 'c-cccccc', name: 'C' }]))
    expect(await readExportCategories('o/r')).toEqual([])
    expect(console.warn).toHaveBeenCalled()
  })
  it('exports none on a duplicate slug', async () => {
    h.readFile.mockResolvedValue(text([A, { ...B, slug: 'a' }]))
    expect(await readExportCategories('o/r')).toEqual([])
  })
  it('missing file → [] silently; other read errors → [] with a warning', async () => {
    h.readFile.mockRejectedValueOnce(new h.FileNotFoundError('x'))
    expect(await readExportCategories('o/r')).toEqual([])
    expect(console.warn).not.toHaveBeenCalled()
    h.readFile.mockRejectedValueOnce(new Error('boom'))
    expect(await readExportCategories('o/r')).toEqual([])
    expect(console.warn).toHaveBeenCalled()
  })
})
