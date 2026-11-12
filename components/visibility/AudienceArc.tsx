import { AUDIENCES } from '@/lib/visibility/audiences'
import type { AudienceKey, AudienceScores } from '@/lib/visibility/types'
import { ARC_STOP_END, ARC_STOP_START, AUD_FILL, AUD_RING_STOP, AUD_STROKE } from './audience-styles'
import { scoreDotRadius } from '@/lib/visibility/arc-geometry'

// The Revaltus brochure's half-circle: bands left → right are 4, 3, 1, 2, 5,
// each in three gradient tones (outer base, mid, inner light) around a navy
// "your firm" core, with a ringed marker outside each band carrying the
// audience score. The numbered white dot is plotted by score: near the core
// for a low score, at the outer edge for a high one.
const ARC_ORDER: AudienceKey[] = ['search', 'talent', 'prospects', 'niche', 'ai']

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

const gradId = (key: AudienceKey, ring: number) => `aud-arc-${key}-${ring}`

export function AudienceArc({ scores, overall, className = '' }: { scores: AudienceScores; overall: number | null; className?: string }) {
  const span = 180 / ARC_ORDER.length
  return (
    <svg viewBox="0 0 500 268" role="img" aria-label="Visibility score by audience" className={className}>
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
      {ARC_ORDER.map((key, i) => {
        const start = 180 - i * span - GAP_DEG / 2
        const end = 180 - (i + 1) * span + GAP_DEG / 2
        const midDeg = (start + end) / 2
        const meta = AUDIENCES.find((a) => a.key === key)
        const score = scores[key]?.score ?? null
        const dot = polar(scoreDotRadius(score, R_BAND_IN, R_OUTER, DOT_R), midDeg)
        const marker = polar(R_MARKER, midDeg)
        const label = polar(R_LABEL, midDeg)
        return (
          <g key={key}>
            <title>{`${meta?.n}. ${meta?.label}: ${score ?? 'not measured'}`}</title>
            {[0, 1, 2].map((ring) => {
              const rOut = R_OUTER - ring * RING_W
              return <path key={ring} d={wedge(rOut - RING_W, rOut, start, end)} fill={`url(#${gradId(key, ring)})`} />
            })}
            <g opacity={score === null ? 0.6 : 1}>
              <circle cx={dot.x} cy={dot.y} r={DOT_R} className="fill-surface-card" />
              <text x={dot.x} y={dot.y + 4.5} textAnchor="middle" className="fill-brand-navy font-heading text-[13px] font-bold">
                {meta?.n}
              </text>
            </g>
            <circle cx={marker.x} cy={marker.y} r={7} strokeWidth={2.5} className={`fill-surface-card ${AUD_STROKE[key]}`} />
            <circle cx={marker.x} cy={marker.y} r={3} className={AUD_FILL[key]} />
            <text x={label.x} y={label.y + 5} textAnchor="middle" className="fill-brand-navy font-heading text-[15px] font-bold">
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
    </svg>
  )
}
