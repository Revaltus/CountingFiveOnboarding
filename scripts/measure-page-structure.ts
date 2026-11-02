// Measures pages against the page-structure rules (lib/content/page-structure.ts):
// body words before the FAQ, content-split count, back-to-back image blocks,
// bullets, scannable sections, FAQ size and CTA label. Read-only.
//
// Usage:
//   npx tsx scripts/measure-page-structure.ts --dir <repo>/content/pages
//   npx tsx scripts/measure-page-structure.ts --job <content_job_id>

import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(__dirname, '..', '.env.local')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
  }
}

type Row = { name: string; url: string; markdown: string; faqCount?: number }

async function fromDir(dir: string): Promise<Row[]> {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const markdown = fs.readFileSync(path.join(dir, f), 'utf-8')
      const url = markdown.match(/^url:\s*"?([^"\n]+)"?/m)?.[1] ?? '/' + f.replace(/\.md$/, '').replace(/--/g, '/')
      return { name: f, url, markdown }
    })
}

async function fromJob(jobId: string): Promise<Row[]> {
  const { createServerClient } = await import('../lib/supabase/server')
  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('generated_pages')
    .select('page_url, page_title, content_markdown, faq_block')
    .eq('content_job_id', jobId)
  if (error) throw new Error(error.message)
  return (data ?? []).map((p) => ({
    name: p.page_title ?? p.page_url,
    url: p.page_url,
    markdown: p.content_markdown ?? '',
    faqCount: Array.isArray(p.faq_block) ? p.faq_block.length : 0,
  }))
}

async function main() {
  const args = process.argv.slice(2)
  const dir = args[args.indexOf('--dir') + 1]
  const job = args[args.indexOf('--job') + 1]
  const rows = args.includes('--dir') && dir ? await fromDir(dir) : args.includes('--job') && job ? await fromJob(job) : null
  if (!rows) {
    console.error('Usage: --dir <content/pages> | --job <content_job_id>')
    process.exit(1)
  }

  const { measurePageStructure, structureViolations, structureTypeForUrl } = await import('../lib/content/page-structure')
  const measured = rows
    .map((r) => {
      const type = structureTypeForUrl(r.url)
      const m = measurePageStructure(r.markdown, { faqCount: r.faqCount })
      return { r, type, m, v: structureViolations(m, type) }
    })
    .sort((a, b) => b.v.length - a.v.length)

  const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n)
  console.warn(`${pad('page', 52)} ${pad('type', 8)} ${pad('words', 6)} ${pad('splits', 6)} ${pad('b2b', 4)} ${pad('bul', 4)} ${pad('scan', 4)} ${pad('faq', 4)} cta`)
  for (const { r, type, m, v } of measured) {
    console.warn(
      `${pad(r.name, 52)} ${pad(type, 8)} ${pad(m.bodyWords, 6)} ${pad(m.splitCount, 6)} ${pad(m.consecutiveImageBlocks, 4)} ${pad(m.bulletCount, 4)} ${pad(m.scannableSections, 4)} ${pad(m.faqCount, 4)} ${m.ctaLabel ?? '-'}`,
    )
    if (v.length) console.warn(`    ↳ ${v.map((x) => x.code).join(', ')}`)
  }
  const n = measured.length || 1
  const avg = (f: (m: (typeof measured)[number]['m']) => number) => (measured.reduce((s, x) => s + f(x.m), 0) / n).toFixed(1)
  console.warn(`\n${measured.length} pages · avg words ${avg((m) => m.bodyWords)} · splits ${avg((m) => m.splitCount)} · bullets ${avg((m) => m.bulletCount)} · faq ${avg((m) => m.faqCount)} · pages with violations ${measured.filter((x) => x.v.length).length}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
