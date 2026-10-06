import { createHash } from 'node:crypto'
import { after, NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { readJsonBody } from '@/app/api/_json'
import { createServerClient } from '@/lib/supabase/server'
import { asJson } from '@/lib/supabase/json-typed'
import { requireContentJobAccess } from '@/lib/auth/access'
import { reviewContentForMbpImpact } from '@/lib/mbp/impact-review'
import { fenceQaForHumanEdit } from '@/lib/content/qa/fence'
import { parseQaReview } from '@/types/qa-review'
import { applyOneFinding } from '@/lib/content/qa/apply-finding'
import { loadProtectedTexts } from '@/lib/content/qa/protected'

interface QaFindingActionBody { findingId?: unknown; action?: unknown }

const md5 = (s: string) => createHash('md5').update(s).digest('hex')

// Human Apply/Dismiss on ONE QA finding. An apply that changes content is a
// human-approved content edit: fence QA out before writing (same as the page
// PATCH route) and run the MBP impact review afterward.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; pageId: string }> }) {
  const { id, pageId } = await params
  const auth = await requireContentJobAccess(id)
  if (auth instanceof NextResponse) return auth
  const sessionId = auth.sessionId

  const body = await readJsonBody<QaFindingActionBody>(req)
  if (body instanceof NextResponse) return body
  if (typeof body.findingId !== 'string' || (body.action !== 'apply' && body.action !== 'dismiss')) {
    return NextResponse.json({ error: 'findingId and action (apply|dismiss) are required' }, { status: 400 })
  }

  const supabase = createServerClient()
  const { data: row, error } = await supabase
    .from('generated_pages')
    .select('content_markdown, meta_title, meta_description, qa_review, page_url')
    .eq('id', pageId).eq('content_job_id', id).maybeSingle()
  if (error) return internalError('qa-findings:load', error, "Couldn't load the page")
  if (!row) return NextResponse.json({ error: 'Page not found' }, { status: 404 })
  const review = parseQaReview(row.qa_review)
  if (!review) return NextResponse.json({ error: 'This page has no QA report' }, { status: 409 })

  const pageBody = row.content_markdown ?? ''
  let protectedTexts: string[] = []
  if (body.action === 'apply') {
    const prot = await loadProtectedTexts(supabase, { contentJobId: id, sessionId, pageUrl: row.page_url, body: pageBody })
    if (!prot.ok) return internalError('qa-findings:protected', prot.error, "Couldn't check the page's word-for-word text")
    protectedTexts = prot.texts
  }

  // templateVersion is intentionally not passed here: the only variant fixes
  // that exist today (rules' media-side alternation) are baseline-safe at
  // every template version, so there's nothing yet that needs it gated.
  const result = applyOneFinding(
    { body: pageBody, metaTitle: row.meta_title, metaDescription: row.meta_description },
    review, body.findingId, body.action, protectedTexts,
  )
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })

  const contentChanged = result.fields.body !== pageBody
    || result.fields.metaTitle !== row.meta_title
    || result.fields.metaDescription !== row.meta_description

  // A human edit wins over QA: fence QA out BEFORE writing, so an in-flight QA
  // write can't land between this update and the fence and overwrite the
  // human's text (same ordering as the page PATCH route).
  if (contentChanged) {
    await fenceQaForHumanEdit(supabase, pageId, { contentJobId: id })
  }

  // CAS moved server-side (migration 084): PostgREST rejects a `.eq()` filter
  // once the full page body is in the query string (confirmed in prod — a
  // 12k-char body passes, 30k is a flat 400), and pages are capped at 50k.
  // The function compares an md5 of the body instead — only when this action
  // actually changes content; `dismiss` passes NULL so an unrelated
  // concurrent content edit never 409s it — plus the qa_review.rev counter,
  // which doubles as the lock on the review itself.
  const { data: updated, error: rpcErr } = await supabase.rpc('qa_apply_page_update', {
    p_page_id: pageId,
    p_job_id: id,
    p_expected_content_md5: contentChanged ? md5(row.content_markdown ?? '') : null,
    p_expected_rev: review.rev ?? 0,
    p_qa_review: asJson(result.review),
    p_content_changed: contentChanged,
    p_content: contentChanged ? result.fields.body : null,
    p_meta_title: contentChanged ? result.fields.metaTitle : null,
    p_meta_description: contentChanged ? result.fields.metaDescription : null,
  })
  if (rpcErr) return internalError('qa-findings:save', rpcErr, "Couldn't save the change")
  if (!updated?.length) return NextResponse.json({ error: 'The page changed while you were reviewing — reload and try again.' }, { status: 409 })

  const saved = updated[0]
  if (contentChanged && typeof saved.content_markdown === 'string') {
    after(() =>
      reviewContentForMbpImpact({
        sessionId,
        origin: 'page_edit',
        sourceRef: saved.page_url ?? pageId,
        changedText: saved.content_markdown ?? '',
      }).catch(err => console.error('[mbp-impact] page_edit review failed:', err))
    )
  }

  return NextResponse.json({ page: saved, qaReview: result.review })
}
