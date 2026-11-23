import type { BlogCategory } from '@/lib/content/blog-categories'

export interface CategoriesGetResponse {
  categories: BlogCategory[]
  counts: Record<string, number>
  /** Draft-branch blob sha of categories.json; send back on PATCH. */
  sha: string | null
  seeded: boolean
  templateSupportsCategories: boolean
}

export interface CategoryCreateRequest {
  name: string
  slug?: string
  description?: string
}
export interface CategoryCreateResponse {
  category: BlogCategory
}

export interface CategoriesPatchRequest {
  categories: Array<{ id: string; name: string; slug: string; description?: string }>
  sha: string
}
export interface CategoriesPatchResponse {
  categories: BlogCategory[]
}

export interface CategoryDeleteResponse {
  postsChanged: number
}
