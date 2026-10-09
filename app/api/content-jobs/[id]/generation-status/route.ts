import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { createServerClient } from '@/lib/supabase/server'
import { requireContentJobAccess } from '@/lib/auth/access'
import { summarizeCritic } from '@/lib/content/critic-review'
import { summarizeQa } from '@/types/qa-review'
import { qaMode } from '@/lib/content/qa/mode'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: _jobId } = await params
  const auth = await requireContentJobAccess(_jobId)
  if (auth instanceof NextResponse) return auth
  const isAdmin = auth.user.isAdmin

  const { id } = await params
  const supabase = createServerClient()

  const [{ data: pages, error }, { data: job }, { data: outlines }] = await Promise.all([
    supabase
      .from('generated_pages')
      .select('id, page_url, page_title, generation_status, generation_error, generation_started_at, admin_approved_content, needs_client_review, client_approved_content, word_count_actual, word_count_target')
      .eq('content_job_id', id)
      .order('created_at', { ascending: true }),
    supabase
      .from('content_jobs')
      .select('confirmed_sitemap')
      .eq('id', id)
      .single(),
    supabase
      .from('page_outlines')
      .select('page_url, admin_approved')
      .eq('content_job_id', id),
  ])

  if (error) {
    return internalError('generation-status', error, "Couldn't load generation status")
  }

  const sitemap = (job?.confirmed_sitemap ?? []) as Array<{ url: string; parent?: string }>
  const parentByUrl = new Map(sitemap.map(p => [p.url, p.parent]))
  // Generation only runs approved outlines, so a pending page whose outline is
  // unapproved can't be moved by Restart — the UI says so instead of spinning.
  const outlineApprovedByUrl = new Map((outlines ?? []).map(o => [o.page_url, o.admin_approved]))

  // Advisory critic scores are fetched separately and best-effort: the
  // critic_review column may not exist yet (pre-migration 064), so a failure
  // here must not break the core status poll — it just omits the score chips.
  const criticByPage = new Map<
    string,
    { overall: number; hasFlags: boolean; needsReview: boolean; regenerated: boolean }
  >()
  // QA Desk summary is fetched the same best-effort way: qa_review/qa_status
  // may not exist yet (pre-migration 083), so a failure here must not break
  // the core status poll — it just omits the QA chip.
  const qaByPage = new Map<string, { summary: ReturnType<typeof summarizeQa>; status: string | null }>()
  try {
    const { data: criticRows, error: criticErr } = await supabase
      .from('generated_pages')
      .select('id, critic_review, qa_review, qa_status')
      .eq('content_job_id', id)
    if (!criticErr) {
      for (const r of criticRows ?? []) {
        const summary = summarizeCritic(r.critic_review)
        if (summary) criticByPage.set(r.id, summary)
        qaByPage.set(r.id, { summary: summarizeQa(r.qa_review), status: r.qa_status ?? null })
      }
    }
  } catch {
    // critic_review/qa_review columns absent pre-migration — degrade silently.
  }

  const all = pages ?? []
  return NextResponse.json({
    total: all.length,
    complete: all.filter(p => p.generation_status === 'complete').length,
    running: all.filter(p => p.generation_status === 'running').length,
    error: all.filter(p => p.generation_status === 'error').length,
    approved: all.filter(p => p.generation_status === 'complete' && p.admin_approved_content).length,
    needsClientReview: all.filter(p => p.needs_client_review).length,
    clientApproved: all.filter(p => p.needs_client_review && p.client_approved_content).length,
    qaMode: qaMode(),
    pages: all.map(p => ({
      id: p.id,
      url: p.page_url,
      title: p.page_title,
      status: p.generation_status,
      // Full failure detail (may carry upstream API/infra strings) is admin-only;
      // members get a generic message and can still retry.
      errorMessage: p.generation_error
        ? isAdmin
          ? p.generation_error
          : 'Generation failed — retry this page or check server logs.'
        : null,
      startedAt: p.generation_started_at,
      parent: parentByUrl.get(p.page_url),
      outlineApproved: outlineApprovedByUrl.get(p.page_url) ?? true,
      approved: p.admin_approved_content,
      needsClientReview: p.needs_client_review,
      clientApproved: p.client_approved_content,
      wordCountActual: p.word_count_actual,
      wordCountTarget: p.word_count_target,
      critic: criticByPage.get(p.id) ?? null,
      qa: qaByPage.get(p.id)?.summary ?? null,
      qaStatus: qaByPage.get(p.id)?.status ?? null,
    })),
  })
}
