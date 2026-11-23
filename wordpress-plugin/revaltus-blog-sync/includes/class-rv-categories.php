<?php
/**
 * Revaltus blog categories → WordPress category terms + post assignments.
 *
 * Revaltus is the source of truth for the categories it owns. Safety rules:
 * - A feed without a `categories` list (missing, not an array, or with no
 *   valid entry) changes nothing: reconcile() returns null and assign() is
 *   never called.
 * - Only terms carrying term meta `_rv_category_id` are ever renamed or
 *   deleted. Terms made by hand in WordPress are left alone.
 * - A hand-made term with a Revaltus category's slug is adopted
 *   (`_rv_adopted` = 1). It follows Revaltus renames while linked, but is only
 *   ever un-linked, never deleted.
 * - Terms imported from the Divi WXR export already carry `_rv_category_id`,
 *   so they count as owned.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class RV_Categories {

	const TERM_META_ID      = '_rv_category_id';
	const TERM_META_ADOPTED = '_rv_adopted';
	const POST_META         = '_rv_assigned_terms';

	/**
	 * Bring WordPress category terms in line with the feed's registry.
	 *
	 * @param array $feed Decoded feed.
	 * @return array<string,int>|null rv_id => term_id; null when the feed has no usable `categories` list (no-op).
	 */
	public static function reconcile( $feed ) {
		$registry = self::registry( $feed );
		if ( null === $registry ) {
			return null;
		}

		$owned = get_terms(
			array(
				'taxonomy'   => 'category',
				'hide_empty' => false,
				'meta_key'   => self::TERM_META_ID,
			)
		);
		if ( is_wp_error( $owned ) || ! is_array( $owned ) ) {
			// Can't tell which terms are ours: change nothing this run.
			self::log( 'could not list owned category terms; categories not synced this run' );
			return null;
		}

		// rv_id => term. Re-read the meta per term so nothing without it is acted on.
		$by_rv_id = array();
		$linked   = array(); // term_id => rv_id, every owned/adopted term.
		foreach ( $owned as $term ) {
			$rv_id = (string) get_term_meta( $term->term_id, self::TERM_META_ID, true );
			if ( '' === $rv_id ) {
				continue;
			}
			$linked[ (int) $term->term_id ] = $rv_id;
			if ( ! isset( $by_rv_id[ $rv_id ] ) ) {
				$by_rv_id[ $rv_id ] = $term;
			}
		}

		$map = array();
		foreach ( $registry['categories'] as $rv_id => $cat ) {
			if ( isset( $by_rv_id[ $rv_id ] ) ) {
				$term_id = (int) $by_rv_id[ $rv_id ]->term_id;
				self::update_term( $by_rv_id[ $rv_id ], $cat );
			} else {
				$term_id = self::create_or_adopt( $rv_id, $cat );
				if ( ! $term_id ) {
					continue;
				}
			}
			$map[ $rv_id ] = $term_id;
		}

		// Linked terms whose category left Revaltus. Ids of entries that were
		// present but malformed are kept, so a bad entry never deletes a term.
		$default = (int) get_option( 'default_category' );
		foreach ( $linked as $term_id => $rv_id ) {
			if ( isset( $registry['seen'][ $rv_id ] ) ) {
				continue;
			}
			$adopted = (bool) get_term_meta( $term_id, self::TERM_META_ADOPTED, true );
			if ( $adopted || $term_id === $default ) {
				// Hand-made (or WordPress's default category): un-link only.
				delete_term_meta( $term_id, self::TERM_META_ID );
				delete_term_meta( $term_id, self::TERM_META_ADOPTED );
				continue;
			}
			// WordPress moves the term's posts to the default category.
			$deleted = wp_delete_term( $term_id, 'category' );
			if ( ! $deleted || is_wp_error( $deleted ) ) {
				self::log( sprintf( 'could not delete category term %d (%s)', $term_id, $rv_id ) );
			}
		}

		return $map;
	}

	/**
	 * Set a post's categories from its feed category ids.
	 *
	 * The post gets exactly the feed's terms, plus any term someone added by
	 * hand in WordPress. Terms the plugin put there before (`_rv_assigned_terms`,
	 * or, for posts synced before 1.5.0, the settings/default category) are
	 * removed once Revaltus categories arrive.
	 *
	 * @param int               $post_id Post ID.
	 * @param string[]          $rv_ids  The post's category ids from the feed.
	 * @param array<string,int> $map     From reconcile().
	 * @return bool True when the post has Revaltus categories (handled). False
	 *              when it has none: the caller applies the settings-category fallback.
	 */
	public static function assign( $post_id, array $rv_ids, $map ) {
		$owned = array_map( 'intval', array_values( (array) $map ) );

		$want = array();
		foreach ( $rv_ids as $rv_id ) {
			if ( is_string( $rv_id ) && isset( $map[ $rv_id ] ) ) {
				$want[] = (int) $map[ $rv_id ];
			}
		}
		$want = self::ids( $want );

		$current = self::ids( wp_get_post_categories( $post_id ) );
		$stored  = get_post_meta( $post_id, self::POST_META, true );
		if ( is_array( $stored ) ) {
			$prev = self::ids( $stored );
		} else {
			// No record yet (synced before 1.5.0, or last fell back to the
			// settings category): the settings/default category is ours.
			$prev = array_values(
				array_intersect(
					$current,
					array_filter( array( RV_Blog_Sync::resolve_category(), (int) get_option( 'default_category' ) ) )
				)
			);
		}

		if ( $want ) {
			$keep = array_diff( $current, $owned, $prev );
			$next = self::ids( array_merge( $keep, $want ) );
			if ( $next !== $current ) {
				wp_set_post_categories( $post_id, $next, false );
			}
			if ( ! is_array( $stored ) || self::ids( $stored ) !== $want ) {
				update_post_meta( $post_id, self::POST_META, $want );
			}
			return true;
		}

		// No Revaltus categories: drop the ones we assigned, then the caller's
		// v1.2 fallback (settings category) applies.
		$next = array_values( array_diff( $current, array_intersect( $prev, $owned ) ) );
		if ( $next !== $current ) {
			// An empty list puts the post in WordPress's default category.
			wp_set_post_categories( $post_id, $next, false );
		}
		if ( '' !== $stored ) {
			delete_post_meta( $post_id, self::POST_META );
		}
		return false;
	}

	/**
	 * Valid registry entries from the feed, or null when the feed has no
	 * usable list. `seen` holds every id present, valid or not.
	 *
	 * @return array{categories: array<string,array{name:string,slug:string,description:string}>, seen: array<string,bool>}|null
	 */
	private static function registry( $feed ) {
		if ( ! is_array( $feed ) || ! array_key_exists( 'categories', $feed ) || ! is_array( $feed['categories'] ) ) {
			return null;
		}
		$categories = array();
		$seen       = array();
		foreach ( $feed['categories'] as $c ) {
			if ( ! is_array( $c ) || ! isset( $c['id'] ) || ! is_string( $c['id'] ) || '' === trim( $c['id'] ) ) {
				continue;
			}
			$rv_id          = trim( $c['id'] );
			$seen[ $rv_id ] = true;
			$name           = isset( $c['name'] ) && is_string( $c['name'] ) ? trim( $c['name'] ) : '';
			$slug           = isset( $c['slug'] ) && is_string( $c['slug'] ) ? sanitize_title( $c['slug'] ) : '';
			if ( '' === $name || '' === $slug || isset( $categories[ $rv_id ] ) ) {
				continue;
			}
			$categories[ $rv_id ] = array(
				'name'        => $name,
				'slug'        => $slug,
				'description' => isset( $c['description'] ) && is_string( $c['description'] ) ? trim( $c['description'] ) : '',
			);
		}
		// A non-empty list with no valid entry is a broken feed, not "no
		// categories": never let it delete every owned term.
		if ( ! $categories && $feed['categories'] ) {
			self::log( 'feed categories list had no valid entries; categories not synced this run' );
			return null;
		}
		return array( 'categories' => $categories, 'seen' => $seen );
	}

	/**
	 * Adopt a hand-made term with the same slug, else create the term.
	 *
	 * @return int Term ID, or 0 on failure.
	 */
	private static function create_or_adopt( $rv_id, $cat ) {
		$existing = get_term_by( 'slug', $cat['slug'], 'category' );
		if ( $existing && ! is_wp_error( $existing ) ) {
			if ( '' !== (string) get_term_meta( $existing->term_id, self::TERM_META_ID, true ) ) {
				// Linked to another Revaltus category (e.g. mid slug swap); retried next run.
				self::log( sprintf( 'category "%s" (%s): slug "%s" is used by another Revaltus category', $cat['name'], $rv_id, $cat['slug'] ) );
				return 0;
			}
			update_term_meta( $existing->term_id, self::TERM_META_ID, $rv_id );
			update_term_meta( $existing->term_id, self::TERM_META_ADOPTED, 1 );
			self::update_term( $existing, $cat );
			return (int) $existing->term_id;
		}

		$result = wp_insert_term(
			$cat['name'],
			'category',
			array(
				'slug'        => $cat['slug'],
				'description' => $cat['description'],
			)
		);
		if ( is_wp_error( $result ) || empty( $result['term_id'] ) ) {
			self::log( sprintf( 'could not create category "%s" (%s): %s', $cat['name'], $rv_id, is_wp_error( $result ) ? $result->get_error_message() : 'unknown error' ) );
			return 0;
		}
		update_term_meta( (int) $result['term_id'], self::TERM_META_ID, $rv_id );
		return (int) $result['term_id'];
	}

	/**
	 * Update a linked term's name/slug/description when they differ. If the
	 * new slug is taken by another term, keep the old slug and log.
	 */
	private static function update_term( $term, $cat ) {
		$args = array();
		if ( ! self::same_text( $term->name, $cat['name'] ) ) {
			$args['name'] = $cat['name'];
		}
		if ( (string) $term->slug !== $cat['slug'] ) {
			$args['slug'] = $cat['slug'];
		}
		if ( ! self::same_text( $term->description, $cat['description'] ) ) {
			$args['description'] = $cat['description'];
		}
		if ( ! $args ) {
			return;
		}

		$result = wp_update_term( (int) $term->term_id, 'category', $args );
		if ( is_wp_error( $result ) && isset( $args['slug'] ) ) {
			self::log( sprintf( 'category term %d: could not change slug to "%s" (%s); kept "%s"', $term->term_id, $cat['slug'], $result->get_error_message(), $term->slug ) );
			unset( $args['slug'] );
			$result = $args ? wp_update_term( (int) $term->term_id, 'category', $args ) : null;
		}
		if ( is_wp_error( $result ) ) {
			self::log( sprintf( 'could not update category term %d: %s', $term->term_id, $result->get_error_message() ) );
		}
	}

	/**
	 * WordPress stores term names/descriptions HTML-escaped ("&amp;"), so
	 * compare decoded text to avoid rewriting the term every run.
	 */
	private static function same_text( $stored, $wanted ) {
		return trim( html_entity_decode( (string) $stored, ENT_QUOTES, 'UTF-8' ) ) === trim( html_entity_decode( (string) $wanted, ENT_QUOTES, 'UTF-8' ) );
	}

	/**
	 * Sorted, unique, positive int ids.
	 */
	private static function ids( $list ) {
		$out = array_values( array_unique( array_filter( array_map( 'intval', (array) $list ) ) ) );
		sort( $out );
		return $out;
	}

	private static function log( $message ) {
		error_log( '[rv-blog-sync] ' . $message ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions
	}
}
