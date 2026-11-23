# Blog Categories — Design

Date: 2026-11-23 · Status: draft for approval

## Intent

Client firms publish posts for distinct audiences (e.g. construction clients vs. nonprofits). Visitors should be able to see only the posts for their world ("only show construction blogs"). Today posts carry free-form `tags` that nobody edits and the blog index has no meaningful topical grouping.

We add **per-site blog categories**: a managed list per client, posts assigned to them (by AI at write time, overridable by operators), filterable on the live site, and mirrored into WordPress for the sites that run the blog-sync plugin — with WordPress still reading only what's in git (via the existing feed).

## Goals

1. Operators can add, rename, reorder and delete a site's categories **from the content editor** for that site.
2. Posts can be (re)categorized from the post editor, including creating a new category inline.
3. New posts are categorized automatically by AI, choosing from the site's list; existing posts can be bulk auto-categorized once.
4. Live sites (client-site template) let visitors filter by category, and each category has its own indexable page.
5. The WordPress plugin creates/renames/deletes matching WP categories and assigns synced posts to them, driven only by the feed built from the repo's `main` branch.
6. The Divi export (editor ••• → Export to Divi) includes the site's categories in this first release (user decision).

## Non-goals (v1)

- Category hierarchy (parent/child).
- Categories shared across sites.
- AI inventing new categories (it only picks from the list).
- Tag editing UI (tags stay as they are).
- Category images, per-category hero art, analytics.

## Anti-goals (failure even if it "works")

- WordPress calling into Revaltus for anything other than the existing feed pull, or any path where WP state flows back into Revaltus.
- The plugin deleting or renaming a WordPress category someone created by hand.
- A malformed or missing `categories.json` breaking a site build, or causing the plugin to delete every category.
- Category sprawl: AI or UI creating near-duplicate categories without an operator choosing to.
- Writing `categories:` into posts on a site whose template can't parse it.

## Approaches considered

- **A. Repo is the source of truth (chosen).** `content/categories.json` in the client repo + `categories:` in post frontmatter. Same pattern as `content/blog.json` (repo-only, no DB mirror). WordPress gets categories through the existing repo-built feed. Chosen because it keeps git as the single truth, rides the existing draft→publish workflow, and needs no new table.
- **B. Supabase table as master, mirrored to the repo.** Easier queries and history, but two sources of truth that can drift (editor commits vs. DB), and WP follows git anyway. Rejected.
- **C. Categories = MBP industries directly.** Least work, but can't express non-industry categories ("Tax Tips"), and MBP edits would silently rename live categories. Rejected.

## Decided by the user

- Approach A.
- AI assigns categories from the MBP industries; operators can override.
- Category management (add / rename / delete / re-categorize posts) lives in the per-site content editor and is part of the normal editing workflow.
- WordPress picks everything up from git; no direct WP↔Revaltus tie.

## Design

### 1. Data contract (in each client repo)

`content/categories.json`:

```json
{
  "version": 1,
  "categories": [
    { "id": "c-7f3a2c", "name": "Construction", "slug": "construction", "description": "Accounting and tax for contractors." }
  ]
}
```

- `id` — permanent, random (`c-` + 6 hex), never changes and never reused. Everything else references this.
- `name` — display label. `slug` — URL segment, unique per site, lowercase `[a-z0-9-]`. `description` — optional, used as the category page intro/meta description.
- Array order = display order (operator-controlled).

Post frontmatter gains `categories: [c-7f3a2c, c-19be04]` (IDs). Renaming a category (name or slug) is therefore a one-file change; only deleting touches posts. Order within a post = primary category first. *(Builder call: max 3 per post; AI assigns 1–2.)*

Unknown IDs in a post (category deleted out-of-band) are ignored everywhere — template, feed, editor — never an error.

### 2. Seeding from the MBP

When a site has no `categories.json` and a category is first needed (opening the Categories screen, a post being generated, or the backfill), seed it from the MBP's **kept** niches (`schema_data.niches[]` minus `dropped`), one category per niche, slugified. Written to the draft branch like every other editor change. After seeding, the list is the operator's; MBP edits never change it again.

### 3. Onboarding app — editor workflow

All writes go to the **draft branch** and go live through the existing "Publish draft to live". Gate: same as other content-editor routes (`resolveEditContext` → `requireSessionAccess`), so admins, managers, editors and Site Owners can manage categories on their sites; only publish remains `canPublish`-gated. *(My call — categories are content, not site config. Flag if Site Owners should be excluded.)*

**a. Blog categories screen** — new item "Blog categories" in the editor's ••• overflow menu next to "Blog landing settings", page `app/admin/content/[id]/blog-categories`. Shows each category with name, slug, description, post count (draft branch), and lets the operator:
- add a category;
- rename (name and/or slug; slug collision blocked);
- reorder (drag or up/down);
- delete, with a confirm that shows the affected post count and offers **"Move these posts to…"** (another category) or "Just remove". Delete + post rewrites land in **one** draft commit (multi-file commit via the existing GitHub helpers);
- run **"Auto-categorize uncategorized posts"** (see §4), which only touches posts with no categories.

**b. Post editor** — in `PageEditor` "Post metadata" for `content/posts/*.md`, a Categories chip picker: shows assigned categories, add/remove from the site list, and **"+ New category"** inline (creates it in `categories.json` on the draft, then assigns it). Saving the post writes the frontmatter like any other metadata edit. Picker shows an "AI-assigned" hint is *not* needed — assignments are just values.

**c. API** — repo-backed routes under `app/api/edit/[id]/categories` (GET list+counts, POST create, PATCH rename/reorder, DELETE with optional `moveTo`), plus `.../categories/auto-assign` (POST, backfill). Mirrors `blog-settings-repo-sync.ts` (read draft-then-main, write draft). Pure helpers in `lib/content/blog-categories.ts` (parse/validate/serialize, slugify, id generation, apply-delete-to-post-frontmatter) with unit tests.

**d. No write gate (my call, after builder check).** The template's `PostFrontmatterSchema` is `.passthrough()`, so older templates already ignore `categories:`. Category management, the picker and AI assignment work on every site. This lets WordPress-synced sites get categories without waiting for the template roll. When the draft template version is below the categories release (`compareTemplateVersions`), the Categories screen shows a notice: "Live-site filters need the latest site template." The notice doesn't block anything.

### 4. AI assignment

A single classifier `classifyPostCategories({ title, excerpt, bodySnippet, categories })` → `string[]` of IDs, on `FAST_MODEL` (Haiku 5.5) with `FAST_PROVIDER_OPTIONS`, JSON output validated against the list (unknown IDs dropped, max 2). Called from every path that creates a post — `resource-draft-generator`, `article-import-generator`, `blog-batch-runner` — right before `post-markdown.ts` serializes, and by the backfill. Non-fatal: on failure or no good fit the post is saved uncategorized (logged with `console.warn`). Records token usage like other fast-tier calls. It never creates categories. Regenerating an existing post preserves its current categories (operator choices win). The re-draft path in `resource-draft-generator.ts` currently rebuilds from scratch, so it must read the existing file from the draft branch first. It finds that file via `resource_ideas.draft_path`, not the new slug, and carries the file's `categories` forward. It classifies only when the existing file had none.

Backfill runs over posts on the draft branch with no categories, in batches, one commit at the end; reports "Categorized N of M; K left uncategorized".

### 5. Client-site template (new template release)

- `src/lib/content/get-categories.ts` — loads/validates `content/categories.json` with zod; any error → empty list (build never fails on it).
- `post-frontmatter-schema.ts` — `categories: z.array(z.string()).optional()`.
- **Blog index** (`ResourceBrowser`) — category chips (All · Construction · Nonprofits…) alongside existing type chips/tag dropdown/search; only categories with ≥1 post are shown. `filter-posts.ts` gains a category filter (pure, tested).
- **Category pages** — `{blogPath}/category/{slug}`, statically generated. The `/category/` segment is fixed (my call). Default path: add a new route `src/app/resources/category/[slug]/page.tsx`, because `/resources` has its own route files. Custom blog path: extend the catch-all `src/app/[...slug]`, rendering through `blog-views.tsx`. `category` becomes a reserved post slug: onboarding's slug generator and the editor's new-post path skip or suffix it, and the template's route resolution gives category pages precedence. The page has: heading = name, intro = description, filtered post list, own canonical + meta description; included in sitemap, `llms.txt`. Unknown slug → 404. Chips on the index link to these pages (real URLs, not just client-side state).
- **Post page** — shows category links; JSON-LD `articleSection` = primary category name.
- Ship via the fleet-sync release manifest; show the client roster before rolling (standing rule). Template must be rolled to a site **before** onboarding writes categories into that site's posts (enforced by §3d).

### 6. WordPress feed

`lib/wordpress/feed-builder.ts` adds:
- top-level `categories: [{ id, name, slug, description }]`, read from `content/categories.json` on `main`. **If the file is missing or invalid, omit the key entirely** (distinct from an empty list).
- per-post `categories: [id…]` (unknown IDs filtered out).

Older plugins ignore both keys.

### 7. WordPress plugin v1.5.0

At the start of each sync (cheap, runs even when posts are hash-skipped):

**Term reconcile** — only if the feed response is 200 **and** contains a `categories` key.
- Each Revaltus category maps to a WP `category` term tagged with term meta `_rv_category_id`.
- Missing → create. If a hand-made term already has that slug, **adopt** it (set `_rv_category_id`, `_rv_adopted=1`) instead of creating a duplicate.
- Name/slug/description changed → `wp_update_term`.
- Owned term whose ID is no longer in the feed → `wp_delete_term` (WP moves its posts to the default category). Adopted terms are only **un-linked** (meta removed), never deleted.
- Terms without `_rv_category_id` are never touched.

**Post assignment (user decision: WordPress shows the category set in Revaltus).**

*Posts with Revaltus categories in the feed:*
- The post's categories become exactly the feed's terms.
- The plugin removes the settings category and WP's default category if it put them there.
- The settings category is only a fallback for posts with no Revaltus category.

*How the plugin tells its own terms from hand-added ones:*
- It records the term IDs it assigned in post meta `_rv_assigned_terms`.
- On each sync it removes only terms in that list (or Revaltus-owned terms) that the feed no longer wants.
- Terms someone added by hand in WP, which are in neither, are kept.

*Migration for posts synced before 1.5.0:* a post still in the settings or default category, with that category not added by hand, counts as plugin-assigned. Either category is removed once Revaltus categories arrive.

*Posts with no Revaltus categories:* the v1.2 behaviour (settings category) still applies. That includes a post whose last Revaltus category was deleted; it falls back to the settings category.

`apply_assignments` on the hash-skip fast path runs this same logic. The post content hash includes the category IDs, so category changes re-sync.

Settings screen note: "Categories are managed in Revaltus. Categories you create here are left alone." Rebuild the tracked zip; bump version so self-update notices fire; manual "Sync now" after upload.

### 8. Divi export (user decision: in the first release)

`lib/content/divi/wxr.ts` emits every category in `content/categories.json` from the **draft** branch, the same branch the export reads pages from. Each is written as a `<wp:category>` term (nicename = slug, cat_name = name, description), with `<wp:termmeta>` `_rv_category_id` = the Revaltus ID.
- The term meta is the point: when the blog-sync plugin later runs on that Divi site, it recognises these terms as its own (owned, not adopted). Renames and deletes from Revaltus then carry over cleanly, with no duplicate categories.
- **Posts stay out of the WXR** (my call). They reach a Divi site through the blog-sync plugin, which upserts by slug and now assigns categories. Exporting posts in the WXR too would create a second import path that collides with the plugin's slug matching.
- Missing or invalid `categories.json` → no terms emitted; the export still succeeds.
- Update `lib/content/divi/README.md` and `readme.ts` (the import notes shipped in the zip): categories are imported, and posts arrive via the blog-sync plugin.
- Tests: extend `divi-export.test.ts` to cover terms + termmeta present, special characters escaped, and the no-file case.

### 9. Flow end to end

Operator edits categories / post categories in the editor → draft branch → Publish draft to live → `main` → (a) Vercel rebuild of the client site shows new filters/pages, (b) next WP sync reads the feed from `main` and reconciles terms and assignments.

## Constraints

- Repo-only storage (no new table, no migration).
- Follow CLAUDE.md: fast-tier options, token recording, decode-then-normalize for any path input, `internalError` for 5xx, no `console.log`.
- Plugin: WP 5.8+/PHP 7.4+, existing 40s time budget, fail-closed on non-200.
- Template change ships through fleet-sync; older repos may lack newly imported modules — include them in the file set.

## Testing

- Unit: categories parse/serialize/slug/id; delete-with-move frontmatter rewrite; classifier output validation; feed builder (missing file → key omitted, unknown IDs filtered); template `filter-posts` + `get-categories` fallback.
- Divi export: WXR contains category terms with `_rv_category_id` termmeta; plugin harness case "term imported from WXR is treated as owned".
- Plugin: stubbed-WP harness cases — create, adopt, rename, delete-owned, unlink-adopted, missing-key no-op, hand-added terms preserved, settings/default category swapped out when Revaltus categories arrive (incl. pre-1.5.0 posts), fallback to settings category when a post loses its last category; PHP lint.
- E2E on a canary site (bblcpa or Accord): seed → AI-categorize → rename → delete-with-move → publish → live filter + category page → WP sync on the Local test site.

## Rollout order

No write gate (§3d), so these tracks are independent:
- Onboarding: helpers, routes, editor UI, classifier, feed, Divi export. Can ship first.
- Plugin 1.5.0: zip, then manual upload to each WP site. Can be tested once the feed ships.
- Template release, then fleet roll. Live filters and category pages appear on each site as it's rolled.

## Left to the builder

Exact UI layout of the screen/picker (follow `raw-docs/design.md`), classifier prompt wording, backfill batch size, category-page copy defaults, whether reorder is drag or arrows.
