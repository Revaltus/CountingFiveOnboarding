import { describe, expect, it } from 'vitest'
import { appendFaqBlock, buildAllPageFiles, buildPageMarkdown, internalizeHref, toPagePath } from './deliverable-builder'
import type { Database } from '@/types/database'

type GeneratedPage = Database['public']['Tables']['generated_pages']['Row']

function makePage(overrides: Partial<GeneratedPage>): GeneratedPage {
  return {
    admin_approved_content: true,
    answer_block: null,
    canonical_url: null,
    client_approved_content: false,
    content_job_id: 'job-1',
    content_markdown: '<!-- block: intro-text -->\n## Overview\n\nBody.',
    created_at: '2026-01-01T00:00:00Z',
    critic_review: null,
    eeat_signals: null,
    faq_block: null,
    faq_heading: null,
    generation_attempts: 0,
    generation_error: null,
    generation_started_at: null,
    generation_status: 'complete',
    hero_block: 'page-header',
    hero_image: null,
    hero_image_alt: null,
    hero_image_query: null,
    hero_subhead: null,
    hero_variant: null,
    id: 'page-1',
    internal_links: null,
    llm_citation_note: null,
    meta_description: null,
    meta_title: null,
    needs_client_review: false,
    page_title: 'Test Page',
    page_url: '/test',
    qa_attempts: 0,
    qa_review: null,
    qa_started_at: null,
    qa_status: null,
    schema_markup_type: null,
    secondary_keywords: null,
    target_keyword: null,
    url_slug: null,
    word_count_actual: null,
    word_count_target: null,
    ...overrides,
  }
}

// Grab the value after `key: ` on its frontmatter line (JSON.stringify emits
// no newlines, so each structured field is a single line).
function frontmatterField(md: string, key: string): string {
  const m = md.match(new RegExp(`^${key}: (.*)$`, 'm'))
  if (!m) throw new Error(`frontmatter field "${key}" not found`)
  return m[1]
}

describe('buildPageMarkdown — structured SEO frontmatter', () => {
  // A colon in the answer is the YAML-hostile char JSON.stringify protects.
  const faq = [{ question: 'Do you offer payroll: weekly?', answer: 'Yes. Weekly, biweekly, or monthly.' }]
  const links = [{ url: '/services/tax', anchor_text: 'tax services', reason: 'related service' }]
  const eeat = ['Ron Lague, CPA, PFS', '200+ returns filed']

  const md = buildPageMarkdown(
    makePage({
      answer_block: 'We file year-round: not just in April.',
      eeat_signals: eeat,
      internal_links: links,
      faq_block: faq,
      llm_citation_note: 'Year-round advisory model.',
    }),
    'Korbey Lague PLLP',
    { websiteUrl: 'https://www.korbeylague.com' }
  )

  it('emits faq_block as JSON that round-trips (fires FAQPage schema downstream)', () => {
    expect(JSON.parse(frontmatterField(md, 'faq_block'))).toEqual(faq)
  })

  it('emits internal_links as JSON that round-trips', () => {
    expect(JSON.parse(frontmatterField(md, 'internal_links'))).toEqual(links)
  })

  it('emits eeat_signals as JSON that round-trips', () => {
    expect(JSON.parse(frontmatterField(md, 'eeat_signals'))).toEqual(eeat)
  })

  it('emits answer_block as a JSON string (colon-safe)', () => {
    expect(JSON.parse(frontmatterField(md, 'answer_block'))).toBe('We file year-round: not just in April.')
  })

  it('defaults missing structured fields to empty JSON (no undefined in YAML)', () => {
    const bare = buildPageMarkdown(makePage({}), 'Firm', { websiteUrl: 'https://x.com' })
    expect(JSON.parse(frontmatterField(bare, 'faq_block'))).toEqual([])
    expect(JSON.parse(frontmatterField(bare, 'internal_links'))).toEqual([])
    expect(JSON.parse(frontmatterField(bare, 'answer_block'))).toBe('')
  })

  it('still includes the human-readable review trailer', () => {
    expect(md).toContain('## SEO & AIO Metadata')
  })
})

describe('toPagePath — full-URL / root-relative normalization', () => {
  it('strips scheme+host from crawled full-URL page_url', () => {
    expect(toPagePath('https://www.bblcpa.com/what-we-do/outsourced-accounting')).toBe(
      '/what-we-do/outsourced-accounting'
    )
  })
  it('collapses the origin root to /', () => {
    expect(toPagePath('https://www.bblcpa.com/')).toBe('/')
    expect(toPagePath('https://www.bblcpa.com')).toBe('/')
  })
  it('leaves clean root-relative paths untouched (minus trailing slash)', () => {
    expect(toPagePath('/services')).toBe('/services')
    expect(toPagePath('/services/')).toBe('/services')
  })
})

describe('buildAllPageFiles — filenames are clean slugs (Issue #1/#2)', () => {
  const files = buildAllPageFiles(
    [
      makePage({ id: 'p-home', page_url: 'https://www.bblcpa.com/' }),
      makePage({ id: 'p-deep', page_url: 'https://www.bblcpa.com/what-we-do/tax' }),
      makePage({ id: 'p-rel', page_url: '/who-we-are' }),
    ],
    'Brammer, Begnaud & Lattimore',
    { websiteUrl: 'https://www.bblcpa.com', ctaByUrl: new Map(), jsonLdByUrl: new Map() }
  )
  const names = files.map((f) => f.filename)

  it('maps the origin root to home.md (overwrites the template seed)', () => {
    expect(names).toContain('home.md')
  })
  it('slugifies a full-URL page into a clean -- path, not the origin', () => {
    expect(names).toContain('what-we-do--tax.md')
    expect(names.some((n) => n.startsWith('https:'))).toBe(false)
  })
  it('leaves already-clean paths correct', () => {
    expect(names).toContain('who-we-are.md')
  })
  it('writes the normalized root-relative url into frontmatter', () => {
    const deep = files.find((f) => f.filename === 'what-we-do--tax.md')!
    expect(JSON.parse(frontmatterField(deep.content, 'url'))).toBe('/what-we-do/tax')
  })

  it('fails loud on a mangled pseudo-path URL instead of shipping a build-breaking filename', () => {
    // The AI proposer once turned https://host/who-we-are/amy into this form; the
    // template splits filenames on "--", so the empty/scheme segments produced a
    // degenerate route that broke `next build`. Assembly must throw, not emit it.
    expect(() =>
      buildAllPageFiles(
        [makePage({ id: 'p-bad', page_url: '/https-//www-slachtacpa-com/who-we-are/amy-slachta' })],
        'Slachta',
        { websiteUrl: 'https://www.slachtacpa.com', ctaByUrl: new Map(), jsonLdByUrl: new Map() }
      )
    ).toThrow(/Malformed page URL/)
  })
})

describe('buildPageMarkdown — colon-safe scalar frontmatter (Issue #3)', () => {
  const md = buildPageMarkdown(
    makePage({
      meta_description:
        'A guide to 1099s from BBL CPAs in Port Arthur, TX: forms, deadlines, penalties, and common filing mistakes explained.',
      meta_title: 'Outsourced Accounting: What You Get',
      page_title: 'Services: Overview',
    }),
    'Brammer, Begnaud & Lattimore',
    { websiteUrl: 'https://www.bblcpa.com' }
  )

  it('quotes meta_description so the embedded colon does not break YAML', () => {
    expect(JSON.parse(frontmatterField(md, 'meta_description'))).toBe(
      'A guide to 1099s from BBL CPAs in Port Arthur, TX: forms, deadlines, penalties, and common filing mistakes explained.'
    )
  })
  it('quotes meta_title with a colon', () => {
    expect(JSON.parse(frontmatterField(md, 'meta_title'))).toBe('Outsourced Accounting: What You Get')
  })
  it('quotes the title (colon in page title + pipe join stay safe)', () => {
    expect(JSON.parse(frontmatterField(md, 'title'))).toBe(
      'Services: Overview | Brammer, Begnaud & Lattimore'
    )
  })
})

describe('internalizeHref — firm-host links become origin-relative', () => {
  const host = 'bblcpa.com'
  it('strips the firm origin (www) to a root-relative path', () => {
    expect(internalizeHref('https://www.bblcpa.com/what-we-do/tax', host)).toBe('/what-we-do/tax')
  })
  it('treats apex and www as the same internal host', () => {
    expect(internalizeHref('https://bblcpa.com/contact', host)).toBe('/contact')
  })
  it('preserves query + hash on internal links', () => {
    expect(internalizeHref('https://www.bblcpa.com/team?x=1#bio', host)).toBe('/team?x=1#bio')
  })
  it('leaves genuinely external URLs absolute', () => {
    expect(internalizeHref('https://www.facebook.com/bbl', host)).toBe('https://www.facebook.com/bbl')
  })
  it('leaves already-relative, fragment, mailto, and tel hrefs untouched', () => {
    expect(internalizeHref('/services', host)).toBe('/services')
    expect(internalizeHref('#top', host)).toBe('#top')
    expect(internalizeHref('mailto:hi@bblcpa.com', host)).toBe('mailto:hi@bblcpa.com')
    expect(internalizeHref('tel:+15550100', host)).toBe('tel:+15550100')
  })
})

describe('buildPageMarkdown — internal links are relativized, SEO stays absolute (relative-links-fix)', () => {
  const md = buildPageMarkdown(
    makePage({
      canonical_url: 'https://www.bblcpa.com/services',
      content_markdown:
        '## Overview\n\nSee our [tax services](https://www.bblcpa.com/what-we-do/tax) and follow us on [Facebook](https://www.facebook.com/bbl).',
      internal_links: [
        { url: 'https://www.bblcpa.com/who-we-are', anchor_text: 'our team', reason: 'about' },
      ],
    }),
    'BBL',
    {
      websiteUrl: 'https://www.bblcpa.com',
      cta: { text: 'Get started', url: 'https://www.bblcpa.com/contact' },
    }
  )

  it('relativizes internal_links frontmatter to the firm host', () => {
    expect(JSON.parse(frontmatterField(md, 'internal_links'))).toEqual([
      { url: '/who-we-are', anchor_text: 'our team', reason: 'about' },
    ])
  })
  it('relativizes the CTA url', () => {
    expect(JSON.parse(frontmatterField(md, 'cta_url'))).toBe('/contact')
  })
  it('relativizes internal body-prose links', () => {
    expect(md).toContain('[tax services](/what-we-do/tax)')
  })
  it('leaves external body-prose links absolute', () => {
    expect(md).toContain('[Facebook](https://www.facebook.com/bbl)')
  })
  it('keeps canonical_url absolute → production (SEO invariant)', () => {
    expect(JSON.parse(frontmatterField(md, 'canonical_url'))).toBe('https://www.bblcpa.com/services')
  })
})

describe('buildPageMarkdown — hero headline', () => {
  it('promotes the first content heading into hero_headline for image heroes', () => {
    const out = buildPageMarkdown(
      makePage({
        hero_block: 'hero',
        hero_variant: 'image',
        content_markdown: '<!-- block: intro-text | variant: centered -->\n## Year-Round Advisory, Not Just April Deadlines\n\nBody.',
      }),
      'Firm',
      { websiteUrl: 'https://x.com' }
    )
    expect(JSON.parse(frontmatterField(out, 'hero_headline'))).toBe(
      'Year-Round Advisory, Not Just April Deadlines'
    )
  })

  it('does not emit hero_headline for page-header heroes (page title is correct there)', () => {
    const out = buildPageMarkdown(makePage({ hero_block: 'page-header' }), 'Firm', {
      websiteUrl: 'https://x.com',
    })
    expect(out).not.toMatch(/^hero_headline:/m)
  })
})

describe('appendFaqBlock heading', () => {
  const faq = [{ question: 'How is pricing set?', answer: 'A fixed monthly fee.' }]
  it('uses the stored industry heading', () => {
    const md = appendFaqBlock(makePage({ faq_block: faq, faq_heading: 'Common questions from contractors' }))
    expect(md).toContain('## Common questions from contractors')
  })
  it('falls back to the default heading', () => {
    const md = appendFaqBlock(makePage({ faq_block: faq, page_title: 'Payroll' }))
    expect(md).toContain('## Frequently Asked Questions About Payroll')
  })
})
