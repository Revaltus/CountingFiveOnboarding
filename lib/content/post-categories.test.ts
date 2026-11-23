import { describe, expect, it } from 'vitest'
import { serializeFile, splitFile } from '@/lib/editor/frontmatter'
import { withPostCategories } from '@/components/editor/PostCategoryPicker'
import { readCategoryIdsFromFrontmatter, readPostCategoryIds } from './post-categories'

const post = (line: string) => `---\ntitle: T\ntags: [x]\n${line}\n---\nBody\n`

describe('readCategoryIdsFromFrontmatter (editor picker source)', () => {
  const cases: Array<[string, string, string[]]> = [
    ['inline array', 'categories: [c-aaaaaa, c-bbbbbb]', ['c-aaaaaa', 'c-bbbbbb']],
    ['JSON-quoted array', 'categories: ["c-aaaaaa","c-bbbbbb"]', ['c-aaaaaa', 'c-bbbbbb']],
    ['block list', 'categories:\n  - c-aaaaaa\n  - "c-bbbbbb"', ['c-aaaaaa', 'c-bbbbbb']],
    ['single scalar', 'categories: c-aaaaaa', ['c-aaaaaa']],
  ]
  it.each(cases)('reads a %s from a parsed Frontmatter object', (_label, line, ids) => {
    const fm = splitFile(post(line)).frontmatter
    expect(readCategoryIdsFromFrontmatter(fm)).toEqual(ids)
    expect(readPostCategoryIds(post(line))).toEqual(ids)
  })
  it.each(cases)('a picker add on a %s keeps the existing ids', (_label, line, ids) => {
    const file = splitFile(post(line))
    const next = withPostCategories(file.frontmatter!, [...readCategoryIdsFromFrontmatter(file.frontmatter), 'c-cccccc'])
    const text = serializeFile({ ...file, frontmatter: next })
    expect(readPostCategoryIds(text)).toEqual([...ids, 'c-cccccc'])
  })
  it('returns [] without frontmatter or key', () => {
    expect(readCategoryIdsFromFrontmatter(null)).toEqual([])
    expect(readCategoryIdsFromFrontmatter(splitFile(post('slug: s')).frontmatter)).toEqual([])
  })
})
