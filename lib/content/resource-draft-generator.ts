import { generateText } from 'ai'
import { after } from 'next/server'
import { anthropic } from '@ai-sdk/anthropic'
import { createServerClient } from '@/lib/supabase/server'
import { buildBrandVoiceBlock, buildFirmContext, firmLocation, clientAvoidPhrases } from './brand-voice'
import { activeTeam } from './active-team'
import { validateContent, ANTI_SLOP_RULES, humanizeDashes } from './anti-slop-validator'
import { loadNoGoPhrases, buildNoGoPromptBlock } from './no-go-phrases'
import { WRITING_EXAMPLES } from './exemplars'
import { checkTokenBudget } from './truncate-to-token-budget'
import { recordTokenUsage } from './token-usage'
import { buildCachedMessages, extractCacheUsage } from './cache-control'
import { GENERATION_PROVIDER_OPTIONS, OUTLINE_PROVIDER_OPTIONS, PUBLISHED_CONTENT_MODEL } from './generation-tuning'
import { RESOURCE_CALL_CAP_MS, clipToDeadline, msUntil } from './generation-budget'
import { extractJson } from './extract-json'
import { deriveImageStyleSuffix } from './visual-style-derivation'
import { resolveStockPhotos, type ImageRef } from './stock-photo-resolver'
import {
  insertBodyImages,
  parseBodyImagePlacements,
  sanitizeBodyImagePlacements,
  type BodyImagePlacement,
} from './body-images'
import {
  DRAFT_BRANCH,
  ensureDraftBranch,
  pushEntriesToBranch,
  readFile,
  removeStaleStaticSitemap,
  FileNotFoundError,
  StaleShaError,
} from '@/lib/github/repo-files'
import { buildCrossLinkIndex, type InternalLinkTarget } from './internal-link-targets'
import { buildPostMarkdown } from './post-markdown'
import { stripGeneratorNotesFromBody } from './strip-generator-notes'
import { insertReverseLinks } from './reverse-linker'
import { asJson } from '@/lib/supabase/json-typed'
import { generateSocialJson, buildSocialMarkdown, socialPathForSlug } from './social-generator'
import { reviewContentForMbpImpact } from '@/lib/mbp/impact-review'
import { reviewResourceDraft } from './draft-critic'
import { OFF_BRAND_MARKER } from './brand-fit'
import { parseNavJson, serializeNavJson } from '@/lib/editor/nav-config'
import { DEFAULT_BLOG_CONFIG, resolveBlogConfig } from '@/lib/content/blog-config'
import {
  CONTENT_TYPES,
  asContentType,
  buildFormatRules,
  hasCaseStudyData,
  type ContentType,
} from './content-types'
import type { NavJson } from '@/types/nav-json'
import type { SessionSchema } from '@/types/session-schema'
import type { PaletteData } from '@/types/palette'
import type { ExternalLink } from './link-checker'
import { arr } from './schema-coerce'

const DRAFT_MODEL = PUBLISHED_CONTENT_MODEL

// Time budget for one draft. The whole pipeline (draft call, JSON retry,
// anti-slop regeneration, social, commit, status write) must fit before
// `deadlineAt`, or the function is killed with the idea claimed 'running'.
// Model work stops POST_MODEL_RESERVE_MS early so the commit + status write
// (or the error write that releases the claim) always happen.
const POST_MODEL_RESERVE_MS = 30_000
// Don't start the first draft call with less than this (a cut-short Sonnet call
// burns tokens and ends in an error anyway).
const MIN_DRAFT_CALL_MS = 45_000
// Optional steps only start with enough time left to finish them.
const MIN_JSON_RETRY_MS = 60_000
const MIN_ANTI_SLOP_REGEN_MS = 150_000 // a full regeneration = draft + possible JSON retry
const MIN_SOCIAL_MS = 45_000
// In-body photos are optional; with less than this left (of the model
// deadline) only the hero is resolved, so the header image is never the one cut.
const MIN_BODY_IMAGES_MS = 60_000
const MIN_AFTER_COMMIT_STEP_MS = 30_000 // MBP impact review / reverse links
// Default budget for callers that don't pass a deadline.
export const RESOURCE_DRAFT_DEFAULT_BUDGET_MS = 240_000
// Runners (blog batch, library) don't START a draft with less than this left:
// room for the first draft call plus a JSON retry or social, and the commit.
// Anything that still doesn't fit is skipped by the deadline checks above, so
// the draft always ends in a written outcome instead of a killed function.
export const RESOURCE_DRAFT_MIN_VIABLE_MS = 240_000

/** Is there time left to start a step that needs `minMs`? Pure for tests. */
export function canStartDraftStep(deadlineAt: number, minMs: number, now: number = Date.now()): boolean {
  return msUntil(deadlineAt, now) >= minMs
}

type DraftFrontmatter = {
  title: string
  excerpt: string
  meta_title: string
  meta_description: string
  target_keyword: string
  secondary_keywords: string[]
  answer_block: string
  schema_markup: string
  tags: string[]
  hero_image: string | null
  hero_image_query: string | null
  image_alt: string | null
  // 0-2 in-body photo placements (shape-checked only; sanitized before use).
  body_images: BodyImagePlacement[]
}

type DraftResult = { body: string; frontmatter: DraftFrontmatter }

function kebabSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
}

// Admin writer-notes block. The OFF_BRAND_MARKER first line means the admin
// confirmed a divergence from the documented brand voice for this post.
function buildNotesBlock(notes: string): string {
  if (notes.startsWith(OFF_BRAND_MARKER)) {
    const rest = notes.slice(OFF_BRAND_MARKER.length).trim()
    return `ADMIN NOTES FOR THIS POST (follow these; they take precedence over the angle — the admin explicitly approved this direction even where it diverges from the brand voice below; keep factual rigor and the anti-slop rules):
${rest}`
  }
  return `ADMIN NOTES FOR THIS POST (follow these; they take precedence over the angle):
${notes}`
}

async function generateDraftContent(args: {
  idea: { title: string; angle: string | null; target_keyword: string | null; rationale: string | null }
  contentType: ContentType
  notes: string | null
  secondaryKeywords: string[]
  externalLinks: ExternalLink[]
  internalTargets: InternalLinkTarget[]
  schema: SessionSchema
  contentJobId: string
  sessionId: string
  flaggedPhrases?: string[]
  // Absolute deadline (epoch ms) for model work; every call is clipped to it.
  deadlineAt: number
}): Promise<DraftResult | null> {
  const { idea, schema, contentType } = args
  const firmName = schema.business?.name ?? 'the firm'
  const location = firmLocation(schema)
  const typeSpec = CONTENT_TYPES[contentType]
  const noGoBlock = buildNoGoPromptBlock((await loadNoGoPhrases()).map(p => p.phrase))

  const retryNote = args.flaggedPhrases?.length
    ? `\n\nIMPORTANT: A previous draft was flagged for these issues — fix all of them: ${args.flaggedPhrases.join(' | ')}`
    : ''

  const externalBlock = args.externalLinks.length
    ? `APPROVED EXTERNAL SOURCES — you may cite ONLY these URLs, verbatim, as markdown links. Do not invent, modify, or cite any other external URL. If none fit a claim, cite none:\n${args.externalLinks.map((l) => `- ${l.url}${l.title ? ` — ${l.title}` : ''}`).join('\n')}`
    : 'EXTERNAL SOURCES: none approved — do NOT include any external URL in the body.'

  // Static, client-constant prefix (brand voice, firm context, format + output
  // rules, anti-slop). Cache breakpoint via buildCachedMessages so every post in
  // a client's batch — and the anti-slop retry of a single post — reuses it as a
  // cache read. The per-post task lives in dynamicSuffix below; keep every
  // per-idea value OUT of this string.
  const staticPrefix = `You are writing a ${typeSpec.articleNoun} for the Resources section of ${firmName}, a CPA firm in ${location}.

${buildBrandVoiceBlock(schema)}

${buildFirmContext(schema)}

${buildFormatRules(contentType, location)}

OUTPUT: Return a JSON object:
{
  "body": "the full post markdown: reader-facing prose ONLY. Never append metadata sections (Answer Block, E-E-A-T Signals, Internal Links, FAQ Block, LLM Citation Note, SEO notes, structured data); those go in frontmatter",
  "frontmatter": {
    "title": "final post title (may refine the working title)",
    "excerpt": "1-2 sentence listing-card excerpt",
    "meta_title": "50-60 chars, contains primary keyword",
    "meta_description": "150-160 chars, compelling + keyword",
    "target_keyword": "...",
    "secondary_keywords": ["..."],
    "answer_block": "2-3 sentences answering the post's core question directly",
    "schema_markup": "BlogPosting" | "Article" | "FAQPage",
    "tags": ["2-4 short topic tags"],
    "hero_image": "kebab-case-filename.jpg — ALWAYS provide one; every post gets a header image",
    "hero_image_query": "3-8 word SUBJECT-only Pexels query (people, setting, activity — no style words) — ALWAYS provide one",
    "image_alt": "descriptive alt text for the hero image",
    "body_images": [{ "after_heading": "exact text of one H2 in the body", "filename": "kebab-case-filename.jpg", "query": "3-8 word SUBJECT-only Pexels query", "alt": "descriptive alt text" }]
  }
}

BODY IMAGES: "body_images" is optional, 0-2 items. Add one only where a photo shows what a specific H2 section is about (a setting, document or activity it describes), never as decoration. Pick an H2 whose section opens with a plain paragraph. Never reuse the hero image's subject or repeat a subject. Do not write image markdown in the body; the server places the images.

${ANTI_SLOP_RULES}

${WRITING_EXAMPLES}${noGoBlock ? `\n\n${noGoBlock}` : ''}`

  // Per-post dynamic suffix — everything that varies per idea. retryNote stays
  // here (not in the prefix) so the first attempt and the anti-slop retry share
  // an identical cached prefix and the retry lands as a cache read.
  const dynamicSuffix = `POST TO WRITE:
Title: ${idea.title}
Angle: ${idea.angle ?? ''}
Why it fits: ${idea.rationale ?? ''}

${args.notes ? buildNotesBlock(args.notes) : ''}

KEYWORD TARGET:
Primary: ${idea.target_keyword ?? idea.title.toLowerCase()}
Secondary: ${args.secondaryKeywords.join(', ')}

${externalBlock}

INTERNAL LINK TARGETS — link to these site pages and existing posts where genuinely relevant (site-relative markdown links, natural anchor text drawn from the topic, 2-4 links total, never force one). Pick targets whose subject actually overlaps what you're writing:
${args.internalTargets
  .map((t) => {
    const kw = t.keyword ? ` — keyword: ${t.keyword}` : ''
    const about = t.about ? ` — about: ${t.about}` : ''
    return `- ${t.url} — "${t.title}"${kw}${about}`
  })
  .join('\n') || '- (none yet)'}${retryNote}`

  // One generation attempt: call the model, record usage, and parse the JSON
  // answer via extractJson (tolerates fences/prose, throws on truncation).
  // Returns the parsed draft or { ok:false } carrying finishReason so the caller
  // can retry. Mirrors the page-body generator's attempt/retry contract.
  const attempt = async (
    maxOutputTokens: number,
    providerOptions: Parameters<typeof generateText>[0]['providerOptions']
  ): Promise<{ ok: true; result: DraftResult } | { ok: false; finishReason: string }> => {
    const callStartedAt = Date.now()
    const { text, usage, finishReason } = await generateText({
      model: anthropic(DRAFT_MODEL),
      // 1h TTL: batch drafts are spread across 5-min cron ticks, and ~17% of
      // calls landed 5-60 min after the previous one — a guaranteed 5m-cache miss.
      messages: buildCachedMessages(staticPrefix, dynamicSuffix, '1h'),
      maxOutputTokens,
      providerOptions,
      // Ride out transient overload/rate-limit (529/429) on big 4-firm batches
      // with the SDK's built-in exponential backoff instead of failing the draft.
      maxRetries: 4,
      // Hard ceiling, bounding the maxRetries backoff above too. Without it a
      // stalled draft consumed the whole function and left its selection row
      // claimed as 'drafting' with nobody working on it.
      // Also clipped to the draft's deadline so it can't outlive the invocation.
      abortSignal: AbortSignal.timeout(clipToDeadline(args.deadlineAt, RESOURCE_CALL_CAP_MS)),
    })

    const cache = extractCacheUsage(usage)
    console.warn(
      `[resource-draft] idea="${idea.title}" input=${usage?.inputTokens ?? '?'} output=${usage?.outputTokens ?? '?'} cacheRead=${cache.cacheReadInputTokens} cacheWrite=${cache.cacheCreationInputTokens} finish=${finishReason} elapsedMs=${Date.now() - callStartedAt}`
    )
    checkTokenBudget('resource-draft', idea.title, usage?.inputTokens, 5000)
    await recordTokenUsage({
      task: 'content',
      contentJobId: args.contentJobId,
      sessionId: args.sessionId,
      stage: 'resource',
      pageUrl: kebabSlug(idea.title),
      model: DRAFT_MODEL,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cacheReadInputTokens: cache.cacheReadInputTokens,
      cacheCreationInputTokens: cache.cacheCreationInputTokens,
      cacheTtl: '1h',
    })

    try {
      const parsed = extractJson(text) as {
        body?: string
        frontmatter?: Record<string, unknown> & { title?: string }
      }
      if (!parsed?.body || !parsed?.frontmatter?.title) return { ok: false, finishReason }
      const fm = parsed.frontmatter
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
      return {
        ok: true,
        result: {
          body: parsed.body,
          frontmatter: {
            title: String(fm.title),
            excerpt: typeof fm.excerpt === 'string' ? fm.excerpt : '',
            meta_title: typeof fm.meta_title === 'string' ? fm.meta_title : String(fm.title),
            meta_description: typeof fm.meta_description === 'string' ? fm.meta_description : '',
            target_keyword:
              typeof fm.target_keyword === 'string' ? fm.target_keyword : idea.target_keyword ?? '',
            secondary_keywords: Array.isArray(fm.secondary_keywords) ? (fm.secondary_keywords as string[]) : [],
            answer_block: typeof fm.answer_block === 'string' ? fm.answer_block : '',
            schema_markup:
              typeof fm.schema_markup === 'string' ? fm.schema_markup : typeSpec.defaultSchemaMarkup,
            tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
            hero_image: str(fm.hero_image),
            hero_image_query: str(fm.hero_image_query),
            image_alt: str(fm.image_alt),
            body_images: parseBodyImagePlacements(fm.body_images),
          },
        },
      }
    } catch {
      return { ok: false, finishReason }
    }
  }

  // First pass: generous budget so adaptive thinking + the full article JSON both
  // fit. A parse failure (usually a `length` finish = truncated JSON) retries once
  // with a bigger budget and low effort — less thinking leaves more room for the
  // answer. This mirrors the page-body generator and turns the old intermittent
  // "Draft generation returned unparseable output" error into a transparent
  // self-heal, so an operator no longer has to click retry.
  let res = await attempt(24000, GENERATION_PROVIDER_OPTIONS)
  if (!res.ok && canStartDraftStep(args.deadlineAt, MIN_JSON_RETRY_MS)) {
    console.warn(
      `[resource-draft] JSON parse failed for "${idea.title}" (finish=${res.finishReason}) — retrying with larger budget`
    )
    res = await attempt(32000, OUTLINE_PROVIDER_OPTIONS)
  } else if (!res.ok) {
    console.warn(`[resource-draft] JSON parse failed for "${idea.title}" and no time is left for a retry`)
  }
  if (res.ok) return res.result
  console.error(
    `[resource-draft] Failed to parse JSON for "${idea.title}" after retry (finish=${res.finishReason})`
  )
  return null
}

// Citation guard: strip any absolute URL that isn't in the approved list.
// The link itself is removed but its anchor text is preserved, so a stray
// hallucinated citation degrades to plain prose instead of a dead link.
function stripUnapprovedExternalLinks(body: string, approved: ExternalLink[]): string {
  const allowed = new Set(approved.map((l) => l.url.replace(/\/$/, '')))
  return body.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (full, anchor: string, url: string) => {
    if (allowed.has(url.replace(/\/$/, ''))) return full
    console.warn(`[resource-draft] Stripped unapproved external URL: ${url}`)
    return anchor
  })
}

// Self-register the blog/resources section in the site nav the first time a
// post is drafted. Packaged repos ship a nav.json built from the page sitemap,
// so the section isn't there until a post exists to justify it. The section's
// label + path come from content/blog.json (Resources defaults when absent), so
// a client who renamed it to Insights/News gets the right nav entry. No-op when
// any top-level entry already points at the blog path (admins may have customized).
export async function updatedNavJson(githubRepo: string): Promise<{ path: string; content: string } | null> {
  let raw: string
  try {
    const blob = await readFile(githubRepo, 'content/nav.json', DRAFT_BRANCH)
    raw = blob.content
  } catch (err) {
    if (!(err instanceof FileNotFoundError)) {
      console.warn('[resource-draft] nav.json read failed:', err)
    }
    return null
  }
  let nav: NavJson
  try {
    nav = parseNavJson(raw)
  } catch (err) {
    console.warn('[resource-draft] nav.json unparseable, leaving as-is:', err)
    return null
  }

  let blog = DEFAULT_BLOG_CONFIG
  try {
    const blob = await readFile(githubRepo, 'content/blog.json', DRAFT_BRANCH)
    blog = resolveBlogConfig(JSON.parse(blob.content))
  } catch (err) {
    if (!(err instanceof FileNotFoundError)) {
      console.warn('[resource-draft] blog.json read/parse failed, using Resources defaults:', err)
    }
  }

  const blogPath = blog.path.replace(/\/$/, '')
  if (nav.primary.some((item) => item.url.replace(/\/$/, '') === blogPath)) return null

  const entry = { label: blog.label, url: blog.path }
  const contactIdx = nav.primary.findIndex((item) => item.url.replace(/\/$/, '') === '/contact')
  if (contactIdx >= 0) {
    nav.primary.splice(contactIdx, 0, entry)
  } else {
    nav.primary.push(entry)
  }
  return { path: 'content/nav.json', content: serializeNavJson(nav) }
}

// Append (or update) this post's entry in the static public/llms.txt that
// packaging pushed to the repo. The template serves it as a static file, so
// drafting is the only moment posts can self-register. Missing file → skip.
export async function updatedLlmsTxt(
  githubRepo: string,
  slug: string,
  title: string,
  description: string
): Promise<{ path: string; content: string } | null> {
  let existing: string
  try {
    const blob = await readFile(githubRepo, 'public/llms.txt', DRAFT_BRANCH)
    existing = blob.content
  } catch (err) {
    if (err instanceof FileNotFoundError) return null
    console.warn('[resource-draft] llms.txt read failed:', err)
    return null
  }

  const entry = `- [${title}](/resources/${slug}): ${description.slice(0, 80)}`
  if (existing.includes(`(/resources/${slug})`)) return null

  let next: string
  if (/^## Resources$/m.test(existing)) {
    next = existing.replace(/^## Resources$/m, `## Resources\n\n${entry}`).replace(/\n{3,}/g, '\n\n')
  } else {
    next = `${existing.trimEnd()}\n\n## Resources\n\n${entry}\n`
  }
  return { path: 'public/llms.txt', content: next }
}

// Append this post's full content to public/llms-full.txt, mirroring the
// per-section format buildLlmsFullTxt() uses (### title, URL, body, rule).
// Like updatedLlmsTxt: missing file → skip, already-present slug → skip.
export async function updatedLlmsFullTxt(
  githubRepo: string,
  slug: string,
  title: string,
  body: string
): Promise<{ path: string; content: string } | null> {
  let existing: string
  try {
    const blob = await readFile(githubRepo, 'public/llms-full.txt', DRAFT_BRANCH)
    existing = blob.content
  } catch (err) {
    if (err instanceof FileNotFoundError) return null
    console.warn('[resource-draft] llms-full.txt read failed:', err)
    return null
  }

  if (existing.includes(`URL: /resources/${slug}\n`)) return null

  const entry = `\n### ${title}\nURL: /resources/${slug}\n\n${body.trim()}\n\n---\n`
  let next: string
  if (/^## Resources$/m.test(existing)) {
    next = existing.replace(/^## Resources$/m, `## Resources\n${entry}`)
  } else {
    next = `${existing.trimEnd()}\n\n## Resources\n${entry}`
  }
  return { path: 'public/llms-full.txt', content: next }
}

function normalizeLinkPath(url: string): string {
  const noTrailing = url.replace(/\/+$/, '')
  return noTrailing === '' ? '/' : noTrailing
}

// Warn-only: surface site-relative links in a freshly drafted post body that
// don't resolve to a known page or post. link-validator.validateInternalLinks
// deliberately skips /resources/* (posts live outside the confirmed sitemap),
// so posts get no link check there — this fills that gap without blocking.
const POST_BODY_LINK_RE = /\[[^\]]*\]\((\/[^)\s#?]*)/g
const POST_LINK_ASSET_RE = /\.(png|jpe?g|webp|gif|svg|pdf|docx?|xlsx?|zip|xml|txt|ico)$/i

function warnUnknownInternalLinks(
  body: string,
  slug: string,
  targets: InternalLinkTarget[],
  postSlugs: string[]
): void {
  const known = new Set<string>(['/'])
  for (const t of targets) known.add(normalizeLinkPath(t.url))
  for (const s of postSlugs) known.add(`/resources/${s}`)
  known.add(`/resources/${slug}`)

  const seen = new Set<string>()
  for (const match of body.matchAll(POST_BODY_LINK_RE)) {
    const target = normalizeLinkPath(match[1])
    if (POST_LINK_ASSET_RE.test(target) || known.has(target) || seen.has(target)) continue
    seen.add(target)
    console.warn(`[resource-draft] /resources/${slug} links to ${target} which is not a known page or post`)
  }
}

// Slug for a (re)draft. A re-draft reuses the idea's existing slug — the
// cross-link index already contains that slug (it's this idea's own post), so
// treating it as "taken" minted `slug-2` and left a duplicate post behind. Only
// OTHER posts' slugs count as collisions.
export function pickPostSlug(args: {
  title: string
  ideaId: string
  existingSlug: string | null
  takenSlugs: Iterable<string>
}): string {
  const taken = new Set(args.takenSlugs)
  if (args.existingSlug) return args.existingSlug
  const base = kebabSlug(args.title) || `post-${args.ideaId.slice(0, 8)}`
  let slug = base
  let suffix = 2
  while (taken.has(slug)) {
    slug = `${base}-${suffix}`
    suffix += 1
  }
  return slug
}

// Persist a NEW idea's slug before anything is committed. The slug used to be
// saved only in the final 'complete' write, after the commit: if that write
// failed (or the function died in between), the retry saw no slug, found its own
// just-committed post in the cross-link index as "taken", and minted `<slug>-2`
// — a second copy of the article. Reserving it first makes the retry reuse it
// (pickPostSlug returns existingSlug) and overwrite its own file. Fenced on
// `slug IS NULL`; if another worker reserved one first, that slug wins.
export async function reserveIdeaSlug(
  supabase: ReturnType<typeof createServerClient>,
  ideaId: string,
  slug: string
): Promise<string> {
  const { data, error } = await supabase
    .from('resource_ideas')
    .update({ slug, updated_at: new Date().toISOString() })
    .eq('id', ideaId)
    .is('slug', null)
    .select('slug')
  if (error) {
    console.error(`[resource-draft] Slug reservation failed for idea ${ideaId}:`, error.message)
    throw new Error('Could not reserve the post slug — will retry')
  }
  if (data?.length) return slug
  const { data: row } = await supabase.from('resource_ideas').select('slug').eq('id', ideaId).single()
  if (row?.slug) return row.slug
  throw new Error('Could not reserve the post slug — will retry')
}

export async function generateResourceDraft(
  ideaId: string,
  // `force` re-drafts an idea whose draft already completed (an explicit
  // operator "Re-draft"). Without it a `complete` idea is never re-claimed —
  // background runners (batch / library) re-entering on a finished idea skip.
  // `deadlineAt` (epoch ms) is when this draft must be finished — the caller's
  // invocation budget. Defaults to RESOURCE_DRAFT_DEFAULT_BUDGET_MS from now.
  opts?: { force?: boolean; deadlineAt?: number }
): Promise<{ status: 'complete' | 'error' | 'skipped'; slug?: string; error?: string }> {
  const supabase = createServerClient()
  const deadlineAt = opts?.deadlineAt ?? Date.now() + RESOURCE_DRAFT_DEFAULT_BUDGET_MS
  const modelDeadline = deadlineAt - POST_MODEL_RESERVE_MS

  const { data: idea } = await supabase
    .from('resource_ideas')
    .select('id, content_job_id, session_id, title, angle, target_keyword, secondary_keywords, rationale, external_links, status, draft_notes, content_type, slug')
    .eq('id', ideaId)
    .single()
  if (!idea) return { status: 'error', error: 'Idea not found' }
  if (idea.status === 'dismissed') return { status: 'error', error: 'Idea is dismissed' }
  const contentType = asContentType(idea.content_type)

  const { data: job } = await supabase
    .from('content_jobs')
    .select('github_repo, palette')
    .eq('id', idea.content_job_id)
    .single()
  if (!job?.github_repo) return { status: 'error', error: 'Repo not linked' }

  const { data: session } = await supabase
    .from('sessions')
    .select('website_url, schema_data')
    .eq('id', idea.session_id)
    .single()
  if (!session) return { status: 'error', error: 'Session not found' }

  // Atomic lock — same pattern as generated_pages.generation_status. A second
  // caller racing on the same idea gets zero rows back and skips.
  // A `complete` idea is only re-claimed on an explicit force (operator
  // re-draft); otherwise a runner re-entering on a finished idea would redraft it.
  let lockQuery = supabase
    .from('resource_ideas')
    .update({ draft_status: 'running', updated_at: new Date().toISOString() })
    .eq('id', ideaId)
    .neq('draft_status', 'running')
  if (!opts?.force) lockQuery = lockQuery.neq('draft_status', 'complete')
  const { data: locked } = await lockQuery.select('id')
  if (!locked?.length) {
    return { status: 'skipped', error: 'Another worker is already drafting this idea, or it is already drafted' }
  }

  const schema = (session.schema_data ?? {}) as SessionSchema

  // Everything after the lock runs inside the try so ANY throw (a dirty schema
  // field in the case-study gate, a malformed JSON column) lands in the catch
  // and releases the lock as 'error' instead of stranding the idea 'running'.
  try {
    if (!canStartDraftStep(modelDeadline, MIN_DRAFT_CALL_MS)) {
      throw new Error('Not enough time left in this run to draft the article — it will be retried')
    }
    const externalLinks = arr(idea.external_links as ExternalLink[] | null)
    const secondaryKeywords = arr(idea.secondary_keywords as string[] | null)

    // Case-study data gate (backstop; the draft API route gates first for instant
    // UI feedback, but batch runs reach this path directly). A case study without
    // a real client story to ground it must fail rather than fabricate one.
    if (CONTENT_TYPES[contentType].requiresCaseData && !hasCaseStudyData(schema, idea.draft_notes)) {
      const message =
        'Case study needs client details — add a client success story to the MBP, or provide the client, challenge, actions, and results in the draft notes.'
      await supabase
        .from('resource_ideas')
        .update({ draft_status: 'error', draft_error: message, updated_at: new Date().toISOString() })
        .eq('id', ideaId)
      return { status: 'error', error: message }
    }

    await ensureDraftBranch(job.github_repo)
    // Self-heal: drop a stale static sitemap a prior package left behind so the
    // template's dynamic route (which includes this new post) takes over.
    try {
      await removeStaleStaticSitemap(job.github_repo, DRAFT_BRANCH)
    } catch (err) {
      console.warn(`[resource-draft] Stale sitemap cleanup failed for ${job.github_repo}:`, err)
    }
    // Cross-link index: draft (within-batch) ∪ main (already-published), so a new
    // post links back to the client's live corpus, not just this batch's drafts.
    const { targets, postSlugs } = await buildCrossLinkIndex(job.github_repo)

    // Slug: reuse this idea's slug on a re-draft (overwrite its own post);
    // otherwise derive from the title and dodge OTHER posts' slugs.
    const picked = pickPostSlug({
      title: idea.title,
      ideaId,
      existingSlug: idea.slug,
      takenSlugs: postSlugs,
    })
    const slug = idea.slug ? picked : await reserveIdeaSlug(supabase, ideaId, picked)

    let result = await generateDraftContent({
      idea,
      contentType,
      notes: idea.draft_notes,
      secondaryKeywords,
      externalLinks,
      internalTargets: targets,
      schema,
      contentJobId: idea.content_job_id,
      sessionId: idea.session_id,
      deadlineAt: modelDeadline,
    })
    if (!result) throw new Error('Draft generation returned unparseable output')
    // Posts render their body verbatim: cut any echoed generator notes BEFORE
    // validating, so they never cost a regeneration. The validator still flags
    // notes the strip refused to cut (content after them).
    result.body = stripGeneratorNotesFromBody(result.body).body

    const noGoPhrases = (await loadNoGoPhrases()).map(p => p.phrase)
    const validation = validateContent(result.body, [...noGoPhrases, ...clientAvoidPhrases(schema)])
    if (!validation.passed && !canStartDraftStep(modelDeadline, MIN_ANTI_SLOP_REGEN_MS)) {
      console.warn(
        `[resource-draft] Anti-slop flagged "${idea.title}": ${validation.flagged.join(' | ')} — no time left to regenerate, keeping the first draft`
      )
    } else if (!validation.passed) {
      console.warn(
        `[resource-draft] Anti-slop flagged "${idea.title}": ${validation.flagged.join(' | ')} — retrying`
      )
      const retry = await generateDraftContent({
        idea,
        contentType,
        notes: idea.draft_notes,
        secondaryKeywords,
        externalLinks,
        internalTargets: targets,
        schema,
        contentJobId: idea.content_job_id,
        sessionId: idea.session_id,
        flaggedPhrases: validation.flagged,
        deadlineAt: modelDeadline,
      })
      if (retry) result = { ...retry, body: stripGeneratorNotesFromBody(retry.body).body }
    }

    result.body = stripUnapprovedExternalLinks(result.body, externalLinks)
    result.body = humanizeDashes(result.body)
    warnUnknownInternalLinks(result.body, slug, targets, postSlugs)

    // Strip AI dash-tells from the visible frontmatter prose too (the body is
    // handled above). Keywords, tags, filenames, and JSON-LD schema markup are
    // left untouched.
    const rfm = result.frontmatter
    rfm.title = humanizeDashes(rfm.title)
    rfm.excerpt = humanizeDashes(rfm.excerpt)
    rfm.meta_title = humanizeDashes(rfm.meta_title)
    rfm.meta_description = humanizeDashes(rfm.meta_description)
    rfm.answer_block = humanizeDashes(rfm.answer_block)
    if (rfm.image_alt) rfm.image_alt = humanizeDashes(rfm.image_alt)
    rfm.body_images = rfm.body_images.map((p) => ({ ...p, alt: humanizeDashes(p.alt) }))

    // Hero image via Pexels — non-fatal. Resolution persists an assets row +
    // storage object; we then download the bytes to push into the repo commit.
    const entries: Array<{ path: string; content: string | Buffer }> = []
    let heroImage: string | null = null
    const fm = result.frontmatter
    // Every post gets a header image: synthesize a ref when Claude omits one.
    if (!fm.hero_image || !fm.hero_image_query) {
      fm.hero_image = `${slug.slice(0, 48).replace(/-+$/, '')}-header.jpg`
      fm.hero_image_query = (idea.target_keyword ?? idea.title)
        .replace(/[^a-zA-Z0-9 ]+/g, ' ')
        .split(/\s+/)
        .slice(0, 6)
        .join(' ')
    }
    // In-body photos (0-2): sanitized, then dry-run placed so only placements
    // that will actually land get a Pexels lookup. Optional: skipped (never the
    // hero) when the run is short on time.
    let bodyPlacements: BodyImagePlacement[] = []
    if (fm.body_images.length > 0) {
      if (canStartDraftStep(modelDeadline, MIN_BODY_IMAGES_MS)) {
        const clean = sanitizeBodyImagePlacements(fm.body_images, fm.hero_image)
        bodyPlacements = insertBodyImages(result.body, clean, { heroFilename: fm.hero_image }).inserted
      } else {
        console.warn(`[resource-draft] Skipping body images for ${slug} — not enough time left in this run`)
      }
    }
    // The committed body. result.body stays the prose-only draft, which is what
    // the llms-full.txt index, MBP impact review and critic read.
    let postBody = result.body
    if (fm.hero_image && fm.hero_image_query) {
      const palette = (job.palette ?? null) as PaletteData | null
      const styleSuffix = deriveImageStyleSuffix(palette, schema.brand)
      const { data: existingAssets } = await supabase
        .from('assets')
        .select('file_name, asset_category, metadata')
        .eq('session_id', idea.session_id)
      const pageUrl = `/resources/${slug}`
      const imageRefs: ImageRef[] = [
        { pageUrl, filename: fm.hero_image, subjectQuery: fm.hero_image_query, source: 'hero' },
        ...bodyPlacements.map((p) => ({ pageUrl, filename: p.filename, subjectQuery: p.query, source: 'body' })),
      ]
      const resolved = await resolveStockPhotos(
        {
          sessionId: idea.session_id,
          apiKey: process.env.PEXELS_API_KEY ?? '',
          styleSuffix,
          existingAssets: existingAssets ?? [],
          imageRefs,
        },
        supabase
      )
      const resolvedNames = new Set(resolved.map((r) => r.filename))
      // Bytes for one resolved image, or null (logged by the caller).
      const downloadAsset = async (filename: string): Promise<Buffer | null> => {
        const { data: bytes, error: dlErr } = await supabase.storage
          .from('session-assets')
          .download(`sessions/${idea.session_id}/${filename}`)
        if (!bytes || dlErr) return null
        return Buffer.from(await bytes.arrayBuffer())
      }
      const heroFile = fm.hero_image
      const [heroBytes, ...bodyBytes] = await Promise.all([
        resolvedNames.has(heroFile) ? downloadAsset(heroFile) : Promise.resolve(null),
        ...bodyPlacements.map((p) =>
          resolvedNames.has(p.filename) ? downloadAsset(p.filename).catch(() => null) : Promise.resolve(null)
        ),
      ])
      if (heroBytes) {
        entries.push({ path: `public/content-assets/${heroFile}`, content: heroBytes })
        heroImage = heroFile
      } else if (resolvedNames.has(heroFile)) {
        console.warn(`[resource-draft] Hero download failed for ${heroFile}`)
      }
      // Only images that resolved AND downloaded are placed and committed.
      const ready = bodyPlacements.filter((_, i) => bodyBytes[i])
      if (ready.length < bodyPlacements.length) {
        const dropped = bodyPlacements.filter((_, i) => !bodyBytes[i]).map((p) => p.filename)
        console.warn(`[resource-draft] Dropped body image(s) for ${slug} (not resolved or downloaded): ${dropped.join(', ')}`)
      }
      if (ready.length > 0) {
        bodyPlacements.forEach((p, i) => {
          const content = bodyBytes[i]
          if (content) entries.push({ path: `public/content-assets/${p.filename}`, content })
        })
        postBody = insertBodyImages(result.body, ready, { heroFilename: heroFile }).body
      }
    }

    const date = new Date().toISOString().slice(0, 10)
    const author = activeTeam(schema)[0]?.name ?? null
    const origin = session.website_url.replace(/\/$/, '').replace(/^(?!https?:\/\/)/, 'https://')
    const canonicalUrl = `${origin}/resources/${slug}`

    const postMarkdown = buildPostMarkdown({
      fm,
      body: postBody,
      slug,
      date,
      contentType,
      author,
      canonicalUrl,
      heroImage,
    })
    entries.push({ path: `content/posts/${slug}.md`, content: postMarkdown })

    const llms = await updatedLlmsTxt(job.github_repo, slug, fm.title, fm.meta_description || fm.excerpt)
    if (llms) entries.push(llms)

    const llmsFull = await updatedLlmsFullTxt(job.github_repo, slug, fm.title, result.body)
    if (llmsFull) entries.push(llmsFull)

    const nav = await updatedNavJson(job.github_repo)
    if (nav) entries.push(nav)

    // Social suggestions ride in the same atomic commit. Non-fatal: a parse
    // failure just means the admin backfills via the panel's button.
    let socialPath: string | null = null
    try {
      if (!canStartDraftStep(modelDeadline, MIN_SOCIAL_MS)) {
        throw new Error('no time left in this run (backfill from the Resources panel)')
      }
      const social = await generateSocialJson({
        schema,
        title: fm.title,
        excerpt: fm.excerpt,
        answerBlock: fm.answer_block,
        body: result.body,
        canonicalUrl,
        contentJobId: idea.content_job_id,
        sessionId: idea.session_id,
        slug,
        deadlineAt: modelDeadline,
      })
      if (social) {
        socialPath = socialPathForSlug(slug)
        entries.push({
          path: socialPath,
          content: buildSocialMarkdown({ title: fm.title, slug, social }),
        })
      }
    } catch (err) {
      console.warn(`[resource-draft] Social generation failed for ${slug}:`, err)
    }

    const { commitSha } = await pushEntriesToBranch(
      job.github_repo,
      DRAFT_BRANCH,
      entries,
      `Draft resource post: ${fm.title}`,
      {}
    )

    const { error: completeErr } = await supabase
      .from('resource_ideas')
      .update({
        status: 'drafted',
        draft_status: 'complete',
        slug,
        draft_path: `content/posts/${slug}.md`,
        draft_commit_sha: commitSha,
        draft_error: null,
        social_path: socialPath,
        // Clear any prior run's audit so a re-draft starts from a clean slate;
        // the reverse-link pass below repopulates it for the current slug.
        reverse_links: asJson([]),
        updated_at: new Date().toISOString(),
      })
      .eq('id', ideaId)
    // The commit landed but the row didn't record it — throw so the catch marks
    // the idea 'error' (retriable) rather than leaving it 'running' forever.
    if (completeErr) throw new Error(`Draft committed (${commitSha.slice(0, 7)}) but status write failed: ${completeErr.message}`)

    console.warn(`[resource-draft] Complete: "${fm.title}" → content/posts/${slug}.md (${commitSha.slice(0, 7)})`)

    // The generated post body is genuinely new prose that may surface a service,
    // office, or positioning shift worth reflecting in the MBP. Non-fatal: a
    // review failure must never regress the already-published draft.
    try {
      if (canStartDraftStep(deadlineAt, MIN_AFTER_COMMIT_STEP_MS)) {
        await reviewContentForMbpImpact({
          sessionId: idea.session_id,
          origin: 'resource',
          sourceRef: `resource post: ${fm.title}`,
          changedText: result.body,
          timeoutMs: clipToDeadline(deadlineAt, 110_000),
        })
      } else {
        console.warn(`[mbp-impact] Skipped for "${fm.title}" — no time left in this run`)
      }
    } catch (err) {
      console.error('[mbp-impact] resource draft review failed:', err)
    }

    // Advisory draft-gate critic: grade the finished post so a weak draft surfaces
    // in the batch UI ("complete · N flagged") instead of shipping silently. The
    // idea (title/angle/rationale) is the "promise" it's graded against. Scheduled
    // in the background (after()) so its Sonnet call never sits on the batch's
    // critical path (50 inline critic calls would eat the runner's soft deadline).
    // Non-fatal + failure-isolated: a scoring error can't regress the published
    // draft. The scheduling is wrapped so a no-request-scope context (where after()
    // throws) degrades to skipping the critic rather than failing the draft.
    try {
      after(() =>
        reviewResourceDraft({
          pageId: idea.id,
          pageUrl: slug,
          pageTitle: fm.title,
          contentMarkdown: result.body,
          outlineSections: asJson({ title: idea.title, angle: idea.angle, rationale: idea.rationale }),
          targetKeyword: fm.target_keyword || idea.target_keyword || '',
          competitorRefs: [],
          schema,
          sessionId: idea.session_id,
          contentJobId: idea.content_job_id,
        }, deadlineAt).catch((err) => console.error('[resource-critic] review failed:', err)),
      )
    } catch (hookErr) {
      console.warn('[resource-critic] could not schedule review:', hookErr)
    }

    // Reverse-link pass: link the most relevant existing posts back to the
    // new one, as a second commit on the same draft branch (one reviewable
    // diff). Runs AFTER the row is marked complete, by design: the draft is
    // already published, so this is failure-isolated — a thrown error (incl. a
    // GitHub fast-forward conflict if a re-trigger raced us) is swallowed below
    // and never regresses the published draft. Trade-off: it runs outside the
    // draft_status lock, so a concurrent re-draft could double-run; worst case
    // is a duplicate/missing back-link, not corruption.
    // Lifecycle note: links point at a post we just created, so they're valid
    // at insertion. If that post is later deleted manually in GitHub the
    // inbound links become orphaned — there is no app-level post-delete flow to
    // hook cleanup onto, so this is an accepted, documented limitation.
    try {
      if (!canStartDraftStep(deadlineAt, MIN_AFTER_COMMIT_STEP_MS)) {
        throw new Error('no time left in this run')
      }
      const { results, entries: reverseEntries } = await insertReverseLinks({
        githubRepo: job.github_repo,
        newPost: {
          slug,
          title: fm.title,
          keyword: fm.target_keyword || null,
          tags: fm.tags,
          excerpt: fm.excerpt,
          answerBlock: fm.answer_block,
        },
        contentJobId: idea.content_job_id,
        sessionId: idea.session_id,
        deadlineAt,
      })
      if (reverseEntries.length > 0) {
        await pushEntriesToBranch(
          job.github_repo,
          DRAFT_BRANCH,
          reverseEntries,
          `Add reverse links to: ${fm.title}`,
          {}
        )
        await supabase
          .from('resource_ideas')
          .update({ reverse_links: asJson(results), updated_at: new Date().toISOString() })
          .eq('id', ideaId)
        console.warn(`[reverse-link] Linked ${results.length} existing post(s) to ${slug}`)
      }
    } catch (err) {
      // A StaleShaError means a linked post changed after we read it — the
      // entries are fenced on the read sha, so the reverse-link commit is
      // refused rather than clobbering that edit. Skip the links; never fail.
      if (err instanceof StaleShaError) {
        console.warn(`[reverse-link] ${err.path} changed since it was read — skipping reverse links for ${slug}`)
      } else {
        console.warn(`[reverse-link] Pass failed for ${slug} (draft already published):`, err)
      }
    }

    return { status: 'complete', slug }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[resource-draft] Error on "${idea.title}":`, err)
    await supabase
      .from('resource_ideas')
      .update({ draft_status: 'error', draft_error: message, updated_at: new Date().toISOString() })
      .eq('id', ideaId)
    return { status: 'error', error: message }
  }
}
