<?php
/**
 * Category sync harness for Revaltus Blog Sync 1.5.0.
 *
 * Runs the REAL plugin classes (RV_Categories, RV_Blog_Sync) against in-memory
 * stubs of the WordPress functions they call. Lives outside the plugin folder
 * so it never ships in the zip.
 *
 *   php wordpress-plugin/tests/categories-harness.php
 *
 * Prints PASS/FAIL per case; exits 1 on any failure.
 */

define( 'ABSPATH', __DIR__ . '/' );
define( 'RV_BLOG_SYNC_OPTION', 'rv_blog_sync_settings' );
define( 'RV_BLOG_SYNC_VERSION', 'harness' );

// error_log is a PHP builtin: route it to a temp file the cases can read.
$GLOBALS['rv_log_file'] = tempnam( sys_get_temp_dir(), 'rvlog' );
ini_set( 'log_errors', '1' );
ini_set( 'error_log', $GLOBALS['rv_log_file'] );

// ---------------------------------------------------------------------------
// In-memory WordPress.
// ---------------------------------------------------------------------------

class WP_Error {
	private $code;
	private $message;
	private $data;
	public function __construct( $code = '', $message = '', $data = '' ) {
		$this->code    = $code;
		$this->message = $message;
		$this->data    = $data;
	}
	public function get_error_code() {
		return $this->code;
	}
	public function get_error_message() {
		return $this->message;
	}
	public function get_error_data() {
		return $this->data;
	}
}

function rvh_reset() {
	$GLOBALS['rvh'] = array(
		'terms'     => array(), // id => array(term_id, name, slug, description)
		'term_meta' => array(), // id => array(key => value)
		'post_cats' => array(), // post_id => int[]
		'post_meta' => array(), // post_id => array(key => value)
		'options'   => array(),
		'next_id'   => 100,
		'calls'     => array(), // every term-table call, in order
		'transients' => array(),
		'fetches'   => array(), // per wp_remote_get: was the lock held?
	);
	file_put_contents( $GLOBALS['rv_log_file'], '' );
}

function rvh_call( $name ) {
	$GLOBALS['rvh']['calls'][] = $name;
}

function rvh_term_obj( $id ) {
	$t = $GLOBALS['rvh']['terms'][ $id ];
	return (object) array(
		'term_id'     => $id,
		'name'        => $t['name'],
		'slug'        => $t['slug'],
		'description' => $t['description'],
		'taxonomy'    => 'category',
	);
}

function rvh_slug_owner( $slug, $except = 0 ) {
	foreach ( $GLOBALS['rvh']['terms'] as $id => $t ) {
		if ( $t['slug'] === $slug && $id !== $except ) {
			return $id;
		}
	}
	return 0;
}

/** Seed a term; $meta is term meta. Returns its id. */
function rvh_term( $name, $slug, $meta = array(), $description = '' ) {
	$id = $GLOBALS['rvh']['next_id']++;
	$GLOBALS['rvh']['terms'][ $id ]     = array( 'name' => $name, 'slug' => $slug, 'description' => $description );
	$GLOBALS['rvh']['term_meta'][ $id ] = $meta;
	return $id;
}

function rvh_terms_by_slug() {
	$out = array();
	foreach ( $GLOBALS['rvh']['terms'] as $id => $t ) {
		$out[ $t['slug'] ] = $id;
	}
	return $out;
}

function sanitize_title( $s ) {
	return trim( preg_replace( '/[^a-z0-9]+/', '-', strtolower( (string) $s ) ), '-' );
}

function get_option( $key, $default = false ) {
	return array_key_exists( $key, $GLOBALS['rvh']['options'] ) ? $GLOBALS['rvh']['options'][ $key ] : $default;
}

function is_wp_error( $thing ) {
	return $thing instanceof WP_Error;
}

function get_terms( $args ) {
	rvh_call( 'get_terms' );
	$out = array();
	foreach ( $GLOBALS['rvh']['terms'] as $id => $t ) {
		if ( isset( $args['meta_key'] ) && ! isset( $GLOBALS['rvh']['term_meta'][ $id ][ $args['meta_key'] ] ) ) {
			continue;
		}
		$out[] = rvh_term_obj( $id );
	}
	return $out;
}

function get_term_by( $field, $value, $taxonomy ) {
	rvh_call( 'get_term_by' );
	foreach ( $GLOBALS['rvh']['terms'] as $id => $t ) {
		if ( ( 'slug' === $field && $t['slug'] === $value )
			|| ( 'name' === $field && $t['name'] === $value )
			|| ( 'id' === $field && (int) $value === $id ) ) {
			return rvh_term_obj( $id );
		}
	}
	return false;
}

function term_exists( $term, $taxonomy = '' ) {
	return isset( $GLOBALS['rvh']['terms'][ (int) $term ] ) ? array( 'term_id' => (int) $term ) : null;
}

function wp_insert_term( $name, $taxonomy, $args = array() ) {
	rvh_call( 'wp_insert_term' );
	$slug = ! empty( $args['slug'] ) ? $args['slug'] : sanitize_title( $name );
	// Like WordPress: a same-name term only blocks the insert when no slug was
	// given, or the given slug is that term's or is already taken.
	foreach ( $GLOBALS['rvh']['terms'] as $id => $t ) {
		if ( $t['name'] === $name && ( empty( $args['slug'] ) || $t['slug'] === $slug || rvh_slug_owner( $slug ) ) ) {
			return new WP_Error( 'term_exists', 'A term with the name provided already exists.', $id );
		}
	}
	$base = $slug;
	$n    = 2;
	while ( rvh_slug_owner( $slug ) ) {
		$slug = $base . '-' . $n++;
	}
	$id = $GLOBALS['rvh']['next_id']++;
	$GLOBALS['rvh']['terms'][ $id ]     = array(
		'name'        => $name,
		'slug'        => $slug,
		'description' => isset( $args['description'] ) ? $args['description'] : '',
	);
	$GLOBALS['rvh']['term_meta'][ $id ] = array();
	return array( 'term_id' => $id, 'term_taxonomy_id' => $id );
}

function wp_update_term( $id, $taxonomy, $args = array() ) {
	rvh_call( 'wp_update_term' );
	if ( ! isset( $GLOBALS['rvh']['terms'][ $id ] ) ) {
		return new WP_Error( 'invalid_term', 'Empty Term.' );
	}
	if ( isset( $args['slug'] ) && rvh_slug_owner( $args['slug'], $id ) ) {
		return new WP_Error( 'duplicate_term_slug', 'The slug is already in use by another term.' );
	}
	foreach ( array( 'name', 'slug', 'description' ) as $k ) {
		if ( isset( $args[ $k ] ) ) {
			$GLOBALS['rvh']['terms'][ $id ][ $k ] = $args[ $k ];
		}
	}
	return array( 'term_id' => $id, 'term_taxonomy_id' => $id );
}

function wp_delete_term( $id, $taxonomy ) {
	rvh_call( 'wp_delete_term' );
	$default = (int) get_option( 'default_category' );
	if ( $id === $default || ! isset( $GLOBALS['rvh']['terms'][ $id ] ) ) {
		return 0;
	}
	unset( $GLOBALS['rvh']['terms'][ $id ], $GLOBALS['rvh']['term_meta'][ $id ] );
	// Like WordPress: posts left with no category fall into the default.
	foreach ( $GLOBALS['rvh']['post_cats'] as $pid => $cats ) {
		$cats = array_values( array_diff( $cats, array( $id ) ) );
		$GLOBALS['rvh']['post_cats'][ $pid ] = $cats ? $cats : array( $default );
	}
	return true;
}

function get_term_meta( $id, $key = '', $single = false ) {
	$v = isset( $GLOBALS['rvh']['term_meta'][ $id ][ $key ] ) ? $GLOBALS['rvh']['term_meta'][ $id ][ $key ] : '';
	return $single ? $v : ( '' === $v ? array() : array( $v ) );
}

function update_term_meta( $id, $key, $value ) {
	rvh_call( 'update_term_meta' );
	$GLOBALS['rvh']['term_meta'][ $id ][ $key ] = $value;
	return true;
}

function delete_term_meta( $id, $key ) {
	rvh_call( 'delete_term_meta' );
	unset( $GLOBALS['rvh']['term_meta'][ $id ][ $key ] );
	return true;
}

function wp_get_post_categories( $post_id ) {
	return isset( $GLOBALS['rvh']['post_cats'][ $post_id ] ) ? $GLOBALS['rvh']['post_cats'][ $post_id ] : array();
}

function wp_set_post_categories( $post_id, $cats = array(), $append = false ) {
	$cats = array_values( array_unique( array_map( 'intval', $cats ) ) );
	if ( ! $cats ) {
		$cats = array( (int) get_option( 'default_category' ) );
	}
	$GLOBALS['rvh']['post_cats'][ $post_id ] = $cats;
	return $cats;
}

function get_post_meta( $post_id, $key = '', $single = false ) {
	$v = isset( $GLOBALS['rvh']['post_meta'][ $post_id ][ $key ] ) ? $GLOBALS['rvh']['post_meta'][ $post_id ][ $key ] : '';
	return $single ? $v : ( '' === $v ? array() : array( $v ) );
}

function update_post_meta( $post_id, $key, $value ) {
	$GLOBALS['rvh']['post_meta'][ $post_id ][ $key ] = $value;
	return true;
}

function delete_post_meta( $post_id, $key ) {
	unset( $GLOBALS['rvh']['post_meta'][ $post_id ][ $key ] );
	return true;
}

function get_transient( $key ) {
	return isset( $GLOBALS['rvh']['transients'][ $key ] ) ? $GLOBALS['rvh']['transients'][ $key ] : false;
}

function set_transient( $key, $value, $ttl = 0 ) {
	$GLOBALS['rvh']['transients'][ $key ] = $value;
	return true;
}

function delete_transient( $key ) {
	unset( $GLOBALS['rvh']['transients'][ $key ] );
	return true;
}

function __( $text, $domain = 'default' ) {
	return $text;
}

function apply_filters( $hook, $value ) {
	return $value;
}

/** The feed fetch: records whether the lock was held, then fails (no network). */
function wp_remote_get( $url, $args = array() ) {
	$GLOBALS['rvh']['fetches'][] = (bool) get_transient( 'rv_blog_sync_lock' );
	return new WP_Error( 'http_request_failed', 'harness: no network' );
}

function get_post_field( $field, $post_id ) {
	return 1; // Every harness post already has an author.
}

// The real plugin code under test.
require __DIR__ . '/../revaltus-blog-sync/includes/class-rv-categories.php';
require __DIR__ . '/../revaltus-blog-sync/includes/class-rv-sync.php';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

$GLOBALS['rv_failures'] = 0;

function check( $label, $ok, $detail = '' ) {
	if ( $ok ) {
		echo "PASS  {$label}\n";
	} else {
		$GLOBALS['rv_failures']++;
		echo "FAIL  {$label}" . ( '' !== $detail ? "  ({$detail})" : '' ) . "\n";
	}
}

function same_set( $a, $b ) {
	$a = array_map( 'intval', $a );
	$b = array_map( 'intval', $b );
	sort( $a );
	sort( $b );
	return $a === $b;
}

function cat( $id, $name, $slug, $description = '' ) {
	return array( 'id' => $id, 'name' => $name, 'slug' => $slug, 'description' => $description );
}

function term_writes() {
	return array_values(
		array_filter(
			$GLOBALS['rvh']['calls'],
			function ( $c ) {
				return 'get_terms' !== $c && 'get_term_by' !== $c;
			}
		)
	);
}

/** Base site: default "Uncategorized" (1st term) + settings category "Blog". */
function site() {
	rvh_reset();
	$uncat = rvh_term( 'Uncategorized', 'uncategorized' );
	$blog  = rvh_term( 'Blog', 'blog' );
	$GLOBALS['rvh']['options']['default_category'] = $uncat;
	$GLOBALS['rvh']['options'][ RV_BLOG_SYNC_OPTION ] = array( 'category' => $blog );
	return array( $uncat, $blog );
}

/** The plugin's per-post assignment step (fast path and upsert both use it). */
function apply_assignments( $post_id, $is_new, $rv_ids, $map ) {
	$m = new ReflectionMethod( 'RV_Blog_Sync', 'apply_assignments' );
	$m->setAccessible( true );
	$m->invoke( null, $post_id, $is_new, $rv_ids, $map );
}

function content_hash( $post ) {
	$m = new ReflectionMethod( 'RV_Blog_Sync', 'content_hash' );
	$m->setAccessible( true );
	return $m->invoke( null, $post );
}

function log_text() {
	return (string) file_get_contents( $GLOBALS['rv_log_file'] );
}

// ---------------------------------------------------------------------------
// Term reconcile.
// ---------------------------------------------------------------------------

// create
site();
$map   = RV_Categories::reconcile( array( 'posts' => array(), 'categories' => array( cat( 'c-1', 'Construction', 'construction', 'Builders' ) ) ) );
$slugs = rvh_terms_by_slug();
$id    = isset( $slugs['construction'] ) ? $slugs['construction'] : 0;
check(
	'create: missing category becomes an owned term',
	$id && array( 'c-1' => $id ) === $map
		&& 'c-1' === get_term_meta( $id, '_rv_category_id', true )
		&& '' === get_term_meta( $id, '_rv_adopted', true )
		&& 'Builders' === $GLOBALS['rvh']['terms'][ $id ]['description']
);

// create is idempotent
$GLOBALS['rvh']['calls'] = array();
$map2 = RV_Categories::reconcile( array( 'posts' => array(), 'categories' => array( cat( 'c-1', 'Construction', 'construction', 'Builders' ) ) ) );
check( 'create: second run with no change writes nothing', $map2 === $map && array() === term_writes(), implode( ',', term_writes() ) );

// adopt
site();
$hand = rvh_term( 'Construction', 'construction' );
$map  = RV_Categories::reconcile( array( 'categories' => array( cat( 'c-1', 'Construction', 'construction' ) ) ) );
check(
	'adopt: same-slug hand term is linked, not duplicated',
	array( 'c-1' => $hand ) === $map
		&& 'c-1' === get_term_meta( $hand, '_rv_category_id', true )
		&& 1 === (int) get_term_meta( $hand, '_rv_adopted', true )
		&& 3 === count( $GLOBALS['rvh']['terms'] )
);

// rename
site();
$own = rvh_term( 'Construction', 'construction', array( '_rv_category_id' => 'c-1' ) );
$map = RV_Categories::reconcile( array( 'categories' => array( cat( 'c-1', 'Building & Construction', 'building-construction', 'New' ) ) ) );
$t   = $GLOBALS['rvh']['terms'][ $own ];
check(
	'rename: owned term follows name, slug and description',
	array( 'c-1' => $own ) === $map && 'Building & Construction' === $t['name'] && 'building-construction' === $t['slug'] && 'New' === $t['description']
);

// rename: stored names come back HTML-escaped from WordPress; no churn.
$GLOBALS['rvh']['terms'][ $own ]['name'] = 'Building &amp; Construction';
$GLOBALS['rvh']['calls']                 = array();
RV_Categories::reconcile( array( 'categories' => array( cat( 'c-1', 'Building & Construction', 'building-construction', 'New' ) ) ) );
check( 'rename: escaped stored name is not rewritten every run', array() === term_writes(), implode( ',', term_writes() ) );

// rename with a slug conflict: keep the old slug, update the name, log.
site();
$own   = rvh_term( 'Construction', 'construction', array( '_rv_category_id' => 'c-1' ) );
$other = rvh_term( 'Builders', 'builders' );
$map   = RV_Categories::reconcile( array( 'categories' => array( cat( 'c-1', 'Builders Group', 'builders' ) ) ) );
$t     = $GLOBALS['rvh']['terms'][ $own ];
check(
	'rename: slug taken by another term keeps old slug, updates name, logs',
	array( 'c-1' => $own ) === $map && 'Builders Group' === $t['name'] && 'construction' === $t['slug']
		&& 'Builders' === $GLOBALS['rvh']['terms'][ $other ]['name'] && 'builders' === $GLOBALS['rvh']['terms'][ $other ]['slug']
		&& false !== strpos( log_text(), '[rv-blog-sync]' ),
	log_text()
);

// adopted terms follow Revaltus while linked
site();
$adopted = rvh_term( 'Construction', 'construction', array( '_rv_category_id' => 'c-1', '_rv_adopted' => 1 ) );
RV_Categories::reconcile( array( 'categories' => array( cat( 'c-1', 'Contractors', 'contractors' ) ) ) );
check(
	'rename: adopted term is renamed while linked',
	'Contractors' === $GLOBALS['rvh']['terms'][ $adopted ]['name'] && 'contractors' === $GLOBALS['rvh']['terms'][ $adopted ]['slug']
);

// delete-owned
site();
$own  = rvh_term( 'Construction', 'construction', array( '_rv_category_id' => 'c-1' ) );
$keep = rvh_term( 'Nonprofits', 'nonprofits', array( '_rv_category_id' => 'c-2' ) );
$map  = RV_Categories::reconcile( array( 'categories' => array( cat( 'c-2', 'Nonprofits', 'nonprofits' ) ) ) );
check(
	'delete-owned: owned term no longer in the feed is deleted',
	! isset( $GLOBALS['rvh']['terms'][ $own ] ) && isset( $GLOBALS['rvh']['terms'][ $keep ] ) && array( 'c-2' => $keep ) === $map
);

// removed adopted term: unlinked, kept
site();
$adopted = rvh_term( 'Construction', 'construction', array( '_rv_category_id' => 'c-1', '_rv_adopted' => 1 ) );
RV_Categories::reconcile( array( 'categories' => array() ) );
check(
	'adopted: removed from feed → meta removed, term kept, never renamed',
	isset( $GLOBALS['rvh']['terms'][ $adopted ] ) && 'Construction' === $GLOBALS['rvh']['terms'][ $adopted ]['name']
		&& '' === get_term_meta( $adopted, '_rv_category_id', true ) && '' === get_term_meta( $adopted, '_rv_adopted', true )
		&& ! in_array( 'wp_delete_term', $GLOBALS['rvh']['calls'], true )
);

// feed without categories key → zero term calls
site();
$own  = rvh_term( 'Construction', 'construction', array( '_rv_category_id' => 'c-1' ) );
$GLOBALS['rvh']['calls'] = array();
$map  = RV_Categories::reconcile( array( 'posts' => array() ) );
check( 'no key: feed without categories makes zero term calls', null === $map && array() === $GLOBALS['rvh']['calls'], implode( ',', $GLOBALS['rvh']['calls'] ) );

// non-array categories → treated as absent
foreach ( array( 'null' => null, 'string' => 'oops', 'object-ish' => 7 ) as $label => $bad ) {
	$GLOBALS['rvh']['calls'] = array();
	$map = RV_Categories::reconcile( array( 'categories' => $bad ) );
	check( "no key: non-array categories ({$label}) is a no-op", null === $map && array() === $GLOBALS['rvh']['calls'] );
}

// non-empty but every entry invalid → treated as absent (never mass-delete)
$GLOBALS['rvh']['calls'] = array();
$map = RV_Categories::reconcile( array( 'categories' => array( 'x', array( 'name' => 'No id' ), array( 'id' => 'c-9' ) ) ) );
check( 'no key: all-invalid category list is a no-op', null === $map && array() === $GLOBALS['rvh']['calls'] && isset( $GLOBALS['rvh']['terms'][ $own ] ) );

// categories: [] → owned terms deleted, hand terms untouched
site();
list( $uncat, $blog ) = array( $GLOBALS['rvh']['options']['default_category'], $GLOBALS['rvh']['options'][ RV_BLOG_SYNC_OPTION ]['category'] );
$own  = rvh_term( 'Construction', 'construction', array( '_rv_category_id' => 'c-1' ) );
$hand = rvh_term( 'Featured', 'featured' );
$map  = RV_Categories::reconcile( array( 'categories' => array() ) );
check(
	'empty list: owned terms deleted; hand terms + default untouched',
	array() === $map && ! isset( $GLOBALS['rvh']['terms'][ $own ] )
		&& isset( $GLOBALS['rvh']['terms'][ $hand ], $GLOBALS['rvh']['terms'][ $uncat ], $GLOBALS['rvh']['terms'][ $blog ] )
		&& 'Featured' === $GLOBALS['rvh']['terms'][ $hand ]['name']
);

// never delete or rename a term without _rv_category_id
site();
$hand = rvh_term( 'Construction', 'construction-old' );
RV_Categories::reconcile( array( 'categories' => array( cat( 'c-1', 'Construction', 'construction' ) ) ) );
$slugs = rvh_terms_by_slug();
check(
	'safety: same-name hand term with another slug is left alone',
	isset( $GLOBALS['rvh']['terms'][ $hand ] ) && 'construction-old' === $GLOBALS['rvh']['terms'][ $hand ]['slug']
		&& array() === $GLOBALS['rvh']['term_meta'][ $hand ]
		&& isset( $slugs['construction'] ) && 'c-1' === get_term_meta( $slugs['construction'], '_rv_category_id', true )
);
RV_Categories::reconcile( array( 'categories' => array() ) );
check( 'safety: hand term survives the owned term being deleted', isset( $GLOBALS['rvh']['terms'][ $hand ] ) );

// same-name hand term (other slug): created alongside, operator is told
site();
$hand = rvh_term( 'Construction', 'construction-old' );
RV_Categories::reconcile( array( 'categories' => array( cat( 'c-1', 'Construction', 'construction' ) ) ) );
check(
	'safety: same-name hand term is not adopted by name; a merge note is logged',
	'construction-old' === $GLOBALS['rvh']['terms'][ $hand ]['slug'] && array() === $GLOBALS['rvh']['term_meta'][ $hand ]
		&& false !== strpos( log_text(), '[rv-blog-sync]' ) && false !== strpos( log_text(), 'construction-old' ),
	log_text()
);

// slug reuse in one publish: delete c-1 "tax" + create c-9 "tax"
site();
$old = rvh_term( 'Tax', 'tax', array( '_rv_category_id' => 'c-1' ) );
$map = RV_Categories::reconcile( array( 'categories' => array( cat( 'c-9', 'Tax', 'tax' ) ) ) );
$slugs = rvh_terms_by_slug();
check(
	'slug reuse: deleted category\'s slug is reused by a new one in the same run',
	! isset( $GLOBALS['rvh']['terms'][ $old ] ) && isset( $slugs['tax'], $map['c-9'] ) && $map['c-9'] === $slugs['tax']
		&& 'c-9' === get_term_meta( $slugs['tax'], '_rv_category_id', true )
);

// slug reuse: rename c-2 into c-1's freed slug
site();
$c1  = rvh_term( 'Tax', 'tax', array( '_rv_category_id' => 'c-1' ) );
$c2  = rvh_term( 'Taxes', 'taxes', array( '_rv_category_id' => 'c-2' ) );
$map = RV_Categories::reconcile( array( 'categories' => array( cat( 'c-2', 'Tax', 'tax' ) ) ) );
check(
	'slug reuse: rename into a slug freed by a deletion converges in one run',
	! isset( $GLOBALS['rvh']['terms'][ $c1 ] ) && 'tax' === $GLOBALS['rvh']['terms'][ $c2 ]['slug'] && 'Tax' === $GLOBALS['rvh']['terms'][ $c2 ]['name']
		&& array( 'c-2' => $c2 ) === $map
);

// owned default category: never deleted, only unlinked
site();
$uncat = $GLOBALS['rvh']['options']['default_category'];
$GLOBALS['rvh']['term_meta'][ $uncat ]['_rv_category_id'] = 'c-1';
RV_Categories::reconcile( array( 'categories' => array() ) );
check(
	'safety: owned term that is the default category is unlinked, not deleted',
	isset( $GLOBALS['rvh']['terms'][ $uncat ] ) && '' === get_term_meta( $uncat, '_rv_category_id', true )
		&& ! in_array( 'wp_delete_term', $GLOBALS['rvh']['calls'], true )
);

// WXR-imported term carries _rv_category_id → owned, not adopted
site();
$wxr = rvh_term( 'Construction', 'construction', array( '_rv_category_id' => 'c-1' ) );
$map = RV_Categories::reconcile( array( 'categories' => array( cat( 'c-1', 'Construction', 'construction' ) ) ) );
check( 'wxr: imported term with _rv_category_id counts as owned', array( 'c-1' => $wxr ) === $map && '' === get_term_meta( $wxr, '_rv_adopted', true ) );
RV_Categories::reconcile( array( 'categories' => array() ) );
check( 'wxr: imported term is deleted like any owned term', ! isset( $GLOBALS['rvh']['terms'][ $wxr ] ) );

// ---------------------------------------------------------------------------
// Post assignment.
// ---------------------------------------------------------------------------

$feed2 = array( 'categories' => array( cat( 'c-1', 'Construction', 'construction' ), cat( 'c-2', 'Nonprofits', 'nonprofits' ) ) );

// settings category "Blog" + feed [c-1] → {Construction}
list( $uncat, $blog ) = site();
$map = RV_Categories::reconcile( $feed2 );
$GLOBALS['rvh']['post_cats'][1] = array( $blog );
apply_assignments( 1, false, array( 'c-1' ), $map );
check( 'assign: 1.2-era post in "Blog" + [c-1] → {Construction}', same_set( array( $map['c-1'] ), wp_get_post_categories( 1 ) ) );

// default category is migrated away too
$GLOBALS['rvh']['post_cats'][2] = array( $uncat );
apply_assignments( 2, false, array( 'c-2' ), $map );
check( 'assign: 1.2-era post in default category + [c-2] → {Nonprofits}', same_set( array( $map['c-2'] ), wp_get_post_categories( 2 ) ) );

// hand term kept across category changes
$featured = rvh_term( 'Featured', 'featured' );
$GLOBALS['rvh']['post_cats'][3] = array( $featured, $blog );
apply_assignments( 3, false, array( 'c-1' ), $map );
check( 'assign: hand "Featured" + [c-1] → {Featured, Construction}', same_set( array( $featured, $map['c-1'] ), wp_get_post_categories( 3 ) ) );
apply_assignments( 3, false, array( 'c-2' ), $map );
check( 'assign: then [c-2] → {Featured, Nonprofits}', same_set( array( $featured, $map['c-2'] ), wp_get_post_categories( 3 ) ) );

// "Blog" added by hand after Revaltus categories arrived is kept
$GLOBALS['rvh']['post_cats'][3][] = $blog;
apply_assignments( 3, false, array( 'c-1' ), $map );
check( 'assign: settings category added by hand later is kept', same_set( array( $featured, $blog, $map['c-1'] ), wp_get_post_categories( 3 ) ) );

// loses all categories → falls back to "Blog"
$GLOBALS['rvh']['post_cats'][4] = array( $blog );
apply_assignments( 4, false, array( 'c-1', 'c-2' ), $map );
check( 'assign: multiple categories', same_set( array( $map['c-1'], $map['c-2'] ), wp_get_post_categories( 4 ) ) );
apply_assignments( 4, false, array(), $map );
check( 'assign: post loses all categories → falls back to "Blog"', same_set( array( $blog ), wp_get_post_categories( 4 ) ) );
apply_assignments( 4, false, array( 'c-2' ), $map );
check( 'assign: fallback "Blog" is replaced when categories return', same_set( array( $map['c-2'] ), wp_get_post_categories( 4 ) ) );

// last Revaltus category deleted from the registry → falls back to "Blog"
$map = RV_Categories::reconcile( array( 'categories' => array( cat( 'c-1', 'Construction', 'construction' ) ) ) );
apply_assignments( 4, false, array(), $map );
check( 'assign: post whose category was deleted falls back to "Blog"', same_set( array( $blog ), wp_get_post_categories( 4 ) ) );

// unknown ids are dropped
apply_assignments( 5, true, array( 'c-404' ), $map );
check( 'assign: unknown ids dropped; new post gets the settings category', same_set( array( $blog ), wp_get_post_categories( 5 ) ) );

// no categories key → map null → v1.2 behaviour only (Revaltus terms untouched)
$GLOBALS['rvh']['post_cats'][6] = array( $map['c-1'] );
apply_assignments( 6, false, array( 'c-2' ), null );
check( 'assign: no registry → post categories unchanged (v1.2 only)', same_set( array( $map['c-1'] ), wp_get_post_categories( 6 ) ) );
$GLOBALS['rvh']['post_cats'][7] = array( $uncat );
apply_assignments( 7, false, array( 'c-1' ), null );
check( 'assign: no registry → v1.2 still moves default → "Blog"', same_set( array( $blog ), wp_get_post_categories( 7 ) ) );

// adopted term on a post, category removed from the feed → settings category
list( $uncat2, $blog2 ) = site();
$tax = rvh_term( 'Tax', 'tax' );
$m   = RV_Categories::reconcile( array( 'categories' => array( cat( 'c-1', 'Tax', 'tax' ) ) ) );
$GLOBALS['rvh']['post_cats'][20] = array( $blog2 );
apply_assignments( 20, false, array( 'c-1' ), $m );
$ok_adopted = array( 'c-1' => $tax ) === $m && same_set( array( $tax ), wp_get_post_categories( 20 ) );
$m = RV_Categories::reconcile( array( 'categories' => array() ) );
apply_assignments( 20, false, array(), $m );
check(
	'assign: adopted category removed from feed → post falls back to "Blog"; term kept',
	$ok_adopted && same_set( array( $blog2 ), wp_get_post_categories( 20 ) ) && isset( $GLOBALS['rvh']['terms'][ $tax ] )
);
// ---------------------------------------------------------------------------
// Run lock.
// ---------------------------------------------------------------------------

site();
$GLOBALS['rvh']['options'][ RV_BLOG_SYNC_OPTION ] += array( 'enabled' => 1, 'feed_url' => 'https://example.test/feed', 'secret' => 's' );
$own = rvh_term( 'Construction', 'construction', array( '_rv_category_id' => 'c-1' ) );
set_transient( 'rv_blog_sync_lock', 1, 120 );
$GLOBALS['rvh']['calls'] = array();
$r = RV_Blog_Sync::run();
check(
	'lock: a run while another holds the lock fetches nothing, writes no terms, keeps the lock',
	is_wp_error( $r ) && 'rv_busy' === $r->get_error_code() && array() === $GLOBALS['rvh']['fetches']
		&& array() === $GLOBALS['rvh']['calls'] && false !== get_transient( 'rv_blog_sync_lock' )
);
delete_transient( 'rv_blog_sync_lock' );
$r = RV_Blog_Sync::run();
check(
	'lock: an unlocked run holds the lock while fetching and releases it after',
	is_wp_error( $r ) && 'http_request_failed' === $r->get_error_code() && array( true ) === $GLOBALS['rvh']['fetches']
		&& false === get_transient( 'rv_blog_sync_lock' )
);

// ---------------------------------------------------------------------------
// Content hash.
// ---------------------------------------------------------------------------

$post = array( 'slug' => 'a', 'title' => 'A', 'html' => '<p>x</p>', 'categories' => array( 'c-1' ) );
$h1   = content_hash( $post );
$post['categories'] = array( 'c-2' );
$h2   = content_hash( $post );
$post['categories'] = array( 'c-1' );
check( 'hash: changes when only the category ids change', $h1 !== $h2 && content_hash( $post ) === $h1 );
$bare = array( 'slug' => 'a', 'title' => 'A', 'html' => '<p>x</p>' );
check( 'hash: post without categories hashes like an empty list', content_hash( $bare ) === content_hash( $bare + array( 'categories' => array() ) ) );

@unlink( $GLOBALS['rv_log_file'] );

if ( $GLOBALS['rv_failures'] ) {
	echo "\n{$GLOBALS['rv_failures']} FAILED\n";
	exit( 1 );
}
echo "\nALL PASS\n";
exit( 0 );
