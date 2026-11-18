import { readFile } from 'node:fs/promises'
import { NextResponse } from 'next/server'
import { resolveSite, verifyBearer } from '@/lib/wordpress/sites'
import { PLUGIN_ZIP_PATH } from '@/lib/wordpress/plugin-release'

export const runtime = 'nodejs'

// The update package WordPress installs. Bearer-gated like the feed: the
// plugin adds the header to this one URL via its http_request_args filter.
export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site: siteKey } = await params
  const site = await resolveSite(siteKey)
  if (!site) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!verifyBearer(req.headers.get('authorization'), site)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const zip = await readFile(PLUGIN_ZIP_PATH)
    return new Response(new Uint8Array(zip), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(zip.byteLength),
        'Content-Disposition': 'attachment; filename="revaltus-blog-sync.zip"',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('[wp-feed/plugin/download] failed', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
