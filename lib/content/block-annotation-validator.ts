// ---------------------------------------------------------------------------
// Block Annotation Validator
// Pure, sync, no I/O. Validates <!-- block: --> annotations in generated
// page content against the rules defined in raw-docs/phaseII/block-annotation-spec.md
// (Validator: Block Assignment Rules section).
// ---------------------------------------------------------------------------

import { BLOCK_CATALOG, BLOCK_IDS, blockSpec, blockVariantValues, blockVariantValuesAt, variantValuesAt, type BlockSpec } from './block-catalog'
import { parseBlockComment, rendersAsSection, templateSectionPattern } from '@/lib/editor/block-annotation'
import { MAX_CONTENT_SPLITS } from './page-structure'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BlockAnnotation = {
  blockId: string
  variant?: string
  image?: string
  theme?: string
  headingText: string
  sectionContent: string // raw markdown body of the section (heading excluded)
  position: number // 0-based section index
}

export type ValidationError = {
  position: number
  headingText: string
  blockId: string
  reason: string
  suggestion?: string // block ID we'd suggest instead
  fix?: 'add-image' // the block is fine — it just needs an image: attribute
}

export type AnnotationCoercion = {
  position: number
  blockId: string
  originalVariant: string
  coercedVariant: string
}

export type ValidationResult = {
  passed: boolean // true if no fatal errors (warnings don't affect this)
  warnings: string[]
  errors: ValidationError[]
  coercions: AnnotationCoercion[] // invalid variants that were auto-fixed
}

// ---------------------------------------------------------------------------
// Block catalog — the template contract mirror (lib/content/block-catalog.ts).
// ---------------------------------------------------------------------------

/**
 * The block catalog a content model may pick from, as a compact
 * `id (v1|v2), id, …` string, derived from the contract so prompt hints can't
 * drift from the validator. Only `insertable` blocks: page openers
 * (frontmatter), platform-inserted blocks (faq-accordion, contact-info, map,
 * pricing pages) and config-driven blocks (booking, resource-list) are left out.
 */
export function blockCatalogHint(opts?: { templateVersion: string | null | undefined }): string {
  // With opts, only the variants a template at that version renders (null ⇒
  // baseline); without, every contract variant (the generation prompts).
  const values = (spec: BlockSpec) =>
    opts ? variantValuesAt(spec.variants, opts.templateVersion) : spec.variants.map((v) => v.value)
  return BLOCK_IDS.map((id) => [id, BLOCK_CATALOG[id] as BlockSpec] as const)
    .filter(([, spec]) => spec.insertable)
    .map(([id, spec]) => {
      const vs = values(spec)
      return vs.length ? `${id} (${vs.join('|')})` : id
    })
    .join(', ')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isFrontmatterBlock = (blockId: string) => blockSpec(blockId)?.placement === 'frontmatter'

/**
 * Count pricing-tier markers in a section body.
 * A tier is signaled by:
 *  - A subheading line (## or ###)
 *  - A strong-emphasis price like **$X**
 *  - A line that starts with a price ($\d+)
 */
function countPricingTiers(content: string): number {
  const lines = content.split('\n')
  let count = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^#{2,3}\s+/.test(trimmed)) { count++; continue }
    if (/\*\*\$\d+/.test(trimmed)) { count++; continue }
    if (/^\$\d+/.test(trimmed)) { count++ }
  }
  return count
}

/**
 * Count named person markers in a section body.
 * A person is signaled by:
 *  - A subheading line (###)
 *  - A **Name** strong-emphasis pattern
 */
function countPeopleMarkers(content: string): number {
  const lines = content.split('\n')
  let count = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^###\s+/.test(trimmed)) { count++; continue }
    if (/\*\*[A-Z][a-zA-Z\s]+\*\*/.test(trimmed)) { count++ }
  }
  return count
}

// ---------------------------------------------------------------------------
// Core validator
// ---------------------------------------------------------------------------

export function validateBlockAnnotations(
  annotations: BlockAnnotation[],
  _pageUrl: string,
  _faqBlock: { question: string; answer: string }[],
  // With a template version, a variant newer than the site's template counts
  // as invalid (coerced like any other); without one, every contract variant
  // is valid (fresh sites get the latest template).
  opts?: { templateVersion: string | null },
): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: string[] = []
  const coercions: AnnotationCoercion[] = []
  const total = annotations.length

  for (let i = 0; i < total; i++) {
    const ann = annotations[i]
    const { blockId, variant, sectionContent, position, headingText } = ann

    // ------------------------------------------------------------------
    // Fatal rule 1: hero/hero-split/page-header as inline annotation
    // ------------------------------------------------------------------
    if (isFrontmatterBlock(blockId)) {
      const suggestion = blockId === 'page-header' ? 'intro-text' : 'content-prose'
      errors.push({
        position,
        headingText,
        blockId,
        reason:
          'hero/hero-split/page-header may only appear in frontmatter, not as inline section annotations',
        suggestion,
      })
      continue // no point running further rules on this annotation
    }

    // ------------------------------------------------------------------
    // Fatal rule 2: platform-inserted / config-driven blocks. faq-accordion
    // is auto-appended from faq_block; contact-info, map and the pricing
    // blocks are inserted by the builders; booking and resource-list need
    // site config. None is chosen during content generation.
    // ------------------------------------------------------------------
    const spec = blockSpec(blockId)
    if (spec && !spec.insertable) {
      errors.push({
        position,
        headingText,
        blockId,
        reason:
          blockId === 'faq-accordion'
            ? 'faq-accordion is auto-appended by the deliverable builder — do not select it during content generation'
            : `${blockId} is inserted by the platform, not selected during content generation`,
        suggestion: 'content-prose',
      })
      continue
    }

    // ------------------------------------------------------------------
    // Fatal rule 3: invalid block ID
    // ------------------------------------------------------------------
    if (!spec) {
      errors.push({
        position,
        headingText,
        blockId,
        reason: `unknown block ID '${blockId}'`,
        suggestion: 'content-prose',
      })
      continue
    }

    // ------------------------------------------------------------------
    // Coercion rule 4: invalid variant (downgrade from fatal — auto-fix to first valid)
    // ------------------------------------------------------------------
    const variants = opts ? blockVariantValuesAt(blockId, opts.templateVersion) : blockVariantValues(blockId)
    if (variant !== undefined && variants.length > 0) {
      if (!variants.includes(variant)) {
        // First listed variant (the contract keeps the generator's preferred
        // order), not the template default — e.g. checklist → with-image.
        const fallback = variants[0]
        coercions.push({
          position,
          blockId,
          originalVariant: variant,
          coercedVariant: fallback,
        })
        warnings.push(
          `invalid variant '${variant}' on '${blockId}' at position ${position} — auto-coerced to '${fallback}' (valid: ${variants.join(', ')})`
        )
        // Don't continue — remaining content rules can still run on this section
      }
    }
    if (ann.theme !== undefined && !spec.themes.includes(ann.theme)) {
      warnings.push(
        `theme '${ann.theme}' on '${blockId}' at position ${position} is ignored by the template (supported: ${spec.themes.join(', ') || 'none'})`
      )
    }

    // ------------------------------------------------------------------
    // Fatal rule 5: stats-bar without numbers
    // ------------------------------------------------------------------
    if (blockId === 'stats-bar' && !/\d/.test(sectionContent)) {
      errors.push({
        position,
        headingText,
        blockId,
        reason: 'stats-bar section must contain at least one numeric value',
        suggestion: 'feature-grid',
      })
    }

    // ------------------------------------------------------------------
    // Fatal rule 6: pricing without tiers
    // ------------------------------------------------------------------
    if (blockId === 'pricing') {
      const tierCount = countPricingTiers(sectionContent)
      if (tierCount < 2) {
        errors.push({
          position,
          headingText,
          blockId,
          reason: 'pricing section must contain at least 2 tier definitions',
          suggestion: 'feature-grid',
        })
      }
    }

    // ------------------------------------------------------------------
    // Fatal rule 7: team-grid without people
    // ------------------------------------------------------------------
    if (blockId === 'team-grid') {
      const peopleCount = countPeopleMarkers(sectionContent)
      if (peopleCount < 2) {
        errors.push({
          position,
          headingText,
          blockId,
          reason: 'team-grid section must reference at least 2 named individuals',
          suggestion: 'content-cards',
        })
      }
    }

    // ------------------------------------------------------------------
    // Fatal rule 8: form at non-terminal position
    // ------------------------------------------------------------------
    if (blockId === 'form' && position < total - 2) {
      errors.push({
        position,
        headingText,
        blockId,
        reason: 'form must be in the last 2 sections of the page',
        suggestion: 'cta-banner',
      })
    }

    // ------------------------------------------------------------------
    // Fatal rule 9: cta-banner at position 0
    // ------------------------------------------------------------------
    if (blockId === 'cta-banner' && position === 0) {
      errors.push({
        position,
        headingText,
        blockId,
        reason: 'cta-banner cannot be the first section of a page',
        suggestion: 'intro-text',
      })
    }

    // ------------------------------------------------------------------
    // Warning rule 10: back-to-back image-beside-text sections (the zigzag
    // rhythm page-structure.ts retires)
    // ------------------------------------------------------------------
    if (i > 0 && isImageSideBlock(blockId, variant) && isImageSideBlock(annotations[i - 1].blockId, annotations[i - 1].variant)) {
      warnings.push(
        `image-beside-text sections at positions ${annotations[i - 1].position} and ${position} sit back to back — separate them with a list or text section, or drop one image`,
      )
    }

    // ------------------------------------------------------------------
    // Warning rule 12: intro-text after intro-text
    // ------------------------------------------------------------------
    if (blockId === 'intro-text' && i > 0 && annotations[i - 1].blockId === 'intro-text') {
      warnings.push(
        `consecutive intro-text sections at positions ${annotations[i - 1].position} and ${position} — likely a structural issue`,
      )
    }

    // ------------------------------------------------------------------
    // Warning rule 13: content-prose with short copy
    // ------------------------------------------------------------------
    if (blockId === 'content-prose') {
      const wordCount = sectionContent.split(/\s+/).filter(Boolean).length
      if (wordCount < 150) {
        warnings.push(
          `content-prose at position ${position} has fewer than 150 words — consider intro-text instead`,
        )
      }
    }

    // ------------------------------------------------------------------
    // Error rule 14: mandatory images. Images are structural for these
    // blocks — a miss triggers the single retry, and ensureBlockMedia
    // injects a deterministic placeholder as the final backstop.
    // ------------------------------------------------------------------
    if (blockId === 'content-split' && !ann.image) {
      errors.push({
        position,
        headingText,
        blockId,
        reason: 'content-split requires an image: + query: on its annotation (imagery is mandatory)',
        fix: 'add-image',
      })
    }
    if (
      blockId === 'checklist-section' &&
      !ann.image &&
      // Every image-bearing checklist variant (legacy with-image, explicit
      // with-image-right/left, or the no-variant default) needs a photo;
      // only standalone is exempt.
      ann.variant !== 'standalone'
    ) {
      errors.push({
        position,
        headingText,
        blockId,
        reason: 'checklist-section (with-image) requires an image: + query: on its annotation',
        fix: 'add-image',
      })
    }
    if (blockId === 'cta-banner' && ann.variant === 'image-bg' && !ann.image) {
      errors.push({
        position,
        headingText,
        blockId,
        reason: 'image-bg cta-banner requires an image: + query: on its annotation',
        fix: 'add-image',
      })
    }

    // ------------------------------------------------------------------
    // Warning rule 15: items missing icons on icon-bearing card blocks.
    // Warning only — the template renders a CheckCircle fallback, and
    // icon misses shouldn't consume the retry that image misses need.
    // ------------------------------------------------------------------
    if (['feature-grid', 'industry-cards', 'service-cards'].includes(blockId)) {
      const lines = sectionContent.split('\n')
      let iconless = 0
      for (let li = 0; li < lines.length; li++) {
        const isItemTitle =
          /^###\s+/.test(lines[li].trim()) || /^\*\*[^*\n]+\*\*\s*$/.test(lines[li].trim())
        if (!isItemTitle) continue
        // Icon bullets (- IconName: **Title** — …) carry their own icon.
        let hasIcon = false
        for (let lj = li + 1; lj < lines.length; lj++) {
          if (lines[lj].trim() === '') continue
          hasIcon = /^icon:\s*[A-Za-z][A-Za-z0-9]*\s*$/.test(lines[lj].trim())
          break
        }
        if (!hasIcon) iconless++
      }
      if (iconless > 0) {
        warnings.push(
          `${blockId} at position ${position} has ${iconless} item(s) without an icon: line — template falls back to CheckCircle`,
        )
      }
    }
  }

  // -----------------------------------------------------------------------
  // Warning rule 11: no CTA or form on pages with 5+ sections
  // -----------------------------------------------------------------------
  if (total >= 5) {
    const lastTwo = annotations.slice(-2)
    const hasCtaOrForm = lastTwo.some(
      (a) => a.blockId === 'cta-banner' || a.blockId === 'form',
    )
    if (!hasCtaOrForm) {
      warnings.push(
        "page has 5+ sections but doesn't end with cta-banner or form",
      )
    }
  }

  const splitCount = annotations.filter((a) => a.blockId === 'content-split').length
  if (splitCount > MAX_CONTENT_SPLITS) {
    warnings.push(
      `${splitCount} content-split sections — use at most ${MAX_CONTENT_SPLITS}; convert the rest to checklist-section (standalone), process-steps or a card grid`,
    )
  }

  return {
    passed: errors.length === 0,
    warnings,
    errors,
    coercions,
  }
}

// ---------------------------------------------------------------------------
// applyCoercions — given the raw markdown body and coercions from validation,
// rewrite the offending `<!-- block: <id> | variant: <bad> ... -->` annotations
// in place so the stored content_markdown carries valid variants downstream.
//
// Conservative: only substitutes the `variant: <oldValue>` token inside an
// annotation tag for the matching block-id. Other annotation parts (image,
// extra keys) are preserved. If a coercion doesn't match anything in the
// markdown (e.g. someone hand-edited the annotation between parse and apply),
// it's a no-op for that entry.
// ---------------------------------------------------------------------------
function isImageSideBlock(blockId: string, variant: string | undefined): boolean {
  if (blockId === 'content-split') return true
  return blockId === 'checklist-section' && !!variant && variant.startsWith('with-image')
}

export function applyCoercions(markdown: string, coercions: AnnotationCoercion[]): string {
  let result = markdown
  for (const c of coercions) {
    // Match the annotation containing this exact blockId + originalVariant
    // pair, then rewrite the variant token. Escape regex-special chars in
    // the original variant just in case.
    const escapedVariant = c.originalVariant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(
      `(<!--\\s*block:\\s*${c.blockId}\\s*\\|\\s*variant:\\s*)${escapedVariant}(\\s*(?:\\||-->))`,
      'g'
    )
    result = result.replace(pattern, `$1${c.coercedVariant}$2`)
  }
  return result
}

// ---------------------------------------------------------------------------
// parseBlockAnnotations
// ---------------------------------------------------------------------------

/**
 * Parse a full page markdown body into an array of BlockAnnotation entries —
 * exactly the sections the template renders (its SECTION_PATTERN via the
 * block-annotation codec: variant | image | alt | query | theme, then a
 * `## heading`). The caller must have already stripped the YAML frontmatter.
 */
export function parseBlockAnnotations(body: string): BlockAnnotation[] {
  return [...body.matchAll(templateSectionPattern())].map((m, position) => ({
    blockId: m[1],
    variant: m[2] ?? undefined,
    image: m[3] ?? undefined,
    theme: m[6] ?? undefined,
    headingText: m[7].trim(),
    sectionContent: m[8] ?? '',
    position,
  }))
}

// ---------------------------------------------------------------------------
// Edit-time syntax check
// Lightweight: are every block's id, variant and theme valid against the
// catalog? Unlike validateBlockAnnotations (which also runs content heuristics
// like "stats-bar needs a number" and positional rules), this only flags what
// an interactive layout edit can break. Pass the page body with frontmatter
// already stripped.
// ---------------------------------------------------------------------------

export type AnnotationIssueKind =
  | 'unknown-block'
  | 'frontmatter-inline'
  | 'invalid-variant'
  | 'variant-too-new'
  | 'invalid-theme'
  | 'unparseable'
  | 'stray'

export type AnnotationIssue = {
  kind: AnnotationIssueKind
  blockId: string
  /** The offending variant/theme value, when the issue is about one. */
  value?: string
  heading: string
  message: string
}

// Annotation lines the template's split would see (`<!-- block:` at line start),
// plus near-misses in other spacing, so a mangled edit is caught too.
const ANNOTATION_LINE_RE = /^<!--\s*block:[^\n]*$/gm

// Lines the template will NOT render as written: a mangled annotation (wrong
// field order, uppercase, stray keys — it drops the section) or a stray one
// with no `## heading` after it (the text below it is dropped).
function unrenderedAnnotationIssues(body: string): AnnotationIssue[] {
  const issues: AnnotationIssue[] = []
  for (const m of body.matchAll(ANNOTATION_LINE_RE)) {
    const line = m[0].replace(/\r$/, '')
    const c = parseBlockComment(line)
    const blockId = c?.blockId ?? ''
    if (!c || !c.strict) {
      issues.push({
        kind: 'unparseable',
        blockId,
        value: line,
        heading: '',
        message: `Annotation ${line} does not match the template grammar (<!-- block: id | variant: v | image: f | alt: "…" | query: "…" | theme: t -->, fields in that order, lowercase values), so that section would not render.`,
      })
      continue
    }
    const after = body.slice((m.index ?? 0) + m[0].length + 1)
    if (!rendersAsSection(line, after)) {
      issues.push({
        kind: 'stray',
        blockId,
        value: line,
        heading: '',
        message: `Annotation ${line} is not followed by a "## Heading" line, so the template drops the text after it. Put the heading directly under the annotation.`,
      })
    }
  }
  return issues
}

/**
 * `templateVersion` (optional): when given, a contract variant newer than the
 * site's template (`since` > version; null ⇒ baseline) is an issue too — the
 * old template would silently render its default. Omitted ⇒ any contract
 * variant is valid (generation, which targets the current template).
 */
export type AnnotationCheckOpts = { templateVersion: string | null | undefined }

export function annotationSyntaxIssues(body: string, opts?: AnnotationCheckOpts): AnnotationIssue[] {
  const issues: AnnotationIssue[] = unrenderedAnnotationIssues(body)
  for (const ann of parseBlockAnnotations(body)) {
    const { blockId, headingText: heading } = ann
    const spec = blockSpec(blockId)
    if (!spec) {
      issues.push({
        kind: 'unknown-block',
        blockId,
        heading,
        message: `Unknown block id "${blockId}" on section "${heading}". Valid ids: ${blockCatalogHint()}.`,
      })
      continue
    }
    if (spec.placement === 'frontmatter') {
      issues.push({
        kind: 'frontmatter-inline',
        blockId,
        heading,
        message: `"${blockId}" on section "${heading}" is a page opener: set it with the frontmatter hero / hero_variant fields, not a body annotation.`,
      })
      continue
    }
    const variants = blockVariantValues(blockId)
    if (ann.variant !== undefined && !variants.includes(ann.variant)) {
      issues.push({
        kind: 'invalid-variant',
        blockId,
        value: ann.variant,
        heading,
        message: variants.length
          ? `Invalid variant "${ann.variant}" for block "${blockId}" on section "${heading}". Valid variants: ${variants.join(', ')}.`
          : `Block "${blockId}" on section "${heading}" has no variants; remove "variant: ${ann.variant}".`,
      })
    } else if (ann.variant !== undefined && opts && !variantValuesAt(spec.variants, opts.templateVersion).includes(ann.variant)) {
      const since = spec.variants.find((v) => v.value === ann.variant)?.since
      const available = variantValuesAt(spec.variants, opts.templateVersion)
      issues.push({
        kind: 'variant-too-new',
        blockId,
        value: ann.variant,
        heading,
        message: `Variant "${ann.variant}" for block "${blockId}" on section "${heading}" needs template ${since ?? 'a newer release'}; this site's template doesn't render it yet. Use one of: ${available.join(', ') || '(none)'}.`,
      })
    }
    if (ann.theme !== undefined && !spec.themes.includes(ann.theme)) {
      issues.push({
        kind: 'invalid-theme',
        blockId,
        value: ann.theme,
        heading,
        message: spec.themes.length
          ? `Invalid theme "${ann.theme}" for block "${blockId}" on section "${heading}". Valid themes: ${spec.themes.join(', ')}.`
          : `Block "${blockId}" on section "${heading}" does not support a theme; remove "theme: ${ann.theme}".`,
      })
    }
  }
  return issues
}

/** Every syntax issue on the page, as messages. Returns [] when clean. */
export function validateAnnotationSyntax(body: string): string[] {
  return annotationSyntaxIssues(body).map((i) => i.message)
}

/**
 * Only the issues an edit INTRODUCES: issues in `afterBody` beyond those
 * already in `beforeBody`, matched by (kind, block, value) — not heading, so a
 * copy edit on a section with a legacy `variant: default` still saves, while a
 * new invalid variant (or a second copy of the same bad value) is rejected.
 * Returns [] when the edit adds no new annotation problem.
 */
export function validateAnnotationDelta(beforeBody: string, afterBody: string, opts?: AnnotationCheckOpts): string[] {
  const key = (i: AnnotationIssue) => `${i.kind}\u0000${i.blockId}\u0000${i.value ?? ''}`
  const budget = new Map<string, number>()
  for (const i of annotationSyntaxIssues(beforeBody, opts)) budget.set(key(i), (budget.get(key(i)) ?? 0) + 1)
  const introduced: string[] = []
  for (const i of annotationSyntaxIssues(afterBody, opts)) {
    const left = budget.get(key(i)) ?? 0
    if (left > 0) budget.set(key(i), left - 1)
    else introduced.push(i.message)
  }
  return introduced
}

// ---------------------------------------------------------------------------
// Page opener (frontmatter hero / hero_variant) — warnings only: the template
// falls back safely (unknown hero → page header; unknown variant → default).
// ---------------------------------------------------------------------------

export function heroPairWarnings(hero: string | undefined, heroVariant: string | undefined): string[] {
  const h = hero?.trim() || undefined
  const v = heroVariant?.trim() || undefined
  if (!h) {
    return v ? [`hero_variant "${v}" is set without hero; the page renders a page header and ignores it. Set hero (hero or hero-split) too.`] : []
  }
  const spec = blockSpec(h)
  if (!spec || spec.placement !== 'frontmatter') {
    return [`hero "${h}" is not a page opener (hero, hero-split, page-header); the page renders a page header.`]
  }
  if (!v) return []
  const variants = blockVariantValues(h)
  if (variants.length === 0) return [`hero_variant "${v}" is ignored for "${h}".`]
  if (variants.includes(v)) return []
  if (h === 'hero' && (v === 'image-right' || v === 'image-left')) {
    return [`hero_variant "${v}" renders as a full-bleed image hero; use hero: hero-split with hero_variant: ${v} for a split layout.`]
  }
  return [`hero_variant "${v}" is not valid for "${h}" (valid: ${variants.join(', ')}); the template renders "${spec.default}".`]
}

// ---------------------------------------------------------------------------
// buildCorrectionPrompt
// ---------------------------------------------------------------------------

/**
 * Build a targeted re-prompt string for a single fatal ValidationError.
 * The content-generator caller sends this to Claude instead of regenerating
 * the full page.
 */
export function buildCorrectionPrompt(
  error: ValidationError,
  sectionContent: string,
): string {
  const truncated =
    sectionContent.length > 800
      ? sectionContent.slice(0, 800) + '\n[...truncated]'
      : sectionContent

  const suggestion = error.suggestion ?? 'content-prose'

  return `The following section annotation is invalid:
Section ${error.position} ("${error.headingText}").
Current annotation: <!-- block: ${error.blockId} -->
Issue: ${error.reason}

Current section content:
${truncated}

Suggested replacement: <!-- block: ${suggestion} -->

Return ONLY the corrected annotation line and the unchanged heading + content for this section. Do not regenerate the rest of the page.`
}
