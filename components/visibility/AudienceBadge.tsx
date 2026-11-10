import { audienceMeta } from '@/lib/visibility/audiences'
import type { AudienceKey } from '@/lib/visibility/types'
import { AUD_BG, AUD_BG_LIGHT, AUD_BORDER } from './audience-styles'

const SIZES = { sm: 'h-5 w-5 text-[10px]', md: 'h-7 w-7 text-xs', lg: 'h-9 w-9 text-sm' } as const

// The deck's numbered audience dot.
export function AudienceBadge({ audience, size = 'md' }: { audience: AudienceKey; size?: keyof typeof SIZES }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-heading font-bold text-text-inverse ${AUD_BG[audience]} ${SIZES[size]}`}
    >
      {audienceMeta(audience).n}
    </span>
  )
}

// A score in the audience's colours: light tint, base-colour border, navy text.
export function AudienceScoreChip({ audience, score }: { audience: AudienceKey; score: number | null }) {
  const meta = audienceMeta(audience)
  return (
    <span
      title={`${meta.n}. ${meta.label}: ${score ?? 'not measured'}`}
      className={`inline-flex h-7 min-w-9 items-center justify-center gap-1 rounded-full border-2 px-1.5 font-heading text-[11px] font-bold text-brand-navy ${AUD_BG_LIGHT[audience]} ${AUD_BORDER[audience]}`}
    >
      {score ?? '—'}
    </span>
  )
}
