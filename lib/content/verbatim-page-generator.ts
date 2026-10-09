import { fileTypeFromBuffer } from 'file-type'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { SessionSchema } from '@/types/session-schema'
import type { GeneratedResult } from './content-generator'
import { safeGetBinary } from '@/lib/audit/crawl'
import { serializeBlockComment } from '@/lib/editor/block-annotation'
import { generateMbpJson } from '@/lib/mbp/generate-json'
import { readSnapshot } from '@/lib/onboarding/page-snapshot'
import { normPath } from '@/lib/onboarding/directives'
import { asJson } from '@/lib/supabase/json-typed'
import { FAST_MODEL, FAST_PROVIDER_OPTIONS } from './generation-tuning'
import { toSitePath } from './url-path'

const IMAGE_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
const DOC_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/x-cfb': 'doc',
}
const DOC_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?)$/i
const MAX_ASSETS = 40

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g
const LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g

export const VERBATIM_MISSING_SNAPSHOT =
  'Verbatim snapshot missing — re-capture the page on its Audit Review instruction card, then regenerate.'

// Wraps the captured markdown in content-prose sections the template renders.
// The template only renders `<!-- block -->` + `## heading` sections and drops
// anything else, so every run of content becomes one section; content before
// the first H2 is headed by the page title. A leading H1 is dropped (the page
// header renders the title). Wording is untouched.
export function wrapVerbatimSections(markdown: string, pageTitle: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').trim().split('\n')
  const firstContent = lines.findIndex((l) => l.trim() !== '')
  if (firstContent >= 0 && /^#\s+/.test(lines[firstContent])) lines.splice(firstContent, 1)

  const sections: Array<{ heading: string; body: string[] }> = []
  let current: { heading: string; body: string[] } | null = null
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line)
    if (h2) {
      current = { heading: h2[1], body: [] }
      sections.push(current)
    } else {
      if (!current) {
        if (line.trim() === '') continue
        current = { heading: pageTitle, body: [] }
        sections.push(current)
      }
      current.body.push(line)
    }
  }
  const annotation = serializeBlockComment({ blockId: 'content-prose' })
  return sections
    .map((s) => `${annotation}\n## ${s.heading}\n\n${s.body.join('\n').trim()}`)
    .join('\n\n')
}

const hostOf = (u: string): string | null => {
  try {
    return new URL(u).host.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

// Absolute URL for a markdown href, or null when it isn't an http(s) target.
function absolutize(href: string, origin: string): string | null {
  if (/^(mailto:|tel:|#)/i.test(href)) return null
  try {
    const u = new URL(href, origin)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

export interface RehostTargets {
  images: string[]
  documents: string[]
}

// Every image (any host — hotlinks break) and every document hosted on the
// client's old site (they vanish when the domain moves to the new site).
export function collectRehostTargets(markdown: string, oldOrigin: string): RehostTargets {
  const oldHost = hostOf(oldOrigin)
  const images = new Set<string>()
  const documents = new Set<string>()
  for (const m of markdown.matchAll(IMAGE_RE)) {
    const abs = absolutize(m[2], oldOrigin)
    if (abs) images.add(abs)
  }
  for (const m of markdown.matchAll(LINK_RE)) {
    const abs = absolutize(m[2], oldOrigin)
    if (!abs || hostOf(abs) !== oldHost) continue
    if (DOC_EXT_RE.test(new URL(abs).pathname)) documents.add(abs)
  }
  return { images: [...images].slice(0, MAX_ASSETS), documents: [...documents].slice(0, MAX_ASSETS) }
}

// Rewrites hrefs/srcs in the verbatim body:
//   - re-hosted images/documents → their /content-assets/ path
//   - an image that couldn't be re-hosted → removed (it would 404 once the
//     domain moves to the new site)
//   - an old-site page link → the page's new path (same path when it's in the
//     new sitemap, else where a merge/drop directive sent it); a link to a page
//     that no longer exists keeps its anchor text and loses the link
//   - external links (forms, portals, IRS, etc.) → untouched
export function rewriteVerbatimLinks(
  markdown: string,
  oldOrigin: string,
  rehosted: Map<string, string>,
  resolvePagePath: (oldPath: string) => string | null,
): string {
  const oldHost = hostOf(oldOrigin)
  const withImages = markdown.replace(IMAGE_RE, (_full, alt: string, href: string, title = '') => {
    const abs = absolutize(href, oldOrigin)
    const local = abs ? rehosted.get(abs) : undefined
    return local ? `![${alt}](${local}${title})` : ''
  })
  return withImages.replace(LINK_RE, (full, anchor: string, href: string, title = '') => {
    const abs = absolutize(href, oldOrigin)
    if (!abs) return full
    const local = rehosted.get(abs)
    if (local) return `[${anchor}](${local}${title})`
    if (hostOf(abs) !== oldHost) return full
    if (DOC_EXT_RE.test(new URL(abs).pathname)) return full
    const path = toSitePath(abs)
    const mapped = path ? resolvePagePath(path) : null
    if (!mapped) return anchor
    const hash = new URL(abs).hash
    return `[${anchor}](${mapped}${hash}${title})`
  })
}

// Old-site path → new-site path: kept as-is when the confirmed sitemap has it,
// otherwise wherever an operator merge/drop (or the redirect worklist) points it.
export function pagePathResolver(schema: SessionSchema, sitemapUrls: string[]): (oldPath: string) => string | null {
  const live = new Map(sitemapUrls.map((u) => [normPath(u), u]))
  const moved = new Map<string, string>()
  for (const r of schema.current_sitemap ?? []) {
    const to = r?.new_url ? toSitePath(r.new_url) : undefined
    if (r?.url && to) moved.set(normPath(toSitePath(r.url) ?? r.url), to)
  }
  return (oldPath) => {
    const key = normPath(oldPath)
    const kept = live.get(key)
    if (kept) return kept
    const to = moved.get(key)
    return to && live.has(normPath(to)) ? live.get(normPath(to))! : null
  }
}

const slugPart = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page'

// Fetches one image/document, validates it by its bytes (never the URL's
// extension), and stores it as a private session asset the package assembler
// bundles into public/content-assets/. Reuses an asset already re-hosted from
// the same source URL (a regeneration must not duplicate files).
async function rehostAsset(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  sourceUrl: string,
  kind: 'image' | 'document',
  pageSlug: string,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('assets')
    .select('file_name')
    .eq('session_id', sessionId)
    .eq('metadata->>source_url', sourceUrl)
    .eq('metadata->>source', 'verbatim')
    .limit(1)
    .maybeSingle()
  if (existing?.file_name) return `/content-assets/${existing.file_name}`

  const fetched = await safeGetBinary(sourceUrl)
  if (!fetched) return null
  const detected = await fileTypeFromBuffer(fetched.buffer)
  const ext = detected ? (kind === 'image' ? IMAGE_MIME : DOC_MIME)[detected.mime] : undefined
  if (!detected || !ext) return null

  const original = decodeURIComponent(new URL(sourceUrl).pathname.split('/').pop() ?? '').replace(/\.[a-z0-9]+$/i, '')
  // Unique, collision-proof name: the assembler renames on a basename clash,
  // which would silently break this page's reference.
  const fileName = `${pageSlug}-${slugPart(original)}-${crypto.randomUUID().slice(0, 8)}.${ext}`
  const storagePath = `sessions/${sessionId}/${crypto.randomUUID()}-${fileName}`
  const { error: uploadErr } = await supabase.storage
    .from('session-assets')
    .upload(storagePath, fetched.buffer, { contentType: detected.mime, upsert: false })
  if (uploadErr) {
    console.warn(`[verbatim] upload failed for ${sourceUrl}: ${uploadErr.message}`)
    return null
  }
  const { error: insertErr } = await supabase.from('assets').insert({
    session_id: sessionId,
    file_name: fileName,
    storage_path: storagePath,
    public_url: null,
    mime_type: detected.mime,
    file_size_bytes: fetched.buffer.byteLength,
    asset_category: kind === 'image' ? 'photo' : 'other',
    metadata: asJson({ source: 'verbatim', source_url: sourceUrl }),
  })
  if (insertErr) {
    await supabase.storage.from('session-assets').remove([storagePath])
    console.warn(`[verbatim] asset row insert failed for ${sourceUrl}: ${insertErr.message}`)
    return null
  }
  return `/content-assets/${fileName}`
}

function firstProse(markdown: string): string {
  for (const line of markdown.split('\n')) {
    const t = line.trim()
    if (!t || /^(#|!|>|\||<!--|[-*]\s)/.test(t)) continue
    const plain = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim()
    if (plain.length > 20) return plain.slice(0, 155)
  }
  return ''
}

function validateSeo(parsed: unknown): { meta_title: string; meta_description: string } | null {
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  const t = typeof p.meta_title === 'string' ? p.meta_title.trim() : ''
  const d = typeof p.meta_description === 'string' ? p.meta_description.trim() : ''
  return t && d ? { meta_title: t.slice(0, 70), meta_description: d.slice(0, 170) } : null
}

export interface VerbatimPageInput {
  supabase: SupabaseClient<Database>
  sessionId: string
  contentJobId: string
  pageUrl: string
  pageTitle: string
  snapshotPath: string | null
  websiteUrl: string
  schema: SessionSchema
  sitemapUrls: string[]
  targetKeyword: string
  secondaryKeywords: string[]
}

// A page an operator said to bring over word-for-word: the captured snapshot,
// wrapped in renderable sections, with images/documents re-hosted and old-site
// page links remapped. The only AI output is the SEO title + description; the
// body's wording is never sent to a writer model. Throws when the snapshot is
// unreadable so the page surfaces as an error instead of shipping empty.
export async function generateVerbatimPage(input: VerbatimPageInput): Promise<GeneratedResult> {
  const raw = input.snapshotPath ? await readSnapshot(input.supabase, input.sessionId, input.snapshotPath) : null
  if (!raw?.trim()) throw new Error(VERBATIM_MISSING_SNAPSHOT)

  const origin = input.websiteUrl.replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'https://')
  const pageSlug = slugPart(input.pageUrl.split('/').filter(Boolean).pop() ?? input.pageTitle)
  const targets = collectRehostTargets(raw, origin)
  const rehosted = new Map<string, string>()
  await Promise.all([
    ...targets.images.map(async (u) => {
      const local = await rehostAsset(input.supabase, input.sessionId, u, 'image', pageSlug)
      if (local) rehosted.set(u, local)
    }),
    ...targets.documents.map(async (u) => {
      const local = await rehostAsset(input.supabase, input.sessionId, u, 'document', pageSlug)
      if (local) rehosted.set(u, local)
    }),
  ])

  const body = rewriteVerbatimLinks(raw, origin, rehosted, pagePathResolver(input.schema, input.sitemapUrls))
  const content = wrapVerbatimSections(body, input.pageTitle)

  const seo =
    (await generateMbpJson(
      `Write SEO metadata for a CPA firm's web page. Do not change or summarize the page itself.
- meta_title: 50-60 characters, includes "${input.targetKeyword}" when it fits naturally
- meta_description: 150-160 characters, plain and specific to what the page offers

Return JSON: {"meta_title": string, "meta_description": string}

PAGE TITLE: ${input.pageTitle}
PAGE:
${content.slice(0, 6000)}`,
      validateSeo,
      600,
      { task: 'content', stage: 'content', sessionId: input.sessionId, contentJobId: input.contentJobId, pageUrl: input.pageUrl },
      { model: FAST_MODEL, providerOptions: FAST_PROVIDER_OPTIONS },
    )) ?? { meta_title: input.pageTitle.slice(0, 70), meta_description: firstProse(body) }

  const host = new URL(origin).host
  return {
    // Nothing renderable survived (blank snapshot body, or only images that
    // couldn't be re-hosted): fail the page so it surfaces and auto-retries
    // instead of shipping an empty "complete" page.
    ...(content.trim() ? {} : { degraded: true }),
    content,
    metadata: {
      meta_title: seo.meta_title,
      meta_description: seo.meta_description,
      target_keyword: input.targetKeyword,
      secondary_keywords: input.secondaryKeywords,
      url_slug: pageSlug,
      canonical_url: `https://${host}${input.pageUrl === '/' ? '' : input.pageUrl}`,
      answer_block: '',
      schema_markup_type: 'WebPage',
      eeat_signals: [],
      internal_links: [],
      faq_block: [],
      llm_citation_note: '',
      hero_block: 'page-header',
      hero_variant: null,
      hero_image: null,
      hero_image_alt: null,
      hero_subhead: null,
      hero_image_query: null,
    },
  }
}

// Every link the source page had, rewritten for the new site (re-hosted
// documents, remapped old-site pages), that the written page doesn't carry,
// as one renderable "Links and resources" section. '' when nothing is missing.
// Links to pages that no longer exist are omitted (they'd only lose their href).
export function missingLinksSection(content: string, rewrittenSource: string): string {
  const missing: string[] = []
  const seen = new Set<string>()
  for (const m of rewrittenSource.matchAll(LINK_RE)) {
    const href = m[2]
    if (seen.has(href) || content.includes(`](${href}`)) continue
    seen.add(href)
    missing.push(`- [${m[1].trim() || href}](${href})`)
  }
  if (!missing.length) return ''
  return `${serializeBlockComment({ blockId: 'content-prose' })}\n## Links and resources\n\n${missing.join('\n')}`
}

// "Bring this page over and keep all its links" on a page that is otherwise
// rewritten: appends whatever links from the captured source the writer
// dropped, with old-site documents re-hosted like a verbatim page's. Returns the
// content unchanged (and logs) when the snapshot can't be read.
export async function appendMissingSourceLinks(
  input: Omit<VerbatimPageInput, 'contentJobId' | 'pageTitle' | 'targetKeyword' | 'secondaryKeywords'> & { content: string },
): Promise<string> {
  const raw = input.snapshotPath ? await readSnapshot(input.supabase, input.sessionId, input.snapshotPath) : null
  if (!raw?.trim()) {
    console.warn(`[verbatim] keep-links snapshot unreadable for ${input.pageUrl}; links not carried over`)
    return input.content
  }
  const origin = input.websiteUrl.replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'https://')
  const pageSlug = slugPart(input.pageUrl.split('/').filter(Boolean).pop() ?? 'page')
  const rehosted = new Map<string, string>()
  await Promise.all(
    collectRehostTargets(raw, origin).documents.map(async (u) => {
      const local = await rehostAsset(input.supabase, input.sessionId, u, 'document', pageSlug)
      if (local) rehosted.set(u, local)
    }),
  )
  const rewritten = rewriteVerbatimLinks(raw, origin, rehosted, pagePathResolver(input.schema, input.sitemapUrls))
  const section = missingLinksSection(input.content, rewritten)
  return section ? `${input.content.trimEnd()}\n\n${section}\n` : input.content
}
