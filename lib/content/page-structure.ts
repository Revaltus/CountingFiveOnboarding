import { findBlockComments } from '@/lib/editor/block-annotation'
import type { SessionSchema } from '@/types/session-schema'
import type { PageIntentType } from './page-intent'
import { realStrings } from './schema-coerce'
import { LOCATION_HUBS, NICHE_HUBS, SERVICE_HUBS } from './page-hubs'

// One page-structure rule set shared by the outline generator, the page writer,
// its deterministic retry gate, QA, the AI editor and the Restructure compare
// (Wade's user-first page skeleton, 2026-11). Pure and client-safe: the
// Restructure modal imports measurePageStructure to render its metrics.

export const BODY_TARGET_WORDS = { min: 500, max: 650 } as const
export const BODY_MAX_WORDS = 800
export const MAX_CONTENT_SPLITS = 2
export const FAQ_QUESTIONS = { min: 6, max: 10 } as const
export const FAQ_ANSWER_WORDS = { min: 40, max: 80 } as const
export const MIN_SCANNABLE_SECTIONS = 2

export const GENERIC_CTA_LABELS = [
  'learn more',
  'contact us',
  'get started',
  'click here',
  'read more',
  'find out more',
  'get in touch',
  'submit',
  'contact',
] as const

// Page types that get the full skeleton (and the FAQ / scannability checks).
// Home/about/contact/generic pages keep only the length + rhythm caps.
export const SKELETON_PAGE_TYPES: readonly PageIntentType[] = ['niche', 'service', 'location']

export const PAGE_STRUCTURE_RULES = `PAGE STRUCTURE RULES (user first, then search and AI):
- Write for the person reading the page. Every section must earn its place; no section restates another.
- Keep the body (everything except the FAQ) to ${BODY_TARGET_WORDS.min}-${BODY_TARGET_WORDS.max} words. Never exceed ${BODY_MAX_WORDS}.
- Prefer bullets to paragraphs for benefits, deliverables, criteria and steps. Short paragraphs (2-3 sentences) elsewhere.
- Use at most ${MAX_CONTENT_SPLITS} content-split (text + image) sections per page and never two image-beside-text sections in a row. Lists go in checklist-section (standalone), process-steps or card grids.
- The FAQ carries depth: ${FAQ_QUESTIONS.min}-${FAQ_QUESTIONS.max} questions, ${FAQ_ANSWER_WORDS.min}-${FAQ_ANSWER_WORDS.max} words each. Definitions, edge cases, how-it-works detail and keyword-rich explanation go there, not in the body. It stays collapsed for readers but is fully indexed.
- End on ONE page-specific call to action. The button names the outcome for this reader (e.g. "Book a job-costing review"), never a generic label like "Learn More" or "Contact Us".`

export type SkeletonSlot = {
  role: string
  blocks: string
  words: string
  guidance: string
}

export type SkeletonOptions = {
  hasTestimonials: boolean
  hasNichePricing: boolean
}

// No per-niche pricing field exists in the schema yet, so the Packages slot is
// off until one does.
export function skeletonOptionsFor(schema: SessionSchema): SkeletonOptions {
  const stories = realStrings(schema.business?.clientSuccessStories)
  const testimonials = realStrings(schema.assets?.testimonialsAvailable)
  return { hasTestimonials: stories.length + testimonials.length > 0, hasNichePricing: false }
}

export function skeletonPromptFor(type: PageIntentType, schema: SessionSchema): string {
  return formatSkeleton(buildPageSkeleton(type, skeletonOptionsFor(schema)))
}

// URL-only page type for callers without a schema match (editor, measure
// script). The generator uses resolvePageIntent's type instead.
export function structureTypeForUrl(url: string): PageIntentType {
  const segs = url
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/[?#].*$/, '')
    .split('/')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  if (!segs.length || segs[0] === 'home' || segs[0] === 'index') return 'home'
  if (segs[0] === 'about' || segs[0] === 'about-us') return 'about'
  if (segs[0] === 'contact' || segs[0] === 'contact-us') return 'contact'
  if (!segs[1]) return 'generic'
  if (NICHE_HUBS.includes(segs[0])) return 'niche'
  if (SERVICE_HUBS.includes(segs[0])) return 'service'
  if (LOCATION_HUBS.includes(segs[0])) return 'location'
  return 'generic'
}

export function usesSkeleton(type: PageIntentType): boolean {
  return SKELETON_PAGE_TYPES.includes(type)
}

export function buildPageSkeleton(type: PageIntentType, opts: SkeletonOptions): SkeletonSlot[] {
  if (!usesSkeleton(type)) return []
  const slots: SkeletonSlot[] = [
    {
      role: 'Acknowledgement',
      blocks: 'intro-text',
      words: '40-70',
      guidance: "In the reader's own vocabulary (e.g. retainage, progress billing): we get it and take it off your plate.",
    },
    {
      role: 'Problem and solution',
      blocks: 'checklist-section (standalone) or feature-grid',
      words: '100-150',
      guidance: "Each of this reader's problems paired with our fix, as bullets.",
    },
    {
      role: 'How it is delivered',
      blocks: 'content-split or checklist-section (standalone)',
      words: '80-130',
      guidance: 'What the client gets: deliverables, cadence, tools.',
    },
    opts.hasTestimonials
      ? {
          role: 'Validation',
          blocks: 'testimonials',
          words: '40-100',
          guidance: 'Only real testimonials from the firm context, never invented.',
        }
      : {
          role: 'Validation',
          blocks: 'stats-bar, logo-bar or intro-text',
          words: '40-80',
          guidance: 'Proof from the firm context only (years, credentials, memberships), never invented.',
        },
    {
      role: 'How we do it',
      blocks: 'process-steps',
      words: '80-120',
      guidance: '3-5 short steps.',
    },
  ]
  if (opts.hasNichePricing) {
    slots.push({
      role: 'Packages',
      blocks: 'pricing',
      words: '60-120',
      guidance: "Only the firm's stated packages for this audience.",
    })
  }
  slots.push({
    role: 'Call to action',
    blocks: 'cta-banner',
    words: '30-60',
    guidance: 'Page-specific offer; the button names the outcome.',
  })
  return slots
}

export function formatSkeleton(slots: SkeletonSlot[]): string {
  if (!slots.length) return ''
  const lines = slots.map(
    (s, i) => `${i + 1}. ${s.role} [${s.blocks}, ${s.words} words]: ${s.guidance}`,
  )
  return [
    'PAGE SKELETON (in this order; the hero is page metadata and the FAQ is inserted before the CTA):',
    ...lines,
  ].join('\n')
}

// Build cue for the Divi/Word exports (never written into page markdown): the
// person rebuilding the page needs to know which sections move.
export const CAROUSEL_CUE = '(This is a carousel section)'

export function isCarouselBlock(blockId: string, variant: string | null | undefined): boolean {
  return (
    (blockId === 'testimonials' && variant === 'carousel') ||
    (blockId === 'hero' && variant === 'slider')
  )
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export type StructureViolationCode =
  | 'body_too_long'
  | 'too_many_splits'
  | 'consecutive_image_blocks'
  | 'too_few_faqs'
  | 'too_many_faqs'
  | 'not_scannable'
  | 'generic_cta'
  | 'missing_cta'
  | 'content_after_faq'

export type StructureViolation = { code: StructureViolationCode; message: string }

export type PageStructureMetrics = {
  bodyWords: number
  sectionCount: number
  splitCount: number
  consecutiveImageBlocks: number
  bulletCount: number
  scannableSections: number
  faqCount: number
  ctaLabel: string | null
  contentAfterFaq: boolean
}

export type StructureSection = {
  blockId: string
  variant?: string
  heading: string
  text: string
}

const TRAILER_MARKERS = [/^-{3,}\s*\n##\s+SEO & AIO Metadata/m, /^##\s+SEO & AIO Metadata/m, /^##\s+Structured Data/m]
const SCANNABLE_BLOCKS = new Set(['checklist-section', 'process-steps', 'feature-grid', 'service-cards', 'industry-cards', 'stats-bar'])

function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

// The generator trailer (SEO & AIO Metadata + Structured Data) is never
// rendered — the template trims at it — so it never counts as page copy.
export function renderedBody(md: string): string {
  let body = stripFrontmatter(md ?? '')
  for (const re of TRAILER_MARKERS) {
    const m = body.match(re)
    if (m?.index !== undefined) body = body.slice(0, m.index)
  }
  return body
}

export function proseWordCount(text: string): number {
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^(icon|photo|query):.*$/gim, ' ')
  return (cleaned.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []).length
}

export function splitSections(md: string): StructureSection[] {
  const body = renderedBody(md)
  const found = findBlockComments(body)
  return found.map((f, i) => {
    const start = f.index + f.raw.length
    const end = i + 1 < found.length ? found[i + 1].index : body.length
    const chunk = body.slice(start, end).replace(/^\s*\n/, '')
    const headingMatch = chunk.match(/^##\s+(.+)$/m)
    const text = headingMatch?.index !== undefined
      ? chunk.slice(headingMatch.index + headingMatch[0].length)
      : chunk
    return {
      blockId: f.comment?.blockId ?? 'unknown',
      variant: f.comment?.variant,
      heading: headingMatch?.[1]?.trim() ?? '',
      text: text.trim(),
    }
  })
}

function isImageSide(s: StructureSection): boolean {
  if (s.blockId === 'content-split') return true
  return s.blockId === 'checklist-section' && !!s.variant && s.variant.startsWith('with-image')
}

function bulletLines(text: string): number {
  return (text.match(/^\s*(?:[-*+]|\d+[.)])\s+\S/gm) ?? []).length
}

function countFaqItems(text: string): number {
  const qBold = (text.match(/^\*\*Q:/gm) ?? []).length
  if (qBold) return qBold
  return (text.match(/^###\s+\S/gm) ?? []).length
}

function lastLinkLabel(text: string): string | null {
  const links = [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
  const last = links.at(-1)
  return last ? last[1].trim() : null
}

export function isGenericCtaLabel(label: string): boolean {
  const norm = label.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim()
  return (GENERIC_CTA_LABELS as readonly string[]).includes(norm)
}

/**
 * Measure a page. `faqCount` supplies the FAQ size when the FAQ is not in the
 * markdown yet (the generator returns it as metadata.faq_block and the
 * deliverable builder inserts it later).
 */
export function measurePageStructure(md: string, opts: { faqCount?: number } = {}): PageStructureMetrics {
  const sections = splitSections(md)
  const faqIndex = sections.findIndex((s) => s.blockId === 'faq-accordion')
  const bodySections = sections.filter((s) => s.blockId !== 'faq-accordion')

  let consecutive = 0
  for (let i = 1; i < sections.length; i++) {
    if (isImageSide(sections[i]) && isImageSide(sections[i - 1])) consecutive++
  }

  const scannable = bodySections.filter(
    (s) => SCANNABLE_BLOCKS.has(s.blockId) || bulletLines(s.text) >= 3,
  ).length

  const ctas = bodySections.filter((s) => s.blockId === 'cta-banner' || s.blockId === 'form')
  const ctaSection = ctas.at(-1)
  const ctaLabel = ctaSection ? lastLinkLabel(ctaSection.text) : null

  const afterFaq = faqIndex >= 0
    ? sections.slice(faqIndex + 1).some((s) => s.blockId !== 'cta-banner' && s.blockId !== 'form')
    : false

  // Pages without annotations (legacy / plain prose) still get a word count.
  const bodyWords = sections.length
    ? bodySections.reduce((n, s) => n + proseWordCount(`${s.heading}\n${s.text}`), 0)
    : proseWordCount(renderedBody(md))

  return {
    bodyWords,
    sectionCount: bodySections.length,
    splitCount: sections.filter((s) => s.blockId === 'content-split').length,
    consecutiveImageBlocks: consecutive,
    bulletCount: bodySections.reduce((n, s) => n + bulletLines(s.text), 0),
    scannableSections: scannable,
    faqCount: faqIndex >= 0 ? countFaqItems(sections[faqIndex].text) : (opts.faqCount ?? 0),
    ctaLabel,
    contentAfterFaq: afterFaq,
  }
}

export function structureViolations(
  m: PageStructureMetrics,
  type: PageIntentType,
): StructureViolation[] {
  const out: StructureViolation[] = []
  const skeleton = usesSkeleton(type)
  if (m.bodyWords > BODY_MAX_WORDS) {
    out.push({
      code: 'body_too_long',
      message: `Body is ${m.bodyWords} words; cut it to ${BODY_TARGET_WORDS.min}-${BODY_TARGET_WORDS.max} (hard max ${BODY_MAX_WORDS}). Move detail into FAQ answers and turn lists into bullets.`,
    })
  }
  if (m.splitCount > MAX_CONTENT_SPLITS) {
    out.push({
      code: 'too_many_splits',
      message: `${m.splitCount} content-split sections; use at most ${MAX_CONTENT_SPLITS}. Convert the rest to checklist-section (standalone), process-steps or a card grid.`,
    })
  }
  if (m.consecutiveImageBlocks > 0) {
    out.push({
      code: 'consecutive_image_blocks',
      message: 'Two image-beside-text sections sit back to back; separate them with a text or list section, or drop one image.',
    })
  }
  if (skeleton && m.faqCount < FAQ_QUESTIONS.min) {
    out.push({
      code: 'too_few_faqs',
      message: `Only ${m.faqCount} FAQ questions; write ${FAQ_QUESTIONS.min}-${FAQ_QUESTIONS.max} that carry the detail cut from the body.`,
    })
  }
  if (m.faqCount > FAQ_QUESTIONS.max) {
    out.push({ code: 'too_many_faqs', message: `${m.faqCount} FAQ questions; keep the best ${FAQ_QUESTIONS.max}.` })
  }
  if (skeleton && m.scannableSections < MIN_SCANNABLE_SECTIONS) {
    out.push({
      code: 'not_scannable',
      message: `Only ${m.scannableSections} scannable section(s); at least ${MIN_SCANNABLE_SECTIONS} should be bullets, steps or cards.`,
    })
  }
  if (skeleton && !m.ctaLabel) {
    out.push({ code: 'missing_cta', message: 'No closing call to action with a button link; end with a page-specific cta-banner.' })
  } else if (m.ctaLabel && isGenericCtaLabel(m.ctaLabel)) {
    out.push({
      code: 'generic_cta',
      message: `CTA button "${m.ctaLabel}" is generic; name the outcome for this reader (e.g. "Book a job-costing review").`,
    })
  }
  if (m.contentAfterFaq) {
    out.push({ code: 'content_after_faq', message: 'Content sections follow the FAQ; only the final CTA may come after it.' })
  }
  return out
}
