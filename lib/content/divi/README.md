# Divi / WordPress export bridge (temporary)

A **throwaway stop-gap** that exports a client's generated page content into a
WordPress import bundle for the shared **Divi boilerplate** site
(`c5d5.flywheelsites.com`). It exists only to get sites live faster while the
custom Next.js theme pipeline is still the long-term destination. When the theme
pipeline is the norm, **delete this feature** — see removal below.

## What it produces

A downloadable zip (`<site>-divi-customizer.json` + `<site>.wxr` + `<site>-divi-library.json` + `<site>-sitemap.pdf/.svg/.png` + `README.txt`):

- **Customizer JSON** (import first) — the client's styling as a Divi Theme
  Customizer import: six Global Colors (`gcid-c5-*`), heading/body fonts, H1–H6
  sizes, buttons, and a marked "Revaltus brand" block of Additional CSS (the
  template's fluid type scale, radii, shadows, serif headlines). Divi's import
  REPLACES all Customizer settings + Additional CSS, so the file is the
  boilerplate's full export (`__fixtures__/divi-customizer-base.json`) with only
  the styling keys changed and our CSS appended after the boilerplate's.

- **WXR** — every live `content/pages/*.md` rendered to Divi Builder shortcode
  (`content:encoded`, flagged `_et_pb_use_builder=on`), plus the primary nav menu
  (from the repo `nav.json`). Pages import as drafts.
- **Sitemap** — a PDF (summary, schematic, page directory with WordPress URL,
  parent, menu position and SEO fields) plus the schematic as SVG and PNG, for
  whoever runs the import. The PNG and PDF are fail-soft (omitted, with a README
  note, if they can't render).

### Styling = the client's design system

`style.ts` builds one model from `content/brand.json` + `content/design.json`
using the template's own contrast rules. Templates in `blocks.ts`/`library.ts`
never contain a hex: they carry tokens (`c5('primary')`, `c5('text')`,
`c5('action', 0.35)`, `pad(60)`, `radius('button')`) that `applyDiviStyle()`
resolves and links to Divi Global Colors via `global_colors_info` (the hex stays
in the attribute, so pages render even before the Customizer import). Heading
sizes are left to the brand CSS. Refresh the base fixture by re-exporting the
boilerplate's Customizer settings.

The Theme / Design Studio look carries over:
- `design.json` radius tokens → button/card/image radii.
- Density × the `sectionRhythm` axis → section padding.
- Treatments: serif headlines, dark sections, and mono eyebrows on the hero eyebrow.
- The `*word*` headline accent, toned by the `accentUsage` axis.
- Style axes:
  - `cards`, `buttons` (bold), `heroScale` and `imageTreatment` → Divi-selector rules in the brand CSS
  - `buttons` pill/sharp and `imageTreatment` rounded → the radius tokens
  - `nav` and `footer` → the Library header/footer
- Layout presets + per-section layout variants: `page.ts effectiveLayout`, the
  template's precedence: explicit layout variant > preset > legacy variant, and
  ink bands never take a preset.
- `theme: ink` on any block.
- `logo.size` and `logo.tone`.

Not portable: the Design Studio CSS region in `design-overrides.css` (scoped CSS
and lock pins, which target the template's markup). The README.txt lists those
areas, so the operator knows what to redo. The team-list and featured-testimonials
presets don't apply because those blocks export as prose.

### Images + logos = the live site

Uploaded images are hot-linked from the deployed site's `/content-assets/`, like
the template's `resolveImageSrc`. That covers section `image:`, the hero
`hero_image`, and the brand.json primary/footer logos. The address comes from
`resolvePreviewSiteUrl` (operator override or Vercel address; never the
pre-cutover `site.config` URL). A stock `query:` is only used when a slot has no
upload or the address is unknown. The signed onboarding logo (1h) is the last
fallback.

### Menu = the editor's Pages sidebar

The Primary Menu and page nesting come from `content/nav.json` — the same tree
the content editor's Pages sidebar shows and edits — so the menu has the same
items, order and dropdown nesting. Absolute nav urls on the firm's host resolve
to their page (as in the sidebar). Pages under "Not in navigation" still import
but get no menu item; their WordPress parent follows the URL prefix. Every
page's `menu_order` follows sidebar order. No nav.json ⇒ an empty menu.
- **Divi Library JSON** — per-client branded Header (with Client Center portals)
  and Footer, for import into the Divi Library + assignment in Theme Builder.
- **README.txt** — operator import steps.

Images are **hot-linked** (no Media Library upload): uploads from the live
site, stock photos from the Pexels CDN.

## Source of truth: the live GitHub repo

The export reads the client's **live `draft` branch** (`content/pages/*.md`,
`content/nav.json`, `content/client-center.json`) — the same source as the
editor's "Download doc" — so it always matches what's live, including
post-generation edits. It does **not** read the original `generated_pages` rows.
Blog posts (`content/posts/*`) are excluded (Divi blog template is out of scope),
but `content/categories.json` is exported as WP category terms (term ids from 900,
`_rv_category_id` termmeta); posts arrive via the Revaltus Blog Sync plugin.

## How it maps

Page `.md` block annotations (`<!-- block: … -->`) → Divi shortcode shells lifted
from `raw-docs/Divi Builder Layouts.json`:

| Block | Divi output |
|---|---|
| `page-header` / hero frontmatter | `subPageHeader` / gradient `copyImageBlock` |
| `content-split`, `hero-split` | two-column `copyImageBlock` (+ hotlinked image) |
| `feature-grid`, `service-cards`, `industry-cards`, `content-cards` | `cardGridBlock` (blurb cards; `list` → one per row) |
| `cta-banner` | `ctaBlock` (centered / image-bg) |
| `faq-accordion` + `faq_block` column | `accordionBlock` (split → heading left) |
| `intro-text` | `basicContentBlock` (centred unless `left-aligned`) |
| `pricing-plans` + `content/pricing-plans.json` | `pricingTablesBlock` (native `et_pb_pricing_tables` + shared-features/add-ons prose) |
| everything else | `basicContentBlock` (clean styled text — no content dropped) |

## Files

- `markdown.ts` — minimal markdown → Divi-safe HTML (no external dep)
- `sanitize.ts` — URL scheme allowlist + HTML-attribute escaping (XSS guard)
- `blocks.ts` — section parser + Divi shortcode template shells + renderers
- `images.ts` — Pexels query → hotlink URL resolver (dedup, fail-soft) + repo asset → live-site URL
- `page.ts` — assemble one page's full Divi shortcode (hero + sections + FAQ)
- `from-frontmatter.ts` — live-repo `.md` (frontmatter + body) → `DiviPageInput`
- `wxr.ts` — WordPress WXR (pages + nav menu)
- `library.ts` — per-client Header/Footer Divi Library JSON
- `readme.ts` — the README.txt shipped in the zip
- `style.ts` — client style model, colour/padding tokens, `applyDiviStyle`, brand CSS
- `customizer.ts` + `__fixtures__/divi-customizer-base.json` — Customizer import file
- `sitemap.ts` — sitemap model (menu tree, not-in-nav group, WP permalinks)
- `sitemap-layout.ts` — schematic geometry shared by the SVG and PDF renderers
- `sitemap-svg.ts` / `sitemap-png.ts` / `sitemap-pdf.tsx` — the three renderers
  (PNG via `@resvg/resvg-js` + bundled Open Sans in `assets/`, OFL)
- `index.ts` — `buildDiviExport()` orchestrator (source-neutral) → zip Buffer

Consumed only by:
- `app/api/edit/[id]/export-divi/route.ts` (reads the live repo, sessionId-keyed)
- the "Export to Divi ↓" item in the editor ••• menu
  (`components/editor/EditorTopBar.tsx`)

## Removal (one move)

This feature is fully additive and self-contained — no migrations, no schema
changes, no edits to the existing content pipeline. To remove:

1. `rm -rf lib/content/divi` (and `npm rm @resvg/resvg-js`; drop its
   `serverExternalPackages` / `export-divi` tracing entries in `next.config.ts`)
2. `rm -rf app/api/edit/[id]/export-divi`
3. In `components/editor/EditorTopBar.tsx`, delete the "Export to Divi ↓" anchor
   in `OverflowMenu`.

Then `npx tsc --noEmit` — a clean compile confirms nothing else depended on it.
