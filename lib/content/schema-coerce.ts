// Shape coercion for stored `schema_data`. Every field here is *declared* with a
// type in SessionSchema, but the stored JSONB can carry a different shape from an
// AI draft, a notes import, a hand edit, or a bracket-path suggestion write. `??
// []` only guards null/undefined, so a dirty value slips straight through and
// TypeErrors deep inside a generator, where it surfaces as a generic "generation
// failed" note. Read dirty-able schema fields through these helpers.

// A string that is really a JSON-encoded string array ('["a", "b"]', written by
// an AI draft or import) — decoded so prompts get "a, b", not brackets and
// quotes cut off mid-item. Anything else is not a JSON array → null.
function jsonStringArray(s: string): string[] | null {
  const t = s.trim()
  if (!t.startsWith('[') || !t.endsWith(']')) return null
  try {
    const parsed: unknown = JSON.parse(t)
    return Array.isArray(parsed) && parsed.every(x => typeof x === 'string') ? (parsed as string[]) : null
  } catch {
    return null
  }
}

// String fields that may hold an array/object. Arrays flatten to a comma list;
// anything else → ''. (Calling `.trim()` on a non-string took down BOTH the
// outline and page-body generators.)
export const str = (v: unknown): string =>
  typeof v === 'string'
    ? (jsonStringArray(v)?.join(', ') ?? v)
    : Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string').join(', ')
      : ''

// string[] fields that may hold a bare string. Symmetric with str() (arrays →
// comma string): a stray non-empty string is preserved as a single element so the
// field's content survives; anything else → []. (Client 07df2372 stored an array
// field as a string → "(t ?? []).filter is not a function" on every outline.)
export const arr = <T>(v: T[] | undefined | null): T[] => {
  if (Array.isArray(v)) return v
  const u = v as unknown
  if (typeof u !== 'string' || !u.trim()) return []
  return (jsonStringArray(u) ?? [u.trim()]) as unknown as T[]
}

// Object-array fields (niches, services, serviceAreas, locations, team...). Two
// failure modes in one read: a stringy value (business.serviceAreas held the
// string "Nationwide, International" → `areas.length` is truthy, so an
// `if (length)` guard passes and `.map`/`.find` throws), and null/non-object
// holes inside the array (a bracket-path write past the end leaves sparse slots
// that persist as JSONB null → `.name` of null). Mirrors the filter in
// active-niches.ts, for fields that have no active*() choke point of their own.
// Never widens a string into a fake row: a scalar can't be recovered into
// structured fields, so it degrades to [].
export const objArr = <T>(v: unknown): T[] =>
  Array.isArray(v) ? v.filter((x): x is T => !!x && typeof x === 'object') : []

// The onboarding chat writes an explicit sentinel ("None", or ["None"]) into a
// field when the firm genuinely has nothing for it, so the gap counts as
// answered. That sentinel must never reach a prompt as real content (a "None"
// success story would pass the case-study gate and get quoted as proof).
const SENTINEL_NONE = new Set(['none', 'n/a', 'na', 'not applicable', 'nothing', 'none yet'])
export const isSentinelNone = (v: unknown): boolean =>
  typeof v === 'string' && SENTINEL_NONE.has(v.trim().toLowerCase().replace(/[.!]+$/, ''))

// arr() + str() with sentinel entries and blanks dropped — for string-array
// fields that feed prompts (success stories, keywords...).
export const realStrings = (v: unknown): string[] =>
  arr(v as unknown[] | null | undefined)
    .map((x) => str(x).trim())
    .filter((x) => x.length > 0 && !isSentinelNone(x))
