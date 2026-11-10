import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolvePreviewSiteUrl = vi.hoisted(() => vi.fn())
vi.mock('@/lib/theme-preview/site-url', () => ({ resolvePreviewSiteUrl }))

import { resolveDefaultReportUrl } from './report-url'

const base = { liveSiteUrl: null, websiteUrl: 'https://old.com', jobId: 'j', githubRepo: 'org/repo' }

describe('resolveDefaultReportUrl', () => {
  beforeEach(() => {
    resolvePreviewSiteUrl.mockReset()
  })

  it('prefers the saved live URL without a preview lookup', async () => {
    expect(await resolveDefaultReportUrl({ ...base, liveSiteUrl: 'https://new.com' })).toEqual({ url: 'https://new.com', source: 'live' })
    expect(resolvePreviewSiteUrl).not.toHaveBeenCalled()
  })

  it('uses the staging preview next', async () => {
    resolvePreviewSiteUrl.mockResolvedValue({ url: 'https://x.vercel.app/', source: 'vercel' })
    expect(await resolveDefaultReportUrl(base)).toEqual({ url: 'https://x.vercel.app/', source: 'preview' })
  })

  it('skips the site.config fallback', async () => {
    resolvePreviewSiteUrl.mockResolvedValue({ url: 'https://old.com', source: 'config' })
    expect(await resolveDefaultReportUrl(base)).toEqual({ url: 'https://old.com', source: 'website' })
  })

  it('treats a lookup error as no preview', async () => {
    resolvePreviewSiteUrl.mockImplementation(async () => {
      throw new Error('db')
    })
    expect((await resolveDefaultReportUrl(base)).source).toBe('website')
  })

  it('falls back to the website URL with no repo', async () => {
    expect(await resolveDefaultReportUrl({ ...base, githubRepo: null })).toEqual({ url: 'https://old.com', source: 'website' })
  })
})
