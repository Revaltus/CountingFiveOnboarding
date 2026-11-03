import { describe, expect, it } from 'vitest'
import { markdownToPlainText, buildPlainText, buildPlainDocx } from './plain-content-builder'
import type { Database } from '@/types/database'

type GeneratedPage = Database['public']['Tables']['generated_pages']['Row']

function makePage(overrides: Partial<GeneratedPage>): GeneratedPage {
  return {
    admin_approved_content: true,
    answer_block: null,
    canonical_url: null,
    client_approved_content: false,
    content_job_id: 'job-1',
    content_markdown: '## Overview\n\nBody.',
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

describe('markdownToPlainText', () => {
  it('strips heading, emphasis, code, and link syntax', () => {
    const out = markdownToPlainText(
      '## Heading\n\nSome **bold** and *italic* and `code` and a [link](https://x.com).'
    )
    expect(out).toContain('Heading')
    expect(out).toContain('Some bold and italic and code and a link.')
    expect(out).not.toMatch(/[#*`]|\]\(/)
  })

  it('normalizes bullets and drops decorative rules', () => {
    const out = markdownToPlainText('- one\n* two\n\n---\n\nAfter')
    expect(out).toContain('- one')
    expect(out).toContain('- two')
    expect(out).not.toContain('---')
  })

  it('strips a leading frontmatter block and fenced code', () => {
    const out = markdownToPlainText('---\ntitle: x\n---\nHello\n\n```\nignored code\n```\nBye')
    expect(out).toContain('Hello')
    expect(out).toContain('Bye')
    expect(out).not.toContain('title:')
    expect(out).not.toContain('ignored code')
  })
})

describe('buildPlainText', () => {
  it('includes each completed page title, url, and body in order', () => {
    const out = buildPlainText(
      [
        makePage({ id: 'a', page_title: 'Home', page_url: '/', content_markdown: 'Alpha body.' }),
        makePage({ id: 'b', page_title: 'About', page_url: '/about', content_markdown: 'Beta body.' }),
      ],
      'Acme'
    )
    expect(out.indexOf('Home')).toBeLessThan(out.indexOf('About'))
    expect(out).toContain('/about')
    expect(out).toContain('Alpha body.')
    expect(out).toContain('Beta body.')
    expect(out).toContain('Acme')
  })

  it('excludes incomplete and error pages', () => {
    const out = buildPlainText(
      [
        makePage({ id: 'ok', page_title: 'Good', content_markdown: 'Keep me.' }),
        makePage({ id: 'err', page_title: 'Bad', generation_status: 'error', content_markdown: 'Drop me.' }),
        makePage({ id: 'empty', page_title: 'Empty', content_markdown: null }),
      ],
      'Acme'
    )
    expect(out).toContain('Keep me.')
    expect(out).not.toContain('Drop me.')
    expect(out).not.toContain('Empty')
  })

  it('carries no markdown markers through to the output', () => {
    const out = buildPlainText(
      [makePage({ content_markdown: '# Title\n\n**bold** [a](b)' })],
      'Acme'
    )
    expect(out).not.toMatch(/\*\*|\]\(/)
  })
})

describe('buildPlainDocx', () => {
  it('returns a non-empty Buffer', async () => {
    const buf = await buildPlainDocx([makePage({})], 'Acme')
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(0)
  })
})
