import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { compareTemplateVersions } from '@/lib/content/block-catalog'
import { newCategoryId, validateCategoryInput, CategoryValidationError, type BlogCategory } from '@/lib/content/blog-categories'
import { listCategoryCounts, loadCategories, saveCategories } from '@/lib/content/blog-categories-repo'
import { readDraftTemplateVersion } from '@/lib/design/capabilities-read'
import type {
  CategoriesGetResponse,
  CategoriesPatchRequest,
  CategoriesPatchResponse,
  CategoryCreateRequest,
  CategoryCreateResponse,
} from '@/types/blog-categories'
import { resolveEditContext } from '../_helpers'
import { actorOf, domainError, seedOrCorrupt, STALE_MESSAGE } from './_shared'

export const runtime = 'nodejs'

const MIN_TEMPLATE = '2026.09.15'
type Params = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params
  const ctx = await resolveEditContext(id)
  if (ctx instanceof NextResponse) return ctx
  try {
    const seed = await seedOrCorrupt(ctx)
    if (seed instanceof NextResponse) return seed
    const [loaded, counts, version] = await Promise.all([
      loadCategories(ctx.githubRepo),
      listCategoryCounts(ctx.githubRepo),
      readDraftTemplateVersion(ctx.githubRepo),
    ])
    const body: CategoriesGetResponse = {
      categories: loaded.file?.categories ?? [],
      counts,
      sha: loaded.sha,
      seeded: seed.seeded,
      templateSupportsCategories: compareTemplateVersions(version ?? '0', MIN_TEMPLATE) >= 0,
    }
    return NextResponse.json(body)
  } catch (err) {
    return domainError(err) ?? internalError('categories:get', err, 'Could not load categories')
  }
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params
  const ctx = await resolveEditContext(id)
  if (ctx instanceof NextResponse) return ctx
  let body: CategoryCreateRequest
  try {
    body = (await req.json()) as CategoryCreateRequest
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body?.name !== 'string') return NextResponse.json({ error: 'Category name is required' }, { status: 400 })
  try {
    const seed = await seedOrCorrupt(ctx)
    if (seed instanceof NextResponse) return seed
    const { file, sha } = await loadCategories(ctx.githubRepo)
    const existing = file?.categories ?? []
    const fields = validateCategoryInput(
      {
        name: body.name,
        slug: typeof body.slug === 'string' ? body.slug : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
      },
      existing
    )
    const category: BlogCategory = { id: newCategoryId(existing.map((c) => c.id)), ...fields }
    await saveCategories(
      ctx.githubRepo,
      { version: 1, categories: [...existing, category] },
      sha,
      actorOf(ctx),
      `Add blog category ${category.name}`
    )
    const res: CategoryCreateResponse = { category }
    return NextResponse.json(res, { status: 201 })
  } catch (err) {
    return domainError(err) ?? internalError('categories:create', err, 'Could not create category')
  }
}

// Full-list replace: rename + reorder only. The id set must match exactly.
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params
  const ctx = await resolveEditContext(id)
  if (ctx instanceof NextResponse) return ctx
  let body: CategoriesPatchRequest
  try {
    body = (await req.json()) as CategoriesPatchRequest
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!Array.isArray(body?.categories) || typeof body.sha !== 'string' || !body.sha) {
    return NextResponse.json({ error: 'categories and sha required' }, { status: 400 })
  }
  try {
    const { file, sha } = await loadCategories(ctx.githubRepo)
    if (!file) return NextResponse.json({ error: 'No categories to update' }, { status: 400 })
    if (sha !== body.sha) return NextResponse.json({ error: STALE_MESSAGE }, { status: 409 })

    const incomingIds = body.categories.map((c) => c?.id)
    const currentIds = new Set(file.categories.map((c) => c.id))
    if (
      incomingIds.length !== currentIds.size ||
      new Set(incomingIds).size !== incomingIds.length ||
      !incomingIds.every((i) => typeof i === 'string' && currentIds.has(i))
    ) {
      return NextResponse.json({ error: 'Category ids must match the current set' }, { status: 400 })
    }

    const next: BlogCategory[] = []
    for (const c of body.categories) {
      if (typeof c.name !== 'string') throw new CategoryValidationError('Category name is required', 400)
      const fields = validateCategoryInput(
        {
          name: c.name,
          slug: typeof c.slug === 'string' ? c.slug : undefined,
          description: typeof c.description === 'string' ? c.description : undefined,
        },
        next
      )
      next.push({ id: c.id, ...fields })
    }
    await saveCategories(ctx.githubRepo, { version: 1, categories: next }, sha, actorOf(ctx), 'Update blog categories')
    const res: CategoriesPatchResponse = { categories: next }
    return NextResponse.json(res)
  } catch (err) {
    return domainError(err) ?? internalError('categories:patch', err, 'Could not save categories')
  }
}
