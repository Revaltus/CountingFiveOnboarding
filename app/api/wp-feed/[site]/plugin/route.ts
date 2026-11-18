import { NextResponse } from 'next/server'
import { resolveSite, verifyBearer } from '@/lib/wordpress/sites'
import { resolveOrigin } from '@/lib/wordpress/origin'
import { pluginDownloadUrl, readPluginRelease, type PluginInfoResponse } from '@/lib/wordpress/plugin-release'

// Reads the committed plugin files from disk (traced in next.config.ts).
export const runtime = 'nodejs'

// The plugin's update check: latest released version + where to download it.
export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site: siteKey } = await params
  const site = await resolveSite(siteKey)
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!verifyBearer(req.headers.get('authorization'), site)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const release = await readPluginRelease()
    const body: PluginInfoResponse = {
      ...release,
      slug: 'revaltus-blog-sync',
      name: 'Revaltus Blog Sync',
      download_url: pluginDownloadUrl(resolveOrigin(req), site.key),
    }
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[wp-feed/plugin] failed', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
