import { after, NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { createServerClient } from '@/lib/supabase/server'
import { requireContentJobAccess } from '@/lib/auth/access'
import { isApprovableOutline } from '@/lib/content/outline-fallback'
import { readJsonBody } from '@/app/api/_json'
import { runContentGeneration } from '@/lib/content/content-generator'
import { discoverImportableArticles } from '@/lib/content/article-import-discovery'
import { isDesignSystemLocked } from '@/lib/content/brand-gate'
import type { SessionSchema } from '@/types/session-schema'
import {
  validateContentJobPatch,
  checkPhaseTransition,
  crossesIntoGeneration,
  type ContentJobPatchBody,
} from './_validate'

export const runtime = 'nodejs'
// Routes that trigger content generation need a long maxDuration because the
// after() block runs the pipeline post-response. PATCHes that don't trigger
// generation complete in milliseconds and exit immediately — the longer cap
// only applies when there's pending work.
export const maxDuration = 300

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: _jobId } = await params
  const auth = await requireContentJobAccess(_jobId)
  if (auth instanceof NextResponse) return auth

  const { id } = await params
  const body = await readJsonBody<ContentJobPatchBody>(req)
  if (body instanceof NextResponse) return body

  const shapeError = validateContentJobPatch(body)
  if (shapeError) return NextResponse.json({ error: shapeError }, { status: 400 })

  const supabase = createServerClient()

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (body.palette !== undefined) updates.palette = body.palette
  if (body.design_tokens !== undefined) updates.design_tokens = body.design_tokens
  if (body.confirmed_sitemap !== undefined) updates.confirmed_sitemap = body.confirmed_sitemap
  if (body.nav_config !== undefined) updates.nav_config = body.nav_config
  if (body.status !== undefined) {
    const validStatuses = ['active', 'complete', 'error']
    if (!validStatuses.includes(body.status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }
    updates.status = body.status
  }
  if (body.error_message !== undefined) updates.error_message = body.error_message

  // Phase moves: forward one step at a time (so no gate can be skipped by a
  // direct PATCH), or backward. Crossing into phase 5 from below runs every
  // generation gate, regardless of the requested target.
  let currentPhase: number | null = null
  if (body.phase !== undefined) {
    if (typeof body.phase !== 'number' || !Number.isInteger(body.phase) || body.phase < 1 || body.phase > 6) {
      return NextResponse.json({ error: 'Invalid phase' }, { status: 400 })
    }
    const { data: job } = await supabase
      .from('content_jobs')
      .select('phase, session_id, library_reviewed_at, articles_reviewed_at, palette, design_tokens')
      .eq('id', id)
      .single()
    if (!job) return NextResponse.json({ error: 'Content job not found' }, { status: 404 })
    currentPhase = job.phase

    const transitionError = checkPhaseTransition(job.phase, body.phase)
    if (transitionError) return NextResponse.json({ error: transitionError }, { status: 409 })

    // Leaving phase 1 requires a locked Design System — the one this PATCH
    // saves, or the one already stored.
    if (job.phase <= 1 && body.phase >= 2) {
      const effective = {
        palette: body.palette !== undefined ? body.palette : job.palette,
        design_tokens: body.design_tokens !== undefined ? body.design_tokens : job.design_tokens,
      }
      if (!isDesignSystemLocked(effective)) {
        return NextResponse.json(
          { error: 'Save a complete palette and type pairing before leaving the Design System step.' },
          { status: 409 },
        )
      }
    }
    updates.phase = body.phase

    if (crossesIntoGeneration(job.phase, body.phase)) {
      // Every outline must be approved. generated_pages rows exist for the whole
      // sitemap, but the runner only generates approved outlines — starting with
      // unapproved ones left `pending` rows that never move.
      const { data: outlines, error: outlineErr } = await supabase
        .from('page_outlines')
        .select('admin_approved, h1, sections, admin_notes')
        .eq('content_job_id', id)
      if (outlineErr) return internalError('content-jobs:patch', outlineErr, "Couldn't load outlines")
      // A placeholder approved before the approve gates existed still counts as unapproved.
      const unapproved = (outlines ?? []).filter(o => !o.admin_approved || !isApprovableOutline(o)).length
      if (!outlines?.length || unapproved > 0) {
        return NextResponse.json(
          {
            error: outlines?.length
              ? `Approve every outline before starting content generation (${unapproved} still unapproved).`
              : 'No outlines to generate from — confirm the sitemap and generate outlines first.',
          },
          { status: 422 },
        )
      }

      // The operator must make an explicit library-content inclusion choice (select
      // + save, or save none) at outline proofing. The OutlinePhase UI gates on
      // this; enforcing it here stops a direct PATCH from skipping the review.
      if (!job.library_reviewed_at) {
        return NextResponse.json(
          { error: 'Confirm your library-content choice on the outline step before starting content generation.' },
          { status: 422 },
        )
      }

      // Same gate for verbatim article imports — but only when the audit actually
      // surfaced importable articles. A session with no blog (or no audit) has an
      // empty panel and must never deadlock, so auto-stamp and proceed.
      if (!job.articles_reviewed_at) {
        const { articles } = await discoverImportableArticles(id)
        if (articles.length > 0) {
          return NextResponse.json(
            { error: 'Confirm your existing-article import choice on the outline step before starting content generation.' },
            { status: 422 },
          )
        }
        await supabase
          .from('content_jobs')
          .update({ articles_reviewed_at: new Date().toISOString() })
          .eq('id', id)
      }

      // Without a firm name the generator falls back to "the firm"/"Unknown firm"
      // everywhere, producing unusable content. Block the advance instead.
      if (job.session_id) {
        const { data: sess } = await supabase.from('sessions').select('schema_data').eq('id', job.session_id).single()
        const name = (sess?.schema_data as SessionSchema | null)?.business?.name
        if (typeof name !== 'string' || !name.trim()) {
          return NextResponse.json(
            { error: 'Cannot start content generation: the MBP has no firm name. Add it on the MBP page first.' },
            { status: 422 },
          )
        }
      }
    }
  }

  const { data, error } = await supabase
    .from('content_jobs')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single()

  if (error) {
    return internalError('content-jobs:patch', error, "Couldn't update the content job")
  }

  // Auto-trigger content generation when advancing to phase 5.
  // after() guarantees the work runs within maxDuration on Vercel; plain
  // fire-and-forget gets terminated once the response leaves the function.
  if (body.phase === 5 && currentPhase !== 5 && data.session_id) {
    const sessionId = data.session_id
    after(async () => {
      try {
        await runContentGeneration(id, sessionId)
      } catch (err) {
        console.error('[content-gen] Auto-trigger failed:', err)
      }
    })
  }

  return NextResponse.json({ contentJob: data })
}
