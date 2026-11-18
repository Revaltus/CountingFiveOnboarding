import { describe, expect, it } from 'vitest'
import {
  bodyImageAnchors,
  bodyImageMarkdown,
  extractBodyImages,
  extractPageImages,
  insertBodyImage,
  setBodyImage,
  setBodyImageAlt,
} from './page-images'
import type { Frontmatter } from './frontmatter'

function fm(fields: Record<string, string>): Frontmatter {
  return { raw: '', fields, arrayFields: {}, order: Object.keys(fields) }
}

const BODY = [
  '## One',
  '',
  'Intro.',
  '',
  '![First photo](a.jpg)',
  '',
  'More.',
  '',
  '![External](https://x.com/e.jpg)',
  '',
  '![Same file again](a.jpg)',
  '',
  'End.',
].join('\n')

describe('extractPageImages', () => {
  it('reads the post `image` field (JSON-quoted alt) as the hero', () => {
    const refs = extractPageImages({
      frontmatter: fm({ image: 'hero.jpg', image_alt: '"A \\"quoted\\" alt"' }),
      body: '',
    })
    expect(refs).toEqual([
      { key: 'hero:hero.jpg', source: 'hero_image', filename: 'hero.jpg', assetPath: 'public/content-assets/hero.jpg', alt: 'A "quoted" alt' },
    ])
  })

  it('still reads legacy `hero_image`', () => {
    const refs = extractPageImages({ frontmatter: fm({ hero_image: 'old.png' }), body: '' })
    expect(refs[0]?.filename).toBe('old.png')
  })
})

describe('extractBodyImages', () => {
  it('lists local images in order with their ordinal among all images', () => {
    expect(extractBodyImages(BODY)).toEqual([
      { index: 0, filename: 'a.jpg', alt: 'First photo' },
      { index: 2, filename: 'a.jpg', alt: 'Same file again' },
    ])
  })
})

describe('setBodyImage / setBodyImageAlt', () => {
  it('swaps only the chosen occurrence', () => {
    const next = setBodyImage(BODY, 2, 'b.jpg')
    expect(next).toContain('![First photo](a.jpg)')
    expect(next).toContain('![Same file again](/content-assets/b.jpg)')
  })

  it('removes an image and collapses the empty paragraph', () => {
    const next = setBodyImage(BODY, 0, null)
    expect(next).not.toContain('First photo')
    expect(next).toContain('Intro.\n\nMore.')
  })

  it('edits alt text, stripping brackets and newlines', () => {
    const next = setBodyImageAlt(BODY, 0, 'New [alt]\ntext ')
    expect(next).toContain('![New alt text ](a.jpg)')
  })

  it('builds standalone markdown', () => {
    expect(bodyImageMarkdown('c.jpg', ' A team ')).toBe('![A team](/content-assets/c.jpg)')
  })
})

describe('insertBodyImage', () => {
  const body = ['## Alpha', '', 'Para one', 'continues.', '', '- a list', '', '## Beta', '', '- only list', ''].join('\n')

  it('places the image after the first paragraph under the chosen heading', () => {
    const next = insertBodyImage(body, '![x](x.jpg)', 0)
    expect(next).toContain('Para one\ncontinues.\n\n![x](x.jpg)\n\n- a list')
  })

  it('appends when the section has no plain paragraph or no anchor is given', () => {
    expect(insertBodyImage(body, '![x](x.jpg)', 1).trimEnd().endsWith('- only list\n\n![x](x.jpg)')).toBe(true)
    expect(insertBodyImage(body, '![x](x.jpg)', null).trimEnd().endsWith('![x](x.jpg)')).toBe(true)
  })

  it('lists H2 anchors', () => {
    expect(bodyImageAnchors(body)).toEqual(['Alpha', 'Beta'])
  })
})
