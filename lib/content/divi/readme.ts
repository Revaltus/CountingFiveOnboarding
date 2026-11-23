// The README.txt shipped inside the export zip — operator import instructions.
// Part of the throwaway Divi/WordPress export bridge (see ./README.md).

export function buildReadme(opts: {
  firmName: string
  filenameBase: string
  pageCount: number
  imageCount: number
  hasLogo: boolean
  logoExpires?: boolean
  navConfigured: boolean
  menuPageCount: number
  notInNavCount: number
  hasSitemapPdf: boolean
  hasSitemapPng: boolean
  fonts: { heading: string; body: string }
  uploadedImageCount?: number
  uploadsPlaced?: number
  missingUploads?: string[]
  uploadsLinked?: boolean
  siteUrl?: string | null
  unportedCss?: string[]
  categoryCount?: number
}): string {
  const uploaded = opts.uploadedImageCount ?? 0
  const placed = opts.uploadsPlaced ?? 0
  const missingUploads = opts.missingUploads ?? []
  const unplaced = Math.max(0, uploaded - placed - missingUploads.length)
  const missingNote = missingUploads.length
    ? `\n${missingUploads.length} image(s) the pages reference are MISSING from the site repo (the live
site shows them broken too); their sections use a stock photo or none. Fix with
"Re-pull images" in the content editor, then re-export:
${missingUploads.map((m) => `  - ${m}`).join('\n')}\n`
    : ''
  const uploadNote = !uploaded
    ? ''
    : opts.uploadsLinked
      ? `\n${placed} uploaded image(s) (banner photos, section and hero photos) are
hot-linked from the live site (${opts.siteUrl}/content-assets/). They only resolve
once the site is published there — publish first, then import, and re-upload them
to the Media Library to make them permanent.${
          unplaced > 0
            ? `\n${unplaced} more uploaded image(s) sit in blocks that export as text (team
photos, logo bars, testimonials) and were not placed — add them by hand.`
            : ''
        }\n`
      : `\n${uploaded} uploaded image(s) could NOT be linked (the site has no deployed address
yet), so those sections fall back to a stock photo or none. Re-export after the
site is deployed, or add them by hand.\n`
  const css = opts.unportedCss ?? []
  const cssNote = css.length
    ? `Design Studio custom CSS was NOT carried over (${css.length} area(s): ${css.join(', ')}).
It targets the client site's own markup — recreate those touches by hand in Divi if
they matter.`
    : 'There is no Design Studio custom CSS to carry over.'
  const sitemapFiles = [
    opts.hasSitemapPdf ? `  ${opts.filenameBase}-sitemap.pdf         site map: summary, schematic, page directory (URLs + SEO)` : '',
    `  ${opts.filenameBase}-sitemap.svg         site map schematic (opens in any browser)`,
    opts.hasSitemapPng ? `  ${opts.filenameBase}-sitemap.png         site map schematic (image)` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const missing = [!opts.hasSitemapPdf && 'PDF', !opts.hasSitemapPng && 'PNG'].filter(Boolean)
  const navNote =
    !opts.navConfigured
      ? `No navigation was configured in the content editor, so "Primary Menu" imports
EMPTY. Build it by hand in Appearance -> Menus (see the site map for every page).`
      : `The Primary Menu is the navigation from the content editor's Pages sidebar —
same items, order and dropdown nesting (${opts.menuPageCount} page(s) in the menu).`
  return `Divi / WordPress import bundle — ${opts.firmName}
${'='.repeat(60)}

This bundle was generated from the client's approved content as a bridge to
get the site live on the shared Divi boilerplate. It contains:

  ${opts.filenameBase}-divi-customizer.json  client styling (colors, fonts, H1-H6, buttons, brand CSS)
  ${opts.filenameBase}.wxr                ${opts.pageCount} page(s) + the primary nav menu
  ${opts.filenameBase}-divi-library.json  branded Header (Client Center) + Footer
${sitemapFiles}
  README.txt                              this file
${missing.length ? `\n(The site map ${missing.join(' and ')} could not be rendered this time — re-export to get ${missing.length > 1 ? 'them' : 'it'}.)\n` : ''}
Site structure:
${navNote}
${opts.notInNavCount} page(s) are "Not in navigation" in the editor: they import as normal
pages but are NOT assigned to any menu. The site map lists them separately.

Images: ${opts.imageCount} stock image(s) are hot-linked to Pexels CDN URLs — no
media upload is performed. They render immediately but live off-site; re-upload
to the Media Library if you want them permanent.
${uploadNote}${missingNote}
Styling: the client's palette ships as six Divi Global Colors ("gcid-c5-*"),
and every page module is linked to them, so changing a Global Color updates the
whole site. Fonts: ${opts.fonts.heading} (headings) / ${opts.fonts.body} (body).
H1-H6 follow the client site's responsive type scale. The Theme / Design Studio
look carries over: radius tokens, density, serif headlines, dark sections, mono
eyebrows, the headline accent, the style presets (cards, buttons, nav, footer,
hero scale, image treatment, section rhythm) and the layout presets (card lists,
centered CTA banners, split FAQ). ${cssNote}

Import steps (start from a FRESH copy of the c5d5 boilerplate):

  0. Styling (do this FIRST):
     Divi -> Theme Customizer -> portability icon (up/down arrows at the top of
     the Customizer sidebar) -> Import -> upload
     ${opts.filenameBase}-divi-customizer.json.
     WARNING: this REPLACES the site's Customizer settings and Additional CSS
     with the boilerplate's plus this client's styling. That is intended on a
     fresh boilerplate copy; don't run it on a site with hand-made Customizer
     changes you want to keep. The client styling sits in a marked
     "Revaltus brand" block at the end of Additional CSS.

  1. Pages + menu:
     WP Admin -> Tools -> Import -> WordPress -> run the importer ->
     upload ${opts.filenameBase}.wxr. (Install the "WordPress Importer" plugin
     if prompted.) Pages import as DRAFTS so you can review before publishing.${
       opts.categoryCount
         ? `\n     Blog categories are included as last published (${opts.categoryCount}); posts arrive via the Revaltus Blog Sync plugin.`
         : ''
     }

  2. Header / Footer:
     Divi -> Divi Library -> Import & Export (portability icon) -> Import ->
     upload ${opts.filenameBase}-divi-library.json. Two layouts appear:
     "${opts.firmName} — Header" and "${opts.firmName} — Footer".
     Then Divi -> Theme Builder -> assign them to the Default Website Template
     (add global Header / Footer, insert the imported layout in each).

  3. Menu location (IMPORTANT — this also drives the header nav):
     Appearance -> Menus -> select "Primary Menu" -> Manage Locations ->
     assign it to the boilerplate's Primary location. The header's menu module
     has no menu hard-coded, so it shows whatever is on the Primary location —
     assign "Primary Menu" there and the header nav + dropdowns light up. (If it
     doesn't, open the Header layout and pick "Primary Menu" in the menu module.)
     Pages import with their parent/child nesting from the site nav, so child
     page URLs become /parent/child (expected for a freshly stood-up site).

  4. Front page:
     Settings -> Reading -> "Your homepage displays" -> A static page ->
     Homepage = the imported "Home" page.

  5. Brand polish (Customizer / Theme Options):
     - Logo:${
       !opts.hasLogo
         ? ' no logo asset was on file — upload one in Appearance -> Customize.'
         : opts.logoExpires
           ? ' a signed logo URL is embedded in the header layout but EXPIRES — re-upload the logo in Appearance -> Customize and swap the header image.'
           : ' the header/footer logos are hot-linked from the live site — re-upload them to the Media Library and swap the images to make them permanent.'
     }
     - Colors: already set (step 0). Adjust a Global Color in any module's
       color picker to restyle the whole site.

Review each page in the Divi Builder before publishing. Blocks without a
dedicated Divi template (stats bars, forms, testimonials, team) render as clean
styled text — restyle those by hand if needed (so the team list and featured
testimonial layout presets don't apply).
`
}
