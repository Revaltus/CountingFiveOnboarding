import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { resolveEditContext } from '../_helpers'
import { createServerClient } from '@/lib/supabase/server'
import { DRAFT_BRANCH, FileNotFoundError, ensureDraftBranch, listTree, readFile } from '@/lib/github/repo-files'
import { CATEGORIES_PATH, parseCategoriesFile, type BlogCategory } from '@/lib/content/blog-categories'
import { parseNavJson } from '@/lib/editor/nav-config'
import { parseClientCenterJson } from '@/lib/editor/client-center-config'
import { buildBrandJson } from '@/lib/content/brand-json-builder'
import { buildClientCenterJson } from '@/lib/content/client-center-json-builder'
import { buildDiviExport, type DiviPageInput } from '@/lib/content/divi'
import { normalizePricingPlansConfig } from '@/lib/content/pricing-plans-config'
import { pageInputFromRepoFile } from '@/lib/content/divi/from-frontmatter'
import { parseDesignJsonText } from '@/lib/content/divi/style'
import type { SessionSchema } from '@/types/session-schema'
import type { PaletteData } from '@/types/palette'
import type { BrandJson } from '@/types/brand-json'
import type { NavJson } from '@/types/nav-json'
import type { ClientCenterJson } from '@/types/client-center'
import {
  DESIGN_SYSTEM_REQUIRED_FOR_EXPORT,
  isCompletePalette,
  paletteFromBrandJson,
} from '@/lib/content/brand-gate'
import { hasCapability } from '@/lib/auth/access'
import { resolvePreviewSiteUrl } from '@/lib/theme-preview/site-url'

// archiver (zip) + GitHub reads require the Node.js runtime; a large site takes
// dozens of GitHub reads plus (time-boxed) Pexels lookups, so allow the full
// serverless window rather than the 60s default.
export const runtime = 'nodejs'
export const maxDuration = 300

const NAV_PATH = 'content/nav.json'
const CLIENT_CENTER_PATH = 'content/client-center.json'
const PRICING_PLANS_PATH = 'content/pricing-plans.json'
const BRAND_JSON_PATH = 'content/brand.json'
const DESIGN_JSON_PATH = 'content/design.json'
const OVERRIDES_PATH = 'content/design-overrides.css'
const ASSETS_DIR = 'public/content-assets/'
const READ_CONCURRENCY = 4

function logoFromBrandJson(text: string): BrandJson['logo'] | null {
  try {
    const logo = (JSON.parse(text) as Partial<BrandJson> | null)?.logo
    if (!logo || typeof logo !== 'object' || typeof logo.primary !== 'string') return null
    return {
      primary: logo.primary,
      alt: typeof logo.alt === 'string' ? logo.alt : '',
      ...(typeof logo.footer === 'string' && logo.footer ? { footer: logo.footer } : {}),
      ...(logo.tone === 'light' || logo.tone === 'dark' ? { tone: logo.tone } : {}),
    }
  } catch {
    return null
  }
}

function gmtStamp(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

async function readInBatches(
  repo: string,
  paths: string[]
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = []
  for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
    const batch = paths.slice(i, i + READ_CONCURRENCY)
    const read = await Promise.all(
      batch.map(async (path) => ({ path, content: (await readFile(repo, path, DRAFT_BRANCH)).content }))
    )
    out.push(...read)
  }
  return out
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const ctx = await resolveEditContext(id)
  if (ctx instanceof NextResponse) return ctx
  // A whole-site bundle (brand, nav, Client Center, pricing, design, logo) is a
  // site-wide admin surface, not page content: admins and managers only — never
  // Site Owners (rule 6 lockdown) or proof-only editors.
  if (!(ctx.user.isAdmin || hasCapability(ctx.user, 'manager'))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const supabase = createServerClient()

  const { data: session } = await supabase
    .from('sessions')
    .select('website_url, schema_data')
    .eq('id', ctx.sessionId)
    .single()
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const { data: job } = await supabase
    .from('content_jobs')
    .select('palette')
    .eq('id', ctx.jobId)
    .maybeSingle()
  // The export is "the live site": its palette is the draft's content/brand.json
  // (Theme Studio / Design Studio write it), falling back to the job palette.
  let livePalette: PaletteData | null = null
  let liveLogo: BrandJson['logo'] | null = null
  try {
    const brandText = (await readFile(ctx.githubRepo, BRAND_JSON_PATH, DRAFT_BRANCH)).content
    livePalette = paletteFromBrandJson(brandText)
    liveLogo = logoFromBrandJson(brandText)
  } catch {
    livePalette = null
  }
  const palette: PaletteData | null =
    livePalette ?? (isCompletePalette(job?.palette) ? (job?.palette as PaletteData) : null)
  // No silent house navy/cyan fallback: an export without a locked palette would
  // hand the client a site in Revaltus colours (same gate as packaging).
  if (!palette) {
    return NextResponse.json({ error: DESIGN_SYSTEM_REQUIRED_FOR_EXPORT }, { status: 409 })
  }

  // Logo: signed because session-assets is private. The private-bucket contract
  // (security rule 7) caps signed URLs at 1 hour, so the export README instructs
  // the operator to run the Divi import within the hour or re-export — a long
  // TTL would leak a durable direct link to the client's private asset.
  const { data: logoAsset } = await supabase
    .from('assets')
    .select('storage_path')
    .eq('session_id', ctx.sessionId)
    .eq('asset_category', 'logo')
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  let logoUrl: string | null = null
  if (logoAsset?.storage_path) {
    const { data: signed } = await supabase.storage
      .from('session-assets')
      .createSignedUrl(logoAsset.storage_path, 3600)
    logoUrl = signed?.signedUrl ?? null
  }

  const schema = (session.schema_data ?? {}) as SessionSchema
  // The site's logos (incl. the footer logo + tone) are what Theme Studio wrote
  // to the draft brand.json, not the onboarding-time default.
  const built = buildBrandJson(schema, palette)
  const brand: BrandJson = liveLogo ? { ...built, logo: liveLogo } : built
  const firmName = brand.firm.name || session.website_url

  try {
    await ensureDraftBranch(ctx.githubRepo)
    const tree = await listTree(ctx.githubRepo, DRAFT_BRANCH, 'content/')

    // Pages only — blog posts (content/posts) use the Divi blog template, which
    // is out of scope for this bridge.
    const pagePaths = tree
      .filter((e) => e.type === 'blob' && e.path.startsWith('content/pages/') && e.path.endsWith('.md'))
      .map((e) => e.path)

    if (pagePaths.length === 0) {
      return NextResponse.json({ error: 'No content pages found for this site' }, { status: 404 })
    }

    const files = await readInBatches(ctx.githubRepo, pagePaths)
    const pages: DiviPageInput[] = files.map((f) => pageInputFromRepoFile(f.path, f.content))

    // Blog categories ride along as WP terms. Missing or invalid → none; a read
    // failure must never fail the export.
    let categories: BlogCategory[] = []
    try {
      const catBlob = await readFile(ctx.githubRepo, CATEGORIES_PATH, DRAFT_BRANCH)
      categories = parseCategoriesFile(catBlob.content)?.categories ?? []
    } catch (err) {
      if (!(err instanceof FileNotFoundError)) {
        console.warn('[export-divi] categories read failed; exporting without categories:', err)
      }
    }

    // Nav + Client Center from the live repo, with graceful fallbacks. No (or a
    // malformed) nav.json means the editor sidebar shows every page as "Not in
    // navigation", so the export ships an empty menu rather than inventing one.
    let nav: NavJson = { primary: [] }
    if (tree.some((e) => e.path === NAV_PATH)) {
      try {
        const navBlob = await readFile(ctx.githubRepo, NAV_PATH, DRAFT_BRANCH)
        nav = parseNavJson(navBlob.content) as NavJson
      } catch {
        /* malformed nav — keep the fallback */
      }
    }

    let clientCenter: ClientCenterJson = buildClientCenterJson(schema)
    if (tree.some((e) => e.path === CLIENT_CENTER_PATH)) {
      try {
        const ccBlob = await readFile(ctx.githubRepo, CLIENT_CENTER_PATH, DRAFT_BRANCH)
        clientCenter = parseClientCenterJson(ccBlob.content) as ClientCenterJson
      } catch {
        /* malformed client-center — keep the schema-derived fallback */
      }
    }

    // The /pricing host page carries only the block annotation; the real tiers
    // live in content/pricing-plans.json. Read it so the Divi export renders a
    // pricing-tables layout instead of dropping to plain prose.
    let pricingPlans = null
    if (tree.some((e) => e.path === PRICING_PLANS_PATH)) {
      try {
        const ppBlob = await readFile(ctx.githubRepo, PRICING_PLANS_PATH, DRAFT_BRANCH)
        pricingPlans = normalizePricingPlansConfig(JSON.parse(ppBlob.content))
      } catch {
        /* malformed plans config — omit; the host page falls back to prose */
      }
    }

    // Fonts, roundness, density and treatments; a missing or malformed file
    // falls back to the template defaults rather than failing the export.
    let designText: string | null = null
    if (tree.some((e) => e.path === DESIGN_JSON_PATH)) {
      try {
        designText = (await readFile(ctx.githubRepo, DESIGN_JSON_PATH, DRAFT_BRANCH)).content
      } catch {
        designText = null
      }
    }

    let overridesCss: string | null = null
    if (tree.some((e) => e.path === OVERRIDES_PATH)) {
      try {
        overridesCss = (await readFile(ctx.githubRepo, OVERRIDES_PATH, DRAFT_BRANCH)).content
      } catch {
        overridesCss = null
      }
    }

    // Which uploaded files exist, so a reference to a missing one falls back to
    // its stock query instead of hot-linking a 404.
    let knownAssets: Set<string> | null = null
    try {
      const assetTree = await listTree(ctx.githubRepo, DRAFT_BRANCH, ASSETS_DIR)
      knownAssets = new Set(assetTree.filter((e) => e.type === 'blob').map((e) => e.path.slice(ASSETS_DIR.length)))
    } catch {
      knownAssets = null
    }

    // Uploaded images and logos hot-link from the deployed Revaltus site. Only
    // a Vercel / operator-set address counts: the 'config' fallback is the
    // client's OLD site before DNS cutover, which doesn't have these files.
    let siteUrl: string | null = null
    try {
      const resolved = await resolvePreviewSiteUrl({ jobId: ctx.jobId, githubRepo: ctx.githubRepo })
      siteUrl = resolved.source === 'config' ? null : resolved.url
    } catch (err) {
      console.warn('[export-divi] site address lookup failed; uploaded images fall back to stock:', err)
    }

    const { zip, filenameBase } = await buildDiviExport({
      firmName,
      websiteUrl: session.website_url,
      pages,
      brand,
      design: parseDesignJsonText(designText),
      clientCenter,
      nav,
      logoUrl,
      siteUrl,
      knownAssets,
      overridesCss,
      pexelsApiKey: process.env.PEXELS_API_KEY ?? '',
      pricingPlans,
      categories,
      dateGmt: gmtStamp(new Date()),
    })

    return new Response(new Uint8Array(zip), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filenameBase}-divi-export.zip"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return internalError('edit:export-divi', err, 'Divi export failed')
  }
}
