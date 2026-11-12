// Radius of an audience's numbered dot: plotted by score along the band, from
// the inner edge (0) to the outer edge (100), inset by the dot's radius so it
// never leaves the band. A missing score sits at the band's midpoint.
export function scoreDotRadius(score: number | null, rIn: number, rOut: number, dotR: number): number {
  const lo = rIn + dotR
  const hi = rOut - dotR
  if (score === null || !Number.isFinite(score)) return (lo + hi) / 2
  const t = Math.min(100, Math.max(0, score)) / 100
  return lo + t * (hi - lo)
}
