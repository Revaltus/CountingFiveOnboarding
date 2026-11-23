import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { deleteCategory } from '@/lib/content/blog-categories-repo'
import type { CategoryDeleteResponse } from '@/types/blog-categories'
import { resolveEditContext } from '../../_helpers'
import { actorOf, domainError } from '../_shared'

export const runtime = 'nodejs'

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; categoryId: string }> }
) {
  const { id, categoryId } = await params
  const ctx = await resolveEditContext(id)
  if (ctx instanceof NextResponse) return ctx
  const moveTo = new URL(req.url).searchParams.get('moveTo') || null
  try {
    const res: CategoryDeleteResponse = await deleteCategory(ctx.githubRepo, categoryId, moveTo, actorOf(ctx))
    return NextResponse.json(res)
  } catch (err) {
    return domainError(err) ?? internalError('categories:delete', err, 'Could not delete category')
  }
}
