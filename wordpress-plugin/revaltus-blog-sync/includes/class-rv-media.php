<?php
/**
 * Media sideload for Revaltus Blog Sync.
 *
 * WP's core media_sideload_image() can't send an Authorization header, but the
 * feed's hero and body images are served by an authenticated proxy — so we
 * fetch the bytes ourselves (with the bearer) and insert the attachment
 * manually.
 *
 * Every attachment this plugin creates carries post meta `_rv_synced = 1`.
 * Only those are ever deleted (when superseded), and never while some post
 * still uses one as its featured image. Media uploaded by WordPress users is
 * never touched.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class RV_Blog_Sync_Media {

	/**
	 * `<img ...>` tag carrying data-rv-ref; group 2 is the ref value.
	 */
	const IMG_REF_PATTERN = '#<img\b[^>]*?\sdata-rv-ref\s*=\s*(["\'])(.*?)\1[^>]*>#is';

	/**
	 * Ensure the hero image is in the media library and set as the post's
	 * featured image. Skips re-download when the feed sha is unchanged, and
	 * skips re-insert when the downloaded bytes are unchanged (md5).
	 *
	 * When the thumbnail moves to a new attachment, the previous one is deleted
	 * if (and only if) this plugin created it, no post uses it as a featured
	 * image, and it is not one of this post's synced body images.
	 *
	 * @param int    $post_id  Target post.
	 * @param array  $hero     { url, requires_auth, alt, filename, sha }.
	 * @param string $secret   Bearer secret (for requires_auth fetches).
	 * @return void
	 */
	public static function attach_hero( $post_id, $hero, $secret ) {
		if ( empty( $hero['url'] ) ) {
			return;
		}

		$sha            = isset( $hero['sha'] ) ? (string) $hero['sha'] : '';
		$existing_thumb = (int) get_post_thumbnail_id( $post_id );

		// Same git blob as last time and still attached: no download needed.
		if ( '' !== $sha && $existing_thumb && get_post_meta( $post_id, '_rv_hero_sha', true ) === $sha ) {
			return;
		}

		$body = self::fetch( $hero, $secret );
		if ( '' === $body ) {
			return; // Non-fatal: leave the post's featured image as it is.
		}

		$hash          = md5( $body );
		$existing_hash = get_post_meta( $post_id, '_rv_hero_hash', true );
		if ( $existing_hash === $hash && $existing_thumb ) {
			if ( '' !== $sha ) {
				update_post_meta( $post_id, '_rv_hero_sha', $sha );
			}
			return; // Unchanged bytes — nothing to do.
		}

		$attach_id = self::insert_attachment( $body, $hero, 'hero-' . $post_id . '.jpg', $post_id );
		if ( ! $attach_id ) {
			return;
		}

		set_post_thumbnail( $post_id, $attach_id );
		update_post_meta( $post_id, '_rv_hero_hash', $hash );
		if ( '' !== $sha ) {
			update_post_meta( $post_id, '_rv_hero_sha', $sha );
		} else {
			delete_post_meta( $post_id, '_rv_hero_sha' );
		}

		if ( $existing_thumb && $existing_thumb !== $attach_id ) {
			$keep   = self::inline_attachment_ids( $post_id );
			$keep[] = $attach_id;
			self::maybe_delete_synced( $existing_thumb, $keep );
		}
	}

	/**
	 * Ensure every body image is in the media library, attached to the post.
	 *
	 * Post meta `_rv_inline_map` = { filename: { sha, attach_id } } records what
	 * is attached. An image is sideloaded only when its filename is new, its sha
	 * changed, or its attachment no longer exists. When a re-download fails, the
	 * previous attachment (if any) is kept and served for now; its stale sha
	 * makes inline_complete() false so the post retries next run.
	 *
	 * Mapped attachments that are superseded or no longer referenced are deleted
	 * under the same safety rules as the hero (synced by us, not anyone's
	 * featured image).
	 *
	 * @param int    $post_id  Target post (becomes the attachments' parent).
	 * @param array  $images   List of { url, requires_auth, alt, filename, sha }.
	 * @param string $secret   Bearer secret (for requires_auth fetches).
	 * @return array Map filename => attachment id, for the images available now.
	 */
	public static function attach_inline( $post_id, $images, $secret ) {
		$old_map = self::get_inline_map( $post_id );
		$new_map = array();
		$result  = array();

		foreach ( (array) $images as $image ) {
			if ( ! is_array( $image ) || empty( $image['filename'] ) || empty( $image['url'] ) ) {
				continue;
			}
			$filename = (string) $image['filename'];
			if ( isset( $new_map[ $filename ] ) ) {
				continue; // Feed dedupes by filename; be defensive anyway.
			}
			$sha = isset( $image['sha'] ) ? (string) $image['sha'] : '';
			$old = isset( $old_map[ $filename ] ) ? $old_map[ $filename ] : null;

			$old_ok = $old && self::attachment_exists( $old['attach_id'] );
			if ( $old_ok && $old['sha'] === $sha ) {
				$new_map[ $filename ] = $old;
				$result[ $filename ]  = $old['attach_id'];
				continue;
			}

			$attach_id = 0;
			$body      = self::fetch( $image, $secret );
			if ( '' !== $body ) {
				$attach_id = self::insert_attachment( $body, $image, 'image-' . $post_id . '.jpg', $post_id );
			}

			if ( $attach_id ) {
				$new_map[ $filename ] = array(
					'sha'       => $sha,
					'attach_id' => $attach_id,
				);
				$result[ $filename ]  = $attach_id;
			} elseif ( $old_ok ) {
				// Keep the previous version (stale sha) until a retry succeeds.
				$new_map[ $filename ] = $old;
				$result[ $filename ]  = $old['attach_id'];
			}
		}

		if ( array() === $new_map ) {
			delete_post_meta( $post_id, '_rv_inline_map' );
		} else {
			update_post_meta( $post_id, '_rv_inline_map', $new_map );
		}

		// Clean up anything the new map no longer points at.
		$keep = array_values( $result );
		foreach ( $old_map as $entry ) {
			if ( ! in_array( $entry['attach_id'], $keep, true ) ) {
				self::maybe_delete_synced( $entry['attach_id'], $keep );
			}
		}

		return $result;
	}

	/**
	 * True when every feed body image is attached at its current sha. Cheap
	 * (post meta + cached post reads), so the sync fast path can call it.
	 *
	 * @param int   $post_id  Target post.
	 * @param array $images   List of { filename, sha, ... } from the feed.
	 * @return bool
	 */
	public static function inline_complete( $post_id, $images ) {
		if ( empty( $images ) || ! is_array( $images ) ) {
			return true;
		}
		$map = self::get_inline_map( $post_id );
		foreach ( $images as $image ) {
			if ( ! is_array( $image ) || empty( $image['filename'] ) || empty( $image['url'] ) ) {
				continue;
			}
			$filename = (string) $image['filename'];
			$sha      = isset( $image['sha'] ) ? (string) $image['sha'] : '';
			if ( ! isset( $map[ $filename ] )
				|| $map[ $filename ]['sha'] !== $sha
				|| ! self::attachment_exists( $map[ $filename ]['attach_id'] ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Point body images at their media-library attachments.
	 *
	 * For each `<img ... data-rv-ref="X">`: when X is in $map, `src` becomes the
	 * attachment URL, `wp-image-{id}` is added to `class`, and `data-rv-ref` is
	 * removed. When X is not in $map, the enclosing `<figure>` (or the bare img)
	 * is removed, so the bearer-only proxy URL never reaches stored content.
	 *
	 * The feed HTML comes from our own converter, so it is regular. Matching is
	 * byte-wise (no /u) and only touches matched tags, so non-ASCII text and all
	 * other markup pass through unchanged.
	 *
	 * @param string $html  Feed HTML.
	 * @param array  $map   filename => attachment id.
	 * @return string|null Rewritten HTML, or null if it could not be rewritten
	 *                     safely (regex failure) — the caller must not save it.
	 */
	public static function rewrite_html( $html, $map ) {
		$html = (string) $html;
		if ( false === strpos( $html, 'data-rv-ref' ) ) {
			return $html;
		}
		$map = (array) $map;

		// Pass 1: figures that wrap a referenced image — drop or rewrite whole.
		$out = preg_replace_callback(
			'#<figure\b[^>]*>.*?</figure>#is',
			function ( $m ) use ( $map ) {
				if ( false === strpos( $m[0], 'data-rv-ref' ) ) {
					return $m[0];
				}
				$ok    = true;
				$inner = preg_replace_callback(
					self::IMG_REF_PATTERN,
					function ( $img ) use ( $map, &$ok ) {
						$rewritten = self::rewrite_img( $img[0], html_entity_decode( $img[2], ENT_QUOTES, 'UTF-8' ), $map );
						if ( '' === $rewritten ) {
							$ok = false;
						}
						return $rewritten;
					},
					$m[0]
				);
				if ( null === $inner ) {
					return $m[0]; // Leave it for pass 2 to handle as bare imgs.
				}
				return $ok ? $inner : '';
			},
			$html
		);
		if ( null === $out ) {
			$out = $html;
		}

		// Pass 2: any referenced img left (not wrapped in a figure).
		$out = preg_replace_callback(
			self::IMG_REF_PATTERN,
			function ( $img ) use ( $map ) {
				return self::rewrite_img( $img[0], html_entity_decode( $img[2], ENT_QUOTES, 'UTF-8' ), $map );
			},
			$out
		);
		if ( null === $out || false !== strpos( $out, 'data-rv-ref' ) ) {
			return null;
		}
		return $out;
	}

	/**
	 * Rewrite one img tag for its attachment, or return '' to drop it.
	 *
	 * @param string $tag  The full `<img ...>` tag.
	 * @param string $ref  The decoded data-rv-ref value.
	 * @param array  $map  filename => attachment id.
	 * @return string
	 */
	private static function rewrite_img( $tag, $ref, $map ) {
		if ( ! isset( $map[ $ref ] ) ) {
			return '';
		}
		$id  = (int) $map[ $ref ];
		$url = wp_get_attachment_url( $id );
		if ( ! $id || ! $url ) {
			return '';
		}

		// Drop the ref attribute (quoted either way).
		$tag = preg_replace( '#\sdata-rv-ref\s*=\s*(["\']).*?\1#is', '', $tag );

		// src: replace in place, or add one. (?<=\s) keeps data-src etc. intact.
		$src   = 'src="' . esc_url( $url ) . '"';
		$count = 0;
		$tag   = preg_replace_callback(
			'#(?<=\s)src\s*=\s*(["\']).*?\1#is',
			function () use ( $src ) {
				return $src;
			},
			$tag,
			1,
			$count
		);
		if ( null !== $tag && 0 === $count ) {
			$tag = '<img ' . $src . substr( $tag, 4 );
		}
		if ( null === $tag ) {
			return '';
		}

		// class: append wp-image-{id}, or add one.
		$class = 'wp-image-' . $id;
		$count = 0;
		$tag   = preg_replace_callback(
			'#(?<=\s)class\s*=\s*(["\'])(.*?)\1#is',
			function ( $cm ) use ( $class ) {
				$classes = preg_split( '#\s+#', trim( $cm[2] ) );
				if ( ! in_array( $class, $classes, true ) ) {
					$classes[] = $class;
				}
				return 'class=' . $cm[1] . trim( implode( ' ', $classes ) ) . $cm[1];
			},
			$tag,
			1,
			$count
		);
		if ( null !== $tag && 0 === $count ) {
			$tag = '<img class="' . $class . '"' . substr( $tag, 4 );
		}

		return null === $tag ? '' : $tag;
	}

	/**
	 * Download an image's bytes, with the bearer when the feed says so.
	 *
	 * Kept short (filterable) so a single slow image can't push a sync run past
	 * the host's gateway timeout; the run's own budget checks between posts, and
	 * an image that misses this run retries on the next.
	 *
	 * @param array  $image   { url, requires_auth, ... }.
	 * @param string $secret  Bearer secret.
	 * @return string Body bytes, or '' on any failure.
	 */
	private static function fetch( $image, $secret ) {
		$timeout = (int) apply_filters( 'rv_blog_sync_image_timeout', 15 );
		$args    = array( 'timeout' => $timeout );
		if ( ! empty( $image['requires_auth'] ) && '' !== $secret ) {
			$args['headers'] = array( 'Authorization' => 'Bearer ' . $secret );
		}

		$response = wp_remote_get( $image['url'], $args );
		if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			return '';
		}
		return (string) wp_remote_retrieve_body( $response );
	}

	/**
	 * Write bytes to uploads and register them as an attachment of $parent_id,
	 * marked `_rv_synced` so later syncs may clean it up.
	 *
	 * @param string $body       Image bytes.
	 * @param array  $image      { filename, alt, ... }.
	 * @param string $fallback   Filename when the feed gives none.
	 * @param int    $parent_id  Post the attachment belongs to.
	 * @return int Attachment id, or 0 on failure.
	 */
	private static function insert_attachment( $body, $image, $fallback, $parent_id ) {
		$filename = ! empty( $image['filename'] ) ? sanitize_file_name( $image['filename'] ) : $fallback;

		require_once ABSPATH . 'wp-admin/includes/image.php';
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';

		$upload = wp_upload_bits( $filename, null, $body );
		if ( ! empty( $upload['error'] ) ) {
			return 0;
		}

		$filetype   = wp_check_filetype( $upload['file'], null );
		$attachment = array(
			'post_mime_type' => $filetype['type'] ? $filetype['type'] : 'image/jpeg',
			'post_title'     => sanitize_file_name( pathinfo( $filename, PATHINFO_FILENAME ) ),
			'post_content'   => '',
			'post_status'    => 'inherit',
		);
		$attach_id = wp_insert_attachment( $attachment, $upload['file'], $parent_id );
		if ( is_wp_error( $attach_id ) || ! $attach_id ) {
			return 0;
		}
		$attach_id = (int) $attach_id;
		update_post_meta( $attach_id, '_rv_synced', 1 );

		$metadata = wp_generate_attachment_metadata( $attach_id, $upload['file'] );
		wp_update_attachment_metadata( $attach_id, $metadata );

		if ( ! empty( $image['alt'] ) ) {
			update_post_meta( $attach_id, '_wp_attachment_image_alt', sanitize_text_field( $image['alt'] ) );
		}

		return $attach_id;
	}

	/**
	 * Delete an attachment only if this plugin created it, it isn't in $keep,
	 * and no post uses it as a featured image.
	 *
	 * @param int   $attach_id  Candidate attachment.
	 * @param int[] $keep       Ids that must survive (current thumbnail / map).
	 * @return bool True when deleted.
	 */
	private static function maybe_delete_synced( $attach_id, $keep ) {
		global $wpdb;

		$attach_id = (int) $attach_id;
		if ( ! $attach_id || in_array( $attach_id, array_map( 'intval', (array) $keep ), true ) ) {
			return false;
		}
		if ( 'attachment' !== get_post_type( $attach_id ) || ! get_post_meta( $attach_id, '_rv_synced', true ) ) {
			return false; // Not ours — never delete media a WordPress user uploaded.
		}
		$in_use = $wpdb->get_var(
			$wpdb->prepare(
				"SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_thumbnail_id' AND meta_value = %s LIMIT 1",
				(string) $attach_id
			)
		);
		if ( $in_use ) {
			return false;
		}
		return (bool) wp_delete_attachment( $attach_id, true );
	}

	/**
	 * The post's `_rv_inline_map`, normalized to filename => { sha, attach_id }.
	 *
	 * @param int $post_id  Target post.
	 * @return array
	 */
	private static function get_inline_map( $post_id ) {
		$raw = get_post_meta( $post_id, '_rv_inline_map', true );
		$map = array();
		if ( ! is_array( $raw ) ) {
			return $map;
		}
		foreach ( $raw as $filename => $entry ) {
			if ( ! is_array( $entry ) || empty( $entry['attach_id'] ) ) {
				continue;
			}
			$map[ (string) $filename ] = array(
				'sha'       => isset( $entry['sha'] ) ? (string) $entry['sha'] : '',
				'attach_id' => (int) $entry['attach_id'],
			);
		}
		return $map;
	}

	/**
	 * Attachment ids currently in the post's inline map.
	 *
	 * @param int $post_id  Target post.
	 * @return int[]
	 */
	private static function inline_attachment_ids( $post_id ) {
		$ids = array();
		foreach ( self::get_inline_map( $post_id ) as $entry ) {
			$ids[] = $entry['attach_id'];
		}
		return $ids;
	}

	/**
	 * True when the id is a live attachment.
	 *
	 * @param int $attach_id  Attachment id.
	 * @return bool
	 */
	private static function attachment_exists( $attach_id ) {
		return $attach_id && 'attachment' === get_post_type( (int) $attach_id );
	}
}
