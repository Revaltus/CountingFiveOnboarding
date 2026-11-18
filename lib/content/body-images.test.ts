import { describe, expect, it } from 'vitest'
import {
  MAX_BODY_IMAGES,
  bodyImageMarkdown,
  insertBodyImages,
  parseBodyImagePlacements,
  sanitizeBodyImageAlt,
  sanitizeBodyImageFilename,
  sanitizeBodyImagePlacements,
  type BodyImagePlacement,
} from './body-images'
import { extractPageImages } from '@/lib/editor/page-images'

const place = (over: Partial<BodyImagePlacement> = {}): BodyImagePlacement => ({
  after_heading: 'Gather Your Records',
  filename: 'records-desk.jpg',
  query: 'person sorting paper receipts at desk',
  alt: 'A person sorting receipts at a desk',
  ...over,
})

const BODY = [
  'Intro paragraph.',
  '',
  '## Gather Your Records',
  '',
  'First paragraph line one.',
  'First paragraph line two.',
  '',
  'Second paragraph.',
  '',
  '## Plan Your Payments',
  '',
  'Payments paragraph.',
].join('\n')

describe('insertBodyImages', () => {
  it('places the image after the first paragraph under the matching H2', () => {
    const { body, inserted } = insertBodyImages(BODY, [place()])
    expect(inserted).toHaveLength(1)
    expect(body).toContain(
      'First paragraph line two.\n\n![A person sorting receipts at a desk](/content-assets/records-desk.jpg)\n\nSecond paragraph.'
    )
  })

  it('matches the heading trimmed and case-insensitively', () => {
    const { inserted } = insertBodyImages(BODY, [place({ after_heading: '  gather your RECORDS ' })])
    expect(inserted).toHaveLength(1)
  })

  it('only matches H2 headings', () => {
    const body = '### Gather Your Records\n\nText.\n'
    expect(insertBodyImages(body, [place()]).inserted).toHaveLength(0)
  })

  it('skips a missing heading and leaves the body unchanged', () => {
    const { body, inserted } = insertBodyImages(BODY, [place({ after_heading: 'Nope' })])
    expect(inserted).toEqual([])
    expect(body).toBe(BODY)
  })

  it('never inserts inside a list; uses the paragraph after it', () => {
    const body = '## Gather Your Records\n\n- one\n- two\n  lazy continuation\n\nAfter the list.\n'
    const out = insertBodyImages(body, [place()]).body
    expect(out).toBe(
      '## Gather Your Records\n\n- one\n- two\n  lazy continuation\n\nAfter the list.\n\n![A person sorting receipts at a desk](/content-assets/records-desk.jpg)\n'
    )
  })

  it('skips a section that is only a list or table', () => {
    const list = '## Gather Your Records\n\n- one\n- two\n\n  indented continuation\n\n## Next\n\nText.\n'
    expect(insertBodyImages(list, [place()]).inserted).toHaveLength(0)
    const table = '## Gather Your Records\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
    expect(insertBodyImages(table, [place()]).inserted).toHaveLength(0)
  })

  it('skips a section holding a block annotation', () => {
    const body = '## Gather Your Records\n\n<!-- block: checklist -->\n\nSome text.\n'
    const { body: out, inserted } = insertBodyImages(body, [place()])
    expect(inserted).toHaveLength(0)
    expect(out).toBe(body)
  })

  it('ignores headings and paragraphs inside code fences', () => {
    const body = '```\n## Gather Your Records\n\ncode text\n```\n\n## Gather Your Records\n\n```\nx\n```\n\nReal paragraph.\n'
    const out = insertBodyImages(body, [place()]).body
    expect(out).toContain('Real paragraph.\n\n![')
    expect(out.indexOf('![')).toBeGreaterThan(out.indexOf('Real paragraph.'))
  })

  it('stops at a subheading: a paragraph under an H3 is not under the H2', () => {
    const body = '## Gather Your Records\n\n### Sub\n\nText.\n'
    expect(insertBodyImages(body, [place()]).inserted).toHaveLength(0)
  })

  it('caps at two and dedupes filenames and headings', () => {
    const { inserted } = insertBodyImages(BODY, [
      place(),
      place({ filename: 'records-desk.jpg', after_heading: 'Plan Your Payments' }),
      place({ filename: 'other.jpg' }),
      place({ filename: 'payments.jpg', after_heading: 'Plan Your Payments' }),
      place({ filename: 'third.jpg', after_heading: 'Plan Your Payments' }),
    ])
    expect(inserted.map((p) => p.filename)).toEqual(['records-desk.jpg', 'payments.jpg'])
    expect(inserted.length).toBeLessThanOrEqual(MAX_BODY_IMAGES)
  })

  it('renames a body filename that collides with the hero', () => {
    const { inserted } = insertBodyImages(BODY, [place({ filename: 'Hero-Shot.JPG' })], {
      heroFilename: 'hero-shot.jpg',
    })
    expect(inserted[0].filename).toBe('hero-shot-body.jpg')
  })

  it('preserves CRLF line endings', () => {
    const { body } = insertBodyImages(BODY.replace(/\n/g, '\r\n'), [place()])
    expect(body).not.toMatch(/[^\r]\n/)
    expect(body).toContain('![')
  })

  it('produces markdown the editor parses as a body image', () => {
    const { body } = insertBodyImages(BODY, [place({ alt: 'Alt [with] brackets\nand a newline' })])
    const refs = extractPageImages({ frontmatter: null, body } as Parameters<typeof extractPageImages>[0])
    expect(refs).toEqual([
      expect.objectContaining({ source: 'body', filename: 'records-desk.jpg', alt: 'Alt with brackets and a newline' }),
    ])
  })
})

describe('sanitizers', () => {
  it('sanitizes filenames to kebab-case .jpg', () => {
    expect(sanitizeBodyImageFilename('Tax Docs_2026.PNG')).toBe('tax-docs-2026.jpg')
    expect(sanitizeBodyImageFilename('../../etc/passwd')).toBe('passwd.jpg')
    expect(sanitizeBodyImageFilename('---.jpg')).toBeNull()
  })

  it('strips brackets and newlines from alt', () => {
    expect(sanitizeBodyImageAlt('a ]b[ c\r\nd')).toBe('a b c d')
    expect(bodyImageMarkdown({ filename: 'x.jpg', alt: 'x]y' })).toBe('![xy](/content-assets/x.jpg)')
  })

  it('falls back to the query when alt is empty and trims the query to 8 words', () => {
    const [p] = sanitizeBodyImagePlacements(
      [place({ alt: '', query: 'one two three four five six seven eight nine ten' })],
      null
    )
    expect(p.query).toBe('one two three four five six seven eight')
    expect(p.alt).toBe(p.query)
  })

  it('parses only well-formed raw placements', () => {
    expect(parseBodyImagePlacements('nope')).toEqual([])
    expect(
      parseBodyImagePlacements([null, 3, { after_heading: 'H', filename: 'f.jpg' }, { after_heading: 'H', filename: 'f.jpg', query: 'q', alt: 7 }])
    ).toEqual([{ after_heading: 'H', filename: 'f.jpg', query: 'q', alt: '' }])
  })
})
