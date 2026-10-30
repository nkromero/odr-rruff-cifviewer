<?php
/**
 * Plugin Name: ODR RRUFF CIF Viewer
 * Description: Reads a CIF and creates the AMC header
 * Version: 1.0.8
 * Author: Nathan
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'CIF_VIEWER_VERSION', '1.0.8' );
define( 'CIF_VIEWER_URL', plugin_dir_url( __FILE__ ) );
define( 'CIF_VIEWER_TOKEN_URL', 'https://www.rruff.net/odr_rruff/api/v4/token' );
define( 'CIF_VIEWER_RECORD_URL', 'https://www.rruff.net/odr_rruff/api/v4/dataset/record/' );
// The ODR symmetry database the [odr_rruff_symmetry] page lists, and its every
// record UUID (a limit of 0 returns all of them).
define( 'CIF_VIEWER_SYMMETRY_DATABASE_UUID', 'e1caf946bba4b04aa57262848214' );
define( 'CIF_VIEWER_SYMMETRY_LIST_URL', 'https://www.rruff.net/odr_rruff/api/v4/search/database/' . CIF_VIEWER_SYMMETRY_DATABASE_UUID . '/records/0/0.json' );
// How many records the daily sync fetches: new ones first, then existing ones
// in turn, so edits in ODR reach the list within about a month.
define( 'CIF_VIEWER_SYMMETRY_SYNC_BATCH', 25 );

// Where to look for the .env holding the API credentials. It should live above
// the web root so it can't be downloaded; define CIF_VIEWER_ENV_DIR in
// wp-config.php to point somewhere else.
function cif_viewer_env_dirs() {
	if ( defined( 'CIF_VIEWER_ENV_DIR' ) ) {
		return array( CIF_VIEWER_ENV_DIR );
	}
	return array( dirname( ABSPATH ), ABSPATH );
}

// Directory path for messages, with the trailing slash dropped.
function cif_viewer_env_dir_label( $dir ) {
	return rtrim( $dir, '/\\' );
}

// Records why the server couldn't get a token (and logs it), so the shortcode
// can show the reason to admins instead of the page just failing with a 403.
function cif_viewer_token_error( $message = null ) {
	static $error = '';
	if ( null !== $message ) {
		$error = $message;
		error_log( 'CIF Viewer: ' . $message );
	}
	return $error;
}

// Path of the .env file that was found, or '' if none was.
function cif_viewer_env_file() {
	foreach ( cif_viewer_env_dirs() as $dir ) {
		$file = rtrim( $dir, '/\\' ) . '/.env';
		if ( is_readable( $file ) ) {
			return $file;
		}
	}
	return '';
}

// Returns the KEY => value pairs from the .env file, loaded once. Only the file
// is read, never the server environment, so a generic name like
// "username" can't pick up an unrelated system variable (on Windows,
// getenv('username') is the OS account name).
function cif_viewer_dotenv() {
	static $values = null;
	if ( null !== $values ) {
		return $values;
	}
	$values = array();

	$file = cif_viewer_env_file();
	if ( '' === $file ) {
		return $values;
	}

	if ( file_exists( __DIR__ . '/vendor/autoload.php' ) ) {
		require_once __DIR__ . '/vendor/autoload.php';
	}
	if ( class_exists( 'Dotenv\Dotenv' ) ) {
		$values = Dotenv\Dotenv::parse( file_get_contents( $file ) );
		return $values;
	}

	// No Composer install - parse the KEY=value lines ourselves.
	foreach ( file( $file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES ) as $line ) {
		$line = trim( $line );
		if ( '' === $line || '#' === $line[0] || false === strpos( $line, '=' ) ) {
			continue;
		}
		list( $key, $value ) = array_map( 'trim', explode( '=', $line, 2 ) );
		if ( strlen( $value ) >= 2 && ( '"' === $value[0] || "'" === $value[0] ) && substr( $value, -1 ) === $value[0] ) {
			$value = substr( $value, 1, -1 );
		}
		$values[ $key ] = $value;
	}
	return $values;
}

// Exchanges the .env credentials for an ODR API token server-to-server, so the
// secret never reaches the browser. The token is cached until shortly before
// it expires so page views don't each hit the token endpoint.
function cif_viewer_generate_token() {
	$cached = get_transient( 'cif_viewer_api_token_cache' );
	if ( $cached ) {
		return $cached;
	}

	// Same username / password names as the standalone app's .env.
	$dotenv   = cif_viewer_dotenv();
	$username = isset( $dotenv['username'] ) ? $dotenv['username'] : '';
	$password = isset( $dotenv['password'] ) ? $dotenv['password'] : '';
	if ( '' === $username || '' === $password ) {
		$env_file = cif_viewer_env_file();
		if ( '' === $env_file ) {
			cif_viewer_token_error( 'no .env file found - put it in one of: ' . implode( ', ', array_map( 'cif_viewer_env_dir_label', cif_viewer_env_dirs() ) ) . ' (not the plugin folder)' );
		} else {
			cif_viewer_token_error( 'found ' . $env_file . ' but it has no username / password values' );
		}
		return '';
	}

	$res = wp_remote_post(
		CIF_VIEWER_TOKEN_URL,
		array(
			'headers' => array( 'Content-Type' => 'application/json' ),
			'body'    => wp_json_encode( array( 'username' => $username, 'password' => $password ) ),
			'timeout' => 15,
		)
	);
	if ( is_wp_error( $res ) ) {
		cif_viewer_token_error( 'token request to ' . CIF_VIEWER_TOKEN_URL . ' failed: ' . $res->get_error_message() );
		return '';
	}
	$code = wp_remote_retrieve_response_code( $res );
	$body = wp_remote_retrieve_body( $res );
	if ( $code < 200 || $code >= 300 ) {
		cif_viewer_token_error( 'token request was rejected with HTTP ' . $code . ' - check the credentials in the .env' );
		return '';
	}

	$data  = json_decode( $body, true );
	$token = is_array( $data ) ? ( $data['token'] ?? $data['access_token'] ?? $data['jwt'] ?? '' ) : trim( $body );
	if ( ! is_string( $token ) || '' === $token ) {
		cif_viewer_token_error( 'token response did not include a token' );
		return '';
	}

	// Cache until a minute before the JWT's own expiry, or 30 minutes if it
	// doesn't carry one.
	$ttl   = 30 * MINUTE_IN_SECONDS;
	$parts = explode( '.', $token );
	if ( 3 === count( $parts ) ) {
		$payload = json_decode( base64_decode( strtr( $parts[1], '-_', '+/' ) ), true );
		if ( isset( $payload['exp'] ) ) {
			$ttl = (int) $payload['exp'] - time() - MINUTE_IN_SECONDS;
		}
	}
	if ( $ttl > 0 ) {
		set_transient( 'cif_viewer_api_token_cache', $token, $ttl );
	}

	return $token;
}

// The token from the .env, falling back to the one saved on the settings page.
// Returns array( token, source ) - source is '.env', 'settings page' or ''.
function cif_viewer_api_token() {
	$token = cif_viewer_generate_token();
	if ( '' !== $token ) {
		return array( $token, '.env' );
	}
	$token = get_option( 'cif_viewer_api_token', '' );
	return array( $token, '' === $token ? '' : 'settings page' );
}

// Error response for the record route. Only admins get the detail, since it can
// name server paths; visitors just see the generic message.
function cif_viewer_rest_error( $message, $detail, $status ) {
	if ( '' !== $detail && current_user_can( 'manage_options' ) ) {
		$message .= ' Server said: ' . $detail;
	}
	return new WP_Error( 'cif_viewer_record', $message, array( 'status' => $status ) );
}

// GETs an API URL server-to-server and decodes its JSON, or returns a WP_Error.
// The browser can't call the API itself: requests with an Authorization header
// need a CORS preflight, and the API answers OPTIONS with 405, so the browser
// reports "Failed to fetch".
function cif_viewer_api_get( $url ) {
	list( $token, $token_source ) = cif_viewer_api_token();
	if ( '' === $token ) {
		return cif_viewer_rest_error( 'The server could not get an API token.', cif_viewer_token_error(), 500 );
	}

	$res = wp_remote_get(
		$url,
		array(
			'headers' => array( 'Authorization' => 'Bearer ' . $token ),
			'timeout' => 20,
		)
	);
	if ( is_wp_error( $res ) ) {
		return cif_viewer_rest_error( 'The record request to the API failed.', $res->get_error_message(), 502 );
	}

	$code = wp_remote_retrieve_response_code( $res );
	if ( 401 === $code || 403 === $code ) {
		// Drop the cached token so the next request logs in afresh.
		delete_transient( 'cif_viewer_api_token_cache' );
		return cif_viewer_rest_error( 'Request failed: ' . $code . ' - the API rejected the token.', 'token came from the ' . $token_source, $code );
	}
	if ( $code < 200 || $code >= 300 ) {
		return cif_viewer_rest_error( 'Request failed: ' . $code . '.', '', 404 === $code ? 404 : 502 );
	}

	$data = json_decode( trim( wp_remote_retrieve_body( $res ) ), true );
	if ( null === $data ) {
		return cif_viewer_rest_error( 'The API returned a record that is not valid JSON.', '', 502 );
	}
	return $data;
}

// Fetches an ODR record for the converter.
function cif_viewer_rest_record( WP_REST_Request $request ) {
	$data = cif_viewer_api_get( CIF_VIEWER_RECORD_URL . rawurlencode( $request['uuid'] ) );
	return is_wp_error( $data ) ? $data : rest_ensure_response( $data );
}

// --- The symmetry page's data ---

// What the symmetry list shows of one record. Same shape as indexEntry() in
// scripts/symmetry_index.js.
function cif_viewer_symmetry_entry( $record ) {
	$f = array();
	foreach ( isset( $record['fields'] ) ? $record['fields'] : array() as $field ) {
		$f[ $field['field_name'] ] = isset( $field['value'] ) ? $field['value'] : '';
	}
	$get = function ( $name ) use ( $f ) {
		return isset( $f[ $name ] ) ? $f[ $name ] : '';
	};
	return array(
		'uuid'       => (string) $record['record_uuid'],
		'id'         => (int) $get( 'GroupID' ),
		'name'       => (string) $get( 'SpaceGroupName' ),
		'number'     => (int) $get( 'SpaceGroupNumber' ),
		'system'     => (string) $get( 'CrystalSystem' ),
		'pointGroup' => (string) $get( 'PointGroup' ),
		'lattice'    => (string) $get( 'Lattice' ),
	);
}

// The list of every space group: the copy the daily sync keeps in the options
// table, or the plugin's data/symmetry_index.json (scripts/symmetry_index.js)
// before the first sync. The API's dataset/<uuid>.json only gives this account
// 100 records, which is why the list is built up one record at a time.
function cif_viewer_symmetry_index() {
	$stored = get_option( 'cif_viewer_symmetry_index' );
	if ( is_array( $stored ) && ! empty( $stored['groups'] ) ) {
		return $stored;
	}
	$file   = plugin_dir_path( __FILE__ ) . 'data/symmetry_index.json';
	$seed   = file_exists( $file ) ? json_decode( file_get_contents( $file ), true ) : null;
	$groups = is_array( $seed ) && isset( $seed['groups'] ) ? $seed['groups'] : array();
	return array(
		'groups'   => $groups,
		'cursor'   => 0,
		'syncedAt' => 0,
	);
}

// The daily sync: one call for every record UUID, then each new record and a
// batch of existing ones fetched on their own, a second apart. Records no
// longer in the database drop out of the list.
function cif_viewer_symmetry_sync() {
	$list = cif_viewer_api_get( CIF_VIEWER_SYMMETRY_LIST_URL );
	if ( is_wp_error( $list ) || ! isset( $list['records'] ) ) {
		return;
	}
	$listed = array();
	foreach ( $list['records'] as $r ) {
		if ( ! empty( $r['unique_id'] ) ) {
			$listed[ $r['unique_id'] ] = true;
		}
	}

	$index   = cif_viewer_symmetry_index();
	$entries = array();
	foreach ( $index['groups'] as $g ) {
		if ( isset( $listed[ $g['uuid'] ] ) ) {
			$entries[ $g['uuid'] ] = $g;
		}
	}
	$kept   = array_keys( $entries );
	$added  = array_slice( array_keys( array_diff_key( $listed, $entries ) ), 0, CIF_VIEWER_SYMMETRY_SYNC_BATCH );
	$count  = min( count( $kept ), CIF_VIEWER_SYMMETRY_SYNC_BATCH - count( $added ) );
	$cursor = (int) $index['cursor'];
	$fetch  = $added;
	for ( $i = 0; $i < $count; $i++ ) {
		$fetch[] = $kept[ ( $cursor + $i ) % count( $kept ) ];
	}

	foreach ( $fetch as $uuid ) {
		sleep( 1 );
		$record = cif_viewer_api_get( CIF_VIEWER_RECORD_URL . rawurlencode( $uuid ) );
		if ( ! is_wp_error( $record ) && isset( $record['database_uuid'] ) && CIF_VIEWER_SYMMETRY_DATABASE_UUID === $record['database_uuid'] ) {
			$entries[ $uuid ] = cif_viewer_symmetry_entry( $record );
		}
	}

	$groups = array_values( $entries );
	usort(
		$groups,
		function ( $a, $b ) {
			return $a['id'] - $b['id'];
		}
	);
	update_option(
		'cif_viewer_symmetry_index',
		array(
			'groups'   => $groups,
			'cursor'   => count( $kept ) ? ( $cursor + $count ) % count( $kept ) : 0,
			'syncedAt' => time(),
		),
		false
	);
}
add_action( 'cif_viewer_symmetry_sync', 'cif_viewer_symmetry_sync' );

// Scheduled here rather than only on activation, since updating the plugin
// doesn't run the activation hook.
function cif_viewer_schedule_symmetry_sync() {
	if ( ! wp_next_scheduled( 'cif_viewer_symmetry_sync' ) ) {
		wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', 'cif_viewer_symmetry_sync' );
	}
}
add_action( 'init', 'cif_viewer_schedule_symmetry_sync' );

function cif_viewer_unschedule_symmetry_sync() {
	wp_clear_scheduled_hook( 'cif_viewer_symmetry_sync' );
}
register_deactivation_hook( __FILE__, 'cif_viewer_unschedule_symmetry_sync' );

function cif_viewer_rest_symmetry_index() {
	$index = cif_viewer_symmetry_index();
	return rest_ensure_response( array( 'groups' => $index['groups'] ) );
}

// One symmetry record, cached for 12 hours. Only records of the symmetry
// database are passed on.
function cif_viewer_rest_symmetry_record( WP_REST_Request $request ) {
	$uuid      = $request['uuid'];
	$cache_key = 'cif_viewer_symmetry_' . md5( $uuid );
	$data      = get_transient( $cache_key );
	if ( false === $data ) {
		$data = cif_viewer_api_get( CIF_VIEWER_RECORD_URL . rawurlencode( $uuid ) );
		if ( is_wp_error( $data ) ) {
			return $data;
		}
		if ( ! isset( $data['database_uuid'] ) || CIF_VIEWER_SYMMETRY_DATABASE_UUID !== $data['database_uuid'] ) {
			return cif_viewer_rest_error( 'That record is not in the symmetry database.', '', 404 );
		}
		set_transient( $cache_key, $data, 12 * HOUR_IN_SECONDS );
	}
	return rest_ensure_response( $data );
}

function cif_viewer_register_rest_routes() {
	register_rest_route(
		'odr-rruff-cifviewer/v1',
		'/record/(?P<uuid>[0-9a-fA-F]{1,64})',
		array(
			'methods'             => 'GET',
			'callback'            => 'cif_viewer_rest_record',
			// Public like the viewer page itself; the uuid pattern keeps it to
			// record lookups only.
			'permission_callback' => '__return_true',
		)
	);
	register_rest_route(
		'odr-rruff-cifviewer/v1',
		'/symmetry',
		array(
			'methods'             => 'GET',
			'callback'            => 'cif_viewer_rest_symmetry_index',
			'permission_callback' => '__return_true',
		)
	);
	register_rest_route(
		'odr-rruff-cifviewer/v1',
		'/symmetry/record/(?P<uuid>[0-9a-fA-F]{1,64})',
		array(
			'methods'             => 'GET',
			'callback'            => 'cif_viewer_rest_symmetry_record',
			'permission_callback' => '__return_true',
		)
	);
}
add_action( 'rest_api_init', 'cif_viewer_register_rest_routes' );

function cif_viewer_register_settings() {
	register_setting(
		'cif_viewer_settings',
		'cif_viewer_api_token',
		array(
			'type'              => 'string',
			'sanitize_callback' => 'sanitize_text_field',
			'default'           => '',
		)
	);
}
add_action( 'admin_init', 'cif_viewer_register_settings' );

function cif_viewer_add_settings_page() {
	add_options_page( 'CIF Viewer', 'CIF Viewer', 'manage_options', 'cif-viewer', 'cif_viewer_render_settings_page' );
}
add_action( 'admin_menu', 'cif_viewer_add_settings_page' );

function cif_viewer_render_settings_page() {
	?>
	<div class="wrap">
		<h1>CIF Viewer Settings</h1>
		<form method="post" action="options.php">
			<?php settings_fields( 'cif_viewer_settings' ); ?>
			<table class="form-table">
				<tr>
					<th scope="row"><label for="cif_viewer_api_token">AMCSD API Token</label></th>
					<td>
						<input type="password" id="cif_viewer_api_token" name="cif_viewer_api_token" value="<?php echo esc_attr( get_option( 'cif_viewer_api_token', '' ) ); ?>" size="60">
						<p class="description">Optional fallback. Normally the token is generated from the username / password in the .env file; this is only used when those aren't set.</p>
					</td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>
	</div>
	<?php
}

// A fixed version string means the enqueued URL (style.css?ver=1.0.0) never
// changes between edits, so browsers/caching plugins keep serving the old file
// after every update - use the file's own mtime instead so it always bumps.
function cif_viewer_asset_version( $relative_path ) {
	$full_path = plugin_dir_path( __FILE__ ) . $relative_path;
	return file_exists( $full_path ) ? (string) filemtime( $full_path ) : CIF_VIEWER_VERSION;
}

function cif_viewer_register_assets() {
	wp_register_style( 'cif-viewer-style', CIF_VIEWER_URL . 'assets/style.css', array(), cif_viewer_asset_version( 'assets/style.css' ) );
	wp_register_script( 'cif-viewer-spacegroups', CIF_VIEWER_URL . 'assets/spacegroups.js', array(), cif_viewer_asset_version( 'assets/spacegroups.js' ), true );
	wp_register_script( 'cif-viewer-submit', CIF_VIEWER_URL . 'assets/submit.js', array(), cif_viewer_asset_version( 'assets/submit.js' ), true );
	wp_register_script( 'cif-viewer-symmetry', CIF_VIEWER_URL . 'assets/symmetry.js', array(), cif_viewer_asset_version( 'assets/symmetry.js' ), true );
	wp_register_script( 'cif-viewer-spacegroupdata', CIF_VIEWER_URL . 'assets/spacegroupdata.js', array(), cif_viewer_asset_version( 'assets/spacegroupdata.js' ), true );
	wp_register_script( 'cif-viewer-unitcell', CIF_VIEWER_URL . 'assets/unitcell.js', array(), cif_viewer_asset_version( 'assets/unitcell.js' ), true );
	wp_register_script( 'cif-viewer-app', CIF_VIEWER_URL . 'assets/app.js', array( 'cif-viewer-spacegroups', 'cif-viewer-submit', 'cif-viewer-symmetry', 'cif-viewer-spacegroupdata', 'cif-viewer-unitcell' ), cif_viewer_asset_version( 'assets/app.js' ), true );
	wp_register_script( 'cif-viewer-amc2cif', CIF_VIEWER_URL . 'assets/amc2cif.js', array( 'cif-viewer-spacegroups', 'cif-viewer-symmetry', 'cif-viewer-spacegroupdata', 'cif-viewer-unitcell' ), cif_viewer_asset_version( 'assets/amc2cif.js' ), true );
	wp_register_script( 'cif-viewer-amc2cif-ui', CIF_VIEWER_URL . 'assets/amc2cif-ui.js', array( 'cif-viewer-app', 'cif-viewer-amc2cif' ), cif_viewer_asset_version( 'assets/amc2cif-ui.js' ), true );
	wp_register_style( 'cif-viewer-metrics', CIF_VIEWER_URL . 'assets/metrics.css', array( 'cif-viewer-style' ), cif_viewer_asset_version( 'assets/metrics.css' ) );
	wp_register_script( 'cif-viewer-metrics', CIF_VIEWER_URL . 'assets/metrics-page.js', array( 'cif-viewer-app' ), cif_viewer_asset_version( 'assets/metrics-page.js' ), true );
	wp_register_style( 'cif-viewer-symmetry-page', CIF_VIEWER_URL . 'assets/symmetry.css', array( 'cif-viewer-style' ), cif_viewer_asset_version( 'assets/symmetry.css' ) );
	wp_register_script( 'cif-viewer-symmetry-page', CIF_VIEWER_URL . 'assets/symmetry-page.js', array(), cif_viewer_asset_version( 'assets/symmetry-page.js' ), true );
}
add_action( 'wp_enqueue_scripts', 'cif_viewer_register_assets' );

function cif_viewer_shortcode() {
	wp_enqueue_style( 'cif-viewer-style' );
	wp_enqueue_style( 'cif-viewer-metrics' );
	wp_enqueue_script( 'cif-viewer-spacegroups' );
	wp_enqueue_script( 'cif-viewer-submit' );
	wp_enqueue_script( 'cif-viewer-app' );
	wp_enqueue_script( 'cif-viewer-amc2cif' );
	wp_enqueue_script( 'cif-viewer-amc2cif-ui' );
	wp_enqueue_script( 'cif-viewer-metrics' );

	// The token stays on the server: the browser fetches records through the
	// plugin's REST route (see cif_viewer_rest_record) instead of the API.
	$config = array(
		'recordProxyUrl' => rest_url( 'odr-rruff-cifviewer/v1/record/' ),
		'restNonce'      => wp_create_nonce( 'wp_rest' ),
		// The metrics view's data (scripts/metrics.js), put in the plugin's data/ folder.
		'metricsUrl'     => CIF_VIEWER_URL . 'data/metrics.json',
	);
	wp_localize_script( 'cif-viewer-app', 'odrRruffCifViewer', $config );

	ob_start();
	?>
	<div class="cif-viewer-app">
		<div class="cif-viewer-nav"><button id="viewToggle" class="cif-viewer-btn" type="button">CIF and AMC Metrics &rarr;</button></div>

		<div id="converterView">
			<h1>CIF Converter</h1>

			<div id="panel">
				<div id="apiSection">
					<h3>AMCSD Record</h3>
					<div id="apiStatus"></div>
				</div>

				<div id="output">
					<h3>CIF &rarr; AMC Header</h3>
					<label class="drop-zone">
					  <input type="file" id="fileInput" accept=".cif,text/plain">
					  <span class="drop-zone-prompt">Drag &amp; drop a .cif file here, or <span class="drop-zone-link">choose a file</span></span>
					  <span class="drop-zone-file"></span>
					</label>
					<div id="cifToAmcStatus"></div>
					<textarea id="amcHeaderOutput" readonly rows="1"></textarea>
					<button id="copyHeaderBtn" class="cif-viewer-btn" type="button">Copy</button>
					<button id="sendHeaderBtn" hidden class="cif-viewer-btn" type="button">Send</button>
					<p id="crystalSystemDisplay"></p>
					<div id="sendHeaderStatus" hidden></div>
				</div>

				<div id="metricTensorSection" hidden>
					<h3>G-Matrix</h3>
					<div id="metricTensorOutput"></div>
					<p id="cellVolumeDisplay"></p>
					<button id="sendGMatrixBtn" hidden class="cif-viewer-btn" type="button">Send</button>
					<div id="sendGMatrixStatus" hidden></div>
				</div>

				<div id="amcToCifSection">
					<h3>AMC &rarr; CIF</h3>
					<label class="drop-zone">
					  <input type="file" id="amcFileInput" accept=".amc,text/plain">
					  <span class="drop-zone-prompt">Drag &amp; drop a .amc file here, or <span class="drop-zone-link">choose a file</span></span>
					  <span class="drop-zone-file"></span>
					</label>
					<div id="amcToCifStatus"></div>
					<button id="copyAmcToCifBtn" class="cif-viewer-btn" type="button">Copy</button>
					<button id="sendAmcToCifBtn" hidden class="cif-viewer-btn" type="button">Send</button>
					<textarea id="amcToCifOutput" readonly rows="1"></textarea>
					<div id="sendAmcToCifStatus" hidden></div>
				</div>

				<div id="unitCellSection" hidden>
					<h3>Unit Cell Atoms</h3>
					<div id="unitCellStatus"></div>
					<button id="copyUnitCellBtn" class="cif-viewer-btn" type="button">Copy</button>
					<textarea id="unitCellOutput" readonly rows="1"></textarea>
				</div>

				<div id="citationSection">
					<h3>Format Citation</h3>
					<p>Paste a citation like: Authors (Year) Title. Journal Volume, Pages</p>
					<textarea id="citationInput" rows="1"></textarea>
					<button id="formatCitationBtn" class="cif-viewer-btn" type="button">Format</button>
					<button id="copyCitationBtn" class="cif-viewer-btn" type="button">Copy</button>
					<div id="citationStatus"></div>
					<textarea id="citationOutput" readonly rows="1"></textarea>
				</div>
			</div>
		</div>

		<div id="metricsView" hidden>
			<h1>CIF and AMC Metrics</h1>
			<p id="metricsSource"></p>

			<div id="metricsLoadPanel" hidden>
				<p>Choose JSON file</p>
				<input type="file" id="metricsFile" accept=".json">
			</div>

			<div id="metricsSummary"></div>

			<div id="metricsExplorer" hidden>
				<h2>Explore the data</h2>
				<div id="metricsControls">
					<input type="search" id="metricsSearch" placeholder="Search name, id, formula, space group">
					<select id="metricsFilter"></select>
					<button id="metricsClearFilter" class="cif-viewer-btn" type="button">Show all</button>
					<button id="metricsDownloadCsv" class="cif-viewer-btn" type="button">Download CSV</button>
				</div>
				<p id="metricsResultCount"></p>
				<div id="metricsTableWrap"><table id="metricsTable"><thead></thead><tbody></tbody></table></div>
				<div id="metricsPager">
					<button id="metricsPrevPage" class="cif-viewer-btn" type="button">Previous</button>
					<span id="metricsPageInfo"></span>
					<button id="metricsNextPage" class="cif-viewer-btn" type="button">Next</button>
				</div>
			</div>

			<dialog id="metricsDetail">
				<form method="dialog"><button class="close cif-viewer-btn">Close</button></form>
				<h3 id="metricsDetailTitle"></h3>
				<table id="metricsDetailTable"></table>
			</dialog>
		</div>
	</div>
	<?php
	return ob_get_clean();
}
add_shortcode( 'odr_rruff_cifviewer', 'cif_viewer_shortcode' );

// The symmetry page: every space group, or with ?UUID=<record uuid> one group's
// symmetry operators (assets/symmetry-page.js fills it in).
function cif_viewer_symmetry_shortcode() {
	wp_enqueue_style( 'cif-viewer-style' );
	wp_enqueue_style( 'cif-viewer-symmetry-page' );
	wp_enqueue_script( 'cif-viewer-symmetry-page' );
	wp_localize_script(
		'cif-viewer-symmetry-page',
		'odrRruffSymmetry',
		array(
			'indexUrl'  => rest_url( 'odr-rruff-cifviewer/v1/symmetry' ),
			'recordUrl' => rest_url( 'odr-rruff-cifviewer/v1/symmetry/record/' ),
			'restNonce' => wp_create_nonce( 'wp_rest' ),
		)
	);
	return '<div class="cif-viewer-app"><div id="symmetryView"></div></div>';
}
add_shortcode( 'odr_rruff_symmetry', 'cif_viewer_symmetry_shortcode' );
