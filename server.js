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
// ODR_API_BASE points the server at another ODR server, e.g. https://zeta.odr.io/api/v4 to test.
const API_BASE = (process.env.ODR_API_BASE || 'https://www.rruff.net/odr_rruff/api/v4').replace(/\/+$/, '');
const TOKEN_URL = `${API_BASE}/token`;
const RECORD_URL = `${API_BASE}/dataset/record/`;
const FILE_URL = `${API_BASE}/file/`;
// POST /file uploads a file into a record's file field (multipart form).
const UPLOAD_URL = `${API_BASE}/file`;
// POST record/<record_uuid>/<field_uuid>/value with { "value": ... } sets a text field.
const fieldValueUrl = (recordUuid, fieldUuid) =>
  `${API_BASE}/record/${encodeURIComponent(recordUuid)}/${encodeURIComponent(fieldUuid)}/value`;
// GET template/<database_uuid> lists every field of a database, including ones a record leaves
// out because it has no value for them yet.
const TEMPLATE_URL = `${API_BASE}/template/`;
// Sending a CIF from AMC -> CIF to a record's Minimal CIF and Minimal CIF Contents fields writes
// to the database, so it stays off unless the server is started with ALLOW_MINIMAL_CIF_UPLOAD=1.
const ALLOW_MINIMAL_CIF_UPLOAD = process.env.ALLOW_MINIMAL_CIF_UPLOAD === '1';
const MINIMAL_CIF_FIELD = 'Minimal CIF Contents';
const MINIMAL_CIF_FILE_FIELD = 'Minimal CIF';
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
// The ODR symmetry database the symmetry page (symmetry.html) lists.
const SYMMETRY_DATABASE_UUID = 'e1caf946bba4b04aa57262848214';
// Every record's UUID; a limit of 0 returns all of them.
const SYMMETRY_LIST_URL = `${API_BASE}/search/database/${SYMMETRY_DATABASE_UUID}/records/0/0.json`;
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

// One API login (username / password) for looking records up and for Send. A server such as
// zeta that doesn't have that account can use symmetry_username / symmetry_password instead,
// with ODR_USE_SYMMETRY_LOGIN=1. The token is cached until a minute before the JWT's own
// expiry (30 minutes if it doesn't carry one) so each record lookup doesn't log in again.
const LOGIN = process.env.ODR_USE_SYMMETRY_LOGIN === '1'
  ? { user: 'symmetry_username', pass: 'symmetry_password' }
  : { user: 'username', pass: 'password' };
const cached = { token: '', expiry: 0 };

function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (payload.exp) return payload.exp * 1000 - 60 * 1000;
  } catch {}
  return Date.now() + 30 * 60 * 1000;
}

async function getToken() {
  if (cached.token && Date.now() < cached.expiry) return cached.token;

  const env = readEnv();
  const { user, pass } = LOGIN;
  const username = env[user];
  const password = env[pass];
  if (!username || !password) {
    throw Object.assign(new Error(`No ${user} / ${pass} in .env - copy .env.example to .env and fill it in.`), { status: 500 });
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
    token = (data.token && data.token.value) || data.token || data.access_token || data.jwt;
  } else {
    token = (await res.text()).trim();
  }
  if (!token || typeof token !== 'string') throw Object.assign(new Error('Login response did not include a token'), { status: 502 });

  cached.token = token;
  cached.expiry = tokenExpiry(token);
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
  const text = await fetchApiJson(RECORD_URL + encodeURIComponent(uuid));
  allowCifFiles(JSON.parse(text));
  return text;
}

// The CIF files of the records handed out, the only files /api/file/ serves, so it can't be
// used to download any other file this account can see. ODR's own download links ask for a
// reCAPTCHA; the API's file route doesn't, with a token.
const CIF_FILE_FIELDS = ['Original CIF', 'Minimal CIF'];
const allowedCifFiles = new Set();

function allowCifFiles(record) {
  for (const field of record.fields || []) {
    if (!CIF_FILE_FIELDS.includes(field.field_name)) continue;
    for (const file of field.files || []) allowedCifFiles.add(file.file_uuid);
  }
}

async function fetchCifFile(fileUuid) {
  if (!allowedCifFiles.has(fileUuid)) {
    throw Object.assign(new Error('That file is not a CIF of a record looked up here.'), { status: 404 });
  }
  return JSON.stringify({ text: await fetchApiText(FILE_URL + encodeURIComponent(fileUuid)) });
}

async function fetchApiJson(url) {
  const text = await fetchApiText(url);
  try {
    JSON.parse(text);
  } catch {
    throw Object.assign(new Error('The API returned a record that is not valid JSON.'), { status: 502 });
  }
  return text;
}

async function fetchApiText(url, init = {}) {
  const token = await getToken();
  const res = await rateLimited(() => fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  }));
  // Which request it was, e.g. "POST /file", so an error says which step failed.
  const request = `${init.method || 'GET'} ${new URL(url).pathname.replace(/^.*\/api\/v4/, '')}`;
  if (res.status === 401) {
    // Drop the cached token so the next lookup logs in afresh.
    cached.token = '';
    throw Object.assign(new Error(`${request} failed: 401 - the API rejected the token.`), { status: 401 });
  }
  if (res.status === 403) {
    // The login worked but this account may not do this (e.g. no edit rights on the database).
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw Object.assign(new Error(`${request} failed: 403 - the ${LOGIN.user} account isn't allowed to do this${detail ? ` (${detail})` : ''}.`), { status: 403 });
  }
  if (!res.ok) {
    // ODR's error replies say what was wrong with a write, so keep the start of them.
    const detail = init.method ? (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300) : '';
    throw Object.assign(new Error(`${request} failed: ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ''}`), { status: res.status === 404 ? 404 : 502 });
  }
  return (await res.text()).trim();
}

// Sends a CIF made in AMC -> CIF to the record, replacing what is there: as a file in the
// Minimal CIF field (named like the record's original CIF, Mineral__minimal__<code>.cif) and as
// text in the Minimal CIF Contents field. The record is looked up first for the field UUIDs; a
// field with no value is left out of the record, so then it comes from the database's template.
// The file goes first: the old minimal CIF file is only deleted once the new one is in the
// field, so a failed upload changes nothing. The text ODR stores is checked against what was sent.
async function uploadMinimalCif({ recordUuid, text }) {
  if (!ALLOW_MINIMAL_CIF_UPLOAD) {
    throw Object.assign(new Error('Sending to the database is switched off for now.'), { status: 403 });
  }
  if (typeof recordUuid !== 'string' || !/^[0-9a-fA-F]{1,64}$/.test(recordUuid)) {
    throw Object.assign(new Error('Missing or invalid record UUID.'), { status: 400 });
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw Object.assign(new Error('There is no CIF to send.'), { status: 400 });
  }

  const record = JSON.parse(await fetchApiJson(RECORD_URL + encodeURIComponent(recordUuid)));
  const recordField = name => (record.fields || []).find(f => f.field_name === name);
  let template;
  async function findField(name) {
    const field = recordField(name);
    if (field) return field;
    template = template || JSON.parse(await fetchApiJson(TEMPLATE_URL + encodeURIComponent(record.database_uuid)));
    const found = (template.fields || []).find(f => f.name === name);
    if (!found) throw Object.assign(new Error(`That record's database has no ${name} field.`), { status: 400 });
    return { field_uuid: found.field_uuid, template_field_uuid: found.template_field_uuid, files: [] };
  }
  const fileField = await findField(MINIMAL_CIF_FILE_FIELD);
  const textField = await findField(MINIMAL_CIF_FIELD);

  const value = name => String((recordField(name) || {}).value || '').replace(/[^\w.-]+/g, '_');
  const fileName = [value('Mineral'), 'minimal', value('database_code_amcsd')].filter(Boolean).join('__') + '.cif';

  // The file.
  const env = readEnv();
  const form = new FormData();
  form.append('name', fileName);
  form.append('file', new Blob([text], { type: 'chemical/x-cif' }), fileName);
  form.append('dataset_uuid', record.database_uuid);
  form.append('template_field_uuid', fileField.template_field_uuid || '');
  form.append('user_email', env.user_email || env[LOGIN.user] || '');
  form.append('field_uuid', fileField.field_uuid);
  form.append('record_uuid', recordUuid);
  const oldUuids = new Set((fileField.files || []).map(f => f.file_uuid));
  let updated = JSON.parse(await fetchApiText(UPLOAD_URL, { method: 'POST', body: form }));
  const filesIn = rec => ((rec.fields || []).find(f => f.field_uuid === fileField.field_uuid) || {}).files || [];
  const after = filesIn(updated);
  if (!after.some(f => !oldUuids.has(f.file_uuid))) {
    throw Object.assign(new Error('The upload went through, but the new file is not in the Minimal CIF field, so nothing else was changed.'), { status: 502 });
  }
  let removed = 0;
  for (const old of after.filter(f => oldUuids.has(f.file_uuid))) {
    try {
      updated = JSON.parse(await fetchApiText(FILE_URL + encodeURIComponent(old.file_uuid), { method: 'DELETE' }));
      removed++;
    } catch (err) {
      throw Object.assign(new Error(`The new file was uploaded, but the old minimal CIF (${old.original_name}) could not be deleted: ${err.message}`), { status: err.status || 502 });
    }
  }
  allowCifFiles(updated);

  // The text.
  const replaced = removed > 0 || (typeof textField.value === 'string' && textField.value.trim() !== '');
  updated = JSON.parse(await fetchApiText(fieldValueUrl(recordUuid, textField.field_uuid), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: text }),
  }));
  const stored = ((updated.fields || []).find(f => f.field_uuid === textField.field_uuid) || {}).value;
  const normalize = v => String(v ?? '').replace(/\r\n/g, '\n').trim();
  if (normalize(stored) !== normalize(text)) {
    throw Object.assign(new Error(`The file was sent, but the ${MINIMAL_CIF_FIELD} ODR stored is not the CIF that was sent.`), { status: 502 });
  }
  console.log(`Minimal CIF sent to record ${recordUuid}: file ${fileName} (${removed} old file(s) deleted), text ${text.length} chars`);
  return JSON.stringify({ replaced, fileName, removed, length: text.length });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(Object.assign(new Error('The CIF is too large to send.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('The request body is not valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
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
  const fileMatch = pathname.match(/^\/api\/file\/([0-9a-fA-F]{1,64})$/);
  if (fileMatch) {
    if (req.method !== 'GET') return sendJson(res, 405, { message: 'Method not allowed' });
    try {
      sendJson(res, 200, await fetchCifFile(fileMatch[1]));
    } catch (err) {
      console.error(`File ${fileMatch[1]}: ${err.message}`);
      sendJson(res, err.status || 500, { message: err.message });
    }
    return;
  }
  if (pathname === '/api/minimal-cif') {
    if (req.method !== 'POST') return sendJson(res, 405, { message: 'Method not allowed' });
    try {
      sendJson(res, 200, await uploadMinimalCif(await readJsonBody(req)));
    } catch (err) {
      console.error(`Minimal CIF upload: ${err.message}`);
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
