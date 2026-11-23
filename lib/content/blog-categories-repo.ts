// ---------------------------------------------------------------------------
// Blog categories ⇄ client repo sync. Categories live in content/categories.json
// and posts reference them by id in frontmatter. Reads prefer the draft branch
// (then main); every write goes to the draft branch with optimistic locking.
// ---------------------------------------------------------------------------
import type { SessionSchema } from '@/types/session-schema'
import {
  DRAFT_BRANCH,
  MAIN_BRANCH,
  FileNotFoundError,
  StaleShaError,
  ensureDraftBranch,
  listTree,
  pushEntriesToBranch,
  readFile,
  readTextBlobs,
  type PushEntry,
} from '@/lib/github/repo-files'
import {
  CATEGORIES_PATH,
  CategoryValidationError,
  parseCategoriesFile,
  readPostCategoryIds,
  replaceCategoryInPost,
  seedCategoriesFromSchema,
  serializeCategoriesFile,
  type CategoriesFile,
} from './blog-categories'

export type Actor = { name?: string | null; email?: string | null }
function authorOf(actor: Actor): { authorName: string; authorEmail: string } {
  return { authorName: actor.name ?? 'Revaltus Admin', authorEmail: actor.email ?? 'admin@revaltus.com' }
}

export type LoadedCategories = { file: CategoriesFile | null; sha: string | null }

const POST_PATH_RE = /^content\/posts\/[^/]+\.md$/

// Draft wins over main. `sha` is only returned for a draft file (it is the
// optimistic-lock token for draft writes). Invalid JSON yields `file: null`.
export async function loadCategories(githubRepo: string): Promise<LoadedCategories> {
  for (const branch of [DRAFT_BRANCH, MAIN_BRANCH]) {
    try {
      const blob = await readFile(githubRepo, CATEGORIES_PATH, branch)
      const file = parseCategoriesFile(blob.content)
      if (!file) console.warn('[blog-categories] categories.json is not valid')
      return { file, sha: branch === DRAFT_BRANCH && file ? blob.sha : null }
    } catch (err) {
      if (err instanceof FileNotFoundError) continue
      throw err
    }
  }
  return { file: null, sha: null }
}

// Seed categories from the MBP niches when no file exists. Race-safe: the
// create is guarded with expectedBlobSha null, and a lost race returns the
// other writer's file.
export async function ensureSeeded(githubRepo: string, schema: SessionSchema, actor: Actor): Promise<CategoriesFile> {
  const existing = await loadCategories(githubRepo)
  if (existing.file) return existing.file
  const seeded = seedCategoriesFromSchema(schema)
  try {
    await ensureDraftBranch(githubRepo)
    await pushEntriesToBranch(
      githubRepo,
      DRAFT_BRANCH,
      [{ path: CATEGORIES_PATH, content: serializeCategoriesFile(seeded), expectedBlobSha: null }],
      'Seed blog categories',
      authorOf(actor)
    )
    return seeded
  } catch (err) {
    if (!(err instanceof StaleShaError)) throw err
    const winner = await loadCategories(githubRepo)
    if (!winner.file) throw err
    return winner.file
  }
}

// Draft posts per category id. Ids not in the file are ignored.
export async function listCategoryCounts(githubRepo: string): Promise<Record<string, number>> {
  const { file } = await loadCategories(githubRepo)
  if (!file) return {}
  const counts: Record<string, number> = Object.fromEntries(file.categories.map((c) => [c.id, 0]))
  const tree = await listTree(githubRepo, DRAFT_BRANCH, 'content/posts/')
  const posts = tree.filter((t) => t.type === 'blob' && POST_PATH_RE.test(t.path))
  if (posts.length === 0) return counts
  for (const post of await readTextBlobs(githubRepo, posts)) {
    for (const id of new Set(readPostCategoryIds(post.content))) {
      if (id in counts) counts[id] += 1
    }
  }
  return counts
}

// Write categories.json to the draft branch. StaleShaError propagates.
export async function saveCategories(
  githubRepo: string,
  next: CategoriesFile,
  expectedSha: string | null,
  actor: Actor,
  message: string
): Promise<void> {
  await ensureDraftBranch(githubRepo)
  await pushEntriesToBranch(
    githubRepo,
    DRAFT_BRANCH,
    [{ path: CATEGORIES_PATH, content: serializeCategoriesFile(next), expectedBlobSha: expectedSha }],
    message,
    authorOf(actor)
  )
}

// Remove a category and rewrite every draft post that referenced it (moving
// them to `moveTo`, or just dropping it) in ONE commit.
export async function deleteCategory(
  githubRepo: string,
  id: string,
  moveTo: string | null,
  actor: Actor
): Promise<{ postsChanged: number }> {
  const loaded = await loadCategories(githubRepo)
  const file = loaded.file
  const target = file?.categories.find((c) => c.id === id)
  if (!file || !target) throw new CategoryValidationError('Category not found', 400)
  if (moveTo !== null && (moveTo === id || !file.categories.some((c) => c.id === moveTo))) {
    throw new CategoryValidationError('Move-to category does not exist', 400)
  }

  await ensureDraftBranch(githubRepo)
  // Guard categories.json with the draft sha; if it only exists on main the
  // draft copy must not exist yet.
  const entries: PushEntry[] = [
    {
      path: CATEGORIES_PATH,
      content: serializeCategoriesFile({ ...file, categories: file.categories.filter((c) => c.id !== id) }),
      expectedBlobSha: loaded.sha,
    },
  ]

  const tree = await listTree(githubRepo, DRAFT_BRANCH, 'content/posts/')
  const posts = tree.filter((t) => t.type === 'blob' && POST_PATH_RE.test(t.path))
  const shaByPath = new Map(posts.map((p) => [p.path, p.sha]))
  let postsChanged = 0
  if (posts.length > 0) {
    for (const post of await readTextBlobs(githubRepo, posts)) {
      const updated = replaceCategoryInPost(post.content, id, moveTo)
      if (updated === post.content) continue
      entries.push({ path: post.path, content: updated, expectedBlobSha: shaByPath.get(post.path) ?? null })
      postsChanged += 1
    }
  }

  await pushEntriesToBranch(githubRepo, DRAFT_BRANCH, entries, `Delete blog category ${target.name}`, authorOf(actor))
  return { postsChanged }
}
