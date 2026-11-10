import type { AudienceKey, CheckStatus } from '@/lib/visibility/types'

// Static class strings so Tailwind sees every token at build time. Each
// audience has three tones from the Revaltus deck arc: base (outer ring), mid,
// and light (inner ring). Base fills carry white numerals only (decorative, as
// in the deck); readable text sits in navy on the light tint.
export const AUD_BG: Record<AudienceKey, string> = {
  prospects: 'bg-aud-prospects',
  clients: 'bg-aud-clients',
  talent: 'bg-aud-talent',
  search: 'bg-aud-search',
  ai: 'bg-aud-ai',
}

export const AUD_BG_LIGHT: Record<AudienceKey, string> = {
  prospects: 'bg-aud-prospects-light',
  clients: 'bg-aud-clients-light',
  talent: 'bg-aud-talent-light',
  search: 'bg-aud-search-light',
  ai: 'bg-aud-ai-light',
}

export const AUD_BORDER: Record<AudienceKey, string> = {
  prospects: 'border-aud-prospects',
  clients: 'border-aud-clients',
  talent: 'border-aud-talent',
  search: 'border-aud-search',
  ai: 'border-aud-ai',
}

export const AUD_MARKER: Record<AudienceKey, string> = {
  prospects: 'marker:text-aud-prospects',
  clients: 'marker:text-aud-clients',
  talent: 'marker:text-aud-talent',
  search: 'marker:text-aud-search',
  ai: 'marker:text-aud-ai',
}

// Arc tones, outer → inner.
export const AUD_FILL_RINGS: Record<AudienceKey, [string, string, string]> = {
  prospects: ['fill-aud-prospects', 'fill-aud-prospects-mid', 'fill-aud-prospects-light'],
  clients: ['fill-aud-clients', 'fill-aud-clients-mid', 'fill-aud-clients-light'],
  talent: ['fill-aud-talent', 'fill-aud-talent-mid', 'fill-aud-talent-light'],
  search: ['fill-aud-search', 'fill-aud-search-mid', 'fill-aud-search-light'],
  ai: ['fill-aud-ai', 'fill-aud-ai-mid', 'fill-aud-ai-light'],
}

export const AUD_FILL: Record<AudienceKey, string> = {
  prospects: 'fill-aud-prospects',
  clients: 'fill-aud-clients',
  talent: 'fill-aud-talent',
  search: 'fill-aud-search',
  ai: 'fill-aud-ai',
}

export const AUD_STROKE: Record<AudienceKey, string> = {
  prospects: 'stroke-aud-prospects',
  clients: 'stroke-aud-clients',
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
