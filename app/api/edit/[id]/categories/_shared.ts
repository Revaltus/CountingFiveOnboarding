import { NextResponse } from 'next/server'
import { StaleShaError } from '@/lib/github/repo-files'
import { CategoriesFileError, CategoryValidationError } from '@/lib/content/blog-categories'
import { ensureSeeded, loadCategories, type Actor } from '@/lib/content/blog-categories-repo'
import { createServerClient } from '@/lib/supabase/server'
import type { SessionSchema } from '@/types/session-schema'
import type { EditContext } from '../_helpers'

export const STALE_MESSAGE = 'Categories changed in another tab — reload'
export const CORRUPT_MESSAGE =
  'content/categories.json is invalid — fix it in the file editor or delete it to re-seed'
export const MISSING_MESSAGE = 'No blog categories yet — reopen the Categories screen to create them'

export const actorOf = (ctx: EditContext): Actor => ({ name: ctx.adminName, email: ctx.adminEmail })

// Seed on first open. A corrupt file (even partially) is a 422, never re-seeded.
// A StaleShaError that escapes ensureSeeded means a categories.json appeared on
// the draft branch mid-seed but does not parse.
export async function seedOrCorrupt(ctx: EditContext): Promise<{ seeded: boolean } | NextResponse> {
  try {
    const before = await loadCategories(ctx.githubRepo)
    if (before.corrupt) return NextResponse.json({ error: CORRUPT_MESSAGE }, { status: 422 })
    if (before.file) return { seeded: false }
    // Only hit the DB when seeding is actually needed. A failed read must
    // throw: seeding from an empty schema would write an empty file for good.
    const supabase = createServerClient()
    const { data, error } = await supabase.from('sessions').select('schema_data').eq('id', ctx.sessionId).single()
    if (error || !data) throw new Error('Could not load session schema for category seeding')
    await ensureSeeded(ctx.githubRepo, (data.schema_data ?? {}) as SessionSchema, actorOf(ctx))
    return { seeded: true }
  } catch (err) {
    if (err instanceof StaleShaError) return NextResponse.json({ error: CORRUPT_MESSAGE }, { status: 422 })
    if (err instanceof CategoriesFileError) return fileError(err)
    throw err
  }
}

function fileError(err: CategoriesFileError): NextResponse {
  return NextResponse.json({ error: err.kind === 'corrupt' ? CORRUPT_MESSAGE : MISSING_MESSAGE }, { status: 422 })
}

// Domain errors keep their deliberate 4xx; anything else is null (caller → 5xx).
export function domainError(err: unknown): NextResponse | null {
  if (err instanceof CategoriesFileError) return fileError(err)
  if (err instanceof CategoryValidationError) return NextResponse.json({ error: err.message }, { status: err.status })
  if (err instanceof StaleShaError) return NextResponse.json({ error: STALE_MESSAGE }, { status: 409 })
  return null
}
