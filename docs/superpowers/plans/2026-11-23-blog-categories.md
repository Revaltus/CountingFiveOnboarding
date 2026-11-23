# Blog Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-site blog categories. They're managed in the content editor, AI-assigned to posts from MBP industries, filterable on live sites, and mirrored into WordPress (via the repo-built feed) and the Divi export.

**Architecture:** The client repo is the source of truth: `content/categories.json` holds the list, and post frontmatter `categories: [id…]` holds assignments. Onboarding reads and writes the draft branch (publish moves it to `main`). The WP feed and the template read from it, and plugin 1.5.0 reconciles WP terms by permanent ID. No database table, no migration.

**Tech Stack:** Next.js 16 / TypeScript / vitest (onboarding + template), AI SDK `generateText` on `FAST_MODEL`, GitHub Git Data API helpers (`lib/github/repo-files.ts`), PHP 7.4+ WordPress plugin.

**Spec:** `docs/superpowers/specs/2026-11-23-blog-categories-design.md`

## Global Constraints

- Category file: `content/categories.json` = `{ "version": 1, "categories": [{ "id", "name", "slug", "description"? }] }`. Array order is display order.
- Category `id`: `c-` + 6 lowercase hex, random, never reused. `slug`: unique per site, matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- Post frontmatter: `categories: [c-7f3a2c, c-19be04]`, unquoted IDs, primary first. Max **3** per post; AI assigns **1–2**.
- Unknown category IDs in a post are silently ignored everywhere: editor, feed, template, WXR, plugin.
- A missing/invalid `categories.json` never fails a build, export or feed. The feed **omits** the `categories` key in that case (distinct from `[]`).
- Seeding: from kept niches only, via `activeNiches(schema)` (`lib/content/active-niches.ts`). Happens once, when the file is absent.
- All editor writes go to `DRAFT_BRANCH`; going live is the existing "Publish draft to live".
- Gate: `resolveEditContext` (admins, managers, editors, Site Owners). No `canPublish` check on category routes.
- Reserved post slug: `category`.
- Template release version: `2026.09.15`. Category page URL: `{blogPath}/category/{slug}`.
- Plugin version: `1.5.0`. Term meta `_rv_category_id`, `_rv_adopted`; post meta `_rv_assigned_terms`.
- CLAUDE.md applies: `FAST_PROVIDER_OPTIONS`, `recordTokenUsage` with `...extractCacheUsage(usage)`, `internalError()` for 5xx, no `console.log`, design tokens only, `npx tsc --noEmit` after each file.

## Review Focus

1. **Concurrent first-seed.** Three blog-batch drafts run at once on a site with no `categories.json`. Each must end up using the *same* IDs, not three random seeds where the last write orphans the others. → Task 2 test `ensureSeeded is race-safe`.
2. **Awkward category names.** "S-Corp & LLC", "Construcción", "  ", a duplicate name. Expect a valid ASCII slug, a 400 for empty, and a 409 for a slug collision. → Task 1 + Task 3 tests.
3. **Broken `categories.json` on main** (hand edit, bad JSON). The plugin must delete **nothing**, the template must render with no categories, and the export must still succeed. → Tasks 9, 10, 11, 12 tests.
4. **Hand-added WP category on a synced post.** It survives Revaltus assignments, renames and deletes. The plugin's settings category is removed once Revaltus categories arrive. → Task 11 harness cases.
5. **Stale editor tab.** An operator saves a post that references a category just deleted in another tab. Expect no crash, the ID ignored on the live site and in the feed, and the picker showing only known categories (dropping the unknown one on the next save). → Task 8 test + Task 9/12 unknown-ID tests.

---

## Track A — Onboarding (`counting-five-onboarding`)

### Task 1: Pure category helpers

**Files:**
- Create: `lib/content/blog-categories.ts`
- Test: `lib/content/blog-categories.test.ts`

**Interfaces — Produces:**
```ts
export const CATEGORIES_PATH = 'content/categories.json'
export const MAX_POST_CATEGORIES = 3
export const RESERVED_POST_SLUGS: readonly string[] = ['category']
export type BlogCategory = { id: string; name: string; slug: string; description?: string }
export type CategoriesFile = { version: 1; categories: BlogCategory[] }
export function parseCategoriesFile(text: string): CategoriesFile | null   // null on bad JSON/shape; drops invalid entries
export function serializeCategoriesFile(file: CategoriesFile): string       // 2-space JSON + trailing \n
export function slugifyCategory(name: string): string                      // '' when nothing usable
export function newCategoryId(existing: Iterable<string>): string          // c-xxxxxx, not in existing
export function seedCategoriesFromSchema(schema: SessionSchema): CategoriesFile
export function readPostCategoryIds(postText: string): string[]
export function setPostCategoryIds(postText: string, ids: string[]): string // dedupes, caps at 3, removes key when empty
export function replaceCategoryInPost(postText: string, removeId: string, moveTo: string | null): string
export class CategoryValidationError extends Error { status: 400 | 409 }
export function validateCategoryInput(input: { name: string; slug?: string; description?: string }, others: BlogCategory[]): BlogCategory /* without id */
```

- [ ] **Step 1: Write failing tests** in `blog-categories.test.ts`:
  - `parseCategoriesFile('{bad')` → `null`; a valid file round-trips through `serializeCategoriesFile` byte-identically; an entry missing `slug` is dropped.
  - `slugifyCategory('S-Corp & LLC')` → `'s-corp-llc'`; `slugifyCategory('Construcción')` → `'construccion'`; `slugifyCategory('  ')` → `''`.
  - `newCategoryId([])` matches `/^c-[0-9a-f]{6}$/`; it never returns an ID that's in `existing` (stub `crypto.randomUUID`/`randomBytes` to collide once).
  - `seedCategoriesFromSchema` with niches `[Construction (kept), Nonprofits (dropped), Real Estate]` → 2 categories, slugs `construction`, `real-estate`; two niches slugifying the same → one category.
  - `setPostCategoryIds` on a fixture post (copy from an existing `lib/content/__fixtures__` post, or build one with `buildPostMarkdown`) with `['a','b','a','c','d']` → frontmatter `categories: [a, b, c]`; with `[]` → no `categories:` line; every other frontmatter line is unchanged.
  - `replaceCategoryInPost(text, 'c-1', 'c-2')` on `[c-1, c-3]` → `[c-2, c-3]`; on `[c-2, c-1]` → `[c-2]` (no dup); with `moveTo=null` → `[c-3]`.
  - `validateCategoryInput({name:'  '}, [])` throws status 400; a name whose slug equals another's throws 409; `slug:'Bad Slug'` throws 400; `slug:'category'` is allowed (that reservation is for post slugs only).
- [ ] **Step 2: Run** `npx vitest run lib/content/blog-categories.test.ts`. Expect FAIL (module missing).
- [ ] **Step 3: Implement.** Use `splitFile`/`serializeFile` from `lib/editor/frontmatter.ts` for post edits, setting `arrayFields.categories` and appending to `order` after `tags` when the key is new. Slugify: NFKD, strip diacritics, lowercase, non-alnum→`-`, trim dashes.
- [ ] **Step 4: Run** the tests, expect PASS; then `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(categories): pure helpers for content/categories.json + post frontmatter`.

### Task 2: Repo sync layer

**Files:**
- Create: `lib/content/blog-categories-repo.ts`
- Test: `lib/content/blog-categories-repo.test.ts` (`vi.mock('@/lib/github/repo-files')`)

**Interfaces:**
- Consumes: Task 1; `readFile`, `listTree`, `readTextBlobs`, `pushEntriesToBranch`, `ensureDraftBranch`, `StaleShaError`, `FileNotFoundError`, `DRAFT_BRANCH`, `MAIN_BRANCH`.
- Produces:
```ts
type Actor = { name?: string | null; email?: string | null }
export type LoadedCategories = { file: CategoriesFile | null; sha: string | null } // draft first, then main; sha only from draft
export async function loadCategories(githubRepo: string): Promise<LoadedCategories>
export async function ensureSeeded(githubRepo: string, schema: SessionSchema, actor: Actor): Promise<CategoriesFile>
export async function listCategoryCounts(githubRepo: string): Promise<Record<string, number>> // draft posts; id → count
export async function saveCategories(githubRepo: string, next: CategoriesFile, expectedSha: string | null, actor: Actor, message: string): Promise<void>
export async function deleteCategory(githubRepo: string, id: string, moveTo: string | null, actor: Actor): Promise<{ postsChanged: number }>
export async function setPostCategories(githubRepo: string, postPath: string, ids: string[], actor: Actor): Promise<void>
```

- [ ] **Step 1: Failing tests:**
  - `loadCategories` prefers draft over main; returns `{file:null}` when both 404; returns `{file:null}` (no throw) on invalid JSON.
  - `ensureSeeded is race-safe`: the first `pushEntriesToBranch` (called with `expectedBlobSha: null`) rejects `StaleShaError`; then `loadCategories` returns the other writer's file, and `ensureSeeded` returns *that* file with no second push.
  - `deleteCategory('c-1','c-2')` issues **one** `pushEntriesToBranch` containing `categories.json` (without c-1) plus only the posts that referenced c-1, each guarded by its read `sha`; returns `postsChanged`. `moveTo` not in the list → throws `CategoryValidationError(400)`.
  - `saveCategories` passes `expectedBlobSha` through; `StaleShaError` propagates.
- [ ] **Step 2: Run**, expect FAIL.
- [ ] **Step 3: Implement.** Mirror `blog-settings-repo-sync.ts`'s read pattern. Author comes from actor (same `authorOf` helper shape). Commit messages: `Seed blog categories`, `Update blog categories`, `Delete blog category <name>`.
- [ ] **Step 4: Run** tests + tsc, expect PASS.
- [ ] **Step 5: Commit** `feat(categories): repo-backed load/seed/save/delete on draft branch`.

### Task 3: Category API routes

**Files:**
- Create: `app/api/edit/[id]/categories/route.ts` (GET, POST, PATCH)
- Create: `app/api/edit/[id]/categories/[categoryId]/route.ts` (DELETE)
- Create: `app/api/edit/[id]/posts/categories/route.ts` (PUT: set one post's categories; used by the picker's "assign" when the post isn't otherwise being saved)
- Test: `app/api/edit/[id]/categories/route.test.ts`, `.../[categoryId]/route.test.ts`

**Interfaces:**
- Consumes: Task 2; `resolveEditContext`; `internalError`; `decodeAndNormalizePath` helper from `app/api/edit/[id]/_path.ts` (use its actual exported name) for the post path.
- Produces (request/response bodies as exported interfaces in `types/blog-categories.ts`):
  - `GET` → `{ categories: BlogCategory[]; counts: Record<string, number>; seeded: boolean; templateSupportsCategories: boolean }`. Calls `ensureSeeded` (seed on first open). `templateSupportsCategories` = `compareTemplateVersions(readDraftTemplateVersion(repo) ?? '0', '2026.09.15') >= 0`.
  - `POST { name, slug?, description? }` → `201 { category }`.
  - `PATCH { categories: Array<{ id, name, slug, description? }>; sha }` → full-list replace (rename + reorder); IDs must equal the current set (no add/remove via PATCH) → else 400; stale `sha` → 409 `{ error: 'Categories changed in another tab — reload' }`.
  - `DELETE /categories/:categoryId?moveTo=c-xxxxxx` → `{ postsChanged }`.
  - `PUT /posts/categories { path, ids }` → path must normalize under `content/posts/` and end `.md`; unknown IDs dropped; >3 → 400.

- [ ] **Step 1: Failing tests:** 401/403 pass-through from a mocked `resolveEditContext`; POST empty name → 400; POST colliding slug → 409; PATCH with a missing ID → 400; DELETE with unknown `moveTo` → 400; PUT path `content/posts/..%2F..%2Fsite.config.ts` → 400; a 5xx body never contains the mocked GitHub error text.
- [ ] **Step 2: Run**, expect FAIL.
- [ ] **Step 3: Implement.** `export const runtime = 'nodejs'`; add each new route to `maxduration-config.test.ts` if that test enumerates routes.
- [ ] **Step 4: Run** tests + tsc, expect PASS.
- [ ] **Step 5: Commit** `feat(categories): editor API for list/create/rename/reorder/delete/assign`.

### Task 4: AI classifier

**Files:**
- Create: `lib/content/post-category-classifier.ts`
- Modify: `lib/content/token-pricing.ts:9-40` (add `'categorize'` to `TokenStage`)
- Test: `lib/content/post-category-classifier.test.ts`; add the file to the list checked by `lib/content/fast-model-options.test.ts` if that test enumerates files.

**Interfaces — Produces:**
```ts
export async function classifyPostCategories(args: {
  title: string; excerpt: string; body: string; categories: BlogCategory[]
  sessionId: string; contentJobId?: string | null; createdBy?: string | null
}): Promise<string[]>  // 0–2 known ids; never throws
```

- [ ] **Step 1: Failing tests** (mock `ai.generateText`): model output `{"ids":["c-1","c-zzz","c-2","c-3"]}` → `['c-1','c-2']`; output not JSON → `[]` plus a `console.warn`; `generateText` throws → `[]`; `categories: []` → `[]` with no model call; the call uses `FAST_MODEL` and `FAST_PROVIDER_OPTIONS`, and `messages` ends with a user turn; `recordTokenUsage` is called with `stage: 'categorize'`, `task: 'content'`.
- [ ] **Step 2: Run**, expect FAIL.
- [ ] **Step 3: Implement.** Prompt lists categories as `id — name — description`, then gives the title, excerpt and the first ~1,500 chars of the body. Ask for JSON `{"ids":[…]}` with 1–2 best fits, or `[]` if none genuinely fits. `maxOutputTokens: 200`.
- [ ] **Step 4: Run** tests + tsc, expect PASS.
- [ ] **Step 5: Commit** `feat(categories): Haiku classifier for post categories`.

### Task 5: Hook categories into post creation + reserve slug

**Files:**
- Modify: `lib/content/post-markdown.ts:31-62` (add `categories?: string[]` arg; emit `categories: [..]` after `tags` only when non-empty, unquoted)
- Modify: `lib/content/resource-draft-generator.ts` (~L483 `pickPostSlug`, ~L615–790 draft path)
- Modify: `lib/content/article-import-generator.ts` (~L330–370)
- Test: `lib/content/post-markdown.test.ts`, `lib/content/resource-draft-slug.test.ts`, plus new cases in the generators' existing tests.

**Interfaces — Consumes:** Task 1 (`RESERVED_POST_SLUGS`, `readPostCategoryIds`), Task 2 (`ensureSeeded`), Task 4.

- [ ] **Step 1: Failing tests:**
  - `buildPostMarkdown({...,categories:['c-1','c-2']})` contains the line `categories: [c-1, c-2]`; with `[]` or omitted, there's no `categories` line (existing snapshot unchanged).
  - `pickPostSlug({title:'Category', ...takenSlugs:[]})` → `'category-2'`; article import of title "Category" → slug `category-2`.
  - Re-draft: when `idea.draft_path` points at a draft-branch file with `categories: [c-9]`, the new markdown keeps `[c-9]` and the classifier is **not** called.
  - New draft: the classifier result is written; classifier `[]` → no line; `ensureSeeded` failure → post still saved, no categories, `console.warn`.
- [ ] **Step 2: Run**, expect FAIL.
- [ ] **Step 3: Implement.** In `pickPostSlug`, seed `taken` with `RESERVED_POST_SLUGS`; do the same in the import's `taken` set. In `generateResourceDraft`, before `buildPostMarkdown`, read the existing post from `DRAFT_BRANCH` at `idea.draft_path` (falling back to `content/posts/{idea.slug}.md`; 404 → none). `ensureSeeded` + classify run only when there are no existing categories, both inside try/catch (non-fatal).
- [ ] **Step 4: Run** `npx vitest run lib/content` + tsc, expect PASS.
- [ ] **Step 5: Commit** `feat(categories): AI-assign categories on draft + import; preserve on re-draft; reserve 'category' slug`.

### Task 6: Backfill ("Auto-categorize uncategorized posts")

**Files:**
- Create: `lib/content/blog-categories-backfill.ts`
- Create: `app/api/edit/[id]/categories/auto-assign/route.ts` (POST)
- Test: `lib/content/blog-categories-backfill.test.ts`

**Interfaces — Produces:**
```ts
export const BACKFILL_BATCH = 25
export async function backfillCategories(args: { githubRepo: string; sessionId: string; schema: SessionSchema; actor: Actor; createdBy: string }):
  Promise<{ categorized: number; leftUncategorized: number; remaining: number }>
```
The route returns the same object. The UI calls it repeatedly while `remaining > 0`.

- [ ] **Step 1: Failing tests:** given 30 draft posts (5 already categorized), the first call classifies 25 uncategorized at concurrency 4 and makes **one** commit, guarded by each post's sha. It returns `remaining: 0` (none skipped). Posts that already have categories are never rewritten. Classifier `[]` counts toward `leftUncategorized` and doesn't rewrite the file. A `StaleShaError` on commit → 409 from the route.
- [ ] **Step 2: Run**, expect FAIL.
- [ ] **Step 3: Implement.** On a re-run, posts that came back `[]` are classified again. That's acceptable at Haiku cost, but it means `remaining` must count only posts not yet attempted *this call*. Return `remaining = uncategorized − attempted`.
- [ ] **Step 4: Run** tests + tsc, expect PASS.
- [ ] **Step 5: Commit** `feat(categories): batch auto-categorize for existing posts`.

### Task 7: Blog categories screen

**Files:**
- Create: `app/admin/content/[id]/blog-categories/page.tsx` (server; copy the access pattern from `blog-landing/page.tsx`, **but** allow Site Owners and editors; only check session access)
- Create: `components/editor/BlogCategoriesEditor.tsx` (client)
- Modify: `components/editor/EditorTopBar.tsx` (~L255: add a "Blog categories →" link **outside** the `!isOwner` block)

**Interfaces — Consumes:** Task 3 + Task 6 endpoints.

- [ ] **Step 1: Build the screen.** Read `raw-docs/design.md` first. The screen has:
  - list rows: name, slug, description, post count, ↑/↓ reorder;
  - inline edit for name, slug and description, with slug auto-filled from the name until the slug is edited by hand;
  - "Add category";
  - delete: a confirm dialog shows "N posts use this", with a radio for "Move them to [select]" or "Just remove it from them";
  - "Auto-categorize uncategorized posts": runs the loop with progress, then shows "Categorized N; K left uncategorized";
  - a notice when `!templateSupportsCategories`: "Live-site filters need the latest site template."
  Show any 409 from the API as "Categories changed elsewhere — reload".
- [ ] **Step 2: Verify** with `npx tsc --noEmit` + `npx eslint components/editor/BlogCategoriesEditor.tsx app/admin/content/[id]/blog-categories`. Then run the design Component Checklist.
- [ ] **Step 3: Browser check** on the dev server, on a test session with a repo: seed appears; add / rename / reorder / delete-with-move all show up in the draft diff ("Review changes").
- [ ] **Step 4: Commit** `feat(categories): Blog categories screen in the content editor`.

### Task 8: Post editor category picker

**Files:**
- Create: `components/editor/PostCategoryPicker.tsx`
- Modify: `components/editor/PageEditor.tsx` (~L242–257 post-metadata block; `isPost` only)
- Test: `components/editor/PostCategoryPicker.test.tsx` (if the repo has React Testing Library set up; otherwise make a pure helper `pickerState(assigned, known)` in the component file and test that)

**Interfaces:**
- Consumes: `GET /categories` (list), `POST /categories` (inline create), Task 1 `MAX_POST_CATEGORIES`.
- Produces: `PostCategoryPicker({ sessionId, assigned: string[], onChange(ids: string[]) })`. PageEditor's `onChange` calls `commit(nextFrontmatter, bodyContent)`, setting `arrayFields.categories` (or removing it when empty), so the change saves with the normal post save.

- [ ] **Step 1: Failing test:** with `assigned ['c-1','c-gone']` and known `[c-1,c-2]`, it renders the chip `c-1` only, and the next `onChange` emits no `c-gone`; add is disabled at 3; inline create calls POST, then `onChange([...assigned, newId])`.
- [ ] **Step 2: Run**, expect FAIL. **Step 3: Implement.** **Step 4: Run** the test + tsc, expect PASS; browser-check saving a post shows `categories:` in Review changes.
- [ ] **Step 5: Commit** `feat(categories): category picker in post metadata`.

### Task 9: WordPress feed

**Files:**
- Modify: `lib/wordpress/feed-builder.ts` (`WpFeedPost` + `postFromRepoFile` ~L171 + `buildFeed` ~L205)
- Modify: `app/api/wp-feed/[site]/route.ts:21-27`
- Test: `lib/wordpress/feed-builder.test.ts`

**Interfaces — Produces:**
```ts
export type WpFeedCategory = { id: string; name: string; slug: string; description: string }
// WpFeedPost gains: categories: string[]
export async function buildFeed(...): Promise<{ posts: WpFeedPost[]; categories: WpFeedCategory[] | null }>
// route body: { site, generated_at, posts, ...(categories ? { categories } : {}) }
```

- [ ] **Step 1: Failing tests:** `main` has a valid file → `categories` has 2 entries; posts carry known IDs only (unknown `c-gone` filtered); file missing → `categories: null` and the route JSON has **no** `categories` key; invalid JSON → same; valid file with `[]` → route has `categories: []`.
- [ ] **Step 2: Run**, expect FAIL. **Step 3: Implement** (read `CATEGORIES_PATH` from `MAIN_BRANCH`; filter post IDs against it; when the file is absent, pass post IDs through unfiltered — the plugin ignores them without terms). **Step 4: Run** tests + tsc, expect PASS.
- [ ] **Step 5: Commit** `feat(wp-feed): categories registry + per-post category ids`.

### Task 10: Divi export categories

**Files:**
- Modify: `lib/content/divi/wxr.ts:142` (`buildWxr` opts gains `categories?: BlogCategory[]`; emit `<wp:category>` terms before the nav_menu term)
- Modify: `app/api/edit/[id]/export-divi/route.ts` (~L153: read `CATEGORIES_PATH` from `DRAFT_BRANCH` via `parseCategoriesFile`; on 404 or invalid → `[]`)
- Modify: `lib/content/divi/README.md:90`, `lib/content/divi/readme.ts` (import notes: "Blog categories are included; posts arrive via the Revaltus Blog Sync plugin.")
- Test: `lib/content/divi/divi-export.test.ts`

Each term (term IDs start at 900 so they never collide with `MENU_TERM_ID` or page IDs):
```xml
<wp:category><wp:term_id>900</wp:term_id><wp:category_nicename>construction</wp:category_nicename><wp:category_parent></wp:category_parent><wp:cat_name><![CDATA[Construction]]></wp:cat_name><wp:category_description><![CDATA[…]]></wp:category_description><wp:termmeta><wp:meta_key>_rv_category_id</wp:meta_key><wp:meta_value><![CDATA[c-7f3a2c]]></wp:meta_value></wp:termmeta></wp:category>
```

- [ ] **Step 1: Failing tests:** 2 categories → 2 `<wp:category>` blocks with nicename, name and termmeta; the name `Tax & "Audit" ]]>` is escaped/CDATA-split by the existing `cdata()`; `categories: []` or omitted → no `<wp:category>`, and the output is otherwise byte-identical to the current fixture.
- [ ] **Step 2: Run**, expect FAIL. **Step 3: Implement.** **Step 4: Run** tests + tsc, expect PASS.
- [ ] **Step 5: Commit** `feat(divi-export): include blog categories as WP terms with _rv_category_id`.

---

## Track B — WordPress plugin (`wordpress-plugin/revaltus-blog-sync`)

### Task 11: Plugin 1.5.0 — term reconcile + assignment

**Files:**
- Create: `wordpress-plugin/revaltus-blog-sync/includes/class-rv-categories.php`
- Modify: `includes/class-rv-sync.php` (`run()` ~L26–110, `content_hash()` ~L148, `apply_assignments()` ~L313–335)
- Modify: `includes/class-rv-settings.php` (~L194: add the note "Categories are managed in Revaltus. Categories you create here are left alone.")
- Modify: `revaltus-blog-sync.php:5,20` → `1.5.0`; `readme.txt` changelog
- Create: `wordpress-plugin/tests/categories-harness.php` (stubbed WP functions: `get_terms`, `wp_insert_term`, `wp_update_term`, `wp_delete_term`, `get_term_meta`/`update_term_meta`/`delete_term_meta`, `wp_get_post_categories`, `wp_set_post_categories`, `get_post_meta`/`update_post_meta`, `get_option('default_category')`), outside the plugin folder so it's never zipped
- Rebuild: `wordpress-plugin/revaltus-blog-sync.zip`

**Interfaces — Produces:**
```php
final class RV_Categories {
  /** @return array<string,int>|null rv_id => term_id; null when feed has no 'categories' key (no-op) */
  public static function reconcile( $feed );
  /** Set a post's categories from feed ids. $map from reconcile(). */
  public static function assign( $post_id, array $rv_ids, $map );
}
```

Algorithm for `assign`:
- `owned` = the term IDs in `$map`.
- `prev` = post meta `_rv_assigned_terms` (array).
- `want` = map lookups of `$rv_ids` (unknown dropped).
- `current` = `wp_get_post_categories`.
- *Migration:* if `prev` is empty and the post has 1.2-era assignment, treat the current settings/default category as `prev`.
- If `want` is non-empty: `keep` = `current` minus (`owned` ∪ `prev`); set `keep` ∪ `want`, and store `want` as `_rv_assigned_terms`.
- If `want` is empty: remove `prev ∩ owned`, then fall back to the existing v1.2 `apply_assignments` behaviour (settings category).

- [ ] **Step 1: Write harness cases** (each prints PASS/FAIL, exit code non-zero on any failure):
  - create;
  - adopt (same-slug hand term gets `_rv_category_id` + `_rv_adopted`);
  - rename (`wp_update_term` name+slug);
  - delete-owned (`wp_delete_term`);
  - removed adopted term → meta removed, term kept;
  - feed without `categories` key → zero term calls;
  - `categories: []` → owned terms deleted;
  - a term imported from WXR with `_rv_category_id` already set counts as owned (not adopted);
  - post in settings category "Blog" + feed `[c-1]` → post categories = {Construction};
  - post with hand term "Featured" + feed `[c-1]` → {Featured, Construction}, and stays so after the feed changes to `[c-2]` → {Featured, Nonprofits};
  - post loses all categories → falls back to "Blog";
  - `content_hash` changes when only the category IDs change.
- [ ] **Step 2: Run** `"$(ls -d ~/Library/Application\ Support/Local/lightning-services/php-8*/bin/darwin-arm64/bin | head -1)/php" wordpress-plugin/tests/categories-harness.php`. Expect FAIL (class missing).
- [ ] **Step 3: Implement.**
  - Call `reconcile` once at the start of `run()`, after the 200/JSON checks and before the post loop, so it runs within the time budget even when every post is hash-skipped.
  - Call `assign` in both `upsert_post` and the fast-path `apply_assignments`.
  - Include `$post['categories']` in `content_hash`.
  - Find owned terms with `get_terms(['taxonomy'=>'category','hide_empty'=>false,'meta_key'=>'_rv_category_id'])`.
- [ ] **Step 4: Run** the harness (expect all PASS), then lint every file with `php -l`.
- [ ] **Step 5: Rebuild the zip:** `cd wordpress-plugin && rm revaltus-blog-sync.zip && zip -r revaltus-blog-sync.zip revaltus-blog-sync -x '*.DS_Store'`. Confirm `app/api/wp-feed/[site]/plugin/route.ts` reports 1.5.0 (update its version source if it's hardcoded).
- [ ] **Step 6: Commit** `feat(wp-plugin): sync Revaltus categories to WP terms + assignments (v1.5.0)`.

---

## Track C — Site template (`counting-five-client-template`, then fleet)

### Task 12: Template data layer

**Files (template repo):**
- Create: `src/lib/content/get-categories.ts` (+ `.test.ts`)
- Modify: `src/lib/content/post-frontmatter-schema.ts:27` (add `categories: z.array(z.string()).optional()`)
- Modify: `src/lib/content/get-post.ts` (`PostMeta`/`Post` gain `categories: string[]`, filtered to known IDs)
- Modify: `src/lib/content/filter-posts.ts` (`BrowsablePost.categories: string[]`; `PostFilters.category: string | null` (slug); `export function presentCategories(posts, all: BlogCategory[]): BlogCategory[]` — only categories with ≥1 post, in file order)
- Test: `src/lib/content/filter-posts.test.ts`

**Interfaces — Produces:** `getCategories(): Promise<BlogCategory[]>` (cached; `[]` on missing/invalid); `getCategoryBySlug(slug): Promise<BlogCategory | null>`.

- [ ] **Step 1: Failing tests:**
  - `getCategories` with a fixture dir: valid → list; bad JSON → `[]`; missing → `[]`.
  - `filterPosts` with `category:'construction'` → only matching posts.
  - `presentCategories` hides empty categories and keeps file order.
  - A post with `categories: [c-gone]` → `categories: []`.
- [ ] **Step 2: Run** `npx vitest run src/lib/content`. Expect FAIL. **Step 3: Implement.** **Step 4: Run** the tests, expect PASS; then `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(categories): load categories.json + category filter`.

### Task 13: Template UI, routes, SEO + release

**Files (template repo):**
- Modify: `src/components/blocks/ResourceBrowser.tsx` (category chips, rendered as `<Link>`s to category pages; "All" links to the blog index)
- Modify: `src/lib/content/blog-views.tsx` (add `CategoryIndex({ slug })` + `categoryIndexMetadata(slug)`; `BlogPost` shows category links; JSON-LD `articleSection` = the primary category's name)
- Create: `src/app/resources/category/[slug]/page.tsx` (default path; `generateStaticParams` from `getCategories`; unknown → `notFound()`; yields like the sibling resources routes when a custom blog path is set)
- Modify: `src/app/[...slug]/page.tsx` (custom blog path: segments `[...blogPath, 'category', slug]` → `CategoryIndex`; evaluated **before** the post match)
- Modify: `src/app/sitemap.ts`, `src/app/llms.txt/route.ts` (category pages)
- Modify: `c5-template.json` → `"templateVersion": "2026.09.15"`
- Onboarding repo: create `config/fleet-releases/2026.09.15.json` (format per `lib/fleet/README.md`)

- [ ] **Step 1: Failing tests:**
  - catch-all route resolution (extend the existing page-slug/blog-config tests): `/insights/category/construction` → category; `/insights/category` → 404 (not a post);
  - sitemap includes `/resources/category/construction` only for categories with posts.
- [ ] **Step 2: Implement**, then run `npx vitest run`, `npx tsc --noEmit`, `npm run build`. Expect green, with category pages in the build output.
- [ ] **Step 3: Visual check.** Mirror the files to `c5-test-client` (per the dev+test loop) and add a `categories.json` + post categories there. On `:3001`, check chips, the category page, post links, and phone width (390px, no horizontal scroll).
- [ ] **Step 4: Commit** in the template repo: `feat: blog categories — filters, category pages, sitemap (2026.09.15)`. Commit the fleet manifest in onboarding.
- [ ] **Step 5: Fleet roll.** Show the user the client roster first (standing rule). Then `npx tsx scripts/fleet-sync.ts --all` (dry-run) → user OK → `--all --apply` (canary 1).

---

### Task 14: End-to-end canary + docs

- [ ] **Step 1: Run the canary on bblcpa (or Accord)** after Tracks A + C deploy. Steps: open Blog categories (seeded from niches) → Auto-categorize → rename one → delete one with move → Publish draft to live. Check the live chips and category page, and that the feed JSON has `categories`.
- [ ] **Step 2: WP check on the Local test site** with plugin 1.5.0. Steps: Sync now → terms created and posts assigned; rename in Revaltus + publish → Sync now → term renamed in place; a hand-made "Featured" category survives.
- [ ] **Step 3: Divi export check.** Import the WXR into a fresh Local WP site: categories exist with the `_rv_category_id` term meta. Then activate the plugin and sync: no duplicate categories.
- [ ] **Step 4: Docs + memory.** Add a "Blog categories" subsection to CLAUDE.md covering the contract, the reserved slug, the plugin meta keys, and that the feed omits the key when the file is invalid. Update the WP bridge memory.
- [ ] **Step 5: Pre-commit greps** (CLAUDE.md workflow §4), then commit `docs: blog categories`.
