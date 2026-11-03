import { anthropic } from '@ai-sdk/anthropic'
import { DEFAULT_COMMIT_AUTHOR } from '@/lib/github/commit-identity'
import { createServerClient } from '@/lib/supabase/server'
import { generateAndFinalizePage, PAGE_DEADLINE_DEFAULT_MS, type Cta } from './content-generator'
import { buildPageMarkdown, type PageMarkdownInput, type CtaInfo } from './deliverable-builder'
import { generateJson } from './json-generation'
import { PUBLISHED_CONTENT_MODEL, OUTLINE_PROVIDER_OPTIONS } from './generation-tuning'
import { deriveImageStyleSuffix } from './visual-style-derivation'
import { extractInlineImageRefs } from './image-ref-extractor'
import { resolveStockPhotos, type ImageRef } from './stock-photo-resolver'
import { recordTokenUsage } from './token-usage'
import { asJson } from '@/lib/supabase/json-typed'
import {
  DRAFT_BRANCH,
  StaleShaError,
  listTree,
  pushEntriesToBranch,
  writeFile,
} from '@/lib/github/repo-files'
import type { SessionSchema } from '@/types/session-schema'
import type { PaletteData } from '@/types/palette'
import { bodyBudgetFor, skeletonPromptFor } from './page-structure'
import { resolvePageIntent } from './page-intent'

const DEFAULT_CTA: Cta = { text: 'Schedule a consultation', url: '/contact' }

type OutlineSection = { h2: string; description: string; word_count: number }

// content/pages/services--tax.md → /services/tax ; home.md → /
function pageUrlFromFilename(path: string): string {
  const slug = path.slice('content/pages/'.length, -3)
  return slug === 'home' ? '/' : `/${slug.replace(/--/g, '/')}`
}

// A brand-new page has no research row and no approved outline. Derive a
// lightweight section outline from the admin's brief so the page-body
// generator has real structure to write against (mirrors the outline→content
// two-step of the bulk pipeline, without the DB coupling). Falls back to a
// single Overview section on any failure — generateAndFinalizePage still
// produces a usable page from that.
async function deriveOutline(args: {
  title: string
  url: string
  brief: string
  schema: SessionSchema
  contentJobId: string
  sessionId: string
}): Promise<{ sections: OutlineSection[]; targetKeyword: string }> {
  const firmName = args.schema.business?.name ?? 'the firm'
  const pageType = resolvePageIntent(args.url, args.title, args.schema).type
  const skeleton = skeletonPromptFor(pageType, args.schema)
  const budget = bodyBudgetFor(pageType)
  const fallback = {
    sections: [{ h2: 'Overview', description: args.brief || args.title, word_count: 500 }],
    targetKeyword: args.title.toLowerCase(),
  }
  const parsed = (await generateJson({
    model: anthropic(PUBLISHED_CONTENT_MODEL),
    system: 'You outline website pages. Return JSON only, no prose.',
    prompt: `Outline a new website page for ${firmName}.

PAGE TITLE: ${args.title}
WHAT THE PAGE SHOULD COVER (admin brief): ${args.brief || '(none — infer from the title)'}

Return JSON only:
{
  "target_keyword": "the primary search phrase this page should rank for",
  "sections": [
    { "h2": "Section heading", "description": "1-2 sentences on what this section covers", "word_count": 150 }
  ]
}

Produce 3-6 sections that make a complete, lean page for a human reader. Section word counts should total ${budget.min}-${budget.max} (never over ${budget.cap}); depth goes in the page FAQ, not extra sections. Each section has one job and never repeats another.${skeleton ? `\n\n${skeleton}` : ''}`,
    firstBudget: 4000,
    retryBudget: 8000,
    providerOptions: OUTLINE_PROVIDER_OPTIONS,
    label: 'new-page-outline',
    onAttempt: async (usage) => {
      await recordTokenUsage({
        task: 'content',
        contentJobId: args.contentJobId,
        sessionId: args.sessionId,
        stage: 'new_page',
        pageUrl: 'outline',
        model: PUBLISHED_CONTENT_MODEL,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      })
    },
  })) as { sections?: unknown; target_keyword?: unknown } | null

  if (!parsed) return fallback
  const sections: OutlineSection[] = Array.isArray(parsed.sections)
    ? parsed.sections
        .filter((s: unknown): s is { h2: unknown; description?: unknown; word_count?: unknown } =>
          !!s && typeof (s as { h2?: unknown }).h2 === 'string')
        .map((s: { h2: unknown; description?: unknown; word_count?: unknown }) => ({
          h2: String(s.h2),
          description: typeof s.description === 'string' ? s.description : '',
          word_count: typeof s.word_count === 'number' ? s.word_count : 200,
        }))
    : []
  if (sections.length === 0) return fallback
  const targetKeyword =
    typeof parsed.target_keyword === 'string' && parsed.target_keyword.trim()
      ? parsed.target_keyword.trim()
      : fallback.targetKeyword
  return { sections, targetKeyword }
}

// Turn a finalized GeneratedResult into the exact subset buildPageMarkdown
// needs. No generated_pages row is written — post-publish the repo is the
// source of truth (same as every other editor mutation).
function toPageMarkdownInput(
  pageTitle: string,
  pageUrl: string,
  meta: Awaited<ReturnType<typeof generateAndFinalizePage>>['metadata'],
  content: string
): PageMarkdownInput {
  return {
    page_title: pageTitle,
    page_url: pageUrl,
    meta_title: meta.meta_title,
    meta_description: meta.meta_description,
    target_keyword: meta.target_keyword,
    secondary_keywords: asJson(meta.secondary_keywords),
    canonical_url: meta.canonical_url,
    schema_markup_type: meta.schema_markup_type,
    hero_block: meta.hero_block,
    hero_variant: meta.hero_variant,
    hero_image: meta.hero_image,
    hero_image_alt: meta.hero_image_alt,
    hero_subhead: meta.hero_subhead,
    answer_block: meta.answer_block,
    eeat_signals: asJson(meta.eeat_signals),
    internal_links: asJson(meta.internal_links),
    faq_block: asJson(meta.faq_block),
    llm_citation_note: meta.llm_citation_note,
    content_markdown: content,
  }
}

// Minimal, VALID starter page — page-header hero (needs no image) + one intro
// paragraph. Written synchronously by the create-page route so the file (and
// any nav link) exists immediately, and as the visible content until an AI
// draft (if requested) replaces it. Rendered fine by the template's
// GeneratedMarkdownPage. Shared so the route and generator agree on shape.
export function buildStarterPage(title: string, pageUrl: string, firmName: string): string {
  const input: PageMarkdownInput = {
    page_title: title,
    page_url: pageUrl,
    meta_title: title,
    meta_description: '',
    target_keyword: '',
    secondary_keywords: [],
    canonical_url: '',
    schema_markup_type: 'WebPage',
    hero_block: 'page-header',
    hero_variant: null,
    hero_image: null,
    hero_image_alt: null,
    hero_subhead: null,
    answer_block: '',
    eeat_signals: [],
    internal_links: [],
    faq_block: [],
    llm_citation_note: '',
    content_markdown: `<!-- block: intro-text | variant: centered -->\n## ${title}\n\nAdd your content for this page here, or use the AI editor to draft it.\n`,
  }
  return buildPageMarkdown(input, firmName, { websiteUrl: '', cta: null })
}

// Fetch Pexels images for the page's hero + inline image refs, upload them as
// session assets, then push any that aren't already in the repo to
// public/content-assets/ on the draft branch. Returns nothing — best-effort;
// a missing PEXELS_API_KEY or a failed fetch just leaves the template to fall
// back on its placeholder behavior (same as the bulk assembler).
async function resolveAndPushImages(args: {
  githubRepo: string
  sessionId: string
  pageUrl: string
  heroImage: string | null
  heroQuery: string | null
  content: string
  palette: PaletteData | null
  brand: SessionSchema['brand'] | undefined
  author: { authorName: string; authorEmail: string }
}): Promise<void> {
  const supabase = createServerClient()
  const imageRefs: ImageRef[] = []
  if (args.heroImage && args.heroQuery) {
    imageRefs.push({ pageUrl: args.pageUrl, filename: args.heroImage, subjectQuery: args.heroQuery, source: 'hero' })
  }
  imageRefs.push(...extractInlineImageRefs(args.content, args.pageUrl))
  if (imageRefs.length === 0) return

  const referenced = new Set(imageRefs.map((r) => r.filename))
  const { data: existingAssets } = await supabase
    .from('assets')
    .select('*')
    .eq('session_id', args.sessionId)

  await resolveStockPhotos(
    {
      sessionId: args.sessionId,
      apiKey: process.env.PEXELS_API_KEY ?? '',
      styleSuffix: deriveImageStyleSuffix(args.palette, args.brand),
      existingAssets: existingAssets ?? [],
      imageRefs,
    },
    supabase
  )

  // Re-query so newly inserted stock-photo rows are included, then push the
  // referenced files that aren't already committed to the repo.
  const { data: assetRows } = await supabase
    .from('assets')
    .select('file_name, storage_path')
    .eq('session_id', args.sessionId)

  let repoAssets: Set<string>
  try {
    const tree = await listTree(args.githubRepo, DRAFT_BRANCH, 'public/content-assets/')
    repoAssets = new Set(tree.filter((e) => e.type === 'blob').map((e) => e.path.split('/').pop() ?? ''))
  } catch {
    repoAssets = new Set()
  }

  const toPush = (assetRows ?? []).filter(
    (a) => referenced.has(a.file_name) && !repoAssets.has(a.file_name)
  )
  if (toPush.length === 0) return

  const entries: { path: string; content: Buffer }[] = []
  for (const asset of toPush) {
    const { data, error } = await supabase.storage.from('session-assets').download(asset.storage_path)
    if (error || !data) {
      console.warn(`[new-page] Failed to download asset ${asset.storage_path}: ${error?.message}`)
      continue
    }
    entries.push({ path: `public/content-assets/${asset.file_name}`, content: Buffer.from(await data.arrayBuffer()) })
  }
  if (entries.length === 0) return

  await pushEntriesToBranch(
    args.githubRepo,
    DRAFT_BRANCH,
    entries,
    `Add ${entries.length} image(s) for ${args.pageUrl} via AI`,
    args.author
  )
}

// Produce a full AI first draft for a brand-new page and write it (plus its
// Pexels images) to the draft branch, overwriting the starter file. Async
// entry point kicked from the create-page route via after(). Atomic-claim
// guarded per the pipeline rule so a retry/sweep overlap can't double-run.
export async function generateNewPage(
  generationId: string
): Promise<{ status: 'complete' | 'error' | 'skipped'; error?: string }> {
  const supabase = createServerClient()
  // Page deadline derived from the create-page route's budget (maxDuration 600
  // minus the reserve): every model call is clipped to it and optional retries
  // are skipped near it, so the after() worker can't be killed mid-write.
  const deadlineAt = Date.now() + PAGE_DEADLINE_DEFAULT_MS

  const { data: row } = await supabase
    .from('new_page_generations')
    .select('id, content_job_id, session_id, target_path, page_url, title, brief, starter_sha')
    .eq('id', generationId)
    .single()
  if (!row) return { status: 'error', error: 'Generation not found' }

  const { data: locked } = await supabase
    .from('new_page_generations')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', generationId)
    // Never re-claim a finished (or in-flight) generation — a duplicate trigger
    // would overwrite a page the operator may already be editing.
    .in('status', ['pending', 'error'])
    .select('id')
  if (!locked?.length) return { status: 'skipped', error: 'Generation already running or complete' }

  const fail = async (message: string) => {
    await supabase
      .from('new_page_generations')
      .update({ status: 'error', error: message.slice(0, 2000), updated_at: new Date().toISOString() })
      .eq('id', generationId)
    return { status: 'error' as const, error: message }
  }

  try {
    const { data: job } = await supabase
      .from('content_jobs')
      .select('github_repo, palette')
      .eq('id', row.content_job_id)
      .single()
    const { data: session } = await supabase
      .from('sessions')
      .select('website_url, schema_data')
      .eq('id', row.session_id)
      .single()
    if (!job?.github_repo || !session) return await fail('Job or session not found')

    const schema = (session.schema_data ?? {}) as SessionSchema
    const palette = (job.palette ?? null) as PaletteData | null
    const firmName = schema.business?.name ?? 'the firm'
    const author = {
      authorName: DEFAULT_COMMIT_AUTHOR.name,
      authorEmail: DEFAULT_COMMIT_AUTHOR.email,
    }

    // Internal-link allow-list = the pages that actually exist on the draft
    // branch right now, not the (possibly stale) confirmed_sitemap.
    let sitemapUrls: string[] = []
    try {
      const entries = await listTree(job.github_repo, DRAFT_BRANCH, 'content/pages/')
      sitemapUrls = entries
        .filter((e) => e.type === 'blob' && e.path.endsWith('.md'))
        .map((e) => pageUrlFromFilename(e.path))
    } catch (err) {
      console.warn('[new-page] Sitemap list failed (continuing without):', err)
    }

    const { sections, targetKeyword } = await deriveOutline({
      title: row.title,
      url: row.page_url,
      brief: row.brief ?? '',
      schema,
      contentJobId: row.content_job_id,
      sessionId: row.session_id,
    })

    const cta: CtaInfo = DEFAULT_CTA
    const result = await generateAndFinalizePage({
      pageTitle: row.title,
      pageUrl: row.page_url,
      outlineSections: asJson(sections),
      targetKeyword,
      secondaryKeywords: [],
      existingContent: null,
      competitorRefs: [],
      schema,
      palette,
      websiteUrl: session.website_url,
      cta,
      contentJobId: row.content_job_id,
      sessionId: row.session_id,
      sitemapUrls,
      deadlineAt,
    })

    const markdown = buildPageMarkdown(
      toPageMarkdownInput(row.title, row.page_url, result.metadata, result.content),
      firmName,
      { websiteUrl: session.website_url, cta }
    )

    // Overwrite the starter with the full draft. expectedSha guards against an
    // admin who hand-edited the starter during generation — don't clobber.
    try {
      await writeFile(
        job.github_repo,
        row.target_path,
        markdown,
        DRAFT_BRANCH,
        `AI first draft for ${row.page_url}`,
        { expectedSha: row.starter_sha ?? undefined, ...author }
      )
    } catch (err) {
      if (err instanceof StaleShaError) {
        return await fail('This page was edited during generation, so the AI draft was discarded to protect your changes.')
      }
      throw err
    }

    // Images last: the page render only happens after publish + rebuild, so
    // pushing images after the page is safe, and doing it after the write
    // means a stale-sha abort never leaves orphan images.
    await resolveAndPushImages({
      githubRepo: job.github_repo,
      sessionId: row.session_id,
      pageUrl: row.page_url,
      heroImage: result.metadata.hero_image,
      heroQuery: result.metadata.hero_image_query,
      content: result.content,
      palette,
      brand: schema.brand,
      author,
    })

    await supabase
      .from('new_page_generations')
      .update({ status: 'complete', error: null, updated_at: new Date().toISOString() })
      .eq('id', generationId)

    console.warn(`[new-page] Complete: ${row.page_url}`)
    return { status: 'complete' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[new-page] Error:', err)
    return await fail(message)
  }
}
