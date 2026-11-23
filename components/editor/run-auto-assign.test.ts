import { describe, it, expect } from 'vitest'
import { runAutoAssign } from './run-auto-assign'

describe('runAutoAssign', () => {
  it('accumulates attempted paths and sums counts until remaining is 0', async () => {
    const seen: string[][] = []
    const batches = [
      { categorized: 2, leftUncategorized: 1, remaining: 2, attempted: ['a', 'b', 'c'] },
      { categorized: 1, leftUncategorized: 1, remaining: 0, attempted: ['d', 'e'] },
    ]
    let i = 0
    const progress: number[] = []
    const totals = await runAutoAssign(
      async (attempted) => {
        seen.push([...attempted])
        return batches[i++]
      },
      (p) => progress.push(p.remaining),
    )
    expect(seen).toEqual([[], ['a', 'b', 'c']])
    expect(totals).toEqual({ categorized: 3, leftUncategorized: 2 })
    expect(progress).toEqual([2, 0])
  })

  it('stops on an empty batch even if remaining is reported', async () => {
    let calls = 0
    const totals = await runAutoAssign(async () => {
      calls++
      return { categorized: 0, leftUncategorized: 0, remaining: 5, attempted: [] }
    })
    expect(calls).toBe(1)
    expect(totals).toEqual({ categorized: 0, leftUncategorized: 0 })
  })
})
