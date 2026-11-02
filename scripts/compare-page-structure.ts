// Before/after eval for the page-structure rules (lib/content/page-structure.ts):
// for recent approved niche/service outlines that already have a stored page
// (written under the old prompt), write the same outline again through the
// production page path WITHOUT persisting, then measure both against the rules
// and score both with the same critic. Read-only against content; each model
// call still records its spend to token_usage.
//
// Usage:
//   npx tsx scripts/compare-page-structure.ts            # 3 most recent
//   npx tsx scripts/compare-page-structure.ts 5 [jobId]

import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(__dirname, '..', '.env.local')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
  }
}

async function main() {
  const { createServerClient } = await import('../lib/supabase/server')
  const { loadPageGenContext, buildFinalizeInput, generateAndFinalizePage, OUTLINE_SELECT } =
    await import('../lib/content/content-generator')
  type OutlineRow = import('../lib/content/content-generator').OutlineRow
  const { PER_CALL_CAP_MS } = await import('../lib/content/generation-budget')
  const { scoreDraft } = await import('../lib/content/draft-critic')
  const { CRITIC_MODEL } = await import('../lib/content/generation-tuning')
  const { measurePageStructure, structureViolations, structureTypeForUrl, usesSkeleton } = await import('../lib/content/page-structure')
  type CriticReview = import('../lib/content/critic-review').CriticReview

  const supabase = createServerClient()
  const [limitArg, jobArg] = process.argv.slice(2)
  const limit = Number(limitArg ?? 3) || 3

  let q = supabase
    .from('page_outlines')
    .select(`${OUTLINE_SELECT}, content_job_id, generation_mode`)
    .eq('admin_approved', true)
    .neq('generation_mode', 'verbatim')
    .order('created_at', { ascending: false })
    .limit(200)
  if (jobArg) q = q.eq('content_job_id', jobArg)
  const { data: outlines, error } = await q
  if (error) throw error
  const picked = ((outlines ?? []) as Array<OutlineRow & { content_job_id: string }>)
    .filter((o) => usesSkeleton(structureTypeForUrl(o.page_url)))
    .slice(0, limit)

  const meanScore = (r: CriticReview | null) => {
    if (!r) return null
    const xs = [
      r.evidence_specificity, r.information_gain, r.brand_fidelity, r.promise_fulfillment,
      r.outline_coverage ?? 0, r.input_utilization ?? 0, r.differentiation ?? 0,
    ]
    return xs.reduce((a, b) => a + b, 0) / xs.length
  }

  type Side = { words: number; splits: number; b2b: number; bullets: number; faq: number; cta: string | null; violations: string[]; score: number | null; claims: number | null }
  const results: Array<{ page: string; before: Side; after: Side }> = []

  for (const o of picked) {
    const { data: stored } = await supabase
      .from('generated_pages')
      .select('content_markdown, faq_block')
      .eq('content_job_id', o.content_job_id)
      .eq('page_url', o.page_url)
      .maybeSingle()
    if (!stored?.content_markdown) {
      console.warn(`skip ${o.page_url}: no stored page`)
      continue
    }
    const ctx = await loadPageGenContext(supabase, o.content_job_id)
    if (!ctx) continue
    const type = structureTypeForUrl(o.page_url)
    const input = buildFinalizeInput(o, ctx, o.content_job_id, {
      attemptNumber: 1,
      callTimeoutMs: PER_CALL_CAP_MS,
      deadlineAt: Date.now() + 10 * 60_000,
    })

    const score = (markdown: string, faq: unknown) =>
      scoreDraft(
        {
          pageId: o.id,
          pageUrl: o.page_url,
          pageTitle: o.page_title,
          contentMarkdown: markdown,
          faq,
          outlineSections: o.sections,
          targetKeyword: input.targetKeyword,
          competitorRefs: input.competitorRefs,
          schema: ctx.schema,
          sessionId: ctx.sessionId,
          contentJobId: o.content_job_id,
        },
        CRITIC_MODEL,
      )

    const side = async (markdown: string, faq: unknown): Promise<Side> => {
      const m = measurePageStructure(markdown, { faqCount: Array.isArray(faq) ? faq.length : 0 })
      const review = await score(markdown, faq)
      return {
        words: m.bodyWords,
        splits: m.splitCount,
        b2b: m.consecutiveImageBlocks,
        bullets: m.bulletCount,
        faq: m.faqCount,
        cta: m.ctaLabel,
        violations: structureViolations(m, type).map((v) => v.code),
        score: meanScore(review),
        claims: review ? review.unsupported_claims.length : null,
      }
    }

    console.warn(`\n=== ${o.page_url} — generating with the new rules…`)
    const t = Date.now()
    const fresh = await generateAndFinalizePage(input).catch((err: unknown) => {
      console.warn(`  generation failed (${err instanceof Error ? err.message : String(err)}) — skipping`)
      return null
    })
    if (!fresh) continue
    console.warn(`  generated in ${((Date.now() - t) / 1000).toFixed(0)}s`)
    const [before, after] = await Promise.all([
      side(stored.content_markdown, stored.faq_block),
      side(fresh.content, fresh.metadata.faq_block),
    ])
    results.push({ page: o.page_url, before, after })
    for (const [label, s] of [['before', before], ['after ', after]] as const) {
      console.warn(
        `  ${label} words=${s.words} splits=${s.splits} b2b=${s.b2b} bullets=${s.bullets} faq=${s.faq} cta="${s.cta ?? '-'}" score=${s.score?.toFixed(2) ?? '-'} claims=${s.claims ?? '-'} violations=[${s.violations.join(', ')}]`,
      )
    }
  }

  const avg = (f: (s: Side) => number | null, which: 'before' | 'after') => {
    const xs = results.map((r) => f(r[which])).filter((x): x is number => x !== null)
    return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : '-'
  }
  console.warn(`\n=== SUMMARY (${results.length} pages, judge ${CRITIC_MODEL})`)
  for (const which of ['before', 'after'] as const) {
    console.warn(
      `  ${which.padEnd(6)} words=${avg((s) => s.words, which)} splits=${avg((s) => s.splits, which)} bullets=${avg((s) => s.bullets, which)} faq=${avg((s) => s.faq, which)} score=${avg((s) => s.score, which)} claims=${avg((s) => s.claims, which)} violations=${avg((s) => s.violations.length, which)}`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
