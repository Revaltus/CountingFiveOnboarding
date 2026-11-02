import type { SessionSchema } from '@/types/session-schema'
import { activeNiches } from './active-niches'
import { activeServices } from './active-services'
import { blocksForPage, hasBlocks, type PageBlocks } from './page-treatment'
import { objArr, realStrings } from './schema-coerce'
import { LOCATION_HUBS, NICHE_HUBS, SERVICE_HUBS } from './page-hubs'

// Resolve what a page IS — a specific niche, service, or location page vs. a
// generic one — and produce a compact, directive focus block that names the exact
// audience, pain, proof, and keywords the copy should use. The bulk firm context
// (buildFirmContext) dumps every niche/service as a list; this points the writer
// at the ONE that matches this page so niche pages stop reading generically.
//
// Pure + dependency-light (schema + URL only) so it can be called at both the
// outline and page-body sites without threading extra params, and unit-tested in
// isolation. Returns an empty focusBlock for home/about/contact/generic pages —
// there the bulk context is already the right level of detail.

export type PageIntentType = 'niche' | 'service' | 'location' | 'home' | 'about' | 'contact' | 'generic'

type Niche = NonNullable<SessionSchema['niches']>[number]
type Service = NonNullable<SessionSchema['services']>[number]
type ServiceArea = NonNullable<NonNullable<SessionSchema['business']>['serviceAreas']>[number]

export interface PageIntent {
  type: PageIntentType
  niche?: Niche
  service?: Service
  city?: string
  // Directive block for the per-page dynamic suffix. Empty when the page has no
  // specific entity to focus on (home/about/contact/generic).
  focusBlock: string
}

// Non-throwing coercions: schema JSONB can hold a string where an array/string is
// expected (hand edits, draft imports). Mirrors the arr()/str() guards in
// brand-voice.ts so a malformed field never crashes intent resolution.
const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const a = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(s).filter(Boolean) : typeof v === 'string' && v.trim() ? [v.trim()] : []

function slugify(v: string): string {
  return v
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Root-relative, lowercased, slash-trimmed path segments. Strips scheme/host and
// any query/hash so "https://x.com/Industries/Healthcare/" → ["industries","healthcare"].
function pathSegments(pageUrl: string): string[] {
  return pageUrl
    .trim()
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/[?#].*$/, '')
    .split('/')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
}

function matchBySlug<T>(items: T[], slug: string, nameOf: (item: T) => string): T | undefined {
  if (!slug) return undefined
  // Exact slug match first, then a containment fallback so "/services/tax-planning"
  // still resolves a service named "Tax Planning & Advisory".
  return (
    items.find((it) => slugify(nameOf(it)) === slug) ??
    items.find((it) => {
      const itemSlug = slugify(nameOf(it))
      return itemSlug.length > 0 && (itemSlug.includes(slug) || slug.includes(itemSlug))
    })
  )
}

// Pick the client success story most relevant to a niche by word overlap with the
// niche name/ICP. Returns null when nothing clearly relates — better to cite no
// proof than to force an unrelated story (the firm context already lists them all).
function pickRelevantStory(niche: Niche, schema: SessionSchema): string | null {
  const stories = realStrings(schema.business?.clientSuccessStories)
  if (!stories.length) return null
  const needleWords = new Set(
    `${s(niche.name)} ${s(niche.icp)}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  )
  if (!needleWords.size) return null
  let best: { story: string; score: number } | null = null
  for (const story of stories) {
    const lc = story.toLowerCase()
    let score = 0
    for (const w of needleWords) if (lc.includes(w)) score++
    if (score > 0 && (!best || score > best.score)) best = { story, score }
  }
  return best ? best.story.slice(0, 220) : null
}

function buildNicheFocus(niche: Niche, schema: SessionSchema, city?: string): string {
  const name = s(niche.name) || 'this industry'
  const lines: string[] = [
    `PAGE FOCUS — this page IS the ${name} page. Write to this specific reader, not a general "small business" audience:`,
  ]
  const audience = s(niche.decisionMaker) || s(niche.icp)
  if (audience) lines.push(`- Audience / who decides: ${audience.slice(0, 160)}`)
  const stageBits = [s(niche.businessStage), s(niche.revenueBand)].filter(Boolean)
  if (stageBits.length) lines.push(`- Where they are: ${stageBits.join(', ').slice(0, 120)}`)
  const pain = s(niche.painPoints)
  if (pain) lines.push(`- Lead with this pain: ${pain.slice(0, 200)}`)
  const trigger = s(niche.customerTrigger)
  if (trigger) lines.push(`- Buying trigger to speak to: ${trigger.slice(0, 160)}`)
  const value = s(niche.valueProp)
  if (value) lines.push(`- Resolve it with this value: ${value.slice(0, 200)}`)
  const keywords = a(niche.keywords).slice(0, 6)
  if (keywords.length) lines.push(`- Weight these keywords naturally: ${keywords.join(', ')}`)
  const story = pickRelevantStory(niche, schema)
  if (story) lines.push(`- Proof you may cite (only if it genuinely fits — never fabricate specifics): ${story}`)
  if (city) lines.push(`- Local angle: this serves ${city} — make the local relevance concrete, not "proudly serving ${city}" filler.`)
  return lines.join('\n')
}

function buildServiceFocus(service: Service, city?: string): string {
  const name = s(service.name) || 'this service'
  const lines: string[] = [
    `PAGE FOCUS — this page IS the ${name} service page. Keep it specifically about this service, not a menu of everything the firm does:`,
  ]
  const offerings = a(service.offerings).slice(0, 8)
  if (offerings.length) lines.push(`- What it actually includes: ${offerings.join(', ')}`)
  const direction = s(service.rewriteDirection)
  if (direction) lines.push(`- Angle / how to position it: ${direction.slice(0, 200)}`)
  const keywords = a(service.keywords).slice(0, 6)
  if (keywords.length) lines.push(`- Weight these keywords naturally: ${keywords.join(', ')}`)
  if (city) lines.push(`- Local angle: this targets ${city} — make the local relevance concrete, not filler.`)
  return lines.join('\n')
}

function buildLocationFocus(city: string, area?: ServiceArea): string {
  const where = [city, s(area?.county), s(area?.state)].filter(Boolean).join(', ')
  return [
    `PAGE FOCUS — this is a local page for ${where || city}. Make the local relevance concrete (the community and the businesses there), and tie it to the firm's real service areas.`,
    `- Avoid generic "proudly serving ${city}" filler — write something a competitor couldn't paste their own town into.`,
  ].join('\n')
}

// A directive telling the writer to cover each block item AS A SECTION on this
// page — never as a link to a separate page (they have no page). Keeps a
// content-block service/niche/sub-service covered even though it got no URL.
function buildBlockDirective(blocks: PageBlocks): string {
  const names = [
    ...blocks.services,
    ...blocks.niches,
    ...blocks.subs.map((s) => s.name),
  ].filter((n) => n.trim())
  if (!names.length) return ''
  return [
    'ALSO INCLUDE, as dedicated sections ON THIS PAGE (they do NOT get their own pages — cover them here, do not link out to a separate page):',
    ...names.map((n) => `- ${n}`),
  ].join('\n')
}

export function resolvePageIntent(pageUrl: string, pageTitle: string, schema: SessionSchema): PageIntent {
  const intent = resolveBaseIntent(pageUrl, pageTitle, schema)
  // Fold any content-block items attached to this page into its focus block so
  // the outline covers them as sections. Applies to hub pages too (which have an
  // otherwise-empty focus block).
  const blocks = blocksForPage(schema, pageUrl)
  if (hasBlocks(blocks)) {
    const directive = buildBlockDirective(blocks)
    intent.focusBlock = [intent.focusBlock, directive].filter(Boolean).join('\n\n')
  }
  return intent
}

function resolveBaseIntent(pageUrl: string, pageTitle: string, schema: SessionSchema): PageIntent {
  const segs = pathSegments(pageUrl)
  const niches = activeNiches(schema)
  const services = activeServices(schema)
  const areas = objArr<ServiceArea>(schema.business?.serviceAreas)

  const findArea = (citySlug: string): ServiceArea | undefined =>
    areas.find((ar) => slugify(s(ar.city)) === citySlug)
  const cityLabel = (citySlug: string): string => {
    const ar = findArea(citySlug)
    return ar ? s(ar.city) : citySlug.replace(/-/g, ' ')
  }

  // Home
  if (segs.length === 0 || (segs.length === 1 && (segs[0] === 'home' || segs[0] === 'index'))) {
    return { type: 'home', focusBlock: '' }
  }

  const head = segs[0]

  if (head === 'about' || head === 'about-us') return { type: 'about', focusBlock: '' }
  if (head === 'contact' || head === 'contact-us') return { type: 'contact', focusBlock: '' }

  // Niche pages: /industries/{slug} (optionally /industries/{slug}/{city}).
  if (NICHE_HUBS.includes(head) && segs[1]) {
    const niche = matchBySlug(niches, segs[1], (n) => s(n.name))
    const citySlug = segs[2]
    const city = citySlug ? cityLabel(citySlug) : undefined
    if (niche) return { type: 'niche', niche, city, focusBlock: buildNicheFocus(niche, schema, city) }
    // Unmatched niche slug → still a niche-type page, but no specific focus block.
    return { type: 'niche', city, focusBlock: '' }
  }

  // Service pages: /services/{slug} (optionally /services/{slug}/{city}).
  if (SERVICE_HUBS.includes(head) && segs[1]) {
    const service = matchBySlug(services, segs[1], (sv) => s(sv.name))
    const citySlug = segs[2]
    const city = citySlug ? cityLabel(citySlug) : undefined
    if (service) return { type: 'service', service, city, focusBlock: buildServiceFocus(service, city) }
    return { type: 'service', city, focusBlock: '' }
  }

  // Location pages: /locations/{city}.
  if (LOCATION_HUBS.includes(head) && segs[1]) {
    const citySlug = segs[1]
    const city = cityLabel(citySlug)
    return { type: 'location', city, focusBlock: buildLocationFocus(city, findArea(citySlug)) }
  }

  return { type: 'generic', focusBlock: '' }
}
