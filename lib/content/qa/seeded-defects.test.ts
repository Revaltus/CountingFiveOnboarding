import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runRules } from './rules'

const dir = path.join(__dirname, '__fixtures__')
const body = readFileSync(path.join(dir, 'seeded-defects.md'), 'utf8')
const expected = JSON.parse(readFileSync(path.join(dir, 'seeded-defects.expect.json'), 'utf8')) as { rules: string[] }

describe('seeded-defect fixture', () => {
  it('rules catch every planted deterministic defect', () => {
    const kinds = new Set(runRules({
      body, pageUrl: '/industries/manufacturing', metaTitle: 'Tax Planning for Manufacturers in Michigan | Korbey Lague', metaDescription: 'x'.repeat(155),
      heroBlock: 'hero', heroVariant: 'image', heroSubhead: null, faqBlock: null,
      noGoPhrases: ['trusted partner'], avoidPhrases: [],
    }).map(f => f.kind))
    for (const k of expected.rules) expect(kinds).toContain(k)
  })
})
