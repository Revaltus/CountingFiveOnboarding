import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { DRAFT_BRANCH, listTree, readFile } from '@/lib/github/repo-files'
import { splitFile, serializeFile, type PageFile } from '@/lib/editor/frontmatter'
import { checkTokenBudget, truncateToTokenBudget } from './truncate-to-token-budget'
import { recordTokenUsage } from './token-usage'
import { titleFromSlug } from './internal-link-targets'
import { FAST_MODEL, FAST_PROVIDER_OPTIONS } from './generation-tuning'
import { HELPER_CALL_CAP_MS, clipToDeadline, msUntil } from './generation-budget'

// Find-passage is a narrow extraction/rewrite task (return one verbatim
// sentence plus a minimally edited copy), not content authoring — Haiku is
// the appropriate tier.
const REVERSE_LINK_MODEL = FAST_MODEL
const MAX_CANDIDATES = 5
const MAX_INSERTIONS = 3
const READ_CONCURRENCY = 5
const CANDIDATE_BODY_TOKENS = 2400
// Don't start another find-passage call with less than this before the deadline.
const MIN_FIND_PASSAGE_MS = 10_000

// A post edit ready for pushEntriesToBranch, fenced on the sha that was read.
export type ReverseLinkEntry = { path: string; content: string; expectedBlobSha?: string | null }

export type ReverseLinkResult = {
  slug: string
  path: string
  anchorText: string
  insertedInto: string
}

export type ReverseLinkNewPost = {
  slug: string
  title: string
  keyword: string | null
  tags: string[]
  excerpt: string
  answerBlock: string
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'to', 'what', 'when', 'why',
  'with', 'you', 'your',
])

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  )
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const w of a) if (b.has(w)) n++
  return n
}

export type Candidate = {
  slug: string
  path: string
  file: PageFile
  score: number
  // Blob sha of the post as read — the commit is fenced on it so a concurrent
  // edit to this post is never silently overwritten (lost update).
  sha: string
}

// Exported for diagnostics (scripts/test-reverse-linker.ts prints scores).
// Candidates come from the draft branch only: reverse-links are committed to
// draft, and publish keeps draft a superset of main (syncMainIntoDraft), so
// already-published posts are reachable here too. The forward direction (new
// content → published corpus) is covered separately by buildCrossLinkIndex.
export async function loadCandidates(
  githubRepo: string,
  newPost: ReverseLinkNewPost
): Promise<Candidate[]> {
  const entries = await listTree(githubRepo, DRAFT_BRANCH, 'content/posts/')
  const paths = entries
    .filter((e) => e.type === 'blob' && e.path.endsWith('.md'))
    .map((e) => e.path)
    .filter((p) => p !== `content/posts/${newPost.slug}.md`)

  const newTags = new Set(newPost.tags.map((t) => t.toLowerCase().trim()))
  const newKeywordTokens = tokenize(newPost.keyword ?? '')
  const newTitleTokens = tokenize(newPost.title)
  const linkMarker = `](/resources/${newPost.slug})`

  const candidates: Candidate[] = []
  for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
    const batch = paths.slice(i, i + READ_CONCURRENCY)
    const loaded = await Promise.all(
      batch.map(async (path): Promise<Candidate | null> => {
        try {
          const blob = await readFile(githubRepo, path, DRAFT_BRANCH)
          const file = splitFile(blob.content)
          if (file.body.includes(linkMarker)) return null // already links — idempotent re-runs
          const fields = file.frontmatter?.fields ?? {}
          const arrays = file.frontmatter?.arrayFields ?? {}
          const slug = path.slice('content/posts/'.length, -3)

          const tags = (arrays.tags ?? []).map((t) => t.toLowerCase().trim())
          const sharedTags = tags.filter((t) => newTags.has(t)).length
          const candidateKeywords = tokenize(
            [fields.target_keyword ?? '', ...(arrays.secondary_keywords ?? [])].join(' ')
          )
          const keywordOverlap = overlap(newKeywordTokens, candidateKeywords)
          const titleOverlap = overlap(newTitleTokens, tokenize(fields.title ?? titleFromSlug(slug)))

          const score = sharedTags * 3 + keywordOverlap * 2 + titleOverlap
          if (score <= 0) return null
          return { slug, path, file, score, sha: blob.sha }
        } catch (err) {
          console.warn(`[reverse-link] Skipping unreadable post ${path}:`, err)
          return null
        }
      })
    )
    candidates.push(...loaded.filter((c): c is Candidate => c !== null))
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES)
}

export type FindPassageResponse = {
  match: boolean
  original_sentence?: string
  rewritten_sentence?: string
  anchor_text?: string
}

function parseFindPassage(text: string): FindPassageResponse | null {
  try {
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed: unknown = JSON.parse(cleaned)
    if (typeof parsed !== 'object' || parsed === null) return null
    const obj = parsed as Record<string, unknown>
    return {
      match: obj.match === true,
      original_sentence: typeof obj.original_sentence === 'string' ? obj.original_sentence : undefined,
      rewritten_sentence: typeof obj.rewritten_sentence === 'string' ? obj.rewritten_sentence : undefined,
      anchor_text: typeof obj.anchor_text === 'string' ? obj.anchor_text : undefined,
    }
  } catch {
    return null
  }
}

async function findPassage(args: {
  candidate: Candidate
  newPost: ReverseLinkNewPost
  contentJobId: string
  sessionId: string
  deadlineAt?: number
}): Promise<FindPassageResponse | null> {
  const { candidate, newPost } = args
  const url = `/resources/${newPost.slug}`
  const prompt = `You are adding ONE internal link from an existing blog post to a newly published post, but ONLY if there is a sentence where the link is genuinely relevant and helpful to the reader.

NEW POST (link target):
- URL: ${url}
- Title: ${newPost.title}
- What it covers: ${newPost.excerpt || newPost.answerBlock}

EXISTING POST BODY:
"""
${truncateToTokenBudget(candidate.file.body, CANDIDATE_BODY_TOKENS)}
"""

Find at most ONE existing sentence in the EXISTING POST BODY where a link to the new post would read naturally — where the sentence already touches the new post's topic. Pick a sentence that does not already contain a markdown link. Rewrite ONLY that one sentence to add a markdown link to ${url} using concise, natural anchor text (3-6 words drawn from the sentence). Change nothing else in the sentence. Do not add new sentences.

If no sentence is a genuine fit, return match=false. Forcing a weak link is worse than none.

Return ONLY JSON:
{ "match": true|false,
  "original_sentence": "the exact sentence copied verbatim from the body, unchanged",
  "rewritten_sentence": "same sentence with the markdown link added",
  "anchor_text": "the anchor text you used" }`

  const { text, usage } = await generateText({
    model: anthropic(REVERSE_LINK_MODEL),
    providerOptions: FAST_PROVIDER_OPTIONS,
    prompt,
    maxOutputTokens: 800,
    maxRetries: 4,
    // Haiku helper: a hang must not hold the caller's invocation.
    abortSignal: AbortSignal.timeout(clipToDeadline(args.deadlineAt, HELPER_CALL_CAP_MS)),
  })

  checkTokenBudget('reverse-link', `/resources/${candidate.slug}`, usage?.inputTokens, 5000)
  await recordTokenUsage({
    task: 'content',
    contentJobId: args.contentJobId,
    sessionId: args.sessionId,
    stage: 'resource',
    pageUrl: `/resources/${candidate.slug}`,
    model: REVERSE_LINK_MODEL,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
  })

  return parseFindPassage(text)
}

// Apply a find-passage response to an existing post. Pure and strict: the
// edit happens only on a verbatim original-sentence match with a valid link
// to the new slug, and never onto a sentence that already contains a link.
// Returns null when any guard fails — worst case is "no link added".
export function applyReverseLink(args: {
  file: PageFile
  slug: string
  path: string
  newSlug: string
  response: FindPassageResponse
  // Sha of the blob `file` was parsed from; carried onto the entry as the
  // push's expectedBlobSha (undefined = unguarded, for callers without one).
  blobSha?: string
}): { entry: ReverseLinkEntry; result: ReverseLinkResult } | null {
  const { file, response, newSlug } = args
  if (!response.match) return null
  const linkMarker = `](/resources/${newSlug})`
  const original = response.original_sentence?.trim() ?? ''
  const rewritten = response.rewritten_sentence?.trim() ?? ''
  if (!original || !rewritten || rewritten === original) return null
  if (!rewritten.includes(linkMarker)) return null
  if (original.includes('](')) return null // never stack onto an existing link
  // Exactly one markdown link, and it must be the expected internal one. The
  // URL target is server-fixed (linkMarker), so this is what stops the model
  // from smuggling a second/external link into a committed post — the
  // external-link stripper never runs on these existing-post edits.
  if ((rewritten.match(/\]\(/g) ?? []).length !== 1) return null
  if (!file.body.includes(original)) {
    console.warn(
      `[reverse-link] No verbatim match in ${args.slug} — model paraphrased, skipping`
    )
    return null
  }
  // Ambiguous: the same sentence appears more than once, so a first-match
  // replace could link the wrong occurrence. Skip rather than guess.
  if (file.body.split(original).length - 1 !== 1) {
    console.warn(`[reverse-link] Ambiguous sentence (multiple matches) in ${args.slug} — skipping`)
    return null
  }
  const newBody = file.body.replace(original, rewritten)
  return {
    entry: {
      path: args.path,
      content: serializeFile({ frontmatter: file.frontmatter, body: newBody }),
      ...(args.blobSha !== undefined ? { expectedBlobSha: args.blobSha } : {}),
    },
    result: {
      slug: args.slug,
      path: args.path,
      anchorText: response.anchor_text ?? '',
      insertedInto: rewritten,
    },
  }
}

// After a new post is committed, insert links back to it from the most
// relevant existing posts. Edits are applied only on a verbatim
// original-sentence match (no fuzzy matching — worst case is "no link
// added"), capped at one link per post and MAX_INSERTIONS posts. Returns the
// edited files as commit entries; the caller controls the commit.
export async function insertReverseLinks(args: {
  githubRepo: string
  newPost: ReverseLinkNewPost
  contentJobId: string
  sessionId: string
  // Absolute deadline (epoch ms); no new model call starts close to it.
  deadlineAt?: number
}): Promise<{
  results: ReverseLinkResult[]
  entries: ReverseLinkEntry[]
}> {
  const { githubRepo, newPost } = args
  const results: ReverseLinkResult[] = []
  const entries: ReverseLinkEntry[] = []

  const candidates = await loadCandidates(githubRepo, newPost)

  for (const candidate of candidates) {
    if (results.length >= MAX_INSERTIONS) break
    if (msUntil(args.deadlineAt) < MIN_FIND_PASSAGE_MS) break

    let response: FindPassageResponse | null = null
    try {
      response = await findPassage({
        candidate,
        newPost,
        contentJobId: args.contentJobId,
        sessionId: args.sessionId,
        deadlineAt: args.deadlineAt,
      })
    } catch (err) {
      console.warn(`[reverse-link] Model call failed for ${candidate.slug}:`, err)
      continue
    }
    if (!response) continue

    const applied = applyReverseLink({
      file: candidate.file,
      slug: candidate.slug,
      path: candidate.path,
      newSlug: newPost.slug,
      response,
      blobSha: candidate.sha,
    })
    if (!applied) continue
    entries.push(applied.entry)
    results.push(applied.result)
  }

  return { results, entries }
}
