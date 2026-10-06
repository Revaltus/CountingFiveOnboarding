import type { createServerClient } from '@/lib/supabase/server'
import type { SessionSchema } from '@/types/session-schema'
import { activeTeam } from '@/lib/content/active-team'
import { parseBlockAnnotations } from '@/lib/content/block-annotation-validator'

type Supabase = ReturnType<typeof createServerClient>

// protectedTexts is the set of body substrings no patch may ever touch:
//   - a verbatim page: the whole body (nothing generated here is ours to fix)
//   - otherwise: section bodies whose heading matches an active team member's
//     name — these are word-for-word bios the operator asked to preserve.
export function protectedTextsFor(body: string, verbatim: boolean, teamNames: string[]): string[] {
  if (verbatim) return [body]
  const names = teamNames.map(n => n.toLowerCase()).filter(Boolean)
  if (!names.length) return []
  return parseBlockAnnotations(body)
    .filter(s => names.some(n => s.headingText.toLowerCase().includes(n)))
    .map(s => s.sectionContent.trim())
    .filter(Boolean)
}

// Loads what protectedTextsFor needs for one page. Any read failure returns
// ok:false — a transient error must never read as "not verbatim", which would
// strip protection from a verbatim page.
export async function loadProtectedTexts(
  supabase: Supabase,
  page: { contentJobId: string; sessionId: string; pageUrl: string; body: string },
): Promise<{ ok: true; texts: string[] } | { ok: false; error: unknown }> {
  const [outlineRes, sessionRes] = await Promise.all([
    supabase
      .from('page_outlines')
      .select('generation_mode')
      .eq('content_job_id', page.contentJobId)
      .eq('page_url', page.pageUrl)
      .maybeSingle(),
    supabase.from('sessions').select('schema_data').eq('id', page.sessionId).maybeSingle(),
  ])
  if (outlineRes.error) return { ok: false, error: outlineRes.error }
  if (sessionRes.error || !sessionRes.data) return { ok: false, error: sessionRes.error ?? new Error('session not found') }
  const schema = (sessionRes.data.schema_data ?? {}) as SessionSchema
  const verbatim = outlineRes.data?.generation_mode === 'verbatim'
  const teamNames = activeTeam(schema).map(m => m.name)
  return { ok: true, texts: protectedTextsFor(page.body, verbatim, teamNames) }
}
