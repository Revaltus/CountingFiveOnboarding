<?php
/**
 * Self-hosted updates for Revaltus Blog Sync.
 *
 * WordPress.org doesn't host this plugin, so the plugin header's `Update URI`
 * routes WP's update check to the `update_plugins_revaltus.com` filter below.
 * The release info comes from the same Revaltus app as the feed
 * ({feed_url}/plugin) with the same bearer secret, and the package download
 * gets that header added for its one URL only. WordPress then shows its normal
 * "new version available" notice and one-click update.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class RV_Blog_Sync_Updater {

	const SLUG          = 'revaltus-blog-sync';
	const TRANSIENT     = 'rv_blog_sync_update_info';
	const CACHE_TTL     = 12 * HOUR_IN_SECONDS;
	const FAIL_TTL      = HOUR_IN_SECONDS;
	const UPDATE_HOST   = 'revaltus.com';

	/**
	 * Register the update hooks.
	 *
	 * @return void
	 */
	public static function init() {
		add_filter( 'update_plugins_' . self::UPDATE_HOST, array( __CLASS__, 'check_update' ), 10, 3 );
		add_filter( 'plugins_api', array( __CLASS__, 'plugin_info' ), 10, 3 );
		add_filter( 'http_request_args', array( __CLASS__, 'auth_package_download' ), 10, 2 );
		add_action( 'upgrader_process_complete', array( __CLASS__, 'flush_cache' ), 10, 0 );
		add_action( 'update_option_' . RV_BLOG_SYNC_OPTION, array( __CLASS__, 'flush_cache' ), 10, 0 );
		// Dashboard → Updates → "Check again" should see a new release at once.
		add_action( 'load-update-core.php', array( __CLASS__, 'flush_on_force_check' ) );
	}

	/**
	 * This plugin's basename, e.g. revaltus-blog-sync/revaltus-blog-sync.php.
	 *
	 * @return string
	 */
	private static function basename() {
		return plugin_basename( RV_BLOG_SYNC_FILE );
	}

	/**
	 * Feed URL + secret from settings, or null when unconfigured.
	 *
	 * @return array|null { info_url, download_prefix, secret }
	 */
	private static function endpoints() {
		$settings = get_option( RV_BLOG_SYNC_OPTION, array() );
		$feed_url = isset( $settings['feed_url'] ) ? untrailingslashit( $settings['feed_url'] ) : '';
		$secret   = isset( $settings['secret'] ) ? $settings['secret'] : '';
		if ( '' === $feed_url || '' === $secret ) {
			return null;
		}
		return array(
			'info_url'     => $feed_url . '/plugin',
			'download_url' => $feed_url . '/plugin/download',
			'secret'       => $secret,
		);
	}

	/**
	 * Latest release info from Revaltus, cached. A failed check is cached
	 * briefly too so an unreachable server doesn't slow every admin page.
	 *
	 * @return array|null Decoded release info, or null.
	 */
	private static function fetch_info() {
		$cached = get_site_transient( self::TRANSIENT );
		if ( is_array( $cached ) ) {
			return empty( $cached['version'] ) ? null : $cached;
		}

		$ep = self::endpoints();
		if ( ! $ep ) {
			return null;
		}

		$response = wp_remote_get(
			$ep['info_url'],
			array(
				'timeout' => 10,
				'headers' => array(
					'Authorization'       => 'Bearer ' . $ep['secret'],
					'X-RV-Plugin-Version' => RV_BLOG_SYNC_VERSION,
				),
			)
		);
		$info = null;
		if ( ! is_wp_error( $response ) && 200 === (int) wp_remote_retrieve_response_code( $response ) ) {
			$data = json_decode( wp_remote_retrieve_body( $response ), true );
			if ( is_array( $data ) && ! empty( $data['version'] ) && is_string( $data['version'] ) ) {
				$info = $data;
			}
		}

		if ( $info ) {
			set_site_transient( self::TRANSIENT, $info, self::CACHE_TTL );
		} else {
			set_site_transient( self::TRANSIENT, array( 'version' => '' ), self::FAIL_TTL );
		}
		return $info;
	}

	/**
	 * The package URL, but only when it points at the configured app's own
	 * download route — never a URL the server could redirect us elsewhere with.
	 *
	 * @param array $info Release info.
	 * @param array $ep   Endpoints.
	 * @return string
	 */
	private static function package_url( $info, $ep ) {
		$url = isset( $info['download_url'] ) ? (string) $info['download_url'] : '';
		return $url === $ep['download_url'] ? $url : '';
	}

	/**
	 * `update_plugins_{host}` filter: report the latest version. WordPress
	 * compares it with the installed version itself.
	 *
	 * @param array|false $update      Current value.
	 * @param array       $plugin_data Plugin headers.
	 * @param string      $plugin_file Plugin basename.
	 * @return array|false
	 */
	public static function check_update( $update, $plugin_data, $plugin_file ) {
		if ( self::basename() !== $plugin_file ) {
			return $update;
		}
		$info = self::fetch_info();
		$ep   = self::endpoints();
		if ( ! $info || ! $ep ) {
			return $update;
		}
		return array(
			'id'           => isset( $plugin_data['UpdateURI'] ) ? $plugin_data['UpdateURI'] : '',
			'slug'         => self::SLUG,
			'plugin'       => $plugin_file,
			'version'      => sanitize_text_field( $info['version'] ),
			'url'          => '',
			'package'      => self::package_url( $info, $ep ),
			'requires'     => isset( $info['requires'] ) ? sanitize_text_field( (string) $info['requires'] ) : '',
			'tested'       => isset( $info['tested'] ) ? sanitize_text_field( (string) $info['tested'] ) : '',
			'requires_php' => isset( $info['requires_php'] ) ? sanitize_text_field( (string) $info['requires_php'] ) : '',
		);
	}

	/**
	 * `plugins_api` filter: the "View details" modal.
	 *
	 * @param false|object|array $result Current result.
	 * @param string             $action API action.
	 * @param object             $args   Request args.
	 * @return false|object|array
	 */
	public static function plugin_info( $result, $action, $args ) {
		if ( 'plugin_information' !== $action || ! isset( $args->slug ) || self::SLUG !== $args->slug ) {
			return $result;
		}
		$info = self::fetch_info();
		$ep   = self::endpoints();
		if ( ! $info || ! $ep ) {
			return $result;
		}

		$changelog = '';
		if ( ! empty( $info['changelog'] ) && is_array( $info['changelog'] ) ) {
			foreach ( $info['changelog'] as $entry ) {
				if ( empty( $entry['version'] ) ) {
					continue;
				}
				$changelog .= '<h4>' . esc_html( $entry['version'] ) . '</h4><ul>';
				foreach ( (array) ( isset( $entry['notes'] ) ? $entry['notes'] : array() ) as $note ) {
					$changelog .= '<li>' . esc_html( (string) $note ) . '</li>';
				}
				$changelog .= '</ul>';
			}
		}

		return (object) array(
			'name'          => 'Revaltus Blog Sync',
			'slug'          => self::SLUG,
			'version'       => sanitize_text_field( $info['version'] ),
			'author'        => 'Revaltus',
			'requires'      => isset( $info['requires'] ) ? sanitize_text_field( (string) $info['requires'] ) : '',
			'tested'        => isset( $info['tested'] ) ? sanitize_text_field( (string) $info['tested'] ) : '',
			'requires_php'  => isset( $info['requires_php'] ) ? sanitize_text_field( (string) $info['requires_php'] ) : '',
			'download_link' => self::package_url( $info, $ep ),
			'sections'      => array(
				'description' => esc_html__( 'One-way pull of published blog posts from a Revaltus feed into WordPress.', 'revaltus-blog-sync' ),
				'changelog'   => $changelog,
			),
		);
	}

	/**
	 * Add the bearer to the update package download (and nothing else).
	 *
	 * @param array  $args HTTP request args.
	 * @param string $url  Request URL.
	 * @return array
	 */
	public static function auth_package_download( $args, $url ) {
		$ep = self::endpoints();
		if ( $ep && $url === $ep['download_url'] ) {
			if ( ! isset( $args['headers'] ) || ! is_array( $args['headers'] ) ) {
				$args['headers'] = array();
			}
			$args['headers']['Authorization'] = 'Bearer ' . $ep['secret'];
		}
		return $args;
	}

	/**
	 * Drop the cached release info.
	 *
	 * @return void
	 */
	public static function flush_cache() {
		delete_site_transient( self::TRANSIENT );
	}

	/**
	 * Flush when an admin clicks "Check again" on Dashboard → Updates.
	 *
	 * @return void
	 */
	public static function flush_on_force_check() {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only flag, core does the same.
		if ( isset( $_GET['force-check'] ) && current_user_can( 'update_plugins' ) ) {
			self::flush_cache();
		}
	}
}
