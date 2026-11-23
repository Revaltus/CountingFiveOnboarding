import { NextResponse } from 'next/server'
import { resolveSite, verifyBearer } from '@/lib/wordpress/sites'
import { resolveOrigin } from '@/lib/wordpress/origin'
import { buildFeed, pluginSupportsInlineImages } from '@/lib/wordpress/feed-builder'

// GitHub reads require the Node.js runtime; a site with many posts takes dozens
// of reads, so allow more than the 60s default.
export const runtime = 'nodejs'
export const maxDuration = 120

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site: siteKey } = await params
  const site = await resolveSite(siteKey)
  // 404 for unknown AND disabled sites — don't reveal which.
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!verifyBearer(req.headers.get('authorization'), site)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { posts, categories } = await buildFeed(site.github_repo, {
      siteKey: site.key,
      origin: resolveOrigin(req),
      inlineImages: pluginSupportsInlineImages(req.headers.get('x-rv-plugin-version')),
    })
    return NextResponse.json(
      {
        site: site.key,
        generated_at: new Date().toISOString(),
        posts,
        ...(categories ? { categories } : {}),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (err) {
    // Log the real cause; return a generic message (this endpoint is called by
    // external WordPress hosts — never echo internal/GitHub error detail).
    console.error('[wp-feed] failed', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
