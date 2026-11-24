// The metrics view, beside the converter on the same page: counts from metrics.json (written
// by scripts/metrics.js), each one a filter on the table of structures below it. The button
// at the top swaps the two views in place, so the page's URL (and its ?UUID=) never changes.
// Wrapped in a function so its names don't meet the converter scripts' globals.
(() => {

// --- The counts, in groups. Each metric is a filter on the rows: its count is how many rows
// pass it, out of the rows its `of` filter passes (all rows when there's none). ---
const has = v => v !== undefined && v !== null;
// Net charge per formula unit, as the mineral calc works it out for the record (netCharge in
// metrics.json); a charge this close to 0 counts as balanced.
const BALANCED = 0.0005;
// Native elements (every element positive-only, nothing to balance against) have a charge too
// but are kept out of the chart and the balance counts.
const charged = r => has(r.netCharge) && !r.nativeElement;
const GROUPS = [
  {
    title: 'Charge balance',
    histogram: true,
    metrics: [
      { id: 'chargeAll', label: 'Charge calculated', test: r => has(r.netCharge) },
      { id: 'chargeCalculated', label: 'Compounds', test: charged, of: 'chargeAll', hint: 'Everything but native elements: the chart and the counts after this one are of these' },
      { id: 'chargeBalanced', label: 'Balanced', test: r => charged(r) && Math.abs(r.netCharge) <= BALANCED, of: 'chargeCalculated' },
      { id: 'chargeUnbalanced', label: 'Not balanced', test: r => charged(r) && Math.abs(r.netCharge) > BALANCED, of: 'chargeCalculated' },
      { id: 'chargeWithinHalf', label: 'Within ±0.5', test: r => charged(r) && Math.abs(r.netCharge) <= 0.5, of: 'chargeCalculated' },
      { id: 'chargeOverOne', label: 'Off by more than 1', test: r => charged(r) && Math.abs(r.netCharge) > 1, of: 'chargeCalculated' },
      { id: 'chargeNegative', label: 'More than 1 too negative', test: r => charged(r) && r.netCharge < -1, of: 'chargeOverOne' },
      { id: 'chargePositive', label: 'More than 1 too positive', test: r => charged(r) && r.netCharge > 1, of: 'chargeOverOne' },
      { id: 'chargeWithIma', label: 'With an IMA formula', test: r => charged(r) && !r.chargeWithoutIma, of: 'chargeCalculated' },
      { id: 'chargeWithoutIma', label: 'Without an IMA formula', test: r => charged(r) && r.chargeWithoutIma === true, of: 'chargeCalculated', hint: 'No linked IMA mineral (mostly synthetic compounds): the cell is divided by its site-multiplicity gcd and valences have no IMA limits' },
      { id: 'chargeNative', label: 'Native elements', test: r => has(r.netCharge) && r.nativeElement === true, of: 'chargeAll', hint: 'Every element has only positive valences (metals, alloys, carbides like SiC), so the charge is never 0; not in the chart' },
      { id: 'chargeOther', label: 'Not calculated', test: r => has(r.chargeSkipped), hint: 'No readable AMC file or Chemistry, or not in the database pull' },
    ],
  },
  {
    title: 'Computed chemical formula',
    note: 'The formula from the unit cell (sum of occupancies over every position, divided by Z), as AMC → CIF writes it.',
    metrics: [
      { id: 'computed', label: 'Formula computed', test: r => has(r.formula) },
      { id: 'notComputed', label: 'No formula computed', test: r => !has(r.formula) },
      { id: 'whole', label: 'All whole-number amounts', test: r => r.whole === true, of: 'computed' },
      { id: 'fractional', label: 'Some fractional amounts', test: r => r.whole === false, of: 'computed' },
      { id: 'divisor', label: 'Common divisor in formula', test: r => r.divisor > 1, of: 'whole', hint: 'Whole-number formulas whose amounts are all divisible by the same number (e.g. Ce2 P10 O30 N4 → 2)' },
      { id: 'noDivisor', label: 'No common divisor in formula', test: r => r.divisor === 1, of: 'whole' },
      { id: 'z1', label: 'Z = 1 (whole cell)', test: r => r.Z === 1, of: 'computed' },
      { id: 'zOver1', label: 'Z > 1', test: r => r.Z > 1, of: 'computed' },
      { id: 'z1Divisor', label: 'Z = 1 and a common divisor', test: r => r.Z === 1 && r.divisor > 1, of: 'z1' },
      { id: 'z1NoDivisor', label: 'Z = 1 and no common divisor', test: r => r.Z === 1 && !(r.divisor > 1), of: 'z1' },
      { id: 'amcsdDivisor', label: "Common divisor in AMCSD's formula", test: r => r.amcsdDivisor > 1, of: 'amcsdFormula' },
      { id: 'amcsdNoDivisor', label: "No common divisor in AMCSD's formula", test: r => has(r.amcsdFormula) && has(r.formula) && !(r.amcsdDivisor > 1), of: 'amcsdFormula' },
    ],
  },
  {
    title: 'Compared with AMCSD',
    note: "Our formula, volume and density against the AMCSD CIF's _chemical_formula_sum, _cell_volume and _exptl_crystal_density_diffrn.",
    metrics: [
      { id: 'amcsdFormula', label: 'Have an AMCSD formula', test: r => has(r.amcsdFormula) && has(r.formula) },
      { id: 'exact', label: 'Formula matches exactly', test: r => r.match === 'exact', of: 'amcsdFormula' },
      { id: 'notExact', label: "Formula doesn't match exactly", test: r => has(r.match) && r.match !== 'exact', of: 'amcsdFormula' },
      { id: 'scaled', label: 'Same chemistry, different Z', test: r => r.match === 'scaled', of: 'amcsdFormula' },
      { id: 'hOnly', label: 'Differs only in H or D', test: r => r.match === 'hOnly', of: 'amcsdFormula' },
      { id: 'differs', label: 'Formula differs', test: r => r.match === 'differs', of: 'amcsdFormula' },
      { id: 'volumeMatch', label: 'Volume matches', test: r => r.volumeMatch === true, of: 'hasVolume' },
      { id: 'volumeDiffers', label: 'Volume differs', test: r => r.volumeMatch === false, of: 'hasVolume' },
      { id: 'densityMatch', label: 'Density matches', test: r => r.densityMatch === true, of: 'hasDensity' },
      { id: 'densityDiffers', label: 'Density differs', test: r => r.densityMatch === false, of: 'hasDensity' },
    ],
  },
  {
    title: 'CIF vs AMC unit cell',
    note: 'Whether the CIF and the AMC file of the same structure give the same unit cell atoms (scripts/check_unit_cell.js).',
    metrics: [
      { id: 'compared', label: 'Pairs compared', test: r => has(r.cifVsAmc) },
      { id: 'notCompared', label: 'Pairs not compared', test: r => !has(r.cifVsAmc) },
      { id: 'same', label: 'Same atoms', test: r => r.cifVsAmc === 'same', of: 'compared' },
      { id: 'notSame', label: 'Different atoms (any reason below)', test: r => has(r.cifVsAmc) && r.cifVsAmc !== 'same', of: 'compared' },
      ...['datasetCount', 'atomCount', 'position', 'occupancy', 'lastDigit', 'printed', 'labelOnly'].map(kind => ({
        id: `cell-${kind}`, label: { datasetCount: 'Different dataset count', atomCount: 'Different atom count', position: 'Different position', occupancy: 'Different occupancy', lastDigit: 'Differ in last digit', printed: 'Print differently', labelOnly: 'Labels only' }[kind],
        test: r => r.cifVsAmc === kind, of: 'compared',
      })),
      { id: 'error', label: 'File could not be read', test: r => has(r.error) },
      { id: 'noError', label: 'Both files read', test: r => !has(r.error) },
    ],
  },
];
// Filters used only as denominators.
const HIDDEN = [
  { id: 'hasVolume', test: r => has(r.amcsdVolume) && has(r.volume) },
  { id: 'hasDensity', test: r => has(r.amcsdDensity) && has(r.density) },
];
const METRICS = new Map([...GROUPS.flatMap(g => g.metrics), ...HIDDEN].filter(m => m.id).map(m => [m.id, m]));

// --- The net charge histogram: bins 0.05 wide, centred on multiples of 0.05 (the 0 bin is
// -0.025 to +0.025), across ±range, with one bar each for everything below and above. ---
const BIN = 0.05;
const CHARGE_RANGES = [0.5, 1, 2, 5];
const chart = { range: 0.5, log: true };
const binOf = x => Math.round(x / BIN);
const edge = k => (k * BIN).toFixed(3);

// A filter for one bar ("charge:<k>", "charge:below:<range>" or "charge:above:<range>").
function chargeBinFilter(id) {
  const [, a, b] = id.split(':');
  if (a === 'below') return { label: `Net charge below ${edge(-binOf(+b) - 0.5)}`, test: r => charged(r) && binOf(r.netCharge) < -binOf(+b) };
  if (a === 'above') return { label: `Net charge above ${edge(binOf(+b) + 0.5)}`, test: r => charged(r) && binOf(r.netCharge) > binOf(+b) };
  const k = +a;
  return { label: `Net charge ${edge(k - 0.5)} to ${edge(k + 0.5)}`, test: r => charged(r) && binOf(r.netCharge) === k };
}
const filterOf = id => (id.startsWith('charge:') ? chargeBinFilter(id) : METRICS.get(id));

function renderHistogram(box) {
  const kmax = binOf(chart.range);
  const counts = new Map();
  let below = 0, above = 0;
  for (const r of state.rows) {
    if (!charged(r)) continue;
    const k = binOf(r.netCharge);
    if (k < -kmax) below++;
    else if (k > kmax) above++;
    else counts.set(k, (counts.get(k) || 0) + 1);
  }
  const bars = [{ id: `charge:below:${chart.range}`, n: below, outside: true }];
  for (let k = -kmax; k <= kmax; k++) bars.push({ id: `charge:${k}`, n: counts.get(k) || 0 });
  bars.push({ id: `charge:above:${chart.range}`, n: above, outside: true });

  const W = 1000, H = 300, L = 56, R = 8, T = 10, B = 42, pw = W - L - R, ph = H - T - B;
  const slot = pw / (bars.length + 2); // a slot's gap each side of the two outside bars
  const x = i => L + (i + (i > 0) + (i === bars.length - 1)) * slot;
  const max = Math.max(1, ...bars.map(b => b.n));
  const y = chart.log ? n => T + ph - (ph * Math.log10(n + 1)) / Math.log10(max + 1) : n => T + ph - (ph * n) / max;
  const ticks = chart.log ? [1, 10, 100, 1000, 10000].filter(t => t <= max) : niceTicks(max);
  const step = { 0.5: 0.1, 1: 0.25, 2: 0.5, 5: 1 }[chart.range];
  const parts = [];
  for (const t of ticks) parts.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t.toLocaleString()}</text>`);
  for (let v = -chart.range; v <= chart.range + 1e-9; v += step) {
    const cx = x(binOf(v) + kmax + 1) + slot / 2;
    parts.push(`<line class="grid" x1="${cx}" x2="${cx}" y1="${T + ph}" y2="${T + ph + 4}"/><text class="axis" x="${cx}" y="${T + ph + 18}" text-anchor="middle">${+v.toFixed(2)}</text>`);
  }
  parts.push(`<text class="axis" x="${x(0) + slot / 2}" y="${T + ph + 18}" text-anchor="middle">below</text>`);
  parts.push(`<text class="axis" x="${x(bars.length - 1) + slot / 2}" y="${T + ph + 18}" text-anchor="middle">above</text>`);
  parts.push(`<text class="axis" x="${L + pw / 2}" y="${H - 4}" text-anchor="middle">net charge per formula unit</text>`);
  const zero = x(kmax + 1) + slot / 2;
  parts.push(`<line class="zero" x1="${zero}" x2="${zero}" y1="${T}" y2="${T + ph}"/>`);
  bars.forEach((b, i) => {
    const label = filterOf(b.id).label;
    const top = b.n ? y(b.n) : T + ph;
    parts.push(`<g class="bin${b.outside ? ' outside' : ''}${state.filter === b.id ? ' active' : ''}" data-filter="${b.id}"><title>${label}: ${b.n.toLocaleString()}</title>`
      + `<rect class="hit" x="${x(i)}" y="${T}" width="${slot}" height="${ph}"/>`
      + (b.n ? `<rect class="bar" x="${x(i) + 1}" y="${top}" width="${Math.max(1, slot - 2)}" height="${T + ph - top}" rx="1"/>` : '')
      + '</g>');
  });
  box.querySelector('svg').innerHTML = parts.join('');
  box.querySelectorAll('.bin').forEach(g => g.addEventListener('click', () => {
    setFilter(g.dataset.filter);
    $('metricsExplorer').scrollIntoView({ behavior: 'smooth' });
  }));
  const seg = (id, items, get, set) => {
    const el = box.querySelector(id);
    el.innerHTML = '';
    for (const [label, value] of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.classList.toggle('on', get() === value);
      button.addEventListener('click', () => { set(value); renderHistogram(box); });
      el.appendChild(button);
    }
  };
  seg('.ranges', CHARGE_RANGES.map(r => [`±${r}`, r]), () => chart.range, v => { chart.range = v; });
  seg('.scales', [['Log', true], ['Linear', false]], () => chart.log, v => { chart.log = v; });
}

function niceTicks(max) {
  const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * mag).find(m => m >= raw);
  const out = [];
  for (let t = 0; t <= max; t += step) out.push(t);
  return out;
}

// --- Table columns ---
const fmt = v => (v === true ? 'yes' : v === false ? 'no' : has(v) ? String(v) : '');
const COLUMNS = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: 'Name' },
  { key: 'sg', label: 'Space group' },
  { key: 'formula', label: 'Computed formula', cls: 'formula' },
  { key: 'Z', label: 'Z', cls: 'num' },
  { key: 'divisor', label: 'Divisor', cls: 'num' },
  { key: 'amcsdFormula', label: 'AMCSD formula', cls: 'formula' },
  { key: 'match', label: 'Formula vs AMCSD', bad: r => r.match && r.match !== 'exact' },
  { key: 'impliedZ', label: 'AMCSD Z', cls: 'num' },
  { key: 'volume', label: 'Volume', cls: 'num', bad: r => r.volumeMatch === false },
  { key: 'density', label: 'Density', cls: 'num', bad: r => r.densityMatch === false },
  { key: 'cifVsAmc', label: 'CIF vs AMC', bad: r => r.cifVsAmc && r.cifVsAmc !== 'same' },
  { key: 'netCharge', label: 'Net charge', cls: 'num', bad: r => has(r.netCharge) && Math.abs(r.netCharge) > BALANCED },
  { key: 'chargeFormula', label: 'Charge formula', cls: 'formula' },
];
// Every field, in order, for the detail view.
const DETAIL_FIELDS = [
  ['id', 'ID'], ['name', 'Name'], ['amc', 'AMC file'], ['cif', 'CIF file'], ['sg', 'Space group'],
  ['datasets', 'Datasets'], ['atoms', 'Atoms in cell'], ['orders', 'Site orders'], ['Z', 'Z'],
  ['formula', 'Computed formula'], ['whole', 'Whole numbers'], ['divisor', 'Common divisor'],
  ['amcsdFormula', 'AMCSD formula'], ['amcsdDivisor', 'AMCSD common divisor'], ['amcsdZ', 'AMCSD _cell_formula_units_Z'],
  ['match', 'Formula vs AMCSD'], ['impliedZ', 'Z implied by AMCSD formula'],
  ['volume', 'Volume'], ['amcsdVolume', 'AMCSD volume'], ['volumeMatch', 'Volume matches'],
  ['density', 'Density'], ['amcsdDensity', 'AMCSD density'], ['densityMatch', 'Density matches'],
  ['unknown', 'Labels with no element'], ['cifVsAmc', 'CIF vs AMC'], ['cifVsAmcDetail', 'CIF vs AMC detail'], ['error', 'Error'],
  ['netCharge', 'Net charge'], ['chargeFormula', 'Formula the charge is from'], ['cationCharge', 'Total cation charge'], ['chargeWithoutIma', 'Charge without an IMA formula'], ['nativeElement', 'Native element'], ['chargeSkipped', 'Charge not calculated'],
];

const PAGE_SIZE = 100;
const state = { rows: [], charges: [], hasMetrics: false, columns: COLUMNS, filter: '', search: '', sort: null, desc: false, page: 0, tab: 0 };
// Charge balance comes from the charge file, which ships with the plugin; the other groups
// need metrics.json.
const available = group => group.histogram || state.hasMetrics;
const $ = id => document.getElementById(id);

function count(id) {
  const m = METRICS.get(id);
  return state.rows.filter(m.test).length;
}

// One group at a time, picked from tabs above it (the first, Charge balance, to start), so
// the table of structures sits right under the counts and chart that filter it.
function renderSummary() {
  const summary = $('metricsSummary');
  summary.innerHTML = '';
  const tabs = document.createElement('div');
  tabs.className = 'metricsTabs';
  tabs.setAttribute('role', 'tablist');
  if (!available(GROUPS[state.tab])) state.tab = 0;
  GROUPS.forEach((group, i) => {
    if (!available(group)) return;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', i === state.tab);
    tab.textContent = group.title;
    tab.addEventListener('click', () => { state.tab = i; renderSummary(); });
    tabs.appendChild(tab);
  });
  summary.appendChild(tabs);
  for (const group of [GROUPS[state.tab]]) {
    const section = document.createElement('section');
    section.className = 'group';
    section.innerHTML = `<h2></h2><p></p><div class="cards"></div>`;
    section.querySelector('h2').textContent = group.title;
    if (group.note) section.querySelector('p').textContent = group.note;
    else section.querySelector('p').remove();
    const cards = section.querySelector('.cards');
    if (group.histogram) {
      const box = document.createElement('div');
      box.className = 'chargeHistogram';
      box.innerHTML = '<div class="chartControls">Range <span class="seg ranges"></span> Count scale <span class="seg scales"></span></div>'
        + '<svg viewBox="0 0 1000 300" role="img" aria-label="Histogram of net charge per formula unit"></svg>';
      section.insertBefore(box, cards);
      renderHistogram(box);
    }
    for (const m of group.metrics) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      const n = count(m.id);
      const total = m.of ? count(m.of) : null;
      const pct = total ? `${((100 * n) / total).toFixed(1)}%` : '';
      card.innerHTML = `<span class="value">${n.toLocaleString()}<span class="pct"></span></span><span class="label"></span>`;
      card.querySelector('.pct').textContent = total !== null ? `of ${total.toLocaleString()}${pct ? ` · ${pct}` : ''}` : '';
      card.querySelector('.label').textContent = m.label;
      if (m.hint) card.title = m.hint;
      card.dataset.filter = m.id;
      card.addEventListener('click', () => { setFilter(m.id); $('metricsExplorer').scrollIntoView({ behavior: 'smooth' }); });
      cards.appendChild(card);
    }
    summary.appendChild(section);
  }
  summary.querySelectorAll('.card, .bin').forEach(c => c.classList.toggle('active', c.dataset.filter === state.filter));
}

function renderFilterOptions() {
  const select = $('metricsFilter');
  select.innerHTML = '<option value="">All structures</option>';
  for (const group of GROUPS.filter(available)) {
    const og = document.createElement('optgroup');
    og.label = group.title;
    for (const m of group.metrics) og.appendChild(new Option(m.label, m.id));
    if (og.children.length) select.appendChild(og);
  }
}

function setFilter(id) {
  state.filter = id;
  state.page = 0;
  const select = $('metricsFilter');
  // A histogram bar's filter gets its own option while it's picked.
  select.querySelectorAll('option.bin').forEach(o => o.remove());
  if (id.startsWith('charge:')) select.appendChild(Object.assign(new Option(filterOf(id).label, id), { className: 'bin' }));
  select.value = id;
  document.querySelectorAll('#metricsView .card, #metricsView .bin').forEach(c => c.classList.toggle('active', c.dataset.filter === id));
  renderTable();
}

function visibleRows() {
  const q = state.search.trim().toLowerCase();
  let rows = state.rows;
  if (state.filter) rows = rows.filter(filterOf(state.filter).test);
  if (q) rows = rows.filter(r => [r.id, r.name, r.formula, r.amcsdFormula, r.sg, r.chargeFormula].some(v => v && String(v).toLowerCase().includes(q)));
  if (state.sort) {
    const k = state.sort, dir = state.desc ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const [x, y] = [a[k], b[k]];
      if (!has(x)) return has(y) ? 1 : 0;
      if (!has(y)) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }
  return rows;
}

function renderTable() {
  const rows = visibleRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const label = state.filter ? filterOf(state.filter).label : 'All structures';
  $('metricsResultCount').textContent = `${label}: ${rows.length.toLocaleString()} structure${rows.length === 1 ? '' : 's'}${state.search.trim() ? ` matching "${state.search.trim()}"` : ''}`;
  $('metricsPageInfo').textContent = `Page ${state.page + 1} of ${pages}`;
  $('metricsPrevPage').disabled = state.page === 0;
  $('metricsNextPage').disabled = state.page >= pages - 1;

  const head = $('metricsTable').tHead;
  head.innerHTML = '';
  const hr = head.insertRow();
  for (const col of state.columns) {
    const th = document.createElement('th');
    th.textContent = col.label + (state.sort === col.key ? (state.desc ? ' ▼' : ' ▲') : '');
    th.addEventListener('click', () => {
      state.desc = state.sort === col.key ? !state.desc : false;
      state.sort = col.key;
      renderTable();
    });
    hr.appendChild(th);
  }
  const body = $('metricsTable').tBodies[0];
  body.innerHTML = '';
  for (const r of rows.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE)) {
    const tr = body.insertRow();
    for (const col of state.columns) {
      const td = tr.insertCell();
      td.textContent = fmt(r[col.key]);
      if (col.cls) td.className = col.cls;
      if (col.bad && col.bad(r)) td.classList.add('bad');
    }
    tr.addEventListener('click', () => showDetail(r));
  }
}

function showDetail(r) {
  $('metricsDetailTitle').textContent = `${r.name} (${r.id})`;
  const table = $('metricsDetailTable');
  table.innerHTML = '';
  for (const [key, label] of DETAIL_FIELDS) {
    if (!has(r[key])) continue;
    const tr = table.insertRow();
    tr.insertCell().textContent = label;
    tr.insertCell().textContent = fmt(r[key]);
  }
  $('metricsDetail').showModal();
}

function downloadCsv() {
  const fields = DETAIL_FIELDS.map(([key]) => key);
  const quote = v => { const s = fmt(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [fields.join(','), ...visibleRows().map(r => fields.map(f => quote(r[f])).join(','))];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `metrics${state.filter ? `-${state.filter}` : ''}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const CHARGE_KEYS = ['netCharge', 'chargeFormula', 'cationCharge', 'chargeWithoutIma', 'nativeElement', 'chargeSkipped'];

// The rows: metrics.json's (when there is one) with each structure's charge from the charge
// file, plus the structures only the charge file has.
function load(metrics) {
  const charges = new Map(state.charges.map(c => [c.id, c]));
  const rows = (metrics ? metrics.rows || [] : []).map(row => {
    const merged = { ...row };
    for (const k of CHARGE_KEYS) delete merged[k];
    const charge = charges.get(row.id);
    if (!charge) return { ...merged, chargeSkipped: 'Not in the net charge file' };
    return { ...charge, ...merged, ...Object.fromEntries(CHARGE_KEYS.filter(k => k in charge).map(k => [k, charge[k]])) };
  });
  const inMetrics = new Set(rows.map(r => r.id));
  state.rows = [...rows, ...[...charges.values()].filter(c => !inMetrics.has(c.id))];
  state.hasMetrics = Boolean(metrics);
  // Only the columns some row has a value for.
  state.columns = COLUMNS.filter(col => col.key === 'id' || col.key === 'name' || state.rows.some(r => has(r[col.key])));
  const panel = $('metricsLoadPanel');
  panel.hidden = state.hasMetrics;
  panel.querySelector('p').textContent = 'For the other metrics, choose a metrics.json file (see the README)';
  $('metricsExplorer').after(panel);
  $('metricsExplorer').hidden = false;
  const dates = [
    state.chargesGenerated && `net charges from ${new Date(state.chargesGenerated).toLocaleDateString()}`,
    metrics && metrics.generated && `metrics from ${new Date(metrics.generated).toLocaleDateString()}`,
  ].filter(Boolean);
  $('metricsSource').textContent = [`${state.rows.length.toLocaleString()} structures`, ...dates].join(' · ');
  renderSummary();
  renderFilterOptions();
  setFilter('');
}

$('metricsSearch').addEventListener('input', e => { state.search = e.target.value; state.page = 0; renderTable(); });
$('metricsFilter').addEventListener('change', e => setFilter(e.target.value));
$('metricsClearFilter').addEventListener('click', () => { $('metricsSearch').value = ''; state.search = ''; setFilter(''); });
$('metricsDownloadCsv').addEventListener('click', downloadCsv);
$('metricsPrevPage').addEventListener('click', () => { state.page--; renderTable(); });
$('metricsNextPage').addEventListener('click', () => { state.page++; renderTable(); });
$('metricsFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (file) load(JSON.parse(await file.text()));
});

// Fetched the first time the view is opened: the net charges (data/net_charge.json, from
// scripts/net_charge.mjs, committed with the plugin) and metrics.json (about 12 MB, not
// committed; without it only Charge balance is shown). The WordPress plugin passes its own
// URLs for them (odrRruffCifViewer.netChargeUrl and metricsUrl).
let requested = false;
function fetchData() {
  if (requested) return;
  requested = true;
  const config = window.odrRruffCifViewer || {};
  $('metricsSource').textContent = 'Loading…';
  const getJson = url => fetch(url).then(res => { if (!res.ok) throw new Error(res.status); return res.json(); });
  Promise.all([
    getJson(config.netChargeUrl || 'wordpress-plugin/odr-rruff-cifviewer/data/net_charge.json').catch(() => null),
    getJson(config.metricsUrl || 'data/metrics.json').catch(() => null),
  ]).then(([charges, metrics]) => {
    if (!charges && !metrics) {
      $('metricsSource').textContent = '';
      $('metricsLoadPanel').hidden = false;
      return;
    }
    state.charges = charges ? charges.rows || [] : [];
    state.chargesGenerated = charges && charges.generated;
    load(metrics);
  });
}

function showView(metrics) {
  $('converterView').hidden = metrics;
  $('metricsView').hidden = !metrics;
  $('viewToggle').textContent = metrics ? '← CIF Converter' : 'CIF and AMC Metrics →';
  if (metrics) fetchData();
}
$('viewToggle').addEventListener('click', () => showView($('metricsView').hidden));
})();
