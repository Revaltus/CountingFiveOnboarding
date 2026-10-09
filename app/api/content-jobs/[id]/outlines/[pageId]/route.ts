import { after, NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { createServerClient } from '@/lib/supabase/server'
import { requireContentJobAccess } from '@/lib/auth/access'
import { reviewContentForMbpImpact } from '@/lib/mbp/impact-review'
import { isApprovableOutline } from '@/lib/content/outline-fallback'
import type { Json } from '@/types/database'

// Fields that, when changed, invalidate any previously-approved generated
// content for this page — admin must re-review after a material outline edit.
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; pageId: string }> }
) {
  const { id: _jobId } = await params
  const auth = await requireContentJobAccess(_jobId)
  if (auth instanceof NextResponse) return auth
  const sessionId = auth.sessionId
  const { pageId } = await params
  const body = await req.json()
  const supabase = createServerClient()

  // Load current row so we can detect material changes before writing.
  const { data: existing, error: loadErr } = await supabase
    .from('page_outlines')
    .select('id, content_job_id, page_url, h1, sections, cta, admin_notes')
    .eq('id', pageId)
    .eq('content_job_id', _jobId)
    .single()
  if (loadErr || !existing) {
    return loadErr
      ? internalError('outline:patch', loadErr, 'Outline not found', 404)
      : NextResponse.json({ error: 'Outline not found' }, { status: 404 })
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (body.h1 !== undefined) {
    // A blank h1 reads as "still generating" everywhere, and the runner would
    // overwrite the row with fresh AI output.
    if (typeof body.h1 !== 'string' || !body.h1.trim()) {
      return NextResponse.json({ error: 'The H1 can’t be blank.' }, { status: 400 })
    }
    updates.h1 = body.h1
  }
  if (body.sections !== undefined) {
    // sections must be a proper JSON array — never a string or object.
    if (!Array.isArray(body.sections)) {
      return NextResponse.json(
        { error: 'sections must be an array' },
        { status: 400 }
      )
    }
    updates.sections = body.sections as Json
  }
  if (body.admin_notes !== undefined) updates.admin_notes = body.admin_notes
  if (body.angle !== undefined) {
    // Per-page angle/POV directive. An angle-only edit does NOT invalidate
    // already-generated content (it's not in the materialChanged set below) —
    // it only steers the next generation.
    if (body.angle !== null && typeof body.angle !== 'string') {
      return NextResponse.json({ error: 'angle must be a string or null' }, { status: 400 })
    }
    updates.angle = body.angle
  }
  if (body.admin_approved !== undefined) updates.admin_approved = body.admin_approved
  if (body.cta !== undefined) {
    if (body.cta === null) {
      updates.cta = null
    } else if (
      body.cta && typeof body.cta === 'object' &&
      typeof body.cta.text === 'string' && typeof body.cta.url === 'string'
    ) {
      updates.cta = { text: body.cta.text, url: body.cta.url } as Json
    } else {
      return NextResponse.json({ error: 'cta must be null or { text, url }' }, { status: 400 })
    }
  }

  if (updates.admin_approved === true) {
    const resulting = {
      h1: updates.h1 ?? existing.h1,
      sections: updates.sections ?? existing.sections,
      admin_notes: updates.admin_notes !== undefined ? updates.admin_notes : existing.admin_notes,
    }
    if (!isApprovableOutline(resulting)) {
      return NextResponse.json(
        { error: 'This outline is still a placeholder. Fill in the sections and clear the “⚠ Needs review” note (or regenerate it) before approving.' },
        { status: 422 },
      )
    }
  }

  // Detect material outline changes against the existing row. Material =
  // anything that affects what the LLM would generate next (h1, sections, cta).
  // admin_approved/admin_notes don't count.
  const materialChanged =
    (body.h1 !== undefined && body.h1 !== existing.h1) ||
    (body.sections !== undefined && !deepEqual(body.sections, existing.sections)) ||
    (body.cta !== undefined && !deepEqual(body.cta ?? null, existing.cta))

  const { data, error } = await supabase
    .from('page_outlines')
    .update(updates)
    .eq('id', pageId)
    .eq('content_job_id', _jobId)
    .select('*')
    .single()

  if (error) {
    return internalError('outline:patch', error, "Couldn't update the outline")
  }

  if (materialChanged) {
    // Cascade-reset the matching generated_pages row's approval. Existing
    // copy stays in place so admin can compare and decide whether to
    // regenerate, but the package gate will block until they re-approve.
    const { error: cascadeErr } = await supabase
      .from('generated_pages')
      .update({ admin_approved_content: false, client_approved_content: false })
      .eq('content_job_id', existing.content_job_id)
      .eq('page_url', existing.page_url)
    if (cascadeErr) {
      console.warn(`[outline-patch] approval cascade failed for ${existing.page_url}:`, cascadeErr.message)
    }

    after(() =>
      reviewContentForMbpImpact({
        sessionId,
        origin: 'outline_edit',
        sourceRef: existing.page_url ?? pageId,
        changedText: JSON.stringify({ h1: data.h1, sections: data.sections, cta: data.cta }),
      }).catch(err => console.error('[mbp-impact] outline_edit review failed:', err))
    )
  }

  return NextResponse.json({ outline: data, materialChanged })
}
