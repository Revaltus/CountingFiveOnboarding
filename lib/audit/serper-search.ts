// General Google organic-search helper via Serper, reusing the auth/timeout/
// degrade-gracefully pattern of index-check.ts. Used by the competitive-ranking
// and digital-intelligence modules. Returns null (not an empty array) when the
// search could not run — callers treat that as "unverified", distinct from a
// search that ran and found nothing.
const SERPER_API = 'https://google.serper.dev/search'
const SERPER_TIMEOUT_MS = 15_000

export interface SerperOrganicResult {
  position: number
  title: string
  link: string
  snippet: string
}

export function serperEnabled(): boolean {
  return !!process.env.SERPER_API_KEY
}

/** The domain's best organic position for a query. `{ position: null }` = the
 * search ran and the domain isn't in the results; null = it could not run. */
export async function rankFor(
  query: string,
  domain: string,
  opts: { location?: string } = {},
): Promise<{ position: number | null; url: string | null } | null> {
  const results = await serperSearch(query, opts)
  if (!results) return null
  const target = domain.toLowerCase().replace(/^www\./, '')
  const hit = results.find((r) => {
    try {
      const host = new URL(r.link).hostname.toLowerCase().replace(/^www\./, '')
      return host === target || host.endsWith(`.${target}`)
    } catch {
      return false
    }
  })
  return hit ? { position: hit.position, url: hit.link } : { position: null, url: null }
}

/** Run one Google organic search. Returns the organic results, or null when no
 * key is set or the request fails. `gl`/`location` bias results geographically
 * (Serper accepts a free-text `location`, e.g. "Port Arthur, Texas, United
 * States"). */
export async function serperSearch(
  query: string,
  opts: { location?: string; gl?: string } = {},
): Promise<SerperOrganicResult[] | null> {
  if (!process.env.SERPER_API_KEY) return null
  try {
    const body: Record<string, string> = { q: query, gl: opts.gl ?? 'us' }
    if (opts.location) body.location = opts.location
    const res = await fetch(SERPER_API, {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SERPER_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      organic?: Array<{ position?: number; title?: string; link?: string; snippet?: string }>
    }
    return (data.organic ?? []).map((o, i) => ({
      position: typeof o.position === 'number' ? o.position : i + 1,
      title: o.title ?? '',
      link: o.link ?? '',
      snippet: o.snippet ?? '',
    }))
  } catch {
    return null
  }
}
