#!/usr/bin/env node
// Writes the symmetry page's list of every space group (the plugin's data/symmetry_index.json)
// from data/symmetry_all_records.json, the records `node scripts/symmetry_upload.js --check`
// fetches. The viewer's API account only gets 100 records from GET dataset/<uuid>.json, so the
// list starts from this file; the plugin's daily sync (and server.js) then add records made
// since and drop deleted ones, one record at a time.
//
// Usage: node scripts/symmetry_index.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RECORDS_FILE = path.join(ROOT, 'data', 'symmetry_all_records.json');
const INDEX_FILE = path.join(ROOT, 'wordpress-plugin', 'odr-rruff-cifviewer', 'data', 'symmetry_index.json');

// What the list shows of one record. Same shape as the plugin's cif_viewer_symmetry_entry().
function indexEntry(record) {
  const f = {};
  for (const field of record.fields || []) f[field.field_name] = field.value;
  return {
    uuid: record.record_uuid,
    id: Number(f.GroupID) || 0,
    name: String(f.SpaceGroupName || ''),
    number: Number(f.SpaceGroupNumber) || 0,
    system: String(f.CrystalSystem || ''),
    pointGroup: String(f.PointGroup || ''),
    lattice: String(f.Lattice || ''),
  };
}

const byGroupId = (a, b) => a.id - b.id;

if (require.main === module) {
  const records = Object.values(JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8')));
  const groups = records.map(indexEntry).filter(g => g.uuid && g.name).sort(byGroupId);
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  // One group per line, so a change shows up as a one-line diff.
  fs.writeFileSync(INDEX_FILE, `{"groups":[\n${groups.map(g => JSON.stringify(g)).join(',\n')}\n]}\n`);
  console.log(`${groups.length} space groups -> ${path.relative(ROOT, INDEX_FILE)}`);
}

module.exports = { indexEntry, byGroupId, INDEX_FILE };
