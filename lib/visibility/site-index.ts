import type { CrawledPage, PageAnalysis } from '@/types/audit-result'

export interface IndexedPage {
  url: string
  path: string
  title: string
  h1: string
  text: string
  schemaTypes: string[]
  html: string
  hasCta: boolean
  hasPhone: boolean
}

export type PageKind =
  | 'careers'
  | 'team'
  | 'about'
  | 'contact'
  | 'partners'
  | 'succession'
  | 'resources'
  | 'client_center'
  | 'testimonials'

const KIND_PATTERNS: Record<PageKind, RegExp> = {
  careers: /career|join[- ]?(our|the)?[- ]?team|\bjobs?\b|employment|hiring|work[- ]with[- ]us/,
  team: /\bteam\b|our[- ]people|\bstaff\b|leadership|professionals|\bbios?\b/,
  about: /about/,
  contact: /contact/,
  partners: /partner|alliance|referral|affiliat|association|membership/,
  succession: /succession|merger|acqui|m&a|practice[- ](sale|transition)|join[- ]forces|investment/,
  resources: /resource|blog|insight|article|news|library/,
  client_center: /client[- ]?(center|portal|login|resources)|portal/,
  testimonials: /testimonial|review|case[- ]stud|success[- ]stor/,
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url
  }
}

export function buildSiteIndex(pages: CrawledPage[], analyzed: PageAnalysis[]): IndexedPage[] {
  const out: IndexedPage[] = []
  pages.forEach((p, i) => {
    const a = analyzed[i]
    if (!a || p.status_code >= 400) return
    out.push({
      url: p.url,
      path: pathOf(p.url),
      title: a.title ?? '',
      h1: (a.h1_texts ?? []).join(' '),
      text: a.page_text_sample ?? '',
      schemaTypes: a.schema_types ?? [],
      html: p.html ?? '',
      hasCta: !!a.has_cta,
      hasPhone: !!a.has_phone,
    })
  })
  return out
}

const signature = (p: IndexedPage): string => `${p.path} ${p.title} ${p.h1}`.toLowerCase()

export function pagesOfKind(index: IndexedPage[], kind: PageKind): IndexedPage[] {
  const re = KIND_PATTERNS[kind]
  return index.filter((p) => re.test(signature(p)))
}

const significantWords = (phrase: string): string[] =>
  phrase
    .toLowerCase()
    .split(/[^a-z0-9&]+/)
    .filter((w) => w.length >= 4)

// A page "mentions" a phrase when every significant (4+ char) word of it is
// present. Heading/path matches win over body-text matches, so the dedicated
// page is the evidence rather than the homepage that lists everything.
export function findPageMentioning(index: IndexedPage[], phrase: string): IndexedPage | null {
  const words = significantWords(phrase)
  if (words.length === 0) {
    const bare = phrase.trim().toLowerCase()
    if (!bare) return null
    words.push(bare)
  }
  const has = (hay: string) => words.every((w) => hay.includes(w))
  return (
    index.find((p) => has(signature(p).replace(/[-_/]/g, ' '))) ??
    index.find((p) => has(p.text.toLowerCase())) ??
    null
  )
}
