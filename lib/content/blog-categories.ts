import { randomBytes } from 'node:crypto'
import type { SessionSchema } from '@/types/session-schema'
import { activeNiches } from '@/lib/content/active-niches'
import { serializeFile, splitFile } from '@/lib/editor/frontmatter'

export const CATEGORIES_PATH = 'content/categories.json'
export const MAX_POST_CATEGORIES = 3
// Post slugs that would collide with the /blog/category/... routes.
export const RESERVED_POST_SLUGS: readonly string[] = ['category']

export type BlogCategory = { id: string; name: string; slug: string; description?: string }
export type CategoriesFile = { version: 1; categories: BlogCategory[] }

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const KEY = 'categories'

function isCategory(v: unknown): v is BlogCategory {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    typeof c.id === 'string' && c.id.length > 0 &&
    typeof c.name === 'string' && c.name.trim().length > 0 &&
    typeof c.slug === 'string' && SLUG_RE.test(c.slug) &&
    (c.description === undefined || typeof c.description === 'string')
  )
}

export function parseCategoriesFile(text: string): CategoriesFile | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const list = (data as { categories?: unknown }).categories
  if (!Array.isArray(list)) return null
  const categories: BlogCategory[] = []
  const seenIds = new Set<string>()
  const seenSlugs = new Set<string>()
  for (const item of list) {
    if (!isCategory(item)) continue
    if (seenIds.has(item.id) || seenSlugs.has(item.slug)) continue
    seenIds.add(item.id)
    seenSlugs.add(item.slug)
    const out: BlogCategory = { id: item.id, name: item.name, slug: item.slug }
    if (item.description !== undefined) out.description = item.description
    categories.push(out)
  }
  return { version: 1, categories }
}

export function serializeCategoriesFile(file: CategoriesFile): string {
  return JSON.stringify(file, null, 2) + '\n'
}

export function slugifyCategory(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
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

export function readPostCategoryIds(postText: string): string[] {
  const fm = splitFile(postText).frontmatter
  if (!fm) return []
  const arr = fm.arrayFields[KEY]
  if (arr) return [...arr]
  const scalar = fm.fields[KEY]
  if (scalar) return [scalar]
  // Block-style list: `categories:\n  - c-1\n  - c-2`
  const lines = fm.blocks?.[KEY]?.lines ?? []
  const ids: string[] = []
  for (const line of lines) {
    const m = /^\s*-\s+(.+?)\s*$/.exec(line)
    if (m) ids.push(m[1].replace(/^["']|["']$/g, ''))
  }
  return ids
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
