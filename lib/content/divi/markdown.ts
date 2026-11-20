// ---------------------------------------------------------------------------
// Minimal markdown → HTML for Divi et_pb_text modules.
//
// Part of the throwaway Divi/WordPress export bridge (see ./README.md). Kept
// self-contained (no markdown dependency) so the whole `lib/content/divi/`
// folder can be deleted in one move when we retire the bridge. Handles only the
// subset our generated page and post bodies use: headings, paragraphs,
// unordered/ordered lists, GFM tables, blockquotes, horizontal rules,
// standalone images, bold/italic, inline links, and inline code. Divi (and the
// WordPress blog-sync feed) render the returned HTML verbatim.
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

// GFM table pieces. A row is any line starting with `|`; the delimiter row
// (`|---|:--:|--:|`) is what makes it a table, so stray pipes stay prose.
const TABLE_ROW_RE = /^\|.*\|?$/
const TABLE_DELIM_CELL_RE = /^:?-{3,}:?$/
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})$/

type CellAlign = 'left' | 'center' | 'right' | null

function splitTableRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur.trim())
  return cells
}

function parseDelimiterRow(line: string): CellAlign[] | null {
  if (!TABLE_ROW_RE.test(line.trim())) return null
  const cells = splitTableRow(line)
  if (!cells.length || !cells.every((c) => TABLE_DELIM_CELL_RE.test(c))) return null
  return cells.map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

function tableHtml(header: string[], aligns: CellAlign[], rows: string[][]): string {
  const width = header.length
  const cell = (tag: 'th' | 'td', text: string, i: number) => {
    const align = aligns[i]
    const style = align && align !== 'left' ? ` style="text-align:${align}"` : ''
    return `<${tag}${style}>${inlineMarkdown(text)}</${tag}>`
  }
  const fit = (cells: string[]) => Array.from({ length: width }, (_, i) => cells[i] ?? '')
  const head = `<thead><tr>${header.map((h, i) => cell('th', h, i)).join('')}</tr></thead>`
  const body = rows.length
    ? `<tbody>\n${rows.map((r) => `<tr>${fit(r).map((c, i) => cell('td', c, i)).join('')}</tr>`).join('\n')}\n</tbody>`
    : ''
  return `<div class="rv-table-wrap"><table class="rv-table">${head}${body}</table></div>`
}

// Convert a markdown block (a section body, or a card body) to Divi-safe HTML.
export function markdownToHtml(md: string, opts: { resolveImage?: ImageResolver } = {}): string {
  const resolveImage = opts.resolveImage ?? absoluteOnly
  const lines = (md ?? '').split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  let listItems: string[] = []
  let listTag: 'ul' | 'ol' = 'ul'
  let quote: string[] = []

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }
  const flushList = () => {
    if (listItems.length) {
      html.push(`<${listTag}>\n${listItems.map((li) => `<li>${inlineMarkdown(li)}</li>`).join('\n')}\n</${listTag}>`)
      listItems = []
    }
  }
  const flushQuote = () => {
    if (quote.length) {
      const paras = quote
        .join('\n')
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\n/g, ' ').trim())
        .filter(Boolean)
      if (paras.length) html.push(`<blockquote>${paras.map((p) => `<p>${inlineMarkdown(p)}</p>`).join('')}</blockquote>`)
      quote = []
    }
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '')
    if (isNoiseLine(line)) continue
    const trimmed = line.trim()

    if (trimmed === '') {
      flushAll()
      continue
    }

    const quoteLine = trimmed.match(/^>\s?(.*)$/)
    if (quoteLine) {
      flushParagraph()
      flushList()
      quote.push(quoteLine[1])
      continue
    }
    flushQuote()

    if (TABLE_ROW_RE.test(trimmed) && i + 1 < lines.length) {
      const aligns = parseDelimiterRow(lines[i + 1])
      const header = splitTableRow(trimmed)
      if (aligns && aligns.length === header.length) {
        flushAll()
        const rows: string[][] = []
        let j = i + 2
        while (j < lines.length && TABLE_ROW_RE.test(lines[j].trim())) {
          rows.push(splitTableRow(lines[j]))
          j++
        }
        html.push(tableHtml(header, aligns, rows))
        i = j - 1
        continue
      }
    }

    if (HR_RE.test(trimmed)) {
      flushAll()
      html.push('<hr>')
      continue
    }

    const heading = trimmed.match(/^(#{2,6})\s+(.*)$/)
    if (heading) {
      flushAll()
      const level = Math.min(heading[1].length, 6)
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      continue
    }

    const image = trimmed.match(STANDALONE_IMAGE_RE)
    if (image) {
      flushAll()
      const tag = imageHtml(image[2], image[1].trim(), resolveImage)
      if (tag) html.push(tag)
      continue
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)$/)
    const item = bullet ?? trimmed.match(/^\d{1,9}[.)]\s+(.*)$/)
    if (item) {
      flushParagraph()
      const tag = bullet ? 'ul' : 'ol'
      if (listItems.length && tag !== listTag) flushList()
      listTag = tag
      listItems.push(item[1])
      continue
    }

    flushList()
    paragraph.push(trimmed)
  }

  flushAll()
  return html.join('\n')
}
