import PhaseCard from './PhaseCard'
import DesignSystemPhase from './DesignSystemPhase'
import SitemapPhase from './SitemapPhase'
import ResearchPhase from './ResearchPhase'
import OutlinePhase from './OutlinePhase'
import GenerationPhase from './GenerationPhase'
import DeliverablesPhase from './DeliverablesPhase'
import SitemapUnapproveButton from './SitemapUnapproveButton'
import type { PhaseStatus } from './PhaseStatusBadge'
import type { PaletteData } from '@/types/palette'
import type { DesignTokens } from '@/types/design-tokens'
import type { SessionSchema } from '@/types/session-schema'
import type { NavJson } from '@/types/nav-json'
import { getPhaseStatus as getGatedPhaseStatus, isDesignSystemLocked } from '@/lib/content/brand-gate'

// The sitemap card stays locked until the Design System is locked (see
// lib/content/brand-gate.ts); the Design System card stays open on a job that
// got past phase 1 without one.
export function getPhaseStatus(jobPhase: number, thisPhase: number, designLocked = true): PhaseStatus {
  return getGatedPhaseStatus(jobPhase, thisPhase, designLocked)
}

type SitemapEntry = { url: string; title: string; parent?: string; status?: string }

export default function PhaseStepper({
  currentPhase,
  sessionId,
  contentJobId,
  existingPalette,
  existingTokens,
  brand,
  logoUrl,
  confirmedPageCount,
  navConfig,
  confirmedSitemap,
  githubRepo,
  initialPreviewPageId = null,
}: {
  currentPhase: number
  sessionId: string
  contentJobId: string
  existingPalette: PaletteData | null
  existingTokens: DesignTokens | null
  brand: SessionSchema['brand']
  logoUrl: string | null
  confirmedPageCount: number
  navConfig: NavJson | null
  confirmedSitemap: SitemapEntry[]
  githubRepo: string | null
  initialPreviewPageId?: string | null
}) {
  const designLocked = isDesignSystemLocked({ palette: existingPalette, design_tokens: existingTokens })
  return (
    <div className="space-y-4">
      {[1, 2, 3, 4, 5, 6].map(phase => {
        const status = getPhaseStatus(currentPhase, phase, designLocked)
        const isComplete = status === 'complete'

        let content: React.ReactNode = null

        if (phase === 1) {
          content = (
            <DesignSystemPhase
              sessionId={sessionId}
              contentJobId={contentJobId}
              existingPalette={existingPalette}
              existingTokens={existingTokens}
              brand={brand}
              logoUrl={logoUrl}
              // Past phase 1, saving must not move the job back to phase 2.
              isLocked={currentPhase > 1}
            />
          )
        } else if (phase === 2) {
          content = isComplete ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-text-muted font-body">Sitemap confirmed.</p>
              <SitemapUnapproveButton contentJobId={contentJobId} />
            </div>
          ) : (
            <SitemapPhase contentJobId={contentJobId} />
          )
        } else if (phase === 3) {
          content = isComplete ? (
            <p className="text-sm text-text-muted font-body">Research complete.</p>
          ) : (
            <ResearchPhase contentJobId={contentJobId} />
          )
        } else if (phase === 4) {
          content = isComplete ? (
            <p className="text-sm text-text-muted font-body">All outlines approved.</p>
          ) : (
            <OutlinePhase contentJobId={contentJobId} />
          )
        } else if (phase === 5) {
          // Always render GenerationPhase — even when the job has advanced
          // past 5 — so the admin can return later to preview pages, toggle
          // approval, or regenerate. The component's internal state handles
          // the "all done" UI on its own.
          content = <GenerationPhase contentJobId={contentJobId} jobPhase={currentPhase} initialPreviewPageId={initialPreviewPageId} />
        } else if (phase === 6) {
          content = (
            <DeliverablesPhase
              sessionId={sessionId}
              contentJobId={contentJobId}
              githubRepo={githubRepo}
              pageCount={confirmedPageCount}
              initialNavConfig={navConfig}
              confirmedSitemap={confirmedSitemap}
            />
          )
        }

        return (
          <PhaseCard key={phase} phase={phase} status={status}>
            {content}
          </PhaseCard>
        )
      })}
    </div>
  )
}
