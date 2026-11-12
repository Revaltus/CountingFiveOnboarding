# Visibility Report — design spec (2026-11-10)

## Context
The pre-sale Site Audit (`lib/audit/*`, `audit_runs`) grades a prospect's *old* site across 10 technical categories. Once Revaltus has rebuilt the site, we have no way to re-measure it, tie the result to the client, or show progress over time. The Revaltus story is moving to five audiences, from the PASBA deck, revised by the 2026-10 Revaltus brochure: **Prospective clients · Ideal niche clients · Future talent & partners · Google search · AI discovery**. We need a client-facing **Visibility Report** that:
- scores the rebuilt site for each of those five audiences, with an overview;
- belongs to the client (`sessions` row, run from `/admin/content/[id]`);
- is kept as a history of reports.

Decisions so far:
- **Reader:** the client. The report is a share-link web page plus a PDF.
- **Scoring:** hybrid. Existing audit checks are regrouped by audience, plus new checks and an AI read grounded in the MBP.
- **Baseline:** none from the pre-sale audit. The first post-launch report is the baseline, and later reports trend against it.
- **Running:** manual. An operator clicks a button on the client.
- **URL:** saved as a new client "live site URL", editable in the run dialog. Each report also stores the exact URL it audited.
- **Each audience section:** score + grade, 2–4 "what's working" highlights with evidence, 2–3 "next opportunities", and a collapsible appendix of checks.
- **Review:** draft → the operator edits → Publish. Publishing freezes the snapshot and enables the share link and PDF.
- **Access:** admins, plus managers assigned to that client.
- **Outside evidence in v1:** Serper keyword ranks, an AI answer probe, and Google Business Profile rating and reviews. GSC/GA4 is listed as future work, because not every site is connected yet.

## Approach (recommended): new `visibility_reports` subsystem that reuses the audit engine as a library
**Alternative rejected:** extending `audit_runs` with a "visibility" kind. Its history is keyed by domain + creator, its access is built for auditors, and it carries folder semantics. Mixing a client-owned report into it would muddy both features. We reuse the *code* (crawl, analyze, PageSpeed, Places, Serper), not the table.

### 1. Data — migration `087_visibility_reports.sql` (copy it into the main `supabase/`, then regenerate `types/database.ts`)
- `sessions.live_site_url text null`, the operator-confirmed URL for the rebuilt site.
- `visibility_reports`:
  - Identity and link: `id uuid pk default gen_random_uuid()`, `session_id uuid fk`.
  - What was audited: `url`, `domain`, `is_live_domain bool`. This is false for `*.vercel.app` and staging addresses; when false, the rank checks and AI probe are skipped and marked "available after launch".
  - Status: `status` = `queued|running|draft|published|error`, plus `error text`, `attempts`.
  - Scores: `rubric_version text`, `overall_score`, `audience_scores jsonb` (`{audience: {score, grade}}`).
  - Content: `result jsonb` (typed `VisibilityResult`: checks, evidence, AI judgments, ranks, probe answers) and `narrative jsonb` (overview plus per-audience wins and opportunities; the AI draft, then operator edits).
  - Publishing: `share_token uuid null`, `published_at`, `published_by`, `pdf_path`.
  - Audit trail: `created_by`, timestamps.
  - RLS: admin-membership policy, same as other tables. App code does the scoping.
- Trends only compare reports with the same `rubric_version`. A rubric change starts a new trend line, and the UI labels it.

### 2. Engine — `lib/visibility/`
- **`run.ts` `runVisibilityReport(input)`** is the orchestrator and has no DB access, mirroring `lib/audit/index.ts runAudit`.
  - Add a `skipIntelligence` option to `RunAuditInput`, then call `runAudit()` for the crawl, analysis and the 10 category scores and findings. We don't need prospect intelligence here.
  - In parallel, run `places-lookup.ts` (GBP rating and reviews) and Serper ranks.
  - Then run the AI review and the probe, then score.
- **`rubric.ts`** holds pure, versioned checks per audience: `{id, audience, label, weight, evaluate(ctx) → pass|partial|fail|n/a + evidenceUrl}`. `ctx` = the audit result + `SessionSchema` + external evidence + AI judgments.
  1. **Prospective clients:** each MBP service has a page; CTA, contact and phone on key pages; mobile performance and UX; AI read: "do the pages explain your services, who you help, and how to begin?"
  2. **Ideal niche clients** (rubric 2026.11.3, replaced Existing clients): each MBP niche has a page; articles/resources cover each niche; resource freshness (latest post date); industry pages name a team member; success stories; AI read: "do industry pages show knowledge of the industry, its challenges, and the work you do?"
  3. **Future talent & partners:** careers page, open roles or an apply path, `JobPosting` schema; team bios with headshots and credentials; culture and values; affiliations and partner path; succession, M&A or investment content.
  4. **Google search:** onpage_seo, indexability, technical, performance, local_seo, LocalBusiness schema (audit findings); Serper rank for each MBP `targetKeywords` × primary city (≤10 queries); GBP rating and review count.
  5. **AI discovery:** the ai_llm category; llms.txt; AI crawlers allowed; Organization, FAQ and Person schema; entity clarity (the About page and MBP positioning agree, judged by AI); the AI answer probe.
- **`ai-review.ts`** makes one `PUBLISHED_CONTENT_MODEL` call with `GENERATION_PROVIDER_OPTIONS` and `buildCachedMessages`.
  - Input: page summaries plus `serializeSchema(schema_data)` with `_meta` stripped. Never `mbp_content`.
  - Output: per-check AI judgments with evidence URLs, plus a draft overview and per-audience wins and opportunities.
  - Wins and opportunities must cite a check or evidence; nothing the evidence doesn't support.
  - Record usage with `recordTokenUsage({...extractCacheUsage(usage)})`.
- **`ai-probe.ts`** asks 3 MBP-derived buyer questions using Anthropic web search, then records whether the firm is mentioned, a snippet, and the cited URL. It only runs when the URL is the live domain.
- **`lib/audit/serper-search.ts`** gets a `rankFor(query, domain)` helper.

### 3. Routes. Gate first: `requireSessionAccess(sessionId)`, then admin or `hasCapability(user,'manager')`
- `POST /api/visibility-reports` takes `{sessionId, url, saveAsLiveUrl}`. It normalizes the URL, runs the SSRF guard, optionally saves `sessions.live_site_url`, inserts a `queued` row and returns `id`.
- `POST /api/visibility-reports/[id]/run` claims the row atomically (`.neq('status','running')`) and runs the worker in `after()` with `maxDuration` 600 and a soft deadline, mirroring `app/api/audits/[id]/run` and `lib/audit/worker.ts`. It ends as `draft` or `error`.
- `GET /api/visibility-reports/[id]/status` is for polling, using the progress bar primitive (`task_progress`).
- `PATCH /api/visibility-reports/[id]` edits `narrative`, and only while the report is a draft.
- `POST /api/visibility-reports/[id]/publish` sets `share_token`, `published_*`, and renders and uploads the PDF to `pdfs/{sessionId}/visibility-{id}.pdf` (`upsert`, `runtime='nodejs'`). `unpublish` clears the token.
- `GET /api/visibility-reports/[id]/pdf` returns a signed URL.
- `sweep-stuck-jobs` cron: a report stuck in `running` for more than 15 minutes becomes `error`.
- 5xx responses go through `internalError()`.

### 4. UI
- **`/admin/content/[id]`** gets a "Visibility Reports" panel:
  - a list of reports (date, URL, overall score, five audience chips, status) and a small trend per audience;
  - a **Run visibility report** dialog. The URL is pre-filled from `live_site_url`, then `resolvePreviewSiteUrl`, then `website_url`. It warns when the URL is a staging host, and has a "Save as live URL" checkbox, on by default.
- **Draft editor** at `/admin/content/[id]/visibility/[reportId]`: an inline-editable overview and per-audience wins and opportunities, the check appendix, and Publish / Unpublish / Copy link / Download PDF.
- **Public page** at `app/visibility/[token]/page.tsx`, Revaltus-branded in the deck style:
  - the five-band arc graphic as an inline SVG, coloured by score;
  - the overview, then one section per audience in deck order, each with its question ("Can you help with what I need?", …);
  - the trend vs earlier published reports;
  - "Coming soon: Search Console & Analytics" omitted until it's built.
- New audience colour tokens (yellow, blue, orange, olive, mauve from the deck) go in `app/globals.css` / the tailwind config. No hex in JSX.
- The PDF uses `@react-pdf/renderer` components in `lib/pdf/visibility/`, built from the same `VisibilityResult` + `narrative`.

### Reuse
- `lib/audit/index.ts runAudit`, `crawl.ts`, `ssrf-guard.ts`, `places-lookup.ts`, `serper-search.ts`, `scoring.ts getGrade`
- `lib/theme-preview/site-url.ts resolvePreviewSiteUrl`
- `lib/auth/access.ts` gates
- `lib/content/cache-control.ts`, `generation-tuning.ts`, `token-pricing` recording
- the audit share-token pattern (`app/audits/[token]`)
- the existing `lib/pdf` setup and progress-bar primitive (migration 057)

### Out of scope (logged as future work)
- GSC/GA4 integration (real impressions and traffic)
- scheduled runs and email delivery
- a pre-sale baseline comparison
- a Site Owner in-editor view of their reports
- revising the pre-sale audit into the five-audience format

## Build order
1. Migration + types + `rubric.ts` + `run.ts` + AI review/probe/ranks, with unit tests. Run it from a script against one live fleet site.
2. Routes + worker + sweep, then the admin panel, run dialog and draft editor.
3. Publish → public share page + PDF.
4. Trend view.

Next: implementation plan via writing-plans.

## Verification
- Unit tests:
  - `rubric.ts`: every check has pass, fail and n/a fixtures, including a staging URL, which skips ranks and the probe.
  - URL resolution order.
  - Route gates: a manager on a different client gets 403, an editor gets 403, an admin passes.
- `npx tsx scripts/run-visibility-report.ts <sessionId> <url>` against one live client and one staging URL. Check that scores, evidence URLs and the AI narrative cite real pages, and that token usage is logged and the AI review stays under 6k input tokens.
- In the browser, end to end on prod-like data: run → draft → edit → publish → open the share link logged out → download the PDF → run a second report → the trend shows two points.
- `npx tsc --noEmit`, `npm test`, plus the CLAUDE.md pre-commit greps (service key, `console.log`).

## Resolved details (spec self-review)
- **Live vs staging:** `is_live_domain` = the host is not `*.vercel.app`, not `localhost`, and not an IP address. The run dialog shows this and lets the operator override it.
- **Primary city for rank queries:** `locations[0]` city → `serviceAreas[0]` → no geo modifier.
- **Keyword cap:** the first 10 `targetKeywords` after de-duplication. With no keywords, the check is `n/a`, not a fail.
- **Access:** `editor` and `owner` capabilities get 403 on every visibility route in v1.
- **Published reports are immutable.** To change one, unpublish it (which returns it to draft and removes the link), edit, then re-publish. Re-publishing issues a new `share_token`.
- **AI probe tool:** Anthropic's server-side web search through `@ai-sdk/anthropic`. If the installed SDK doesn't expose it, the probe is shown as "unavailable" and the report still completes. Like WHOIS, a failure here is never fatal.
- **Scoring math:** audience score = the weighted share of applicable checks, where pass = 1, partial = 0.5 and `n/a` checks are excluded. Overall score = the mean of the five audience scores. Grade = `getGrade()`.
