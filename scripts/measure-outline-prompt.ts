// Measures the outline prompt, section by section, for real jobs, using
// Anthropic's token-counting endpoint (no generation, no cost beyond the count).
// Read-only: nothing is written.
//
// Usage:
//   npx tsx scripts/measure-outline-prompt.ts <content_job_id> [more job ids…]
//   npx tsx scripts/measure-outline-prompt.ts            # 3 most recent jobs with outlines

import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(__dirname, '..', '.env.local')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
  }
}

// A section starts at a line like "FIRM PROFILE (…" / "RULES:" / "PAGE: …".
const HEADER = /^(?:[A-Z][A-Z0-9 &/—–-]{2,}[A-Z])(?=\s*[:(])/

function splitSections(text: string): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [{ name: '(preamble)', text: '' }]
  for (const line of text.split('\n')) {
    const m = line.match(HEADER)
    if (m) out.push({ name: m[0], text: line + '\n' })
    else out[out.length - 1].text += line + '\n'
  }
  return out.filter((s) => s.text.trim())
}

async function countTokens(model: string, text: string): Promise<number> {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text || '.' }] }),
  })
  if (!res.ok) throw new Error(`count_tokens ${res.status}: ${await res.text()}`)
  return ((await res.json()) as { input_tokens: number }).input_tokens
}

async function main() {
  const { createServerClient } = await import('../lib/supabase/server')
  const { buildOutlinePrompt, buildAuditPageIndex } = await import('../lib/content/outline-generator')
  const { loadNoGoPhrases } = await import('../lib/content/no-go-phrases')
  const { PUBLISHED_CONTENT_MODEL } = await import('../lib/content/generation-tuning')
  type SessionSchema = import('../types/session-schema').SessionSchema
  type PaletteData = import('../types/palette').PaletteData
  type AuditResult = import('../types/audit-result').AuditResult

  const supabase = createServerClient()
  let jobIds = process.argv.slice(2)
  if (!jobIds.length) {
    const { data } = await supabase
      .from('content_jobs')
      .select('id')
      .gte('phase', 4)
      .order('created_at', { ascending: false })
      .limit(3)
    jobIds = (data ?? []).map((j) => j.id)
  }
  const noGoPhrases = (await loadNoGoPhrases()).map((p) => p.phrase)
  const base = await countTokens(PUBLISHED_CONTENT_MODEL, '.')

  for (const jobId of jobIds) {
    const { data: job } = await supabase.from('content_jobs').select('session_id, palette').eq('id', jobId).single()
    if (!job) continue
    const [{ data: session }, { data: audit }, { data: outlines }, { data: research }] = await Promise.all([
      supabase.from('sessions').select('schema_data').eq('id', job.session_id).single(),
      supabase
        .from('audit_runs')
        .select('result')
        .eq('session_id', job.session_id)
        .eq('audit_status', 'complete')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from('page_outlines').select('page_url, page_title').eq('content_job_id', jobId).limit(4),
      supabase
        .from('research_results')
        .select('page_url, target_keyword, secondary_keywords, competitor_references, existing_content, merged_content')
        .eq('content_job_id', jobId),
    ])
    const schema = (session?.schema_data ?? {}) as SessionSchema
    const auditIndex = buildAuditPageIndex((audit?.result ?? null) as AuditResult | null)
    console.warn(`\n=== ${schema.business?.name ?? jobId} (${jobId})`)

    let printedStatic = false
    for (const o of outlines ?? []) {
      const r = (research ?? []).find((x) => x.page_url === o.page_url) ?? null
      const norm = o.page_url.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase()
      const { staticPrefix, dynamicSuffix } = buildOutlinePrompt({
        pageTitle: o.page_title,
        pageUrl: o.page_url,
        schema,
        palette: (job.palette ?? null) as PaletteData | null,
        research: r,
        auditedPage: [...auditIndex.entries()].find(([k]) => k.endsWith(norm))?.[1],
        noGoPhrases,
      })
      if (!printedStatic) {
        const total = (await countTokens(PUBLISHED_CONTENT_MODEL, staticPrefix)) - base
        console.warn(`  STATIC PREFIX ${total} tokens`)
        for (const sec of splitSections(staticPrefix)) {
          const n = (await countTokens(PUBLISHED_CONTENT_MODEL, sec.text)) - base
          console.warn(`    ${String(n).padStart(5)}  ${sec.name}`)
        }
        printedStatic = true
      }
      const dyn = (await countTokens(PUBLISHED_CONTENT_MODEL, dynamicSuffix)) - base
      const parts = await Promise.all(
        splitSections(dynamicSuffix).map(async (sec) => `${sec.name}=${(await countTokens(PUBLISHED_CONTENT_MODEL, sec.text)) - base}`),
      )
      console.warn(`  ${o.page_url}: dynamic ${dyn}  [${parts.join(', ')}]`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
