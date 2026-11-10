import { AUDIENCES } from '@/lib/visibility/audiences'
import type { AudienceKey, AudienceScores } from '@/lib/visibility/types'
import { AUD_FILL } from './audience-styles'

// Left-to-right band order of the Revaltus deck's half-circle (4, 3, 1, 2, 5).
const ARC_ORDER: AudienceKey[] = ['search', 'talent', 'prospects', 'clients', 'ai']

const CX = 200
const CY = 200
const R_OUTER = 190
const R_INNER = 92
const GAP_DEG = 1.5

const polar = (r: number, deg: number) => {
  const rad = (deg * Math.PI) / 180
  return { x: CX + r * Math.cos(rad), y: CY - r * Math.sin(rad) }
}

function wedge(startDeg: number, endDeg: number): string {
  const a = polar(R_OUTER, startDeg)
  const b = polar(R_OUTER, endDeg)
  const c = polar(R_INNER, endDeg)
  const d = polar(R_INNER, startDeg)
  return `M ${a.x} ${a.y} A ${R_OUTER} ${R_OUTER} 0 0 1 ${b.x} ${b.y} L ${c.x} ${c.y} A ${R_INNER} ${R_INNER} 0 0 0 ${d.x} ${d.y} Z`
}

// Band opacity encodes the audience score; an unmeasured audience is faint.
const opacityFor = (score: number | null) => (score === null ? 0.15 : 0.3 + 0.7 * (score / 100))

export function AudienceArc({ scores, overall, className = '' }: { scores: AudienceScores; overall: number | null; className?: string }) {
  const span = 180 / ARC_ORDER.length
  return (
    <svg viewBox="0 0 400 215" role="img" aria-label="Visibility score by audience" className={className}>
      {ARC_ORDER.map((key, i) => {
        const start = 180 - i * span - GAP_DEG / 2
        const end = 180 - (i + 1) * span + GAP_DEG / 2
        const mid = polar((R_OUTER + R_INNER) / 2, (start + end) / 2)
        const meta = AUDIENCES.find((a) => a.key === key)
        const score = scores[key]?.score ?? null
        return (
          <g key={key}>
            <path d={wedge(start, end)} className={AUD_FILL[key]} fillOpacity={opacityFor(score)}>
              <title>{`${meta?.label}: ${score ?? 'not measured'}`}</title>
            </path>
            <circle cx={mid.x} cy={mid.y} r={15} className="fill-surface-card" />
            <text x={mid.x} y={mid.y + 5} textAnchor="middle" className="fill-brand-navy font-heading text-[14px] font-bold">
              {meta?.n}
            </text>
          </g>
        )
      })}
      <path d={`M ${CX - 80} ${CY} A 80 80 0 0 1 ${CX + 80} ${CY} Z`} className="fill-brand-navy" />
      <text x={CX} y={CY - 26} textAnchor="middle" className="fill-text-inverse font-heading text-[40px] font-bold">
        {overall ?? '—'}
      </text>
      <text x={CX} y={CY - 8} textAnchor="middle" className="fill-text-inverse font-body text-[11px]">
        overall visibility
      </text>
    </svg>
  )
}
