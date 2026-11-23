import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { extractJson } from './extract-json'
import { recordTokenUsage } from './token-usage'
import { extractCacheUsage } from './cache-control'
import { FAST_MODEL, FAST_PROVIDER_OPTIONS } from './generation-tuning'
import { HELPER_CALL_CAP_MS, clipToDeadline } from './generation-budget'
import type { BlogCategory } from './blog-categories'

const BODY_EXCERPT_CHARS = 1500
const MAX_CATEGORIES_PER_POST = 2

// Picks the 0-2 best-fitting blog categories for a post. Fails closed to []:
// a classifier problem must never block post generation.
export async function classifyPostCategories(args: {
  title: string
  excerpt: string
  body: string
  categories: BlogCategory[]
  sessionId: string
  contentJobId?: string | null
  createdBy?: string | null
  // Epoch ms the caller must finish by; the call's timeout is clipped to it.
  deadlineAt?: number
}): Promise<string[]> {
  if (args.categories.length === 0) return []

  const list = args.categories
    .map((c) => `${c.id} — ${c.name} — ${c.description?.trim() || '(no description)'}`)
    .join('\n')
  const prompt = `Assign this blog post to the categories that fit it best.

CATEGORIES (id — name — description):
${list}

POST
Title: ${args.title}
Excerpt: ${args.excerpt}
Body (start): ${args.body.slice(0, BODY_EXCERPT_CHARS)}

Pick the 1-${MAX_CATEGORIES_PER_POST} best-fitting category ids, or none if no category genuinely fits. Use only ids from the list.
Return ONLY JSON: {"ids":["<id>"]}  (or {"ids":[]} if none fit)`

  try {
    const { text, usage } = await generateText({
      model: anthropic(FAST_MODEL),
      providerOptions: FAST_PROVIDER_OPTIONS,
      system: 'You classify blog posts into a fixed category list. Return JSON only, no prose.',
      prompt,
      maxOutputTokens: 200,
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(clipToDeadline(args.deadlineAt, HELPER_CALL_CAP_MS)),
    })
    await recordTokenUsage({
      task: 'content',
      stage: 'categorize',
      contentJobId: args.contentJobId ?? null,
      sessionId: args.sessionId,
      createdBy: args.createdBy ?? null,
      pageUrl: 'post-categories',
      model: FAST_MODEL,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      ...extractCacheUsage(usage),
    })

    const parsed = extractJson(text) as { ids?: unknown } | null
    if (!parsed || !Array.isArray(parsed.ids)) {
      console.warn('[post-category-classifier] unparseable output:', text.slice(0, 120))
      return []
    }
    const known = new Set(args.categories.map((c) => c.id))
    const out: string[] = []
    for (const id of parsed.ids) {
      if (typeof id === 'string' && known.has(id) && !out.includes(id)) out.push(id)
      if (out.length >= MAX_CATEGORIES_PER_POST) break
    }
    return out
  } catch (err) {
    console.warn('[post-category-classifier] classification failed:', err)
    return []
  }
}
