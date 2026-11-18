// Extracts the repo-local image references on a page so the editor can show a
// thumbnail + replace control for each. Repo images live flat under
// public/content-assets/ and are referenced by bare filename — in the hero
// frontmatter field (`image` on posts, `hero_image` on legacy pages) and as
// inline markdown `![alt](file.png)`.
// External URLs (http/https) and absolute paths are left alone.

import type { PageFile } from './frontmatter'

export const ASSET_ROOT = 'public/content-assets/'
// Body images must be root-relative: the template renders markdown <img src>
// verbatim, so a bare filename would resolve against /resources/<slug>/.
export const PUBLIC_ASSET_PREFIX = '/content-assets/'

export type PageImageRef = {
  key: string // stable identity for React keys
  source: 'hero_image' | 'body'
  filename: string // bare filename, e.g. "hero-home.png"
  assetPath: string // public/content-assets/<filename>
  alt: string
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg)$/i
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

function isExternal(src: string): boolean {
  return /^https?:\/\//i.test(src) || src.startsWith('//')
}

// A bare filename or a path whose basename is a content-asset image. Returns
// the basename, or null if the ref is external / not an image.
export function localImageFilename(src: string): string | null {
  if (isExternal(src)) return null
  const cleaned = src.replace(/^\.?\//, '')
  const basename = cleaned.split('/').pop() ?? cleaned
  if (!IMAGE_EXT_RE.test(basename)) return null
  return basename
}

export function unquoteScalar(raw: string): string {
  const t = raw.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return String(JSON.parse(t))
    } catch {
      return t.slice(1, -1)
    }
  }
  return t
}

export function extractPageImages(file: PageFile): PageImageRef[] {
  const refs: PageImageRef[] = []
  const seen = new Set<string>()

  const fields = file.frontmatter?.fields ?? {}
  const heroKey = fields['image'] ? 'image' : 'hero_image'
  const hero = unquoteScalar(fields[heroKey] ?? '')
  if (hero) {
    const filename = localImageFilename(hero)
    if (filename) {
      refs.push({
        key: `hero:${filename}`,
        source: 'hero_image',
        filename,
        assetPath: ASSET_ROOT + filename,
        alt: unquoteScalar(fields[heroKey === 'image' ? 'image_alt' : 'hero_image_alt'] ?? ''),
      })
      seen.add(filename)
    }
  }

  for (const match of file.body.matchAll(MD_IMAGE_RE)) {
    const alt = match[1] ?? ''
    const filename = localImageFilename(match[2] ?? '')
    if (!filename || seen.has(filename)) continue
    seen.add(filename)
    refs.push({
      key: `body:${filename}`,
      source: 'body',
      filename,
      assetPath: ASSET_ROOT + filename,
      alt,
    })
  }

  return refs
}

// One entry per local `![alt](file)` in the body, in reading order and NOT
// deduped: `index` is the ordinal among all markdown images, so a swap rewrites
// exactly that occurrence even when the same file appears twice.
export type BodyImageRef = { index: number; filename: string; alt: string }

export function extractBodyImages(body: string): BodyImageRef[] {
  const refs: BodyImageRef[] = []
  let index = 0
  for (const match of body.matchAll(MD_IMAGE_RE)) {
    const filename = localImageFilename(match[2] ?? '')
    if (filename) refs.push({ index, filename, alt: match[1] ?? '' })
    index++
  }
  return refs
}

// `]` would end the alt early and a newline would split the paragraph. Not
// trimmed: it runs on every keystroke of the alt field.
export function cleanImageAlt(alt: string): string {
  return alt.replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '')
}

function rewriteNthImage(body: string, index: number, render: (alt: string, src: string) => string | null): string {
  let n = 0
  let removed = false
  const out = body.replace(MD_IMAGE_RE, (whole, alt: string, src: string) => {
    if (n++ !== index) return whole
    const next = render(alt, src)
    if (next === null) {
      removed = true
      return ''
    }
    return next
  })
  // A removed standalone image leaves an empty paragraph; collapse it.
  return removed ? out.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n') : out
}

// Point one body image at another library file, or remove it (filename null).
export function setBodyImage(body: string, index: number, filename: string | null): string {
  return rewriteNthImage(body, index, (alt) => (filename ? `![${alt}](${PUBLIC_ASSET_PREFIX}${filename})` : null))
}

export function setBodyImageAlt(body: string, index: number, alt: string): string {
  return rewriteNthImage(body, index, (_alt, src) => `![${cleanImageAlt(alt)}](${src})`)
}

// Markdown for a new standalone body image paragraph.
export function bodyImageMarkdown(filename: string, alt: string): string {
  return `![${cleanImageAlt(alt).trim()}](${PUBLIC_ASSET_PREFIX}${filename})`
}

// H2 headings a new body image can be placed under, in order.
export function bodyImageAnchors(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.match(/^##\s+(.+?)\s*$/)?.[1] ?? null)
    .filter((h): h is string => !!h)
}

// Insert a standalone image after the first plain paragraph under the `##`
// heading at position `anchor` (index into bodyImageAnchors), or at the end of
// the body when anchor is null or has no plain paragraph. Never splits a list,
// table, annotation, or existing image line.
export function insertBodyImage(body: string, markdown: string, anchor: number | null): string {
  const lines = body.split('\n')
  const isPlain = (l: string) => {
    const t = l.trim()
    return t !== '' && !/^(#|[-*+]\s|\d+\.\s|\||<!--|>|!\[|```)/.test(t) && !/^(icon|photo|query|alt):/i.test(t)
  }
  let at = -1
  if (anchor !== null) {
    let h = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i]) && ++h === anchor) {
        let j = i + 1
        while (j < lines.length && !/^#{1,2}\s/.test(lines[j]) && !isPlain(lines[j])) j++
        if (j < lines.length && isPlain(lines[j])) {
          while (j + 1 < lines.length && isPlain(lines[j + 1])) j++
          at = j
        }
        break
      }
    }
  }
  if (at === -1) return body.replace(/\s*$/, '') + `\n\n${markdown}\n`
  lines.splice(at + 1, 0, '', markdown, '')
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}
