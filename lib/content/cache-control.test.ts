import { describe, it, expect } from 'vitest'
import { buildCachedMessages, buildCachedPartsMessages, extractCacheUsage } from './cache-control'
import { chatProviderOptions, FAST_CHAT_PROVIDER_OPTIONS } from './generation-tuning'

type TextPart = { type: 'text'; text: string; providerOptions?: { anthropic?: { cacheControl?: unknown } } }

function parts(ttl?: '5m' | '1h'): TextPart[] {
  const [msg] = buildCachedMessages('STATIC', 'DYNAMIC', ttl)
  return msg.content as TextPart[]
}

describe('buildCachedMessages', () => {
  it('marks only the static prefix with a 5m breakpoint by default', () => {
    const [prefix, suffix] = parts()
    expect(prefix.text).toBe('STATIC')
    expect(prefix.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' })
    expect(suffix.text).toBe('DYNAMIC')
    expect(suffix.providerOptions).toBeUndefined()
  })

  it('uses a 1h TTL when asked', () => {
    expect(parts('1h')[0].providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
  })
})

describe('chat provider options', () => {
  it('turns on automatic caching alongside effort for Sonnet chats', () => {
    expect(chatProviderOptions('low').anthropic).toMatchObject({
      effort: 'low',
      cacheControl: { type: 'ephemeral' },
    })
  })

  it('gives the fast branch caching with thinking off and no effort', () => {
    expect(FAST_CHAT_PROVIDER_OPTIONS.anthropic).toEqual({
      thinking: { type: 'disabled' },
      cacheControl: { type: 'ephemeral' },
    })
  })
})

describe('buildCachedPartsMessages', () => {
  const img = new Uint8Array([1, 2, 3])
  type Part = { type: string; text?: string; image?: unknown; mediaType?: string; providerOptions?: { anthropic?: { cacheControl?: unknown } } }
  const partsOf = (m: ReturnType<typeof buildCachedPartsMessages>): Part[] => m[0].content as Part[]

  it('puts the static prefix first behind a breakpoint and keeps parts in order', () => {
    const msgs = buildCachedPartsMessages('STATIC', [
      { type: 'text', text: 'A' },
      { type: 'image', image: img, mediaType: 'image/webp' },
      { type: 'text', text: 'B' },
    ])
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    const p = partsOf(msgs)
    expect(p.map((x) => x.type)).toEqual(['text', 'text', 'image', 'text'])
    expect(p[0]).toMatchObject({ text: 'STATIC', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } })
    expect(p[2]).toEqual({ type: 'image', image: img, mediaType: 'image/webp' })
    expect(p[1].providerOptions).toBeUndefined()
    expect(p[3].providerOptions).toBeUndefined()
  })

  it('adds a second breakpoint on the LAST text part when cacheDynamic is set', () => {
    const p = partsOf(
      buildCachedPartsMessages('S', [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }], { cacheDynamic: true })
    )
    expect(p[1].providerOptions).toBeUndefined()
    expect(p[2].providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' })
  })

  it('never marks an image part, even when it is last', () => {
    const p = partsOf(
      buildCachedPartsMessages('S', [{ type: 'text', text: 'A' }, { type: 'image', image: img, mediaType: 'image/png' }], {
        cacheDynamic: true,
      })
    )
    expect(p[1].providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' })
    expect(p[2].providerOptions).toBeUndefined()
  })

  it('uses the 1h TTL on every breakpoint when asked', () => {
    const p = partsOf(buildCachedPartsMessages('S', [{ type: 'text', text: 'A' }], { ttl: '1h', cacheDynamic: true }))
    expect(p[0].providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(p[1].providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('breakAt adds a breakpoint on that suffix part — an image too — alongside the dynamic one', () => {
    const img = { type: 'image' as const, image: new Uint8Array([1]), mediaType: 'image/webp' }
    const msgs = buildCachedPartsMessages('STATIC', [{ type: 'text', text: 'A' }, img, { type: 'text', text: 'B' }], {
      cacheDynamic: true,
      breakAt: 1,
    })
    const p = msgs[0].content as Part[]
    expect(p[1].providerOptions).toBeUndefined()
    expect(p[2].providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' })
    expect(p[3].providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' })
    expect(p.filter((x) => x.providerOptions).length).toBe(3)
  })

  it('breakAt on the last text part does not add a second marker; out-of-range breakAt is ignored', () => {
    const parts = [{ type: 'text' as const, text: 'A' }, { type: 'text' as const, text: 'B' }]
    const same = buildCachedPartsMessages('S', parts, { cacheDynamic: true, breakAt: 1 })[0].content as Part[]
    expect(same.filter((x) => x.providerOptions).length).toBe(2)
    const out = buildCachedPartsMessages('S', parts, { breakAt: 9 })[0].content as Part[]
    expect(out.filter((x) => x.providerOptions).length).toBe(1)
    const neg = buildCachedPartsMessages('S', parts, { breakAt: -1 })[0].content as Part[]
    expect(neg.filter((x) => x.providerOptions).length).toBe(1)
  })
})

describe('extractCacheUsage', () => {
  it('reads the SDK cache split and defaults to zero', () => {
    expect(
      extractCacheUsage({
        inputTokens: 100,
        inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 },
        outputTokens: 5,
        outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
        totalTokens: 105,
      }),
    ).toEqual({ cacheReadInputTokens: 80, cacheCreationInputTokens: 10 })
    expect(extractCacheUsage(undefined)).toEqual({ cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
  })
})
