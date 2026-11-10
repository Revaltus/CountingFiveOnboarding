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

export const PDF_AUDIENCE_COLORS: Record<AudienceKey, string> = {
  prospects: '#F2BE45',
  clients: '#74AFC8',
  talent: '#EE9444',
  search: '#9FA878',
  ai: '#968592',
}
