<?php
/**
 * Plugin Name: Revaltus Blog Sync
 * Description: One-way pull of published blog posts from a Revaltus feed into WordPress. Authoring/editing stays in Revaltus; this site is a publish target.
 * Version:     1.3.0
 * Author:      Revaltus
 * Update URI:  https://revaltus.com/plugins/revaltus-blog-sync
 * Requires at least: 5.8
 * License:     GPL-2.0-or-later
 *
 * Isolated, removable bridge for the WordPress transition period. Polls an
 * app-served, bearer-authenticated JSON feed on WP-cron and upserts posts by
 * slug. It NEVER holds a GitHub token — only the feed URL + a shared secret.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // No direct access.
}

define( 'RV_BLOG_SYNC_VERSION', '1.3.0' );
define( 'RV_BLOG_SYNC_CRON_HOOK', 'rv_blog_sync_event' );
define( 'RV_BLOG_SYNC_OPTION', 'rv_blog_sync_settings' );
define( 'RV_BLOG_SYNC_PATH', plugin_dir_path( __FILE__ ) );
define( 'RV_BLOG_SYNC_FILE', __FILE__ );

require_once RV_BLOG_SYNC_PATH . 'includes/class-rv-settings.php';
require_once RV_BLOG_SYNC_PATH . 'includes/class-rv-media.php';
require_once RV_BLOG_SYNC_PATH . 'includes/class-rv-sync.php';
require_once RV_BLOG_SYNC_PATH . 'includes/class-rv-updater.php';

// Update notices + one-click updates from the Revaltus app (see the class).
RV_Blog_Sync_Updater::init();

/**
 * Allow the sync interval to be tuned; defaults to hourly. A custom interval is
 * registered so operators can pick "every 15 minutes" from settings.
 */
function rv_blog_sync_cron_schedules( $schedules ) {
	$schedules['rv_fifteen_minutes'] = array(
		'interval' => 15 * MINUTE_IN_SECONDS,
		'display'  => __( 'Every 15 minutes (Revaltus Blog Sync)', 'revaltus-blog-sync' ),
	);
	return $schedules;
}
add_filter( 'cron_schedules', 'rv_blog_sync_cron_schedules' );

/**
 * Schedule the recurring sync on activation using the configured interval.
 */
function rv_blog_sync_activate() {
	$settings = get_option( RV_BLOG_SYNC_OPTION, array() );
	$interval = isset( $settings['interval'] ) ? $settings['interval'] : 'hourly';
	if ( ! wp_next_scheduled( RV_BLOG_SYNC_CRON_HOOK ) ) {
		wp_schedule_event( time() + MINUTE_IN_SECONDS, $interval, RV_BLOG_SYNC_CRON_HOOK );
	}
}
register_activation_hook( __FILE__, 'rv_blog_sync_activate' );

/**
 * Clear the schedule on deactivation. Synced posts are left untouched.
 */
function rv_blog_sync_deactivate() {
	$timestamp = wp_next_scheduled( RV_BLOG_SYNC_CRON_HOOK );
	if ( $timestamp ) {
		wp_unschedule_event( $timestamp, RV_BLOG_SYNC_CRON_HOOK );
	}
	wp_clear_scheduled_hook( RV_BLOG_SYNC_CRON_HOOK );
}
register_deactivation_hook( __FILE__, 'rv_blog_sync_deactivate' );

// The cron event and the "Sync now" action both run the same worker.
add_action( RV_BLOG_SYNC_CRON_HOOK, array( 'RV_Blog_Sync', 'run' ) );

// Settings page (Settings → Revaltus Blog Sync) + "Sync now" handler.
add_action( 'admin_menu', array( 'RV_Blog_Sync_Settings', 'register_page' ) );
add_action( 'admin_init', array( 'RV_Blog_Sync_Settings', 'register_settings' ) );
add_action( 'admin_post_rv_blog_sync_now', array( 'RV_Blog_Sync_Settings', 'handle_sync_now' ) );
