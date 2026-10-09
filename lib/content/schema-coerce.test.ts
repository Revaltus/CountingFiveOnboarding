import { describe, expect, it } from 'vitest'
import { arr, objArr, str, isSentinelNone, realStrings } from './schema-coerce'

describe('objArr', () => {
  it('degrades a stringy object-array field to empty (business.serviceAreas)', () => {
    // The Berg session stored serviceAreas as "Nationwide, International", whose
    // truthy .length slipped past an `if (areas.length)` guard and threw on .map.
    expect(objArr('Nationwide, International')).toEqual([])
  })

  it('drops null holes left by a stale-index bracket write', () => {
    expect(objArr([{ name: 'A' }, null, { name: 'B' }, undefined])).toEqual([
      { name: 'A' },
      { name: 'B' },
    ])
  })

  it('drops non-object elements rather than widening a scalar into a row', () => {
    expect(objArr([{ name: 'A' }, 'B', 7])).toEqual([{ name: 'A' }])
  })

  it('passes a clean array through untouched', () => {
    const clean = [{ city: 'Tyngsborough' }]
    expect(objArr(clean)).toEqual(clean)
  })

  it('handles null / undefined', () => {
    expect(objArr(null)).toEqual([])
    expect(objArr(undefined)).toEqual([])
  })
})

describe('arr', () => {
  it('preserves a stray string as a single element so content survives', () => {
    expect(arr('Varies' as unknown as string[])).toEqual(['Varies'])
  })

  it('returns [] for a blank string and for non-array non-strings', () => {
    expect(arr('  ' as unknown as string[])).toEqual([])
    expect(arr({ a: 1 } as unknown as string[])).toEqual([])
    expect(arr(null)).toEqual([])
  })
})

describe('str', () => {
  it('flattens an array to a comma list and drops non-strings', () => {
    expect(str(['a', 'b'])).toBe('a, b')
    expect(str(42)).toBe('')
    expect(str('plain')).toBe('plain')
  })
})

describe('isSentinelNone / realStrings', () => {
  it('recognizes the onboarding "None" sentinel case-insensitively', () => {
    for (const v of ['None', ' none ', 'N/A', 'n/a', 'None.']) expect(isSentinelNone(v)).toBe(true)
    for (const v of ['Nonprofit audit win', '', 42, null]) expect(isSentinelNone(v)).toBe(false)
  })

  it('drops sentinels and blanks from string arrays (and a bare sentinel string)', () => {
    expect(realStrings(['None'])).toEqual([])
    expect(realStrings('None')).toEqual([])
    expect(realStrings(['Cut a dentist\'s tax bill 20%', ' n/a ', ''])).toEqual(["Cut a dentist's tax bill 20%"])
  })
})

describe('JSON-encoded string arrays', () => {
  it('arr() decodes a JSON string array stored as a string', () => {
    expect(arr('["Bank reconciliation", "Sales tax filing"]' as unknown as string[])).toEqual(['Bank reconciliation', 'Sales tax filing'])
  })

  it('str() flattens one to a comma list', () => {
    expect(str('["Thin margins", "Tip reporting"]')).toBe('Thin margins, Tip reporting')
  })

  it('leaves non-JSON or mixed arrays as plain strings', () => {
    expect(str('[TBD]')).toBe('[TBD]')
    expect(arr('[1, 2]' as unknown as string[])).toEqual(['[1, 2]'])
    expect(str('Plain text')).toBe('Plain text')
  })
})
