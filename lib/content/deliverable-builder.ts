import type { Database } from '@/types/database'

type GeneratedPage = Database['public']['Tables']['generated_pages']['Row']

// The exact subset of a generated_pages row that buildPageMarkdown reads. A
// full row is structurally assignable to this, so buildAllPageFiles keeps
// passing rows unchanged; callers that never persist a row (the post-publish
// new-page generator) build just these fields instead of a 30-column literal.
export type PageMarkdownInput = Pick<
  GeneratedPage,
  | 'page_title'
  | 'page_url'
  | 'meta_title'
  | 'meta_description'
  | 'target_keyword'
  | 'secondary_keywords'
  | 'canonical_url'
  | 'schema_markup_type'
  | 'hero_block'
  | 'hero_variant'
  | 'hero_image'
  | 'hero_image_alt'
  | 'hero_subhead'
  | 'answer_block'
  | 'eeat_signals'
  | 'internal_links'
  | 'faq_block'
  | 'llm_citation_note'
  | 'content_markdown'
> & {
  /** Transient (not a DB column) — set by the package assembler's Ink & Clay
   * pass to render the small-caps kicker above a statement-variant hero. */
  hero_eyebrow?: string
}

export type CtaInfo = { text: string; url: string }

// page_url may arrive root-relative (/services) or as a full origin URL —
// crawled pages store scheme+host. Routing and filenames are path-based, so
// normalize to a clean root-relative path: strip scheme+host, drop trailing
// slash(es), guarantee a leading slash. Root stays '/'.
export function toPagePath(rawUrl: string): string {
  let path = (rawUrl ?? '').trim()
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname
    } catch {
      // malformed URL — fall through and slugify whatever we were handed
    }
  }
  path = path.replace(/\/+$/, '')
  if (!path.startsWith('/')) path = `/${path}`
  return path
}

function pageFilename(url: string): string {
  // /services/virtual-cfo-advisory → services--virtual-cfo-advisory.md; / → home.md
  const path = toPagePath(url)
  const slug = path.replace(/^\//, '').replace(/\//g, '--')
  if (!slug) return 'home.md'
  // Fail loud on a URL that never got normalized to a real path — an absolute
  // URL the AI proposer mangled into a pseudo-path (/https-//host.../page), or
  // any URL with an empty interior segment (//). The client template turns the
  // filename back into a route by splitting on '--'; an empty or scheme-like
  // first segment yields a degenerate route that breaks `next build` on Vercel.
  // Better to fail the onboarding assembler here, named, than silently ship it.
  const segments = slug.split('--')
  if (segments.some(s => s === '') || /^https?$/i.test(segments[0] ?? '')) {
    throw new Error(
      `Malformed page URL "${url}" → path "${path}": not a clean root-relative ` +
        `path (scheme/host or empty segment). Normalize with toSitePath before assembly.`
    )
  }
  return `${slug}.md`
}

// Frontmatter scalars can contain colons, quotes, or newlines (meta_description
// often reads "City, ST: summary"), which break unquoted YAML. JSON.stringify
// emits a valid YAML double-quoted scalar, keeping the hand-built frontmatter
// parseable — the same guarantee the structured fields below already rely on.
const yv = (value: string | null | undefined): string =>
  JSON.stringify(value == null ? '' : String(value))

// The firm's registration domain, minus a leading www — the identity we treat
// as "internal" for link normalization. Apex and www forms both match.
export function siteHost(siteUrl: string): string {
  const raw = (siteUrl ?? '').trim()
  try {
    const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).host
    return host.replace(/^www\./i, '').toLowerCase()
  } catch {
    return raw.replace(/^www\./i, '').toLowerCase()
  }
}

// Clickable internal links must be origin-relative so they resolve against
// whatever origin serves the page (Vercel preview before launch, the live
// domain after) instead of hard-jumping to production. Rewrite an absolute
// http(s) URL on the firm's own host to a root-relative path; leave already-
// relative hrefs, fragments, queries, mailto:/tel:, and genuinely external
// URLs untouched. SEO fields (canonical_url, OG) never pass through here — they
// stay absolute → production by design.
export function internalizeHref(href: string, host: string): string {
  const h = (href ?? '').trim()
  if (!/^https?:\/\//i.test(h)) return h
  try {
    const u = new URL(h)
    if (u.host.replace(/^www\./i, '').toLowerCase() === host) {
      return `${u.pathname}${u.search}${u.hash}` || '/'
    }
  } catch {
    // malformed URL — leave it as-is
  }
  return h
}

// Relativize inline markdown link targets (`[text](https://firm-host/...)`) on
// the firm's own host. Image links (`![alt](...)`) and external targets are
// left alone.
function internalizeMarkdownLinks(md: string, host: string): string {
  return md.replace(
    /(!?)(\[[^\]]*\]\()(https?:\/\/[^)\s]+)/g,
    (full, bang: string, open: string, url: string) =>
      bang ? full : open + internalizeHref(url, host)
  )
}

// The image/split hero blocks render a large H1. Without a dedicated headline
// the template falls back to the page title, so a nav-titled page ("Home",
// "Contact") shows that bare word as its hero — weak copy and a poor on-page
// H1. Promote the page's first content heading into hero_headline so the hero
// leads with real value-prop copy; the template de-dupes it from the lead
// section. page-header heroes show the page title (correct for index pages),
// so they get no headline.
function deriveHeroHeadline(page: PageMarkdownInput): string | null {
  const heroBlock = page.hero_block ?? 'page-header'
  if (heroBlock !== 'hero' && heroBlock !== 'hero-split') return null
  const m = (page.content_markdown ?? '').match(/^##\s+(.+?)\s*$/m)
  return m ? m[1].trim() : null
}

export function buildPageMarkdown(
  page: PageMarkdownInput,
  firmName: string,
  options: {
    websiteUrl: string
    cta?: CtaInfo | null
    jsonLd?: string
  }
): string {
  const host = siteHost(options.websiteUrl)
  const secondaryKw = (page.secondary_keywords as string[]) ?? []
  const eeatSignals = (page.eeat_signals as string[]) ?? []
  const internalLinks = ((page.internal_links as Array<{ url: string; anchor_text: string; reason: string }>) ?? [])
    .map((l) => ({ ...l, url: internalizeHref(l.url, host) }))
  const faqBlock = (page.faq_block as Array<{ question: string; answer: string }>) ?? []
  const cta = options.cta ? { ...options.cta, url: internalizeHref(options.cta.url, host) } : null
  const body = internalizeMarkdownLinks(page.content_markdown ?? '', host)
  const heroHeadline = deriveHeroHeadline(page)

  let md = `---
title: ${yv(`${page.page_title} | ${firmName}`)}
url: ${yv(toPagePath(page.page_url))}
meta_title: ${yv(page.meta_title ?? page.page_title)}
meta_description: ${yv(page.meta_description ?? '')}
target_keyword: ${yv(page.target_keyword ?? '')}
secondary_keywords: ${JSON.stringify(secondaryKw)}
canonical_url: ${yv(page.canonical_url ?? '')}
schema_markup: ${yv(page.schema_markup_type ?? 'WebPage')}
${cta ? `cta_text: ${yv(cta.text)}\ncta_url: ${yv(cta.url)}\n` : ''}hero: ${yv(page.hero_block ?? 'page-header')}
${page.hero_variant ? `hero_variant: ${yv(page.hero_variant)}\n` : ''}${page.hero_eyebrow ? `hero_eyebrow: ${yv(page.hero_eyebrow)}\n` : ''}${page.hero_image ? `hero_image: ${yv(page.hero_image)}\n` : ''}${page.hero_image && page.hero_image_alt ? `hero_image_alt: ${yv(page.hero_image_alt.replace(/\n/g, ' '))}\n` : ''}${page.hero_subhead ? `hero_subhead: ${yv(page.hero_subhead.replace(/\n/g, ' '))}\n` : ''}${heroHeadline ? `hero_headline: ${yv(heroHeadline)}\n` : ''}answer_block: ${JSON.stringify(page.answer_block ?? '')}
eeat_signals: ${JSON.stringify(eeatSignals)}
internal_links: ${JSON.stringify(internalLinks)}
faq_block: ${JSON.stringify(faqBlock)}
llm_citation_note: ${JSON.stringify(page.llm_citation_note ?? '')}
---

${body}

---
## SEO & AIO Metadata

**Answer Block:**
${page.answer_block ?? ''}

**E-E-A-T Signals:**
${eeatSignals.map(s => `- ${s}`).join('\n') || '- None specified'}

**Internal Links:**
${internalLinks.map(l => `- ${l.anchor_text} → ${l.url} — ${l.reason}`).join('\n') || '- None'}

**FAQ Block:**
${faqBlock.map(f => `\n**Q: ${f.question}**\nA: ${f.answer}`).join('\n') || '\nNone'}

**LLM Citation Note:**
${page.llm_citation_note ?? ''}
`

  if (cta) {
    md += `\n**Call to Action:** [${cta.text}](${cta.url})\n`
  }

  if (options.jsonLd) {
    md += `\n---\n## Structured Data — paste into \`<head>\`\n\n\`\`\`html\n${options.jsonLd}\n\`\`\`\n`
  }

  return md
}

export function buildAllPageFiles(
  pages: GeneratedPage[],
  firmName: string,
  options: {
    websiteUrl: string
    ctaByUrl: Map<string, CtaInfo | null>
    jsonLdByUrl: Map<string, string>
  }
): Array<{ filename: string; content: string }> {
  return pages
    .filter(p => p.generation_status === 'complete' && p.content_markdown)
    .map(p => ({
      filename: pageFilename(p.page_url),
      content: buildPageMarkdown(p, firmName, {
        websiteUrl: options.websiteUrl,
        cta: options.ctaByUrl.get(p.page_url) ?? null,
        jsonLd: options.jsonLdByUrl.get(p.page_url),
      }),
    }))
}

/**
 * Inject `photo: <filename>` lines into team-grid sections of a page's
 * markdown content. Used by the package builder right before zip assembly to
 * wire uploaded team headshots (and synthesized initials avatars) into the
 * deliverable so the Phase II TeamGrid parser picks them up.
 *
 * Input markdown structure (per Phase I content-generator output):
 *
 *   <!-- block: team-grid | variant: 3-col -->
 *   ## Our Team
 *
 *   ### Ron Lague, CPA, PFS
 *   Ron holds a CPA license...
 *
 *   ### Jackie Estes, MBA
 *   Jackie brings...
 *
 * After processing with photoMap = { "Ron Lague": "ron.jpg", "Jackie Estes": "jackie-avatar.svg" }:
 *
 *   <!-- block: team-grid | variant: 3-col -->
 *   ## Our Team
 *
 *   ### Ron Lague, CPA, PFS
 *   photo: ron.jpg
 *   Ron holds a CPA license...
 *
 *   ### Jackie Estes, MBA
 *   photo: jackie-avatar.svg
 *   Jackie brings...
 *
 * Member name matching: case-insensitive, compares the leading name portion
 * of the ### heading (everything before the first comma) against photoMap
 * keys. If a `photo:` line already exists right after the heading, it's
 * left alone (idempotent).
 *
 * Members in the markdown without a photoMap entry are left untouched —
 * callers should pre-populate photoMap with initials-avatar filenames for
 * any team member who lacks an uploaded photo, so every member ends up
 * with something.
 *
 * Pure and never throws.
 */
export function injectTeamPhotos(markdown: string, photoMap: Record<string, string>): string {
  if (!markdown || Object.keys(photoMap).length === 0) return markdown

  // Split by block annotations, preserving the delimiter at the start of
  // each chunk. The first chunk (before any annotation) is left as-is.
  const parts = markdown.split(/(?=<!-- block:)/g)
  const lookup = new Map<string, string>()
  for (const [k, v] of Object.entries(photoMap)) {
    lookup.set(k.toLowerCase().trim(), v)
  }

  const processed = parts.map(part => {
    if (!/^<!-- block: team-grid/.test(part)) return part
    return part.replace(
      /^(### [^\n]+\n)((?:photo:[^\n]*\n)?)/gm,
      (_match, heading: string, existingPhoto: string) => {
        if (existingPhoto) return heading + existingPhoto
        const headingText = heading.replace(/^### /, '').trim()
        const memberName = headingText.split(',')[0].trim().toLowerCase()
        const filename = lookup.get(memberName)
        if (!filename) return heading + existingPhoto
        return `${heading}photo: ${filename}\n`
      }
    )
  })

  return processed.join('')
}

/**
 * Standardize the /contact page's structure so every client deliverable
 * gets a working contact page out of the box.
 *
 * The Phase I content-generator gives Claude latitude to design contact
 * page content, but contact pages have hard structural requirements that
 * shouldn't be left to model judgment:
 *   - Phone / email / hours / address must come from brand.json, NOT
 *     from Claude's generated prose. Claude historically hallucinated
 *     fake numbers ("(978) 555-0100") when reaching for a credible-
 *     sounding placeholder.
 *   - A map embed is non-negotiable for a CPA firm's contact page.
 *   - A contact form is non-negotiable.
 *
 * This post-processor enforces the standard layout for any page whose
 * url is /contact (or ends in /contact):
 *
 *   1. Page-header (Claude's title — kept as-is from frontmatter)
 *   2. intro-text from Claude (if present) with phone/email substrings
 *      stripped to prevent the hallucination bug
 *   3. contact-info block  (NEW — auto-fills from brand.json)
 *   4. map block           (NEW — auto-fills from brand.json)
 *   5. form block (contact variant) — Claude's intro text is preserved
 *      if it already emitted one; otherwise a default intro is used
 *   6. (faq-accordion auto-appended later by appendFaqBlock)
 *
 * Idempotent: re-running on a page that already has contact-info / map
 * blocks doesn't double-insert. Detects existing annotations and only
 * appends what's missing.
 */
export function standardizeContactPage(page: GeneratedPage): string {
  const content = page.content_markdown ?? ''
  if (!isContactPage(page.page_url)) return content
  if (!content) return content

  // Strip hallucinated phone/email values that Claude inlined into prose.
  // Match common forms: "Phone: (xxx) xxx-xxxx", "Email: foo@bar.com",
  // "Call us at (xxx) xxx-xxxx".
  const cleaned = content
    .replace(/\s*Phone:\s*\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}\.?/gi, '')
    .replace(/\s*Email:\s*[\w.+-]+@[\w-]+\.[\w.-]+\.?/gi, '')
    .replace(/\s*Call us at \(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}\.?/gi, '')

  const hasContactInfo = /<!-- block: contact-info\b/.test(cleaned)
  const hasMap = /<!-- block: map\b/.test(cleaned)
  const hasForm = /<!-- block: form\b/.test(cleaned)

  // Build the standard insert. Empty if all three already exist.
  const inserts: string[] = []
  if (!hasContactInfo) {
    inserts.push('<!-- block: contact-info -->\n## How to Reach Us\n')
  }
  if (!hasMap) {
    inserts.push('<!-- block: map -->\n## Where to Find Us\n')
  }
  if (!hasForm) {
    inserts.push(
      '<!-- block: form | variant: contact -->\n## Send Us a Message\n\nDrop a line and a member of our team will get back to you within one business day.\n'
    )
  }
  if (inserts.length === 0) return cleaned

  // Insert just before any closing cta-banner / faq-accordion if one exists,
  // otherwise append at the end. Mirrors appendFaqBlock's insertion heuristic.
  const ctaIdx = cleaned.search(/^<!-- block: cta-banner/m)
  const faqIdx = cleaned.search(/^<!-- block: faq-accordion/m)
  const insertText = inserts.join('\n')
  let insertBefore = -1
  if (faqIdx >= 0) insertBefore = faqIdx
  if (ctaIdx >= 0 && (insertBefore < 0 || ctaIdx < insertBefore)) insertBefore = ctaIdx

  if (insertBefore >= 0) {
    return cleaned.slice(0, insertBefore).trimEnd() + '\n\n' + insertText + '\n' + cleaned.slice(insertBefore)
  }
  return cleaned.trimEnd() + '\n\n' + insertText
}

function isContactPage(url: string | null | undefined): boolean {
  if (!url) return false
  const normalized = url.toLowerCase().replace(/\/+$/, '')
  return normalized === '/contact' || normalized.endsWith('/contact')
}

export function buildErrorsFile(pages: GeneratedPage[]): string | null {
  const errored = pages.filter(p => p.generation_status === 'error')
  if (errored.length === 0) return null

  let md = `# Pages That Need Manual Copy\n\nThe following pages failed during content generation and need manual copywriting:\n\n`
  for (const p of errored) {
    md += `- **${p.page_title}** (${p.page_url})\n`
  }
  return md
}

// Appends FAQ block to content_markdown with annotation comment.
// Inserts before closing cta-banner/form blocks if present; otherwise appends at end.
export function appendFaqBlock(page: GeneratedPage): string {
  const content = page.content_markdown ?? ''
  if (!content) return ''

  // Defensively parse faq_block as Array<{ question: string; answer: string }>
  const raw = page.faq_block
  if (!raw || !Array.isArray(raw)) return content
  const items = raw.filter((it): it is { question: string; answer: string } =>
    it != null &&
    typeof it === 'object' &&
    typeof (it as { question?: unknown }).question === 'string' &&
    typeof (it as { answer?: unknown }).answer === 'string'
  )
  if (items.length === 0) return content

  // Build FAQ section. Industry pages carry a Prime-style heading
  // ("Common questions from contractors"); others use the default.
  const headline = page.faq_heading?.trim() || `Frequently Asked Questions About ${page.page_title}`
  const faqMarkdown = items
    .map(({ question, answer }) => `**Q: ${question}**\nA: ${answer}`)
    .join('\n\n')
  const faqSection = `<!-- block: faq-accordion -->\n## ${headline}\n\n${faqMarkdown}`

  // Find the last cta-banner or form block annotation
  const ctaBannerMatch = content.match(/^<!-- block: cta-banner/m)
  const formMatch = content.match(/^<!-- block: form/m)
  let lastBlockIndex = -1

  if (ctaBannerMatch) {
    const idx = content.lastIndexOf('<!-- block: cta-banner')
    lastBlockIndex = idx >= 0 ? idx : -1
  }
  if (formMatch) {
    const idx = content.lastIndexOf('<!-- block: form')
    lastBlockIndex = Math.max(lastBlockIndex, idx)
  }

  // Insert before the last block if found; otherwise append at end
  if (lastBlockIndex >= 0) {
    // Find the start of the line containing the block annotation
    const lineStart = content.lastIndexOf('\n', lastBlockIndex - 1) + 1
    return content.slice(0, lineStart) + faqSection + '\n\n' + content.slice(lineStart)
  } else {
    return content + '\n\n' + faqSection
  }
}
