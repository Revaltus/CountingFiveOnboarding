// react-pdf can't read CSS custom properties, so the PDF mirrors the web
// tokens here. Keep in sync with app/globals.css (--color-aud-*, --color-brand-*).
import type { AudienceKey } from '@/lib/visibility/types'

export const PDF_COLORS = {
  ink: '#231f20',
  teal: '#098195',
  body: '#1E293B',
  muted: '#64748B',
  faint: '#94A3B8',
  rule: '#E2E8F0',
  page: '#ffffff',
} as const

export const PDF_AUDIENCE_COLORS: Record<AudienceKey, { base: string; mid: string; light: string }> = {
  prospects: { base: '#F5C045', mid: '#F8DB82', light: '#FBE9B1' },
  clients: { base: '#74B1C8', mid: '#9ECADA', light: '#C6DFEA' },
  talent: { base: '#EF9544', mid: '#F4BE85', light: '#FBE5C8' },
  search: { base: '#9FA876', mid: '#CACEAB', light: '#ECEDDE' },
  ai: { base: '#948492', mid: '#B0A3AE', light: '#CEC5CB' },
}
