# Visibility Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator run a five-audience "Visibility Report" on a rebuilt client site from `/admin/content/[id]`, edit the AI draft, and publish it as a share-link page and a PDF, with a history of reports per client.

**Architecture:** There is a new `visibility_reports` table keyed to `sessions`. A pure engine in `lib/visibility/` reuses the audit crawler and scorer (`runAudit` with `skipIntelligence`), adds a versioned per-audience rubric, external evidence (Serper ranks, Places GBP, an AI answer probe) and one Sonnet 5.5 review call. Routes mirror the audit run/worker pattern (atomic claim, then `after()`). The admin pages hang off the content client page; the public page and PDF render from the same stored result.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role client), Vercel AI SDK 6 + `@ai-sdk/anthropic` 3.0.128 (`anthropic.tools.webSearch_20260209`), `@react-pdf/renderer`, Tailwind v4 `@theme` tokens, vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-visibility-report-design.md`

## Global Constraints
- The gate on every visibility admin route is `requireOnboardingSessionAccess(sessionId)` (admins + managers assigned to the client). Editors and Site Owners get 403.
- The public page looks up by `share_token` only, uses `robots: noindex`, and fails closed (404) unless `status = 'published'`.
- Model ids come only from `lib/content/generation-tuning.ts` (`PUBLISHED_CONTENT_MODEL`). Never set `temperature`. Never use `toolChoice` with Sonnet 5.5.
- Never send `mbp_content` to Claude. Strip `_meta` and registrar fields: use `serializeSchemaFull()` from `lib/agent/system-prompt.ts`.
- Every Claude call records usage via `recordTokenUsage({ task: 'audit', stage: 'visibility', sessionId, createdBy, ...extractCacheUsage(usage) })`.
- 5xx responses go through `internalError()` (`lib/api/errors.ts`). No `console.log`. No `as any`. No hex in JSX/CSS outside `app/globals.css` `@theme` (react-pdf `StyleSheet` hex lives in one palette module, matching `lib/pdf/components`).
- JSONB writes use `asJson()`. Primary keys are `gen_random_uuid()`.
- Failures in the AI review, probe, ranks or Places are non-fatal: the report still completes, and that piece shows as unavailable.
- `RUBRIC_VERSION = '2026.11.1'`. Trends compare only reports with an equal `rubric_version`.
- Run `npx tsc --noEmit` after each task. Before each commit, run the CLAUDE.md greps (`SUPABASE_SERVICE_ROLE_KEY`, `GITHUB_APP_PRIVATE_KEY` in `./app`; `console.log` in app/lib).

---

### Task 1: Migration, DB types, token stage

**Files:**
- Create: `supabase/087_visibility_reports.sql`
- Modify: `types/database.ts` (regenerate; hand-stub if no PAT), `lib/content/token-pricing.ts` (add `'visibility'` to `TokenStage`)

**Produces:** the `visibility_reports` table, `sessions.live_site_url`, and `Database['public']['Tables']['visibility_reports']`.

- [ ] Write the migration:

```sql
-- 087: Visibility Reports — post-launch five-audience report per client.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS live_site_url text DEFAULT NULL;

CREATE TABLE IF NOT EXISTS visibility_reports (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  url            text        NOT NULL,
  domain         text        NOT NULL,
  is_live_domain boolean     NOT NULL DEFAULT true,
  status         text        NOT NULL DEFAULT 'queued'
                             CHECK (status IN ('queued','running','draft','published','error')),
  status_detail  text        DEFAULT NULL,
  error          text        DEFAULT NULL,
  attempts       int         NOT NULL DEFAULT 0,
  rubric_version text        DEFAULT NULL,
  overall_score  int         DEFAULT NULL,
  overall_grade  text        DEFAULT NULL,
  audience_scores jsonb      DEFAULT NULL,
  result         jsonb       DEFAULT NULL,
  narrative      jsonb       DEFAULT NULL,
  share_token    uuid        DEFAULT NULL UNIQUE,
  published_at   timestamptz DEFAULT NULL,
  published_by   uuid        DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,
  pdf_path       text        DEFAULT NULL,
  created_by     uuid        DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,
  started_at     timestamptz DEFAULT NULL,
  completed_at   timestamptz DEFAULT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visibility_reports_session_idx ON visibility_reports (session_id, created_at DESC);

ALTER TABLE visibility_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins manage visibility_reports" ON visibility_reports;
CREATE POLICY "Admins manage visibility_reports" ON visibility_reports FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admins WHERE admins.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins WHERE admins.id = auth.uid()));
```

- [ ] Apply it via the Management API (`SUPABASE_ACCESS_TOKEN` from `.env.local`), verify with `information_schema.columns`, regenerate types into a tmp file, check that `visibility_reports` appears, then move the file into place. Without the PAT, hand-stub the Row/Insert/Update in `types/database.ts` and give the user the curl command.
- [ ] Add `| 'visibility'` to `TokenStage` in `lib/content/token-pricing.ts` (stage has no DB CHECK since migration 048).
- [ ] `npx tsc --noEmit` → clean. Commit: `feat(visibility): migration 087 + types`.

### Task 2: Core types, audiences, scoring math

**Files:** Create `lib/visibility/types.ts`, `lib/visibility/audiences.ts`, `lib/visibility/score.ts`, `lib/visibility/score.test.ts`

**Produces:**

```ts
// types.ts
export type AudienceKey = 'prospects' | 'clients' | 'talent' | 'search' | 'ai'
export type CheckStatus = 'pass' | 'partial' | 'fail' | 'na'
export interface CheckResult { id: string; audience: AudienceKey; label: string; weight: number; status: CheckStatus; detail: string; evidenceUrl: string | null; source: 'site' | 'audit' | 'external' | 'ai' }
export interface AudienceScore { score: number | null; grade: Grade | null }
export type AudienceScores = Record<AudienceKey, AudienceScore>
export interface RankResult { query: string; position: number | null; url: string | null }
export interface ProbeResult { question: string; mentioned: boolean; snippet: string; citedUrl: string | null }
export interface VisibilityNarrativeSection { wins: string[]; opportunities: string[] }
export interface VisibilityNarrative { overview: string; audiences: Record<AudienceKey, VisibilityNarrativeSection> }
export interface VisibilityResult {
  rubricVersion: string; url: string; domain: string; isLiveDomain: boolean; auditedAt: string
  pagesCrawled: number; checks: CheckResult[]; audienceScores: AudienceScores; overallScore: number | null; overallGrade: Grade | null
  categoryScores: CategoryScoreMap                 // from runAudit, appendix only
  ranks: RankResult[] | null                       // null = not run (staging / no key)
  gbp: { rating: number | null; reviewCount: number | null; mapsUri: string | null } | null
  probe: ProbeResult[] | null
  unavailable: string[]                            // e.g. ['probe','ranks'] with reason text in checks
}
// audiences.ts
export const AUDIENCES: ReadonlyArray<{ key: AudienceKey; n: 1|2|3|4|5; label: string; question: string }>
// score.ts
export function scoreAudience(checks: CheckResult[], audience: AudienceKey): AudienceScore
export function scoreAll(checks: CheckResult[]): { audienceScores: AudienceScores; overallScore: number | null; overallGrade: Grade | null }
```

The `AUDIENCES` order and copy follow the deck: prospects "Can you help with what I need?", clients "What else can you help me achieve?", talent "Careers, partnerships + investment", search "Where is this firm relevant?", ai "How should this firm be understood?".

- [ ] Write failing tests in `score.test.ts`:
  - all `pass` → 100 / A;
  - pass(w2) + fail(w2) → 50;
  - pass(w1) + partial(w1) → 75;
  - only `na` → `{score:null, grade:null}`;
  - overall = rounded mean of the non-null audience scores;
  - all null → null.
- [ ] Implement it. Score = `Math.round(100 * Σ(w·v) / Σw)` with pass = 1, partial = 0.5, fail = 0, and `na` excluded. Grade via `getGrade` from `lib/audit/scoring.ts`.
- [ ] Tests pass, tsc clean. Commit.

### Task 3: Site index (page classification)

**Files:** Create `lib/visibility/site-index.ts`, `lib/visibility/site-index.test.ts`

**Produces:**

```ts
export interface IndexedPage { url: string; path: string; title: string; h1: string; text: string; schemaTypes: string[]; html: string; hasCta: boolean; hasPhone: boolean }
export type PageKind = 'careers' | 'team' | 'about' | 'contact' | 'partners' | 'succession' | 'resources' | 'client_center' | 'testimonials'
export function buildSiteIndex(pages: CrawledPage[], analyzed: PageAnalysis[]): IndexedPage[]
export function pagesOfKind(index: IndexedPage[], kind: PageKind): IndexedPage[]
export function findPageMentioning(index: IndexedPage[], phrase: string): IndexedPage | null // title/h1/path match first, then body text
```

`KIND_PATTERNS: Record<PageKind, RegExp>` are tested against `path + ' ' + title + ' ' + h1`, lowercased:
- careers: `/career|join[- ]?(our|the)?[- ]?team|jobs?\b|employment|hiring|work[- ]with[- ]us/`
- team: `/\bteam\b|our[- ]people|staff|leadership|professionals|bios?\b/`
- about: `/about/`
- contact: `/contact/`
- partners: `/partner|alliance|referral|affiliat|association|membership/`
- succession: `/succession|merger|acqui|m&a|practice[- ](sale|transition)|join[- ]forces|investment/`
- resources: `/resource|blog|insight|article|news|library/`
- client_center: `/client[- ]?(center|portal|login|resources)|portal/`
- testimonials: `/testimonial|review|case[- ]stud|success[- ]stor/`

- [ ] Write failing tests with fixture pages, e.g. `/careers` → careers; `/about-us/our-team` → team and about; a "Join Our Team" title on `/opportunities` → careers; `findPageMentioning(index,'Dental Practices')` finds a page whose h1 contains "Dental" and "Practices" (case-insensitive, all ≥4-char words of the phrase present).
- [ ] Implement. `text` = `analyzed.page_text_sample`, `html` = the crawled html. Index only pages with status < 400.
- [ ] Pass, then commit.

### Task 4: Rubric (versioned checks per audience)

**Files:** Create `lib/visibility/rubric.ts`, `lib/visibility/rubric.test.ts`

**Consumes:** Tasks 2–3; `Findings` from `@/types/audit-result`; `activeNiches`, `activeServices`, `activeTeam`.

**Produces:**

```ts
export const RUBRIC_VERSION = '2026.11.1'
export interface AiJudgment { checkId: string; status: Exclude<CheckStatus,'na'>; detail: string; evidenceUrl: string | null }
export interface RubricContext {
  index: IndexedPage[]; findings: Findings; categoryScores: CategoryScoreMap; schema: SessionSchema
  sitemapEntries: SitemapEntry[]; isLiveDomain: boolean; now: Date
  ranks: RankResult[] | null; gbp: VisibilityResult['gbp']; probe: ProbeResult[] | null
  ai: AiJudgment[] | null
}
export const AI_CHECKS: ReadonlyArray<{ id: string; audience: AudienceKey; label: string; question: string }>
export function evaluateRubric(ctx: RubricContext): CheckResult[]
```

Checks (id: weight). Status rules are written inline in the code; the summary below lists every check:
- **prospects:**
  - `p.niche_pages` (3): share of active niches with `findPageMentioning`. ≥80% pass, ≥40% partial, otherwise fail; `na` when there are no niches.
  - `p.service_pages` (3): the same, over active services.
  - `p.cta` (2): `findings.content.pct_has_cta` ≥70 pass, ≥40 partial.
  - `p.contact` (2): `findings.content.homepage_has_contact`, plus a contact page exists.
  - `p.mobile` (1): `findings.performance.mobile_score` ≥80 pass, ≥50 partial; `na` if it's missing.
  - `p.answers_need` (3): AI.
- **clients:**
  - `c.portal` (2): when `schema.clientPortals` is non-empty, pass if any portal URL host appears in some page html, otherwise fail; with no portals, pass if a client_center page exists, otherwise `na`.
  - `c.service_breadth` (2): all active services mentioned somewhere in the index text: 100% pass, ≥60% partial.
  - `c.fresh_content` (2): the newest `sitemapEntries` lastmod among resource-like URLs. ≤60 days pass, ≤180 days partial, otherwise fail; `na` if there are no dated entries.
  - `c.subscribe` (1): a regex for `subscribe|newsletter` in any html.
  - `c.success_stories` (1): a testimonials page or `Review` schema.
  - `c.what_else` (2): AI.
- **talent:**
  - `t.careers` (3): a careers page exists.
  - `t.apply_path` (2): the careers page has `apply|open position|opening|resume|JobPosting` or `JobPosting` schema anywhere.
  - `t.team_bios` (2): a team page exists, and active team members ≥1 are named in index text: ≥80% pass.
  - `t.culture` (1): regex `culture|values|why work|benefits` on careers/about pages.
  - `t.partners` (1): a partners page, or `business.affiliations` named on the site.
  - `t.succession` (1): a succession page; `na` is never used, fail when absent.
  - `t.story` (2): AI.
- **search:** the audit categories map 1:1 to partial checks:
  - `s.onpage` (2) = onpage_seo, `s.indexable` (2) = indexability, `s.technical` (1) = technical, `s.local` (2) = local_seo. Each is score ≥80 pass, ≥60 partial, otherwise fail; null → `na`.
  - `s.ranks` (3): with no ranks, `na`. Otherwise top-10 share ≥50% pass, ≥20% partial.
  - `s.gbp` (2): when gbp is present, rating ≥4.5 with ≥25 reviews passes, ≥4.0 is partial; null → `na`.
- **ai:**
  - `a.llms` (1): llms_txt_present.
  - `a.crawlers` (2): `ai_crawlers_blocked` empty.
  - `a.entity_schema` (2): has_organization or has_local_business → partial; plus Person or FAQPage → pass.
  - `a.faq` (1): has_faq_schema.
  - `a.entity_clarity` (2): AI.
  - `a.probe` (3): probe null → `na`; otherwise mentioned share ≥2/3 pass, ≥1/3 partial.

AI checks (`p.answers_need`, `c.what_else`, `t.story`, `a.entity_clarity`) take their status from the matching `ctx.ai` judgment, and become `na` with detail "AI review unavailable" when it's absent. Every check sets `evidenceUrl` to the page that satisfied it, when there is one.

- [ ] Write failing tests:
  - a full fixture (a site with niche, service, careers, team, contact pages, findings at 90s) → prospects/talent pass and score ≥85;
  - an empty fixture → fails, no throws;
  - `ranks:null, probe:null, ai:null` → those checks are `na`, and the audiences still score from the remaining checks;
  - `c.fresh_content` boundary at 60/61 days, using a fixed `now`;
  - every check id is unique, and every `AI_CHECKS` id appears in the output.
- [ ] Implement, pass, commit.

### Task 5: External evidence — live-host detection, ranks, GBP

**Files:**
- Create: `lib/visibility/live-host.ts`, `lib/visibility/ranks.ts`, `lib/visibility/external.test.ts`
- Modify: `lib/audit/serper-search.ts` (add `rankFor`)

**Produces:**

```ts
export function isLiveHost(url: string): boolean      // false for *.vercel.app, localhost, IPv4/IPv6 literals
export function primaryCity(schema: SessionSchema): string | null   // serviceAreas primary → locations[0] "City, ST" → serviceAreas[0] → null
export function buildRankQueries(schema: SessionSchema): string[]   // dedupe targetKeywords (case-insens.), cap 10, append ` ${city}` when city and keyword lacks it
export async function rankFor(query: string, domain: string, opts?: { location?: string }): Promise<{ position: number | null; url: string | null } | null> // in serper-search.ts; null = could not run
export async function checkRanks(schema: SessionSchema, domain: string): Promise<RankResult[] | null>  // null when no key or no queries
```

`rankFor` matches results whose `new URL(link).host` with `www.` stripped equals `domain` or ends with `.${domain}`.

- [ ] Write failing tests:
  - `isLiveHost` cases;
  - `primaryCity` fallbacks;
  - `buildRankQueries` de-duplication, the cap, and the city suffix not doubling;
  - `rankFor` with `fetch` mocked (found at position 3; not found → `{position:null,url:null}`; no key → null).
- [ ] Implement. Run `checkRanks` with concurrency 3 (simple chunking).
- [ ] Pass, commit.

### Task 6: AI review + AI probe

**Files:** Create `lib/visibility/ai-review.ts`, `lib/visibility/ai-probe.ts`, `lib/visibility/ai.test.ts`

**Produces:**

```ts
export interface AiReviewOutput { judgments: AiJudgment[]; narrative: VisibilityNarrative }
export function buildReviewPrompt(input: { firmName: string; schemaJson: string; index: IndexedPage[]; checks: CheckResult[] }): { prefix: string; suffix: string }
export function validateReview(parsed: unknown): AiReviewOutput | null
export async function runAiReview(input: {...as above; ctx: TokenContext}): Promise<AiReviewOutput | null>
export function buildProbeQuestions(schema: SessionSchema): string[]   // ≤3: top active niche × city, top service × city, "who is <firm name>?"
export function detectMention(answer: string, firmName: string, domain: string): boolean
export async function runAiProbe(input: { schema: SessionSchema; firmName: string; domain: string; ctx: TokenContext }): Promise<ProbeResult[] | null>
```

**Review:**
- Call `generateMbpJson<AiReviewOutput>(suffix, validateReview, 6000, ctx, { providerOptions: BACKGROUND_MEDIUM_PROVIDER_OPTIONS, cachePrefix: prefix, attempts: 2 })`.
- The prefix holds the instructions plus the five-audience definitions plus `AI_CHECKS` and their questions.
- The suffix holds the firm name, `serializeSchemaFull(schema)` capped at 6,000 chars, a page list (url | title | h1 | first 400 chars of text, max 25 pages, prioritized by kind and niche/service matches), and the deterministic check results (id/status/detail).
- Instructions:
  - Judge each AI check.
  - Write the overview (3–5 sentences, addressed to the firm as "your site") and per audience 2–4 wins and 2–3 opportunities.
  - Every win must cite a passing check id or a page URL from the list.
  - No invented facts, no metrics not given, and no mention of Revaltus internals.
- `validateReview` coerces arrays, drops judgments with unknown check ids, clamps wins to 4 and opportunities to 3, and returns null if the overview is empty.

**Probe:**
- Per question, call `generateText({ model: anthropic(PUBLISHED_CONTENT_MODEL), tools: { web_search: anthropic.tools.webSearch_20260209({ maxUses: 3 }) }, prompt: question + ' Answer briefly, naming specific firms.', providerOptions: BACKGROUND_MEDIUM_PROVIDER_OPTIONS, maxOutputTokens: 3000, abortSignal: AbortSignal.timeout(90_000) })`.
- Record usage. `mentioned = detectMention(text, firmName, domain)`. `snippet` = the sentence containing the mention (≤240 chars), otherwise the first 240 chars. `citedUrl` = the first `sources` url on the firm's domain, otherwise null.
- Any throw for one question → skip that question. All failed → null.

- [ ] Write failing tests:
  - `validateReview` with good, partial (unknown ids dropped) and garbage input (null);
  - `buildReviewPrompt`: the prefix contains no firm name or URL (cache safety), and the suffix never contains `mbp_content` or `_meta`;
  - `buildProbeQuestions` with and without niches/city;
  - `detectMention` matches the firm name ignoring case and a "CPA"/"LLC"/"PLLC" suffix, plus the domain.
- [ ] Implement, pass, commit.

### Task 7: Orchestrator + runAudit option + dev script

**Files:**
- Modify: `types/audit-result.ts` (`RunAuditInput.skipIntelligence?: boolean`), `lib/audit/index.ts` (skip the intelligence block when set)
- Create: `lib/visibility/run.ts`, `lib/visibility/run.test.ts`, `scripts/run-visibility-report.ts`

**Produces:**

```ts
export type VisibilityStage = 'crawling' | 'analyzing' | 'evidence' | 'reviewing' | 'scoring'
export async function runVisibilityReport(input: {
  url: string; schema: SessionSchema; firmName: string; isLiveDomain: boolean
  ctx: TokenContext; deadline: number; onProgress?: (stage: VisibilityStage, detail: string) => Promise<void>
}): Promise<{ result: VisibilityResult; narrative: VisibilityNarrative }>
```

Flow:
1. `runAudit({ url, maxPages: 60, skipIntelligence: true, deadline: deadline - 150_000, onProgress → map stages })`.
2. `buildSiteIndex(audit.raw.pages, audit.raw.analyzed)`.
3. `Promise.all` over ranks (only if live), GBP via `lookupPlace(firmName, { location: primaryCity })` (only if live), and the probe (only if live). Each is wrapped so it never rejects.
4. Run a deterministic `evaluateRubric` with `ai:null` to get the check list for the prompt.
5. `runAiReview`.
6. Run the final `evaluateRubric` with the AI judgments.
7. `scoreAll`.
8. The narrative is the AI narrative, or a fallback: overview "Report generated without AI commentary." and, per audience, wins = labels of passing checks (≤3) and opportunities = labels of failing checks (≤3).
9. `unavailable` lists the skipped or failed pieces.

- [ ] Write a failing `run.test.ts` with `runAudit`, the AI and external modules mocked: a staging run skips ranks, GBP and probe (`unavailable` includes them) and still returns scores; a null AI review produces the fallback narrative.
- [ ] Implement. Add `skipIntelligence` to `runAudit`, plus one test asserting `buildIntelligence` isn't called (extend `lib/audit/index.test.ts`).
- [ ] Write `scripts/run-visibility-report.ts <sessionId> [url]`: it loads the session via the service client, runs the report, and prints the audience scores, check table, narrative and token totals. It writes nothing to the DB.
- [ ] Run it against one live fleet site and one `*.vercel.app` URL. Sanity-check that evidence URLs are real pages and the review stays under 6k input tokens.
- [ ] Commit.

### Task 8: Worker, API routes, sweep

**Files:**
- Create:
  - `lib/visibility/worker.ts`, `lib/visibility/report-url.ts` (+ test)
  - `app/api/visibility-reports/route.ts` (POST create)
  - `app/api/visibility-reports/[id]/route.ts` (GET, PATCH)
  - `app/api/visibility-reports/[id]/run/route.ts`
  - `app/api/visibility-reports/[id]/publish/route.ts` (POST publish, DELETE unpublish)
  - `app/api/visibility-reports/[id]/pdf/route.ts`
  - `app/api/visibility-reports/route.test.ts`, `app/api/visibility-reports/[id]/route.test.ts`
- Modify: `app/api/cron/sweep-stuck-jobs/route.ts`

**Produces:**
- `resolveDefaultReportUrl(session, job): Promise<{ url: string | null; source: 'live' | 'preview' | 'website' }>`. The order is `sessions.live_site_url` → `resolvePreviewSiteUrl({jobId, githubRepo})` when the job has a repo → `sessions.website_url`.
- `loadReportForUser(id)`: fetches `session_id`, then `requireOnboardingSessionAccess`. Returns `{ user, report } | NextResponse` (404 when missing).
- `runVisibilityJob(id)`: mirrors `lib/audit/worker.ts`. It loads the row and session, sets `status='running'` progress via `status_detail` (throttled 1.5s), runs with `deadline = now + 560_000`, then writes `status='draft'`, `result`, `narrative`, scores, `rubric_version` and `completed_at`; on a throw it writes `status='error'` and `error`.

Routes:
- `POST /api/visibility-reports` takes `{ sessionId: string; url: string; saveAsLiveUrl: boolean; isLiveDomain?: boolean }`.
  - It validates the UUID and gates, then normalizes with `normalizeInputUrl`.
  - It rejects the URL with a 400 unless `await isUrlPubliclyFetchable(url)` (`lib/audit/ssrf-guard.ts`).
  - It updates `sessions.live_site_url` when `saveAsLiveUrl` is set, and inserts a queued row (`is_live_domain = body.isLiveDomain ?? isLiveHost(url)`, `created_by`).
  - Returns `{ id }` with status 201.
- `POST /[id]/run` does the atomic claim: `.update({status:'running', started_at, attempts: row.attempts+1, error:null}).eq('id',id).in('status',['queued','error'])`. Then `after(() => runVisibilityJob(id))`, `maxDuration = 600`, `runtime = 'nodejs'`. A failed claim returns `{status:'skipped'}`.
- `GET /[id]` → `{ report }`, for polling.
- `PATCH /[id]` takes `{ narrative: VisibilityNarrative }`. It returns 409 unless status is `draft`, and validates it with `validateNarrative` from `lib/visibility/narrative.ts`: overview ≤2000 chars, 5 audiences, wins ≤4 and opportunities ≤3 of ≤400 chars each.
- `POST /[id]/publish` returns 409 unless `draft`.
  - It renders the PDF (Task 11) and uploads it to `pdfs/{sessionId}/visibility-{id}.pdf` with `upsert:true`.
  - Then it sets `status='published'`, `share_token=crypto.randomUUID()`, `published_at`, `published_by`, `pdf_path`.
  - A PDF failure is a 500 via `internalError`, and the report stays a draft.
- `DELETE /[id]/publish` → `status='draft'`, `share_token=null`, `published_at=null`.
- `GET /[id]/pdf` → `{ url }` from `createSignedUrl(pdf_path, 3600)`, admin-gated. The public page gets its PDF link via the same route with `?token=` (allowed when the token matches a published row).

Sweep: add `visibility_reports` status `running` with `started_at < cutoff` → `error`, 'Report timed out (swept by cron)', into the existing `Promise.all`, and extend the destructured tuple and log.

- [ ] Write failing route tests (mock pattern from `app/api/blog-batches/[id]/route.test.ts`):
  - create: an editor is 403, an unassigned manager is 403, an admin gets 201;
  - `saveAsLiveUrl` writes `sessions`;
  - a `localhost` URL is 400;
  - PATCH on `published` is 409; a bad narrative shape is 400.
- [ ] Write `report-url.test.ts` covering the three fallbacks.
- [ ] Implement, then run tsc, the tests and the greps. Commit.

### Task 9: Admin UI — panel, run dialog, draft editor

**Files:**
- Modify: `app/admin/content/[id]/page.tsx` (add a "Visibility reports" card linking to the list, same markup as the "Pricing calculator" card)
- Create:
  - `app/admin/content/[id]/visibility/page.tsx`: a server component; same access block as the parent page.
  - `components/visibility/RunReportDialog.tsx` (client)
  - `components/visibility/ReportList.tsx` (client; polls running rows every 4s via `GET /api/visibility-reports/[id]`, then `router.refresh()`)
  - `app/admin/content/[id]/visibility/[reportId]/page.tsx`
  - `components/visibility/NarrativeEditor.tsx` (client)
  - `components/visibility/AudienceArc.tsx` (shared server/client SVG)
  - `components/visibility/AudienceSection.tsx` (shared)
  - `components/visibility/CheckAppendix.tsx` (shared, `<details>`)
- Modify: `app/globals.css` `@theme`, adding the deck colours:
  - `--color-aud-prospects: #F2BE45`
  - `--color-aud-clients: #74AFC8`
  - `--color-aud-talent: #EE9444`
  - `--color-aud-search: #9FA878`
  - `--color-aud-ai: #968592`

**List page:**
- Header: the firm name. A "Run visibility report" pill button opens `RunReportDialog`.
- The dialog has a URL input pre-filled from `resolveDefaultReportUrl` (with its source shown, e.g. "from staging preview"), a "Save as this client's live URL" checkbox (checked), and a "This is the live domain" checkbox defaulting to `isLiveHost(url)`. It warns: "Staging addresses skip Google rank, Business Profile and AI-answer checks."
- On submit it calls POST create, then POST run, then refreshes.
- The table shows date, URL, status chip (`status_detail` while running), overall, five audience score chips (bg `aud-*` tokens) and an Open link.

**Detail page:**
- `AudienceArc` and the overall score.
- `NarrativeEditor`: textareas for the overview and each audience's wins and opportunities as line lists, with Save → PATCH and an "unsaved changes" guard. It's read-only when published.
- `AudienceSection` ×5 showing checks and evidence links.
- `CheckAppendix`.
- Actions: Publish (draft) / Unpublish + Copy share link + Download PDF (published).

**AudienceArc:** an inline SVG semicircle of 5 bands in deck order (left to right: 4 search, 3 talent, 1 prospects, 2 clients, 5 ai). Each band is filled `var(--color-aud-*)`, with an opacity of 0.35 + 0.65·score/100 (null = 0.15), a numbered marker and a centre circle holding the overall score. Pure function of `AudienceScores`.

- [ ] Build it. Follow `raw-docs/design.md`: pill buttons, brand tokens, no hex in JSX. Run the Component Checklist.
- [ ] Do a dev-server check via the `run` skill: open the list → run against a fleet site → watch it reach draft → edit → save.
- [ ] Commit.

### Task 10: Public share page

**Files:** Create `app/visibility/[token]/page.tsx`, `components/visibility/PublicReport.tsx`

- [ ] The server page looks up `visibility_reports` by `share_token`. If it's not published or has no result → `notFound()`. Set `metadata` robots noindex and `runtime='nodejs'`.
- [ ] Load the trend: the same `session_id`, `status='published'`, the same `rubric_version`, ordered by `published_at`, at most 8 rows, taking only `published_at, overall_score, audience_scores`.
- [ ] `PublicReport` renders, in order:
  - Revaltus logo header (`/public/logo-white.svg` on a navy band) and "Visibility Report — {firm} · {date}";
  - `AudienceArc`;
  - the overview;
  - five `AudienceSection`s (number badge in the audience colour, question, score/grade, wins, opportunities);
  - a trend table/sparkline per audience when there are ≥2 points;
  - `CheckAppendix` collapsed;
  - a "Download PDF" link to `/api/visibility-reports/{id}/pdf?token=…`.
- [ ] Verify while logged out in the browser; an unpublished token gives a 404.
- [ ] Commit.

### Task 11: PDF

**Files:**
- Create: `lib/pdf/visibility/palette.ts` (hex mirror of the `aud-*` + brand tokens, with a comment pointing at `globals.css`), `lib/pdf/visibility/VisibilityPdf.tsx`, `lib/pdf/visibility/render.ts` (`renderVisibilityPdf(result, narrative, firmName): Promise<Buffer>`), `lib/pdf/visibility/render.test.ts`

**Contents:**
- Cover page: firm, date, URL, overall score, five audience scores as coloured rows (react-pdf `Svg` arc is optional; rows are acceptable).
- Overview page.
- One page per audience: question, score, wins, opportunities, check list with ✓/~/✗.
- No images embedded.

- [ ] Write a failing test: the render returns a Buffer starting with `%PDF`, using a fixture result.
- [ ] Implement it and wire it into publish (Task 8). The routes use `runtime='nodejs'`.
- [ ] Commit.

### Task 12: Final verification

- [ ] `npx tsc --noEmit`, `npx vitest run`, `npm run lint`, and the three CLAUDE.md greps.
- [ ] End to end in the browser on a fleet client:
  1. Run against the live domain.
  2. The draft appears in under 10 minutes.
  3. Edit an opportunity, then save.
  4. Publish.
  5. Open the share link in a logged-out window and download the PDF.
  6. Run a second report and publish it; the trend shows 2 points.
  7. Unpublish the first; its link now gives a 404.
- [ ] Check that the Token Usage dashboard shows the `visibility` stage with non-zero cost.
- [ ] Update CLAUDE.md with a short "Visibility Report" section (gate, table, rubric versioning, non-fatal externals), plus the memory file. Commit.
