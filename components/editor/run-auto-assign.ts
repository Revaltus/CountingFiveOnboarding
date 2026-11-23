import type { CategoriesAutoAssignResponse } from '@/types/blog-categories'

export interface AutoAssignTotals {
  categorized: number
  leftUncategorized: number
}

/**
 * Drives the batched auto-assign endpoint: resends the accumulated `attempted`
 * paths each round and sums the counts until nothing remains.
 */
export async function runAutoAssign(
  fetcher: (attempted: string[]) => Promise<CategoriesAutoAssignResponse>,
  onProgress?: (totals: AutoAssignTotals & { remaining: number }) => void,
): Promise<AutoAssignTotals> {
  let attempted: string[] = []
  const totals: AutoAssignTotals = { categorized: 0, leftUncategorized: 0 }
  for (;;) {
    const res = await fetcher(attempted)
    totals.categorized += res.categorized
    totals.leftUncategorized += res.leftUncategorized
    attempted = [...attempted, ...res.attempted]
    onProgress?.({ ...totals, remaining: res.remaining })
    // An empty batch means no progress is possible; stop rather than spin.
    if (res.remaining <= 0 || res.attempted.length === 0) return totals
  }
}
