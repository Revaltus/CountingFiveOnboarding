// ---------------------------------------------------------------------------
// Build the per-site JSON feed of published blog/resource posts for the
// WordPress blog-sync bridge (see ./README.md).
//
// Source of truth is the client's git repo `main` branch (published content).
// We reuse the existing frontmatter parser and the Divi bridge's markdown→HTML
// converter (which already sanitizes URL schemes and strips machine-only
// annotation lines) so this stays self-contained and deletable in one move.
// ---------------------------------------------------------------------------

import { splitFile, type Frontmatter } from '@/lib/editor/frontmatter'
import { markdownToHtml, type ImageResolver } from '@/lib/content/divi/markdown'
import { localImageFilename } from '@/lib/editor/page-images'
import { listTree, readTextBlobs, readFile, FileNotFoundError, MAIN_BRANCH } from '@/lib/github/repo-files'
import { CATEGORIES_PATH, parseCategoriesFileDetailed, readPostCategoryIds } from '@/lib/content/blog-categories'
import { assetUrlFor, type HeroImage } from './assets'

export type WpFeedCategory = { id: string; name: string; slug: string; description: string }

export type WpFeedPost = {
  slug: string // WordPress match key
  title: string
  html: string
  excerpt: string
  date_gmt: string // "YYYY-MM-DD HH:MM:SS" (GMT), or '' when absent
  tags: string[]
  categories: string[] // category ids (registry: feed.categories)
  author: string | null
  content_type: string
  canonical_url: string
  meta_title: string
  meta_description: string
  hero_image: HeroImage | null
  inline_images: HeroImage[] // one per distinct local body image; [] for pre-1.3.0 plugins
}

export type FeedOptions = {
  siteKey: string
  origin: string
  // filename → git blob sha for public/content-assets/
  assetShas?: ReadonlyMap<string, string>
  // Body images reference auth-only proxy URLs; only plugins >= 1.3.0 rewrite
  // them to WP media URLs, so older plugins get bodies without images.
  inlineImages?: boolean
  // Category ids from a valid content/categories.json: post ids are filtered to
  // this set. null/absent (no valid file) passes ids through unfiltered.
  knownCategoryIds?: ReadonlySet<string> | null
}

// Plugins send X-RV-Plugin-Version from 1.3.0 on; absent means older.
export const INLINE_IMAGES_MIN_PLUGIN = [1, 3, 0] as const

export function pluginSupportsInlineImages(version: string | null): boolean {
  const m = (version ?? '').trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return false
  const v = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
  for (let i = 0; i < 3; i++) {
    if (v[i] !== INLINE_IMAGES_MIN_PLUGIN[i]) return v[i] > INLINE_IMAGES_MIN_PLUGIN[i]
  }
  return true
}

const ASSETS_PREFIX = 'public/content-assets/'

const POSTS_PREFIX = 'content/posts/'
// buildPostMarkdown appends an inline "## SEO & AIO Metadata" block to the body;
// it carries no block annotation, so strip from the marker to end of file before
// converting to HTML (mirrors lib/content/divi/from-frontmatter.ts).
const SEO_SECTION_MARKER = '## SEO & AIO Metadata'

// Frontmatter scalars are written JSON-quoted (title: "Foo | Bar") or bare.
function unquote(raw: string): string {
  const t = raw.trim()
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

function scalar(fm: Frontmatter | null, key: string): string {
  const raw = fm?.fields[key]
  return raw === undefined ? '' : unquote(raw)
}

function stripInlineSeoSection(body: string): string {
  const idx = body.indexOf(SEO_SECTION_MARKER)
  if (idx === -1) return body
  return body.slice(0, idx).replace(/\n*-{3,}\s*\n*$/, '\n').trimEnd() + '\n'
}

// The generator writes `tags: ["a", "b"]` JSON-quoted, which the frontmatter
// parser refuses to treat as an inline array (it bails on quotes) — so tags land
// in `fields` as a raw string, not `arrayFields`. Handle both: arrayFields for
// legacy unquoted posts, JSON.parse for the current quoted form.
function parseTags(fm: Frontmatter | null): string[] {
  if (!fm) return []
  const arr = fm.arrayFields['tags']
  if (arr) return arr
  const raw = fm.fields['tags']
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean)
  } catch {
    /* fall through to a bare comma split */
  }
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => unquote(s.trim()))
    .filter(Boolean)
}

// Generator writes `date: YYYY-MM-DD`. WordPress wants `post_date_gmt` as
// "YYYY-MM-DD HH:MM:SS". Treat a date-only value as midnight GMT. Best-effort
// parse anything else; leave unrecognized values for the plugin to default.
function normalizeDate(raw: string): string {
  const t = unquote(raw).trim()
  if (t === '') return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return `${t} 00:00:00`
  const d = new Date(t)
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
  }
  return t
}

// content/posts/<slug>.md → <slug>
function slugFromPath(path: string): string {
  return path.replace(POSTS_PREFIX, '').replace(/\.md$/, '')
}

function heroImage(fm: Frontmatter | null, opts: FeedOptions): HeroImage | null {
  const image = scalar(fm, 'image') || scalar(fm, 'hero_image')
  if (!image) return null
  const alt = scalar(fm, 'image_alt') || scalar(fm, 'hero_image_alt') || null
  // An absolute URL (e.g. a Pexels CDN link) is publicly fetchable — pass it
  // through verbatim. A bare filename is a private repo asset → proxy URL.
  if (/^https?:\/\//i.test(image)) {
    return { url: image, requires_auth: false, alt, filename: image.split('/').pop() ?? image, sha: null }
  }
  const filename = localImageFilename(image) ?? image
  return {
    url: assetUrlFor(opts.origin, opts.siteKey, filename),
    requires_auth: true,
    alt,
    filename,
    sha: opts.assetShas?.get(filename) ?? null,
  }
}

// Body images: local filenames become proxy URLs tagged with data-rv-ref (the
// plugin swaps them for WP media URLs); absolute URLs pass through; a local
// file missing from the repo is dropped rather than shipped as a broken image.
function bodyImageResolver(opts: FeedOptions, collected: Map<string, HeroImage>): ImageResolver {
  return (src, alt) => {
    if (/^https?:\/\//i.test(src)) return { src }
    const filename = localImageFilename(src)
    if (!filename || !opts.inlineImages) return null
    const sha = opts.assetShas?.get(filename) ?? null
    if (opts.assetShas && !sha) return null
    const url = assetUrlFor(opts.origin, opts.siteKey, filename)
    if (!collected.has(filename)) {
      collected.set(filename, { url, requires_auth: true, alt: alt || null, filename, sha })
    }
    return { src: url, attrs: { 'data-rv-ref': filename } }
  }
}

function postCategoryIds(content: string, opts: FeedOptions): string[] {
  const ids = readPostCategoryIds(content)
  const known = opts.knownCategoryIds
  return known ? ids.filter((id) => known.has(id)) : ids
}

// Registry from `main`: missing, unparseable or partially-corrupt file → null
// (feed omits the key, so the plugin deletes nothing); any other read failure
// propagates so the route returns 500. A partial list must never be sent: the
// plugin would delete the dropped categories' terms.
async function readCategories(githubRepo: string): Promise<WpFeedCategory[] | null> {
  let text: string
  try {
    text = (await readFile(githubRepo, CATEGORIES_PATH, MAIN_BRANCH)).content
  } catch (err) {
    if (err instanceof FileNotFoundError) return null
    throw err
  }
  const { file, dropped } = parseCategoriesFileDetailed(text)
  if (!file || dropped > 0) {
    console.warn(
      `[wp-feed] ${githubRepo}: categories.json is invalid` + (file ? ` (${dropped} invalid/duplicate entries)` : '') + ' — omitting categories'
    )
    return null
  }
  return file.categories.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description ?? '',
  }))
}

// Map one repo post file to the feed shape. Pure (no network) — unit-tested.
// Returns null for a post explicitly flagged draft/unpublished in frontmatter
// (defensive; the publish flow should already keep drafts off `main`).
export function postFromRepoFile(
  path: string,
  content: string,
  opts: FeedOptions
): WpFeedPost | null {
  const { frontmatter, body } = splitFile(content)
  if (scalar(frontmatter, 'draft').toLowerCase() === 'true') return null
  if (scalar(frontmatter, 'status').toLowerCase() === 'draft') return null

  const slug = scalar(frontmatter, 'slug') || slugFromPath(path)
  const inline = new Map<string, HeroImage>()
  const html = markdownToHtml(stripInlineSeoSection(body), {
    resolveImage: bodyImageResolver(opts, inline),
  })
  return {
    slug,
    title: scalar(frontmatter, 'title') || slug,
    html,
    excerpt: scalar(frontmatter, 'excerpt'),
    date_gmt: normalizeDate(frontmatter?.fields['date'] ?? ''),
    tags: parseTags(frontmatter),
    categories: postCategoryIds(content, opts),
    author: scalar(frontmatter, 'author') || null,
    content_type: scalar(frontmatter, 'content_type') || 'blog',
    canonical_url: scalar(frontmatter, 'canonical_url') || `/resources/${slug}`,
    meta_title: scalar(frontmatter, 'meta_title'),
    meta_description: scalar(frontmatter, 'meta_description'),
    hero_image: heroImage(frontmatter, opts),
    inline_images: [...inline.values()],
  }
}

// List and read every published post from `main`. Each post is fetched by the
// blob sha the tree listing already returned (one getBlob, no path lookup)
// through a single bounded pool to stay under GitHub's secondary rate limit.
export async function buildFeed(
  githubRepo: string,
  opts: Omit<FeedOptions, 'assetShas' | 'knownCategoryIds'>
): Promise<{ posts: WpFeedPost[]; categories: WpFeedCategory[] | null }> {
  const categories = await readCategories(githubRepo)
  const knownCategoryIds = categories ? new Set(categories.map((c) => c.id)) : null

  const tree = await listTree(githubRepo, MAIN_BRANCH, POSTS_PREFIX)
  const entries = tree.filter(
    (e) => e.type === 'blob' && e.path.startsWith(POSTS_PREFIX) && e.path.endsWith('.md')
  )

  // One listing for the whole feed: shas let WP detect an in-place replace.
  const assetShas = new Map<string, string>()
  for (const e of await listTree(githubRepo, MAIN_BRANCH, ASSETS_PREFIX)) {
    if (e.type !== 'blob' || !e.path.startsWith(ASSETS_PREFIX)) continue
    const name = e.path.slice(ASSETS_PREFIX.length)
    if (!name.includes('/')) assetShas.set(name, e.sha)
  }

  const posts: WpFeedPost[] = []
  for (const f of await readTextBlobs(githubRepo, entries)) {
    const post = postFromRepoFile(f.path, f.content, { ...opts, assetShas, knownCategoryIds })
    if (post) posts.push(post)
  }
  return { posts, categories }
}
