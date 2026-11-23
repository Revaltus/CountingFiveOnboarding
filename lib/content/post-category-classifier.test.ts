import { beforeEach, describe, expect, it, vi } from 'vitest'

const generateText = vi.fn()
const recordTokenUsage = vi.fn()
vi.mock('ai', () => ({ generateText: (...a: unknown[]) => generateText(...a) }))
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: (id: string) => ({ id }) }))
vi.mock('./token-usage', () => ({ recordTokenUsage: (...a: unknown[]) => recordTokenUsage(...a) }))

import { classifyPostCategories } from './post-category-classifier'
import { FAST_MODEL, FAST_PROVIDER_OPTIONS } from './generation-tuning'

const categories = [
  { id: 'c-1', name: 'Tax', slug: 'tax', description: 'Tax tips' },
  { id: 'c-2', name: 'Payroll', slug: 'payroll' },
  { id: 'c-3', name: 'News', slug: 'news' },
]
const base = { title: 't', excerpt: 'e', body: 'b', categories, sessionId: 's1' }

beforeEach(() => {
  generateText.mockReset()
  recordTokenUsage.mockReset()
})

describe('classifyPostCategories', () => {
  it('keeps known ids, drops unknown, caps at 2', async () => {
    generateText.mockResolvedValue({ text: '{"ids":["c-1","c-zzz","c-2","c-3"]}', usage: { inputTokens: 10, outputTokens: 5 } })
    expect(await classifyPostCategories(base)).toEqual(['c-1', 'c-2'])
  })

  it('returns [] and warns on non-JSON output', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    generateText.mockResolvedValue({ text: 'sorry', usage: {} })
    expect(await classifyPostCategories(base)).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('returns [] when generateText throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    generateText.mockRejectedValue(new Error('boom'))
    expect(await classifyPostCategories(base)).toEqual([])
    warn.mockRestore()
  })

  it('skips the model call with no categories', async () => {
    expect(await classifyPostCategories({ ...base, categories: [] })).toEqual([])
    expect(generateText).not.toHaveBeenCalled()
  })

  it('uses the fast model/options with a single user prompt (no messages/prefill) and records usage', async () => {
    generateText.mockResolvedValue({ text: '{"ids":["c-3"]}', usage: { inputTokens: 10, outputTokens: 5 } })
    await classifyPostCategories({ ...base, contentJobId: 'j1', createdBy: 'u1' })
    const call = generateText.mock.calls[0][0]
    expect(call.model).toEqual({ id: FAST_MODEL })
    expect(call.providerOptions).toBe(FAST_PROVIDER_OPTIONS)
    expect(typeof call.prompt).toBe('string')
    expect(call.messages).toBeUndefined()
    expect(call.temperature).toBeUndefined()
    expect(recordTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'content', stage: 'categorize', sessionId: 's1', contentJobId: 'j1', createdBy: 'u1', pageUrl: 'post-categories' }),
    )
  })
})

describe('classifyPostCategories deadline', () => {
  it('clips the call timeout to the caller deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    generateText.mockResolvedValue({ text: '{"ids":["c-1"]}', usage: {} })
    await classifyPostCategories({ ...base, deadlineAt: Date.now() + 10_000 })
    const ms = timeout.mock.calls[0][0]
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThanOrEqual(10_000)
    timeout.mockRestore()
  })

  it('uses the full helper cap without a deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    generateText.mockResolvedValue({ text: '{"ids":["c-1"]}', usage: {} })
    await classifyPostCategories(base)
    expect(timeout.mock.calls[0][0]).toBe(30_000)
    timeout.mockRestore()
  })
})
