import { describe, it, expect } from 'vitest'
import { measurePageStructure, isGenericCtaLabel, MAX_CONTENT_SPLITS } from './page-structure'
import {
  WRITING_EXAMPLES,
  PAGE_BODY_EXEMPLAR,
  OUTLINE_EXEMPLAR,
  SHORT_COPY_EXEMPLAR,
} from './exemplars'

// Guards against an exemplar being accidentally emptied — they ride in the cached
// prompt prefixes, so a blank one silently drops the few-shot guidance.
describe('exemplars', () => {
  it('all exemplars are non-empty', () => {
    for (const ex of [WRITING_EXAMPLES, PAGE_BODY_EXEMPLAR, OUTLINE_EXEMPLAR, SHORT_COPY_EXEMPLAR]) {
      expect(ex.trim().length).toBeGreaterThan(50)
    }
  })

  it('the writing examples contrast weak vs strong', () => {
    expect(WRITING_EXAMPLES).toContain('✗')
    expect(WRITING_EXAMPLES).toContain('✓')
  })

  it('the page-body exemplar demonstrates the block annotation format', () => {
    expect(PAGE_BODY_EXEMPLAR).toContain('<!-- block:')
  })

  it('the page-body exemplar follows the page-structure rules it teaches', () => {
    const m = measurePageStructure(PAGE_BODY_EXEMPLAR.replace(/^[^\n]*\n/, ''))
    expect(m.splitCount).toBeLessThanOrEqual(MAX_CONTENT_SPLITS)
    expect(m.consecutiveImageBlocks).toBe(0)
    expect(m.bulletCount).toBeGreaterThanOrEqual(3)
    expect(m.ctaLabel).not.toBeNull()
    expect(isGenericCtaLabel(m.ctaLabel ?? '')).toBe(false)
  })

  it('the outline exemplar is valid JSON with specific section descriptions', () => {
    const match = OUTLINE_EXEMPLAR.match(/\{[\s\S]*\}/)
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match![0]) as { sections: Array<{ description: string }> }
    expect(parsed.sections.length).toBeGreaterThan(2)
    // Descriptions should be working briefs, not placeholders.
    expect(parsed.sections.every((s) => s.description.length > 20)).toBe(true)
  })
})
