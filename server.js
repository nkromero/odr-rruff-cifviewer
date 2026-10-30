// Local server for the standalone viewer: serves the page and fetches ODR
// records on its behalf. The browser can't call the API itself - requests with
// an Authorization header need a CORS preflight, and the API answers OPTIONS
// with 405, so the browser only reports "Failed to fetch". Doing the login and
// lookup here also keeps the .env credentials and token out of the browser.
//
// Usage: node server.js   (then open http://localhost:8000/?UUID=<record-uuid>, or
//        http://localhost:8000/symmetry.html/ for the symmetry page)
// Set PORT to use a different port. Needs Node 18+ for the built-in fetch.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { indexEntry, byGroupId, INDEX_FILE } = require('./scripts/symmetry_index.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8000;
const TOKEN_URL = 'https://www.rruff.net/odr_rruff/api/v4/token';
const RECORD_URL = 'https://www.rruff.net/odr_rruff/api/v4/dataset/record/';
// The ODR symmetry database the symmetry page (symmetry.html) lists.
const SYMMETRY_DATABASE_UUID = 'e1caf946bba4b04aa57262848214';
// Every record's UUID; a limit of 0 returns all of them.
const SYMMETRY_LIST_URL = `https://www.rruff.net/odr_rruff/api/v4/search/database/${SYMMETRY_DATABASE_UUID}/records/0/0.json`;
const SYMMETRY_CACHE_MS = 24 * 60 * 60 * 1000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Same KEY=value parsing the old in-browser auth.js did, re-read on each login
// so edits to .env apply without restarting.
function readEnv() {
  const values = {};
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  } catch {
    return values;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

// The token is cached until a minute before the JWT's own expiry (30 minutes if
// it doesn't carry one) so each record lookup doesn't log in again.
let cachedToken = '';
let cachedTokenExpiry = 0;

function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (payload.exp) return payload.exp * 1000 - 60 * 1000;
  } catch {}
  return Date.now() + 30 * 60 * 1000;
}

async function getToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const { username, password } = readEnv();
  if (!username || !password) {
    throw Object.assign(new Error('No username / password in .env - copy .env.example to .env and fill it in.'), { status: 500 });
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Login failed: ${res.status} ${res.statusText} - check the credentials in .env`), { status: 502 });
  }

  let token;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    const data = await res.json();
    token = data.token || data.access_token || data.jwt;
  } else {
    token = (await res.text()).trim();
  }
  if (!token) throw Object.assign(new Error('Login response did not include a token'), { status: 502 });

  cachedToken = token;
  cachedTokenExpiry = tokenExpiry(token);
  return token;
}

// Spaces lookups at least a second apart, matching the browser-side limit.
let lastApiRequestTime = 0;
let apiQueue = Promise.resolve();

function rateLimited(fn) {
  const run = apiQueue.then(async () => {
    const wait = Math.max(0, lastApiRequestTime + 1000 - Date.now());
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastApiRequestTime = Date.now();
    return fn();
  });
  apiQueue = run.catch(() => {});
  return run;
}

async function fetchRecord(uuid) {
  return fetchApiJson(RECORD_URL + encodeURIComponent(uuid));
}

async function fetchApiJson(url) {
  const token = await getToken();
  const res = await rateLimited(() => fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  }));
  if (res.status === 401 || res.status === 403) {
    // Drop the cached token so the next lookup logs in afresh.
    cachedToken = '';
    throw Object.assign(new Error(`Request failed: ${res.status} - the API rejected the token.`), { status: res.status });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`Request failed: ${res.status} ${res.statusText}`), { status: res.status === 404 ? 404 : 502 });
  }
  const text = (await res.text()).trim();
  try {
    JSON.parse(text);
  } catch {
    throw Object.assign(new Error('The API returned a record that is not valid JSON.'), { status: 502 });
  }
  return text;
}

// The symmetry page's list of every space group. GET dataset/<uuid>.json only gives this account
// 100 records, so the list starts from the plugin's data/symmetry_index.json (written by
// scripts/symmetry_index.js) and is synced with ODR once a day, the way the plugin's daily task
// does it: one call for every record UUID, then each new record (and SYMMETRY_SYNC_BATCH
// existing ones in turn, to pick up edits) fetched on its own. Records that are gone drop out.
// The sync runs in the background, so the list is served at once. The batch is smaller than the
// plugin's, since this server syncs on every start.
const SYMMETRY_SYNC_BATCH = 5;
const symmetry = {
  groups: JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).groups,
  syncedAt: 0,
  cursor: 0,
  syncing: null,
};

async function syncSymmetryIndex() {
  const { records = [] } = JSON.parse(await fetchApiJson(SYMMETRY_LIST_URL));
  const listed = new Set(records.map(r => r.unique_id));
  const kept = symmetry.groups.filter(g => listed.has(g.uuid));
  const known = new Set(kept.map(g => g.uuid));
  const added = [...listed].filter(uuid => !known.has(uuid)).slice(0, SYMMETRY_SYNC_BATCH);
  const refreshCount = Math.min(kept.length, SYMMETRY_SYNC_BATCH - added.length);
  const refresh = Array.from({ length: refreshCount }, (_, i) => kept[(symmetry.cursor + i) % kept.length].uuid);

  const entries = new Map(kept.map(g => [g.uuid, g]));
  let errors = 0;
  for (const uuid of [...added, ...refresh]) {
    try {
      const record = JSON.parse(await fetchRecord(uuid));
      if (record.database_uuid === SYMMETRY_DATABASE_UUID) entries.set(uuid, indexEntry(record));
    } catch (err) {
      errors++;
      console.error(`Symmetry sync, record ${uuid}: ${err.message}`);
    }
  }
  const removed = symmetry.groups.length - kept.length;
  symmetry.groups = [...entries.values()].sort(byGroupId);
  symmetry.cursor = kept.length ? (symmetry.cursor + refreshCount) % kept.length : 0;
  console.log(`Symmetry list synced: ${symmetry.groups.length} groups, ${added.length} new, ${removed} removed, ${refreshCount} refreshed, ${errors} errors`);
}

function fetchSymmetryIndex() {
  if (!symmetry.syncing && Date.now() - symmetry.syncedAt > SYMMETRY_CACHE_MS) {
    symmetry.syncedAt = Date.now();
    symmetry.syncing = syncSymmetryIndex()
      .catch(err => console.error(`Symmetry sync: ${err.message}`))
      .finally(() => { symmetry.syncing = null; });
  }
  return JSON.stringify({ groups: symmetry.groups });
}

// One symmetry record, kept like the index. Only records of the symmetry database are passed on.
const symmetryRecords = new Map();

async function fetchSymmetryRecord(uuid) {
  const cached = symmetryRecords.get(uuid);
  if (cached && Date.now() - cached.time < SYMMETRY_CACHE_MS) return cached.text;
  const text = await fetchRecord(uuid);
  if (JSON.parse(text).database_uuid !== SYMMETRY_DATABASE_UUID) {
    throw Object.assign(new Error('That record is not in the symmetry database.'), { status: 404 });
  }
  symmetryRecords.set(uuid, { text, time: Date.now() });
  return text;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function serveStatic(res, urlPath) {
  // "/symmetry.html/" is the page itself, so its links can end in /?UUID=.
  const pagePath = urlPath === '/' ? '/index.html' : urlPath.replace(/\.html\/$/, '.html');
  const relative = path.normalize(decodeURIComponent(pagePath)).replace(/^[\\/]+/, '');
  const filePath = path.join(ROOT, relative);
  // Stay inside the repo and never serve dotfiles (.env, .git) or the server itself.
  const parts = relative.split(/[\\/]/);
  if (!filePath.startsWith(ROOT + path.sep) || parts.some(p => p.startsWith('.') || p === 'node_modules') || relative === 'server.js') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  const recordMatch = pathname.match(/^\/api\/record\/([0-9a-fA-F]{1,64})$/);
  if (recordMatch) {
    if (req.method !== 'GET') return sendJson(res, 405, { message: 'Method not allowed' });
    try {
      sendJson(res, 200, await fetchRecord(recordMatch[1]));
    } catch (err) {
      console.error(`Record ${recordMatch[1]}: ${err.message}`);
      sendJson(res, err.status || 500, { message: err.message });
    }
    return;
  }
  const symmetryMatch = pathname.match(/^\/api\/symmetry\/record\/([0-9a-fA-F]{1,64})$/);
  const symmetryRoute = pathname === '/api/symmetry' ? fetchSymmetryIndex
    : symmetryMatch ? () => fetchSymmetryRecord(symmetryMatch[1]) : null;
  if (symmetryRoute) {
    if (req.method !== 'GET') return sendJson(res, 405, { message: 'Method not allowed' });
    try {
      sendJson(res, 200, await symmetryRoute());
    } catch (err) {
      console.error(`Symmetry ${pathname}: ${err.message}`);
      sendJson(res, err.status || 500, { message: err.message });
    }
    return;
  }
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { message: 'Unknown API route' });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }
  serveStatic(res, pathname);
});

// Bound to localhost only, so other machines on the network can't use the proxy.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`CIF Viewer running at http://localhost:${PORT}/`);
});
