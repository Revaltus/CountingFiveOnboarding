// One-off eval for the FAST_MODEL tier (Haiku 5.5, thinking off, since 2026-10-09). Replays the brand-fit
// classifier — a representative short JSON helper — over real client brands and
// a fixed set of admin directions (some deliberately off-brand), once per model,
// and reports agreement, failures, latency and cost. Informational: it tells us
// what the Haiku-retirement fallback would cost and whether it classifies the
// same way. Nothing is persisted except the normal token_usage rows.
//
// The baseline runs exactly as production does (FAST_PROVIDER_OPTIONS).
//
// Challengers (--challenger, default sonnet55):
//   sonnet55     Sonnet 5.5, effort low + between_tools
//   haiku45      Haiku 4.5, no provider options (the pre-2026-10-09 baseline)
//   haiku55-low  Haiku 5.5, adaptive thinking at effort low
//
// Usage:
//   npx tsx scripts/compare-fast-models.ts            # 3 most recent sessions with a brand
//   npx tsx scripts/compare-fast-models.ts 5 --challenger haiku45

import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(__dirname, '..', '.env.local')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
  }
}

const DIRECTIONS = [
  'Write a guide to year-end tax planning for small business owners.',
  'An explainer on how R&D tax credits work for manufacturers.',
  'A checklist for what to bring to your first meeting with us.',
  'A post comparing cash vs accrual accounting for startups.',
  'Write a snarky, meme-heavy post roasting other local CPA firms by name.',
  'An aggressive post promising clients we guarantee they will never be audited.',
  'A casual TikTok-style piece full of slang and emojis about crypto get-rich-quick tips.',
  'Fear-based copy telling readers the IRS is coming for them unless they call today.',
]

const warn0 = (...a: unknown[]) => console.warn(...a)

async function main() {
  const { createServerClient } = await import('../lib/supabase/server')
  const { checkBrandFit } = await import('../lib/content/brand-fit')
  const { FAST_MODEL, FAST_PROVIDER_OPTIONS, SONNET_5_5_CHALLENGER, HAIKU_4_5_LEGACY } = await import('../lib/content/generation-tuning')
  type SessionSchema = import('../types/session-schema').SessionSchema

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.ANTHROPIC_API_KEY) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or ANTHROPIC_API_KEY')
    process.exit(1)
  }
  const supabase = createServerClient()
  const argv = process.argv.slice(2)
  const ci = argv.indexOf('--challenger')
  const challengerKey = ci >= 0 ? argv[ci + 1] : 'sonnet55'
  const limit = Number(argv.find((a, i) => /^\d+$/.test(a) && argv[i - 1] !== '--challenger') ?? 3) || 3

  const challengers = {
    sonnet55: {
      id: SONNET_5_5_CHALLENGER,
      providerOptions: { anthropic: { thinking: { type: 'between_tools' as const }, effort: 'low' as const } },
    },
    haiku45: { id: HAIKU_4_5_LEGACY, providerOptions: undefined },
    'haiku55-low': {
      id: FAST_MODEL,
      providerOptions: { anthropic: { thinking: { type: 'adaptive' as const }, effort: 'low' as const } },
    },
  }
  const challenger = challengers[challengerKey as keyof typeof challengers]
  if (!challenger) {
    console.error(`Unknown --challenger "${challengerKey}" (expected ${Object.keys(challengers).join(' | ')})`)
    process.exit(1)
  }
  warn0(`challenger: ${challengerKey} (${challenger.id})`)
  if (challenger.id === FAST_MODEL) warn0('  (same model id as the baseline — the $/call figures below are pooled across both)')

  const contenders = [{ id: FAST_MODEL, providerOptions: FAST_PROVIDER_OPTIONS }, challenger]

  const { data: jobs, error } = await supabase
    .from('content_jobs')
    .select('id, session_id')
    .order('created_at', { ascending: false })
    .limit(limit * 4)
  if (error) throw error

  // checkBrandFit fails OPEN (returns on-brand) and only logs; count those logs
  // so a failure isn't mistaken for an on-brand verdict.
  let failures = 0
  const warn = console.warn
  console.warn = (...a: unknown[]) => {
    if (typeof a[0] === 'string' && a[0].startsWith('[brand-fit] Check failed')) failures++
    else warn(...a)
  }

  const seen = new Set<string>()
  const stats = new Map(contenders.map((c) => [c.id, { offBrand: 0, failures: 0, ms: 0, calls: 0, startedAt: new Date().toISOString() }]))
  let agree = 0
  let total = 0

  for (const job of jobs ?? []) {
    if (!job.session_id || seen.has(job.session_id) || seen.size >= limit) continue
    const { data: session } = await supabase.from('sessions').select('schema_data').eq('id', job.session_id).single()
    const schema = session?.schema_data as SessionSchema | undefined
    if (!schema?.brand) continue
    seen.add(job.session_id)
    warn(`\n=== ${schema.business?.name ?? job.session_id}`)

    for (const text of DIRECTIONS) {
      const verdicts: string[] = []
      for (const c of contenders) {
        const s = stats.get(c.id)!
        const before = failures
        const t = Date.now()
        const r = await checkBrandFit({ text, schema, contentJobId: job.id, sessionId: job.session_id, model: c })
        s.ms += Date.now() - t
        s.calls++
        const failed = failures > before
        if (failed) s.failures++
        if (r.fit === 'off-brand') s.offBrand++
        verdicts.push(failed ? 'FAIL' : r.fit)
      }
      total++
      if (verdicts[0] === verdicts[1]) agree++
      warn(`  ${verdicts.map((v) => v.padEnd(9)).join(' | ')}  ${text.slice(0, 70)}`)
    }
  }
  console.warn = warn

  console.warn(`\n=== SUMMARY  agreement ${agree}/${total}`)
  for (const c of contenders) {
    const s = stats.get(c.id)!
    const { data: usage } = await supabase
      .from('token_usage')
      .select('cost_usd')
      .eq('model', c.id)
      .eq('page_url', 'brand-fit')
      .gte('created_at', s.startedAt)
    const cost = (usage ?? []).reduce((sum, r) => sum + Number(r.cost_usd), 0)
    console.warn(
      `  ${c.id.padEnd(26)} off-brand=${s.offBrand}/${s.calls}  failures=${s.failures}  ms/call=${(s.ms / Math.max(1, s.calls)).toFixed(0)}  $/call=${(cost / Math.max(1, s.calls)).toFixed(4)}`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
