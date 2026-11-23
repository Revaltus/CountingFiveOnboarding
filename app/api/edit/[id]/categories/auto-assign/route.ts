import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { backfillCategories } from '@/lib/content/blog-categories-backfill'
import type { CategoriesAutoAssignRequest } from '@/types/blog-categories'
import { resolveEditContext } from '../../_helpers'
import { actorOf, domainError, seedOrCorrupt } from '../_shared'

export const runtime = 'nodejs'
export const maxDuration = 300

// Leave headroom under maxDuration for the commit.
const CLASSIFY_BUDGET_MS = 240_000

type Params = { params: Promise<{ id: string }> }

export async function POST(req: Request, { params }: Params) {
  const { id } = await params
  const ctx = await resolveEditContext(id)
  if (ctx instanceof NextResponse) return ctx
  let body: CategoriesAutoAssignRequest = {}
  try {
    const text = await req.text()
    if (text.trim()) body = JSON.parse(text) as CategoriesAutoAssignRequest
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const attempted = body?.attempted
  if (attempted !== undefined && (!Array.isArray(attempted) || !attempted.every((p) => typeof p === 'string'))) {
    return NextResponse.json({ error: 'attempted must be an array of paths' }, { status: 400 })
  }
  try {
    // Seeds on first use from the session's schema (and 422s on a corrupt
    // file); backfill then requires the existing file (422 if corrupt/missing).
    const seed = await seedOrCorrupt(ctx)
    if (seed instanceof NextResponse) return seed
    const res = await backfillCategories({
      githubRepo: ctx.githubRepo,
      sessionId: ctx.sessionId,
      actor: actorOf(ctx),
      createdBy: ctx.adminId,
      attempted: attempted ?? [],
      deadlineAt: Date.now() + CLASSIFY_BUDGET_MS,
    })
    return NextResponse.json(res)
  } catch (err) {
    return domainError(err) ?? internalError('categories:auto-assign', err, 'Could not auto-categorize posts')
  }
}
