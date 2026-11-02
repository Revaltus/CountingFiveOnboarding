import { Paragraph, HeadingLevel, TextRun } from 'docx'
import { parseBlockComment } from '@/lib/editor/block-annotation'
import { CAROUSEL_CUE, isCarouselBlock } from './page-structure'

// Strip the inline markdown marks our runs render as plain text: **bold**,
// *italic*, and [label](url) (kept as the label). Shared so the page-body
// converter and the site document's hero/heading copy clean identically.
export function stripInlineMarks(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

// Convert the light markdown our page bodies use (## / # headings, - / * bullets,
// --- rules, **bold**/*italic*/[link](url) inline marks) into docx Paragraphs.
// Shared by the content-package builder (lib/content/docx-builder.ts) and the
// live-draft site document (lib/content/site-doc-builder.ts) so both render page
// bodies identically. Inline marks are stripped to plain text — the runs stay
// simple and predictable, matching the original single-purpose implementation.
export function markdownToDocxParagraphs(markdown: string): Paragraph[] {
  const paragraphs: Paragraph[] = []
  const lines = markdown.split('\n')
  let inFence = false

  for (const line of lines) {
    const trimmed = line.trim()

    // Fenced code blocks (``` / ```lang … ```): render the inner lines as
    // compact monospace so embedded code — e.g. JSON-LD structured data — reads
    // as code and stays tight instead of sprawling as full-size body text. The
    // fence marker lines themselves are dropped.
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      if (trimmed === '') continue
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: line, font: 'Courier New', size: 16 })],
        spacing: { after: 0 },
      }))
      continue
    }

    if (!trimmed) continue

    // Block annotations are layout data, not copy. The one a rebuilder needs is
    // which sections are carousels.
    if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) {
      const c = parseBlockComment(trimmed)
      if (c && isCarouselBlock(c.blockId, c.variant)) {
        paragraphs.push(new Paragraph({
          children: [new TextRun({ text: CAROUSEL_CUE, italics: true })],
          spacing: { before: 240, after: 0 },
        }))
      }
      continue
    }

    if (trimmed.startsWith('## ')) {
      paragraphs.push(new Paragraph({
        text: trimmed.replace(/^## /, ''),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
      }))
    } else if (trimmed.startsWith('# ')) {
      // The page title gets emitted as a Bookmark-wrapped Heading 1 outside
      // this function, so an in-content H1 (the Claude-generated SEO title)
      // becomes Heading 2 to keep TOC structure tidy.
      paragraphs.push(new Paragraph({
        text: trimmed.replace(/^# /, ''),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
      }))
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      paragraphs.push(new Paragraph({
        children: [new TextRun(trimmed.replace(/^[-*] /, ''))],
        bullet: { level: 0 },
        spacing: { after: 60 },
      }))
    } else if (trimmed.startsWith('---')) {
      // Horizontal rules are decorative in markdown; treat as visual spacer.
      paragraphs.push(new Paragraph({ spacing: { after: 120 } }))
    } else {
      const clean = stripInlineMarks(trimmed)

      paragraphs.push(new Paragraph({
        children: [new TextRun(clean)],
        spacing: { after: 120 },
      }))
    }
  }

  return paragraphs
}
