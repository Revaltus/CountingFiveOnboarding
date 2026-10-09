// ---------------------------------------------------------------------------
// AI seed for the pricing plans page — drafts starting tiers from the firm's
// free-text pricing (business.pricing), services, and any pricing the audit
// captured from the client's current site (_meta.audit_context.pricing). The
// operator always reviews/edits before saving; this only pre-fills the editor.
//
// Model tier: FAST_MODEL (structured extraction), thinking off via
// FAST_PROVIDER_OPTIONS.
// ---------------------------------------------------------------------------
import { anthropic } from '@ai-sdk/anthropic'
import { recordTokenUsage } from './token-usage'
import { generateJson } from './json-generation'
import { normalizePricingPlansConfig } from './pricing-plans-config'
import { DEFAULT_PLANS_CONFIG, type PricingPlansConfig } from '@/types/pricing-plans'
import type { SessionSchema } from '@/types/session-schema'
import { FAST_MODEL, FAST_PROVIDER_OPTIONS } from './generation-tuning'

const SEED_MODEL = FAST_MODEL

function buildServicesBlock(schema: SessionSchema): string {
  const services = (schema.services ?? [])
    .map(s => `- ${s.name}${s.description ? `: ${s.description}` : ''}`)
    .join('\n')
  return services || '(no structured services captured)'
}

// Fold in pricing the audit found on the client's current site so the seed can
// anchor on real tiers/rates instead of generic defaults.
function buildAuditPricingBlock(schema: SessionSchema): string {
  const p = schema._meta?.audit_context?.pricing
  if (!p) return '(no pricing detected on the current site)'
  const lines: string[] = []
  if (p.strategy) lines.push(`Current pricing style: ${p.strategy}`)
  for (const t of p.tiers ?? []) {
    const feats = t.features?.length ? ` — includes: ${t.features.join(', ')}` : ''
    lines.push(`Tier "${t.name}"${t.price ? ` at ${t.price}` : ''}${feats}`)
  }
  for (const r of p.rates ?? []) {
    lines.push(`Rate: ${r.service ?? 'service'} — ${r.rate ?? ''}`.trim())
  }
  return lines.join('\n') || '(no pricing detected on the current site)'
}

// Draft a PricingPlansConfig from the firm's known pricing signals. Falls back
// to DEFAULT_PLANS_CONFIG on any failure — the seed is best-effort and must
// never block the editor.
export async function seedPricingPlans(args: {
  schema: SessionSchema
  sessionId: string
  contentJobId: string | null
}): Promise<PricingPlansConfig> {
  const { schema } = args
  const firmName = schema.business?.name ?? 'this firm'
  const pricingText = schema.business?.pricing?.trim() || '(no pricing notes captured)'

  const prompt = `You are configuring a static pricing/plans page (tier cards) for ${firmName}.

Draft realistic tiers and copy using what's known about the firm. Keep the fixed structure — do not invent new fields. Prefer the firm's actual services and any pricing already on their current site.

FIRM PRICING NOTES:
${pricingText}

FIRM SERVICES:
${buildServicesBlock(schema)}

PRICING FOUND ON THE CURRENT SITE:
${buildAuditPricingBlock(schema)}

Return ONLY JSON matching exactly this shape (monthly USD prices; annualPrice is the discounted per-month figure):
{
  "intro": "one or two friendly sentences introducing the plans",
  "billing": { "showToggle": true, "defaultCadence": "monthly", "annualDiscountPct": <10-20>, "monthlyLabel": "Monthly", "annualLabel": "Annual" },
  "tiers": [ { "id": "kebab-case", "name": "Tier name", "description": "short", "monthlyPrice": <$>, "annualPrice": <$ discounted>, "priceSuffix": "/mo", "isMostPopular": <true on ONE tier>, "features": [ { "id": "kebab", "label": "Feature", "included": true } ], "cta": { "label": "Get started", "url": "/contact" } } ],
  "sharedFeatures": { "heading": "All plans include", "items": [ "shared benefit" ] },
  "addOns": [ { "id": "kebab", "label": "Add-on", "type": "flat", "price": <$>, "cadence": "month" } ],
  "disclaimer": "one sentence that plans are a starting point",
  "cta": { "label": "Book a consultation", "url": "/contact" }
}

Rules: 3-4 tiers escalating in price; exactly ONE tier with "isMostPopular": true (usually the middle); each tier 4-7 features with lower tiers marking some "included": false; 3-5 sharedFeatures.items; 0-3 addOns. Base numbers on the firm's pricing notes / current-site pricing when given, otherwise use sensible small-firm defaults. Output JSON only, no prose.`

  // Returns null on a model/parse failure; we then
  // fall back to the default config the operator can fill in manually.
  const parsed = (await generateJson({
    model: anthropic(SEED_MODEL),
    providerOptions: FAST_PROVIDER_OPTIONS,
    system: 'You configure pricing/plans pages for professional-services firms. Return JSON only, no prose.',
    prompt,
    firstBudget: 3000,
    retryBudget: 5000,
    label: 'plans-seed',
    onAttempt: async (usage) => {
      await recordTokenUsage({
        task: 'content',
        contentJobId: args.contentJobId ?? undefined,
        sessionId: args.sessionId,
        stage: 'idea',
        pageUrl: 'pricing-plans-seed',
        model: SEED_MODEL,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      })
    },
  })) as Record<string, unknown> | null

  if (!parsed) return DEFAULT_PLANS_CONFIG
  // Merge over the default so any field the model omitted keeps a sane value,
  // then normalize (which enforces the full shape + bounds + single popular).
  return normalizePricingPlansConfig({ ...DEFAULT_PLANS_CONFIG, ...parsed, version: 1 })
}
