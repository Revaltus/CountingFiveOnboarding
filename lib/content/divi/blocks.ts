// ---------------------------------------------------------------------------
// Block parsing + Divi shortcode rendering.
//
// Part of the throwaway Divi/WordPress export bridge (see ./README.md). Turns a
// generated page's block-annotated markdown body into Divi Builder shortcode by
// lifting the styled "BP -" boilerplate layout shells from the reference export
// (raw-docs/Divi Builder Layouts.json) and substituting real copy.
//
// Design notes:
//  - Colours, padding and radii are TOKENS (./style.ts c5()/pad()/radius()),
//    resolved to the client's palette + linked to Divi Global Colors by
//    applyDiviStyle(). Never write a hex here. Heading sizes are left to the
//    site-wide brand CSS (the template's fluid type scale), so no module sets a
//    heading font size or weight.
//  - Every block family that lacks a dedicated template falls back to a plain
//    styled text block (basicContentBlock) so no content is ever dropped.
//  - Card icons and testimonial author/quote parsing are intentionally omitted
//    from v1 (an open item in the design doc) — wrong icons read worse than
//    none. Cards render as clean title + body blurbs.
// ---------------------------------------------------------------------------

import { markdownToHtml, inlineMarkdown } from './markdown'
import { escapeShortcodeBrackets, safeUrl } from './sanitize'
import { templateSectionPattern } from '@/lib/editor/block-annotation'
import type { PricingPlansConfig } from '@/types/pricing-plans'
import { c5, pad, radius, HEADING_FONT } from './style'

const BV = '4.27.4' // Divi _builder_version stamped on emitted modules

// Divi encodes a literal double-quote inside a shortcode attribute as %22.
function attr(value: string): string {
  return escapeShortcodeBrackets((value ?? '').replace(/"/g, '%22').replace(/\r?\n/g, ' ').trim())
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type DiviSection = {
  blockId: string
  variant?: string
  image?: string
  alt?: string
  query?: string
  theme?: string
  heading: string
  content: string
}

// Exactly the sections the site template renders (its SECTION_PATTERN, via the
// block-annotation codec) — incl. a trailing `theme:`, so ink bands export.
export function parseDiviSections(body: string): DiviSection[] {
  const out: DiviSection[] = []
  for (const m of (body ?? '').matchAll(templateSectionPattern())) {
    out.push({
      blockId: m[1],
      variant: m[2] || undefined,
      image: m[3] || undefined,
      alt: m[4] || undefined,
      query: m[5] || undefined,
      theme: m[6] || undefined,
      heading: m[7].trim(),
      content: m[8] ?? '',
    })
  }
  return out
}

export type Card = { title: string; bodyHtml: string }

// Split a card-grid section body into `### Title` (or `**Title**`) items. Lines
// like `icon:`/`photo:` are dropped by markdownToHtml. Returns [] when the body
// isn't card-shaped, letting the renderer fall back to prose.
export function parseCards(content: string): Card[] {
  const parts = content.split(/\n(?=###\s+)/)
  const cards: Card[] = []
  for (const part of parts) {
    const m = part.match(/^###\s+(.+?)\n([\s\S]*)$/)
    if (!m) continue
    cards.push({ title: m[1].trim(), bodyHtml: markdownToHtml(m[2]) })
  }
  return cards
}

export type QA = { question: string; answer: string }

// Extract **Q: …** / A: … pairs from an inline faq-accordion section body.
export function parseQA(content: string): QA[] {
  const out: QA[] = []
  const re = /\*\*Q:\s*(.+?)\*\*\s*\n\s*A:\s*([\s\S]*?)(?=\n\s*\*\*Q:|\s*$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    out.push({ question: m[1].trim(), answer: m[2].trim() })
  }
  return out
}

// ---------------------------------------------------------------------------
// Shortcode template shells (lifted from the reference boilerplate export)
// ---------------------------------------------------------------------------

// `band: 'ink'` = the template's dark band (theme: ink); `align` = the text
// orientation (intro-text is centred by default).
export function basicContentBlock(html: string, opts: { band?: 'light' | 'ink'; align?: 'left' | 'center' } = {}): string {
  const ink = opts.band === 'ink'
  const bg = ink ? ` background_color="${c5('band')}"` : ''
  const orient = opts.align === 'center' ? ' text_orientation="center"' : ''
  const textColors = ink
    ? `background_layout="dark" text_text_color="${c5('onBand')}" header_2_text_color="${c5('onBand')}" header_3_text_color="${c5('onBand')}"`
    : `text_text_color="${c5('text')}" header_2_text_color="${c5('heading')}" header_3_text_color="${c5('heading')}"`
  return (
    `[et_pb_section fb_built="1" _builder_version="${BV}" _module_preset="default"${bg} custom_padding="${pad(50)}||${pad(60)}|||" global_colors_info="{}" template_type="section"]` +
    `[et_pb_row _builder_version="${BV}" _module_preset="default" width="100%" max_width="75%" module_alignment="center" global_colors_info="{}"]` +
    `[et_pb_column type="4_4" _builder_version="${BV}" _module_preset="default" global_colors_info="{}"]` +
    `[et_pb_text _builder_version="${BV}"${orient} ${textColors} global_colors_info="{}"]` +
    `${html}` +
    `[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]`
  )
}

export function subPageHeader(title: string, subhead?: string): string {
  const sub = subhead
    ? `\n<p style="color:${c5('onPrimary')};opacity:0.85;font-size:1.125rem;">${inlineMarkdown(subhead)}</p>`
    : ''
  return (
    `[et_pb_section fb_built="1" _builder_version="${BV}" _module_preset="default" background_color="${c5('primarySurface')}" custom_padding="${pad(70)}||${pad(70)}|||" global_colors_info="{}" template_type="section"]` +
    `[et_pb_row _builder_version="${BV}" _module_preset="default" width="100%" max_width="75%" module_alignment="center" global_colors_info="{}"]` +
    `[et_pb_column type="4_4" _builder_version="${BV}" _module_preset="default" global_colors_info="{}"]` +
    `[et_pb_text _builder_version="${BV}" text_orientation="center" background_layout="dark" header_text_color="${c5('onPrimary')}" text_text_color="${c5('onPrimary')}" global_colors_info="{}"]` +
    `<h1 class="c5-page-title">${inlineMarkdown(title)}</h1>${sub}` +
    `[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]`
  )
}

function imageColumn(url: string, alt: string): string {
  return (
    `[et_pb_column type="1_2" _builder_version="${BV}" _module_preset="default" global_colors_info="{}"]` +
    `[et_pb_image src="${attr(url)}" alt="${attr(alt)}" _builder_version="${BV}" _module_preset="default" module_class="c5-frame" border_radii="on|${radius('image')}|${radius('image')}|${radius('image')}|${radius('image')}" box_shadow_style="preset3" box_shadow_color="${c5('primary', 0.15)}" global_colors_info="{}"][/et_pb_image]` +
    `[/et_pb_column]`
  )
}

// content-split (light) and hero/hero-split (gradient) share this two-column
// copy+image shell; `hero` swaps in the gradient background + H1.
export function copyImageBlock(opts: {
  heading: string
  eyebrow?: string
  subhead?: string
  bodyHtml: string
  buttonText?: string
  buttonUrl?: string
  imageUrl?: string
  imageAlt?: string
  side: 'image-right' | 'image-left'
  hero?: boolean
}): string {
  const headingTag = opts.hero ? 'h1' : 'h2'
  const sub = opts.subhead
    ? `\n<h2>${inlineMarkdown(opts.subhead)}</h2>`
    : ''
  const buttonHref = opts.buttonUrl ? safeUrl(opts.buttonUrl) : null
  // Hero buttons invert onto the primary surface; body buttons use the action colour.
  const button =
    opts.buttonText && buttonHref
      ? `[et_pb_button button_url="${attr(buttonHref)}" button_text="${attr(opts.buttonText)}" button_alignment="left" _builder_version="${BV}" _module_preset="default" custom_button="on" button_text_size="16px" button_text_color="${opts.hero ? c5('primary') : c5('onAction')}" button_bg_color="${opts.hero ? c5('onPrimary') : c5('action')}" button_border_width="0px" button_border_radius="${radius('button')}" button_font="${HEADING_FONT(700)}" button_use_icon="off" custom_padding="15px|26px|15px|26px|true|true" global_colors_info="{}"][/et_pb_button]`
      : ''

  const textColor = opts.hero ? c5('onPrimary') : c5('text')
  const headerColor = opts.hero ? c5('onPrimary') : c5('heading')
  // The hero H1 takes the template's display size (.c5-display in the brand CSS).
  const headingOpen = opts.hero ? '<h1 class="c5-display">' : `<${headingTag}>`
  const eyebrow = opts.eyebrow ? `<p class="c5-eyebrow">${inlineMarkdown(opts.eyebrow)}</p>` : ''
  const textColumn =
    `[et_pb_column type="1_2" _builder_version="${BV}" _module_preset="default" global_colors_info="{}"]` +
    `[et_pb_text _builder_version="${BV}" ${opts.hero ? 'background_layout="dark" ' : ''}header_text_color="${headerColor}" header_2_text_color="${opts.hero ? c5('onPrimary') : c5('actionText')}" text_text_color="${textColor}" global_colors_info="{}"]` +
    `${eyebrow}${headingOpen}${inlineMarkdown(opts.heading)}</${headingTag}>${sub}\n${opts.bodyHtml}` +
    `[/et_pb_text]${button}[/et_pb_column]`

  const imgCol = opts.imageUrl ? imageColumn(opts.imageUrl, opts.imageAlt ?? opts.heading) : ''
  const cols = imgCol
    ? opts.side === 'image-left'
      ? imgCol + textColumn
      : textColumn + imgCol
    : textColumn

  const sectionAttrs = opts.hero
    ? `background_color="${c5('primarySurface')}" custom_padding="${pad(90)}|0px|${pad(90)}|0px"`
    : `custom_padding="${pad(50)}|0px|${pad(50)}|0px"`

  return (
    `[et_pb_section fb_built="1" _builder_version="${BV}" _module_preset="default" ${sectionAttrs} global_colors_info="{}" template_type="section"]` +
    `[et_pb_row column_structure="1_2,1_2" _builder_version="${BV}" _module_preset="default" width="100%" max_width="75%" module_alignment="center" make_equal="on" global_colors_info="{}"]` +
    `${cols}` +
    `[/et_pb_row][/et_pb_section]`
  )
}

function cardColumn(card: Card, colType: string): string {
  return (
    `[et_pb_column type="${colType}" _builder_version="${BV}" _module_preset="default" background_color="${c5('nearWhite')}" custom_padding="24px|24px|24px|24px|true|false" border_radii="on|${radius('card')}|${radius('card')}|${radius('card')}|${radius('card')}" box_shadow_style="preset3" box_shadow_color="${c5('primary', 0.12)}" module_class="c5-card" global_colors_info="{}"]` +
    `[et_pb_text _builder_version="${BV}" _module_preset="default" header_3_text_color="${c5('heading')}" text_text_color="${c5('text')}" global_colors_info="{}"]` +
    `<h3>${inlineMarkdown(card.title)}</h3>\n${card.bodyHtml}` +
    `[/et_pb_text][/et_pb_column]`
  )
}

const COL_TYPES: Record<number, string> = { 1: '4_4', 2: '1_2', 3: '1_3', 4: '1_4' }

// `band: 'ink'` renders the section on the template's dark band (theme: ink):
// the primary surface, or the deep ink surface when design.json darkSections is
// on — the `band` role resolves that per client. Cards stay light.
export function cardGridBlock(heading: string, cards: Card[], cols: number, band: 'light' | 'ink' = 'light'): string {
  const perRow = Math.min(Math.max(cols, 1), 4)
  const rows: string[] = []
  const bandBg = band === 'ink' ? c5('band') : c5('surfaceMuted')
  const headingColor = band === 'ink' ? c5('onBand') : c5('heading')
  const headingText = heading
    ? `[et_pb_row _builder_version="${BV}" _module_preset="default" width="100%" max_width="75%" module_alignment="center" global_colors_info="{}"]` +
      `[et_pb_column type="4_4" _builder_version="${BV}" _module_preset="default" global_colors_info="{}"]` +
      `[et_pb_text _builder_version="${BV}" text_orientation="center" ${band === 'ink' ? 'background_layout="dark" ' : ''}header_2_text_color="${headingColor}" global_colors_info="{}"]<h2>${inlineMarkdown(heading)}</h2>[/et_pb_text]` +
      `[/et_pb_column][/et_pb_row]`
    : ''

  for (let i = 0; i < cards.length; i += perRow) {
    const chunk = cards.slice(i, i + perRow)
    const colType = COL_TYPES[chunk.length] ?? '1_3'
    const structure = chunk.map(() => colType).join(',')
    rows.push(
      `[et_pb_row column_structure="${structure}" use_custom_gutter="on" gutter_width="2" make_equal="on" _builder_version="${BV}" _module_preset="default" width="100%" max_width="75%" module_alignment="center" global_colors_info="{}"]` +
        chunk.map((c) => cardColumn(c, colType)).join('') +
        `[/et_pb_row]`
    )
  }

  return (
    `[et_pb_section fb_built="1" _builder_version="${BV}" _module_preset="default" background_color="${bandBg}" custom_padding="${pad(50)}||${pad(60)}|||" global_colors_info="{}" template_type="section"]` +
    `${headingText}${rows.join('')}` +
    `[/et_pb_section]`
  )
}

// cta-banner. `centered` = the template's centred layout (variant
// *-centered or the ctaBanner preset); `bgImageUrl` = its image-bg variant,
// multiplied onto the primary surface like the template's scrim.
export function ctaBlock(opts: {
  heading: string
  bodyHtml: string
  buttonText: string
  buttonUrl: string
  centered?: boolean
  bgImageUrl?: string
}): string {
  const bgImage = opts.bgImageUrl
    ? ` background_image="${attr(opts.bgImageUrl)}" background_size="cover" background_position="center" background_blend="multiply"`
    : ''
  const text =
    `[et_pb_text _builder_version="${BV}"${opts.centered ? ' text_orientation="center"' : ''} background_layout="dark" header_2_text_color="${c5('onPrimary')}" text_text_color="${c5('onPrimary')}" global_colors_info="{}"]` +
    `<h2>${inlineMarkdown(opts.heading)}</h2>\n${opts.bodyHtml}` +
    `[/et_pb_text]`
  const button =
    `[et_pb_button button_url="${attr(safeUrl(opts.buttonUrl) ?? '/contact/')}" button_text="${attr(opts.buttonText)}" button_alignment="center" _builder_version="${BV}" _module_preset="default" custom_button="on" button_text_size="16px" button_text_color="${c5('onAction')}" button_bg_color="${c5('action')}" button_border_width="0px" button_border_radius="${radius('button')}" button_font="${HEADING_FONT(700)}" button_use_icon="off" custom_padding="16px|30px|16px|30px|true|true" box_shadow_style="preset3" box_shadow_color="${c5('action', 0.35)}" global_colors_info="{}"][/et_pb_button]`
  const row = opts.centered
    ? `[et_pb_row _builder_version="${BV}" _module_preset="default" width="100%" max_width="60%" module_alignment="center" global_colors_info="{}"]` +
      `[et_pb_column type="4_4" _builder_version="${BV}" _module_preset="default" global_colors_info="{}"]${text}${button}[/et_pb_column][/et_pb_row]`
    : `[et_pb_row column_structure="2_3,1_3" use_custom_gutter="on" make_equal="on" _builder_version="${BV}" _module_preset="default" width="100%" max_width="75%" module_alignment="center" global_colors_info="{}"]` +
      `[et_pb_column type="2_3" _builder_version="${BV}" _module_preset="default" global_colors_info="{}"]${text}[/et_pb_column]` +
      `[et_pb_column type="1_3" _builder_version="${BV}" _module_preset="default" global_colors_info="{}"]${button}[/et_pb_column][/et_pb_row]`
  return (
    `[et_pb_section fb_built="1" _builder_version="${BV}" _module_preset="default" background_color="${c5('primarySurface')}"${bgImage} custom_padding="${pad(opts.bgImageUrl ? 90 : 60)}|0px|${pad(opts.bgImageUrl ? 90 : 60)}|0px|true|true" global_colors_info="{}" template_type="section"]` +
    `${row}[/et_pb_section]`
  )
}

// The currency symbol for a Divi pricing table (falls back to the code).
function currencySymbol(currency: string): string {
  try {
    const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(1)
    return parts.find((p) => p.type === 'currency')?.value ?? currency
  } catch {
    return currency
  }
}

// Config-driven pricing plans → a native Divi pricing-tables module, plus a
// styled prose block for the "all plans include" list + add-ons (Divi's pricing
// module has no shared-features/add-ons slot, so nothing is dropped). Uses the
// monthly price — the interactive monthly/annual toggle has no Divi equivalent.
export function pricingTablesBlock(config: PricingPlansConfig): string {
  const symbol = currencySymbol(config.currency)
  const tables = config.tiers
    .map((tier) => {
      // Divi lists features one per line inside the module body; a leading `-`
      // marks a feature as unavailable (struck through).
      const features = tier.features
        .map((f) => `${f.included ? '' : '-'}${f.label}`)
        .join('\n')
      const numeric = (tier.monthlyPrice ?? 0) > 0
      const sum = numeric ? String(tier.monthlyPrice) : (tier.priceSuffix || 'Custom')
      const per = numeric ? attr((tier.priceSuffix || '/mo').replace(/^\//, '')) : ''
      const buttonUrl = safeUrl(tier.cta.url) ?? '/contact/'
      return (
        `[et_pb_pricing_table featured="${tier.isMostPopular ? 'on' : 'off'}" title="${attr(tier.name)}"` +
        (tier.description ? ` subtitle="${attr(tier.description)}"` : '') +
        ` currency="${attr(symbol)}" per="${per}" sum="${attr(sum)}"` +
        ` button_url="${attr(buttonUrl)}" button_text="${attr(tier.cta.label)}"` +
        ` _builder_version="${BV}" _module_preset="default" button_bg_color="${c5('action')}" button_text_color="${c5('onAction')}" button_border_radius="${radius('button')}" global_colors_info="{}"]` +
        `${features}` +
        `[/et_pb_pricing_table]`
      )
    })
    .join('')

  const pricingSection =
    `[et_pb_section fb_built="1" _builder_version="${BV}" _module_preset="default" custom_padding="${pad(50)}||${pad(60)}|||" global_colors_info="{}" template_type="section"]` +
    `[et_pb_row _builder_version="${BV}" _module_preset="default" width="100%" max_width="90%" module_alignment="center" global_colors_info="{}"]` +
    `[et_pb_column type="4_4" _builder_version="${BV}" _module_preset="default" global_colors_info="{}"]` +
    `[et_pb_pricing_tables _builder_version="${BV}" _module_preset="default" header_background_color="${c5('primarySurface')}" featured_table_background_color="${c5('surfaceMuted')}" global_colors_info="{}"]${tables}[/et_pb_pricing_tables]` +
    `[/et_pb_column][/et_pb_row][/et_pb_section]`

  // Shared features + add-ons as a styled prose block below the tables.
  const sharedList = config.sharedFeatures.items.length
    ? `<h3>${inlineMarkdown(config.sharedFeatures.heading)}</h3>\n<ul>` +
      config.sharedFeatures.items.map((i) => `<li>${inlineMarkdown(i)}</li>`).join('') +
      `</ul>`
    : ''
  const addOnList = config.addOns.length
    ? `<h3>Add-ons</h3>\n<ul>` +
      config.addOns
        .map((a) => {
          const price =
            a.type === 'flat'
              ? `${currencySymbol(config.currency)}${a.price}${a.cadence === 'once' ? ' one-time' : a.cadence === 'year' ? '/yr' : '/mo'}`
              : `${currencySymbol(config.currency)}${a.unitPrice} / ${a.unitLabel}`
          return `<li><strong>${inlineMarkdown(a.label)}</strong> — ${price}${a.description ? `: ${inlineMarkdown(a.description)}` : ''}</li>`
        })
        .join('') +
      `</ul>`
    : ''
  const disclaimer = config.disclaimer ? `<p><em>${inlineMarkdown(config.disclaimer)}</em></p>` : ''
  const extras = sharedList + addOnList + disclaimer

  return pricingSection + (extras ? basicContentBlock(extras) : '')
}

// `split` = the template's faq split preset: heading left, questions right.
export function accordionBlock(heading: string, items: QA[], split = false): string {
  const accItems = items
    .map(
      (qa, i) =>
        `[et_pb_accordion_item title="${attr(qa.question)}" _builder_version="${BV}" _module_preset="default" open="${i === 0 ? 'on' : 'off'}" global_colors_info="{}"]${markdownToHtml(qa.answer)}[/et_pb_accordion_item]`
    )
    .join('')
  const headingText = heading
    ? `[et_pb_text _builder_version="${BV}" header_2_text_color="${c5('heading')}" custom_margin="||20px|" global_colors_info="{}"]<h2>${inlineMarkdown(heading)}</h2>[/et_pb_text]`
    : ''
  const accordion = `[et_pb_accordion _builder_version="${BV}" _module_preset="default" toggle_font="${HEADING_FONT(600)}" toggle_text_color="${c5('heading')}" body_text_color="${c5('text')}" global_colors_info="{}"]${accItems}[/et_pb_accordion]`
  const row =
    split && headingText
      ? `[et_pb_row column_structure="1_3,2_3" _builder_version="${BV}" _module_preset="default" width="100%" max_width="75%" module_alignment="center" global_colors_info="{}"]` +
        `[et_pb_column type="1_3" _builder_version="${BV}" _module_preset="default" global_colors_info="{}"]${headingText}[/et_pb_column]` +
        `[et_pb_column type="2_3" _builder_version="${BV}" _module_preset="default" global_colors_info="{}"]${accordion}[/et_pb_column][/et_pb_row]`
      : `[et_pb_row _builder_version="${BV}" _module_preset="default" width="100%" max_width="75%" module_alignment="center" global_colors_info="{}"]` +
        `[et_pb_column type="4_4" _builder_version="${BV}" _module_preset="default" global_colors_info="{}"]${headingText}${accordion}[/et_pb_column][/et_pb_row]`
  return (
    `[et_pb_section fb_built="1" _builder_version="${BV}" _module_preset="default" background_color="${c5('surfaceMuted')}" custom_padding="${pad(50)}|0px|${pad(50)}|0px|true|true" global_colors_info="{}" template_type="section"]` +
    `${row}[/et_pb_section]`
  )
}
