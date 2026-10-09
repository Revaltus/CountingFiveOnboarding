import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { fileTypeFromBuffer } from 'file-type'
import { createServerClient } from '@/lib/supabase/server'
import { isUrlPubliclyFetchable } from '@/lib/audit/ssrf-guard'
import { fetchLiveHtml } from '@/lib/onboarding/page-snapshot'
import { safeGetBinary } from '@/lib/audit/crawl'
import { checkTokenBudget, truncateToTokenBudget } from './truncate-to-token-budget'
import { recordTokenUsage } from './token-usage'
import { HELPER_CALL_CAP_MS } from './generation-budget'
import { DRAFT_BRANCH, pushEntriesToBranch, StaleShaError } from '@/lib/github/repo-files'
import { buildCrossLinkIndex, type InternalLinkTarget } from './internal-link-targets'
import { insertReverseLinks } from './reverse-linker'
import { reviewContentForMbpImpact } from '@/lib/mbp/impact-review'
import { toSitePath } from './url-path'
import { extractArticleMarkdown } from './html-to-markdown'
import { buildPostMarkdown } from './post-markdown'
import { updatedNavJson, updatedLlmsTxt, updatedLlmsFullTxt } from './resource-draft-generator'
import { activeTeam } from './active-team'
import type { AuditResult, CrawledPage } from '@/types/audit-result'
import type { SessionSchema } from '@/types/session-schema'
import { FAST_MODEL, FAST_PROVIDER_OPTIONS } from './generation-tuning'

// Find-passage-style link insertion is a narrow extraction/rewrite task, not
// authoring — fast tier, thinking off.
const LINK_MODEL = FAST_MODEL
const MAX_FORWARD_LINKS = 4
const BODY_PROMPT_TOKENS = 6000
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

type RepoEntry = { path: string; content: string | Buffer }

export interface ImportArticleResult {
  status: 'complete' | 'error' | 'skipped'
  slug?: string
  error?: string
}

function kebabSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
}

// A plain-text lead for the excerpt/meta fallback: first real prose line with
// markdown syntax stripped, capped.
function firstProse(markdown: string): string {
  for (const line of markdown.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('!') || t.startsWith('>') || t.startsWith('|')) continue
    const plain = t
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`#>]/g, '')
      .trim()
    if (plain.length > 20) return plain.slice(0, 155)
  }
  return ''
}

// Re-host every in-body image to the repo's served asset dir so it survives the
// old site going away. SSRF-guarded fetch + magic-byte validation (never trust
// the URL's extension). Images that fail to fetch/validate are dropped (their
// markdown removed) rather than left hotlinking a dead domain.
async function rehostImages(
  body: string,
  imageUrls: string[],
  slug: string
): Promise<{ body: string; entries: RepoEntry[] }> {
  const entries: RepoEntry[] = []
  let next = body
  let i = 0
  for (const url of imageUrls) {
    i += 1
    let filename: string | null = null
    try {
      if (await isUrlPubliclyFetchable(url)) {
        const fetched = await safeGetBinary(url)
        if (fetched) {
          const detected = await fileTypeFromBuffer(fetched.buffer)
          const ext = detected ? EXT_BY_MIME[detected.mime] : undefined
          if (ext) {
            filename = `${slug.slice(0, 48).replace(/-+$/, '')}-img-${i}.${ext}`
            entries.push({ path: `public/content-assets/${filename}`, content: fetched.buffer })
          }
        }
      }
    } catch (err) {
      console.warn(`[article-import] Image fetch failed for ${url}:`, err)
    }
    if (filename) {
      next = next.split(`](${url})`).join(`](/content-assets/${filename})`)
    } else {
      // Drop the image markdown, keep any surrounding text.
      next = next.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegExp(url)}\\)`, 'g'), '')
    }
  }
  return { body: next, entries }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Rewrite links that point back at the client's OLD site: turn them into
// site-relative links when the path exists in the cross-link index, otherwise
// strip the link but keep its anchor text. Real external citations are untouched.
function sweepOldSiteLinks(body: string, oldOrigin: string, indexUrls: Set<string>): string {
  let oldHost: string
  try {
    oldHost = new URL(oldOrigin).host.replace(/^www\./, '')
  } catch {
    return body
  }
  return body.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (full, anchor: string, url: string) => {
    let host: string
    try {
      host = new URL(url).host.replace(/^www\./, '')
    } catch {
      return full
    }
    if (host !== oldHost) return full
    const path = toSitePath(url)
    if (path && indexUrls.has(path)) return `[${anchor}](${path})`
    return anchor
  })
}

type ForwardEdit = { original_sentence?: unknown; rewritten_sentence?: unknown; url?: unknown }

function parseForwardEdits(text: string): ForwardEdit[] {
  try {
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed: unknown = JSON.parse(cleaned)
    return Array.isArray(parsed) ? (parsed as ForwardEdit[]) : []
  } catch {
    return []
  }
}

// Insert up to MAX_FORWARD_LINKS internal links INTO the verbatim body, at
// sentences where a link reads naturally — WITHOUT rewriting surrounding prose.
// Verbatim-safe: an edit applies only on a unique exact-sentence match whose
// rewrite adds exactly one markdown link to an allowed index URL and the source
// sentence had no link. Never throws — returns the (possibly unchanged) body.
async function injectForwardLinks(args: {
  body: string
  targets: InternalLinkTarget[]
  contentJobId: string
  sessionId: string
  pageUrl: string
}): Promise<string> {
  const { body, targets } = args
  if (!targets.length || !body.trim()) return body
  const allowed = new Set(targets.map((t) => t.url))
  const list = targets
    .slice(0, 25)
    .map((t) => `- ${t.url} — ${t.title}${t.keyword ? ` (keyword: ${t.keyword})` : ''}`)
    .join('\n')

  const prompt = `Add internal links to an article body, but ONLY where a link is genuinely relevant to the reader. Insert between 1 and ${MAX_FORWARD_LINKS} links total. Forcing a weak link is worse than none.

LINK TARGETS (you may ONLY link to these exact URLs — never invent a path):
${list}

ARTICLE BODY:
"""
${truncateToTokenBudget(body, BODY_PROMPT_TOKENS)}
"""

For each link, find ONE existing sentence where a link fits naturally, and rewrite ONLY that sentence to add a single markdown link to one of the target URLs, using concise natural anchor text (3-6 words drawn from the sentence). Do not change anything else in the sentence. Do not add new sentences. Never pick a sentence that already contains a markdown link.

Return ONLY a JSON array (possibly empty):
[{ "original_sentence": "exact sentence copied verbatim from the body", "rewritten_sentence": "same sentence with one markdown link added", "url": "the target URL you linked to" }]`

  let text: string
  try {
    // Bounded: the selection row is claimed 'drafting' while this runs.
    const res = await generateText({
      model: anthropic(LINK_MODEL),
      providerOptions: FAST_PROVIDER_OPTIONS,
      prompt,
      maxOutputTokens: 1500,
      maxRetries: 4,
      abortSignal: AbortSignal.timeout(HELPER_CALL_CAP_MS),
    })
    text = res.text
    checkTokenBudget('article-import-links', args.pageUrl, res.usage?.inputTokens, 5000)
    await recordTokenUsage({
      task: 'content',
      contentJobId: args.contentJobId,
      sessionId: args.sessionId,
      stage: 'resource',
      pageUrl: args.pageUrl,
      model: LINK_MODEL,
      inputTokens: res.usage?.inputTokens,
      outputTokens: res.usage?.outputTokens,
    })
  } catch (err) {
    console.warn('[article-import] Forward-link pass failed:', err)
    return body
  }

  let out = body
  let applied = 0
  for (const edit of parseForwardEdits(text)) {
    if (applied >= MAX_FORWARD_LINKS) break
    const original = typeof edit.original_sentence === 'string' ? edit.original_sentence.trim() : ''
    const rewritten = typeof edit.rewritten_sentence === 'string' ? edit.rewritten_sentence.trim() : ''
    const url = typeof edit.url === 'string' ? edit.url.trim() : ''
    if (!original || !rewritten || rewritten === original || !allowed.has(url)) continue
    if (!rewritten.includes(`](${url})`)) continue
    if ((rewritten.match(/\]\(/g) ?? []).length !== 1) continue
    if (original.includes('](')) continue
    if (out.split(original).length - 1 !== 1) continue // absent or ambiguous → skip
    out = out.replace(original, rewritten)
    applied += 1
  }
  return out
}

async function mark(
  supabase: ReturnType<typeof createServerClient>,
  id: string,
  fields: Record<string, unknown>
): Promise<void> {
  await supabase
    .from('content_job_article_imports')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)
}

// Import ONE of the client's own existing articles into the new site AS-IS: the
// body is the client's own prose converted verbatim (no LLM rewrite), wrapped
// with generated frontmatter, with images re-hosted and internal links injected.
// Atomic status lock so a concurrent run/cron doesn't double-draft. Never throws.
// Load (and memoize per job run) the crawled pages of an audit. The audit
// `result` JSONB is large; the runner used to re-read it once PER import.
export type AuditPagesCache = Map<string, Promise<CrawledPage[]>>

export function loadAuditPages(
  supabase: ReturnType<typeof createServerClient>,
  auditRunId: string,
  cache?: AuditPagesCache
): Promise<CrawledPage[]> {
  const hit = cache?.get(auditRunId)
  if (hit) return hit
  const load = (async () => {
    const { data: run } = await supabase
      .from('audit_runs')
      .select('result')
      .eq('id', auditRunId)
      .single()
    return (run?.result as unknown as AuditResult | null)?.raw?.pages ?? []
  })()
  cache?.set(auditRunId, load)
  return load
}

export async function importArticleAsIs(
  importId: string,
  // `priorAttempts` is the row's attempts count as the runner read it; the claim
  // stamps priorAttempts + 1 so the auto-retry cap can stop a row that keeps
  // failing. `auditPages` shares one audit-result read across a whole job run.
  opts?: { priorAttempts?: number; auditPages?: AuditPagesCache }
): Promise<ImportArticleResult> {
  const supabase = createServerClient()
  const priorAttempts = opts?.priorAttempts ?? 0

  // Atomic claim: flip pending/error → drafting; a losing racer gets no row.
  // Never re-claims a `complete` (or in-flight) import.
  const { data: claimed } = await supabase
    .from('content_job_article_imports')
    .update({ status: 'drafting', error: null, attempts: priorAttempts + 1, updated_at: new Date().toISOString() })
    .eq('id', importId)
    .in('status', ['pending', 'error'])
    .select('id, content_job_id, session_id, audit_run_id, source_url, source_title')
    .maybeSingle()
  if (!claimed) return { status: 'skipped' }

  try {
    const { data: job } = await supabase
      .from('content_jobs')
      .select('github_repo, palette')
      .eq('id', claimed.content_job_id)
      .single()

    // Repo not provisioned yet (repos are seeded at phase 6). Transient, not a
    // failure — leave PENDING so the publish chain + cron auto-resume it.
    if (!job?.github_repo) {
      // Waiting on the repo isn't a failed attempt — give the claim's attempt back.
      await mark(supabase, importId, { status: 'pending', error: null, attempts: priorAttempts })
      return { status: 'skipped' }
    }
    const githubRepo = job.github_repo

    const { data: session } = await supabase
      .from('sessions')
      .select('website_url, schema_data')
      .eq('id', claimed.session_id)
      .single()
    if (!session) throw new Error('Session not found')
    const schema = (session.schema_data ?? {}) as SessionSchema

    // The source must be a page the audit actually crawled (never an arbitrary
    // URL). Its HTML is fetched live: the audit trims page HTML before storing
    // it, so a stored copy only exists on audits from before that trim.
    const pages = await loadAuditPages(supabase, claimed.audit_run_id, opts?.auditPages)
    const page = pages.find((p) => p.url === claimed.source_url)
    if (!page) throw new Error('Source article is no longer in the audit crawl')
    const html = page.html || (await fetchLiveHtml(claimed.source_url))
    if (!html) throw new Error('Could not fetch the source article from the live site')

    const extracted = extractArticleMarkdown(html, { baseUrl: claimed.source_url })
    if (!extracted.markdown.trim()) throw new Error('Could not extract an article body from the page')

    const title = (claimed.source_title || extracted.extractedTitle || '').trim() || 'Imported Article'

    // Slug: dodge collisions with existing posts AND page URLs (union index).
    const { targets, postSlugs } = await buildCrossLinkIndex(githubRepo)
    const indexUrls = new Set(targets.map((t) => t.url))
    const taken = new Set(postSlugs)
    for (const t of targets) {
      const seg = t.url.split('/').filter(Boolean).pop()
      if (seg) taken.add(seg)
    }
    let slug = kebabSlug(title) || `article-${importId.slice(0, 8)}`
    let suffix = 2
    const base = slug
    while (taken.has(slug)) {
      slug = `${base}-${suffix}`
      suffix += 1
    }

    // Verbatim body → re-host images → sweep old-site links → inject cross-links.
    const rehosted = await rehostImages(extracted.markdown, extracted.imageUrls, slug)
    const origin = session.website_url.replace(/\/$/, '').replace(/^(?!https?:\/\/)/, 'https://')
    let body = sweepOldSiteLinks(rehosted.body, origin, indexUrls)
    body = await injectForwardLinks({
      body,
      targets,
      contentJobId: claimed.content_job_id,
      sessionId: claimed.session_id,
      pageUrl: `/resources/${slug}`,
    })

    const excerpt = (extracted.extractedMetaFromHtml || firstProse(body)).slice(0, 155)
    const date = new Date().toISOString().slice(0, 10)
    const author = activeTeam(schema)[0]?.name ?? null
    const canonicalUrl = `${origin}/resources/${slug}`

    const postMarkdown = buildPostMarkdown({
      fm: {
        title,
        excerpt,
        meta_title: title,
        meta_description: excerpt,
        target_keyword: '',
        secondary_keywords: [],
        answer_block: '',
        schema_markup: '',
        tags: [],
        image_alt: null,
      },
      body,
      slug,
      date,
      contentType: 'article',
      author,
      canonicalUrl,
      heroImage: null,
    })

    const entries: RepoEntry[] = [...rehosted.entries, { path: `content/posts/${slug}.md`, content: postMarkdown }]

    const nav = await updatedNavJson(githubRepo)
    if (nav) entries.push(nav)
    const llms = await updatedLlmsTxt(githubRepo, slug, title, excerpt)
    if (llms) entries.push(llms)
    const llmsFull = await updatedLlmsFullTxt(githubRepo, slug, title, body)
    if (llmsFull) entries.push(llmsFull)

    const { commitSha } = await pushEntriesToBranch(
      githubRepo,
      DRAFT_BRANCH,
      entries,
      `Import existing article as-is: ${title}`,
      {}
    )

    await mark(supabase, importId, {
      status: 'complete',
      slug,
      draft_path: `content/posts/${slug}.md`,
      draft_commit_sha: commitSha,
      error: null,
    })
    console.warn(`[article-import] Complete: "${title}" → content/posts/${slug}.md (${commitSha.slice(0, 7)})`)

    // Non-fatal follow-ups (draft already committed): MBP impact + reverse links.
    try {
      await reviewContentForMbpImpact({
        sessionId: claimed.session_id,
        origin: 'resource',
        sourceRef: `imported article: ${title}`,
        changedText: body,
      })
    } catch (err) {
      console.error('[mbp-impact] imported article review failed:', err)
    }

    try {
      const { entries: reverseEntries } = await insertReverseLinks({
        githubRepo,
        newPost: { slug, title, keyword: null, tags: [], excerpt, answerBlock: '' },
        contentJobId: claimed.content_job_id,
        sessionId: claimed.session_id,
      })
      if (reverseEntries.length > 0) {
        await pushEntriesToBranch(githubRepo, DRAFT_BRANCH, reverseEntries, `Add reverse links to: ${title}`, {})
      }
    } catch (err) {
      // StaleShaError: a linked post changed after it was read — skip the links
      // (the fenced commit refuses to clobber it); never fail the import.
      if (err instanceof StaleShaError) {
        console.warn(`[article-import] ${err.path} changed since it was read — skipping reverse links for ${slug}`)
      } else {
        console.warn(`[article-import] Reverse-link pass failed for ${slug} (draft already committed):`, err)
      }
    }

    return { status: 'complete', slug }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[article-import] Error on import ${importId}:`, err)
    await mark(supabase, importId, { status: 'error', error: message.slice(0, 500) })
    return { status: 'error', error: message }
  }
}
