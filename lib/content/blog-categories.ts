import { randomBytes } from 'node:crypto'
import { slugifyCategory, MAX_POST_CATEGORIES } from '@/lib/content/category-slug'
import type { SessionSchema } from '@/types/session-schema'
import { activeNiches } from '@/lib/content/active-niches'
import { serializeFile, splitFile } from '@/lib/editor/frontmatter'
import { readPostCategoryIds, readCategoryIdsFromFrontmatter } from '@/lib/content/post-categories'

export { slugifyCategory, MAX_POST_CATEGORIES, readPostCategoryIds, readCategoryIdsFromFrontmatter }
export const CATEGORIES_PATH = 'content/categories.json'
// Post slugs that would collide with the /blog/category/... routes.
export const RESERVED_POST_SLUGS: readonly string[] = ['category']

export type BlogCategory = { id: string; name: string; slug: string; description?: string }
export type CategoriesFile = { version: 1; categories: BlogCategory[] }

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// Must match the template's id rule (src/lib/content/categories.ts).
export const CATEGORY_ID_RE = /^c-[0-9a-f]{6}$/
const KEY = 'categories'

function isCategory(v: unknown): v is BlogCategory {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    typeof c.id === 'string' && CATEGORY_ID_RE.test(c.id) &&
    typeof c.name === 'string' && c.name.trim().length > 0 &&
    typeof c.slug === 'string' && SLUG_RE.test(c.slug) &&
    (c.description === undefined || typeof c.description === 'string')
  )
}

// `file` is null when the text is not a categories file at all; otherwise it
// holds the valid entries and `dropped` counts invalid/duplicate ones. A file
// with dropped > 0 is CORRUPT — never treat the remainder as the real list
// (a sync or write would then delete the dropped categories).
export type ParsedCategoriesFile = { file: CategoriesFile | null; dropped: number }

export function parseCategoriesFileDetailed(text: string): ParsedCategoriesFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { file: null, dropped: 0 }
  }
  if (!data || typeof data !== 'object') return { file: null, dropped: 0 }
  const list = (data as { categories?: unknown }).categories
  if (!Array.isArray(list)) return { file: null, dropped: 0 }
  const categories: BlogCategory[] = []
  const seenIds = new Set<string>()
  const seenSlugs = new Set<string>()
  let dropped = 0
  for (const item of list) {
    if (!isCategory(item) || seenIds.has(item.id) || seenSlugs.has(item.slug)) {
      dropped += 1
      continue
    }
    seenIds.add(item.id)
    seenSlugs.add(item.slug)
    const out: BlogCategory = { id: item.id, name: item.name, slug: item.slug }
    if (item.description !== undefined) out.description = item.description
    categories.push(out)
  }
  return { file: { version: 1, categories }, dropped }
}

// Strict: null for anything but a fully valid file.
export function parseCategoriesFile(text: string): CategoriesFile | null {
  const { file, dropped } = parseCategoriesFileDetailed(text)
  return dropped > 0 ? null : file
}

// Thrown when content/categories.json is corrupt (or, for routes that need an
// existing file, missing). Routes map it to a 422.
export class CategoriesFileError extends Error {
  kind: 'corrupt' | 'missing'
  constructor(kind: 'corrupt' | 'missing') {
    super(kind === 'corrupt' ? 'content/categories.json is invalid' : 'content/categories.json does not exist')
    this.name = 'CategoriesFileError'
    this.kind = kind
  }
}

export function serializeCategoriesFile(file: CategoriesFile): string {
  return JSON.stringify(file, null, 2) + '\n'
}

export function newCategoryId(existing: Iterable<string>): string {
  const taken = new Set(existing)
  for (;;) {
    const id = `c-${randomBytes(3).toString('hex')}`
    if (!taken.has(id)) return id
  }
}

export function seedCategoriesFromSchema(schema: SessionSchema): CategoriesFile {
  const categories: BlogCategory[] = []
  const slugs = new Set<string>()
  const ids = new Set<string>()
  for (const niche of activeNiches(schema)) {
    const name = niche.name.trim()
    const slug = slugifyCategory(name)
    if (!slug || slugs.has(slug)) continue
    const id = newCategoryId(ids)
    slugs.add(slug)
    ids.add(id)
    categories.push({ id, name, slug })
  }
  return { version: 1, categories }
}

export function setPostCategoryIds(postText: string, ids: string[]): string {
  const file = splitFile(postText)
  const fm = file.frontmatter
  if (!fm) return postText
  const clean = [...new Set(ids)].slice(0, MAX_POST_CATEGORIES)
  if (clean.length === 0) {
    delete fm.fields[KEY]
    delete fm.arrayFields[KEY]
    if (fm.blocks) delete fm.blocks[KEY]
    fm.order = fm.order.filter((k) => k !== KEY)
    return serializeFile(file)
  }
  delete fm.fields[KEY]
  if (fm.blocks) delete fm.blocks[KEY]
  fm.arrayFields[KEY] = clean
  if (!fm.order.includes(KEY)) {
    const tagsAt = fm.order.indexOf('tags')
    if (tagsAt >= 0) fm.order.splice(tagsAt + 1, 0, KEY)
    else fm.order.push(KEY)
  }
  return serializeFile(file)
}

export function replaceCategoryInPost(postText: string, removeId: string, moveTo: string | null): string {
  const current = readPostCategoryIds(postText)
  if (!current.includes(removeId)) return postText
  const next: string[] = []
  for (const id of current) next.push(id === removeId ? (moveTo ?? '') : id)
  return setPostCategoryIds(postText, next.filter((id) => id.length > 0))
}

export class CategoryValidationError extends Error {
  status: 400 | 409
  constructor(message: string, status: 400 | 409) {
    super(message)
    this.name = 'CategoryValidationError'
    this.status = status
  }
}

export function validateCategoryInput(
  input: { name: string; slug?: string; description?: string },
  others: BlogCategory[]
): Omit<BlogCategory, 'id'> {
  const name = input.name.trim()
  if (!name) throw new CategoryValidationError('Category name is required', 400)
  const explicit = input.slug?.trim()
  const slug = explicit ? explicit : slugifyCategory(name)
  if (!slug || !SLUG_RE.test(slug)) throw new CategoryValidationError('Slug must be lowercase letters, numbers and dashes', 400)
  if (others.some((c) => c.slug === slug)) throw new CategoryValidationError('Another category already uses that slug', 409)
  const out: Omit<BlogCategory, 'id'> = { name, slug }
  const description = input.description?.trim()
  if (description) out.description = description
  return out
}
