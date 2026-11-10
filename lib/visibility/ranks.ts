import { rankFor } from '@/lib/audit/serper-search'
import type { SessionSchema } from '@/types/session-schema'
import type { RankResult } from './types'

const MAX_QUERIES = 10
const CONCURRENCY = 3

const place = (city: string | undefined, state: string | undefined): string | null => {
  const c = (city ?? '').trim()
  if (!c) return null
  const s = (state ?? '').trim()
  return s ? `${c}, ${s}` : c
}

export function primaryCity(schema: SessionSchema): string | null {
  const areas = Array.isArray(schema.business?.serviceAreas) ? schema.business.serviceAreas : []
  const primary = areas.find((a) => a?.primary)
  const firstLocation = Array.isArray(schema.locations) ? schema.locations[0] : undefined
  return (
    place(primary?.city, primary?.state) ??
    place(firstLocation?.city, firstLocation?.state) ??
    place(areas[0]?.city, areas[0]?.state)
  )
}

export function buildRankQueries(schema: SessionSchema): string[] {
  const raw = Array.isArray(schema.business?.targetKeywords) ? schema.business.targetKeywords : []
  const city = primaryCity(schema)?.split(',')[0].trim() ?? null
  const seen = new Set<string>()
  const out: string[] = []
  for (const kw of raw) {
    if (typeof kw !== 'string') continue
    const k = kw.trim()
    const key = k.toLowerCase()
    if (!k || seen.has(key)) continue
    seen.add(key)
    out.push(city && !key.includes(city.toLowerCase()) ? `${k} ${city}` : k)
    if (out.length === MAX_QUERIES) break
  }
  return out
}

// null when nothing could run (no key, no keywords, or every lookup failed).
export async function checkRanks(schema: SessionSchema, domain: string): Promise<RankResult[] | null> {
  const queries = buildRankQueries(schema)
  if (!queries.length) return []
  const location = primaryCity(schema) ?? undefined
  const out: RankResult[] = []
  let ran = 0
  for (let i = 0; i < queries.length; i += CONCURRENCY) {
    const batch = queries.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map((q) => rankFor(q, domain, { location })))
    results.forEach((r, j) => {
      if (!r) return
      ran++
      out.push({ query: batch[j], position: r.position, url: r.url })
    })
  }
  return ran === 0 ? null : out
}
