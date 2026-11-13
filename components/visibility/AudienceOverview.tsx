'use client'

import { useRef, useState } from 'react'
import { AUDIENCES } from '@/lib/visibility/audiences'
import type { AudienceKey, AudienceScores } from '@/lib/visibility/types'
import { AudienceArc } from './AudienceArc'
import { AudienceBadge, AudienceScoreChip } from './AudienceBadge'
import { AUD_BG_TINT, AUD_BORDER, audienceSectionId } from './audience-styles'

interface Press {
  key: AudienceKey
  touch: boolean
  wasActive: boolean
}

export function AudienceOverview({ scores, overall }: { scores: AudienceScores; overall: number | null }) {
  const [active, setActive] = useState<AudienceKey | null>(null)
  const activeRef = useRef<AudienceKey | null>(null)
  const press = useRef<Press | null>(null)

  const activate = (key: AudienceKey | null) => {
    activeRef.current = key
    setActive(key)
  }

  // Recorded on pointerdown, before focus fires, so a first tap on a touch
  // screen only reveals "You are here"; a second tap opens the section.
  const onPress = (key: AudienceKey, pointerType: string) => {
    press.current = { key, touch: pointerType === 'touch', wasActive: activeRef.current === key }
  }

  const select = (key: AudienceKey) => {
    const p = press.current
    press.current = null
    if (p?.key === key && p.touch && !p.wasActive) {
      activate(key)
      return
    }
    const el = document.getElementById(audienceSectionId(key))
    if (!(el instanceof HTMLDetailsElement)) return
    el.open = true
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  }

  return (
    <div>
      <figure>
        <AudienceArc
          scores={scores}
          overall={overall}
          active={active}
          onActivate={activate}
          onPress={onPress}
          onSelect={select}
          className="w-full"
        />
        <figcaption className="mt-2 text-center text-xs font-body italic text-text-secondary">Focused visibility across all five channels</figcaption>
      </figure>
      <ul className="mt-6 grid gap-2 sm:grid-cols-2">
        {AUDIENCES.map((a) => {
          const isActive = active === a.key
          const dimmed = active !== null && !isActive
          return (
            <li key={a.key}>
              <button
                type="button"
                aria-label={`${a.n}. ${a.label}: ${scores[a.key]?.score ?? 'not measured'}. Show details`}
                onPointerEnter={(e) => e.pointerType !== 'touch' && activate(a.key)}
                onPointerLeave={(e) => e.pointerType !== 'touch' && activate(null)}
                onPointerDown={(e) => onPress(a.key, e.pointerType)}
                onFocus={() => activate(a.key)}
                onBlur={() => activate(null)}
                onClick={() => select(a.key)}
                className={`flex w-full items-center gap-3 rounded-lg border-2 px-3 py-2 text-left text-sm font-body transition-[background-color,border-color,opacity] duration-200 motion-reduce:transition-none focus-visible:outline-none ${
                  isActive ? `${AUD_BG_TINT[a.key]} ${AUD_BORDER[a.key]}` : 'border-transparent'
                } ${dimmed ? 'opacity-60' : 'opacity-100'}`}
              >
                <AudienceBadge audience={a.key} size="sm" />
                <span className="min-w-0 flex-1 text-text-primary">
                  <span className="font-heading font-semibold">{a.label}</span>{' '}
                  <span className="text-text-secondary">— {a.summary}</span>
                </span>
                <AudienceScoreChip audience={a.key} score={scores[a.key]?.score ?? null} />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
