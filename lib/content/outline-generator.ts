import { generateText } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { createServerClient } from '@/lib/supabase/server'
import { derivePaletteToneSignal } from './palette-tone-signal'
import { buildFirmContext } from './brand-voice'
import { loadNoGoPhrases, buildNoGoPromptBlock } from './no-go-phrases'
import { activeNiches } from './active-niches'
import { arr, str } from './schema-coerce'
import { cleanHeading } from './anti-slop-validator'
import { OUTLINE_EXEMPLAR } from './exemplars'
import { resolvePageIntent } from './page-intent'
import { truncateToTokenBudget, checkTokenBudget } from './truncate-to-token-budget'
import { recordTokenUsage } from './token-usage'
import { buildCachedMessages, extractCacheUsage } from './cache-control'
import { extractJson } from './extract-json'
import { OUTLINE_PRIMARY_PROVIDER_OPTIONS, OUTLINE_PROVIDER_OPTIONS, PUBLISHED_CONTENT_MODEL } from './generation-tuning'
import { createBudget, runWithPool, OUTLINE_CALL_CAP_MS } from './generation-budget'

// Must match the maxDuration on /api/content-jobs/[id]/outlines/{generate,regenerate-all}.
const OUTLINE_ROUTE_MAX_DURATION_MS = 300_000
// One outline is a small call (measured output p50 881 tokens) plus its low-effort
// retry rung; don't begin one without room for both.
const OUTLINE_MIN_VIABLE_MS = 90_000
import { OUTLINE_FALLBACK_NOTE, buildExclusionConflictNote, buildOutlineFailureNote, buildOutlineRefusalNote, isRefusedOutline } from './outline-fallback'
import { matchingExclusion, operatorExclusions } from './exclusion-match'
import type { SessionSchema } from '@/types/session-schema'
import type { PaletteData } from '@/types/palette'
import type { AuditResult } from '@/types/audit-result'
import { asJson } from '@/lib/supabase/json-typed'
import { OUTLINE_STALE_CLAIM_MS } from './outline-resume'
import { readSnapshot } from '@/lib/onboarding/page-snapshot'

const OUTLINE_MODEL = PUBLISHED_CONTENT_MODEL

// Strip scheme + trailing slash so a sitemap's http:// URL still matches the
// crawler's final https:// URL for the same page.
const normUrl = (u: string) =>
  u.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase()

type AuditPageSummary = NonNullable<AuditResult['page_analysis_summary']>[number]

// Build a normalized-URL → per-page audit summary lookup once per job so the
// batch loop doesn't linear-scan page_analysis_summary for every page (O(n²)).
export function buildAuditPageIndex(auditResult: AuditResult | null): Map<string, AuditPageSummary> {
  const index = new Map<string, AuditPageSummary>()
  for (const p of auditResult?.page_analysis_summary ?? []) {
    if (!index.has(normUrl(p.url))) index.set(normUrl(p.url), p)
  }
  return index
}

type OutlineResult = {
  h1: string
  sections: Array<{ h2: string; description: string; word_count: number }>
  target_keyword: string
  notes?: string
}

// Per-page research row, as consumed here. Loosely typed (JSONB columns) so the
// existing downstream casts (as string[], as Array<...>) still apply.
export type PageResearch = {
  target_keyword: string | null
  secondary_keywords: unknown
  competitor_references: unknown
  existing_content: string | null
  merged_content: string | null
}

// Measured 2026-10-09 (scripts/measure-outline-prompt.ts): 4.0k–5.4k input tokens
// per outline; a 13-service firm sits at the top. ~4k of it is the cached prefix
// (read at 0.05x). Above this, something regressed — e.g. an unbounded block.
const OUTLINE_INPUT_TOKEN_TARGET = 6000

// Outline-only trims (the page writer keeps its fuller inputs).
const OUTLINE_MAX_SECONDARY_KEYWORDS = 10
const OUTLINE_COMPETITOR_EXCERPT_CHARS = 250

// Strip what a raw scrape drags along: HTML entities, "Skip to content",
// leftover comment markers, repeated whitespace.
export function cleanScrapedText(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/-->|<!--/g, ' ')
    .replace(/\bSkip to (?:main )?content\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type OutlinePromptInput = {
  pageTitle: string
  pageUrl: string
  schema: SessionSchema
  palette: PaletteData | null
  research: PageResearch | null
  auditedPage: AuditPageSummary | undefined
  noGoPhrases: string[]
}

// Pure prompt assembly for one outline: the job-constant `staticPrefix` (cached)
// and the per-page `dynamicSuffix`. Exported so the prompt can be measured and
// tested without a model call (scripts/measure-outline-prompt.ts).
export function buildOutlinePrompt(input: OutlinePromptInput): {
  staticPrefix: string
  dynamicSuffix: string
  targetKeyword: string
} {
  const { pageTitle, pageUrl, schema, palette, research, auditedPage, noGoPhrases } = input
  const targetKeyword = research?.target_keyword ?? pageTitle.toLowerCase()
  const secondaryKeywords = ((research?.secondary_keywords as string[]) ?? []).slice(0, OUTLINE_MAX_SECONDARY_KEYWORDS)
  const competitorRefs = (research?.competitor_references as Array<{ url: string; title: string; excerpt: string }>) ?? []
  const existingContent = research?.existing_content ?? ''
  const mergedContent = research?.merged_content ?? ''

  const paletteTone = derivePaletteToneSignal(palette)

  // Competitor excerpts are raw page scrapes (nav menus, "Skip to content",
  // HTML entities). An outline only needs the gist of how rivals pitch, so each
  // is cleaned and kept short.
  const competitorExcerpts = truncateToTokenBudget(
    competitorRefs
      .slice(0, 3)
      .map(c => `[${cleanScrapedText(c.title)}]\n${cleanScrapedText(c.excerpt ?? '').slice(0, OUTLINE_COMPETITOR_EXCERPT_CHARS)}`)
      .join('\n\n'),
    300
  )

  // Site-wide content gaps from the audit (if the session came from one). It sits
  // in every page's prompt, so each list is kept to its top 3, without URLs.
  const cg = schema.content_gaps
  const gapItems = (items: unknown) =>
    arr(items as unknown[] | undefined)
      .map(x => str(x).replace(/\s*\(https?:\/\/[^)]*\)/g, '').trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 3)
      .join('; ')
  const gapsBlock =
    cg && (cg.authorityGaps?.length || cg.conversionGaps?.length || cg.nicheGaps?.length || cg.teamExpertiseGaps?.length)
      ? [
          'SITE AUDIT — CONTENT GAPS (address where relevant to this page):',
          cg.conversionGaps?.length ? `Conversion: ${gapItems(cg.conversionGaps)}` : '',
          cg.authorityGaps?.length ? `Depth/authority: ${gapItems(cg.authorityGaps)}` : '',
          cg.nicheGaps?.length ? `Coverage: ${gapItems(cg.nicheGaps)}` : '',
          cg.teamExpertiseGaps?.length ? `Team expertise to leverage: ${gapItems(cg.teamExpertiseGaps)}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : ''

  // Per-page audit findings — what's wrong with this exact page today. Prefer
  // the prebuilt index (O(1)); fall back to a scan for standalone callers.
  const auditHintsBlock = auditedPage
    ? [
        'SITE AUDIT — THIS PAGE TODAY (the rewrite must fix these):',
        `Current length: ${auditedPage.word_count} words${auditedPage.word_count < 300 ? ' (thin — expand substantially)' : ''}`,
        auditedPage.issues.length ? `Issues: ${auditedPage.issues.slice(0, 6).join('; ')}` : '',
        auditedPage.suggested_title ? `Suggested title: ${auditedPage.suggested_title}` : '',
        auditedPage.suggested_meta ? `Suggested meta: ${auditedPage.suggested_meta}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : ''

  const noGoBlock = buildNoGoPromptBlock(noGoPhrases)

  // Static, job-constant prefix (firm context + site-wide content gaps + the
  // output/rules spec). Cache breakpoint via buildCachedMessages so every page
  // outline in a job reuses it as a cache read. Per-page inputs live in
  // dynamicSuffix below — keep every per-page value OUT of this string.
  const staticPrefix = `You are a website content strategist for a CPA firm. Generate a structured page outline — not copy, just structure.

FIRM CONTEXT:
Brand voice: ${schema.brand?.currentTone ?? 'professional and approachable'}
Positioning: ${schema.business?.positioningOption ?? ''} — ${schema.business?.positioningStatement?.slice(0, 200) ?? ''}
Differentiators: ${schema.business?.differentiators ?? 'Not specified'}
${activeNiches(schema).length ? '' : 'Niches: General CPA services\n'}${paletteTone ? `Palette tone: ${paletteTone}` : ''}

${buildFirmContext(schema, { includeCompetitors: false })}

${gapsBlock}

OUTPUT FORMAT (JSON only, no prose):
{
  "h1": "...",
  "sections": [
    { "h2": "...", "description": "A specific brief for the copywriter: the angle this section takes AND which concrete input it draws on — the exact niche persona/pain, the proof point or credential, or the keyword it targets.", "word_count": 150 }
  ],
  "target_keyword": "...",
  "notes": "Optional: anything the copywriter should know about tone or angle for this page."
}

RULES:
- 4–7 sections per page (fewer for simple pages, more for comprehensive service pages)
- H1 must contain or closely relate to the target keyword
- Section descriptions are a WORKING BRIEF, not a topic label. Each must name the concrete material the copywriter should use — a specific niche audience and their pain, a real credential or proof point from the firm context, or the keyword the section targets. Generic placeholders ("Add content here", "Overview of services", "Introduction to the topic") are unacceptable — every description must be specific enough that two different writers would produce the same-shaped section.
- Word counts should total 600–1200 words for standard pages, 1500–2000 for pillar pages
- Do not write any actual copy — structure only

${OUTLINE_EXEMPLAR}

HEADING RULES (h1 and every h2):
- Specific and benefit-driven, in sentence case
- No parenthetical subtitles, e.g. "(Beyond the Buzzwords)"
- No colon-cliché subtitles ("A Deep Dive", "A Complete/Ultimate Guide", "Everything You Need to Know")
- Never "What X Actually Means", "Beyond the …", "The Importance of …", "A Closer Look", "Demystifying/Decoding/Unpacking", or listicle titles ("5 Reasons …")
- No dashes (— or –) in any heading${noGoBlock ? `\n\n${noGoBlock}` : ''}`

  // Per-page dynamic suffix — everything that varies per page, kept out of the
  // cached prefix. The page-intent focus block points the model at the ONE niche
  // or service this page is about (the cached firm context lists them all).
  const intent = resolvePageIntent(pageUrl, pageTitle, schema)
  const focusBlock = intent.focusBlock ? `\n${intent.focusBlock}\n` : ''
  const dynamicSuffix = `PAGE: ${pageTitle} (${pageUrl})
TARGET KEYWORD: ${targetKeyword}
SECONDARY KEYWORDS: ${secondaryKeywords.join(', ')}
${focusBlock}

${existingContent ? `EXISTING CONTENT (current site — improve on this):\n${existingContent.slice(0, 800)}` : ''}

${mergedContent ? `MERGED INTO THIS PAGE (an operator folded these current pages into this one — plan sections that carry over all of their substance):\n${mergedContent.slice(0, 4000)}` : ''}

${competitorExcerpts ? `COMPETITOR REFERENCES (SERP top results — differentiate from these):\n${competitorExcerpts}` : ''}

${auditHintsBlock}`

  return { staticPrefix, dynamicSuffix, targetKeyword }
}

export async function generateOutlineForPage(
  outlineId: string,
  pageTitle: string,
  pageUrl: string,
  contentJobId: string,
  sessionId: string,
  schema: SessionSchema,
  palette: PaletteData | null,
  auditResult: AuditResult | null = null,
  auditPageByUrl?: Map<string, AuditPageSummary>,
  researchByUrl?: Map<string, PageResearch>
): Promise<void> {
  const supabase = createServerClient()

  // A verbatim page (operator "bring this page over word-for-word") gets a fixed
  // outline mirroring the captured page's own headings — no AI planning, nothing
  // to restructure. The body is reproduced from the same snapshot at generation.
  const { data: mode } = await supabase
    .from('page_outlines')
    .select('generation_mode, source_snapshot_path')
    .eq('id', outlineId)
    .maybeSingle()
  if (mode?.generation_mode === 'verbatim') {
    const markdown = mode.source_snapshot_path ? await readSnapshot(supabase, sessionId, mode.source_snapshot_path) : null
    const outline = verbatimOutline(pageTitle, markdown)
    await supabase
      .from('page_outlines')
      .update({
        h1: outline.h1,
        sections: asJson(outline.sections),
        target_keyword: outline.target_keyword,
        admin_notes: outline.notes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', outlineId)
    return
  }

  // A page named by an operator-typed exclusion is a sitemap/MBP conflict only a
  // human can settle. Asking the model got either a refusal or copy about the
  // excluded topic; flag it for review without a model call instead.
  const conflict = matchingExclusion(`${pageTitle} ${pageUrl}`, operatorExclusions(schema))
  if (conflict) {
    console.warn(`[outline-gen] ${pageUrl} matches content exclusion "${conflict}" — flagged for review`)
    await supabase
      .from('page_outlines')
      .update({
        h1: pageTitle,
        sections: asJson([{ h2: 'Overview', description: 'Add content here', word_count: 300 }]),
        admin_notes: buildExclusionConflictNote(conflict),
        updated_at: new Date().toISOString(),
      })
      .eq('id', outlineId)
    return
  }

  // Research for this page — prefer the batch-loaded Map (one query for the whole
  // job); fall back to a per-page SELECT when called standalone (regenerate route).
  let research: PageResearch | null
  if (researchByUrl) {
    research = researchByUrl.get(pageUrl) ?? null
  } else {
    const { data } = await supabase
      .from('research_results')
      .select('target_keyword, secondary_keywords, competitor_references, existing_content, merged_content')
      .eq('content_job_id', contentJobId)
      .eq('page_url', pageUrl)
      .limit(1)
      .maybeSingle()
    research = data
  }

  const auditedPage = auditPageByUrl
    ? auditPageByUrl.get(normUrl(pageUrl))
    : auditResult?.page_analysis_summary?.find(p => normUrl(p.url) === normUrl(pageUrl))
  const { staticPrefix, dynamicSuffix, targetKeyword } = buildOutlinePrompt({
    pageTitle,
    pageUrl,
    schema,
    palette,
    research,
    auditedPage,
    noGoPhrases: (await loadNoGoPhrases()).map(p => p.phrase),
  })

  // One outline attempt: call the model, record usage, and parse the JSON. A
  // non-array `sections` (Claude occasionally emits the literal "[]") counts as a
  // parse failure so the retry re-tries rather than shipping a malformed row.
  const attempt = async (
    maxOutputTokens: number,
    providerOptions: Parameters<typeof generateText>[0]['providerOptions']
  ): Promise<{ ok: true; outline: OutlineResult } | { ok: false; finishReason: string }> => {
    const callStartedAt = Date.now()
    const { text, usage, finishReason } = await generateText({
      model: anthropic(OUTLINE_MODEL),
      messages: buildCachedMessages(staticPrefix, dynamicSuffix),
      maxOutputTokens,
      providerOptions,
      maxRetries: 4,
      abortSignal: AbortSignal.timeout(OUTLINE_CALL_CAP_MS),
    })

    const cache = extractCacheUsage(usage)
    console.warn(
      `[outline-gen] page="${pageUrl}" input=${usage?.inputTokens ?? '?'} output=${usage?.outputTokens ?? '?'} cacheRead=${cache.cacheReadInputTokens} cacheWrite=${cache.cacheCreationInputTokens} finish=${finishReason} elapsedMs=${Date.now() - callStartedAt}`
    )
    checkTokenBudget('outline', pageUrl, usage?.inputTokens, OUTLINE_INPUT_TOKEN_TARGET)
    await recordTokenUsage({
      task: 'content',
      contentJobId,
      sessionId,
      stage: 'outline',
      pageUrl,
      model: OUTLINE_MODEL,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cacheReadInputTokens: cache.cacheReadInputTokens,
      cacheCreationInputTokens: cache.cacheCreationInputTokens,
    })

    try {
      // extractJson tolerates fences / surrounding prose (a naive fence-strip +
      // JSON.parse failed on any preamble and burned the retry).
      const parsed = extractJson(text) as OutlineResult | null
      if (!parsed || !Array.isArray(parsed.sections)) return { ok: false, finishReason }
      return { ok: true, outline: parsed }
    } catch {
      return { ok: false, finishReason }
    }
  }

  // Primary attempt: high effort with a generous budget so the reasoned section
  // plan and the full JSON both fit. A parse failure (usually a `length` finish =
  // truncated JSON) retries once with low effort — less thinking leaves more of
  // the budget for the answer — before collapsing to the review-flagged placeholder.
  let res = await attempt(12000, OUTLINE_PRIMARY_PROVIDER_OPTIONS)
  if (!res.ok) {
    console.warn(
      `[outline-gen] Outline JSON parse failed for ${pageUrl} (finish=${res.finishReason}) — retrying with low effort`
    )
    res = await attempt(12000, OUTLINE_PROVIDER_OPTIONS)
  }

  let outline: OutlineResult
  if (res.ok && isRefusedOutline(res.outline)) {
    // A declined page isn't a truncation, so the low-effort retry wouldn't help.
    console.warn(`[outline-gen] Model declined to outline ${pageUrl} — saving a review-flagged placeholder`)
    outline = {
      h1: pageTitle,
      sections: [{ h2: 'Overview', description: 'Add content here', word_count: 300 }],
      target_keyword: res.outline.target_keyword || targetKeyword,
      notes: buildOutlineRefusalNote(res.outline.notes),
    }
  } else if (res.ok) {
    outline = res.outline
  } else {
    console.warn(
      `[outline-gen] Failed to parse outline JSON for ${pageUrl} after retry (finish=${res.finishReason}) — using fallback`
    )
    outline = {
      h1: pageTitle,
      sections: [{ h2: 'Overview', description: 'Add content here', word_count: 300 }],
      target_keyword: targetKeyword,
      notes: OUTLINE_FALLBACK_NOTE,
    }
  }

  // Humanize headings at the source so page generation inherits clean titles
  // (strip parenthetical subtitles, normalize dashes). Admins still review before approval.
  if (typeof outline.h1 === 'string') outline.h1 = cleanHeading(outline.h1)
  outline.sections = outline.sections.map(s =>
    typeof s.h2 === 'string' ? { ...s, h2: cleanHeading(s.h2) } : s
  )

  await supabase
    .from('page_outlines')
    .update({
      h1: outline.h1,
      sections: asJson(outline.sections),
      target_keyword: outline.target_keyword ?? targetKeyword,
      admin_notes: outline.notes ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', outlineId)
}

export async function runOutlineGeneration(
  contentJobId: string,
  sessionId: string
): Promise<void> {
  const supabase = createServerClient()

  // Load session, job, and the audit this session was seeded from (if any) so
  // each outline can target the audit's per-page findings. Only the source
  // audit is linked via session_id (re-audits are unlinked), so this is the
  // baseline "before" snapshot.
  const [{ data: session }, { data: job }, { data: auditRun, error: auditErr }] = await Promise.all([
    supabase.from('sessions').select('schema_data').eq('id', sessionId).single(),
    supabase.from('content_jobs').select('palette').eq('id', contentJobId).single(),
    // A session can have several complete audits linked (re-runs); maybeSingle()
    // errored on >1 row and silently dropped ALL audit context. Take the newest.
    supabase
      .from('audit_runs')
      .select('result')
      .eq('session_id', sessionId)
      .eq('audit_status', 'complete')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (auditErr) console.warn('[outline-gen] audit lookup failed:', auditErr.message)
  const schema = (session?.schema_data ?? {}) as SessionSchema
  const palette = (job?.palette ?? null) as PaletteData | null
  const auditResult = (auditRun?.result ?? null) as AuditResult | null

  // Load all outlines for this job
  const { data: outlines } = await supabase
    .from('page_outlines')
    .select('id, page_url, page_title, h1')
    .eq('content_job_id', contentJobId)
    .order('created_at', { ascending: true })

  if (!outlines?.length) {
    console.warn('[outline-gen] No outlines found for job:', contentJobId)
    return
  }

  // Process in small parallel batches with a soft deadline + self-chain, mirroring
  // the page-body generator (runContentGeneration). A single 120s/300s invocation
  // could not finish a 40+ page job sequentially and got killed mid-run, leaving
  // most rows with null h1 ("still generating") and nothing to resume them. The
  // `!o.h1` filter makes this idempotent, so a chained continuation picks up
  // exactly where the prior invocation was cut off.
  const CONCURRENCY = 3
  // The old fixed 240s soft deadline could NEVER fire here: vercel.json pinned
  // this route to 120s while the route file exported 300, so the function was
  // killed long before 240s elapsed. Both config sources now agree (and a test
  // enforces that), and the budget is checked before every page rather than
  // between batches.
  const budget = createBudget({ maxDurationMs: OUTLINE_ROUTE_MAX_DURATION_MS })
  let completedThisRun = 0

  const auditPageByUrl = buildAuditPageIndex(auditResult)

  // Batch-load research once for the whole job (was a per-page SELECT inside
  // generateOutlineForPage = N+1), mirroring runContentGeneration's researchByUrl.
  const { data: researchRows } = await supabase
    .from('research_results')
    .select('page_url, target_keyword, secondary_keywords, competitor_references, existing_content, merged_content')
    .eq('content_job_id', contentJobId)
  const researchByUrl = new Map<string, PageResearch>()
  for (const r of researchRows ?? []) {
    if (!researchByUrl.has(r.page_url)) researchByUrl.set(r.page_url, r)
  }

  // A model refusal used to be saved as h1 '' — counted as "still generating"
  // by the UI and by the filter below, yet never claimable (the claim requires
  // h1 IS NULL), so Retry did nothing. Reset those rows so they're re-run.
  const blank = outlines.filter(o => o.h1 === '').map(o => o.id)
  if (blank.length) {
    // Un-approve too: the row is about to be replaced by fresh AI output.
    await supabase.from('page_outlines').update({ h1: null, admin_approved: false }).in('id', blank).eq('h1', '')
  }

  const pending = outlines.filter(o => !o.h1)
  const { skipped } = await runWithPool(
    pending,
    CONCURRENCY,
    budget,
    async (outline) => {
      // Atomic per-row claim: a chained continuation and a cron/human re-trigger
      // can overlap; without a claim both generated (and paid for) the same
      // outline. Only a still-unwritten row with no live claim is taken; a claim
      // older than the route's max duration is from a dead worker.
      const staleClaim = new Date(Date.now() - OUTLINE_STALE_CLAIM_MS).toISOString()
      const { data: claimed } = await supabase
        .from('page_outlines')
        .update({ generation_claimed_at: new Date().toISOString() })
        .eq('id', outline.id)
        .is('h1', null)
        .or(`generation_claimed_at.is.null,generation_claimed_at.lt.${staleClaim}`)
        .select('id')
      if (!claimed?.length) return
      try {
        await generateOutlineForPage(
          outline.id,
          outline.page_title,
          outline.page_url,
          contentJobId,
          sessionId,
          schema,
          palette,
          auditResult,
          auditPageByUrl,
          researchByUrl
        )
      } catch (err) {
        console.error(`[outline-gen] Error generating outline for ${outline.page_url}:`, err)
        // Store a review-flagged fallback carrying the real error so the operator
        // sees the cause (isFallbackOutline recognizes the prefix → "Needs review").
        await supabase
          .from('page_outlines')
          .update({
            h1: outline.page_title,
            sections: asJson([{ h2: 'Overview', description: 'Add content here', word_count: 300 }]),
            admin_notes: buildOutlineFailureNote(err),
            updated_at: new Date().toISOString(),
          })
          .eq('id', outline.id)
      }
      // A fallback write still sets h1, so the row is no longer "still generating"
      // and this counts as forward progress for the chain guard below.
      completedThisRun += 1
    },
    OUTLINE_MIN_VIABLE_MS
  )
  if (skipped.length) {
    console.warn(
      `[outline-gen] Budget reached with ${skipped.length} outline(s) left (elapsed ${budget.elapsed()}ms) — chaining continuation.`
    )
  }

  // Re-query the true remaining count so a chained continuation reasons about the
  // live state, not this invocation's stale snapshot.
  const { data: remaining } = await supabase
    .from('page_outlines')
    .select('id')
    .eq('content_job_id', contentJobId)
    .is('h1', null)
  const remainingCount = remaining?.length ?? 0

  if (remainingCount > 0) {
    // Guard against an infinite cascade: only chain when this run made progress.
    if (completedThisRun === 0) {
      console.warn(`[outline-gen] ${remainingCount} pages remain but no progress this run — not chaining.`)
      return
    }
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL
    const cronSecret = process.env.CRON_SECRET
    if (!baseUrl || !cronSecret) {
      console.warn('[outline-gen] Auto-chain skipped — NEXT_PUBLIC_APP_URL or CRON_SECRET missing.')
      return
    }
    const url = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`
    try {
      const res = await fetch(`${url}/api/content-jobs/${contentJobId}/outlines/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cronSecret}` },
      })
      console.warn(`[outline-gen] Chained continuation: completed=${completedThisRun} this run, status=${res.status}`)
    } catch (err) {
      console.error('[outline-gen] Auto-chain self-call failed:', err)
    }
    return
  }

  console.warn(`[content-job] Outlines generated for job=${contentJobId}`)

  // Final invocation — every page is written. Send the "ready for review" email once.
  const firmName = schema.business?.name ?? 'Unknown firm'
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL) {
    try {
      const { Resend } = await import('resend')
      const resend = new Resend(process.env.RESEND_API_KEY)
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL,
        to: process.env.ADMIN_EMAIL ?? process.env.RESEND_FROM_EMAIL,
        subject: `[Revaltus] Outlines ready for review — ${firmName}`,
        html: `
          <h2>Outlines Ready for Review</h2>
          <p><strong>${firmName}</strong></p>
          <p>${outlines.length} page outlines are ready for your review.</p>
          <p><a href="${appUrl}/admin/content/${sessionId}">Review outlines →</a></p>
        `,
      })
    } catch (emailErr) {
      console.warn('[outline-gen] Email notification failed:', emailErr)
    }
  }
}

export const VERBATIM_OUTLINE_NOTE =
  'Verbatim page: reproduces the client’s current page exactly (operator instruction from onboarding). Only the SEO title and description are written by AI.'

// Outline for a verbatim page: the snapshot's own H2s (or one section when the
// page has none), so the outline review shows what will ship.
export function verbatimOutline(pageTitle: string, markdown: string | null): OutlineResult {
  if (!markdown) {
    return {
      h1: pageTitle,
      sections: [{ h2: 'Page content', description: 'Snapshot missing: re-capture it on the Audit Review card', word_count: 0 }],
      target_keyword: pageTitle.toLowerCase(),
      notes: `${VERBATIM_OUTLINE_NOTE} WARNING: the captured snapshot could not be read.`,
    }
  }
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean)
  const h1 = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || pageTitle
  return {
    h1,
    sections: (headings.length ? headings : ['Page content']).map((h2) => ({
      h2,
      description: 'Verbatim client content, reproduced exactly',
      word_count: 0,
    })),
    target_keyword: pageTitle.toLowerCase(),
    notes: VERBATIM_OUTLINE_NOTE,
  }
}
