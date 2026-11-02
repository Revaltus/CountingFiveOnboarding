import { describe, it, expect } from 'vitest'
import { markdownToDocxParagraphs } from './markdown-to-docx'
import { CAROUSEL_CUE } from './page-structure'

// docx paragraphs keep their text in an internal tree; serializing it is enough
// to see what would be printed.
async function docText(markdown: string): Promise<string> {
  return JSON.stringify(markdownToDocxParagraphs(markdown))
}

describe('markdownToDocxParagraphs', () => {
  it('drops block annotations instead of printing them as copy', async () => {
    const text = await docText('<!-- block: content-split | variant: image-right | image: a.jpg -->\n## Heading\n\nBody.')
    expect(text).not.toContain('block:')
    expect(text).toContain('Heading')
    expect(text).toContain('Body.')
  })

  it('marks carousel sections for the rebuild', async () => {
    const text = await docText('<!-- block: testimonials | variant: carousel -->\n## What clients say\n\n> Great.')
    expect(text).toContain(CAROUSEL_CUE)
    const grid = await docText('<!-- block: testimonials | variant: grid -->\n## What clients say')
    expect(grid).not.toContain(CAROUSEL_CUE)
  })
})
