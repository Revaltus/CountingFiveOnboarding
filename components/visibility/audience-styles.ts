import type { AudienceKey, CheckStatus } from '@/lib/visibility/types'

// Static class strings so Tailwind sees every token at build time. Each
// audience has three arc tones from the Revaltus brochure — base (outer ring),
// mid, light (inner ring) — plus a pale tint for panels. Base fills carry white
// numerals only (decorative, as in the brochure); readable text sits in navy
// on the tint.
export const AUD_BG: Record<AudienceKey, string> = {
  prospects: 'bg-aud-prospects',
  niche: 'bg-aud-niche',
  talent: 'bg-aud-talent',
  search: 'bg-aud-search',
  ai: 'bg-aud-ai',
}

export const AUD_BG_TINT: Record<AudienceKey, string> = {
  prospects: 'bg-aud-prospects-tint',
  niche: 'bg-aud-niche-tint',
  talent: 'bg-aud-talent-tint',
  search: 'bg-aud-search-tint',
  ai: 'bg-aud-ai-tint',
}

export const AUD_BORDER: Record<AudienceKey, string> = {
  prospects: 'border-aud-prospects',
  niche: 'border-aud-niche',
  talent: 'border-aud-talent',
  search: 'border-aud-search',
  ai: 'border-aud-ai',
}

export const AUD_MARKER: Record<AudienceKey, string> = {
  prospects: 'marker:text-aud-prospects',
  niche: 'marker:text-aud-niche',
  talent: 'marker:text-aud-talent',
  search: 'marker:text-aud-search',
  ai: 'marker:text-aud-ai',
}

// Arc gradients, outer → inner ring: each sets --aud-stop on its
// <linearGradient> for ARC_STOP_START / ARC_STOP_END to shade.
export const AUD_RING_STOP: Record<AudienceKey, [string, string, string]> = {
  prospects: ['[--aud-stop:var(--color-aud-prospects)]', '[--aud-stop:var(--color-aud-prospects-mid)]', '[--aud-stop:var(--color-aud-prospects-light)]'],
  niche: ['[--aud-stop:var(--color-aud-niche)]', '[--aud-stop:var(--color-aud-niche-mid)]', '[--aud-stop:var(--color-aud-niche-light)]'],
  talent: ['[--aud-stop:var(--color-aud-talent)]', '[--aud-stop:var(--color-aud-talent-mid)]', '[--aud-stop:var(--color-aud-talent-light)]'],
  search: ['[--aud-stop:var(--color-aud-search)]', '[--aud-stop:var(--color-aud-search-mid)]', '[--aud-stop:var(--color-aud-search-light)]'],
  ai: ['[--aud-stop:var(--color-aud-ai)]', '[--aud-stop:var(--color-aud-ai-mid)]', '[--aud-stop:var(--color-aud-ai-light)]'],
}

// The brochure's bands brighten on the left and deepen on the right.
export const ARC_STOP_START = '[stop-color:color-mix(in_srgb,var(--aud-stop)_88%,white)]'
export const ARC_STOP_END = '[stop-color:color-mix(in_srgb,var(--aud-stop),black_4%)]'

export const AUD_FILL: Record<AudienceKey, string> = {
  prospects: 'fill-aud-prospects',
  niche: 'fill-aud-niche',
  talent: 'fill-aud-talent',
  search: 'fill-aud-search',
  ai: 'fill-aud-ai',
}

export const AUD_STROKE: Record<AudienceKey, string> = {
  prospects: 'stroke-aud-prospects',
  niche: 'stroke-aud-niche',
  talent: 'stroke-aud-talent',
  search: 'stroke-aud-search',
  ai: 'stroke-aud-ai',
}

export const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: 'Strong',
  partial: 'Partial',
  fail: 'Opportunity',
  na: 'Not measured',
}

export const STATUS_CLS: Record<CheckStatus, string> = {
  pass: 'bg-success/10 text-success',
  partial: 'bg-warning/15 text-warning-strong',
  fail: 'bg-error/10 text-error',
  na: 'bg-surface-subtle text-text-muted',
}

// DOM id of an audience's collapsible report section, opened from the arc.
export const audienceSectionId = (key: AudienceKey) => `aud-${key}`
