import type { createServerClient } from '@/lib/supabase/server'

// Send page bodies written from a since-replaced outline back to `pending`, so
// the next generation run rewrites them instead of skipping them as `complete`.
// Only for jobs still before phase 5: once generation has started, the operator
// regenerates a page explicitly. A `running` row is left to its worker.
export async function resetStalePages(
  supabase: ReturnType<typeof createServerClient>,
  contentJobId: string,
  pageUrls?: string[],
): Promise<void> {
  let q = supabase
    .from('generated_pages')
    .update({
      generation_status: 'pending',
      generation_error: null,
      generation_attempts: 0,
      admin_approved_content: false,
      client_approved_content: false,
      qa_status: null,
    })
    .eq('content_job_id', contentJobId)
    .neq('generation_status', 'running')
  if (pageUrls) q = q.in('page_url', pageUrls)
  const { error } = await q
  if (error) console.warn(`[outline-regen] stale page reset failed for job ${contentJobId}:`, error.message)
}
