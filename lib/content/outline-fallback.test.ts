import { describe, expect, it } from 'vitest'
import {
  OUTLINE_FALLBACK_NOTE,
  OUTLINE_FALLBACK_PREFIX,
  buildOutlineFailureNote,
  buildOutlineRefusalNote,
  isRefusedOutline,
  isApprovableOutline,
  isFallbackOutline,
} from './outline-fallback'

describe('outline fallback markers', () => {
  it('recognizes the parse-failure placeholder note', () => {
    expect(isFallbackOutline(OUTLINE_FALLBACK_NOTE)).toBe(true)
  })

  it('embeds the real error in the failure note and stays recognized', () => {
    const note = buildOutlineFailureNote(new Error('e.painPoints?.trim is not a function'))
    expect(note.startsWith(OUTLINE_FALLBACK_PREFIX)).toBe(true)
    expect(note).toContain('e.painPoints?.trim is not a function')
    // The prefix is what makes the approval UI flag it as "Needs review".
    expect(isFallbackOutline(note)).toBe(true)
  })

  it('handles non-Error throwables', () => {
    expect(isFallbackOutline(buildOutlineFailureNote('boom'))).toBe(true)
  })

  it('caps a very long error message', () => {
    const note = buildOutlineFailureNote(new Error('x'.repeat(1000)))
    expect(note.length).toBeLessThan(400)
  })

  it('does not flag a normal admin note or blanks', () => {
    expect(isFallbackOutline('Notes for the copywriter: punchy tone')).toBe(false)
    expect(isFallbackOutline(null)).toBe(false)
    expect(isFallbackOutline(undefined)).toBe(false)
    expect(isFallbackOutline('')).toBe(false)
  })
})

describe('refused outlines', () => {
  it('flags an empty-sections / blank-h1 outline as refused', () => {
    expect(isRefusedOutline({ h1: '', sections: [] })).toBe(true)
    expect(isRefusedOutline({ h1: 'Estate planning', sections: [] })).toBe(true)
    expect(isRefusedOutline({ h1: '  ', sections: [{ h2: 'x' }] })).toBe(true)
  })

  it('accepts a real outline', () => {
    expect(isRefusedOutline({ h1: 'Estate planning', sections: [{ h2: 'x' }] })).toBe(false)
  })

  it('builds a review-flagged note that carries the model reason', () => {
    const note = buildOutlineRefusalNote('No outline produced. Topic excluded.')
    expect(isFallbackOutline(note)).toBe(true)
    expect(note).toContain('Topic excluded.')
    expect(isFallbackOutline(buildOutlineRefusalNote(undefined))).toBe(true)
  })
})

describe('isApprovableOutline', () => {
  const good = { h1: 'Estate planning', sections: [{ h2: 'x' }], admin_notes: 'Keep it warm.' }

  it('accepts a real outline', () => {
    expect(isApprovableOutline(good)).toBe(true)
    expect(isApprovableOutline({ ...good, admin_notes: null })).toBe(true)
  })

  it('rejects a placeholder still carrying the Needs review note', () => {
    expect(isApprovableOutline({ ...good, admin_notes: OUTLINE_FALLBACK_NOTE })).toBe(false)
    expect(isApprovableOutline({ ...good, admin_notes: buildOutlineRefusalNote('excluded') })).toBe(false)
  })

  it('rejects a blank h1 or empty sections', () => {
    expect(isApprovableOutline({ ...good, h1: '  ' })).toBe(false)
    expect(isApprovableOutline({ ...good, h1: null })).toBe(false)
    expect(isApprovableOutline({ ...good, sections: [] })).toBe(false)
    expect(isApprovableOutline({ ...good, sections: 'x' })).toBe(false)
  })
})
