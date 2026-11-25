#!/usr/bin/env node
// Writes every AMCSD structure's net charge per formula unit to its own file, which the
// metrics view's Charge balance tab reads (committed with the plugin, so the histogram
// needs nothing else), worked out with the
// mineral calc's own code (odr-rruff-mineralcalc) from a scripts/amcsd_pull.js folder:
//  - the pulled FormulaCalcElements table is loaded over the bundled one, as the page does;
//  - with a linked IMA mineral, the record goes through mineralFromRecord and the page's
//    steps (buildIdealRows, buildEmpiricalRows, the site-average refill): the AMC formula
//    scaled to the IMA formula, valences kept within its own;
//  - without one, the same AMC reading with no IMA formula: the cell divided by its
//    site-multiplicity gcd, valences limited only by the element table.
// Either way the AMC file is read as is (no H added), label valences (Fe2+) are kept as
// given, and other elements take whichever valence balances best. With no readable AMC
// file, the record's Chemistry field is used, as the mineral calc does.
//
//   node scripts/net_charge.mjs path/to/odr-rruff-mineralcalc pullDir wordpress-plugin/odr-rruff-cifviewer/data/net_charge.json
//
// { generated, rows }, a row per record: id, name, then netCharge, chargeFormula,
// cationCharge (total positive charge), chargeWithoutIma and nativeElement (true when so),
// or chargeSkipped (why there's none).
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const [ROOT, PULL, OUT] = process.argv.slice(2);
if (!ROOT || !PULL || !OUT) {
  console.error('Usage: node scripts/net_charge.mjs path/to/odr-rruff-mineralcalc pullDir out.json');
  process.exit(1);
}
const AMCSD_DB = 'bf04d8bf310bcf7a1126d2f042c6';
const IMA_DB = '8737e9e4212f5eac3703aeeb5cae';

// The mineral calc's modules import .jsx, so they're bundled for Node first (with its esbuild).
const { build } = createRequire(join(ROOT, 'package.json'))('esbuild');
const outfile = join(tmpdir(), `net-charge-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `export { mineralFromRecord } from './src/mineralDataSources.js';
               export { amcValenceChemistry } from './src/amcChemistry.js';
               export { unitCellFromAmc } from './src/amcsd/amcFile.js';
               export { buildIdealRows, buildEmpiricalRows, averageCitationAtoms } from './src/empiricalFormulaRows.js';
               export { ELEMENTS } from './src/elements.js';
               export { parseElementRecords } from './src/elementsLoader.js';`,
    resolveDir: ROOT,
    loader: 'js',
  },
  bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', outfile, logLevel: 'error',
});
const M = await import(pathToFileURL(outfile).href);
rmSync(outfile, { force: true });

// elementsLoader.js's loadElementsFromDatabase, from the pulled records.
const table = M.parseElementRecords(JSON.parse(readFileSync(join(PULL, 'elements.json'), 'utf8')));
Object.assign(M.ELEMENTS, table);
if (table.Ce) M.ELEMENTS.REE = { ...table.Ce };

const f = (field_name, value) => ({ field_name, value });
const asRecord = r => ({
  database_uuid: AMCSD_DB,
  record_name: r.id,
  fields: [f('database_code_amcsd', r.id), f('Mineral', r.name), f('Chemistry', r.chemistry), f('AMC File Contents', r.amc)],
  records: [{ database_uuid: IMA_DB, fields: [f('Mineral Name', r.imaName), f('Valence Formula', r.valenceFormula)] }],
});

// The citation amcsdCitationOf would build with no ideal formula.
function citationWithoutIma(r) {
  let chem = null;
  try { chem = r.amc.trim() ? M.amcValenceChemistry(r.amc, undefined, {}) : null; } catch { chem = null; }
  const formula = chem ? chem.formulaStr : r.chemistry;
  if (!formula) throw new Error('No readable AMC file or Chemistry');
  return {
    formula, citation: r.id, amcsdId: r.id, keepScale: false,
    amcValences: chem?.labelled?.length ? chem : null,
    amcScale: chem ? { divisor: chem.Z, divisors: chem.divisors, symmetryCount: chem.symmetryCount, scaledToIdeal: false, withDivisor: () => null } : null,
  };
}

// Why a record has no charge, as close to the cause as the AMC file shows; null when its AMC
// file reads fine (then the calculator's own message is used).
function whyNoCharge(r) {
  if (!r.amc.trim()) return r.chemistry ? null : 'No AMC file and no Chemistry';
  let atoms;
  try {
    atoms = M.unitCellFromAmc(r.amc)[0].atoms.length;
  } catch (e) {
    return `AMC file can't be read: ${e.message}`;
  }
  if (atoms) return null;
  return /^\s*atom\s/im.test(r.amc)
    ? 'AMC file has no atom rows that could be read'
    : 'AMC file has no column header line (atom x y z ...), so no atoms were read';
}

async function chargeOf(r) {
  let name = r.name, ideal = '', citations;
  if (r.valenceFormula) ({ name, formulaStr: ideal, citations } = await M.mineralFromRecord(asRecord(r)));
  else citations = [citationWithoutIma(r)];
  // LandingPage: the ideal rows, then the site-average refill for a modified ideal formula.
  const idealRows = ideal ? M.buildIdealRows(name, ideal) : [];
  let built = M.buildEmpiricalRows(name, citations, idealRows, ideal);
  const average = idealRows[0]?.result?.isModifiedIdeal ? M.averageCitationAtoms(built.rows) : null;
  const filled = average ? M.buildIdealRows(name, ideal, average) : null;
  if (filled?.[0]?.siteAverageCount) built = M.buildEmpiricalRows(name, citations, filled, ideal);
  const row = built.rows[0];
  if (!row) throw new Error(built.errors[0]?.error || 'No formula');
  const cols = row.result.isRange ? row.result.columns : [row.result];
  const net = cols.reduce((w, c) => (Math.abs(c.netCharge) > Math.abs(w) ? c.netCharge : w), 0);
  const cations = (cols[0].atoms || []).reduce((s, a) => s + (a.valence > 0 ? a.valence * a.count : 0), 0);
  return {
    netCharge: +net.toFixed(3),
    chargeFormula: String(row.formulaStr).replace(/[_^]/g, ''),
    cationCharge: +cations.toFixed(3),
    ...(r.valenceFormula ? {} : { chargeWithoutIma: true }),
    ...(row.result.isMetallic ? { nativeElement: true } : {}),
  };
}

const pages = join(PULL, 'amcsd');
const records = readdirSync(pages).sort().flatMap(file => JSON.parse(readFileSync(join(pages, file), 'utf8')).records);
const rows = [];
const counts = {};
for (const r of records) {
  let charge;
  try {
    charge = await chargeOf(r);
  } catch (e) {
    charge = { chargeSkipped: whyNoCharge(r) || e.message };
  }
  rows.push({ id: r.id, name: r.name, ...charge });
  const kind = charge.chargeSkipped ? 'not calculated' : charge.nativeElement ? 'native element' : charge.chargeWithoutIma ? 'without IMA formula' : 'with IMA formula';
  counts[kind] = (counts[kind] || 0) + 1;
}
rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
// One row per line keeps diffs of the committed file readable.
const lines = rows.map(row => JSON.stringify(row)).join(',\n');
writeFileSync(OUT, `{"generated":${JSON.stringify(new Date().toISOString())},"rows":[\n${lines}\n]}\n`);
console.error(counts);
