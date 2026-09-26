'use strict';
// Backups: a consistent SQLite snapshot (VACUUM INTO) plus a mirror of new upload files.
// Runs on a timer inside the server and on demand via scripts/backup.js.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { db } = require('./db');

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function runBackup({ dir = config.backupDir, keep = config.backupKeep } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `woe-${stamp()}.db`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);

  // Uploads are immutable (random names, never rewritten), so copying only new files is safe.
  const mirror = path.join(dir, 'uploads');
  fs.mkdirSync(mirror, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(config.uploadsDir)) {
    const dst = path.join(mirror, name);
    if (!fs.existsSync(dst)) { fs.copyFileSync(path.join(config.uploadsDir, name), dst); copied++; }
  }

  // Prune old snapshots.
  const snaps = fs.readdirSync(dir).filter(n => /^woe-\d{8}-\d{4}\.db$/.test(n)).sort();
  const removed = [];
  while (snaps.length > keep) { const old = snaps.shift(); fs.unlinkSync(path.join(dir, old)); removed.push(old); }
  return { file, copied, removed };
}

function schedule() {
  const hours = config.backupHours;
  if (!(hours > 0)) return null;
  const tick = () => {
    try { const r = runBackup(); console.log(`[backup] wrote ${r.file} (+${r.copied} upload files)`); }
    catch (e) { console.error('[backup] failed', e); }
  };
  const timer = setInterval(tick, hours * 3600 * 1000);
  timer.unref();
  return timer;
}

module.exports = { runBackup, schedule };
