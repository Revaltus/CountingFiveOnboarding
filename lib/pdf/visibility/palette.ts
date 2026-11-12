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
  core: '#101B2C',
} as const

export const PDF_AUDIENCE_COLORS: Record<AudienceKey, { base: string; mid: string; light: string; tint: string }> = {
  prospects: { base: '#F3B848', mid: '#F7C770', light: '#F9D188', tint: '#FDF5E5' },
  niche: { base: '#529DB1', mid: '#83B2C0', light: '#9FC2CC', tint: '#E7F1F4' },
  talent: { base: '#EC9049', mid: '#EFA264', light: '#F2B177', tint: '#FCEFE6' },
  search: { base: '#8F9670', mid: '#9CA17E', light: '#A7AC8B', tint: '#EFF0EB' },
  ai: { base: '#7C6D6D', mid: '#9C8F8E', light: '#B3A9A7', tint: '#EDEBEB' },
}
