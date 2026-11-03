import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ generateText: vi.fn() }))

vi.mock('ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('ai')>()), generateText: h.generateText }))
vi.mock('./no-go-phrases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./no-go-phrases')>()),
  loadNoGoPhrases: async () => [],
}))
vi.mock('./token-usage', () => ({ recordTokenUsage: async () => undefined }))
vi.mock('@/lib/supabase/server', () => ({ createServerClient: vi.fn() }))

import { generateAndFinalizePage, type FinalizePageInput } from './content-generator'
import type { SessionSchema } from '@/types/session-schema'

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
const faq = Array.from({ length: 7 }, (_, i) => ({ question: `Q${i}?`, answer: words(50) }))

function page(body: string, extra: Record<string, unknown> = {}) {
  return {
    text: JSON.stringify({
      content: body,
      metadata: { meta_title: 'T', faq_block: faq, hero_block: 'page-header', target_keyword: 'k', ...extra },
    }),
    usage: { inputTokens: 10, outputTokens: 10 },
    finishReason: 'stop',
  }
}

const split = (i: number) =>
  `<!-- block: content-split | variant: image-${i % 2 ? 'left' : 'right'} | image: s${i}.jpg | alt: "a" | query: "q" -->\n## Section ${i}\n\n${words(40)}\n`
const zigzag = [1, 2, 3, 4].map(split).join('\n') + '\n<!-- block: cta-banner | variant: color-bg -->\n## Talk\n\n[Book a dental tax review](/contact)\n'
const lean =
  `<!-- block: intro-text | variant: centered -->\n## We know dental practices\n\n${words(40)}\n\n` +
  `<!-- block: checklist-section | variant: standalone -->\n## Problems\n\n- one\n- two\n- three\n\n` +
  `<!-- block: process-steps | variant: vertical -->\n## How we work\n\n### Call\nShort.\n\n### Close\nShort.\n\n` +
  `<!-- block: cta-banner | variant: color-bg -->\n## Talk\n\n[Book a dental tax review](/contact)\n`

const input: FinalizePageInput = {
  pageTitle: 'Dental',
  pageUrl: '/industries/dental',
  outlineSections: [],
  targetKeyword: 'dental cpa',
  secondaryKeywords: [],
  existingContent: null,
  competitorRefs: [],
  schema: {} as SessionSchema,
  palette: null,
  websiteUrl: 'https://firm.com',
  cta: { text: 'Contact', url: '/contact' },
  contentJobId: 'j',
  sessionId: 's',
  sitemapUrls: ['/contact'],
  deadlineAt: Date.now() + 10 * 60_000,
}

describe('generateAndFinalizePage — page-structure retry', () => {
  beforeEach(() => h.generateText.mockReset())

  it('rewrites a zigzag page once with the structure problems named', async () => {
    h.generateText.mockResolvedValueOnce(page(zigzag)).mockResolvedValueOnce(page(lean))
    const result = await generateAndFinalizePage(input)
    expect(h.generateText).toHaveBeenCalledTimes(2)
    const retryPrompt = JSON.stringify(h.generateText.mock.calls[1][0].messages)
    expect(retryPrompt).toContain('content-split sections; use at most 2')
    expect(result.content).toContain('We know dental practices')
  })

  it('keeps the first draft when the retry times out', async () => {
    h.generateText.mockResolvedValueOnce(page(zigzag)).mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
    const result = await generateAndFinalizePage(input)
    expect(result.degraded).toBeFalsy()
    expect(result.content).toContain('Section 1')
  })

  it('does not rewrite a page whose only problem is soft', async () => {
    const oneList = lean.replace(/<!-- block: process-steps[\s\S]*?(?=<!-- block: cta-banner)/, '')
    h.generateText.mockResolvedValueOnce(page(oneList))
    await generateAndFinalizePage(input)
    expect(h.generateText).toHaveBeenCalledTimes(1)
  })
})

describe('generateAndFinalizePage — FAQ heading', () => {
  beforeEach(() => h.generateText.mockReset())

  it('keeps the Prime-style heading on industry pages', async () => {
    h.generateText.mockResolvedValueOnce(page(lean, { faq_heading: 'Common questions from dentists' }))
    const result = await generateAndFinalizePage(input)
    expect(result.metadata.faq_heading).toBe('Common questions from dentists')
  })

  it('drops it on service pages (locked shape keeps the default heading)', async () => {
    h.generateText.mockResolvedValueOnce(page(lean, { faq_heading: 'Common questions from dentists' }))
    const result = await generateAndFinalizePage({ ...input, pageUrl: '/services/payroll' })
    expect(result.metadata.faq_heading).toBeNull()
  })
})
