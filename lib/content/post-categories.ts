// Reads a post's category ids from frontmatter. Crypto-free so client
// components (the editor's category picker) can import it.
import { splitFile, type Frontmatter } from '@/lib/editor/frontmatter'

const KEY = 'categories'

// Accepts every form a post may carry: inline array (`[a, b]`), a JSON-quoted
// array scalar, a single scalar, or a block list (`categories:\n  - a`).
export function readCategoryIdsFromFrontmatter(fm: Frontmatter | null | undefined): string[] {
  if (!fm) return []
  const arr = fm.arrayFields[KEY]
  if (arr) return [...arr]
  const scalar = fm.fields[KEY]
  if (scalar && scalar.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(scalar)
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0)
    } catch {
      // fall through to scalar handling
    }
  }
  if (scalar) return [scalar]
  const lines = fm.blocks?.[KEY]?.lines ?? []
  const ids: string[] = []
  for (const line of lines) {
    const m = /^\s*-\s+(.+?)\s*$/.exec(line)
    if (m) ids.push(m[1].replace(/^["']|["']$/g, ''))
  }
  return ids
}

export function readPostCategoryIds(postText: string): string[] {
  return readCategoryIdsFromFrontmatter(splitFile(postText).frontmatter)
}
