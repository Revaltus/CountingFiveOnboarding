=== Revaltus Blog Sync ===
Contributors: revaltus
Requires at least: 5.8
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.2.0
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
* Uploads the hero image into the media library and sets it as the featured image.
* Holds NO GitHub credentials — only the feed URL and a shared bearer secret.

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
* Post HTML from the feed uses only tags within WordPress's `wp_kses_post`
  allowlist (headings, paragraphs, lists, links, bold/italic, code).
* SEO meta title/description are written for both Yoast and Rank Math; use the
  `rv_blog_sync_seo_meta_keys` filter to map to another SEO plugin.

== Disabling / removal ==

* Pause: uncheck "Enabled" (settings are retained), or disable the site in
  Revaltus (Admin → WordPress Sites) — the feed then 404s and the plugin no-ops.
* Remove: deactivate + delete the plugin. Synced posts remain in WordPress in
  whatever state they were last in. Post meta `_rv_synced`, `_rv_source_slug`,
  and `_rv_hero_hash` are left in place.

== Changelog ==

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
