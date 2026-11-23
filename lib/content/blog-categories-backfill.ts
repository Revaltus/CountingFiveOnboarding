// ---------------------------------------------------------------------------
// Backfill: classify existing uncategorized draft posts in batches. The caller
// loops while `remaining > 0`, resending `attempted` so each post is classified
// at most once per run (posts the classifier returns [] for stay uncategorized).
// ---------------------------------------------------------------------------
import type { SessionSchema } from '@/types/session-schema'
import type { CategoriesAutoAssignResponse } from '@/types/blog-categories'
import { DRAFT_BRANCH, ensureDraftBranch, pushEntriesToBranch, readTextBlobs, type PushEntry } from '@/lib/github/repo-files'
import { splitFile } from '@/lib/editor/frontmatter'
import { readPostCategoryIds, setPostCategoryIds } from './blog-categories'
import { ensureSeeded, listDraftPosts, type Actor } from './blog-categories-repo'
import { classifyPostCategories } from './post-category-classifier'

export const BACKFILL_BATCH = 25
const CONCURRENCY = 4

// Frontmatter scalars are written JSON-quoted (title: "Foo") or bare.
function unquote(raw: string | undefined): string {
  const t = (raw ?? '').trim()
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return String(JSON.parse(t))
    } catch {
      return t.slice(1, -1)
    }
  }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1)
  return t
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function backfillCategories(args: {
  githubRepo: string
  sessionId: string
  schema: SessionSchema
  actor: Actor
  createdBy: string
  attempted: string[]
  deadlineAt?: number
}): Promise<CategoriesAutoAssignResponse> {
  const file = await ensureSeeded(args.githubRepo, args.schema, args.actor)
  const validIds = new Set(file.categories.map((c) => c.id))
  const skip = new Set(args.attempted)

  const listed = await listDraftPosts(args.githubRepo)
  const shaByPath = new Map(listed.map((p) => [p.path, p.sha]))
  const blobs = listed.length > 0 ? await readTextBlobs(args.githubRepo, listed) : []
  const candidates = blobs.filter((b) => !skip.has(b.path) && readPostCategoryIds(b.content).length === 0)
  const batch = candidates.slice(0, BACKFILL_BATCH)
  const remaining = candidates.length - batch.length

  const results = await mapPool(batch, CONCURRENCY, async (post) => {
    const { frontmatter, body } = splitFile(post.content)
    const ids = await classifyPostCategories({
      title: unquote(frontmatter?.fields.title),
      excerpt: unquote(frontmatter?.fields.excerpt),
      body,
      categories: file.categories,
      sessionId: args.sessionId,
      createdBy: args.createdBy,
      deadlineAt: args.deadlineAt,
    })
    return { post, ids: ids.filter((id) => validIds.has(id)) }
  })

  const entries: PushEntry[] = []
  for (const { post, ids } of results) {
    if (ids.length === 0) continue
    const updated = setPostCategoryIds(post.content, ids)
    if (updated === post.content) continue
    entries.push({ path: post.path, content: updated, expectedBlobSha: shaByPath.get(post.path) ?? null })
  }

  if (entries.length > 0) {
    await ensureDraftBranch(args.githubRepo)
    await pushEntriesToBranch(
      args.githubRepo,
      DRAFT_BRANCH,
      entries,
      `Auto-categorize ${entries.length} blog post${entries.length === 1 ? '' : 's'}`,
      { authorName: args.actor.name ?? 'Revaltus Admin', authorEmail: args.actor.email ?? 'admin@revaltus.com' }
    )
  }

  return {
    categorized: entries.length,
    leftUncategorized: batch.length - entries.length,
    remaining,
    attempted: batch.map((b) => b.path),
  }
}
