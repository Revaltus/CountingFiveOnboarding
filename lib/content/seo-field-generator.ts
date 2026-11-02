import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { buildBrandVoiceBlock, buildFirmContext } from './brand-voice'
import { ANTI_SLOP_RULES, sanitizeGeneratedText } from './anti-slop-validator'
import { loadNoGoPhrases, buildNoGoPromptBlock } from './no-go-phrases'
import { OUTLINE_PROVIDER_OPTIONS, PUBLISHED_CONTENT_MODEL } from './generation-tuning'
import { RESOURCE_CALL_CAP_MS } from './generation-budget'
import { extractJson } from './extract-json'
import type { SessionSchema } from '@/types/session-schema'
import type { FaqItem, InternalLink } from '@/lib/editor/structured-fields'
import { FAQ_ANSWER_WORDS, FAQ_QUESTIONS } from './page-structure'

const MODEL = PUBLISHED_CONTENT_MODEL

export type SeoField = 'faq' | 'answer' | 'eeat' | 'links'

export const SEO_FIELDS: readonly SeoField[] = ['faq', 'answer', 'eeat', 'links']

export function isSeoField(v: unknown): v is SeoField {
  return typeof v === 'string' && (SEO_FIELDS as readonly string[]).includes(v)
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export function parseAnswerOutput(text: string): string {
  const obj = asRecord(extractJson(text))
  const answer = obj['answer_block']
  return typeof answer === 'string' ? answer.trim() : ''
}

export function parseEeatOutput(text: string): string[] {
  const obj = asRecord(extractJson(text))
  const list = obj['eeat_signals']
  if (!Array.isArray(list)) return []
  return list.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean)
}

export function parseFaqOutput(text: string): FaqItem[] {
  const obj = asRecord(extractJson(text))
  const list = obj['faq_block']
  if (!Array.isArray(list)) return []
  return list
    .filter(
      (it): it is FaqItem =>
        it != null &&
        typeof it === 'object' &&
        typeof (it as FaqItem).question === 'string' &&
        typeof (it as FaqItem).answer === 'string'
    )
    .map((it) => ({ question: it.question.trim(), answer: it.answer.trim() }))
    .filter((it) => it.question !== '' && it.answer !== '')
}

// Links are constrained to the site's real URLs — drop anything Claude invented
// or any self-link, normalizing trailing slashes for the comparison.
export function parseLinksOutput(
  text: string,
  allowedUrls: string[],
  selfUrl?: string
): InternalLink[] {
  const obj = asRecord(extractJson(text))
  const list = obj['internal_links']
  if (!Array.isArray(list)) return []
  const norm = (u: string) => u.replace(/\/+$/, '') || '/'
  const allowed = new Set(allowedUrls.map(norm))
  const self = selfUrl ? norm(selfUrl) : null
  return list
    .filter(
      (it): it is InternalLink =>
        it != null &&
        typeof it === 'object' &&
        typeof (it as InternalLink).url === 'string' &&
        typeof (it as InternalLink).anchor_text === 'string' &&
        typeof (it as InternalLink).reason === 'string'
    )
    .map((it) => ({
      url: it.url.trim(),
      anchor_text: it.anchor_text.trim(),
      reason: it.reason.trim(),
    }))
    .filter((it) => allowed.has(norm(it.url)) && norm(it.url) !== self)
}

function fieldInstruction(field: SeoField, sitemapUrls: string[], selfUrl: string): string {
  switch (field) {
    case 'answer':
      return `Write the AIO answer_block — 2-3 sentences answering the likely search query for this page directly. Return ONLY JSON: {"answer_block": "..."}`
    case 'faq':
      return `Generate ${FAQ_QUESTIONS.min}-${FAQ_QUESTIONS.max} FAQ entries for this page — ${FAQ_ANSWER_WORDS.min}-${FAQ_ANSWER_WORDS.max} words per answer. The FAQ carries the page's depth: definitions, edge cases and how-it-works detail the body leaves out, without repeating the body. Return ONLY JSON: {"faq_block": [{"question": "...", "answer": "..."}]}`
    case 'eeat':
      return `List the E-E-A-T trust signals for this page — specific credential/experience claims supported by the firm profile. Return ONLY JSON: {"eeat_signals": ["..."]}`
    case 'links': {
      const noSelf = selfUrl ? `, and never link to this page (${selfUrl})` : ''
      return `Suggest internal links for this page. ONLY use URLs from this exact list — never invent paths${noSelf}: ${sitemapUrls.join(' ')}. Return ONLY JSON: {"internal_links": [{"url": "...", "anchor_text": "...", "reason": "..."}]}`
    }
  }
}

export type SeoFieldResult =
  | { field: 'faq'; value: FaqItem[] }
  | { field: 'answer'; value: string }
  | { field: 'eeat'; value: string[] }
  | { field: 'links'; value: InternalLink[] }

export async function generateSeoField(args: {
  field: SeoField
  pageTitle: string
  pageUrl: string
  pageContent: string
  schema: SessionSchema
  sitemapUrls: string[]
}): Promise<{ result: SeoFieldResult; inputTokens: number; outputTokens: number }> {
  const { field, pageTitle, pageUrl, pageContent, schema, sitemapUrls } = args
  const firmName = schema.business?.name ?? 'the firm'
  const noGoBlock = buildNoGoPromptBlock((await loadNoGoPhrases()).map(p => p.phrase))

  const prompt = `You are writing structured SEO metadata for ${firmName}, a CPA firm.

${buildBrandVoiceBlock(schema)}

${buildFirmContext(schema)}

PAGE: ${pageTitle} (${pageUrl})
PAGE CONTENT:
"""
${pageContent.slice(0, 6000)}
"""

TASK: ${fieldInstruction(field, sitemapUrls, pageUrl)}

Ground everything in the page content and firm profile above. NEVER invent facts — credentials, numbers, named people, or dates not supported by the profile or the page content. Output JSON only, no commentary.

${ANTI_SLOP_RULES}${noGoBlock ? `\n\n${noGoBlock}` : ''}`

  const { text, usage } = await generateText({
    model: anthropic(MODEL),
    prompt,
    // Small structured JSON (incl. a 4–6 item FAQ). Low-effort adaptive thinking
    // + a generous budget: high effort against a tight 3000 budget starved the
    // JSON answer, truncating it into a silent empty faq_block (same failure the
    // outline generator hit — see OUTLINE_PROVIDER_OPTIONS).
    maxOutputTokens: 8000,
    providerOptions: OUTLINE_PROVIDER_OPTIONS,
    maxRetries: 4,
    // Bounds the call and its retry backoff well inside the 300s route.
    abortSignal: AbortSignal.timeout(RESOURCE_CALL_CAP_MS),
  })

  // Sanitize the visible prose the model produced (answers, questions, E-E-A-T
  // claims, link anchor text) before it reaches the page. URLs and the internal
  // `reason` note are left as-is. Parse functions stay pure/testable.
  let result: SeoFieldResult
  switch (field) {
    case 'answer':
      result = { field, value: sanitizeGeneratedText(parseAnswerOutput(text)) }
      break
    case 'faq':
      result = {
        field,
        value: parseFaqOutput(text).map((it) => ({
          question: sanitizeGeneratedText(it.question),
          answer: sanitizeGeneratedText(it.answer),
        })),
      }
      break
    case 'eeat':
      result = { field, value: parseEeatOutput(text).map(sanitizeGeneratedText) }
      break
    case 'links':
      result = {
        field,
        value: parseLinksOutput(text, sitemapUrls, pageUrl).map((it) => ({
          ...it,
          anchor_text: sanitizeGeneratedText(it.anchor_text),
        })),
      }
      break
  }

  return {
    result,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  }
}

export const SEO_MODEL = MODEL
