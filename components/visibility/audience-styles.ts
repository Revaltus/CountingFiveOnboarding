import type { AudienceKey, CheckStatus } from '@/lib/visibility/types'

// Static class strings so Tailwind can see every token at build time.
export const AUD_BG: Record<AudienceKey, string> = {
  prospects: 'bg-aud-prospects',
  clients: 'bg-aud-clients',
  talent: 'bg-aud-talent',
  search: 'bg-aud-search',
  ai: 'bg-aud-ai',
}

export const AUD_FILL: Record<AudienceKey, string> = {
  prospects: 'fill-aud-prospects',
  clients: 'fill-aud-clients',
  talent: 'fill-aud-talent',
  search: 'fill-aud-search',
  ai: 'fill-aud-ai',
}

export const AUD_BORDER: Record<AudienceKey, string> = {
  prospects: 'border-aud-prospects',
  clients: 'border-aud-clients',
  talent: 'border-aud-talent',
  search: 'border-aud-search',
  ai: 'border-aud-ai',
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
