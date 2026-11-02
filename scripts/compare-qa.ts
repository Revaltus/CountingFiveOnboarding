// One-off eval: run the QA Desk rules + specialists (+ the Opus judge) against a
// session's real finished pages and/or the seeded-defect fixture, so a
// QA_SPECIALIST_MODEL change is decided on evidence (kind coverage + cost/page),
// not vibes. Mirrors scripts/compare-critic-models.ts for env loading, arg
// parsing and session loading. Read-only against generated_pages — nothing here
// ever writes a page's content or QA fields. Each specialist/judge call still
// records its real spend to token_usage (stage qa_accuracy/qa_copy/qa_seo/
// qa_structure/qa_judge), which is also where the per-call cost below is read
// from (same pattern as scripts/compare-content-models.ts).
//
// Usage:
//   npx tsx scripts/compare-qa.ts --help
//   npx tsx scripts/compare-qa.ts --session <id> --pages 2 --fixture
//   npx tsx scripts/compare-qa.ts --session <id> --model claude-sonnet-5-5 --pages 5

import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(__dirname, '..', '.env.local')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
  }
}

type Args = { session?: string; model?: string; pages: number; fixture: boolean; help: boolean }

function parseArgs(argv: string[]): Args {
  const out: Args = { pages: 5, fixture: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--session') out.session = argv[++i]
    else if (a === '--model') out.model = argv[++i]
    else if (a === '--pages') out.pages = Number(argv[++i]) || 5
    else if (a === '--fixture') out.fixture = true
  }
  return out
}

function printUsage(): void {
  console.error(`QA Desk A/B harness — rules + specialists + Opus judge against real pages
and/or the seeded-defect fixture. Read-only against generated_pages.

Usage:
  npx tsx scripts/compare-qa.ts --session <id> [--model <model-id>] [--pages <n>] [--fixture]
  npx tsx scripts/compare-qa.ts --help

  --session <id>   Session id to pull "complete" pages from (its latest content
                    job). Required — also grounds --fixture's accuracy check
                    against this session's real firm profile.
  --model <id>     Specialist model to A/B (default QA_SPECIALIST_MODEL). The
                    judge always runs on CRITIC_MODEL (Opus) — never A/B'd,
                    so no tier grades its own work.
  --pages <n>      How many of the session's complete pages to run (default 5).
  --fixture        Also run lib/content/qa/__fixtures__/seeded-defects.md and
                    print PASS/FAIL per expected live-only finding kind.

Each specialist/judge call still records its real spend to token_usage (stage
qa_accuracy/qa_copy/qa_seo/qa_structure/qa_judge) — this script never writes
generated_pages.`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  if (args.help || argv.length === 0) {
    printUsage()
    return
  }
  if (!args.session) {
    printUsage()
    console.error('\nError: --session <id> is required.')
    process.exit(1)
  }

  const { createServerClient } = await import('../lib/supabase/server')
  const { loadPageGenContext } = await import('../lib/content/content-generator')
  const { loadNoGoPhrases } = await import('../lib/content/no-go-phrases')
  const { clientAvoidPhrases } = await import('../lib/content/brand-voice')
  const { runRules } = await import('../lib/content/qa/rules')
  const { SPECIALISTS, runSpecialist } = await import('../lib/content/qa/specialists/run')
  const { scoreDraft, CRITIC_CALL_CAP_MS } = await import('../lib/content/draft-critic')
  const { generateMbpJson } = await import('../lib/mbp/generate-json')
  const { QA_SPECIALIST_MODEL, CRITIC_MODEL } = await import('../lib/content/generation-tuning')
  type TokenContext = import('../lib/content/token-pricing').TokenContext
  type SpecialistInput = import('../lib/content/qa/specialists/types').SpecialistInput
  type Json = import('../types/database').Json
  type ScoreDraftInput = Parameters<typeof scoreDraft>[0]
  // Only the fields run.ts's runSpecialist actually passes. Kept loose
  // (providerOptions: unknown) and cast at the call boundary below —
  // generateMbpJson's full generic opts type (with `accept`/`attempts` tied to
  // its own T) doesn't instantiate cleanly through a locally-declared generic
  // wrapper.
  type GenerateOpts = {
    providerOptions?: unknown
    cachePrefix?: string
    cacheTtl?: '5m' | '1h'
    timeoutMs?: number
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey || !process.env.ANTHROPIC_API_KEY) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or ANTHROPIC_API_KEY')
    process.exit(1)
  }
  const supabase = createServerClient()
  const model = args.model ?? QA_SPECIALIST_MODEL

  // Identifies the fixture target's token_usage rows (see Target.isFixture
  // below) so they never attribute spend to a real client's content_job_id/
  // session_id — a synthetic page must not pollute a live client's cost ledger.
  const FIXTURE_PAGE_URL = '__fixture__/seeded-defects'

  // Delegates to the real generateMbpJson (same retries/caching/recordTokenUsage
  // as production) with the A/B model substituted in — the specialist modules
  // hardcode QA_SPECIALIST_MODEL, so this is the only hook available to vary it.
  // Also the interception point that nulls session_id/content_job_id in the
  // recorded ctx for the fixture page (TokenContext already allows null here —
  // no cast needed), while still keying the row to the identifiable fixture
  // page_url.
  function generateWithModel<T>(
    prompt: string,
    validate: (parsed: unknown) => T | null,
    maxOutputTokens?: number,
    ctx?: TokenContext,
    opts?: GenerateOpts,
  ): Promise<T | null> {
    const effectiveCtx: TokenContext | undefined =
      ctx && ctx.pageUrl === FIXTURE_PAGE_URL ? { ...ctx, sessionId: null, contentJobId: null } : ctx
    return generateMbpJson<T>(prompt, validate, maxOutputTokens, effectiveCtx, {
      ...(opts as Parameters<typeof generateMbpJson>[4]),
      model,
    })
  }

  const { data: session, error: sessionErr } = await supabase
    .from('sessions')
    .select('id, schema_data')
    .eq('id', args.session)
    .maybeSingle()
  if (sessionErr || !session) {
    console.error(`Session not found: ${args.session}`, sessionErr?.message ?? '')
    process.exit(1)
  }

  const { data: job } = await supabase
    .from('content_jobs')
    .select('id')
    .eq('session_id', args.session)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!job) {
    console.error(`No content job found for session ${args.session}`)
    process.exit(1)
  }
  const jobId: string = job.id

  const ctx = await loadPageGenContext(supabase, jobId)
  if (!ctx) {
    console.error(`Could not load page-gen context for content job ${jobId}`)
    process.exit(1)
  }

  const noGoPhrases = (await loadNoGoPhrases()).map((p) => p.phrase)
  const avoidPhrases = clientAvoidPhrases(ctx.schema)

  type Target = {
    pageId: string
    pageUrl: string
    pageTitle: string
    body: string
    metaTitle: string | null
    metaDescription: string | null
    targetKeyword: string | null
    heroBlock: string | null
    heroVariant: string | null
    heroSubhead: string | null
    faqBlock: unknown
    outlineSections: Json
    verbatim: boolean
    isFixture: boolean
  }

  const targets: Target[] = []

  const { data: pages } = await supabase
    .from('generated_pages')
    .select(
      'id, page_url, page_title, content_markdown, meta_title, meta_description, target_keyword, hero_block, hero_variant, hero_subhead, faq_block',
    )
    .eq('content_job_id', jobId)
    .eq('generation_status', 'complete')
    .not('content_markdown', 'is', null)
    .order('created_at', { ascending: false })
    .limit(args.pages)

  for (const p of pages ?? []) {
    const { data: outline } = await supabase
      .from('page_outlines')
      .select('sections, generation_mode')
      .eq('content_job_id', jobId)
      .eq('page_url', p.page_url)
      .maybeSingle()
    targets.push({
      pageId: p.id,
      pageUrl: p.page_url,
      pageTitle: p.page_title,
      body: p.content_markdown ?? '',
      metaTitle: p.meta_title,
      metaDescription: p.meta_description,
      targetKeyword: p.target_keyword,
      heroBlock: p.hero_block,
      heroVariant: p.hero_variant,
      heroSubhead: p.hero_subhead,
      faqBlock: p.faq_block,
      outlineSections: (outline?.sections ?? []) as Json,
      verbatim: outline?.generation_mode === 'verbatim',
      isFixture: false,
    })
  }

  type Expect = { rules: string[]; live: Record<string, string[]> }
  let expected: Expect | null = null
  if (args.fixture) {
    const fixtureDir = path.join(__dirname, '..', 'lib/content/qa/__fixtures__')
    const fixtureBody = fs.readFileSync(path.join(fixtureDir, 'seeded-defects.md'), 'utf8')
    expected = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'seeded-defects.expect.json'), 'utf8')) as Expect
    targets.push({
      pageId: 'seeded-defects-fixture',
      pageUrl: FIXTURE_PAGE_URL,
      pageTitle: 'Tax Planning for Manufacturers in Michigan',
      body: fixtureBody,
      metaTitle: 'Tax Planning for Manufacturers in Michigan | Korbey Lague',
      metaDescription: 'x'.repeat(155),
      targetKeyword: 'tax planning',
      heroBlock: 'hero',
      heroVariant: 'image',
      heroSubhead: null,
      faqBlock: null,
      outlineSections: [] as Json,
      verbatim: false,
      isFixture: true,
    })
  }

  if (targets.length === 0) {
    console.error('No pages to run: no complete pages were found for this job and --fixture was not set.')
    process.exit(1)
  }

  // `byJobId: null` (the fixture case) reads back the rows generateWithModel
  // recorded with a null content_job_id — queried by page_url + stage + model
  // + the time window instead, since FIXTURE_PAGE_URL is unique to this run and
  // no live job ever writes it.
  async function costSince(
    stage: string,
    costModel: string,
    pageUrl: string,
    sinceIso: string,
    byJobId: string | null,
  ): Promise<number> {
    let q = supabase
      .from('token_usage')
      .select('cost_usd')
      .eq('stage', stage)
      .eq('model', costModel)
      .eq('page_url', pageUrl)
      .gte('created_at', sinceIso)
    if (byJobId) q = q.eq('content_job_id', byJobId)
    const { data } = await q
    return (data ?? []).reduce((s, r) => s + Number(r.cost_usd), 0)
  }

  const pageCosts: number[] = []
  let fixtureAllPass = true

  for (const t of targets) {
    console.warn(`\n=== ${t.pageUrl}${t.isFixture ? '  (SEEDED FIXTURE)' : ''}`)

    const rules = runRules({
      body: t.body,
      pageUrl: t.pageUrl,
      metaTitle: t.metaTitle,
      metaDescription: t.metaDescription,
      heroBlock: t.heroBlock,
      heroVariant: t.heroVariant,
      heroSubhead: t.heroSubhead,
      faqBlock: t.faqBlock,
      noGoPhrases: t.isFixture ? ['trusted partner'] : noGoPhrases,
      avoidPhrases: t.isFixture ? [] : avoidPhrases,
    })
    console.warn(`  rules       ${rules.length} finding(s) — ${rules.map((f) => f.kind).join(', ') || 'none'}`)

    const input: SpecialistInput = {
      pageUrl: t.pageUrl,
      pageTitle: t.pageTitle,
      body: t.body,
      metaTitle: t.metaTitle,
      metaDescription: t.metaDescription,
      targetKeyword: t.targetKeyword,
      outlineSections: t.outlineSections,
      sitemapUrls: ctx.sitemapUrls,
      verbatim: t.verbatim,
      ruleHits: rules,
      schema: ctx.schema,
      sessionId: ctx.sessionId,
      contentJobId: jobId,
    }

    const active = SPECIALISTS.filter((d) => !(input.verbatim && d.skipWhenVerbatim))
    let pageCost = 0

    const specialistResults = await Promise.all(
      active.map(async (def) => {
        const startedAt = new Date().toISOString()
        const t0 = Date.now()
        const findings = await runSpecialist(def, input, { generate: generateWithModel as typeof generateMbpJson })
        const wallMs = Date.now() - t0
        const cost = await costSince(def.stage, model, t.pageUrl, startedAt, t.isFixture ? null : jobId)
        return { def, findings, wallMs, cost }
      }),
    )
    for (const { def, findings, wallMs, cost } of specialistResults) {
      pageCost += cost
      const auto = findings.filter((f) => f.safety === 'auto').length
      const flag = findings.length - auto
      console.warn(
        `  ${def.agent.padEnd(10)} ${String(findings.length).padStart(2)} finding(s) (auto=${auto} flag=${flag})  $${cost.toFixed(4)}  ${wallMs}ms`,
      )
    }

    // scoreDraft's DraftCriticInput types sessionId/contentJobId as required
    // strings (every production call site has them) — but it only ever reads
    // them to build the token_usage ctx it records, so for the fixture target
    // we deliberately pass null to keep it off the real session's cost ledger.
    // `as unknown as ScoreDraftInput` bridges that one intentional widening;
    // every other field matches the real interface exactly.
    const judgeStartedAt = new Date().toISOString()
    const judgeT0 = Date.now()
    const judge = await scoreDraft(
      {
        pageId: t.pageId,
        pageUrl: t.pageUrl,
        pageTitle: t.pageTitle,
        contentMarkdown: t.body,
        outlineSections: t.outlineSections,
        targetKeyword: t.targetKeyword ?? '',
        competitorRefs: [],
        schema: ctx.schema,
        sessionId: t.isFixture ? null : ctx.sessionId,
        contentJobId: t.isFixture ? null : jobId,
      } as unknown as ScoreDraftInput,
      CRITIC_MODEL,
      { timeoutMs: CRITIC_CALL_CAP_MS, stage: 'qa_judge' },
    )
    const judgeWallMs = Date.now() - judgeT0
    const judgeCost = await costSince('qa_judge', CRITIC_MODEL, t.pageUrl, judgeStartedAt, t.isFixture ? null : jobId)
    pageCost += judgeCost
    console.warn(
      `  judge(Opus) ${judge ? `claims=${judge.unsupported_claims.length} missing=${(judge.missing_sections ?? []).length}` : 'NO RESULT'}  $${judgeCost.toFixed(4)}  ${judgeWallMs}ms`,
    )
    console.warn(`  page total  $${pageCost.toFixed(4)}`)
    pageCosts.push(pageCost)

    if (t.isFixture && expected) {
      console.warn('  --- fixture PASS/FAIL (live-only finding kinds) ---')
      const byAgent = new Map<string, Set<string>>()
      for (const { def, findings } of specialistResults) byAgent.set(def.agent, new Set(findings.map((f) => f.kind)))
      for (const [agent, kinds] of Object.entries(expected.live)) {
        const found = byAgent.get(agent) ?? new Set<string>()
        for (const kind of kinds) {
          const pass = found.has(kind)
          if (!pass) fixtureAllPass = false
          console.warn(`    ${pass ? 'PASS' : 'FAIL'}  ${agent}.${kind}`)
        }
      }
    }
  }

  const meanCost = pageCosts.reduce((a, b) => a + b, 0) / (pageCosts.length || 1)
  console.warn(`\n=== SUMMARY  model=${model}  pages=${pageCosts.length}  mean $/page=${meanCost.toFixed(4)}`)
  if (args.fixture) console.warn(`  fixture: ${fixtureAllPass ? 'ALL PASS' : 'SOME FAILED (see above)'}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
