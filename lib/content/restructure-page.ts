import { anthropic } from '@ai-sdk/anthropic'
import type { SessionSchema } from '@/types/session-schema'
import { splitFile, serializeFile } from '@/lib/editor/frontmatter'
import { getFaqBlock, setFaqBlock, type FaqItem } from '@/lib/editor/structured-fields'
import { parseFaqFromBody, setFaqAccordionBody } from '@/lib/editor/page-body'
import { composeAiEditCommit, splitForModel } from '@/lib/editor/ai-edit-trailer'
import { checkEditAnnotations } from '@/lib/editor/apply-edit'
import { findBlockComments } from '@/lib/editor/block-annotation'
import { validateFrontmatterYaml } from '@/lib/editor/frontmatter-yaml'
import { buildBrandVoiceBlock, buildFirmContext } from './brand-voice'
import { buildNoGoPromptBlock, findNoGoHits } from './no-go-match'
import { applyCoercions, blockCatalogHint, parseBlockAnnotations, validateBlockAnnotations } from './block-annotation-validator'
import { ANTI_SLOP_RULES } from './anti-slop-validator'
import { buildCachedMessages, extractCacheUsage } from './cache-control'
import { generateJson } from './json-generation'
import { BACKGROUND_MEDIUM_PROVIDER_OPTIONS, OUTLINE_PROVIDER_OPTIONS, PUBLISHED_CONTENT_MODEL } from './generation-tuning'
import { recordTokenUsage } from './token-usage'
import { enforceVerbatimBios } from './verbatim-bios'
import type { DiffLine } from '@/lib/design/design-md-ui'
import { CARD_ICON_NAMES } from './card-icons'
import { resolvePageIntent } from './page-intent'
import { realStrings } from './schema-coerce'
import {
  FAQ_ANSWER_WORDS,
  FAQ_QUESTIONS,
  PAGE_STRUCTURE_RULES,
  measurePageStructure,
  renderedBody,
  skeletonPromptFor,
  structureTypeForUrl,
  structureViolations,
  type BodyBudget,
  type PageStructureMetrics,
  type StructureViolation,
} from './page-structure'

// "Restructure to new layout": rewrite an existing published page into the
// user-first skeleton (page-structure.ts) WITHOUT writing anything. The editor
// shows current vs proposed side by side; only an explicit Accept commits.
// The model rewrites the body + FAQ only; frontmatter (SEO fields, hero), the
// hidden generator trailer and every image annotation are carried over.

export type RestructureProposal = {
  proposed: string
  before: PageStructureMetrics
  after: PageStructureMetrics
  violationsBefore: StructureViolation[]
  violationsAfter: StructureViolation[]
  coverage: ContentCoverage
}

// Body of POST /api/edit/[id]/restructure (propose).
export interface RestructureProposeResponse {
  current: string
  currentSha: string
  proposed: string
  metrics: { before: PageStructureMetrics; after: PageStructureMetrics }
  violationsBefore: StructureViolation[]
  violationsAfter: StructureViolation[]
  diff: DiffLine[]
  // The page has manual ("via admin") saves the rewrite could undo.
  handEdited: boolean
  // Where the current page's links and key terms ended up.
  coverage: ContentCoverage
  budget: BodyBudget
}

// The accept commit message starts with this; its presence in a page's git
// history is what marks the page as already restructured (one-time rule).
export const RESTRUCTURE_COMMIT_PREFIX = 'Restructure '

export function isRestructureCommit(message: string): boolean {
  return message.startsWith(RESTRUCTURE_COMMIT_PREFIX) && /\bvia AI\b/.test(message.split('\n')[0])
}

export type RestructureStatus = { restructured: boolean; at: string | null; by: string | null }

/** Whether a page's history (newest first) holds an accepted restructure. Pure. */
export function restructureStatus(
  commits: Array<{ message: string; date: string | null; authorName: string | null }>,
): RestructureStatus {
  const hit = commits.find((c) => isRestructureCommit(c.message))
  return hit ? { restructured: true, at: hit.date, by: hit.authorName } : { restructured: false, at: null, by: null }
}

export type TermPlacement = 'body' | 'faq' | 'missing'
export type ContentCoverage = {
  droppedLinks: string[]
  terms: Array<{ term: string; where: TermPlacement }>
}

type ModelAnswer = { body: string; faq: FaqItem[]; faqHeading?: string }

const FAQ_MARKER = '<!-- block: faq-accordion -->'

function pageTitle(fm: ReturnType<typeof splitFile>['frontmatter']): string {
  const raw = fm?.fields.hero_headline ?? fm?.fields.title ?? ''
  return raw.trim().replace(/^(["'])(.*)\1$/, '$2').split(' | ')[0].trim()
}

// The page's FAQ (frontmatter is the source of truth; legacy pages only have it
// in the body) and the body with the faq-accordion section removed.
export function splitOutFaq(file: string): { body: string; faq: FaqItem[]; heading: string | null } {
  const { frontmatter, body } = splitFile(splitForModel(file).visible)
  const fromFm = frontmatter ? getFaqBlock(frontmatter) : []
  const faq = fromFm.length ? fromFm : parseFaqFromBody(body)
  const heading = body.match(/<!--\s*block:\s*faq-accordion[^\n]*\n##\s+(.+)/)?.[1]?.trim() ?? null
  return { body: setFaqAccordionBody(body, [], ''), faq, heading }
}

// Image annotations the page already has, keyed by filename. A restructure may
// keep, move or drop them but never invent one (no file would exist for it).
export function existingImages(body: string): Set<string> {
  const out = new Set<string>()
  for (const f of findBlockComments(body)) if (f.comment?.image) out.add(f.comment.image)
  return out
}

function faqSection(heading: string, items: FaqItem[]): string {
  const pairs = items.map((f) => `**Q: ${f.question}**\nA: ${f.answer}`).join('\n\n')
  return `${FAQ_MARKER}\n## ${heading}\n\n${pairs}`
}

// FAQ goes just before the final cta-banner/form (deliverable-builder's
// appendFaqBlock placement), else at the end.
export function placeFaq(body: string, heading: string, items: FaqItem[]): string {
  const trimmed = body.trim()
  if (!items.length) return `${trimmed}\n`
  const comments = findBlockComments(trimmed)
  const last = [...comments].reverse().find((c) => c.comment?.blockId === 'cta-banner' || c.comment?.blockId === 'form')
  const section = faqSection(heading, items)
  if (!last) return `${trimmed}\n\n${section}\n`
  return `${trimmed.slice(0, last.index).trimEnd()}\n\n${section}\n\n${trimmed.slice(last.index)}\n`
}

/** Assemble the proposed file from the model's answer. Pure. */
export function composeProposal(
  file: string,
  path: string,
  answer: ModelAnswer,
  schema: SessionSchema,
): string {
  const { frontmatter } = splitFile(file)
  const { trailer } = splitForModel(file)
  const { heading } = splitOutFaq(file)
  const faqHeading =
    answer.faqHeading?.trim() || heading || `Frequently Asked Questions About ${pageTitle(frontmatter) || 'This Page'}`
  const cleanedBody = enforceVerbatimBios(setFaqAccordionBody(answer.body, [], ''), schema)
  const body = placeFaq(cleanedBody, faqHeading, answer.faq)
  const visible = serializeFile({
    frontmatter: frontmatter ? setFaqBlock(frontmatter, answer.faq) : null,
    body: `\n${body}`,
  })
  return composeAiEditCommit(visible, trailer, path)
}

function internalLinks(md: string): Set<string> {
  const out = new Set<string>()
  for (const m of renderedBody(md).matchAll(/\]\((\/[^)\s#?]*)/g)) {
    out.add(m[1].length > 1 ? m[1].replace(/\/+$/, '') : m[1])
  }
  return out
}

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim()

// Terms worth keeping for search/LLMs: the niche's own keywords plus anything
// the current page set in bold. Only terms the current page actually uses.
function keyTerms(current: string, nicheKeywords: string[]): string[] {
  const body = norm(renderedBody(current))
  const bold = [...renderedBody(current).matchAll(/\*\*([^*\n]{3,60})\*\*/g)]
    .map((m) => m[1].replace(/^Q:\s*/, '').replace(/[.:?!]+$/, '').trim())
    .filter((t) => t.split(/\s+/).length <= 6)
  const seen = new Set<string>()
  return [...nicheKeywords, ...bold].filter((t) => {
    const k = norm(t)
    if (!k || seen.has(k) || !body.includes(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Where the current page's internal links and key terms ended up in the
 * proposal: kept in the body, moved to the FAQ, or missing. Nothing useful to
 * search/LLMs should vanish (it belongs in the FAQ if the body drops it). Pure.
 */
export function contentCoverage(current: string, proposed: string, nicheKeywords: string[] = []): ContentCoverage {
  const after = internalLinks(proposed)
  const droppedLinks = [...internalLinks(current)].filter((l) => !after.has(l))
  const { body, faq } = splitOutFaq(proposed)
  const bodyText = norm(renderedBody(body))
  const faqText = norm(faq.map((f) => `${f.question} ${f.answer}`).join(' '))
  const terms = keyTerms(current, nicheKeywords).map((term) => {
    const k = norm(term)
    const where: TermPlacement = bodyText.includes(k) ? 'body' : faqText.includes(k) ? 'faq' : 'missing'
    return { term, where }
  })
  return { droppedLinks, terms }
}

/** Problems that make a proposal unsafe to show. Pure. */
export function proposalErrors(
  current: string,
  proposed: string,
  opts: { templateVersion: string | null; noGoPhrases: string[] },
): string[] {
  const errors: string[] = []
  const yaml = validateFrontmatterYaml(proposed)
  if (yaml) errors.push(yaml)
  errors.push(...checkEditAnnotations(current, proposed, { templateVersion: opts.templateVersion }).errors)
  const known = existingImages(splitFile(current).body)
  for (const f of findBlockComments(splitFile(proposed).body)) {
    const img = f.comment?.image
    if (img && !known.has(img)) errors.push(`Image "${img}" is not on the current page; reuse an existing image annotation exactly or drop the image.`)
  }
  for (const hit of findNoGoHits(splitFile(proposed).body, opts.noGoPhrases)) {
    errors.push(`Banned phrase "${hit}" appears; rewrite it out.`)
  }
  for (const link of contentCoverage(current, proposed).droppedLinks) {
    errors.push(`Internal link ${link} was dropped; keep it in the body or in an FAQ answer.`)
  }
  return errors
}

/**
 * Rewrite any variant the model invented (e.g. intro-text "standard") to the
 * block's default, the same coercion the page writer applies, so one bad
 * variant never sinks a whole proposal. Pure.
 */
export function coerceVariants(body: string, templateVersion: string | null): string {
  const { coercions } = validateBlockAnnotations(parseBlockAnnotations(body), '', [], { templateVersion })
  return coercions.length ? applyCoercions(body, coercions) : body
}

function parseAnswer(raw: unknown): ModelAnswer | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { body?: unknown; faq?: unknown; faq_heading?: unknown }
  if (typeof r.body !== 'string' || !r.body.trim()) return null
  const faq = Array.isArray(r.faq)
    ? r.faq.filter(
        (f): f is FaqItem =>
          !!f && typeof (f as FaqItem).question === 'string' && typeof (f as FaqItem).answer === 'string',
      )
    : []
  const faqHeading = typeof r.faq_heading === 'string' && r.faq_heading.trim() ? r.faq_heading.trim().slice(0, 120) : undefined
  return { body: r.body, faq: faq.map((f) => ({ question: f.question.trim(), answer: f.answer.trim() })), faqHeading }
}

function staticPrefix(schema: SessionSchema, noGoPhrases: string[], templateVersion: string | null): string {
  const noGo = buildNoGoPromptBlock(noGoPhrases)
  return `You restructure an existing page on a CPA firm's website into a leaner, reader-first layout. You are editing, not writing from scratch.

${buildBrandVoiceBlock(schema)}

${buildFirmContext(schema)}

${PAGE_STRUCTURE_RULES}

HARD RULES:
- Use ONLY facts already on the page or in the firm context above. Never add a credential, number, client, service, location or claim that isn't there.
- Nothing substantive is lost: detail you cut from the body moves into an FAQ answer. Keep every internal link that still fits.
- Keep the block annotation format exactly: an HTML comment "<!-- block: id | variant: v | image: x.jpg | alt: "..." | query: "..." -->" on the line before every "## heading". Field order: block, variant, image, alt, query, theme.
- Use only these block ids and variants (what this site's template renders): ${blockCatalogHint({ templateVersion })}. Omit "variant:" rather than invent one.
- Images: you may keep, move or drop an existing image annotation (copy its image, alt and query exactly). Never invent a new image filename. A content-split must carry an image; if none is left for it, use a different block.
- Item format: in checklist-section use "- " bullets; in process-steps, feature-grid and service-cards introduce each item with a "### Title" line (feature-grid/service-cards items also need an "icon:" line: keep existing ones; new ones from ${CARD_ICON_NAMES.join(', ')}, never repeated within a block).
- Do NOT include the FAQ in "body", and never write a heading starting "Frequently Asked Questions" or "FAQ" in it. The FAQ goes in "faq" and is placed automatically before the final CTA.
- Keep any team member bios exactly as written.
- Do not include frontmatter or any "SEO & AIO Metadata" / "Structured Data" section.

${ANTI_SLOP_RULES}${noGo ? `\n\n${noGo}` : ''}

OUTPUT: JSON only, no prose:
{ "body": "the full restructured page body in markdown with block annotations", "faq": [{ "question": "...", "answer": "..." }], "faq_heading": "only when the page notes ask for one, else omit" }
The faq has ${FAQ_QUESTIONS.min}-${FAQ_QUESTIONS.max} items of ${FAQ_ANSWER_WORDS.min}-${FAQ_ANSWER_WORDS.max} words each; keep the strongest existing questions and add ones that carry the moved detail.`
}

function dynamicSuffix(args: {
  url: string
  title: string
  schema: SessionSchema
  body: string
  faq: FaqItem[]
  violations: StructureViolation[]
  fixNotes: string[]
}): string {
  const type = structureTypeForUrl(args.url)
  const skeleton = skeletonPromptFor(type, args.schema)
  const notes = type === 'niche'
    ? `\nPAGE NOTES: return "faq_heading" as "Common questions from <this audience>" (e.g. "Common questions from contractors").\n`
    : ''
  return `PAGE: ${args.title || args.url} (${args.url})
${skeleton ? `\n${skeleton}\n` : ''}${notes}
WHAT IS WRONG WITH THE CURRENT LAYOUT:
${args.violations.length ? args.violations.map((v) => `- ${v.message}`).join('\n') : '- Nothing measurable; tighten it to the rules and skeleton above.'}

CURRENT BODY (rewrite this):
"""
${args.body.trim()}
"""

CURRENT FAQ:
${JSON.stringify(args.faq)}${args.fixNotes.length ? `\n\nYOUR PREVIOUS ATTEMPT HAD THESE PROBLEMS — fix every one:\n${args.fixNotes.map((n) => `- ${n}`).join('\n')}` : ''}`
}

export type RestructureArgs = {
  file: string
  path: string
  url: string
  schema: SessionSchema
  noGoPhrases: string[]
  templateVersion: string | null
  sessionId: string
  userId: string
  deadlineAt: number
}

export type RestructureOutcome =
  | { ok: true; proposal: RestructureProposal }
  | { ok: false; reason: 'model_failed' | 'invalid'; details: string[] }

const MIN_ATTEMPT_MS = 90_000

export async function proposeRestructure(args: RestructureArgs): Promise<RestructureOutcome> {
  const { frontmatter } = splitFile(args.file)
  const title = pageTitle(frontmatter)
  const type = structureTypeForUrl(args.url)
  const { body, faq } = splitOutFaq(args.file)
  const before = measurePageStructure(args.file, { faqCount: faq.length })
  const violationsBefore = structureViolations(before, type)
  const prefix = staticPrefix(args.schema, args.noGoPhrases, args.templateVersion)
  const nicheKeywords = type === 'niche' ? realStrings(resolvePageIntent(args.url, title, args.schema).niche?.keywords) : []

  let fixNotes: string[] = []
  let lastErrors: string[] = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = args.deadlineAt - Date.now()
    if (remaining < MIN_ATTEMPT_MS) break
    const raw = await generateJson({
      model: anthropic(PUBLISHED_CONTENT_MODEL),
      messages: buildCachedMessages(prefix, dynamicSuffix({ url: args.url, title, schema: args.schema, body, faq, violations: violationsBefore, fixNotes })),
      firstBudget: 24000,
      providerOptions: attempt === 1 ? BACKGROUND_MEDIUM_PROVIDER_OPTIONS : OUTLINE_PROVIDER_OPTIONS,
      timeoutMs: Math.min(remaining - 15_000, 200_000),
      label: 'restructure-page',
      onAttempt: async (usage) => {
        await recordTokenUsage({
          task: 'content',
          sessionId: args.sessionId,
          createdBy: args.userId,
          stage: 'content_edit',
          pageUrl: args.path,
          model: PUBLISHED_CONTENT_MODEL,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          ...extractCacheUsage(usage),
        })
      },
    })
    const answer = parseAnswer(raw)
    if (!answer) {
      lastErrors = ['The model did not return a usable page.']
      fixNotes = ['Return valid JSON with a non-empty "body" string and a "faq" array.']
      continue
    }
    const proposed = composeProposal(
      args.file,
      args.path,
      {
        ...answer,
        body: coerceVariants(answer.body, args.templateVersion),
        // Prime-style "Common questions from …" heading is an industry-page thing;
        // service pages keep their existing FAQ heading (locked shape).
        faqHeading: type === 'niche' ? answer.faqHeading : undefined,
      },
      args.schema,
    )
    const errors = proposalErrors(args.file, proposed, { templateVersion: args.templateVersion, noGoPhrases: args.noGoPhrases })
    if (!errors.length) {
      const after = measurePageStructure(proposed)
      return {
        ok: true,
        proposal: {
          proposed,
          before,
          after,
          violationsBefore,
          violationsAfter: structureViolations(after, type),
          coverage: contentCoverage(args.file, proposed, nicheKeywords),
        },
      }
    }
    lastErrors = errors
    fixNotes = errors
  }
  return lastErrors.length && lastErrors[0] !== 'The model did not return a usable page.'
    ? { ok: false, reason: 'invalid', details: lastErrors }
    : { ok: false, reason: 'model_failed', details: lastErrors }
}
