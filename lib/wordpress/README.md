# WordPress blog-sync bridge (Revaltus)

A **one-way, opt-in** bridge that lets self-hosted WordPress (Divi) sites pull
published blog/resource posts from a client's git repo during the transition
period, while blogs are still authored and edited inside Revaltus.

It is deliberately **isolated and removable** — the sibling of the throwaway Divi
export bridge (`lib/content/divi/`). It is **not** wired into the content/publish
workflow, phase pipeline, publish gates, cron config, or editor UI. It adds:

- `lib/wordpress/` — feed builder + DB-backed site registry + image proxy helpers
- `app/api/wp-feed/[site]/` — the feed route + authenticated image-proxy route
- `app/api/admin/wordpress-sites/` — admin CRUD for the site registry
- `app/admin/wordpress-sites/` — the admin roster page (add/toggle/regenerate/delete)
- `wordpress_sites` table (migration 067) — one row per synced WP site
- `wordpress-plugin/revaltus-blog-sync/` — the PHP plugin operators install

## How it works

```
WP plugin (WP-cron)  ──GET /api/wp-feed/{site}  (Bearer secret)──▶  this app
   parse JSON posts                                                  reads content/posts/*.md
   upsert wp_posts by slug (publish)                                 from git `main` (GitHub App)
   sideload hero via /api/wp-feed/{site}/asset (Bearer) ◀────────────  streams private repo bytes
   posts missing from feed → set draft (never delete)
```

The app holds **all** GitHub credentials and serves clean JSON + proxied image
bytes. WordPress holds only a feed URL + a per-site bearer secret — never a
GitHub token. Repos are private, so hero images are emitted as authenticated
proxy URLs (`requires_auth: true`) that the plugin fetches with the bearer.

## Enabling a site (admin UI)

1. **Admin → WordPress Sites → Add site.** Enter a **site key** (URL slug, e.g.
   `acmetax`) and the **GitHub repo** (`name` or `owner/name`, same as
   `content_jobs.github_repo`). The app generates a bearer secret and shows it
   **once** with the feed URL — copy both.
2. Install the `revaltus-blog-sync` plugin on the WordPress site and paste the
   feed URL (`https://<app-host>/api/wp-feed/acmetax`) + the secret.
3. Click **Sync now** in WordPress (or wait for WP-cron).

Lost the secret? Use **Regenerate** on the row (rotates it, shown once) and
update the plugin. **Disable** flips `enabled` off (feed 404s); **Delete**
removes the row.

## Disabling

- **Per-site:** toggle the site off (or delete it) in the admin UI. The feed then
  returns 404 and the plugin **no-ops** (it never drafts posts on a non-200), so
  nothing is destroyed.

## Full removal (one move)

```
rm -rf lib/wordpress
rm -rf app/api/wp-feed
rm -rf app/api/admin/wordpress-sites
rm -rf app/admin/wordpress-sites
rm -rf wordpress-plugin/revaltus-blog-sync
rm components/admin/AddWordpressSiteDialog.tsx components/admin/WordpressSiteRow.tsx types/wordpress-sites.ts
# remove the "WordPress" link from components/admin/AdminSidebar.tsx
# drop table: DROP TABLE wordpress_sites;  (+ remove the type block from types/database.ts)
npx tsc --noEmit   # clean compile confirms nothing else depended on it
```

## Scope / limitations (v1)

- **Posts only** (`content/posts/*.md`). Pages, nav, and client-center are out of
  scope (handled natively or by the Divi bridge).
- **Categories**: the feed carries `categories: [{id,name,slug,description}]`
  (the registry from `content/categories.json` on `main`) and each post a
  `categories: [id]` list, filtered to known ids. The top-level `categories` key
  is **omitted** when the file is missing, invalid or partially corrupt (any bad
  or duplicate entry — never a partial list) (`[]` when valid but empty);
  post ids then pass through unfiltered. Plugin 1.5.0 reconciles WP terms from it.
  Reconcile rules: only terms carrying term meta `_rv_category_id` are renamed or
  deleted; a hand-made term with the same SLUG is adopted (`_rv_adopted`) and never deleted
  (a same-name term with another slug is left alone and a new term is created);
  `_rv_assigned_terms` post meta records what the plugin assigned so hand-assigned
  terms survive; runs are serialised by the `rv_blog_sync_lock` transient.
- **One-way**: git is the source of truth; edits made inside WordPress are
  overwritten on the next sync.
- **Images**: the featured image (`hero_image`) and standalone body images
  (`![alt](file.jpg)` lines → `<figure><img data-rv-ref>` + `inline_images`)
  both carry the repo blob `sha`, so a file replaced in place re-syncs. Body
  images are only emitted to plugins >= 1.3.0 (`X-RV-Plugin-Version` header);
  older plugins get bodies without them, because they would store the auth-only
  proxy URLs. The plugin sideloads each image and rewrites `src` to the WP media URL.
- `github_repo` is duplicated from Supabase into the site row (intentional, for
  isolation) — keep it in sync if a repo is renamed.
