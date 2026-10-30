# ODR RRUFF CIF Viewer

Reads a CIF file and builds the AMC header, AMC → CIF conversion, and
formatted citation for an AMCSD record. The record itself is loaded from the
ODR RRUFF API using the `?UUID=<record-uuid>` in the page URL.

It can be run two ways:

- **[WordPress plugin](#wordpress-plugin)**, in `wordpress-plugin/odr-rruff-cifviewer/`
- **[Standalone local server](#standalone-local-server)**, from the repo root with `node server.js` (for personal testing)

## How the API login works (read this first)

Both setups log in to the ODR API **on the server, not in the browser**:

1. The server reads your API username/password from a `.env` file.
2. The server POSTs them to `https://www.rruff.net/odr_rruff/api/v4/token` and gets a token.
3. The server calls
   `https://www.rruff.net/odr_rruff/api/v4/dataset/record/<uuid>` with the token and
   passes the JSON back.

## WordPress plugin

### 1. Install the plugin

Upload the `wordpress-plugin/odr-rruff-cifviewer/` folder to
`wp-content/plugins/odr-rruff-cifviewer/`, either by copying the folder or by
zipping it and using **Plugins → Add New → Upload Plugin**. Then activate
**ODR RRUFF CIF Viewer**.

### 2. Composer (optional)

```bash
composer install
```

Run this in the plugin folder. It installs `vlucas/phpdotenv` for parsing
`.env`. **It's optional**: without `vendor/`, the plugin uses its own simple
`KEY=value` parser. Composer has nothing to do with getting the token.

### 3. Create the `.env` file

The plugin does **not** look in its own folder. Put `.env` in one of these
places (checked in this order):

1. **One level above the WordPress root**, the folder that _contains_ the
   WordPress install (recommended, since it can't be downloaded from the web).
2. **The WordPress root** itself, next to `wp-config.php`.

To use a different folder, add this to `wp-config.php`:

```php
define( 'CIF_VIEWER_ENV_DIR', '/path/to/folder/containing/env' );
```

Contents (the same as the standalone app's `.env`):

```
username=The Username
password=The Password
```

The account needs read access to the AMCSD dataset on ODR RRUFF.

### 4. Add the viewer to a page

Put this shortcode on a page:

```
[odr_rruff_cifviewer]
```

Then open the page with a record UUID:

```
https://your-site/your-page/?UUID=06672a8429fb856e198cda62bae9
```

The **AMCSD Record** section should say "Fetched successfully."

### Optional: fallback token

**Settings → CIF Viewer** has an "AMCSD API Token" field. It's only used when
no credentials are found in `.env`. Normally leave it empty.

## Metrics view

The **CIF and AMC Metrics** button at the top of the converter switches the
same page to a summary of the checks run across all of AMCSD: the chemical
formula computed from the unit cell (whole numbers or not, common divisors,
Z), how it compares with AMCSD's formula, volume and density, and whether the
CIF and AMC files give the same unit cell. Each count filters the table under
it, and any filtered list can be downloaded as CSV. Switching views doesn't
change the URL, so the `?UUID=` stays and the WordPress shortcode keeps it in
its own container.

Generate the data from folders of AMC and CIF files (it takes several minutes):

```bash
node scripts/metrics.js path/to/amc path/to/cif > data/metrics.json
```

- **Standalone:** the page reads `data/metrics.json`.
- **WordPress:** copy the file to the plugin's `data/metrics.json`
  (`wp-content/plugins/odr-rruff-cifviewer/data/metrics.json`).

The file isn't committed. Without it, the view asks you to choose it.

## Symmetry page

A separate page listing every space group in the ODR symmetry database, under
headers for crystal system and point group, one row per space group number.
Monoclinic rows are split by unique axis (`:1` c, `:2` b, `:3` a) and
rhombohedral ones by hexagonal or rhombohedral axes (`:4`, `:5`). Each symbol
links to the same page with `?UUID=<record uuid>`, which shows that group's
generators, symmetry operators and reciprocal space operators.

Put this shortcode on its own page:

```
[odr_rruff_symmetry]
```

It uses the same `.env` login as the converter.

- **The list** comes from the plugin's `data/symmetry_index.json`, since the
  API only gives this account 100 records per dataset fetch. A daily WordPress
  task keeps it in step with ODR: it fetches every record UUID, adds new
  records, drops deleted ones, and re-reads 25 existing records a day so edits
  in ODR reach the list within about a month. To rebuild the file from scratch
  (after `node scripts/symmetry_upload.js --check` refreshes
  `data/symmetry_all_records.json`):

  ```bash
  node scripts/symmetry_index.js
  ```

- **A group's page** reads its record live from ODR, cached for 12 hours.
- **Standalone:** `node server.js`, then open
  `http://localhost:8000/symmetry.html/`.
