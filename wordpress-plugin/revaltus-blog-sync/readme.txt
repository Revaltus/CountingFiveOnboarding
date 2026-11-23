=== Revaltus Blog Sync ===
Contributors: revaltus
Requires at least: 5.8
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.5.0
License: GPLv2 or later

One-way pull of published blog posts from a Revaltus feed into WordPress.

== Description ==

During the transition period, blog/resource content is authored and edited inside
Revaltus and published to a client's git repo. This plugin lets a self-hosted
WordPress (Divi) site PULL those published posts in on a schedule.

* One-way: Revaltus is the source of truth. Editing a synced post inside
  WordPress is overwritten on the next sync.
* Matches posts by slug. New/updated posts are published. Posts that disappear
  from the feed are set to DRAFT (never deleted).
* Syncs Revaltus blog categories: each becomes a WordPress category, and a
  synced post's categories match the ones set in Revaltus. Categories you
  create in WordPress are left alone, and ones you add to a post by hand stay.
* Uploads the hero image into the media library and sets it as the featured image.
* Uploads body images into the media library and points the post content at
  them. An image replaced in Revaltus (same filename, new file) is re-uploaded,
  and the superseded copy is removed. Only images this plugin uploaded are ever
  removed; media added by WordPress users is never touched.
* Holds NO GitHub credentials — only the feed URL and a shared bearer secret.
* Updates itself through WordPress's normal update screen: new releases come
  from the same Revaltus app as the feed (needs the Feed URL + secret set).

== Installation ==

1. Copy the `revaltus-blog-sync` folder into `wp-content/plugins/`.
2. Activate "Revaltus Blog Sync" in Plugins.
3. In Revaltus, go to Admin → WordPress Sites, add this site, and copy its
   Feed URL and generated Secret.
4. In WordPress, go to Settings → Revaltus Blog Sync and enter:
   * Feed URL — e.g. https://app.revaltus.com/api/wp-feed/your-site
   * Shared secret — the secret shown when you added the site in Revaltus
   * Sync interval — how often WP-cron pulls (default hourly)
   * Category / Author — assigned to synced posts (defaults: WordPress's
     default category; the first administrator)
   * Enabled — check to run scheduled syncs
5. Click "Sync now" to run an immediate pass and verify.

== Behavior notes ==

* If the feed returns anything other than HTTP 200 (wrong secret, disabled site,
  server error), the plugin makes NO changes — it will not draft posts on a
  transient failure.
* Each sync run is time-bounded (default 40s, filter `rv_blog_sync_time_budget`)
  and resumable, so a large repo won't trip your host's gateway timeout. If a run
  reports posts "still pending", click "Sync now" again or let WP-cron finish
  them; already-synced posts and images are skipped, so each run gets faster.
  Per-image download timeout is `rv_blog_sync_image_timeout` (default 15s).
* A body image that fails to download is left out of the post for that run and
  the post is retried on the next run.
* Post HTML from the feed uses only tags within WordPress's `wp_kses_post`
  allowlist (headings, paragraphs, lists, tables, blockquotes, rules, links,
  bold/italic, code, figures and images).
* Tables get a small scoped stylesheet (`assets/rv-content.css`), loaded only on
  synced single posts.
* Categories: Revaltus categories are created as WordPress categories (term
  meta `_rv_category_id`) and kept in step: renamed, re-slugged or deleted when
  they change in Revaltus (WordPress moves a deleted category's posts to the
  default category). A WordPress category that already has a Revaltus
  category's slug is linked to it instead of duplicated; a linked category is
  only un-linked, never deleted. Categories without that term meta are never
  changed. A post with Revaltus categories gets exactly those, plus any
  category added to it by hand in WordPress; the "Category" setting is the
  fallback for posts with none. If the feed carries no category list, no
  categories are changed.
* SEO meta title/description are written for both Yoast and Rank Math; use the
  `rv_blog_sync_seo_meta_keys` filter to map to another SEO plugin.

== Disabling / removal ==

* Pause: uncheck "Enabled" (settings are retained), or disable the site in
  Revaltus (Admin → WordPress Sites) — the feed then 404s and the plugin no-ops.
* Remove: deactivate + delete the plugin. Synced posts remain in WordPress in
  whatever state they were last in. Post meta `_rv_synced`, `_rv_source_slug`,
  `_rv_hero_hash`, `_rv_hero_sha`, `_rv_inline_map` and `_rv_assigned_terms`,
  and category term meta `_rv_category_id` / `_rv_adopted`, are left in place.

== Changelog ==

= 1.5.0 =
* Blog categories set in Revaltus now sync: they are created, renamed and
  deleted as WordPress categories, and each synced post gets the categories set
  in Revaltus. Categories you create in WordPress, and ones you add to a post
  by hand, are left alone.
* A WordPress category with the same slug as a Revaltus category is linked
  rather than duplicated, and is never deleted by the sync.
* Posts with Revaltus categories leave the "Category" setting's category (and
  the default category) the plugin put them in; that setting is now the
  fallback for posts without Revaltus categories.
* Categories imported with the Revaltus Divi export are recognised as synced.
* Only one sync runs at a time: a "Sync now" (or cron run) that starts while
  another is running stops without changes and says so.

= 1.4.0 =
* Tables in synced posts are styled: header row, row striping, borders, and
  horizontal scrolling on phones. The stylesheet loads only on synced posts.
* Tables now arrive as real HTML tables (a Revaltus feed fix; posts update on
  the next sync even before this plugin update).

= 1.3.0 =
* Body images sync into the media library; replaced images are detected;
  superseded synced images are cleaned up.
* Update notices: WordPress now shows when a new version is available, with
  one-click update from Plugins, fetched from Revaltus with this site's secret.
* The first sync after upgrading updates every synced post once (the content
  hash now includes image versions).

= 1.2.0 =
* New "Category" setting: synced posts go into the chosen category instead of
  "Uncategorized". Posts still in the default category are moved on the next
  sync; categories changed by hand in WordPress are kept.
* New "Author" setting (defaults to the first administrator). Scheduled syncs
  previously created posts with no author; those are repaired on the next sync.
  Authors changed by hand in WordPress are kept.

= 1.1.0 =
* Time-bounded, resumable sync: a run stops starting new work once its wall
  budget (default 40s) is spent, so large repos no longer trip host gateway
  timeouts. Unchanged posts skip by content hash; hero images skip by hash.
* Shorter per-image download timeout (default 15s), both filterable.
* "Sync now" reports how many posts are still pending.

= 1.0.0 =
* Initial release.
