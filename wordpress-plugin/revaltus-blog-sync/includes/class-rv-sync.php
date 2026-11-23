<?php
/**
 * The sync worker: fetch the feed and reconcile WordPress posts.
 *
 * One-way. Revaltus is the source of truth. New/updated posts are published;
 * posts that disappear from the feed are set to draft (never deleted).
 *
 * Time-bounded + resumable: a single run stops starting new work once its wall
 * budget is spent (default 40s), so it never trips a host's gateway timeout on a
 * large repo. Unchanged posts are skipped by content hash and already-fetched
 * hero/body images by sha, so repeat runs (WP-cron or "Sync now") converge
 * cheaply.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class RV_Blog_Sync {

	const LOCK = 'rv_blog_sync_lock';

	/**
	 * Run one sync pass.
	 *
	 * @return array|WP_Error Counts { created, updated, drafted, skipped, remaining } or an error.
	 */
	public static function run() {
		$settings = get_option( RV_BLOG_SYNC_OPTION, array() );
		$feed_url = isset( $settings['feed_url'] ) ? $settings['feed_url'] : '';
		$secret   = isset( $settings['secret'] ) ? $settings['secret'] : '';
		$enabled  = ! empty( $settings['enabled'] );

		if ( ! $enabled ) {
			return array( 'created' => 0, 'updated' => 0, 'drafted' => 0, 'skipped' => 0, 'remaining' => 0, 'note' => 'disabled' );
		}
		if ( '' === $feed_url || '' === $secret ) {
			return new WP_Error( 'rv_config', __( 'Feed URL and secret are required.', 'revaltus-blog-sync' ) );
		}

		// One pass at a time: WP-cron and "Sync now" (or two cron hits) running
		// together would race on creating terms and posts. The TTL outlives a
		// pass (30s fetch + 40s budget) and frees the lock if PHP dies mid-run.
		if ( get_transient( self::LOCK ) ) {
			return new WP_Error( 'rv_busy', __( 'A sync is already running — no changes made. Try again in a minute or two.', 'revaltus-blog-sync' ) );
		}
		set_transient( self::LOCK, 1, 120 );
		try {
			return self::run_pass( $feed_url, $secret );
		} finally {
			delete_transient( self::LOCK );
		}
	}

	/**
	 * Fetch the feed and reconcile. Called by run() while it holds the lock.
	 *
	 * @return array|WP_Error
	 */
	private static function run_pass( $feed_url, $secret ) {
		// Wall budget for the whole run (from before the feed fetch). Kept well
		// under a typical 60s gateway timeout; filterable for stricter hosts.
		$start  = microtime( true );
		$budget = (float) apply_filters( 'rv_blog_sync_time_budget', 40.0 );

		$response = wp_remote_get(
			$feed_url,
			array(
				'timeout' => 30,
				'headers' => array(
					'Authorization'       => 'Bearer ' . $secret,
					// From 1.3.0 the feed embeds body images (<img data-rv-ref>);
					// older plugins are sent HTML without them.
					'X-RV-Plugin-Version' => RV_BLOG_SYNC_VERSION,
				),
			)
		);
		if ( is_wp_error( $response ) ) {
			return $response;
		}
		$code = (int) wp_remote_retrieve_response_code( $response );

		// CRITICAL: only reconcile on a clean 200. On any other status (401 wrong
		// secret, 404 disabled site, 5xx) we make NO changes — otherwise a
		// transient failure would draft every synced post.
		if ( 200 !== $code ) {
			return new WP_Error(
				'rv_http',
				sprintf(
					/* translators: %d: HTTP status code */
					__( 'Feed returned HTTP %d — no changes made.', 'revaltus-blog-sync' ),
					$code
				)
			);
		}

		$body = wp_remote_retrieve_body( $response );
		$data = json_decode( $body, true );
		if ( ! is_array( $data ) || ! isset( $data['posts'] ) || ! is_array( $data['posts'] ) ) {
			return new WP_Error( 'rv_parse', __( 'Feed response was not valid JSON — no changes made.', 'revaltus-blog-sync' ) );
		}

		// Category terms first, outside the time budget: cheap, and it must run
		// even when every post is hash-skipped. Null when the feed carries no
		// category list — then no terms change and posts keep v1.2 behaviour.
		$category_map = RV_Categories::reconcile( $data );

		// Full feed slug set up front, so a partial (budget-limited) pass still
		// drafts the right posts and never drafts one it simply hasn't reached.
		$feed_slugs = array();
		foreach ( $data['posts'] as $p ) {
			if ( ! empty( $p['slug'] ) ) {
				$feed_slugs[] = sanitize_title( $p['slug'] );
			}
		}

		$created   = 0;
		$updated   = 0;
		$skipped   = 0;
		$remaining = 0;

		foreach ( $data['posts'] as $post ) {
			if ( empty( $post['slug'] ) ) {
				continue;
			}
			$slug     = sanitize_title( $post['slug'] );
			$existing = self::find_existing( $slug );
			$hash     = self::content_hash( $post );

			// Fast path: content unchanged AND the hero and every body image are
			// already attached (or there are none). Cheap DB reads only — safe to keep doing even
			// after the budget is spent, so a converged site re-syncs instantly.
			if ( $existing
				&& get_post_meta( $existing->ID, '_rv_content_hash', true ) === $hash
				&& self::image_ok( $existing->ID, $post ) ) {
				// Cheap: writes only if the post lacks an author or its categories
				// differ, so changing those settings backfills old posts.
				self::apply_assignments( $existing->ID, false, self::post_category_ids( $post ), $category_map );
				$skipped++;
				continue;
			}

			// Budget spent: leave the remaining work for the next run. Posts
			// already processed above persist; the cron/"Sync now" resumes here.
			if ( ( microtime( true ) - $start ) > $budget ) {
				$remaining++;
				continue;
			}

			$verb = self::upsert_post( $slug, $post, $secret, $hash, $category_map );
			if ( 'created' === $verb ) {
				$created++;
			} elseif ( 'updated' === $verb ) {
				$updated++;
			}
		}

		$drafted = self::draft_removed( $feed_slugs );

		return array(
			'created'   => $created,
			'updated'   => $updated,
			'drafted'   => $drafted,
			'skipped'   => $skipped,
			'remaining' => $remaining,
		);
	}

	/**
	 * Stable hash of the feed fields we write, so an unchanged post can be
	 * skipped without touching the DB or re-sideloading its images. Image shas
	 * are included so a file replaced in place (same filename, new bytes)
	 * still changes the hash.
	 */
	private static function content_hash( $post ) {
		$hero     = isset( $post['hero_image']['url'] ) ? $post['hero_image']['url'] : '';
		$hero_sha = isset( $post['hero_image']['sha'] ) ? (string) $post['hero_image']['sha'] : '';
		$tags     = ( isset( $post['tags'] ) && is_array( $post['tags'] ) ) ? implode( ',', $post['tags'] ) : '';
		$inline   = array();
		foreach ( self::inline_images( $post ) as $image ) {
			$inline[] = ( isset( $image['filename'] ) ? $image['filename'] : '' ) . ':' . ( isset( $image['sha'] ) ? $image['sha'] : '' );
		}
		$fields = array(
			isset( $post['title'] ) ? $post['title'] : '',
			isset( $post['html'] ) ? $post['html'] : '',
			isset( $post['excerpt'] ) ? $post['excerpt'] : '',
			isset( $post['date_gmt'] ) ? $post['date_gmt'] : '',
			$tags,
			isset( $post['meta_title'] ) ? $post['meta_title'] : '',
			isset( $post['meta_description'] ) ? $post['meta_description'] : '',
			$hero,
			$hero_sha,
			implode( ',', $inline ),
		);
		// Only posts with categories get the extra field, so upgrading to
		// 1.5.0 doesn't re-sync every uncategorized post.
		$categories = self::post_category_ids( $post );
		if ( $categories ) {
			sort( $categories );
			$fields[] = 'categories:' . implode( ',', $categories );
		}
		return md5( implode( '|', $fields ) );
	}

	/**
	 * The post's Revaltus category ids from the feed (empty for older servers).
	 *
	 * @return string[]
	 */
	private static function post_category_ids( $post ) {
		if ( ! isset( $post['categories'] ) || ! is_array( $post['categories'] ) ) {
			return array();
		}
		return array_values( array_unique( array_filter( $post['categories'], 'is_string' ) ) );
	}

	/**
	 * True when the post needs no image work: its hero (if any) is the featured
	 * image and every body image is attached at its current sha. An image that
	 * failed to attach last run returns false so it is retried.
	 */
	private static function image_ok( $post_id, $post ) {
		if ( ! empty( $post['hero_image']['url'] ) && ! get_post_thumbnail_id( $post_id ) ) {
			return false;
		}
		return RV_Blog_Sync_Media::inline_complete( $post_id, self::inline_images( $post ) );
	}

	/**
	 * The post's `inline_images` list from the feed (empty for older servers).
	 */
	private static function inline_images( $post ) {
		return ( isset( $post['inline_images'] ) && is_array( $post['inline_images'] ) ) ? $post['inline_images'] : array();
	}

	/**
	 * Insert or update a single post, matched by slug. Returns 'created' or
	 * 'updated'. Stamps the content hash on success so the next run can skip it.
	 *
	 * Body images are sideloaded before the content is saved, so the
	 * bearer-only proxy URLs in the feed HTML never reach stored content. An
	 * existing post sideloads first, then saves once. A new post with body
	 * images needs an id to parent them to, so it is inserted as a draft
	 * without them, then published with the rewritten HTML.
	 */
	private static function upsert_post( $slug, $post, $secret, $hash, $category_map ) {
		$existing = self::find_existing( $slug );
		$html     = isset( $post['html'] ) ? (string) $post['html'] : '';
		$images   = self::inline_images( $post );
		$two_step = ! $existing && false !== strpos( $html, 'data-rv-ref' );

		if ( $existing ) {
			$content = RV_Blog_Sync_Media::rewrite_html( $html, RV_Blog_Sync_Media::attach_inline( $existing->ID, $images, $secret ) );
		} else {
			$content = RV_Blog_Sync_Media::rewrite_html( $html, array() );
		}
		if ( null === $content ) {
			return 'error'; // Could not strip proxy URLs safely; retried next run.
		}

		$postarr = array(
			'post_type'    => 'post',
			'post_status'  => 'publish',
			'post_name'    => $slug,
			// Our feed HTML uses only tags inside wp_kses_post's allowlist, so no
			// special unfiltered handling is needed. wp_slash survives the
			// wp_unslash that wp_insert_post applies internally.
			'post_title'   => wp_slash( isset( $post['title'] ) ? $post['title'] : $slug ),
			'post_content' => wp_slash( $content ),
			'post_excerpt' => wp_slash( isset( $post['excerpt'] ) ? $post['excerpt'] : '' ),
		);

		if ( ! $existing ) {
			$author = self::resolve_author();
			if ( $author ) {
				$postarr['post_author'] = $author;
			}
		}

		if ( ! empty( $post['date_gmt'] ) ) {
			$postarr['post_date_gmt'] = $post['date_gmt'];
			$postarr['post_date']     = get_date_from_gmt( $post['date_gmt'] );
		}

		if ( $existing ) {
			$postarr['ID'] = $existing->ID;
			$result = wp_update_post( $postarr, true );
			$verb = 'updated';
		} else {
			if ( $two_step ) {
				// Publish hooks (feeds, newsletters, social) should only ever
				// see the final content, so the first insert is a draft.
				$postarr['post_status'] = 'draft';
			}
			$result = wp_insert_post( $postarr, true );
			$verb = 'created';
		}

		if ( is_wp_error( $result ) || ! $result ) {
			return 'error';
		}
		$post_id = is_object( $result ) ? $result->ID : (int) $result;

		// Set before any slow work so an interrupted run finds this post again
		// (find_existing matches drafts) instead of creating a duplicate.
		update_post_meta( $post_id, '_rv_synced', 1 );
		update_post_meta( $post_id, '_rv_source_slug', $slug );

		if ( $two_step ) {
			$content = RV_Blog_Sync_Media::rewrite_html( $html, RV_Blog_Sync_Media::attach_inline( $post_id, $images, $secret ) );
			if ( null === $content ) {
				return 'error'; // Left as an un-hashed draft; retried next run.
			}
			$postarr['ID']           = $post_id;
			$postarr['post_status']  = 'publish';
			$postarr['post_content'] = wp_slash( $content );
			$result = wp_update_post( $postarr, true );
			if ( is_wp_error( $result ) || ! $result ) {
				return 'error';
			}
		}

		self::apply_assignments( $post_id, 'created' === $verb, self::post_category_ids( $post ), $category_map );

		// Tags (replace the full set each sync).
		if ( ! empty( $post['tags'] ) && is_array( $post['tags'] ) ) {
			wp_set_post_tags( $post_id, array_map( 'sanitize_text_field', $post['tags'] ), false );
		}

		self::apply_seo_meta( $post_id, $post );

		if ( ! empty( $post['hero_image'] ) && is_array( $post['hero_image'] ) ) {
			RV_Blog_Sync_Media::attach_hero( $post_id, $post['hero_image'], $secret );
		}

		// Stamp last so a mid-run failure above leaves the post un-hashed and it
		// is retried next run rather than skipped. A body image that failed to
		// sideload was left out of the content; skipping the stamp retries it.
		if ( RV_Blog_Sync_Media::inline_complete( $post_id, $images ) ) {
			update_post_meta( $post_id, '_rv_content_hash', $hash );
		} else {
			delete_post_meta( $post_id, '_rv_content_hash' );
		}

		return $verb;
	}

	/**
	 * Author + categories. An author is set on a new post, and on an existing
	 * post that has none (posts created by WP-cron before 1.2.0).
	 *
	 * Categories: when the feed carries a category list ($category_map is not
	 * null) and the post has Revaltus categories, RV_Categories::assign() sets
	 * them. Otherwise the settings category applies: a new post gets it, an
	 * existing post only while it is in WordPress's default category, so a
	 * category changed by hand in WordPress is never overwritten.
	 *
	 * @param string[]               $rv_ids       The post's feed category ids.
	 * @param array<string,int>|null $category_map From RV_Categories::reconcile().
	 */
	private static function apply_assignments( $post_id, $is_new, $rv_ids = array(), $category_map = null ) {
		if ( ! $is_new && 0 === (int) get_post_field( 'post_author', $post_id ) ) {
			$author = self::resolve_author();
			if ( $author ) {
				wp_update_post( array( 'ID' => $post_id, 'post_author' => $author ) );
			}
		}

		if ( null !== $category_map && RV_Categories::assign( $post_id, $rv_ids, $category_map ) ) {
			return;
		}

		$category = self::resolve_category();
		if ( ! $category ) {
			return;
		}
		$default = (int) get_option( 'default_category' );
		$current = array_map( 'intval', wp_get_post_categories( $post_id ) );
		if ( $is_new || array() === $current || array( $default ) === $current ) {
			if ( array( $category ) !== $current ) {
				wp_set_post_categories( $post_id, array( $category ), false );
			}
		}
	}

	/**
	 * The configured author if they still exist and can write posts, else the
	 * lowest-ID administrator. WP-cron runs with no logged-in user, so without
	 * this a scheduled sync would create posts with no author.
	 */
	private static function resolve_author() {
		static $resolved = null;
		if ( null !== $resolved ) {
			return $resolved;
		}
		$settings = get_option( RV_BLOG_SYNC_OPTION, array() );
		$id       = isset( $settings['author'] ) ? (int) $settings['author'] : 0;
		if ( $id && user_can( $id, 'edit_posts' ) ) {
			$resolved = $id;
			return $resolved;
		}
		$admins   = get_users(
			array(
				'role'    => 'administrator',
				'orderby' => 'ID',
				'order'   => 'ASC',
				'number'  => 1,
				'fields'  => 'ID',
			)
		);
		$resolved = $admins ? (int) $admins[0] : 0;
		return $resolved;
	}

	/**
	 * The configured category if it still exists; 0 means use WordPress's default.
	 */
	public static function resolve_category() {
		$settings = get_option( RV_BLOG_SYNC_OPTION, array() );
		$id       = isset( $settings['category'] ) ? (int) $settings['category'] : 0;
		if ( $id && term_exists( $id, 'category' ) ) {
			return $id;
		}
		return 0;
	}

	/**
	 * Prefer a post we previously synced (by _rv_source_slug), then fall back to
	 * any post with the same slug. Avoids clobbering an unrelated manual post
	 * unless it genuinely shares the slug.
	 */
	private static function find_existing( $slug ) {
		$query = new WP_Query(
			array(
				'post_type'      => 'post',
				'post_status'    => array( 'publish', 'draft', 'pending', 'private', 'future' ),
				'meta_key'       => '_rv_source_slug',
				'meta_value'     => $slug,
				'posts_per_page' => 1,
				'no_found_rows'  => true,
			)
		);
		if ( $query->have_posts() ) {
			return $query->posts[0];
		}
		$by_path = get_page_by_path( $slug, OBJECT, 'post' );
		return $by_path ? $by_path : null;
	}

	/**
	 * Write meta title/description for Yoast and Rank Math. Harmless if neither
	 * plugin is active. Filterable so operators can map to another SEO plugin.
	 */
	private static function apply_seo_meta( $post_id, $post ) {
		$meta_title = isset( $post['meta_title'] ) ? sanitize_text_field( $post['meta_title'] ) : '';
		$meta_desc  = isset( $post['meta_description'] ) ? sanitize_text_field( $post['meta_description'] ) : '';

		$map = apply_filters(
			'rv_blog_sync_seo_meta_keys',
			array(
				'_yoast_wpseo_title'    => $meta_title,
				'_yoast_wpseo_metadesc' => $meta_desc,
				'rank_math_title'       => $meta_title,
				'rank_math_description' => $meta_desc,
			),
			$post
		);

		foreach ( $map as $key => $value ) {
			if ( '' !== $value ) {
				update_post_meta( $post_id, $key, $value );
			}
		}
	}

	/**
	 * Any synced post whose slug is no longer in the feed → set to draft.
	 * Never deletes; a slug re-appearing flips it back to publish via upsert.
	 * Safe after a partial pass because $feed_slugs is the FULL feed set.
	 *
	 * @return int Number of posts drafted.
	 */
	private static function draft_removed( $feed_slugs ) {
		$feed_slugs = array_flip( $feed_slugs );
		$drafted = 0;

		$query = new WP_Query(
			array(
				'post_type'      => 'post',
				'post_status'    => 'publish',
				'meta_key'       => '_rv_synced',
				'meta_value'     => 1,
				'posts_per_page' => -1,
				'no_found_rows'  => true,
				'fields'         => 'ids',
			)
		);

		foreach ( $query->posts as $post_id ) {
			$source_slug = get_post_meta( $post_id, '_rv_source_slug', true );
			if ( '' === $source_slug || isset( $feed_slugs[ $source_slug ] ) ) {
				continue;
			}
			wp_update_post( array( 'ID' => $post_id, 'post_status' => 'draft' ) );
			$drafted++;
		}

		return $drafted;
	}
}
