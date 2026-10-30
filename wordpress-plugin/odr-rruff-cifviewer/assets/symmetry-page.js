// The symmetry page: every space group in the ODR symmetry database, and one group's symmetry
// operators. With ?UUID=<record uuid> in the URL it shows that group; without one, the list of
// all groups, under headers for their crystal system and point group, one row per space group
// number. The data comes through the server (server.js /api/symmetry, or the plugin's REST
// routes when the WordPress plugin passes them in odrRruffSymmetry), which holds the API token.
(() => {

const config = window.odrRruffSymmetry || {};
const INDEX_URL = config.indexUrl || '/api/symmetry';
const RECORD_URL = config.recordUrl || '/api/symmetry/record/';

// The number after a ":" in a space group name, shown as written; the detail page adds its
// name, from data/SpaceGroupData.txt.
const settingLabel = setting => `:${setting}`;
const SETTING_NAMES = {
  1: 'unique axis c',
  2: 'unique axis b',
  3: 'unique axis a',
  4: 'hexagonal axes',
  5: 'rhombohedral axes',
};

const SYSTEM_LABELS = {
  triclinic: 'Triclinic',
  monoclinic: 'Monoclinic',
  orthorhombic: 'Orthorhombic',
  tetragonal: 'Tetragonal',
  hexagonal: 'Hexagonal',
  cubic: 'Cubic',
};

const view = document.getElementById('symmetryView');

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Split a name such as "*I2/a:2[.25,0,.25]" into its symbol, setting and origin shift.
function parseName(name) {
  const m = /^\*?([^:[]+)(?::(\d+))?(?:\[([^\]]*)\])?$/.exec(name.trim());
  if (!m) return { symbol: name, setting: null, shift: null };
  return { symbol: m[1], setting: m[2] ? Number(m[2]) : null, shift: m[3] ? m[3].split(',') : null };
}

// Symbol as HTML: "-4" gets an overbar, "2_1" a subscript (P-42_1c -> P4̄2₁c).
function symbolHtml(symbol) {
  return String(symbol).replace(/(-?)(\d)(?:_(\d))?|[^-\d]+|-/g, (all, bar, digit, sub) => {
    if (digit === undefined) return escapeHtml(all);
    const d = bar ? `<span class="sg-bar">${digit}</span>` : digit;
    return sub ? `${d}<sub>${sub}</sub>` : d;
  });
}

const VULGAR = { '1/2': '½', '1/3': '⅓', '2/3': '⅔', '1/4': '¼', '3/4': '¾', '1/6': '⅙', '5/6': '⅚', '1/8': '⅛', '3/8': '⅜', '5/8': '⅝', '7/8': '⅞' };

// An origin shift component (".25", "-1/12", "0") as a fraction.
function shiftText(value) {
  let num, den;
  if (value.includes('/')) {
    [num, den] = value.split('/').map(Number);
  } else {
    const x = Number(value);
    den = [1, 2, 3, 4, 6, 8, 12, 24].find(d => Math.abs(x * d - Math.round(x * d)) < 1e-6) || 1;
    num = Math.round(x * den);
  }
  if (!num) return '0';
  const sign = num < 0 ? '−' : '';
  const frac = `${Math.abs(num)}/${den}`;
  return den === 1 ? `${sign}${Math.abs(num)}` : sign + (VULGAR[frac] || frac);
}

const shiftLabel = shift => `origin shifted by (${shift.map(shiftText).join(', ')})`;

// The page's own path with a trailing slash (/symmetry.html/?UUID=..., /symmetry/?UUID=...).
const pagePath = location.pathname.replace(/\/?$/, '/');
const detailUrl = uuid => `${pagePath}?UUID=${encodeURIComponent(uuid)}`;
const homeUrl = number => pagePath + (number ? `#sg-${number}` : '');

async function getJson(url) {
  const headers = config.restNonce ? { 'X-WP-Nonce': config.restNonce } : {};
  const res = await fetch(url, { headers });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.message) || `Request failed: ${res.status}`);
  return data;
}

function showStatus(message, isError) {
  view.innerHTML = `<p class="sg-status${isError ? ' sg-error' : ''}">${message}</p>`;
}

// Items grouped by key(item), in the order each key first appears.
function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

const byNumber = (a, b) => a.number - b.number || a.id - b.id;

// --- The list of every group ---

function groupLink(group) {
  const { symbol, shift } = parseName(group.name);
  const note = shift ? `<span class="sg-shift" title="${escapeHtml(shiftLabel(shift))}">origin ${escapeHtml(shift.map(shiftText).join(','))}</span>` : '';
  return `<a class="sg-link${shift ? ' sg-shifted' : ''}" href="${escapeHtml(detailUrl(group.uuid))}">${symbolHtml(symbol)}${note}</a>`;
}

// One space group number's row. Groups with settings (monoclinic unique axes, rhombohedral
// axes) get one line per setting, labelled with it; the others share one unlabelled line.
function numberRow(number, groups) {
  const bySetting = groupBy(groups, g => parseName(g.name).setting);
  const labelled = [...bySetting.keys()].some(s => s !== null);
  const lines = [...bySetting].sort(([a], [b]) => (a ?? 99) - (b ?? 99)).map(([setting, unsorted]) => {
    // Origin-shifted entries go right after the symbol they shift.
    const symbols = unsorted.map(g => parseName(g.name).symbol);
    const list = unsorted.map((g, i) => [symbols.indexOf(symbols[i]), i, g]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(e => e[2]);
    const label = labelled ? `<span class="sg-setting">${setting === null ? '' : settingLabel(setting)}</span>` : '';
    return `<div class="sg-line">${label}<span class="sg-symbols">${list.map(groupLink).join('')}</span></div>`;
  });
  return `<tr id="sg-${number}"><th scope="row">${number}</th><td>${lines.join('')}</td></tr>`;
}

function renderIndex(groups) {
  const sorted = [...groups].sort(byNumber);
  const systems = groupBy(sorted, g => g.system);
  const nav = [...systems.keys()].map(s => `<a href="#sg-system-${escapeHtml(s)}">${escapeHtml(SYSTEM_LABELS[s] || s)}</a>`).join('');

  const sections = [...systems].map(([system, list]) => {
    const numbers = list.map(g => g.number);
    const pointGroups = [...groupBy(list, g => g.pointGroup)].map(([pointGroup, pgList]) => {
      const rows = [...groupBy(pgList, g => g.number)].map(([number, n]) => numberRow(number, n)).join('');
      return `<h3>Point group ${symbolHtml(pointGroup)}</h3><table class="sg-rows"><tbody>${rows}</tbody></table>`;
    }).join('');
    return `<section class="sg-system" id="sg-system-${escapeHtml(system)}">
      <h2>${escapeHtml(SYSTEM_LABELS[system] || system)} <span class="sg-range">space groups ${Math.min(...numbers)}–${Math.max(...numbers)}</span></h2>
      ${pointGroups}
    </section>`;
  }).join('');

  view.innerHTML = `
    <h1>Space Group Symmetries</h1>
    <p class="sg-intro">The space groups used in RRUFF and for the IMA minerals.</p>
    <nav class="sg-nav">${nav}</nav>
    ${sections}`;

  // The browser's own jump to #sg-12 runs before the rows exist.
  if (location.hash) {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) target.scrollIntoView();
  }
}

// --- One group's operators ---

const fieldValues = record => Object.fromEntries((record.fields || []).map(f => [f.field_name, f.value]));

// One operator per line; generator lines start with their order ("2:-x,-y,-z").
function lines(value) {
  return String(value || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const m = /^(\d+):(.*)$/.exec(line);
    return m ? { order: m[1], text: m[2] } : { order: '', text: line };
  });
}

// A matrix line: rows split by tabs, entries by spaces ("1 0 0 1/2\t0 1 0 0\t0 0 1 0").
function matrixHtml(text) {
  const rows = text.split('\t').map(r => r.trim().split(/\s+/)).filter(r => r[0] !== '');
  const body = rows.map(r => `<tr>${r.map(v => `<td>${escapeHtml(v.replace(/^-/, '−'))}</td>`).join('')}</tr>`).join('');
  return `<table class="sg-matrix"><tbody>${body}</tbody></table>`;
}

const opText = text => escapeHtml(text.replace(/,/g, ', ').replace(/-/g, '−'));

// A table of operators: the text form beside the matrix form, matched by line.
function operatorTable(title, formLabel, texts, matrices, withOrder) {
  const ops = lines(texts), ms = lines(matrices);
  const count = Math.max(ops.length, ms.length);
  if (!count) return '';
  const rows = Array.from({ length: count }, (_, i) => {
    const op = ops[i] || ms[i];
    const first = withOrder ? escapeHtml(op.order) : i + 1;
    return `<tr><td class="sg-num">${first}</td><td class="sg-op">${ops[i] ? opText(ops[i].text) : ''}</td><td>${ms[i] ? matrixHtml(ms[i].text) : ''}</td></tr>`;
  }).join('');
  return `<section class="sg-ops">
    <h2>${title} <span class="sg-range">${count}</span></h2>
    <table class="sg-op-table">
      <thead><tr><th>${withOrder ? 'Order' : '#'}</th><th>${formLabel}</th><th>Matrix form</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderDetail(record, groups) {
  const f = fieldValues(record);
  const name = f.SpaceGroupName || '';
  const { symbol, setting, shift } = parseName(name);
  const number = Number(f.SpaceGroupNumber) || 0;
  const system = f.CrystalSystem || '';

  const facts = [
    ['Space group number', number || ''],
    ['Crystal system', escapeHtml(SYSTEM_LABELS[system] || system)],
    ['Point group', symbolHtml(f.PointGroup || '')],
    ['Lattice', escapeHtml(f.Lattice || '')],
    ['Setting', setting ? settingLabel(setting) + (SETTING_NAMES[setting] ? ` (${SETTING_NAMES[setting]})` : '') : ''],
    ['Origin', shift ? escapeHtml(shiftLabel(shift)) : ''],
    ['Name in the database', escapeHtml(name)],
  ].filter(([, v]) => v !== '').map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  const others = (groups || []).filter(g => g.number === number && g.uuid !== record.record_uuid).sort(byNumber);
  const othersHtml = others.length ? `<section class="sg-others">
      <h2>Other symbols for space group ${number}</h2>
      <div class="sg-symbols">${others.map(g => {
        const p = parseName(g.name);
        const note = [p.setting && settingLabel(p.setting), p.shift && shiftLabel(p.shift)].filter(Boolean).join(', ');
        return `<a class="sg-link" href="${escapeHtml(detailUrl(g.uuid))}">${symbolHtml(p.symbol)}${note ? `<span class="sg-shift">${escapeHtml(note)}</span>` : ''}</a>`;
      }).join('')}</div>
    </section>` : '';

  view.innerHTML = `
    <nav class="sg-back"><a href="${escapeHtml(homeUrl(number))}">&larr; All space groups</a></nav>
    <h1>${symbolHtml(symbol)}</h1>
    <dl class="sg-facts">${facts}</dl>
    ${othersHtml}
    ${operatorTable('Generators', '(x,y,z) form', f['Generator XYZs'], f['Generator Ms'], true)}
    ${operatorTable('Symmetry operators', '(x,y,z) form', f.SymmetryOpXYZs, f.SymmetryOpMs, false)}
    ${operatorTable('Reciprocal space operators', '(h,k,l) form', f.SymmetryOphkl, f.ReciprocalSymmetryOpM, false)}`;
}

async function init() {
  if (!view) return;
  const uuid = new URLSearchParams(location.search).get('UUID');
  if (uuid && !/^[0-9a-fA-F]{1,64}$/.test(uuid)) {
    showStatus(`"${escapeHtml(uuid)}" is not a record UUID. <a href="${escapeHtml(homeUrl())}">See all space groups</a>.`, true);
    return;
  }
  showStatus('Loading…');
  try {
    if (uuid) {
      // The list only fills in the other symbols for the same number, so the page works without it.
      const [record, index] = await Promise.all([
        getJson(RECORD_URL + encodeURIComponent(uuid)),
        getJson(INDEX_URL).catch(() => null),
      ]);
      renderDetail(record, index && index.groups);
    } else {
      renderIndex((await getJson(INDEX_URL)).groups || []);
    }
  } catch (err) {
    const home = uuid ? ` <a href="${escapeHtml(homeUrl())}">See all space groups</a>.` : '';
    showStatus(`Could not load the symmetry data: ${escapeHtml(err.message)}${home}`, true);
  }
}

init();

})();
