// One-time repair: remove named entries from a session's business.contentExclusions
// (and from _meta.review_exclusions, the list syncReviewExclusions tracks).
//
// Used when a review drop was mirrored into a hard exclusion that blocks a
// topic the operator kept — e.g. TK Partners, where dropping the duplicate
// "Estates & Trusts / Fiduciary Administration" niche made the outline model
// refuse every estate/trust page. The dropped items stay dropped (still hidden
// from generators via activeNiches/activeServices); only the exclusion goes.
// Re-applying that review step later re-mirrors the drop.
//
// Dry run by default.
//
// Usage:
//   npx tsx scripts/remove-content-exclusions.ts --session <id> --remove "<name>" [--remove "<name>"] [--apply]

import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(__dirname, '..', '.env.local')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const norm = (s: string) => s.trim().toLowerCase()

type Args = { session?: string; remove: string[]; apply: boolean }

function parseArgs(argv: string[]): Args {
  const out: Args = { remove: [], apply: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') out.session = argv[++i]
    else if (argv[i] === '--remove') out.remove.push(argv[++i] ?? '')
    else if (argv[i] === '--apply') out.apply = true
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.session || !UUID.test(args.session) || !args.remove.some(r => r.trim())) {
    console.error('Usage: --session <uuid> --remove "<name>" [--remove …] [--apply]')
    process.exit(1)
  }
  const sessionId = args.session
  const targets = new Set(args.remove.filter(r => r.trim()).map(norm))

  const { createServerClient } = await import('../lib/supabase/server')
  const { updateSessionWithCas } = await import('../lib/session/schema-cas')
  const { asJson } = await import('../lib/supabase/json-typed')
  type SessionSchema = import('../types/session-schema').SessionSchema

  const supabase = createServerClient()

  const result = await updateSessionWithCas(supabase, sessionId, (row) => {
    const schema = structuredClone((row.schema_data ?? {}) as SessionSchema)
    const before = Array.isArray(schema.business?.contentExclusions) ? schema.business.contentExclusions : []
    const after = before.filter(x => typeof x !== 'string' || !targets.has(norm(x)))
    const removed = before.filter(x => typeof x === 'string' && targets.has(norm(x)))

    const meta = schema._meta as (SessionSchema['_meta'] & { review_exclusions?: unknown }) | undefined
    const tracked = Array.isArray(meta?.review_exclusions)
      ? (meta.review_exclusions as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    const trackedAfter = tracked.filter(x => !targets.has(norm(x)))

    if (!removed.length && trackedAfter.length === tracked.length) {
      return { skip: true as const, result: { removed: [] as unknown[], remaining: before, applied: false } }
    }
    if (!args.apply) {
      return { skip: true as const, result: { removed, remaining: after, applied: false } }
    }
    if (schema.business) schema.business.contentExclusions = after as string[]
    if (meta && tracked.length !== trackedAfter.length) meta.review_exclusions = trackedAfter
    return {
      update: { schema_data: asJson(schema) },
      result: { removed, remaining: after, applied: true },
    }
  })

  console.warn(`[remove-content-exclusions] session=${sessionId} ${result.applied ? 'APPLIED' : 'dry run'}`)
  console.warn('  removing:', JSON.stringify(result.removed))
  console.warn('  remaining:', JSON.stringify(result.remaining))
  if (!result.applied && result.removed.length) console.warn('  re-run with --apply to write')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
