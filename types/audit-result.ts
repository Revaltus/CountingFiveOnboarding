// Type contract for the site-audit engine and its persisted result.
//
// Ported from the shapes that the reference `audit.py` produces (see
// raw-docs/site-audit/reference/audit.py and the sample
// audit-stgcpas-com-2026-04-20.json). The sample JSON predates the current
// audit.py in a couple of `findings` fields, so fields the current code emits
// but the sample lacks are marked optional.
//
// `AuditResult` is the full structured value stored in `audit_runs.result`
// (JSONB). The report is always re-rendered from this JSON — never stored as
// pre-baked HTML. Unlike audit.py, we also persist the raw scoring inputs
// (`raw`) so scoring can be re-run for regression tests.

export type AuditStage =
  | 'queued'
  | 'crawling'
  | 'analyzing'
  | 'scoring'
  | 'researching'
  | 'rendering'
  | 'complete'
  | 'error'

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F'

export type CategoryKey =
  | 'performance'
  | 'technical'
  | 'onpage_seo'
  | 'ux'
  | 'content'
  | 'indexability'
  | 'schema'
  | 'ai_llm'
  | 'analytics'
  | 'local_seo'

/** Per-category score 0–100 (null when the category could not be measured). */
export type CategoryScores = Record<CategoryKey, number | null>

/** Score + letter grade per category, stored in `audit_runs.category_scores`. */
export interface CategoryScore {
  score: number | null
  grade: Grade | null
}
export type CategoryScoreMap = Record<CategoryKey, CategoryScore>

// ── Per-category findings ──────────────────────────────────────────────────

export interface TechnicalFindings {
  ssl_valid: boolean
  ssl_expiry_days: number | null
  ssl_error: string | null
  robots_present: boolean
  mixed_content_pages: number
  mixed_content_detail?: Array<{ page: string; resources: string[] }>
  redirect_chain_pages: number
  broken_links: number
  avg_security_headers: number
  security_headers_sample: Record<string, boolean>
  missing_security_headers?: string[]
}

export interface PerformanceFindings {
  error?: string
  mobile_score?: number
  desktop_score?: number
  lcp?: number | null
  lcp_pass?: boolean
  cls?: number | null
  cls_pass?: boolean
  fcp?: number | null
  fcp_pass?: boolean
  ttfb?: number | null
  inp?: number | null
}

export interface OnpageSeoFindings {
  pct_has_title: number
  pct_title_len_ok: number
  pct_unique_titles: number
  pct_has_meta: number
  pct_meta_len_ok: number
  pct_one_h1: number
  pct_no_heading_skip: number
  pct_alt_text_ok: number
  pct_og_complete: number
  pct_tw_card: number
  pct_clean_url: number
  pages_missing_title: string[]
}

export interface ContentFindings {
  pct_adequate_words: number
  avg_reading_grade: number
  pct_readable: number
  pct_has_cta: number
  pct_has_trust_signals: number
  homepage_has_contact: boolean
  duplicate_title_pages: number
}

export interface IndexabilityFindings {
  sitemap_found: boolean
  sitemap_url: string | null
  sitemap_is_index: boolean
  sitemap_child_count: number
  sitemap_url_count: number
  sitemap_pages: number
  sitemap_posts: number
  sitemap_other: number
  sitemap_in_robots: boolean
  pages_with_noindex: number
  /** Integer count from the Serper `site:` query, or 'unverified' when no key. */
  google_index_count: number | 'unverified'
  crawled_pages: number
}

export interface SchemaFindings {
  types_found: string[]
  has_organization: boolean
  has_website: boolean
  has_breadcrumb: boolean
  has_local_business: boolean
  has_article: boolean
  has_faq: boolean
  has_product: boolean
  all_json_valid: boolean
  pct_pages_with_schema: number
}

export interface AiLlmFindings {
  llms_txt_present: boolean
  llms_txt_url: string | null
  ai_crawlers_blocked: string[]
  ai_crawlers_allowed: string[]
  has_faq_schema: boolean
  has_about_content: boolean
  contact_info_in_text: boolean
}

export interface UxFindings {
  pct_has_viewport: number
  pct_buttons_accessible: number
  pct_form_labels_ok: number
  pct_skip_nav: number
  has_custom_404: boolean
}

export interface AnalyticsFindings {
  has_ga4: boolean
  has_gtm: boolean
  has_meta_pixel: boolean
  has_linkedin_pixel: boolean
  has_heatmap_tool: boolean
  ga4_page_coverage: number
}

export interface LocalSeoFindings {
  has_local_business: boolean
  local_business_nap_complete: boolean
  local_business_has_geo: boolean
  local_business_has_hours: boolean
  has_map_embed: boolean
  homepage_has_contact: boolean
  /** All pages that show a phone number show the same one (consistent NAP). */
  nap_consistent: boolean
}

export interface Findings {
  technical: TechnicalFindings
  performance: PerformanceFindings
  onpage_seo: OnpageSeoFindings
  content: ContentFindings
  indexability: IndexabilityFindings
  schema: SchemaFindings
  ai_llm: AiLlmFindings
  ux: UxFindings
  analytics: AnalyticsFindings
  local_seo: LocalSeoFindings
}

// ── Recommendations ────────────────────────────────────────────────────────

export type RecommendationPriority = 'critical' | 'warning'
export type RecommendationEffort = 'Low' | 'Medium' | 'High'

export interface Recommendation {
  priority: RecommendationPriority
  category: string
  title: string
  detail: string
  effort: RecommendationEffort
  impact?: string
}

// ── Raw crawl + analysis inputs (persisted for regression testing) ──────────

export interface RedirectHop {
  url: string
  status: number
}

export interface CrawledPage {
  /** Final URL after redirects. */
  url: string
  /** URL as discovered/queued, before redirects. */
  original_url: string
  status_code: number
  redirect_chain: RedirectHop[]
  redirect_count: number
  html: string
  response_headers: Record<string, string>
  ssl_error: boolean
  content_length: number
}

export interface CrawlError {
  url: string
  status?: number
  error: string
}

/** Rich per-page analysis (audit.py `analyze_page` return). Feeds scoring. */
export interface PageAnalysis {
  title: string
  title_len: number
  meta_desc: string
  meta_desc_len: number
  /** Canonical href, or '' when absent (audit.py stores ''). */
  canonical: string
  noindex: boolean
  h1_count: number
  h1_texts: string[]
  h2_count: number
  headings: Record<string, string[]>
  heading_skip: boolean
  imgs_total: number
  imgs_missing_alt: number
  og_title: boolean
  og_desc: boolean
  og_image: boolean
  tw_card: boolean
  viewport: boolean
  schema_types: string[]
  schema_valid: boolean
  word_count: number
  fk_grade: number | null
  has_cta: boolean
  has_trust: boolean
  has_phone: boolean
  has_email: boolean
  /** First phone number on the page, normalized to digits — for cross-page NAP
   * consistency. null when none detected. */
  primary_phone: string | null
  has_ga4: boolean
  has_gtm: boolean
  has_meta_px: boolean
  has_linkedin: boolean
  has_hotjar: boolean
  has_clarity: boolean
  mixed_content: boolean
  mixed_content_urls: string[]
  sec_headers: Record<string, boolean>
  sec_header_count: number
  url_has_params: boolean
  url_has_caps: boolean
  buttons_missing_label: number
  inputs_missing_label: number
  has_skip_nav: boolean
  /** Some LocalBusiness (or service subtype) JSON-LD node has BOTH address and telephone. */
  local_biz_nap: boolean
  /** Some local-business JSON-LD node carries a geo coordinate. */
  local_biz_geo: boolean
  /** Some local-business JSON-LD node declares opening hours. */
  local_biz_hours: boolean
  /** The raw HTML embeds a Google Maps map (iframe or embed URL). */
  has_map_embed: boolean
  page_text_sample: string
  content_length_bytes: number
  redirect_count: number
}

/** Derived per-page summary for the report's page inventory. */
export interface PageSummary {
  url: string
  status_code: number
  title: string
  title_ok: boolean
  title_len: number
  meta_desc: string
  meta_ok: boolean
  meta_len: number
  h1_count: number
  h1_text: string
  schema_types: string[]
  word_count: number
  og_complete: boolean
  has_ga4: boolean
  issues: string[]
  content_snippet: string
  /** Suggested replacements for thin/missing metadata (display aids). */
  suggested_title: string | null
  suggested_meta: string | null
}

export interface SitemapEntry {
  url: string
  lastmod: string
  type: string
}

export interface SitemapInfo {
  found: boolean
  url: string | null
  is_index: boolean
  child_sitemaps: string[]
  count: number
  pages: number
  posts: number
  other: number
  page_entries: SitemapEntry[]
}

export interface RobotsResult {
  present: boolean
  sitemaps: string[]
  ai_blocked?: string[]
  ai_allowed?: string[]
}

export interface SslResult {
  valid: boolean
  expiry_days: number | null
  error: string | null
}

export interface PageSpeedResult {
  score: number | null
  lcp?: number | null
  lcp_pass?: boolean
  cls?: number | null
  cls_pass?: boolean
  fcp?: number | null
  fcp_pass?: boolean
  ttfb?: number | null
  inp?: number | null
  error?: string
}

export interface LlmsResult {
  present: boolean
  url: string | null
}

/** Result of the Serper `site:` index check. */
export interface IndexCheckResult {
  google_index_count: number | 'unverified'
  google_indexed_urls: string[]
}

/** Business/contact data harvested from crawled pages (JSON-LD + tel/mailto +
 * social links) to seed an AI-drafted session profile. Display/draft only;
 * never feeds scoring. Absent on audits run before this was added. */
export interface BusinessSignals {
  organizationName: string | null
  phones: string[]
  emails: string[]
  addresses: string[]
  socialLinks: string[]
}

/** Raw scoring inputs — our addition (audit.py discarded these). */
export interface AuditRawInputs {
  pages: CrawledPage[]
  analyzed: PageAnalysis[]
  psi_mobile: PageSpeedResult
  psi_desktop: PageSpeedResult
  robots: RobotsResult
  ssl: SslResult
  llms: LlmsResult
  crawl_errors: CrawlError[]
}

// ── Intelligence layer (AI + off-site research) ─────────────────────────────
//
// Everything here is additive and best-effort. The intelligence stage in
// runAudit() is wrapped in try/catch (WHOIS-style non-fatal), and each
// sub-section is independently optional: a failed Serper/Claude/WHOIS call
// simply omits its section, the rest of the audit still completes and renders.
// Older audit rows have no `intelligence` and render exactly as before.

/** A scored analytical section (Target Market, Niche & Services, Competitive)
 * that carries its OWN score/grade — it never feeds the deterministic
 * 9-category scoring, which stays untouched. */
export interface ScoredSection {
  score: number
  grade: Grade
  sub_scores: Record<string, number>
  commentary: string
}

export type FootprintStrength = 'minimal' | 'moderate' | 'strong'
export type NicheSignal = 'weak' | 'moderate' | 'strong'
export type NarrativePriority = 'High' | 'Medium' | 'Low'

export interface NarrativeRecommendation {
  title: string
  business_impact: string
  counting_five_help: string
  priority: NarrativePriority
}

export interface NarrativeIntelligence {
  executive_summary: string
  /** Per-section prose, keyed by a stable section id (e.g. 'performance',
   * 'niche_services', 'competitive'). */
  section_commentary: Record<string, string>
  recommendations: NarrativeRecommendation[]
}

export interface DetectedNiche {
  name: string
  signal: NicheSignal
  note: string
}

export interface InvisibleNiche {
  name: string
  opportunity: string
}

export interface ServiceAnalysis {
  service: string
  clarity: string
  framing: string
  audience: string
  rewrite_direction: string
}

export interface NicheServicesIntelligence extends ScoredSection {
  detected_niches: DetectedNiche[]
  invisible_niches: InvisibleNiche[]
  services_analysis: ServiceAnalysis[]
  top_improvements: string[]
}

export interface KeywordRanking {
  keyword: string
  /** SERP position (1-based), or null when not found in the checked results. */
  rank: number | null
  note: string
}

export interface CompetitiveIntelligence extends ScoredSection {
  keyword_rankings: KeywordRanking[]
  ai_search_presence: string
  local_seo: string
}

// A competitor firm discovered off-site (Serper organic results + an LLM
// extraction pass). Shape mirrors SessionSchema business.competitors[] so the
// audit→session draft can map it across directly. Unknown fields are ''.
export interface CompetitorEntity {
  name: string
  location: string
  size: string
  nicheClaim: string
  positioningNotes: string
}

export interface CompetitorIntelligence {
  competitors: CompetitorEntity[]
}

export interface TechStackIntelligence {
  cms: string | null
  page_builder: string | null
  hosting: string | null
  frameworks: string[]
  /** Risky/notable third-party dependencies (e.g. a compromised polyfill.io). */
  risk_flags: string[]
  commentary: string
}

export interface DomainIntelligence {
  /** Raw registration date string from WHOIS, or null when unavailable. */
  registered: string | null
  age_years: number | null
  /** Freshest content signal (sitemap lastmod), or null. */
  last_updated: string | null
}

export interface ContentLibraryFormat {
  type: string
  count: number
  cadence: string
}

export interface ContentLibraryIntelligence {
  total_pieces: number
  formats: ContentLibraryFormat[]
  syndication_assessment: string
  recommendations: string[]
}

export interface PersonnelProfile {
  name: string
  role: string
  footprint: FootprintStrength
  linkedin?: string
  associations: string[]
  notes: string
}

export interface ReputationIntelligence {
  sentiment: string
  ratings: string[]
  praise_themes: string[]
  concern_themes: string[]
}

export interface ContentFootprintItem {
  type: string
  title: string
  source: string
}

export interface SocialPresenceItem {
  platform: string
  status: string
  detail: string
}

export interface NicheGapIntelligence {
  external: string[]
  on_site: string[]
  unleveraged: string[]
}

export interface DigitalIntelligence {
  personnel: PersonnelProfile[]
  reputation: ReputationIntelligence
  affiliations: string[]
  content_footprint: ContentFootprintItem[]
  social_presence: SocialPresenceItem[]
  niche_gap: NicheGapIntelligence
}

// ── Social & Local Presence (quality-assessed) ──────────────────────────────
// A deeper pass than DigitalIntelligence.social_presence (a coarse Serper list):
// this assesses each channel's QUALITY — GBP rating/reviews/hours/categories,
// LinkedIn follower/page-type/activity, and bonus IG/FB/X follower + recency —
// feeds the MBP, and drives the report's Recommended Next Steps. Best-effort and
// never scored; absent on older rows and when the stage produced nothing.

export type SocialPlatform =
  | 'google_business'
  | 'linkedin'
  | 'instagram'
  | 'facebook'
  | 'x'
  | 'youtube'
  | 'tiktok'
  | 'pinterest'
  | 'yelp'
  | 'other'

export type ProfileStatus = 'active' | 'dormant' | 'not_found' | 'unknown'
export type Usefulness = 'low' | 'medium' | 'high'

export interface SocialProfileMetrics {
  /** GBP / Yelp star rating. */
  rating?: number | null
  /** GBP / Yelp review count. */
  reviewCount?: number | null
  /** LinkedIn / IG / FB / X follower count. */
  followerCount?: number | null
  /** GBP listing categories. */
  categories?: string[]
  /** GBP business hours present. */
  hoursListed?: boolean
  /** Recency signal, e.g. "posted 3 weeks ago". */
  lastActivity?: string | null
  /** LinkedIn company vs. personal page. */
  pageType?: 'company' | 'personal' | 'unknown'
  completeness?: 'partial' | 'complete' | 'unknown'
}

export interface SocialProfileAssessment {
  platform: SocialPlatform
  url: string | null
  status: ProfileStatus
  metrics: SocialProfileMetrics
  /** Quality verdict used when mapping into the MBP. */
  usefulness: Usefulness
  /** One actionable sentence. */
  roomForImprovement: string
  /** Provenance / degradation flag: authoritative Places vs. Serper vs. on-page. */
  source: 'places_api' | 'serper' | 'onpage' | 'ai'
}

export interface SocialPresenceReport {
  profiles: SocialProfileAssessment[]
  /** A Google Business Profile was located. */
  hasGbp: boolean
  /** A LinkedIn company/profile was located. */
  hasLinkedIn: boolean
  /** Required platforms with no profile found — drives "missing presence" recs. */
  missingRequired: SocialPlatform[]
  summary: string
}

// ── Team Social Footprint & Niche-Expertise ─────────────────────────────────
// A per-person parallel to SocialPresenceReport: for each team member found on
// the site, the quality of their off-site social footprint plus the untapped
// niche-content opportunities their certifications/expertise imply. Feeds the
// MBP team roster and content gaps; best-effort and never scored.

export interface TeamMemberSocial {
  name: string
  title?: string
  certifications: string[]
  specializations: string[]
  /** Per-profile assessment, reusing the business social-presence shape. */
  socialProfiles: SocialProfileAssessment[]
  footprint: FootprintStrength
  /** One actionable sentence on strengthening this person's footprint. */
  roomForImprovement: string
  /** Untapped niches implied by this person's certs/expertise. */
  nicheOpportunities: string[]
  /** Provenance: on-page roster only vs. AI-synthesized from external search. */
  source: 'onpage' | 'ai'
}

export interface TeamSocialReport {
  members: TeamMemberSocial[]
  /** Aggregate niche-content ideas across the whole team. */
  teamNicheOpportunities: string[]
  summary: string
  membersAssessed: number
  /** Members found but not assessed due to the cap — no silent truncation. */
  membersDropped: number
}

/** Authoritative Google Business Profile data from the Places API Text Search. */
export interface PlaceDetails {
  name: string | null
  rating: number | null
  reviewCount: number | null
  businessStatus: string | null
  categories: string[]
  hoursListed: boolean
  mapsUri: string | null
}

/** The full intelligence bundle attached to a completed audit. Every field is
 * optional: sub-sections appear only when their builder succeeds. */
export interface AuditIntelligence {
  narrative?: NarrativeIntelligence
  target_market?: ScoredSection
  niche_services?: NicheServicesIntelligence
  competitive?: CompetitiveIntelligence
  competitors?: CompetitorIntelligence
  tech_stack?: TechStackIntelligence
  domain?: DomainIntelligence
  content_library?: ContentLibraryIntelligence
  digital_intelligence?: DigitalIntelligence
  social_presence?: SocialPresenceReport
  team_social?: TeamSocialReport
}

// ── Top-level result ───────────────────────────────────────────────────────

/** Full structured value stored in `audit_runs.result` (JSONB). */
export interface AuditResult {
  version: string
  domain: string
  site_name: string
  url: string
  audit_date: string
  max_pages: number
  pages_crawled: number
  crawl_errors_count: number
  overall_score: number
  overall_grade: Grade
  scores: CategoryScores
  category_scores: CategoryScoreMap
  findings: Findings
  recommendations: Recommendation[]
  page_analysis_summary: PageSummary[]
  google_indexed_urls: string[]
  sitemap: SitemapInfo
  /** Harvested business/contact data for the audit→session draft. Optional so
   * older rows (and audits that found nothing) stay valid. */
  business_signals?: BusinessSignals
  /** AI + off-site intelligence layer. Optional and best-effort: absent on
   * older rows and on audits where the intelligence stage failed wholesale. */
  intelligence?: AuditIntelligence
  /** Persisted for re-scoring/regression. Optional so older rows stay valid. */
  raw?: AuditRawInputs
}

/** Input to `runAudit()`. The engine is pure with respect to the DB. */
export interface RunAuditInput {
  url: string
  siteName?: string
  maxPages?: number
  onProgress?: (stage: AuditStage, detail: string, pagesCrawled?: number) => Promise<void>
  // Attribution for the AI intelligence stage's token usage. auditId is the
  // audit_runs row; sessionId is set only when the audit is linked to a client.
  auditId?: string
  sessionId?: string | null
  // Absolute wall-clock deadline (epoch ms) shared across the whole audit so the
  // crawl and the intelligence stage split the function's budget instead of each
  // assuming it owns the full maxDuration. Set by the worker at job entry.
  deadline?: number
  // Skip the prospect-research stage (competitors, social, narrative). Used by
  // the post-launch Visibility Report, which only needs crawl + scores.
  skipIntelligence?: boolean
}
