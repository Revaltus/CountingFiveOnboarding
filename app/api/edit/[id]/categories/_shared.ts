import { NextResponse } from 'next/server'
import { StaleShaError } from '@/lib/github/repo-files'
import { CategoryValidationError } from '@/lib/content/blog-categories'
import { ensureSeeded, loadCategories, type Actor } from '@/lib/content/blog-categories-repo'
import { createServerClient } from '@/lib/supabase/server'
import type { SessionSchema } from '@/types/session-schema'
import type { EditContext } from '../_helpers'

export const STALE_MESSAGE = 'Categories changed in another tab — reload'
export const CORRUPT_MESSAGE =
  'content/categories.json is invalid — fix it in the file editor or delete it to re-seed'

export const actorOf = (ctx: EditContext): Actor => ({ name: ctx.adminName, email: ctx.adminEmail })

// Seed on first open. A StaleShaError that escapes ensureSeeded means a
// categories.json exists on the draft branch but does not parse.
export async function seedOrCorrupt(ctx: EditContext): Promise<{ seeded: boolean } | NextResponse> {
  const supabase = createServerClient()
  const { data } = await supabase.from('sessions').select('schema_data').eq('id', ctx.sessionId).single()
  const schema = (data?.schema_data ?? {}) as SessionSchema
  try {
    const before = await loadCategories(ctx.githubRepo)
    await ensureSeeded(ctx.githubRepo, schema, actorOf(ctx))
    return { seeded: !before.file }
  } catch (err) {
    if (err instanceof StaleShaError) return NextResponse.json({ error: CORRUPT_MESSAGE }, { status: 422 })
    throw err
  }
}

// Domain errors keep their deliberate 4xx; anything else is null (caller → 5xx).
export function domainError(err: unknown): NextResponse | null {
  if (err instanceof CategoryValidationError) return NextResponse.json({ error: err.message }, { status: err.status })
  if (err instanceof StaleShaError) return NextResponse.json({ error: STALE_MESSAGE }, { status: 409 })
  return null
}
