import { describe, expect, it } from 'vitest'
import { scoreDotRadius } from './arc-geometry'

describe('scoreDotRadius', () => {
  it('plots 0 at the inner edge and 100 at the outer edge, inset by the dot', () => {
    expect(scoreDotRadius(0, 100, 200, 13)).toBe(113)
    expect(scoreDotRadius(100, 100, 200, 13)).toBe(187)
    expect(scoreDotRadius(50, 100, 200, 13)).toBe(150)
  })

  it('clamps out-of-range scores and centres a missing one', () => {
    expect(scoreDotRadius(140, 100, 200, 13)).toBe(187)
    expect(scoreDotRadius(-5, 100, 200, 13)).toBe(113)
    expect(scoreDotRadius(null, 100, 200, 13)).toBe(150)
  })
})
