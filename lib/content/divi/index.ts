// ---------------------------------------------------------------------------
// Divi/WordPress export bridge — orchestrator.
//
// Throwaway stop-gap that turns a client's live pages into a WordPress import
// bundle for the shared Divi boilerplate site. See ./README.md for the full
// rationale and a one-move removal guide. Produces a zip containing:
//   - <site>.wxr                 all pages (Divi shortcode) + primary nav menu
//   - <site>-divi-customizer.json  client styling: Global Colors, fonts, H1–H6,
//                                buttons, brand CSS (./customizer.ts)
//   - <site>-divi-library.json   per-client Header (Client Center) + Footer
//   - <site>-sitemap.pdf/.svg/.png  site structure reference for the importer
//   - README.txt                 import + Theme Builder steps
//
// Source-neutral: callers hand it a prepared DiviPageInput[] (the editor route
// maps live repo `.md` files via from-frontmatter.ts). The Primary Menu and page
// nesting come from nav.json — the tree the editor's Pages sidebar shows — and
// pages outside it import with no menu entry (URL-prefix parent only).
// ---------------------------------------------------------------------------

import type { BrandJson } from '@/types/brand-json'
import type { DesignJson } from '@/types/design-json'
import type { ClientCenterJson } from '@/types/client-center'
import type { NavJson } from '@/types/nav-json'
import type { PricingPlansConfig } from '@/types/pricing-plans'
import { toPagePath, siteHost } from '@/lib/content/deliverable-builder'
import { assembleZip } from '@/lib/content/zip-assembler'
import { buildPageDivi, collectPageQueries, type DiviPageInput } from './page'
import { parseDiviSections } from './blocks'
import { repoAssetResolver, resolveImageUrls } from './images'
import { buildWxr, type WxrPage } from './wxr'
import { buildDiviLibrary } from './library'
import { buildReadme } from './readme'
import type { BlogCategory } from '@/lib/content/blog-categories'
import { analyzeNav, levelOf, buildSectionLandingDivi, type NavSection } from './hierarchy'
import { buildSitemapModel, sidebarOrder } from './sitemap'
import { layoutSitemap, sitemapTheme } from './sitemap-layout'
import { renderSitemapSvg } from './sitemap-svg'
import { renderSitemapPng } from './sitemap-png'
import { renderSitemapPdf } from './sitemap-pdf'
import { applyDiviStyle, buildDiviStyle } from './style'
import { buildDiviCustomizer } from './customizer'
import { readRegion } from '@/lib/design/bundle-files'

export type { DiviPageInput } from './page'

export type DiviExportInput = {
  firmName: string
  websiteUrl: string
  pages: DiviPageInput[]
  brand: BrandJson
  // The draft's content/design.json (fonts, roundness, density, treatments).
  design: DesignJson
  clientCenter: ClientCenterJson
  nav: NavJson
  logoUrl: string | null
  // The deployed site's address: uploaded images and the footer logo are
  // hot-linked from its /content-assets/. Null = unknown (stock images only).
  siteUrl?: string | null
  // Filenames under the repo's public/content-assets/ (null = unknown).
  knownAssets?: ReadonlySet<string> | null
  // content/design-overrides.css — only read to report what didn't transfer.
  overridesCss?: string | null
  pexelsApiKey: string
  // Config-driven plans page (content/pricing-plans.json), if the client ships
  // one — the /pricing host page md carries only the annotation, not the tiers.
  pricingPlans?: PricingPlansConfig | null
  // Blog categories (content/categories.json) exported as WP category terms.
  categories?: BlogCategory[]
  dateGmt: string // "YYYY-MM-DD HH:mm:ss" — passed in so the builder stays pure
}

export type DiviExportResult = {
  zip: Buffer
  filenameBase: string
}

function slugFor(path: string): string {
  const last = path.replace(/\/+$/, '').split('/').pop() || ''
  return last || 'home'
}

// The parent page path is the nearest existing ancestor: drop the last URL
// segment and, if a page lives there, that's the parent. e.g. /services/cfo →
// /services (if present), else root.
function parentPathFor(path: string, existing: Set<string>): string | null {
  if (path === '/') return null
  const segments = path.split('/').filter(Boolean)
  for (let i = segments.length - 1; i >= 1; i--) {
    const candidate = '/' + segments.slice(0, i).join('/')
    if (existing.has(candidate)) return candidate
  }
  return null
}

type PageRec = {
  path: string
  title: string
  real?: DiviPageInput
  section?: NavSection
  synthesized?: 'section' | 'home'
}

// Every uploaded image ref the pages carry, and those missing from the repo.
function uploadedImageRefs(pages: DiviPageInput[], known: ReadonlySet<string> | null): { total: number; missing: string[] } {
  const refs = new Set<string>()
  for (const p of pages) {
    if (p.hero_image) refs.add(p.hero_image.trim())
    for (const s of parseDiviSections(p.content_markdown ?? '')) if (s.image) refs.add(s.image.trim())
  }
  const missing = known ? [...refs].filter((r) => !/^https?:\/\//i.test(r) && !r.startsWith('/') && !known.has(r)) : []
  return { total: refs.size, missing: missing.sort() }
}

// Distinct live-site images the pages actually show (uploads inside blocks that
// export as prose — team photos, logo bars — are not placed).
function placedUploads(pages: WxrPage[], origin: string | null): number {
  if (!origin) return 0
  const prefix = `${origin}/content-assets/`
  const urls = new Set<string>()
  for (const p of pages) {
    let i = p.content.indexOf(prefix)
    while (i !== -1) {
      const end = p.content.slice(i).search(/["\s\]]/)
      urls.add(p.content.slice(i, end === -1 ? undefined : i + end))
      i = p.content.indexOf(prefix, i + prefix.length)
    }
  }
  return urls.size
}

// The Design Studio CSS areas (scoped CSS + lock pins) in design-overrides.css:
// they target the client template's markup, so they can't carry over.
export function unportedCssAreas(overridesCss: string | null): string[] {
  if (!overridesCss?.trim()) return []
  const region = readRegion(overridesCss)
  if (!region.ok) return ['design-overrides.css']
  const areas = [
    ...(region.css.global?.trim() ? ['site-wide'] : []),
    ...Object.entries(region.css.blocks).filter(([, css]) => css?.trim()).map(([key]) => key),
    ...(region.css.locks?.trim() ? ['locked areas'] : []),
  ]
  return areas
}

export async function buildDiviExport(input: DiviExportInput): Promise<DiviExportResult> {
  const style = buildDiviStyle(input.brand, input.design)

  // nav.json is the authoritative structure: parent/child + which section pages
  // must be synthesized, plus a nav with URLs rewritten to real page paths.
  const realByPath = new Map<string, DiviPageInput>()
  for (const p of input.pages) realByPath.set(toPagePath(p.page_url), p)

  const { parentByChildPath, sections, resolvedNav } = analyzeNav(input.nav, {
    pagePaths: new Set(realByPath.keys()),
    siteHost: siteHost(input.websiteUrl),
  })

  // A dropdown parent with no page of its own gets a synthesized landing page so
  // its children have something to nest under and the section is navigable.
  const recs: PageRec[] = input.pages.map((p) => ({
    path: toPagePath(p.page_url),
    title: p.page_title,
    real: p,
  }))
  for (const s of sections) {
    if (!realByPath.has(s.path)) recs.push({ path: s.path, title: s.title, section: s, synthesized: 'section' })
  }

  // Dedup by path (first wins — real pages are added first).
  const seen = new Set<string>()
  const uniqueRecs = recs.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)))

  // Guarantee a home page exists. If the site has no page at '/', synthesize a
  // simple landing page linking the top-level nav so there's always a front page
  // to set under Settings → Reading.
  if (!uniqueRecs.some((r) => r.path === '/')) {
    uniqueRecs.push({
      path: '/',
      title: 'Home',
      synthesized: 'home',
      section: {
        path: '/',
        title: input.firmName || 'Home',
        children: resolvedNav.primary.map((i) => ({ title: i.label, path: toPagePath(i.url) })),
      },
    })
  }

  // Order home → shallow → deep so every parent precedes its children (WP
  // importer needs it).
  uniqueRecs.sort((a, b) => {
    if (a.path === '/') return -1
    if (b.path === '/') return 1
    const la = levelOf(a.path, parentByChildPath)
    const lb = levelOf(b.path, parentByChildPath)
    return la !== lb ? la - lb : a.path.localeCompare(b.path)
  })

  // Stable post IDs so nav menu items and page parents can reference them.
  const pageIdByPath = new Map<string, number>()
  uniqueRecs.forEach((r, i) => pageIdByPath.set(r.path, 100 + i))
  const allPaths = new Set(pageIdByPath.keys())

  const parentPathOf = (path: string): string | null => {
    const navParent = parentByChildPath.get(path)
    if (navParent && pageIdByPath.has(navParent)) return navParent
    return parentPathFor(path, allPaths) // fallback: URL-prefix nesting
  }
  const parentIdFor = (path: string): number => {
    const parent = parentPathOf(path)
    return (parent && pageIdByPath.get(parent)) || 0
  }

  // One model of the imported structure feeds both menu_order and the sitemap docs.
  const sitemap = buildSitemapModel({
    firmName: input.firmName || siteHost(input.websiteUrl),
    generatedAt: input.dateGmt.slice(0, 10),
    pages: uniqueRecs.map((r) => ({
      path: r.path,
      title: r.path === '/' ? 'Home' : r.title,
      synthesized: r.synthesized ?? null,
      parentPath: parentPathOf(r.path),
      seo: r.real?.seo,
    })),
    nav: resolvedNav,
  })
  const menuOrderByPath = new Map(sidebarOrder(sitemap).map((p, i) => [p, i]))

  // Uploaded images come from the live site; resolve every remaining stock
  // query once, deduped across the real pages.
  const assets = repoAssetResolver(input.siteUrl ?? null, input.knownAssets ?? null)
  const uploadsResolve = assets.linked
  const allQueries = uniqueRecs.filter((r) => r.real).flatMap((r) => collectPageQueries(r.real!, assets.url))
  const imageUrls = await resolveImageUrls(allQueries, input.pexelsApiKey)
  const renderOpts = { layout: style.layout, assetUrl: assets.url }
  // brand.json's logo on the live site is the one the site shows and never
  // expires; the signed onboarding copy (1h) is the fallback.
  const siteLogo = input.brand.logo?.primary ? assets.url(input.brand.logo.primary) : null
  const logoUrl = siteLogo ?? input.logoUrl

  const wxrPages: WxrPage[] = uniqueRecs.map((r) => ({
    // Always name the front page "Home" so it's unmistakable in the Pages list
    // and easy to set under Settings → Reading (its real title is often the firm
    // name, which reads as a normal page and gets missed).
    title: r.path === '/' ? 'Home' : r.title,
    path: r.path,
    slug: slugFor(r.path),
    postId: pageIdByPath.get(r.path)!,
    parentId: parentIdFor(r.path),
    menuOrder: menuOrderByPath.get(r.path) ?? 0,
    content: applyDiviStyle(
      r.real
        ? buildPageDivi(r.real, imageUrls, input.websiteUrl, input.pricingPlans ?? null, renderOpts)
        : buildSectionLandingDivi(r.section!),
      style
    ),
  }))

  const wxr = buildWxr({
    siteTitle: input.firmName || siteHost(input.websiteUrl),
    siteUrl: input.websiteUrl,
    pages: wxrPages,
    nav: resolvedNav,
    dateGmt: input.dateGmt,
    categories: input.categories,
  })

  const library = buildDiviLibrary({
    brand: input.brand,
    clientCenter: input.clientCenter,
    nav: resolvedNav,
    logoUrl,
    footerLogoUrl: input.brand.logo?.footer ? assets.url(input.brand.logo.footer) : null,
    style,
    dateGmt: input.dateGmt,
  })
  const customizer = buildDiviCustomizer(style)

  const filenameBase =
    (siteHost(input.websiteUrl) || 'client').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')

  // Sitemap reference. The SVG is a pure string; the PNG and PDF are fail-soft
  // so a renderer problem never blocks the import bundle itself.
  const theme = sitemapTheme(input.brand.palette)
  const layout = layoutSitemap(sitemap)
  const sitemapSvg = renderSitemapSvg(layout, theme)
  const [sitemapPng, sitemapPdf] = await Promise.all([
    renderSitemapPng(sitemapSvg, layout.width),
    renderSitemapPdf(sitemap, layout, theme, style).catch((err: unknown) => {
      console.warn('[divi-export] sitemap PDF render skipped:', err instanceof Error ? err.message : err)
      return null
    }),
  ])

  const uploadRefs = uploadedImageRefs(uniqueRecs.flatMap((r) => (r.real ? [r.real] : [])), input.knownAssets ?? null)
  const readme = buildReadme({
    firmName: input.firmName,
    filenameBase,
    pageCount: wxrPages.length,
    imageCount: imageUrls.size,
    hasLogo: !!logoUrl,
    logoExpires: !siteLogo && !!input.logoUrl,
    navConfigured: sitemap.navConfigured,
    menuPageCount: sitemap.counts.inMenu,
    notInNavCount: sitemap.counts.notInNav,
    hasSitemapPdf: !!sitemapPdf,
    hasSitemapPng: !!sitemapPng,
    fonts: { heading: style.fonts.heading, body: style.fonts.body },
    uploadedImageCount: uploadRefs.total,
    missingUploads: uploadRefs.missing,
    uploadsPlaced: uploadsResolve ? placedUploads(wxrPages, assets.origin) : 0,
    uploadsLinked: uploadsResolve,
    siteUrl: assets.origin,
    unportedCss: unportedCssAreas(input.overridesCss ?? null),
    categoryCount: input.categories?.length ?? 0,
  })

  const zip = await assembleZip([
    { path: `${filenameBase}.wxr`, content: wxr },
    { path: `${filenameBase}-divi-customizer.json`, content: customizer },
    { path: `${filenameBase}-divi-library.json`, content: library },
    ...(sitemapPdf ? [{ path: `${filenameBase}-sitemap.pdf`, content: sitemapPdf }] : []),
    { path: `${filenameBase}-sitemap.svg`, content: sitemapSvg },
    ...(sitemapPng ? [{ path: `${filenameBase}-sitemap.png`, content: sitemapPng }] : []),
    { path: 'README.txt', content: readme },
  ])

  return { zip, filenameBase }
}
