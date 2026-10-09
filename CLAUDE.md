# Revaltus Onboarding Agent — Project Rules

This file is read by AI coding assistants before working on this codebase. Follow all rules below without exception.

---

## Stack

- **Framework:** Next.js 16 (App Router, TypeScript; `proxy.ts` is the middleware convention)
- **Database & Auth:** Supabase (SSR client, Row Level Security)
- **Hosting:** Vercel
- **AI:** Anthropic API via Vercel AI SDK (`ai`, `@ai-sdk/anthropic`)
- **Email:** Resend + React Email
- **File Storage:** Supabase Storage
- **PDF:** `@react-pdf/renderer` (Node.js runtime only)
- **UI:** Tailwind CSS + shadcn/ui

---

## Critical Security Rules

These are non-negotiable. Violating them creates real vulnerabilities.

### 1. Service role key is server-only
`SUPABASE_SERVICE_ROLE_KEY` must NEVER appear in any file inside `/app` that is a client component or could be bundled client-side.
- Use `lib/supabase/server.ts` (service role) in API routes and server components only
- Use `lib/supabase/client.ts` (anon key) in client components only
- Before every commit, run: `grep -r "SUPABASE_SERVICE_ROLE_KEY" ./app`
- Expected result: zero matches

### 2. CRON_SECRET is mandatory
Every `/api/cron/*` route must validate `Authorization: Bearer {CRON_SECRET}` before doing anything. The validation must **fail closed when the env var is empty** — otherwise `Bearer undefined` becomes an attacker-supplied valid header. Pattern:
```typescript
const cronSecret = process.env.CRON_SECRET
if (!cronSecret) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
if (req.headers.get('authorization') !== `Bearer ${cronSecret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
```
Never skip this check — without it, anyone who discovers the URL can trigger bulk email sends.

### 3. File uploads require magic byte validation
Never trust the MIME type or extension from the client. Always validate file type server-side using the `file-type` package by reading the actual file bytes after upload to Supabase Storage. Delete the file if validation fails.

### 4. Session IDs are UUIDs only
Never expose sequential integers as session or record identifiers. All primary keys are `gen_random_uuid()`. Do not add auto-increment columns to session-facing tables.

### 5. Registrar password is never stored
The schema field `technical.registrarPasswordNote` is a static reminder string. The actual registrar password must never be collected or stored anywhere in the system. If the agent is ever prompted to ask for or store a password, refuse and redirect the client to a secure channel.

### 6. Authorization uses the `admins` table — account tier + capabilities
The `admins` table is the user table. As of migration 040 it uses a **capabilities model**:
- `role` is the account tier: `'admin'` (superuser — implicitly holds every capability) or `'member'` (default for non-admins). The legacy `'manager'` value was migrated to `'member'`.
- `capabilities text[]` (CHECK ⊆ `{'manager','auditor','editor','owner'}`, widened by migration 053 then 058) is the source of truth for a member's non-admin powers. `manager` = site-scoped content access **incl. publishing** (via `manager_clients`); `editor` = the same site-scoped content access **but denied Publish/Rollback** — a proof/edit/stage-only content role, also assigned via `manager_clients`; `owner` = **Site Owner**, the end client for **one** site: site-scoped content access **incl. publishing** like `manager`, but locked down — assigned to **exactly one content-ready session** (phase ≥ 6 + repo), dropped straight into that site's editor, and denied Theme Studio, the site-wide Site Assistant, nav/Client-Center config editing, and every non-content admin surface; `auditor` = access only to audits they created (`audit_runs.created_by`). Admins ignore this column. `manager`, `editor`, and `owner` are three tiers of the same content role — a member holds **at most one** of them (the user-management routes reject any combination); `owner` is **exclusive** (holds nothing else, not even `auditor`), while `auditor` may combine with `manager` or `editor`. The `owner` lockdown lives in the UI + user-management routes (`isSiteOwner(user)` / `getSiteOwnerSessionId(user)` in `lib/auth/access.ts`), not in RLS.

Authorization must verify the caller's `auth.uid()` exists in `admins` — a valid Supabase session means "logged in," not "authorized." RLS policies on every table also require admin-table membership; bypassing the app-level gate does not bypass RLS.

Use the gates in `lib/auth/access.ts` (all return `{ ... } | NextResponse`, same convention as `requireAdmin()`):
- `requireAdminUser()` — admin-only (403s members). Use for user management, session creation (incl. audit `approve`/`draft-session`/`start-session`), and destructive/global routes.
- `requireSessionAccess(sessionId)` — admins pass; otherwise requires a **content capability** (`manager`, `editor`, **or** `owner`, via `hasContentAccess()`) AND a `manager_clients` link to that session. Gates the whole draft editor (`/api/edit/*` via `resolveEditContext`) and all session-scoped content routes. The two live-mutating editor routes (`/api/edit/[id]/publish`, `/rollback`) additionally call `canPublish(user)` (admin, `manager`, or `owner`) to keep editors from pushing to live. The per-page AI editor (`/api/edit/[id]/chat`) is further limited to admins and Site Owners (`isSiteOwner`) — managers/editors don't get it.
- `requireContentJobAccess(jobId)` — resolves the job's `session_id`, then requires the `manager` capability (content-job (re)generation can overwrite live content, so `editor` and `owner` are intentionally NOT admitted here).
- `requireAuditorCapability()` — admins pass; otherwise requires the `auditor` capability (gate for audit list/create, before a specific audit exists).
- `requireAuditAccess(auditId)` — admins pass; otherwise requires the `auditor` capability AND ownership (`audit_runs.created_by === user.id`).
- `getCurrentUser()` → `{ id, email, role, isAdmin, capabilities }`. Branch on `isAdmin` / `hasCapability(user, cap)` / `hasContentAccess(user)` / `canPublish(user)` / `isSiteOwner(user)`, not on `role` strings. `getAccessibleSessionIds(user)` (admins → `null` = all; content-capable member (manager, editor, or owner) → assigned ids; else `[]`) and `getAccessibleAuditScope(user)` (admins → `null`; else `{ createdBy }`) scope list/detail server components. A Site Owner's post-login landing and cross-site guards use `getSiteOwnerSessionId(user)` (their single assigned session).

`requireAdmin()` in `lib/auth/require-admin.ts` is the legacy authenticate-and-check-membership gate (no role distinction); prefer the `access.ts` gates above for new code.

**Scoping is enforced in app code** (API routes use the service-role client, which bypasses RLS). `manager_clients` (migration 030) is the many-to-many grant of managers → sessions; auditor scope reuses `audit_runs.created_by` (no join table).

When adding the first admin (or after migration 016 wipes loose policies), seed the table manually:
```sql
INSERT INTO admins (id, email, name, role) VALUES ('<auth.users.id-uuid>', 'you@example.com', 'Your Name', 'admin');
```

### 7. The `session-assets` bucket is private — never write public URLs
Storage paths under `sessions/{sessionId}/` are private. `assets.public_url` is nullable; new inserts MUST write `null`. Admin UIs that render asset thumbnails take server-signed URLs from their parent server component (1-hour TTL via `supabase.storage.from('session-assets').createSignedUrl(path, 3600)`). Calling `.getPublicUrl()` on this bucket is forbidden.

### 8. File paths from clients are decoded before validation
Any route that accepts a file path in a query param or JSON body MUST decode-then-normalize before any `startsWith` / prefix check. `content/..%2F..%2Fetc/passwd` passes a raw `startsWith('content/')` check but escapes the root after decoding. Use the helper in `app/api/edit/[id]/_path.ts` (or mirror its pattern).

---

## Architecture Rules

### Client vs. Server Components
- Default to Server Components. Only add `'use client'` when you need browser APIs, hooks (`useState`, `useEffect`), or event handlers.
- Never fetch data in client components directly from Supabase — use server actions or API routes instead.
- The `ChatInterface` component is a client component (uses `useChat`) — keep its data loading in the parent server component (`app/session/[id]/page.tsx`).

### API Route Patterns
- All routes that touch Supabase session data use the service role client (`lib/supabase/server.ts`)
- Admin API routes must gate as the first step with the helpers in `lib/auth/access.ts`: `requireAdminUser()` for admin-only routes, `requireSessionAccess(sessionId)` for routes a content-capable member (manager, editor, or owner) may also use (add a `canPublish(user)` check for any route that pushes to live), `requireContentJobAccess(jobId)` for manager-only content-job routes, `requireAuditorCapability()` / `requireAuditAccess(auditId)` for audit routes an auditor may use (all return 401 unauthenticated, 403 unauthorized). See security rule 6.
- The client self-serve flow is retired (`app/session/[id]` is a static notice). `/api/chat` now requires `requireOnboardingSessionAccess`, and `/api/upload/*` requires `requireSessionAccess`. No session-data route is unauthenticated.
- 5xx responses never carry raw Supabase, GitHub or Storage error text. Use `internalError(context, err, publicMessage)` from `lib/api/errors.ts`. Typed domain errors (stale sha, not-found, validation) keep their deliberate 4xx messages.
- Every read-modify-write of `sessions.schema_data` or `gap_list` goes through `updateSessionWithCas()` (`lib/session/schema-cas.ts`). Keep its compute callback a pure function of the row it's given, and do any AI call or other slow work before calling it.
- Always return typed error responses: `{ error: string }` with appropriate HTTP status codes

### Database Access
- Never write raw SQL in application code. Use the Supabase JS client exclusively.
- Never use `any` for Supabase query results — import and use types from `types/database.ts`
- Regenerate `types/database.ts` after every schema migration: `npx supabase gen types typescript --project-id PROJECT_ID > types/database.ts`
- The `schema_data` column is JSONB typed as `SessionSchema` from `types/session-schema.ts` — never pass raw `any` objects when updating it
- When writing structured values to a JSONB column, use `asJson()` from `lib/supabase/json-typed.ts` instead of `as unknown as Json`. The helper centralizes the cast for grep-ability and signals intent.

### Supabase Storage
- All file reads from the `session-assets` bucket must use the service role client (bucket is private)
- Storage paths follow these conventions:
  - Client uploads: `sessions/{sessionId}/{uuid}-{filename}`
  - Generated PDFs: `pdfs/{sessionId}/intake-summary.pdf`
  - Design Studio images: `design/{sessionId}/{renders|inputs|runs|versions|attachments}/…webp` (WebP, long edge ≤ 1568; signed URLs only; never the `assets` table)
- Never make the `session-assets` bucket public
- `assets.public_url` is nullable and **new inserts must write `null`**. To show an asset in the admin UI, the parent server component signs a short-TTL URL with `createSignedUrl(path, 3600)` and passes a `signedUrls: Record<assetId, url>` map to the client component. See `app/admin/sessions/[id]/page.tsx` for the pattern.

---

## Claude / AI Integration Rules

### System Prompt Construction
- The system prompt is built fresh for every request in `lib/agent/system-prompt.ts`
- Always strip `_meta` from `schema_data` before passing to Claude — internal tracking must never appear in Claude's context
- Only include gap list instructions when `current_phase >= 4`
- Never include `mbp_content` (raw MBP text) in the system prompt — only the parsed `schema_data`
- Always run `serializeSchema()` to remove empty/null/blank fields before injecting schema into prompt

### Token Budget Targets (enforce during development)
Log token usage in every `onFinish` callback. Flag any exchange that exceeds these limits:

| Phase | Max input tokens | Model |
|---|---|---|
| Phase 1 | 1,000 | Haiku |
| Phase 3 | 3,500 | Sonnet |
| Phase 4 | 3,000 | Sonnet |
| Phase 5–6 | 1,500 | Haiku |

If any exchange exceeds 5,000 input tokens, stop and investigate before continuing.

Outline generation is a background job, not a chat. Its prompt carries the full firm profile, so it runs 4.0k–5.4k input tokens per outline, and about 4k of that is the cached prefix. Its warning threshold is 6,000 (`OUTLINE_INPUT_TOKEN_TARGET`). Check per-section sizes with `npx tsx scripts/measure-outline-prompt.ts <job-id>` after changing `buildOutlinePrompt` or `buildFirmContext`. `app/api/chat/route.ts` emits a `console.error` (`[token-budget] EXCEEDED ...`) when the estimated input tokens (chars/4) cross 5k — watch server logs for it.

### Model Selection
All model ids live in `lib/content/generation-tuning.ts` — import the constant, never hardcode an id.
Interactive chat (`/api/chat`) stays Sonnet/Haiku — never use Sonnet for phases 1, 2, 5, or 6:
```typescript
const modelId = [3, 4].includes(session.current_phase) ? INTERACTIVE_CHAT_MODEL : FAST_MODEL
```
Tier map (reviewed 2026-10-09 against the Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5 lineup):
- **Sonnet 5.5** (`PUBLISHED_CONTENT_MODEL`) — all async content writing: the published
  page-body generator (`lib/content/content-generator.ts`) and the audit→session draft
  (`lib/session-draft/draft-from-audit.ts`), plus outlines, sitemap proposal, MBP/draft JSON and
  text, SEO fields, social, and resource generation. $2/$10.
  - Replaced Sonnet 5 on 2026-09-30 (`scripts/compare-content-models.ts`, Opus-judged):
    - critic mean 7.64 vs 7.36
    - unsupported claims per page 3.0 vs 6.5
    - 97s vs 184s per page
    - $0.16 vs $0.22 per page
  - Sonnet 5 had replaced Opus 4.8 on 2026-06-30.
- **Sonnet 5.5** (`INTERACTIVE_CHAT_MODEL`) — every interactive chat: intake phases 3/4 and the
  audit/MBP/content-assistant/editor/site-assistant/theme/admin-assistant chats. Replaced Sonnet 5
  on 2026-09-30.
  - It defaults to adaptive thinking at effort `high`, which is too slow for chat, so every chat
    route MUST pass `chatProviderOptions('low'|'medium')`: `medium` for the page editor, site
    assistant and Design Studio chat, `low` elsewhere.
  - Thinking tokens count against `maxOutputTokens`, so leave headroom.
  - Chats use `display: 'summarized'` and stream reasoning to the UI. Sonnet 5.5 puts its notes
    between tool calls into thinking blocks, and the loading line shows the latest one via
    `latestProgressNote()` in `lib/ai/progress-note.ts`.
- **Opus 5.5** (`CRITIC_MODEL`) — the draft critic only (`lib/content/draft-critic.ts`). A
  different, stronger tier than the writer avoids self-grading bias; in an A/B on 5 live pages
  it caught 2-4x more ungrounded claims (e.g. invented service lines) and ran faster.
  `scripts/compare-critic-models.ts` re-runs that comparison.
- **Sonnet 5.5** (`QA_SPECIALIST_MODEL`) — QA Desk specialists (Accuracy, Copy Editor, SEO/GEO, Structure)
  in `lib/content/qa/specialists/`. The judge is `CRITIC_MODEL` (Opus 5.5), so no tier grades its own
  work. A/B with `scripts/compare-qa.ts`.
- **Haiku 5.5** (`FAST_MODEL`) — phase 1/2/5/6 intake chat and classification helpers (brand-fit,
  keyword, reverse-link, oneoff resolve, pricing seeds, article-import links, command bar).
  - Replaced Haiku 4.5 on 2026-10-09 (`scripts/compare-fast-models.ts`, brand-fit over 5 clients × 8 directions):
    39/40 agreement, 0 failures, 1.9s vs 2.6s per call, ~$0.0002 vs $0.0018 per call.
  - Every call passes `FAST_PROVIDER_OPTIONS` (thinking off) or `FAST_CHAT_PROVIDER_OPTIONS`;
    `lib/content/fast-model-options.test.ts` enforces it. Haiku 5.5 thinks adaptively by default,
    which adds latency and eats small `maxOutputTokens` caps. Adaptive at effort `low` had 3/40 failures.
  - Priced by prompt length: $0.10/$0.50 up to 100k prompt tokens, $0.50/$2.50 above (`longPrompt` in `PRICING`).
  - Its tokenizer counts ~30% more tokens than Haiku 4.5, so the phase 1/5–6 budgets above read ~30% higher.
- **Sonnet 5.5** (`DESIGN_MODEL`) — Design Studio concept generation and revision (admin-only,
  a few runs per client). Replaced Opus 5.5 on 2026-09-30 after the bblcpa A/B (3 concepts each,
  Sonnet 5 judge):
  - critic mean 3.89 vs 3.94, both 3/3 pass
  - 50s vs 127s per concept
  - generation $0.34 vs $1.17
  - The earlier 2026-09-26 A/B kept Opus 5.5 over Fable 5.1: Fable scored +0.09 at 2.3x the cost.
- **Opus 5.5** (`DESIGN_CRITIC_MODEL`) — Design Studio's vision critique, which gates
  keep/revise. It stays a stronger tier than `DESIGN_MODEL` so the generator never grades its own
  concepts. It's also the A/B script's default judge.
- **Fable 5.1** (`DESIGN_AB_CHALLENGER_MODEL`) — only the Design Studio A/B script
  (`scripts/compare-design-models.ts`, P7); never a production route at 5x Sonnet's price. The
  script judges both sides with `PUBLISHED_CONTENT_MODEL` (Sonnet 5.5) by default (`--critic`). When Sonnet 5.5 is itself a contender, pass a non-contender judge (e.g. `--critic claude-fable-5-1`); the script warns when the judge is a contender.

The async generation paths use adaptive thinking + `effort` via the shared
`GENERATION_PROVIDER_OPTIONS` in `lib/content/generation-tuning.ts`. Hard rules:
- Never send `GENERATION_PROVIDER_OPTIONS` (or any high-effort options) to a fast-tier call — use `FAST_PROVIDER_OPTIONS`.
- Haiku 5.5 rejects an assistant prefill (a final assistant turn), even with thinking off — end `messages` with a user turn.
- `budget_tokens` is deprecated — use `thinking: { type: 'adaptive' }`.
- Never set `temperature`/`top_p`/`top_k` — Sonnet 5.5 and Opus 5.5 return a 400 on non-default values.
- Sonnet 5.5 (like Opus 5.5) rejects forced tool use (`toolChoice`) and `thinking: { type: 'disabled' }`. Its lowest setting is `between_tools`.
- Opus 5.5 always thinks (thinking can't be disabled) and rejects forced tool use (`toolChoice`).
### Prompt Caching
All caching helpers live in `lib/content/cache-control.ts`.
- **Chats:** `chatProviderOptions()` / `FAST_CHAT_PROVIDER_OPTIONS` turn on request-level automatic caching, so tool-loop steps and follow-up turns re-read the prompt at 0.1x. Keep anything that changes per turn (e.g. the page being edited) in a LATER system block than the stable instructions, with a `CACHE_EPHEMERAL` breakpoint on the stable block — see `app/api/edit/[id]/chat/route.ts`.
- **Background generators:** use `buildCachedMessages(staticPrefix, dynamicSuffix, ttl)` or `generateMbpJson(..., { cachePrefix, cacheTtl })`. Every per-call value goes in the suffix; one leaked id or timestamp in the prefix defeats the cache.
- **TTL:** use `'1h'` when calls sharing a prefix land more than 5 minutes apart (cron-driven batches, impact reviews), otherwise the default `'5m'`.
- **Cost recording:** always pass `...extractCacheUsage(usage)` to `recordTokenUsage`, plus `cacheTtl: '1h'` for 1h breakpoints. Without them the dashboard prices cached reads at full rate.

Any new model id must also be added to the `PRICING` map in `lib/content/token-pricing.ts`,
or its spend silently records as $0 on the Token Usage dashboard. Models whose cache reads are
not 0.1x input (e.g. Opus 5.5 at 0.05x) set `cacheRead` on their entry.
`lib/content/token-pricing.test.ts` fails CI for any `claude-*` constant in `generation-tuning.ts` without an entry.

### Model review cadence
A model-fit review checks whether each tier above is still the best fit for quality and cost. It's due when `node scripts/model-check.mjs` flags any of these:
- a new model on Anthropic's Models API (not in `.audit/model-review.json` `knownModels`)
- an in-use model that the API no longer lists
- a `watch` entry with a retirement `date` under 30 days away (add the date once Anthropic announces one)
- 45 days since `lastReview`
- a model constant with no `PRICING` entry

How it runs:
- A SessionStart hook runs `model-check.mjs --hook`. When it flags, tell the user at session start and offer the review. Don't start one unprompted.
- A monthly scheduled cloud agent also posts a report-only review.
- Every tier change needs evidence from an A/B run before it ships:
  - writer: `scripts/compare-content-models.ts`
  - critic: `compare-critic-models.ts`
  - Design Studio: `compare-design-models.ts`
  - fast tier: `compare-fast-models.ts`
- A tier change also needs a `PRICING` entry, an SDK version that knows the model id (`@ai-sdk/anthropic`'s `getModelCapabilities` matches ids by prefix, so an unknown id silently inherits the older model's quirks), and an updated tier map above.
- After a review, run `node scripts/model-check.mjs --mark "<summary>"` and commit `.audit/model-review.json`.
- Chats never replay reasoning parts: `trimMessages()` strips them server-side, even though routes stream reasoning to the UI for progress notes. Sonnet 5.5 and later reject thinking blocks whose earlier context changed.

### Processing Flag Safety
The `processing` boolean in `sessions` prevents concurrent Claude calls. It MUST be set to `false` in both:
1. The `onFinish` callback (normal completion)
2. A `catch`/`finally` block (error or disconnect)

If this flag is not cleared, the session is permanently locked for the client. This is a critical bug.

### Tool Call Rules
- The `update_session_data` tool is the only way Claude should modify session state
- `advancePhase: true` should only be set when phase goals are genuinely complete — the server validates this
- Tool descriptions must stay concise (under 50 words per parameter description) to minimize token overhead

### MBP Improvement Confirmation (interactive AI content agents)
Any **interactive** AI agent that generates content (e.g. the Generate Content assistant in `lib/content/generate-content-prompt.ts` → `/api/content-assistant/[id]/chat`) MUST use **ask-then-file** when a durable MBP improvement surfaces: honor the rule/fact in the current reply, then **ask the operator to confirm** before calling any MBP-suggestion/update tool. Never silently mutate `schema_data` or auto-file an MBP suggestion from an interactive session. "Improvement" covers both facts (certs, services, titles, positioning) and brand-voice/writing rules (map avoid-rules like "no em-dashes/emojis" to `brand.toneToAvoid`). This applies to every current and future content-generating AI agent.
This does NOT apply to the **background** impact reviews (`reviewContentForMbpImpact`, `content-edit-review`) that run via `after()` with no user present — those continue to file pending suggestions for admin approval. The admin MBP editor chat (`/api/mbp/[id]/chat`) also **files pending suggestions** (origin `mbp_chat`, via its `suggest_mbp_update` tool → `insertMbpSuggestion`) rather than mutating `schema_data` directly — a human still approves every AI-proposed change in the "Suggested updates" panel. The only direct writes to `schema_data` are the operator's own manual inline field edits (PATCH `/api/sessions/[id]`), where the human typing *is* the check.

### Content Generation Concurrency
- `lib/content/content-generator.ts → generateSinglePage()` uses an atomic SQL guard: the `generation_status` is updated to `'running'` only if it's not already `'running'` (`.neq('generation_status', 'running')`). A second caller hitting the same outline-id while one is in flight gets `{ status: 'skipped' }`. Mirror this pattern for any future per-row pipeline worker.
- Stuck rows (status `running` for >15 min) are reset to `error` automatically by `/api/cron/sweep-stuck-jobs` every 5 minutes. Don't write manual recovery scripts for orphaned rows — extend the cron.

### QA Desk
- **Stage.** `generated_pages.qa_status` (queued/running/done/error/skipped) is claimed atomically like `generation_status`. QA runs per page in `/api/content-jobs/[id]/qa/run`, triggered with the CRON bearer.
- **Mode.** `CONTENT_QA_MODE=off|shadow|on` (unset = `shadow`). Prod runs `on` since 2026-10-06.
  - `shadow` only reports; the legacy critic still runs.
  - `on` applies `auto` findings, replaces the legacy critic step, and holds phase 5→6 + the content-ready email until QA is terminal.
- **Safety.** Specialists may only auto-fix kinds in their `allowedAuto`. Accuracy claims and section changes are always flags.
  - Patches apply one at a time through `applyFindReplace`, then the batch result is checked once with `checkEditAnnotations`. Any failure degrades to a flag.
  - Verbatim pages and verbatim bios never get body-text patches. Rules may still fix their layout variants and SEO meta fields.
  - In `on` mode patches only land while the job is in phase 5. A run after that (e.g. a retry) is report-only.
  - A judge that returns nothing on a non-verbatim page adds an open high `judge_unavailable` flag, which fails QA.
- **Human edits win.** Human writes call `fenceQaForHumanEdit` (one page) or `fenceQaForPages` (bulk, e.g. domain-rename). Both flip `queued|running|error` → `skipped`, which breaks the QA write fence.
- **Sweep.** `sweep-stuck-jobs` handles QA in this order:
  - errors QA `running` > 15 min;
  - flips approved pages still `queued|running|error` to `skipped`;
  - time-boxes `queued` rows unclaimed 30 min after generation to `error` with attempts at the cap (`normalizeQaHolds`, 100 rows max);
  - re-triggers stale `queued`/retriable `error` rows (cap `QA_MAX_ATTEMPTS`);
  - finishes jobs that were waiting on QA.
  In `on` mode a retriable `error` (attempts below the cap) still holds phase 6.
- **Apply/Dismiss.** The Apply/Dismiss route calls the `qa_apply_page_update` RPC (migration 084), which does a server-side md5+rev CAS — PostgREST can't filter on long text in the URL.

### Design Studio
Spec: `docs/superpowers/specs/2026-09-24-design-studio-design.md`. It replaced the template's retired `export-brief` → Claude Design workflow (removed 2026-09-26).
- Every `app/api/edit/[id]/design/**` route calls `requireDesignAdmin(id)` first (admin-only); the run step route alternatively takes the fail-closed `CRON_SECRET` bearer.
- **Capabilities:** gates (what a concept/chat may change, the 422 "locked" checks, the specimen pick) use the EFFECTIVE tier = draft `c5-template.json` ∩ the deployed shell's `<meta name="c5-capabilities">` (`readEffectiveCapabilities`). File-contract decisions (write/guard `src/app/fonts.generated.ts`, `applied_blobs`, drift paths) use the DRAFT marker. An unverified shell counts as the draft tier.
- `applied_blobs` = the four theme files, plus `src/app/fonts.generated.ts` on L2+ drafts. Every theme write on an L2+ draft regenerates the fonts module; never hand-edit it.
- Chat commits never sync the MBP. All writes go through `commitDesignVersion`.
- **Chat scope:** every design lever is site-wide. `lib/design/scope-guard.ts` refuses chat CSS that introduces a literal colour or a named font (use `var(--color-*)` / `set_fonts`) and warns on button rules in one block's fragment; the chat prompt's `SCOPE` section routes element-level requests to site-wide levers. The editor's Design drawer (`components/editor/DesignDrawer.tsx`) calls `POST /design/baseline` first so a chat commit never 409s for a missing v0.
- **Style coverage:** every visible surface a client site renders must sit inside a CSS target — a `data-block` in `OVERRIDE_BLOCKS` or a `data-component` in `CHROME_COMPONENTS` (both append-only) — or the chat can't reach it and styles a neighbour instead. A template release that adds a surface gives it a hook, appends the id, and adds a `lib/design/brief/block-catalog.ts` entry with `since` = that release (the vocabulary hides it from older sites). Verify with `node scripts/audit-style-coverage.mjs <site-url> <paths…>` — expect `TOTAL 0` (template 2026.09.11 + onboarding: 0 on 7 sites, 2026-09-28).
- The critic scores only the levers a concept controls (palette, type, tokens, treatments, style axes, scoped CSS) — never copy, images, layout, CTAs, the chat widget or the logo. Pass rule: every dimension ≥3, mean ≥3.8, distinctiveness ≥3 for keep/evolve palette freedom and ≥4 for free.
- Template contracts are byte-mirrored — copy, don't retype: `lib/content/__fixtures__/font-manifest.template.json` + fonts goldens, `lib/design/__fixtures__/style-axes.template.json`, `lib/design/__fixtures__/layout-presets.template.json`, and `lib/content/__fixtures__/blocks.template.json` must equal the template's `docs/design/*` files. Every template release that changes a block, variant or preset re-copies them.
- **Template version:** the effective template version = min(draft `c5-template.json`, the deployed shell's `<meta name="c5-template-version">`); a verified shell without the meta counts as 2026.09.8. Anything that offers block variants or layout presets (Studio brief, chat hints, the `layout-presets` gate) uses the effective version; the editor's per-section Layout picker and content validation use the DRAFT version (page content renders on the draft template). Compare versions only with `compareTemplateVersions` (numeric — `2026.09.10 > 2026.09.9`).
- **Block annotations:** every read/write of `<!-- block: … -->` comments goes through `lib/editor/block-annotation.ts` (field order `variant | image | alt | query | theme`, must match the template parser). Never hand-roll a new regex and never add annotation fields — new layouts are new `variant:` values in the block catalog (`lib/content/block-catalog.ts`, `since` = template version). Edits are validated with `checkEditAnnotations` (delta: only issues the edit introduces block it).
- **Layout presets:** `design.json.layout` (cards / ctaBanner / faq / team / testimonials) is a site-wide lever gated by the `layout-presets` capability (template ≥ 2026.09.9). An explicit per-section layout variant always wins over a preset. Layout-only Controls changes don't sync the MBP. Studio CSS may use `order` only on `[data-c5-slot="media"|"body"]` (reading-order guard).
- **Design locks** (`design_locks`, migration 085; `lib/design/locks.ts`, `lock-pins.ts`, `lock-enforce.ts`, `lock-ops.ts`). An admin locks either an AREA (one CSS target, site-wide per block type) or a LEVER (`palette|fonts|tokens|treatments|style|layout:<preset>`), via the chat's `lock_design`/`unlock_design` tools or the lock chips (`/design/locks`).
  - **Freezing a look:** an area lock snapshots the theme custom properties + font families at lock time. `composeLockPins` writes them as `:where([data-block=…])` rules into the region's `locks` fragment, FIRST in the region (zero specificity, so the block's own CSS still wins). Pinned families go in `design.json typography.pinnedFonts`, and the fonts module loads them as `--font-pin-<slug>`.
  - **Enforcement:** every versioned write recomputes the pins from the rows, and the lock pins are never authored by a model. `applyUserLocks` runs in `commitDesignVersion` and `validateConceptBundle` (chat + Studio concepts) and puts locked levers, locked areas' CSS (incl. their global-fragment selectors) and presets that re-lay out a locked area back to the draft's. The chat workspace refuses those edits up front with a "locked — ask the user" error. The Controls PATCH 422s a locked lever; area pins survive it untouched (the route never writes design-overrides.css).
  - A restore ignores locks (full rollback) and re-freezes every area lock to the restored look. Lock / unlock refuse while chat edits are staged.
  - The template's `generate-fonts --check` understands `pinnedFonts` from template 2026.09.12 on (rolled out to the fleet 2026-10-02). A site below it reports fonts-module drift in CI once it has an area lock.
- **The AI chat lives beside both Theme Studio tabs** (ThemeStudio owns one `DesignChat`, so Studio and Controls share one thread). Screenshots can be attached, pasted or dropped.

---

## Phase Logic Rules

### Phase Numbers
- **Development Phases 1–14:** The build phases defined in `raw-docs/dev-steps/` — these are the implementation steps
- **Agent Phases 0–7:** The conversation phases the client experiences — defined in `raw-docs/agent-conversation-flow.md`
- Never confuse these two numbering systems. "Phase 3" in a dev step file means development Phase 3 (admin auth). "Agent Phase 3" means the MBP review conversation.

### Phase Advancement
Phase advances are validated server-side in `updateSessionSchema`. Claude calling `advancePhase: true` is a request, not a guarantee. The server checks:
- Phase 1 → 2: `contact.email`, `contact.firstName`, `contact.phone`, and `websiteUrl` must all be set
- Phase 3 → 4: `_meta.phase3_completed_chunks` must include `chunk1` **and** both `chunk2a` and `chunk2b` (a legacy single `chunk2` marker is still accepted in place of the 2a/2b pair)
- Phase 4 → 5: all Tier 1 gaps must have `resolved: true`

If validation fails, do not advance the phase and do not surface an error to the client.

### WHOIS Lookup
WHOIS (Phase 2) runs automatically server-side when the session advances to phase 2. It is never triggered by Claude directly. WHOIS failure is non-fatal — log the error and advance to Phase 3 with empty `technical.*` fields.

---

## MBP Parser Rules

- The parser must never throw. Wrap all section parsers in try/catch and always return a partial result.
- Use regex to find section headers — never use line numbers or character offsets.
- ✅ items in MBP → add to schema. ❓ items → add to gap list.
- The Korbey Lague MBP (`raw-docs/mfp-korbeylague-com-2026-04-24.md`) is the primary test fixture. Run the parser against it after any change.
- Store raw `mbp_content` in the DB — never in the system prompt.

---

## PDF Generation Rules

- The PDF generation route MUST export `export const runtime = 'nodejs'` — `@react-pdf/renderer` will not work on the Edge runtime.
- Do not embed uploaded images in the PDF. Reference files by filename only.
- PDF storage path: `pdfs/{sessionId}/intake-summary.pdf`
- Upload uses `upsert: true` — re-generating the PDF overwrites the previous version.


## TypeScript Rules

- `strict: true` is assumed. Never use `as any` — define proper types.
- All schema data typed as `SessionSchema` from `types/session-schema.ts`
- All Supabase query results typed via `types/database.ts` (auto-generated — do not edit manually)
- All gap items typed as `GapItem` from `types/gap-item.ts`
- API request/response bodies should have explicit TypeScript interfaces, not inline object types

---

## File & Folder Conventions

```
app/
  (admin)/          # Admin routes — all require auth
    dashboard/
    sessions/[id]/
    login/
  session/[id]/     # Client-facing — no auth required
  api/
    chat/           # Core streaming endpoint
    sessions/       # Session CRUD
    upload/         # File upload (presign + confirm)
    whois/          # WHOIS lookup trigger
    cron/           # Scheduled jobs — require CRON_SECRET
    pdf/            # PDF generation
lib/
  supabase/         # client.ts, server.ts, proxy.ts
  agent/            # system-prompt.ts, phase-instructions.ts, trim-messages.ts, gap-list.ts
  mbp-parser/       # index.ts + section parsers
  pdf/              # generate-pdf.ts + components/
components/
  chat/             # ChatInterface, FileUploadButton, MessageBubble
  admin/            # SchemaViewer, ApproveButton, StatusBanner
emails/             # React Email templates
types/              # database.ts (generated), session-schema.ts, gap-item.ts
```

---

## Development Workflow

1. Read the relevant dev step file in `raw-docs/dev-steps/` before starting any phase
2. Run tests from that step's **Test Process** section after completing implementation
3. Run `npx tsc --noEmit` after every file change — fix type errors before moving on
4. Before every commit, run:
   - `grep -r "SUPABASE_SERVICE_ROLE_KEY" ./app` (expect zero matches)
   - `grep -r "GITHUB_APP_PRIVATE_KEY" ./app` (expect zero matches)
   - `grep -rn "console\.log" ./app ./lib --include="*.ts" --include="*.tsx" --exclude="*.test.ts" --exclude="*.test.tsx"` (expect zero matches outside `scripts/`; test fixtures may carry the literal string as data)
5. Test against the Korbey Lague MBP fixture for any changes to the parser or agent logic
6. Use the Supabase SQL Editor to verify DB state after any session-modifying operation

### Full re-audit cadence

A **full re-audit** (parallel read-only reviewers covering security/auth + RLS, the content pipeline + cron, agent/chat/MBP, editor/GitHub, UI, and the DB layer; every finding verified in code before it's reported or fixed) is due when **any** threshold in `.audit/last-full-audit.json` is crossed since the last one:
- **30 days**, or
- **150 commits**, or
- **15,000 lines changed** (excluding `package-lock.json` and `types/database.ts`).

- A SessionStart hook (`.claude/settings.json` → `node scripts/audit-due.mjs --hook`) flags when it's due. When it fires, tell the user at the start of the session and offer to run the audit before starting other large work. Don't start one unprompted.
- Check status at any time with `node scripts/audit-due.mjs`.
- After a full audit's fixes ship, run `node scripts/audit-due.mjs --mark "<one-line summary>"` and commit `.audit/last-full-audit.json`.
- Also run one before any major migration, such as the infra account move, and after any change to auth or RLS larger than a single route.
- Thresholds live in the marker file; change them there, not in the script.

---

## Design System Rules

The full design specification lives in `raw-docs/design.md`. **Read it before writing any UI code.** All visual decisions — color, typography, spacing, shadows, border-radius, component styling — are defined there and must be followed exactly.

### Non-Negotiable Design Rules

1. **Colors come from the palette only.** Never hardcode hex values in JSX or CSS outside of `tailwind.config.ts`. Use Tailwind classes mapped to `brand.*`, `surface.*`, `text.*`, and `border.*` tokens.
   - Primary CTA color: `brand-cyan` (`#00C1DE`)
   - Primary structural color: `brand-navy` (`#003B71`)
   - No default blues, no generic grays for interactive elements

2. **Fonts are Inter (headings) and Open Sans (body).** Load via `next/font/google`. No system serif fonts. No inline `font-family` overrides.

3. **Buttons are always pill-shaped (`border-radius: 40px`) and brand-colored.** Gray buttons = disabled only. No square or zero-radius buttons.

4. **Shadows use the navy-tinted palette** defined in `raw-docs/design.md`. Never use `rgba(0,0,0,0.5)` or similar generic black shadows.

5. **The Revaltus logo (white version) appears in the client-facing session header.** Place it at `/public/logo-white.svg`. Never stretch, filter, or display it on a cyan background.

6. **Chat bubbles:** agent = white card with `border-color: #E2E8F0`; user = `#003B71` navy background with white text.

7. **No inline style overrides on color or typography.** All styling through Tailwind utility classes that map to the design token config.

8. **Run the Component Checklist** (bottom of `raw-docs/design.md`) before considering any UI screen complete.

---

## Do Not

- Do not use `localStorage` or `sessionStorage` anywhere in the application
- Do not send `mbp_content` to Claude
- Do not use `export const runtime = 'edge'` on any route that uses `@react-pdf/renderer` or `whoiser`
- Do not use sequential IDs for session or record lookups
- Do not advance a phase without server-side validation
- Do not mark a session as approved if it is already approved
- Do not clear the `processing` flag only in `onFinish` — also clear it on error
- Do not call `.getPublicUrl()` on the `session-assets` bucket or write a value into `assets.public_url`
- Do not write `console.log` in pipeline or production paths — use `console.warn` for non-fatal operational logs, `console.error` for genuine failures
- Do not use raw Tailwind semantic colors (`text-red-*`, `bg-amber-*`, etc.) — use the `error` / `warning` / `info` / `success` tokens defined in `app/globals.css`
- Do not let `process.env.CRON_SECRET` be empty in any environment that has cron routes deployed

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
