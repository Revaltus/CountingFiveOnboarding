import type { KeyboardEvent, PointerEvent } from 'react'
import { AUDIENCES } from '@/lib/visibility/audiences'
import type { AudienceKey, AudienceScores } from '@/lib/visibility/types'
import { ARC_STOP_END, ARC_STOP_START, AUD_FILL, AUD_RING_STOP, AUD_STROKE } from './audience-styles'
import { scoreDotRadius } from '@/lib/visibility/arc-geometry'

// The Revaltus brochure's half-circle: bands left → right are 4, 3, 1, 2, 5,
// each in three gradient tones (outer base, mid, inner light) around a navy
// "your firm" core, with a ringed marker outside each band carrying the
// audience score. Each numbered white dot rests at its band's inner edge; the
// active audience's dot travels out to its score with a "You are here" pill.
const ARC_ORDER: AudienceKey[] = ['search', 'talent', 'prospects', 'niche', 'ai']

const VB_W = 500
const CX = 250
const CY = 250
const R_CORE = 92
const R_OUTER = 196
const R_BAND_IN = R_CORE + 8
const RING_W = (R_OUTER - R_BAND_IN) / 3
const GAP_DEG = 1.2
const DOT_R = 13
const R_MARKER = R_OUTER + 20
const R_LABEL = R_OUTER + 44
const PILL_W = 72
const PILL_H = 18

const polar = (r: number, deg: number) => {
  const rad = (deg * Math.PI) / 180
  return { x: CX + r * Math.cos(rad), y: CY - r * Math.sin(rad) }
}

function wedge(rIn: number, rOut: number, startDeg: number, endDeg: number): string {
  const a = polar(rOut, startDeg)
  const b = polar(rOut, endDeg)
  const c = polar(rIn, endDeg)
  const d = polar(rIn, startDeg)
  return `M ${a.x} ${a.y} A ${rOut} ${rOut} 0 0 1 ${b.x} ${b.y} L ${c.x} ${c.y} A ${rIn} ${rIn} 0 0 0 ${d.x} ${d.y} Z`
}

// Centre of the "You are here" pill, kept inside the viewBox. On the
// near-horizontal side bands it sits just above the dot (along the radius it
// would land on the navy core); elsewhere it sits beside the dot along its
// radius — outward in the band's inner half, inward in the outer half.
function pillCentre(r: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  const ux = Math.abs(Math.cos(rad))
  const uy = Math.abs(Math.sin(rad))
  const dot = polar(r, deg)
  const clearance = DOT_R + 4 + (ux * PILL_W) / 2 + (uy * PILL_H) / 2
  const outward = r < (R_BAND_IN + R_OUTER) / 2
  const p = ux > 0.7 ? { x: dot.x, y: dot.y - DOT_R - 4 - PILL_H / 2 } : polar(outward ? r + clearance : r - clearance, deg)
  return {
    x: Math.min(VB_W - PILL_W / 2 - 2, Math.max(PILL_W / 2 + 2, p.x)),
    y: Math.max(PILL_H / 2 + 2, p.y),
  }
}

const gradId = (key: AudienceKey, ring: number) => `aud-arc-${key}-${ring}`

export interface AudienceArcProps {
  scores: AudienceScores
  overall: number | null
  className?: string
  active?: AudienceKey | null
  onActivate?: (key: AudienceKey | null) => void
  onPress?: (key: AudienceKey, pointerType: string) => void
  onSelect?: (key: AudienceKey) => void
}

export function AudienceArc({ scores, overall, className = '', active = null, onActivate, onPress, onSelect }: AudienceArcProps) {
  const span = 180 / ARC_ORDER.length
  const interactive = Boolean(onSelect)
  const restR = scoreDotRadius(0, R_BAND_IN, R_OUTER, DOT_R)
  const bands = ARC_ORDER.map((key, i) => {
    const start = 180 - i * span - GAP_DEG / 2
    const end = 180 - (i + 1) * span + GAP_DEG / 2
    const midDeg = (start + end) / 2
    const meta = AUDIENCES.find((a) => a.key === key)
    const score = scores[key]?.score ?? null
    const scoreR = scoreDotRadius(score, R_BAND_IN, R_OUTER, DOT_R)
    return { key, start, end, midDeg, meta, score, scoreR, rest: polar(restR, midDeg), at: polar(scoreR, midDeg) }
  })

  const onKey = (key: AudienceKey) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect?.(key)
    }
  }
  const notTouch = (e: PointerEvent) => e.pointerType !== 'touch'

  return (
    <svg
      viewBox={`0 0 ${VB_W} 268`}
      role={interactive ? 'group' : 'img'}
      aria-label="Visibility score by audience"
      className={className}
    >
      <defs>
        {ARC_ORDER.flatMap((key) =>
          AUD_RING_STOP[key].map((tone, ring) => (
            <linearGradient key={gradId(key, ring)} id={gradId(key, ring)} x1="0" y1="0" x2="1" y2="0" className={tone}>
              <stop offset="0" className={ARC_STOP_START} />
              <stop offset="1" className={ARC_STOP_END} />
            </linearGradient>
          )),
        )}
      </defs>
      {bands.map(({ key, start, end, midDeg, meta, score, rest, at }) => {
        const isActive = active === key
        const dimmed = active !== null && !isActive
        const marker = polar(R_MARKER, midDeg)
        const label = polar(R_LABEL, midDeg)
        return (
          <g
            key={key}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-label={interactive ? `${meta?.n}. ${meta?.label}: ${score ?? 'not measured'}. Show details` : undefined}
            className={interactive ? 'cursor-pointer outline-none [&:focus-visible>g>path:first-child]:stroke-brand-navy [&:focus-visible>g>path:first-child]:stroke-2' : undefined}
            onPointerEnter={(e) => notTouch(e) && onActivate?.(key)}
            onPointerLeave={(e) => notTouch(e) && onActivate?.(null)}
            onPointerDown={(e) => onPress?.(key, e.pointerType)}
            onFocus={() => onActivate?.(key)}
            onBlur={() => onActivate?.(null)}
            onClick={() => onSelect?.(key)}
            onKeyDown={interactive ? onKey(key) : undefined}
          >
            <title>{`${meta?.n}. ${meta?.label}: ${score ?? 'not measured'}`}</title>
            <g className={`transition-opacity duration-300 motion-reduce:transition-none ${dimmed ? 'opacity-45' : 'opacity-100'}`}>
              {[0, 1, 2].map((ring) => {
                const rOut = R_OUTER - ring * RING_W
                return <path key={ring} d={wedge(rOut - RING_W, rOut, start, end)} fill={`url(#${gradId(key, ring)})`} />
              })}
            </g>
            <g
              opacity={score === null ? 0.6 : 1}
              className="transition-transform duration-500 ease-out motion-reduce:transition-none"
              style={{ transform: isActive ? `translate(${at.x - rest.x}px, ${at.y - rest.y}px)` : 'translate(0px, 0px)' }}
            >
              <circle cx={rest.x} cy={rest.y} r={DOT_R} className="fill-surface-card" />
              <text x={rest.x} y={rest.y + 4.5} textAnchor="middle" className="pointer-events-none fill-brand-navy font-heading text-[13px] font-bold">
                {meta?.n}
              </text>
            </g>
            <circle cx={marker.x} cy={marker.y} r={7} strokeWidth={2.5} className={`fill-surface-card ${AUD_STROKE[key]}`} />
            <circle cx={marker.x} cy={marker.y} r={3} className={AUD_FILL[key]} />
            <text x={label.x} y={label.y + 5} textAnchor="middle" className="pointer-events-none fill-brand-navy font-heading text-[15px] font-bold">
              {score ?? '—'}
            </text>
          </g>
        )
      })}
      <path d={`M ${CX - R_CORE + 6} ${CY} A ${R_CORE - 6} ${R_CORE - 6} 0 0 1 ${CX + R_CORE - 6} ${CY} Z`} className="fill-aud-core" />
      <text x={CX} y={CY - 30} textAnchor="middle" className="fill-text-inverse font-heading text-[38px] font-bold">
        {overall ?? '—'}
      </text>
      <text x={CX} y={CY - 12} textAnchor="middle" className="fill-text-inverse font-body text-[10px]">
        overall visibility
      </text>
      {interactive &&
        bands.map(({ key, midDeg, scoreR }) => {
          const p = pillCentre(scoreR, midDeg)
          const isActive = active === key
          return (
            <g
              key={`pill-${key}`}
              aria-hidden="true"
              className={`pointer-events-none transition-opacity motion-reduce:transition-none ${isActive ? 'opacity-100 delay-300 duration-300' : 'opacity-0 duration-150'}`}
            >
              <rect x={p.x - PILL_W / 2} y={p.y - PILL_H / 2} width={PILL_W} height={PILL_H} rx={PILL_H / 2} className="fill-aud-core" />
              <text x={p.x} y={p.y + 3.5} textAnchor="middle" className="fill-text-inverse font-heading text-[10px] font-semibold">
                You are here
              </text>
            </g>
          )
        })}
    </svg>
  )
}
