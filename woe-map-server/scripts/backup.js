'use strict';
// Take a backup now: a consistent SQLite snapshot plus any upload files not yet mirrored.
// Usage: node scripts/backup.js [targetDir]
// Safe to run while the server is running (WAL mode). Schedule it with Task Scheduler for off-box copies.
const { runBackup } = require('../server/backup');
const config = require('../server/config');

const dir = process.argv[2] || config.backupDir;
const r = runBackup({ dir, keep: config.backupKeep });
console.log(`Snapshot: ${r.file}`);
console.log(`Upload files copied: ${r.copied}`);
if (r.removed.length) console.log(`Pruned old snapshots: ${r.removed.join(', ')}`);
