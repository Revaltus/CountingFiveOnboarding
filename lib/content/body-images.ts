// In-body stock images for resource posts (blog/article).
//
// The resource-draft model may return up to MAX_BODY_IMAGES placements in
// frontmatter.body_images. Everything here is pure: the generator sanitizes the
// placements, dry-runs insertBodyImages to learn which ones can be placed,
// resolves only those through Pexels, then inserts the ones whose bytes
// actually downloaded (so a post never references a file the commit lacks).
//
// Image markdown matches what the editor (lib/editor/page-images.ts
// MD_IMAGE_RE + localImageFilename) and the WordPress feed parse, and what the
// template's post renderer can load: `![alt](/content-assets/<file>.jpg)`.
// The template renders post bodies through ReactMarkdown with the raw src, so a
// bare `file.jpg` would resolve against /resources/<slug>/ and 404; the
// root-relative path matches the article importer's body images.

import { PUBLIC_ASSET_PREFIX } from '@/lib/editor/page-images'

export const MAX_BODY_IMAGES = 2
const MAX_FILENAME_STEM = 60
const MAX_ALT_CHARS = 200
const MAX_QUERY_WORDS = 8

export interface BodyImagePlacement {
  /** Exact text of an H2 in the body; the image goes after its first paragraph. */
  after_heading: string
  /** Kebab-case .jpg filename (bare, no path). */
  filename: string
  /** 3-8 word subject-only Pexels query. */
  query: string
  /** Descriptive alt text. */
  alt: string
}

export interface InsertBodyImagesResult {
  body: string
  /** The placements that were inserted, in input order. */
  inserted: BodyImagePlacement[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Shape-only parse of the model's raw `body_images` value. Drops non-objects
 * and entries missing a heading, filename or query. Never throws.
 */
export function parseBodyImagePlacements(raw: unknown): BodyImagePlacement[] {
  if (!Array.isArray(raw)) return []
  const out: BodyImagePlacement[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const p: BodyImagePlacement = {
      after_heading: str(rec.after_heading).trim(),
      filename: str(rec.filename).trim(),
      query: str(rec.query).trim(),
      alt: str(rec.alt).trim(),
    }
    if (p.after_heading && p.filename && p.query) out.push(p)
  }
  return out
}

/** Kebab-case `[a-z0-9-]+.jpg`, or null when nothing usable is left. */
export function sanitizeBodyImageFilename(name: string): string | null {
  const base = name.trim().split(/[\\/]/).pop() ?? ''
  const stem = base
    .toLowerCase()
    .replace(/\.(jpe?g|png|webp|gif|avif)$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_FILENAME_STEM)
    .replace(/-+$/g, '')
  return stem ? `${stem}.jpg` : null
}

/**
 * Alt text safe inside `![...]`: one line, no square brackets (the editor's
 * MD_IMAGE_RE `[^\]]*` can't read an escaped `\]`, so brackets are removed
 * rather than escaped), capped in length.
 */
export function sanitizeBodyImageAlt(alt: string): string {
  return alt
    .replace(/[\r\n]+/g, ' ')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ALT_CHARS)
    .trim()
}

function normalizeHeading(text: string): string {
  return text
    .replace(/\s+#+\s*$/, '') // closing ATX hashes
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Sanitize + dedupe + cap. Filenames become `[a-z0-9-]+.jpg` and never equal
 * the hero filename (a collision gets a `-body` suffix); duplicate filenames
 * and duplicate headings keep the first placement only.
 */
export function sanitizeBodyImagePlacements(
  placements: BodyImagePlacement[],
  heroFilename: string | null
): BodyImagePlacement[] {
  const hero = heroFilename ? sanitizeBodyImageFilename(heroFilename) ?? heroFilename.toLowerCase() : null
  const seenFiles = new Set<string>()
  const seenHeadings = new Set<string>()
  if (heroFilename) seenFiles.add(heroFilename.toLowerCase())
  const out: BodyImagePlacement[] = []
  for (const p of placements) {
    if (out.length >= MAX_BODY_IMAGES) break
    let filename = sanitizeBodyImageFilename(p.filename)
    if (!filename) continue
    if (filename === hero) filename = filename.replace(/\.jpg$/, '-body.jpg')
    if (seenFiles.has(filename)) continue
    const heading = normalizeHeading(p.after_heading)
    if (!heading || seenHeadings.has(heading)) continue
    const query = p.query.replace(/\s+/g, ' ').trim().split(' ').slice(0, MAX_QUERY_WORDS).join(' ')
    if (!query) continue
    const alt = sanitizeBodyImageAlt(p.alt) || sanitizeBodyImageAlt(query)
    seenFiles.add(filename)
    seenHeadings.add(heading)
    out.push({ after_heading: p.after_heading.trim(), filename, query, alt })
  }
  return out
}

/** The markdown line for one placed image. */
export function bodyImageMarkdown(p: Pick<BodyImagePlacement, 'filename' | 'alt'>): string {
  return `![${sanitizeBodyImageAlt(p.alt)}](${PUBLIC_ASSET_PREFIX}${p.filename})`
}

const FENCE_RE = /^\s{0,3}(```|~~~)/
const HEADING_RE = /^\s{0,3}#{1,6}(\s|$)/
const H2_RE = /^\s{0,3}##[ \t]+(.+?)[ \t]*$/
// Lines that start something other than a plain paragraph.
const NON_PARAGRAPH_RE = [
  /^\s*([-*+]|\d+[.)])\s/, // list item
  /^\s*\|/, // table row
  /^\s*>/, // blockquote
  /^\s*<!--/, // HTML comment / block annotation
  /^\s*<\/?[a-zA-Z]/, // raw HTML
  /^\s*!\[/, // an image already
  /^(\t| {4})/, // indented code
  /^\s{0,3}([-*_])(\s*\1){2,}\s*$/, // thematic break
  FENCE_RE,
  HEADING_RE,
]

function isPlainParagraphLine(line: string): boolean {
  if (!line.trim()) return false
  return !NON_PARAGRAPH_RE.some((re) => re.test(line))
}

// Line index right after the first plain paragraph under the H2 at `h`, or -1.
// The section ends at the next heading. A section holding a block annotation
// is a structured block and is never touched; lists, tables, quotes and code
// before the first paragraph are stepped over, never inserted into.
function insertionIndex(lines: string[], h: number): number {
  let end = lines.length
  let inFence = false
  for (let i = h + 1; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) inFence = !inFence
    if (!inFence && HEADING_RE.test(lines[i])) {
      end = i
      break
    }
  }
  if (lines.slice(h + 1, end).some((l) => /<!--\s*block\s*:/i.test(l))) return -1

  inFence = false
  let prevBlank = true
  for (let i = h + 1; i < end; i++) {
    const line = lines[i]
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      prevBlank = false
      continue
    }
    if (inFence) continue
    if (!line.trim()) {
      prevBlank = true
      continue
    }
    // A paragraph must start after a blank line (or the heading), so a list
    // item's lazy continuation line is never mistaken for one.
    // It must also start at column 0: an indented line after a list is that
    // list item's continuation paragraph, not a top-level one.
    if (prevBlank && /^\S/.test(line) && isPlainParagraphLine(line)) {
      let j = i + 1
      while (j < end && isPlainParagraphLine(lines[j])) j++
      return j
    }
    prevBlank = false
  }
  return -1
}

function findH2(lines: string[], heading: string): number {
  const target = normalizeHeading(heading)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = H2_RE.exec(lines[i])
    if (m && normalizeHeading(m[1]) === target) return i
  }
  return -1
}

/**
 * Insert each placement as its own paragraph after the FIRST plain paragraph
 * under the matching `## {after_heading}` (trimmed, case-insensitive). A
 * placement whose heading is missing, whose section has no plain paragraph, or
 * whose section is a structured block is skipped. Placements are sanitized,
 * deduped and capped first (see sanitizeBodyImagePlacements).
 */
export function insertBodyImages(
  body: string,
  placements: BodyImagePlacement[],
  opts: { heroFilename?: string | null } = {}
): InsertBodyImagesResult {
  const clean = sanitizeBodyImagePlacements(placements, opts.heroFilename ?? null)
  const newline = body.includes('\r\n') ? '\r\n' : '\n'
  const lines = body.split(/\r?\n/)
  const inserted: BodyImagePlacement[] = []
  for (const p of clean) {
    const h = findH2(lines, p.after_heading)
    if (h < 0) continue
    const at = insertionIndex(lines, h)
    if (at < 0) continue
    const block = ['', bodyImageMarkdown(p)]
    if (at >= lines.length || lines[at].trim() !== '') block.push('')
    lines.splice(at, 0, ...block)
    inserted.push(p)
  }
  return { body: lines.join(newline), inserted }
}
