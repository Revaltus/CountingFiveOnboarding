import type { CategoryKey, CategoryScoreMap, Findings, SitemapEntry } from '@/types/audit-result'
import type { SessionSchema } from '@/types/session-schema'
import type { IndexedPage } from '../site-index'
import type { RubricContext } from '../rubric'

export const NOW = new Date('2026-11-10T12:00:00Z')

export function pageFixture(path: string, title: string, extra: Partial<IndexedPage> = {}): IndexedPage {
  return {
    url: `https://firm.com${path}`,
    path,
    title,
    h1: title,
    text: '',
    schemaTypes: [],
    html: '',
    hasCta: true,
    hasPhone: true,
    ...extra,
  }
}

export function findingsFixture(level: 'good' | 'bad'): Findings {
  const good = level === 'good'
  const pct = good ? 95 : 10
  return {
    technical: {
      ssl_valid: good,
      ssl_expiry_days: 90,
      ssl_error: null,
      robots_present: good,
      mixed_content_pages: 0,
      redirect_chain_pages: 0,
      broken_links: 0,
      avg_security_headers: 4,
      security_headers_sample: {},
    },
    performance: good ? { mobile_score: 90, desktop_score: 98 } : { mobile_score: 30, desktop_score: 50 },
    onpage_seo: {
      pct_has_title: pct,
      pct_title_len_ok: pct,
      pct_unique_titles: pct,
      pct_has_meta: pct,
      pct_meta_len_ok: pct,
      pct_one_h1: pct,
      pct_no_heading_skip: pct,
      pct_alt_text_ok: pct,
      pct_og_complete: pct,
      pct_tw_card: pct,
      pct_clean_url: pct,
      pages_missing_title: [],
    },
    content: {
      pct_adequate_words: pct,
      avg_reading_grade: 10,
      pct_readable: pct,
      pct_has_cta: pct,
      pct_has_trust_signals: pct,
      homepage_has_contact: good,
      duplicate_title_pages: 0,
    },
    indexability: {
      sitemap_found: good,
      sitemap_url: null,
      sitemap_is_index: false,
      sitemap_child_count: 0,
      sitemap_url_count: 10,
      sitemap_pages: 10,
      sitemap_posts: 0,
      sitemap_other: 0,
      sitemap_in_robots: good,
      pages_with_noindex: 0,
      google_index_count: 'unverified',
      crawled_pages: 10,
    },
    schema: {
      types_found: good ? ['Organization', 'LocalBusiness', 'FAQPage', 'Person'] : [],
      has_organization: good,
      has_website: good,
      has_breadcrumb: good,
      has_local_business: good,
      has_article: false,
      has_faq: good,
      has_product: false,
      all_json_valid: true,
      pct_pages_with_schema: pct,
    },
    ai_llm: {
      llms_txt_present: good,
      llms_txt_url: null,
      ai_crawlers_blocked: good ? [] : ['GPTBot'],
      ai_crawlers_allowed: [],
      has_faq_schema: good,
      has_about_content: good,
      contact_info_in_text: good,
    },
    ux: { pct_has_viewport: pct, pct_buttons_accessible: pct, pct_form_labels_ok: pct, pct_skip_nav: pct, has_custom_404: good },
    analytics: { has_ga4: good, has_gtm: false, has_meta_pixel: false, has_linkedin_pixel: false, has_heatmap_tool: false, ga4_page_coverage: pct },
    local_seo: {
      has_local_business: good,
      local_business_nap_complete: good,
      local_business_has_geo: good,
      local_business_has_hours: good,
      has_map_embed: good,
      homepage_has_contact: good,
      nap_consistent: good,
    },
  }
}

const CATEGORY_KEYS: CategoryKey[] = [
  'performance', 'technical', 'onpage_seo', 'ux', 'content', 'indexability', 'schema', 'ai_llm', 'analytics', 'local_seo',
]

export function categoryScoresFixture(score: number | null): CategoryScoreMap {
  return Object.fromEntries(
    CATEGORY_KEYS.map((k) => [k, { score, grade: score === null ? null : score >= 90 ? 'A' : 'F' }]),
  ) as CategoryScoreMap
}

export function schemaFixture(): SessionSchema {
  return {
    business: {
      name: 'Firm CPA',
      affiliations: ['AICPA'],
      targetKeywords: ['dental cpa', 'tax planning'],
      serviceAreas: [{ city: 'Austin', state: 'TX', primary: true }],
    },
    niches: [{ name: 'Dental Practices', description: '', icp: '', painPoints: '', valueProp: '' }],
    services: [{ name: 'Tax Planning', description: '', offerings: [] }],
    team: [{ name: 'Jane Doe', title: 'Partner', certifications: [], bio: '', specializations: [] }],
    clientPortals: [{ label: 'ShareFile', url: 'https://firm.sharefile.com' }],
  } as unknown as SessionSchema
}

export function goodIndex(): IndexedPage[] {
  return [
    pageFixture('/', 'Home', {
      text: 'Tax Planning for dental practices. Subscribe to our newsletter.',
      html: '<a href="https://firm.sharefile.com">Client portal</a> Subscribe to our newsletter',
    }),
    pageFixture('/industries/dental-practices', 'Dental Practices'),
    pageFixture('/services/tax-planning', 'Tax Planning'),
    pageFixture('/careers', 'Careers', {
      text: 'Our culture and values. Apply for an open position.',
      html: 'Our culture and values. Apply for an open position.',
      schemaTypes: ['JobPosting'],
    }),
    pageFixture('/about/team', 'Our Team', { html: 'Jane Doe, Partner' }),
    pageFixture('/contact', 'Contact Us'),
    pageFixture('/about/affiliations', 'Partners & Associations'),
    pageFixture('/succession-planning', 'Practice Transition'),
    pageFixture('/testimonials', 'Client Success Stories'),
    pageFixture('/blog', 'Insights'),
  ]
}

export function goodSitemap(): SitemapEntry[] {
  return [{ url: 'https://firm.com/blog/new-post', lastmod: '2026-10-20', type: 'post' }]
}

export function goodContext(): RubricContext {
  return {
    index: goodIndex(),
    findings: findingsFixture('good'),
    categoryScores: categoryScoresFixture(92),
    schema: schemaFixture(),
    sitemapEntries: goodSitemap(),
    isLiveDomain: true,
    now: NOW,
    ranks: [
      { query: 'dental cpa Austin', position: 3, url: 'https://firm.com/industries/dental-practices' },
      { query: 'tax planning Austin', position: 8, url: 'https://firm.com/services/tax-planning' },
    ],
    gbp: { rating: 4.8, reviewCount: 60, mapsUri: 'https://maps.google.com/x' },
    probe: [
      { question: 'q1', kind: 'discovery', mentioned: true, snippet: '', citedUrl: null },
      { question: 'q2', kind: 'discovery', mentioned: true, snippet: '', citedUrl: null },
      { question: 'q3', kind: 'understanding', mentioned: false, snippet: '', citedUrl: null },
    ],
    ai: [
      { checkId: 'p.answers_need', status: 'pass', detail: 'Clear', evidenceUrl: 'https://firm.com/industries/dental-practices' },
      { checkId: 'c.what_else', status: 'pass', detail: 'Clear', evidenceUrl: null },
      { checkId: 't.story', status: 'partial', detail: 'Thin', evidenceUrl: null },
      { checkId: 'a.entity_clarity', status: 'pass', detail: 'Consistent', evidenceUrl: null },
    ],
  }
}

export function emptyContext(): RubricContext {
  return {
    index: [],
    findings: findingsFixture('bad'),
    categoryScores: categoryScoresFixture(null),
    schema: {} as SessionSchema,
    sitemapEntries: [],
    isLiveDomain: false,
    now: NOW,
    ranks: null,
    gbp: null,
    probe: null,
    ai: null,
  }
}
