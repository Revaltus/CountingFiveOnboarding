<?php
/**
 * Settings screen + "Sync now" action for Revaltus Blog Sync.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class RV_Blog_Sync_Settings {

	/**
	 * Register the settings sub-page under Settings.
	 */
	public static function register_page() {
		add_options_page(
			__( 'Revaltus Blog Sync', 'revaltus-blog-sync' ),
			__( 'Revaltus Blog Sync', 'revaltus-blog-sync' ),
			'manage_options',
			'revaltus-blog-sync',
			array( __CLASS__, 'render_page' )
		);
	}

	/**
	 * Register the single option (an array) with a sanitizing callback.
	 */
	public static function register_settings() {
		register_setting(
			'rv_blog_sync',
			RV_BLOG_SYNC_OPTION,
			array( 'sanitize_callback' => array( __CLASS__, 'sanitize' ) )
		);
	}

	public static function sanitize( $input ) {
		$prev = get_option( RV_BLOG_SYNC_OPTION, array() );
		$out  = array();

		$out['feed_url'] = isset( $input['feed_url'] ) ? esc_url_raw( trim( $input['feed_url'] ) ) : '';

		// Keep the previously-saved secret if the field is submitted empty, so an
		// operator editing other fields doesn't have to re-enter it every time.
		$secret = isset( $input['secret'] ) ? trim( $input['secret'] ) : '';
		$out['secret'] = $secret !== '' ? $secret : ( isset( $prev['secret'] ) ? $prev['secret'] : '' );

		$allowed_intervals = array( 'rv_fifteen_minutes', 'hourly', 'twicedaily', 'daily' );
		$out['interval'] = isset( $input['interval'] ) && in_array( $input['interval'], $allowed_intervals, true )
			? $input['interval']
			: 'hourly';

		$out['enabled'] = ! empty( $input['enabled'] ) ? 1 : 0;

		$category        = isset( $input['category'] ) ? absint( $input['category'] ) : 0;
		$out['category'] = ( $category && term_exists( $category, 'category' ) ) ? $category : 0;

		$author        = isset( $input['author'] ) ? absint( $input['author'] ) : 0;
		$out['author'] = ( $author && user_can( $author, 'edit_posts' ) ) ? $author : 0;

		// Re-schedule if the interval changed.
		self::reschedule( $out['interval'] );

		return $out;
	}

	private static function reschedule( $interval ) {
		$timestamp = wp_next_scheduled( RV_BLOG_SYNC_CRON_HOOK );
		if ( $timestamp ) {
			wp_unschedule_event( $timestamp, RV_BLOG_SYNC_CRON_HOOK );
		}
		wp_schedule_event( time() + MINUTE_IN_SECONDS, $interval, RV_BLOG_SYNC_CRON_HOOK );
	}

	/**
	 * Handle the "Sync now" button (admin-post).
	 */
	public static function handle_sync_now() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Insufficient permissions.', 'revaltus-blog-sync' ) );
		}
		check_admin_referer( 'rv_blog_sync_now' );

		$result = RV_Blog_Sync::run();

		$args = array( 'page' => 'revaltus-blog-sync' );
		if ( is_wp_error( $result ) ) {
			$args['rv_sync_error'] = rawurlencode( $result->get_error_message() );
		} else {
			$args['rv_sync_done'] = 1;
			$args['rv_created']   = isset( $result['created'] ) ? (int) $result['created'] : 0;
			$args['rv_updated']   = isset( $result['updated'] ) ? (int) $result['updated'] : 0;
			$args['rv_drafted']   = isset( $result['drafted'] ) ? (int) $result['drafted'] : 0;
			$args['rv_remaining'] = isset( $result['remaining'] ) ? (int) $result['remaining'] : 0;
		}
		wp_safe_redirect( add_query_arg( $args, admin_url( 'options-general.php' ) ) );
		exit;
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$settings = get_option( RV_BLOG_SYNC_OPTION, array() );
		$feed_url = isset( $settings['feed_url'] ) ? $settings['feed_url'] : '';
		$interval = isset( $settings['interval'] ) ? $settings['interval'] : 'hourly';
		$enabled  = ! empty( $settings['enabled'] );
		$has_secret = ! empty( $settings['secret'] );
		$category   = isset( $settings['category'] ) ? (int) $settings['category'] : 0;
		$author     = isset( $settings['author'] ) ? (int) $settings['author'] : 0;
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Revaltus Blog Sync', 'revaltus-blog-sync' ); ?></h1>

			<?php if ( isset( $_GET['rv_sync_done'] ) ) : ?>
				<?php $rv_remaining = isset( $_GET['rv_remaining'] ) ? (int) $_GET['rv_remaining'] : 0; ?>
				<div class="notice notice-success is-dismissible"><p>
					<?php
					printf(
						/* translators: 1: created, 2: updated, 3: drafted */
						esc_html__( 'Sync complete — %1$d created, %2$d updated, %3$d drafted.', 'revaltus-blog-sync' ),
						isset( $_GET['rv_created'] ) ? (int) $_GET['rv_created'] : 0,
						isset( $_GET['rv_updated'] ) ? (int) $_GET['rv_updated'] : 0,
						isset( $_GET['rv_drafted'] ) ? (int) $_GET['rv_drafted'] : 0
					);
					?>
				</p></div>
				<?php if ( $rv_remaining > 0 ) : ?>
					<div class="notice notice-info is-dismissible"><p>
						<?php
						printf(
							/* translators: %d: number of posts still pending */
							esc_html__( '%d post(s) still pending — this run hit its time budget. Click “Sync now” again, or wait for the next scheduled sync to finish them.', 'revaltus-blog-sync' ),
							$rv_remaining
						);
						?>
					</p></div>
				<?php endif; ?>
			<?php endif; ?>

			<?php if ( isset( $_GET['rv_sync_error'] ) ) : ?>
				<div class="notice notice-error is-dismissible"><p>
					<?php echo esc_html( sanitize_text_field( wp_unslash( rawurldecode( $_GET['rv_sync_error'] ) ) ) ); ?>
				</p></div>
			<?php endif; ?>

			<form method="post" action="options.php">
				<?php settings_fields( 'rv_blog_sync' ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="rv_feed_url"><?php esc_html_e( 'Feed URL', 'revaltus-blog-sync' ); ?></label></th>
						<td>
							<input name="<?php echo esc_attr( RV_BLOG_SYNC_OPTION ); ?>[feed_url]" id="rv_feed_url" type="url"
								class="regular-text" value="<?php echo esc_attr( $feed_url ); ?>"
								placeholder="https://app.revaltus.com/api/wp-feed/your-site" />
							<p class="description"><?php esc_html_e( 'The Revaltus feed endpoint for this site.', 'revaltus-blog-sync' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="rv_secret"><?php esc_html_e( 'Shared secret', 'revaltus-blog-sync' ); ?></label></th>
						<td>
							<input name="<?php echo esc_attr( RV_BLOG_SYNC_OPTION ); ?>[secret]" id="rv_secret" type="password"
								class="regular-text" value="" autocomplete="new-password"
								placeholder="<?php echo $has_secret ? esc_attr__( '•••••• (saved — leave blank to keep)', 'revaltus-blog-sync' ) : ''; ?>" />
							<p class="description"><?php esc_html_e( 'Bearer token for the feed. Sent as Authorization: Bearer <secret>.', 'revaltus-blog-sync' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="rv_interval"><?php esc_html_e( 'Sync interval', 'revaltus-blog-sync' ); ?></label></th>
						<td>
							<select name="<?php echo esc_attr( RV_BLOG_SYNC_OPTION ); ?>[interval]" id="rv_interval">
								<option value="rv_fifteen_minutes" <?php selected( $interval, 'rv_fifteen_minutes' ); ?>><?php esc_html_e( 'Every 15 minutes', 'revaltus-blog-sync' ); ?></option>
								<option value="hourly" <?php selected( $interval, 'hourly' ); ?>><?php esc_html_e( 'Hourly', 'revaltus-blog-sync' ); ?></option>
								<option value="twicedaily" <?php selected( $interval, 'twicedaily' ); ?>><?php esc_html_e( 'Twice daily', 'revaltus-blog-sync' ); ?></option>
								<option value="daily" <?php selected( $interval, 'daily' ); ?>><?php esc_html_e( 'Daily', 'revaltus-blog-sync' ); ?></option>
							</select>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="rv_category"><?php esc_html_e( 'Category', 'revaltus-blog-sync' ); ?></label></th>
						<td>
							<?php
							wp_dropdown_categories(
								array(
									'name'              => RV_BLOG_SYNC_OPTION . '[category]',
									'id'                => 'rv_category',
									'selected'          => $category,
									'hide_empty'        => 0,
									'hierarchical'      => 1,
									'show_option_none'  => __( '— WordPress default category —', 'revaltus-blog-sync' ),
									'option_none_value' => 0,
								)
							);
							?>
							<p class="description"><?php esc_html_e( 'Assigned to new synced posts, and to synced posts still in the default category. Categories you set by hand in WordPress are kept.', 'revaltus-blog-sync' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="rv_author"><?php esc_html_e( 'Author', 'revaltus-blog-sync' ); ?></label></th>
						<td>
							<?php
							wp_dropdown_users(
								array(
									'name'              => RV_BLOG_SYNC_OPTION . '[author]',
									'id'                => 'rv_author',
									'selected'          => $author,
									'role__in'          => array( 'administrator', 'editor', 'author' ),
									'show_option_none'  => __( '— First administrator —', 'revaltus-blog-sync' ),
									'option_none_value' => 0,
								)
							);
							?>
							<p class="description"><?php esc_html_e( 'Shown as the author of new synced posts, and set on synced posts that have no author. Authors you change by hand in WordPress are kept.', 'revaltus-blog-sync' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Enabled', 'revaltus-blog-sync' ); ?></th>
						<td>
							<label>
								<input name="<?php echo esc_attr( RV_BLOG_SYNC_OPTION ); ?>[enabled]" type="checkbox" value="1" <?php checked( $enabled ); ?> />
								<?php esc_html_e( 'Run scheduled syncs', 'revaltus-blog-sync' ); ?>
							</label>
							<p class="description"><?php esc_html_e( 'Uncheck to pause syncing without deleting settings.', 'revaltus-blog-sync' ); ?></p>
						</td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>

			<hr />
			<h2><?php esc_html_e( 'Manual sync', 'revaltus-blog-sync' ); ?></h2>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="rv_blog_sync_now" />
				<?php wp_nonce_field( 'rv_blog_sync_now' ); ?>
				<?php submit_button( __( 'Sync now', 'revaltus-blog-sync' ), 'secondary', 'submit', false ); ?>
			</form>
		</div>
		<?php
	}
}
