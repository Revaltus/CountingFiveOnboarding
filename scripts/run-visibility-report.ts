// Runs a Visibility Report for one client and prints it, without creating a
// visibility_reports row. Real crawl + real AI calls (their spend is recorded
// in token_usage under stage 'visibility', like any run).
//
// Usage:
//   npx tsx scripts/run-visibility-report.ts <session_id> [url]
// The URL defaults to sessions.live_site_url, then sessions.website_url.

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
  const [sessionId, urlArg] = process.argv.slice(2)
  if (!sessionId) {
    console.error('Usage: npx tsx scripts/run-visibility-report.ts <session_id> [url]')
    process.exit(1)
  }
  const { createServerClient } = await import('../lib/supabase/server')
  const { normalizeInputUrl } = await import('../lib/audit/index')
  const { runVisibilityReport } = await import('../lib/visibility/run')
  const { buildReviewPrompt } = await import('../lib/visibility/ai-review')
  const { isLiveHost } = await import('../lib/visibility/live-host')
  const { AUDIENCES } = await import('../lib/visibility/audiences')
  type SessionSchema = import('../types/session-schema').SessionSchema

  const supabase = createServerClient()
  const { data: session, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .single()
  if (error || !session) throw new Error(`Session not found: ${error?.message ?? sessionId}`)

  const schema = (session.schema_data ?? {}) as unknown as SessionSchema
  const url = normalizeInputUrl(urlArg ?? (session as { live_site_url?: string | null }).live_site_url ?? session.website_url)
  const firmName = schema.business?.name?.trim() || new URL(url).host
  const isLiveDomain = isLiveHost(url)
  console.warn(`Running for ${firmName} at ${url} (${isLiveDomain ? 'live domain' : 'staging'})`)

  const started = Date.now()
  const { result, narrative } = await runVisibilityReport({
    url,
    schema,
    firmName,
    isLiveDomain,
    ctx: { task: 'audit', stage: 'visibility', sessionId },
    deadline: Date.now() + 560_000,
    onProgress: async (stage, detail) => console.warn(`  [${stage}] ${detail}`),
  })

  console.warn(`\nDone in ${Math.round((Date.now() - started) / 1000)}s · ${result.pagesCrawled} pages · unavailable: ${result.unavailable.join(', ') || 'none'}`)
  console.warn(`Overall: ${result.overallScore ?? '—'} ${result.overallGrade ?? ''}`)
  for (const a of AUDIENCES) {
    const s = result.audienceScores[a.key]
    console.warn(`\n${a.n}. ${a.label}: ${s.score ?? '—'} ${s.grade ?? ''}`)
    for (const c of result.checks.filter((x) => x.audience === a.key)) {
      console.warn(`   ${c.status.padEnd(7)} ${c.id.padEnd(18)} ${c.detail}${c.evidenceUrl ? `  → ${c.evidenceUrl}` : ''}`)
    }
    for (const w of narrative.audiences[a.key].wins) console.warn(`   + ${w}`)
    for (const o of narrative.audiences[a.key].opportunities) console.warn(`   → ${o}`)
  }
  console.warn(`\nOverview: ${narrative.overview}`)
  if (result.ranks?.length) console.warn(`\nRanks: ${result.ranks.map((r) => `${r.query}=${r.position ?? 'NR'}`).join(', ')}`)
  if (result.probe?.length) for (const p of result.probe) console.warn(`Probe: ${p.mentioned ? 'YES' : 'no '} ${p.question}`)

  // Rough review-prompt size (chars/4); the exact counts are in token_usage.
  const { prefix, suffix } = buildReviewPrompt({ firmName, schema, index: [], checks: result.checks })
  console.warn(`\nReview prompt (excluding pages) ≈ ${Math.round((prefix.length + suffix.length) / 4)} tokens`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
