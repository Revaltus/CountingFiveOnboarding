import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { buildBrandVoiceBlock } from './brand-voice'
import { extractJson } from './extract-json'
import { recordTokenUsage } from './token-usage'
import type { SessionSchema } from '@/types/session-schema'
import { FAST_MODEL, FAST_PROVIDER_OPTIONS } from './generation-tuning'
import { HELPER_CALL_CAP_MS } from './generation-budget'

const BRAND_FIT_MODEL = FAST_MODEL

export type BrandAmendment = {
  summary: string
  toneAdjectivesAdd: string[]
  toneToAvoidRemove: string[]
  aspirationalToneAppend: string | null
}

export type BrandFitResult = {
  fit: 'on-brand' | 'off-brand'
  conflicts: string[]
  proposedAmendment: BrandAmendment | null
}

const ON_BRAND: BrandFitResult = { fit: 'on-brand', conflicts: [], proposedAmendment: null }

// Pre-generation guard for admin-supplied direction (brainstorm seed, draft
// notes). Synchronous and cheap (Haiku) — routes call it before doing any
// work and 409 on a conflict so the admin can confirm or revise. Fails OPEN:
// the generation prompts force brand voice regardless, so a guard failure
// can never itself produce off-brand output.
export async function checkBrandFit(args: {
  text: string
  schema: SessionSchema
  contentJobId: string
  sessionId: string
  // Model override — only scripts/compare-fast-models.ts sets it.
  model?: { id: string; providerOptions?: Parameters<typeof generateText>[0]['providerOptions'] }
}): Promise<BrandFitResult> {
  const modelId = args.model?.id ?? BRAND_FIT_MODEL
  const prompt = `You are the brand steward for ${args.schema.business?.name ?? 'a CPA firm'}. An admin asked the content engine for the following:

"${args.text}"

THE DOCUMENTED BRAND:
${buildBrandVoiceBlock(args.schema)}

Judge ONLY voice and positioning fit. A topic outside the firm's usual subject matter is NOT off-brand. Flag the request as off-brand ONLY if it genuinely conflicts: it demands a tone the brand explicitly avoids, contradicts the positioning statement, addresses the wrong audience register, or asks for tactics at odds with the differentiators (e.g. attack content for a measured, trust-first brand).

If off-brand, also propose the smallest concrete brand amendment that would make this request on-brand — the admin may decide the brand has evolved.

Return ONLY JSON:
{
  "fit": "on-brand" | "off-brand",
  "conflicts": ["each specific clash, quoting the brand field it violates — empty if on-brand"],
  "proposedAmendment": null | {
    "summary": "one line describing the brand change",
    "toneAdjectivesAdd": ["adjectives to add"],
    "toneToAvoidRemove": ["existing avoid-entries this would lift"],
    "aspirationalToneAppend": "sentence to append to the aspirational tone, or null"
  }
}`

  try {
    const { text, usage } = await generateText({
      model: anthropic(modelId),
      providerOptions: args.model ? args.model.providerOptions : FAST_PROVIDER_OPTIONS,
      system: 'You are a meticulous brand steward. Return JSON only, no prose.',
      prompt,
      // An off-brand verdict with conflicts + an amendment runs 500+ tokens;
      // a tighter cap truncated the JSON and silently failed the guard open.
      maxOutputTokens: 1200,
      maxRetries: 4,
      // Haiku helper on a request path: a hang must not hold the route.
      abortSignal: AbortSignal.timeout(HELPER_CALL_CAP_MS),
    })
    await recordTokenUsage({
      task: 'content',
      contentJobId: args.contentJobId,
      sessionId: args.sessionId,
      stage: 'idea',
      pageUrl: 'brand-fit',
      model: modelId,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    })

    const parsed = extractJson(text) as { fit?: unknown; conflicts?: unknown; proposedAmendment?: Record<string, unknown> | null } | null
    if (!parsed) throw new Error(`unparseable brand-fit JSON: ${text.slice(0, 120)}`)
    if (parsed?.fit !== 'off-brand') return ON_BRAND
    const amendment = parsed.proposedAmendment
    return {
      fit: 'off-brand',
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts.filter((c: unknown) => typeof c === 'string') : [],
      proposedAmendment: amendment && typeof amendment.summary === 'string'
        ? {
            summary: amendment.summary,
            toneAdjectivesAdd: Array.isArray(amendment.toneAdjectivesAdd) ? amendment.toneAdjectivesAdd : [],
            toneToAvoidRemove: Array.isArray(amendment.toneToAvoidRemove) ? amendment.toneToAvoidRemove : [],
            aspirationalToneAppend:
              typeof amendment.aspirationalToneAppend === 'string' && amendment.aspirationalToneAppend.trim()
                ? amendment.aspirationalToneAppend.trim()
                : null,
          }
        : null,
    }
  } catch (err) {
    console.warn('[brand-fit] Check failed, proceeding (generation is brand-forced anyway):', err)
    return ON_BRAND
  }
}

// Marker line persisted at the top of draft_notes when the admin approved an
// off-brand direction — the detached draft worker reads it from the row.
export const OFF_BRAND_MARKER = '[Approved off-brand direction]'
