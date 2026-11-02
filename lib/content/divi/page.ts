// ---------------------------------------------------------------------------
// Assemble one generated page into a single Divi Builder shortcode string.
// Part of the throwaway Divi/WordPress export bridge (see ./README.md).
// ---------------------------------------------------------------------------

import { siteHost, internalizeHref } from '@/lib/content/deliverable-builder'
import { markdownToHtml } from './markdown'
import {
  parseDiviSections,
  parseCards,
  parseQA,
  basicContentBlock,
  subPageHeader,
  copyImageBlock,
  cardGridBlock,
  ctaBlock,
  accordionBlock,
  pricingTablesBlock,
  type DiviSection,
  type QA,
} from './blocks'
import type { PricingPlansConfig } from '@/types/pricing-plans'
import { BLOCK_CATALOG } from '@/lib/content/block-catalog'
import { CAROUSEL_CUE, isCarouselBlock } from '@/lib/content/page-structure'
import { DEFAULT_LAYOUT_PRESET, LAYOUT_PRESETS, LAYOUT_PRESET_NAMES, type LayoutPresets } from '@/lib/design/layout-presets'

export type DiviPageInput = {
  page_title: string
  page_url: string
  hero_block: string | null
  hero_variant: string | null
  hero_image_alt: string | null
  hero_subhead: string | null
  hero_image_query: string | null
  // Repo frontmatter (template hero fields); absent on non-repo sources.
  hero_image?: string | null
  hero_headline?: string | null
  hero_eyebrow?: string | null
  content_markdown: string | null
  faq_block: unknown
  cta: { text: string; url: string } | null
  // SEO frontmatter — not rendered into the page, listed in the sitemap PDF so
  // the importer can fill the SEO plugin fields.
  seo?: DiviPageSeo
}

export type DiviPageSeo = { metaTitle: string; metaDescription: string; targetKeyword: string }

function colsFromVariant(variant: string | undefined, fallback: number): number {
  const m = (variant ?? '').match(/(\d+)/)
  const n = m ? Number(m[1]) : NaN
  return n >= 1 && n <= 4 ? n : fallback
}

// Rewrite inline markdown links on the firm's own host to root-relative so a
// migrated page doesn't hard-jump back to the old site.
function internalizeLinks(md: string, host: string): string {
  return md.replace(
    /(!?)(\]\()(https?:\/\/[^)\s]+)/g,
    (full, bang: string, open: string, url: string) =>
      bang ? full : open + internalizeHref(url, host)
  )
}

// Carousel sections export as a static block; the cue tells whoever rebuilds
// the page in Divi to make it a slider.
const CAROUSEL_CUE_HTML = `<p><em>${CAROUSEL_CUE}</em></p>`

function headingHtml(section: DiviSection): string {
  const cue = isCarouselBlock(section.blockId, section.variant) ? `${CAROUSEL_CUE_HTML}\n` : ''
  return `${cue}<h2>${section.heading}</h2>\n${markdownToHtml(section.content)}`
}

// Pull the first markdown link out of a section body for a CTA fallback.
function firstLink(content: string): { text: string; url: string } | null {
  const m = content.match(/\[([^\]]+)\]\(([^)\s]+)\)/)
  return m ? { text: m[1].trim(), url: m[2].trim() } : null
}

// What a page render needs beyond the page itself.
export type DiviRenderOptions = {
  // design.json `layout` presets (template 2026.09.9+).
  layout?: LayoutPresets
  // An uploaded repo image (`image:` / hero_image) → its public URL; null when
  // the site's address isn't known (the Pexels `query:` is used instead).
  assetUrl?: (ref: string) => string | null
}

// Precedence mirrors the template (lib/design/layout-presets.ts): an explicit
// per-section layout variant wins, then the family's preset, then the legacy
// variant. Ink card bands never take a preset.
export function effectiveLayout(section: DiviSection, layout: LayoutPresets): string | undefined {
  const explicit = section.variant
  if (explicit && LAYOUT_VARIANTS.has(explicit)) return explicit
  if (section.theme === 'ink') return undefined
  for (const name of LAYOUT_PRESET_NAMES) {
    const value = layout[name]
    if (!value || value === DEFAULT_LAYOUT_PRESET) continue
    if ((LAYOUT_PRESETS[name].blocks as readonly string[]).includes(section.blockId)) return value
  }
  return undefined
}

const LAYOUT_VARIANTS: ReadonlySet<string> = new Set<string>(
  Object.values(BLOCK_CATALOG).flatMap((spec) => spec.variants.filter((v) => 'layout' in v && v.layout).map((v) => v.value))
)

function sectionImage(section: DiviSection, images: Map<string, string>, opts: DiviRenderOptions): string | undefined {
  const uploaded = section.image ? opts.assetUrl?.(section.image) : null
  if (uploaded) return uploaded
  return section.query ? images.get(section.query.trim()) : undefined
}

function renderSection(
  section: DiviSection,
  images: Map<string, string>,
  pageCta: { text: string; url: string } | null,
  pricingPlans: PricingPlansConfig | null,
  opts: DiviRenderOptions
): string {
  const imageUrl = sectionImage(section, images, opts)
  const layout = effectiveLayout(section, opts.layout ?? {})
  const band = section.theme === 'ink' ? 'ink' : 'light'

  switch (section.blockId) {
    case 'pricing-plans': {
      // Config-driven: the page md is a minimal host, the tiers live in
      // content/pricing-plans.json (threaded in as pricingPlans).
      if (pricingPlans && pricingPlans.tiers.length > 0) return pricingTablesBlock(pricingPlans)
      return basicContentBlock(headingHtml(section))
    }

    case 'content-split': {
      const side = section.variant === 'image-left' ? 'image-left' : 'image-right'
      return copyImageBlock({
        heading: section.heading,
        bodyHtml: markdownToHtml(section.content),
        imageUrl,
        imageAlt: section.alt,
        side,
      })
    }

    case 'feature-grid':
    case 'service-cards':
    case 'industry-cards':
    case 'content-cards': {
      const cards = parseCards(section.content)
      if (cards.length === 0) return basicContentBlock(headingHtml(section), { band })
      const cols = layout === 'list' ? 1 : colsFromVariant(section.variant, 3)
      return cardGridBlock(section.heading, cards, cols, band)
    }

    case 'cta-banner': {
      const link = pageCta ?? firstLink(section.content) ?? { text: 'Get in touch', url: '/contact/' }
      const bodyHtml = markdownToHtml(section.content.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1'))
      // The background (color-bg / image-bg) is the legacy variant; the
      // centred layout comes from a *-centered variant or the preset.
      const shape = layout ?? ''
      const imageBg = (section.variant ?? '').startsWith('image-bg') || shape.startsWith('image-bg')
      return ctaBlock({
        heading: section.heading,
        bodyHtml,
        buttonText: link.text,
        buttonUrl: link.url,
        centered: shape === 'centered' || shape.endsWith('-centered'),
        bgImageUrl: imageBg ? imageUrl : undefined,
      })
    }

    case 'faq-accordion': {
      const qa = parseQA(section.content)
      if (qa.length === 0) return basicContentBlock(headingHtml(section))
      return accordionBlock(section.heading, qa, layout === 'split')
    }

    case 'intro-text':
      return basicContentBlock(headingHtml(section), { band, align: section.variant === 'left-aligned' ? 'left' : 'center' })

    default:
      // content-prose, content-table, checklist-section, process-steps,
      // stats-bar, logo-bar, testimonials, team-grid, form, and anything new
      // render as clean styled prose so no content is ever dropped.
      return basicContentBlock(headingHtml(section), { band })
  }
}

function renderHero(page: DiviPageInput, images: Map<string, string>, body: string, opts: DiviRenderOptions): string {
  const heroBlock = page.hero_block ?? 'page-header'
  if (heroBlock !== 'hero' && heroBlock !== 'hero-split') {
    return subPageHeader(page.page_title, page.hero_subhead ?? undefined)
  }
  const firstHeading = body.match(/^##\s+(.+?)\s*$/m)
  const headline = page.hero_headline || (firstHeading ? firstHeading[1].trim() : page.page_title)
  const uploaded = page.hero_image ? opts.assetUrl?.(page.hero_image) : null
  const imageUrl = uploaded || (page.hero_image_query ? images.get(page.hero_image_query.trim()) : undefined)
  const side = page.hero_variant === 'image-left' ? 'image-left' : 'image-right'
  return copyImageBlock({
    heading: headline,
    eyebrow: page.hero_eyebrow ?? undefined,
    subhead: page.hero_subhead ?? undefined,
    bodyHtml: isCarouselBlock(heroBlock, page.hero_variant) ? CAROUSEL_CUE_HTML : '',
    buttonText: page.cta?.text,
    buttonUrl: page.cta?.url,
    imageUrl,
    imageAlt: page.hero_image_alt ?? headline,
    side,
    hero: true,
  })
}

function faqFromColumn(raw: unknown): QA[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (it): it is { question: string; answer: string } =>
        !!it &&
        typeof it === 'object' &&
        typeof (it as { question?: unknown }).question === 'string' &&
        typeof (it as { answer?: unknown }).answer === 'string'
    )
    .map((it) => ({ question: it.question, answer: it.answer }))
}

// Every unique image query a page needs (hero + section images), so the caller
// can resolve them all up front. A slot whose uploaded image resolves needs no
// stock lookup.
export function collectPageQueries(page: DiviPageInput, assetUrl?: (ref: string) => string | null): string[] {
  const uploaded = (ref: string | null | undefined) => !!ref && !!assetUrl?.(ref)
  const queries: string[] = []
  if (page.hero_image_query && !uploaded(page.hero_image)) queries.push(page.hero_image_query.trim())
  for (const s of parseDiviSections(page.content_markdown ?? '')) {
    if (s.query && !uploaded(s.image)) queries.push(s.query.trim())
  }
  return queries.filter(Boolean)
}

export function buildPageDivi(
  page: DiviPageInput,
  images: Map<string, string>,
  websiteUrl: string,
  pricingPlans: PricingPlansConfig | null = null,
  opts: DiviRenderOptions = {}
): string {
  const host = siteHost(websiteUrl)
  const body = internalizeLinks(page.content_markdown ?? '', host)
  const sections = parseDiviSections(body)

  const parts: string[] = [renderHero(page, images, body, opts)]
  for (const section of sections) {
    parts.push(renderSection(section, images, page.cta, pricingPlans, opts))
  }

  // Append the structured FAQ unless the page already carried an inline
  // faq-accordion section.
  const hasInlineFaq = sections.some((s) => s.blockId === 'faq-accordion')
  if (!hasInlineFaq) {
    const faq = faqFromColumn(page.faq_block)
    if (faq.length > 0) {
      parts.push(accordionBlock(`Frequently Asked Questions`, faq, opts.layout?.faq === 'split'))
    }
  }

  return parts.join('')
}
