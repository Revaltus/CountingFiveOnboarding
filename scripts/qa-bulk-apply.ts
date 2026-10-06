// One-time backfill: apply the open QA Desk fixes that shadow mode reported but
// never applied — exactly the set `CONTENT_QA_MODE=on` would have applied at
// generation time (open `auto` findings with a patch or variant fix). Flags
// (accuracy claims, section changes) stay open for a human. Verbatim pages and
// team bios keep their protection: a fix touching them degrades to an open flag.
//
// Writes go through the same path as the per-finding Apply button: QA fence
// first, then the qa_apply_page_update CAS (md5 + rev), which also clears
// admin_approved_content on a content change. --keep-approval re-approves
// pages that were approved before the run. The MBP impact review is skipped:
// these are copy/SEO polish edits, not new facts.
//
// Dry run by default. A published site only picks the changes up on the next
// "Publish site live" (which re-assembles from generated_pages).
//
// Usage:
//   npx tsx scripts/qa-bulk-apply.ts --job <content_job_id>
//   npx tsx scripts/qa-bulk-apply.ts --job <content_job_id> --apply [--keep-approval]

import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'

const envPath = path.join(__dirname, '..', '.env.local')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

type Args = { job?: string; apply: boolean; keepApproval: boolean }

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, keepApproval: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--job') out.job = argv[++i]
    else if (argv[i] === '--apply') out.apply = true
    else if (argv[i] === '--keep-approval') out.keepApproval = true
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.job || !UUID.test(args.job)) {
    console.error('Usage: npx tsx scripts/qa-bulk-apply.ts --job <content_job_id> [--apply] [--keep-approval]')
    process.exit(1)
  }
  const { createServerClient } = await import('../lib/supabase/server')
  const { asJson } = await import('../lib/supabase/json-typed')
  const { parseQaReview } = await import('../types/qa-review')
  const { applyOpenAutoFindings } = await import('../lib/content/qa/apply-finding')
  const { loadProtectedTexts } = await import('../lib/content/qa/protected')
  const { fenceQaForHumanEdit } = await import('../lib/content/qa/fence')
  const { readDesignCapabilities } = await import('../lib/design/capabilities-read')
  const { countWords } = await import('../lib/content/word-count-validator')

  const supabase = createServerClient()
  const { data: job, error: jobErr } = await supabase
    .from('content_jobs').select('id, session_id, github_repo, phase').eq('id', args.job).maybeSingle()
  if (jobErr || !job) throw new Error(`content job not found: ${jobErr?.message ?? args.job}`)

  // Variant fixes are gated on the site's template version; never guess it.
  let templateVersion: string | null = null
  if (job.github_repo) templateVersion = (await readDesignCapabilities(job.github_repo)).templateVersion ?? null

  const { data: pages, error: pagesErr } = await supabase
    .from('generated_pages')
    .select('id, page_url, content_markdown, meta_title, meta_description, qa_review, admin_approved_content')
    .eq('content_job_id', job.id)
    .not('qa_review', 'is', null)
    .order('page_url')
  if (pagesErr) throw pagesErr

  console.warn(`${args.apply ? 'APPLY' : 'DRY RUN'} — job ${job.id} (${job.github_repo ?? 'no repo'}, phase ${job.phase}, template ${templateVersion ?? 'unknown'})`)
  let totalApplied = 0
  let totalFailed = 0
  let written = 0

  for (const p of pages ?? []) {
    const review = parseQaReview(p.qa_review)
    if (!review) continue
    const body = p.content_markdown ?? ''
    const prot = await loadProtectedTexts(supabase, { contentJobId: job.id, sessionId: job.session_id, pageUrl: p.page_url, body })
    if (!prot.ok) {
      console.error(`  ✗ ${p.page_url}: couldn't load protected text — skipped`, prot.error)
      continue
    }
    const r = applyOpenAutoFindings(
      { body, metaTitle: p.meta_title, metaDescription: p.meta_description },
      review, prot.texts, templateVersion,
    )
    if (!r.applied.length && !r.failed.length) continue
    totalApplied += r.applied.length
    totalFailed += r.failed.length
    const kinds = [...new Set(r.applied.map(f => f.kind))].join(', ')
    console.warn(`  ${p.page_url}: ${r.applied.length} applied${r.failed.length ? `, ${r.failed.length} → flag` : ''}${p.admin_approved_content ? ' [approved]' : ''}${prot.texts.length ? ` [${prot.texts.length} protected span(s)]` : ''}  (${kinds})`)
    for (const f of r.failed) console.warn(`      flag: ${f.kind} — ${f.message}`)
    if (!args.apply) continue

    const contentChanged = r.fields.body !== body
      || r.fields.metaTitle !== p.meta_title
      || r.fields.metaDescription !== p.meta_description
    if (contentChanged) await fenceQaForHumanEdit(supabase, p.id, { contentJobId: job.id })
    const { data: updated, error: rpcErr } = await supabase.rpc('qa_apply_page_update', {
      p_page_id: p.id,
      p_job_id: job.id,
      p_expected_content_md5: contentChanged ? md5(body) : null,
      p_expected_rev: review.rev ?? 0,
      p_qa_review: asJson(r.review),
      p_content_changed: contentChanged,
      p_content: contentChanged ? r.fields.body : null,
      p_meta_title: contentChanged ? r.fields.metaTitle : null,
      p_meta_description: contentChanged ? r.fields.metaDescription : null,
    })
    if (rpcErr) { console.error(`  ✗ ${p.page_url}: save failed`, rpcErr); continue }
    if (!updated?.length) { console.error(`  ✗ ${p.page_url}: page changed since it was read — skipped`); continue }
    const followUp: { word_count_actual: number; admin_approved_content?: boolean } = { word_count_actual: countWords(r.fields.body) }
    if (args.keepApproval && p.admin_approved_content) followUp.admin_approved_content = true
    const { error: fuErr } = await supabase.from('generated_pages').update(followUp).eq('id', p.id).eq('content_job_id', job.id)
    if (fuErr) console.error(`  ! ${p.page_url}: saved, but word count/approval update failed`, fuErr)
    written++
  }

  console.warn(`\n${totalApplied} fix(es) ${args.apply ? 'applied' : 'would apply'}, ${totalFailed} degraded to flags${args.apply ? `, ${written} page(s) written` : ''}.`)
}

main().catch(err => { console.error(err); process.exit(1) })
