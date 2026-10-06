// Per-page QA Desk orchestrator: claims a completed, unapproved page
// atomically, runs deterministic rules → AI specialists → the patch merger →
// the senior-editor judge, and writes the verdict (and, in `on` mode, the
// patched content) back under a fenced write. Mirrors the claim/fence pattern
// generateSinglePage uses for `generation_status` — never touches that column.
import { createServerClient } from '@/lib/supabase/server'
import { asJson } from '@/lib/supabase/json-typed'
import type { Database } from '@/types/database'
import { loadPageGenContext, type PageGenContext } from '@/lib/content/content-generator'
import { loadNoGoPhrases } from '@/lib/content/no-go-phrases'
import { clientAvoidPhrases } from '@/lib/content/brand-voice'
import { activeTeam } from '@/lib/content/active-team'
import { countWords } from '@/lib/content/word-count-validator'
import { scoreDraft, CRITIC_CALL_CAP_MS } from '@/lib/content/draft-critic'
import { CRITIC_MODEL } from '@/lib/content/generation-tuning'
import type { QaReview } from '@/types/qa-review'
import { qaMode, QA_MAX_ATTEMPTS, type QaMode } from './mode'
import { runRules } from './rules'
import { runAllSpecialists } from './specialists/run'
import { mergeFindings } from './merge'
import { protectedTextsFor } from './protected'
import { judgeFindings, judgeUnavailableFinding, dedupeFindings, qaPasses, agentScores } from './judge'

type Supabase = ReturnType<typeof createServerClient>
type PageUpdate = Database['public']['Tables']['generated_pages']['Update']

export type QaDeps = {
  supabase?: Supabase
  loadContext?: (s: Supabase, jobId: string) => Promise<PageGenContext | null>
  specialists?: typeof runAllSpecialists
  judge?: typeof scoreDraft
  noGo?: () => Promise<string[]>
  mode?: QaMode
  now?: () => string
}

const PAGE_COLS =
  'id, content_job_id, page_url, page_title, generation_status, admin_approved_content, qa_status, qa_attempts, content_markdown, meta_title, meta_description, target_keyword, hero_block, hero_variant, hero_subhead, faq_block'

export async function runQaForPage(
  contentJobId: string,
  pageId: string,
  deps: QaDeps = {},
): Promise<{ status: 'done' | 'skipped' | 'error'; reason?: string }> {
  const mode = deps.mode ?? qaMode()
  if (mode === 'off') return { status: 'skipped', reason: 'QA is off' }
  const supabase = deps.supabase ?? createServerClient()
  const now = deps.now ?? (() => new Date().toISOString())

  const { data: row, error: rowErr } = await supabase
    .from('generated_pages')
    .select(PAGE_COLS)
    .eq('id', pageId)
    .eq('content_job_id', contentJobId)
    .maybeSingle()
  // No claim was taken yet, so a read failure needs no fenced DB write — just
  // report it as an error rather than silently treating it as "not found"
  // (which a transient failure must never be confused with).
  if (rowErr) {
    console.error(`[qa] row read failed for page ${pageId}:`, rowErr)
    return { status: 'error', reason: 'page read failed' }
  }
  if (!row) return { status: 'skipped', reason: 'page not found' }
  if (row.generation_status !== 'complete' || row.admin_approved_content) {
    return { status: 'skipped', reason: 'not reviewable' }
  }
  if ((row.qa_attempts ?? 0) >= QA_MAX_ATTEMPTS) return { status: 'skipped', reason: 'attempt cap' }

  const stamp = now()
  const { data: claimed } = await supabase
    .from('generated_pages')
    .update({ qa_status: 'running', qa_started_at: stamp, qa_attempts: (row.qa_attempts ?? 0) + 1 })
    .eq('id', pageId)
    .eq('content_job_id', contentJobId)
    .eq('generation_status', 'complete')
    .eq('admin_approved_content', false)
    .in('qa_status', ['queued', 'error'])
    .lt('qa_attempts', QA_MAX_ATTEMPTS)
    // Optimistic attempts CAS: two racing claims both read N; only one can
    // move N → N+1, so a double-fire can't both win.
    .eq('qa_attempts', row.qa_attempts ?? 0)
    .select('id')
  if (!claimed?.length) return { status: 'skipped', reason: 'claim lost' }

  try {
    const { data: outline, error: outlineErr } = await supabase
      .from('page_outlines')
      .select('sections, generation_mode')
      .eq('content_job_id', contentJobId)
      .eq('page_url', row.page_url)
      .maybeSingle()
    // A transient failure here must never silently read as "not verbatim" —
    // outline null -> verbatim=false would strip protection from a verbatim
    // page's body. Throw so the catch below fences qa_status to 'error' and
    // the page is retried within the attempt cap.
    if (outlineErr) throw new Error(`outline read failed: ${outlineErr.message}`)
    // Patches only land while the job is still in generation (phase 5). A retry
    // that fires after phase 6 (a human may be proofing) is report-only, as is
    // any run whose job phase can't be read — never guess toward writing.
    const { data: job, error: jobErr } = await supabase
      .from('content_jobs')
      .select('phase')
      .eq('id', contentJobId)
      .maybeSingle()
    if (jobErr) console.warn(`[qa] job phase read failed for ${contentJobId}; running report-only:`, jobErr)
    const apply = mode === 'on' && job?.phase === 5
    const ctx = await (deps.loadContext ?? loadPageGenContext)(supabase, contentJobId)
    if (!ctx) throw new Error('content job context unavailable')
    const verbatim = outline?.generation_mode === 'verbatim'
    const body = row.content_markdown ?? ''
    const noGo = await (deps.noGo ?? (async () => (await loadNoGoPhrases()).map(p => p.phrase)))()
    const teamNames = activeTeam(ctx.schema).map(m => m.name)
    const outlineSections = outline?.sections ?? []

    const rules = runRules({
      body,
      metaTitle: row.meta_title,
      metaDescription: row.meta_description,
      heroBlock: row.hero_block,
      heroVariant: row.hero_variant,
      heroSubhead: row.hero_subhead,
      faqBlock: row.faq_block,
      noGoPhrases: noGo,
      avoidPhrases: clientAvoidPhrases(ctx.schema),
    })
    const spec = await (deps.specialists ?? runAllSpecialists)({
      pageUrl: row.page_url,
      pageTitle: row.page_title,
      body,
      metaTitle: row.meta_title,
      metaDescription: row.meta_description,
      targetKeyword: row.target_keyword,
      outlineSections,
      sitemapUrls: ctx.sitemapUrls,
      verbatim,
      ruleHits: rules,
      schema: ctx.schema,
      sessionId: ctx.sessionId,
      contentJobId,
    })
    const merged = mergeFindings(
      { body, metaTitle: row.meta_title, metaDescription: row.meta_description },
      [...rules, ...spec],
      {
        apply,
        protectedTexts: protectedTextsFor(body, verbatim, teamNames),
        templateVersion: ctx.templateVersion,
      },
    )
    const judge = verbatim
      ? null
      : await (deps.judge ?? scoreDraft)(
          {
            pageId,
            pageUrl: row.page_url,
            pageTitle: row.page_title,
            contentMarkdown: merged.fields.body,
            outlineSections,
            targetKeyword: row.target_keyword ?? '',
            // The judge here grades accuracy/coverage against the outline and firm
            // profile; information gain vs. a competitor is the writer's job and is
            // already scored by the legacy critic in shadow mode.
            competitorRefs: [],
            schema: ctx.schema,
            sessionId: ctx.sessionId,
            contentJobId,
          },
          CRITIC_MODEL,
          { timeoutMs: CRITIC_CALL_CAP_MS, stage: 'qa_judge' },
        )

    // Verbatim pages skip the judge by design; anywhere else a null judge means
    // it failed, which must fail QA rather than silently pass.
    const judgeMissing = !verbatim && judge === null
    const findings = dedupeFindings([
      ...merged.findings,
      ...judgeFindings(judge),
      ...(judgeMissing ? [judgeUnavailableFinding()] : []),
    ])
    const review: QaReview = {
      mode,
      ran_at: now(),
      findings,
      scores: agentScores(findings),
      judge,
      passed: qaPasses(judge, findings),
    }

    const update: PageUpdate = { qa_status: 'done', qa_review: asJson(review) }
    if (apply) {
      if (merged.fields.body !== body) {
        update.content_markdown = merged.fields.body
        update.word_count_actual = countWords(merged.fields.body)
      }
      update.meta_title = merged.fields.metaTitle
      update.meta_description = merged.fields.metaDescription
    }
    if (mode === 'on') {
      // A null judge clears critic_review so a stale flag from an earlier
      // generation can't drive needs-review; the QA chip carries the signal.
      update.critic_review = judge ? asJson({ ...judge, needs_human_review: !review.passed }) : null
    }

    const { data: written, error: writeErr } = await supabase
      .from('generated_pages')
      .update(update)
      .eq('id', pageId)
      .eq('qa_status', 'running')
      .eq('qa_started_at', stamp)
      .eq('generation_status', 'complete')
      .eq('admin_approved_content', false)
      .select('id')
    // A write error must not leave the row 'running' until the stuck sweep;
    // throw so the catch fences it to 'error' (retriable within the cap) now.
    if (writeErr) throw new Error(`final QA write failed: ${writeErr.message}`)
    if (!written?.length) return { status: 'skipped', reason: 'page changed during QA' }
    return { status: 'done' }
  } catch (err) {
    console.error(`[qa] run failed for page ${pageId}:`, err)
    await supabase
      .from('generated_pages')
      .update({ qa_status: 'error' })
      .eq('id', pageId)
      .eq('qa_status', 'running')
      .eq('qa_started_at', stamp)
    return { status: 'error', reason: 'QA run failed' }
  }
}
