// ---------------------------------------------------------------------------
// Minimal markdown → HTML for Divi et_pb_text modules.
//
// Part of the throwaway Divi/WordPress export bridge (see ./README.md). Kept
// self-contained (no markdown dependency) so the whole `lib/content/divi/`
// folder can be deleted in one move when we retire the bridge. Handles only the
// subset our generated page bodies use: headings, paragraphs, unordered lists,
// standalone images, bold/italic, inline links, and inline code. Divi renders the returned HTML
// verbatim inside a text module.
// ---------------------------------------------------------------------------

import { escapeShortcodeBrackets, htmlAttrEscape, safeUrl } from './sanitize'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Inline: escape first, then re-introduce the handful of inline HTML spans we
// support. Links are matched before bold/italic so a `[**text**](url)` label
// still bolds inside the anchor.
export function inlineMarkdown(text: string): string {
  let out = escapeHtml(text.trim())
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    // Drop links with an unsafe scheme (javascript:/data:/…) — keep the text so
    // no copy is lost, but never emit the anchor. The URL is already HTML-escaped
    // for &/</> by escapeHtml above; encode the quote chars so it can't break out
    // of the href attribute.
    const safe = safeUrl(url)
    if (!safe) return label
    const href = safe.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    return `<a href="${href}">${label}</a>`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  // After link parsing (which needs the brackets): any bracket left is copy.
  return escapeShortcodeBrackets(out)
}

// Strip machine-only annotation lines (icon:/photo:/query:/alt:) that live in
// the source markdown but must never render as visible copy.
function isNoiseLine(line: string): boolean {
  const t = line.trim()
  return (
    /^icon:\s*/i.test(t) ||
    /^photo:\s*/i.test(t) ||
    /^query:\s*/i.test(t) ||
    /^alt:\s*/i.test(t) ||
    t.startsWith('<!-- block:')
  )
}

// A line that is only `![alt](src)` (optionally with a "title").
const STANDALONE_IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/

export type ImageResolver = (src: string, alt: string) => { src: string; attrs?: Record<string, string> } | null

// Default: only absolute http(s) images render. A bare repo filename has no
// public URL outside the client site, so callers that can serve it pass a resolver.
const absoluteOnly: ImageResolver = (src) => (/^https?:\/\//i.test(src) && safeUrl(src) ? { src } : null)

function imageHtml(src: string, alt: string, resolve: ImageResolver): string | null {
  const resolved = resolve(src, alt)
  if (!resolved) return null
  const attrs = Object.entries(resolved.attrs ?? {})
    .map(([k, v]) => ` ${k}="${htmlAttrEscape(v)}"`)
    .join('')
  return `<figure><img src="${htmlAttrEscape(resolved.src)}" alt="${htmlAttrEscape(alt)}"${attrs}></figure>`
}

// Convert a markdown block (a section body, or a card body) to Divi-safe HTML.
export function markdownToHtml(md: string, opts: { resolveImage?: ImageResolver } = {}): string {
  const resolveImage = opts.resolveImage ?? absoluteOnly
  const lines = (md ?? '').split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  let listItems: string[] = []

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }
  const flushList = () => {
    if (listItems.length) {
      html.push(`<ul>\n${listItems.map((li) => `<li>${inlineMarkdown(li)}</li>`).join('\n')}\n</ul>`)
      listItems = []
    }
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (isNoiseLine(line)) continue
    const trimmed = line.trim()

    if (trimmed === '') {
      flushParagraph()
      flushList()
      continue
    }

    const heading = trimmed.match(/^(#{2,6})\s+(.*)$/)
    if (heading) {
      flushParagraph()
      flushList()
      const level = Math.min(heading[1].length, 6)
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      continue
    }

    const image = trimmed.match(STANDALONE_IMAGE_RE)
    if (image) {
      flushParagraph()
      flushList()
      const tag = imageHtml(image[2], image[1].trim(), resolveImage)
      if (tag) html.push(tag)
      continue
    }

    const listItem = trimmed.match(/^[-*]\s+(.*)$/)
    if (listItem) {
      flushParagraph()
      listItems.push(listItem[1])
      continue
    }

    flushList()
    paragraph.push(trimmed)
  }

  flushParagraph()
  flushList()
  return html.join('\n')
}
