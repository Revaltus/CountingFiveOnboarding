// Category assignment for the two post writers (LLM resource drafts and
// verbatim article imports). A re-draft keeps the post's current categories;
// otherwise categories.json is seeded if needed and the post is classified.
import type { SessionSchema } from '@/types/session-schema'
import { DRAFT_BRANCH, FileNotFoundError, readFile } from '@/lib/github/repo-files'
import { readPostCategoryIds } from './blog-categories'
import { ensureSeeded, type Actor } from './blog-categories-repo'
import { classifyPostCategories } from './post-category-classifier'
import { HELPER_CALL_CAP_MS, msUntil } from './generation-budget'

// Commit identity for a categories.json seed made by a background generator.
const GENERATOR_ACTOR: Actor = { name: 'Revaltus', email: null }

// Where a re-drafted idea's current post lives (null on a first draft).
export function existingPostPath(idea: { slug: string | null; draft_path: string | null }): string | null {
  if (!idea.slug) return null
  return idea.draft_path ?? `content/posts/${idea.slug}.md`
}

export async function resolvePostCategories(args: {
  githubRepo: string
  schema: SessionSchema
  existingPath: string | null
  post: { title: string; excerpt: string; body: string }
  sessionId: string
  contentJobId: string | null
  // Epoch ms model work must finish by. Too close → skip seed + classify (the
  // re-draft read above still runs, so existing categories are never dropped).
  deadlineAt?: number
}): Promise<string[]> {
  if (args.existingPath) {
    try {
      const blob = await readFile(args.githubRepo, args.existingPath, DRAFT_BRANCH)
      const ids = readPostCategoryIds(blob.content)
      if (ids.length > 0) return ids
    } catch (err) {
      // Any other read failure propagates: classifying here could overwrite
      // categories an operator set on the existing post.
      if (!(err instanceof FileNotFoundError)) throw err
    }
  }

  if (msUntil(args.deadlineAt) < HELPER_CALL_CAP_MS) {
    console.warn(`[post-categories] No time left to classify "${args.post.title}" — saving without categories`)
    return []
  }

  try {
    const file = await ensureSeeded(args.githubRepo, args.schema, GENERATOR_ACTOR)
    return await classifyPostCategories({
      title: args.post.title,
      excerpt: args.post.excerpt,
      body: args.post.body,
      categories: file.categories,
      sessionId: args.sessionId,
      contentJobId: args.contentJobId,
      deadlineAt: args.deadlineAt,
    })
  } catch (err) {
    console.warn(`[post-categories] Category assignment skipped for "${args.post.title}":`, err)
    return []
  }
}
