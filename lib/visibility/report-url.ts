import { resolvePreviewSiteUrl } from '@/lib/theme-preview/site-url'

export type ReportUrlSource = 'live' | 'preview' | 'website'

export interface ReportUrlInput {
  liveSiteUrl: string | null
  websiteUrl: string | null
  jobId: string | null
  githubRepo: string | null
}

// The run dialog's pre-filled URL: the operator-confirmed live URL, else the
// rebuilt site's staging address, else the URL on file (often the old site).
// The preview resolver's last resort (site.config siteUrl) is skipped: before
// cutover it points at the old site, which website_url already covers.
export async function resolveDefaultReportUrl(input: ReportUrlInput): Promise<{ url: string | null; source: ReportUrlSource }> {
  if (input.liveSiteUrl) return { url: input.liveSiteUrl, source: 'live' }
  if (input.jobId && input.githubRepo) {
    try {
      const preview = await resolvePreviewSiteUrl({ jobId: input.jobId, githubRepo: input.githubRepo })
      if (preview.url && preview.source !== 'config') return { url: preview.url, source: 'preview' }
    } catch (err) {
      console.warn('[visibility] preview URL lookup failed (non-fatal):', err)
    }
  }
  return { url: input.websiteUrl, source: 'website' }
}
