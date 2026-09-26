'use strict';
// Delete upload files that nothing references any more: not a lobby map, not a marker icon, and not
// an icon kept in change history (so reverts keep working). Run with --dry-run to just list them.
// Usage: node scripts/cleanup-uploads.js [--dry-run] [--history-days N]
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../server/db');
const config = require('../server/config');

const dry = process.argv.includes('--dry-run');
const daysArg = process.argv.indexOf('--history-days');
const historyDays = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : 90;
const cutoff = Date.now() - historyDays * 86400000;

const keep = new Set();
for (const r of db.prepare('SELECT map_file f FROM lobbies WHERE map_file IS NOT NULL').all()) keep.add(r.f);
for (const r of db.prepare('SELECT icon_file f FROM markers WHERE icon_file IS NOT NULL').all()) keep.add(r.f);
for (const r of db.prepare("SELECT before, after FROM history WHERE entity = 'marker' AND created_at >= ?").all(cutoff)) {
  for (const s of [r.before, r.after]) {
    if (!s) continue;
    try { const o = JSON.parse(s); if (o.iconFile) keep.add(o.iconFile); } catch { /* ignore */ }
  }
}

let removed = 0, bytes = 0;
for (const name of fs.readdirSync(config.uploadsDir)) {
  if (keep.has(name)) continue;
  const p = path.join(config.uploadsDir, name);
  const size = fs.statSync(p).size;
  console.log(`${dry ? 'would remove' : 'removing'} ${name} (${Math.round(size / 1024)} KB)`);
  if (!dry) fs.unlinkSync(p);
  removed++; bytes += size;
}
console.log(`${dry ? 'Would remove' : 'Removed'} ${removed} file(s), ${Math.round(bytes / 1024)} KB. Kept ${keep.size} referenced file(s); history window ${historyDays} days.`);
