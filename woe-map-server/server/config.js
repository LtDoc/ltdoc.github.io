'use strict';
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dataDir = process.env.WOE_DATA_DIR
  ? path.resolve(process.env.WOE_DATA_DIR)
  : path.join(root, 'data');

module.exports = {
  root,
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  dbFile: path.join(dataDir, 'woe.db'),
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  sessionTtlMs: Number(process.env.WOE_SESSION_DAYS || 14) * 86400000,
  // Set WOE_SECURE_COOKIES=1 when the site is served over HTTPS (behind IIS/Caddy/nginx).
  secureCookies: process.env.WOE_SECURE_COOKIES === '1',
  maxUploadBytes: Number(process.env.WOE_MAX_UPLOAD_MB || 50) * 1024 * 1024,
  cookieName: 'woe_session',
  // Automatic backups: every N hours into backupDir, keeping the newest `backupKeep` snapshots. 0 disables.
  backupHours: Number(process.env.WOE_BACKUP_HOURS ?? 24),
  backupKeep: Number(process.env.WOE_BACKUP_KEEP || 14),
  backupDir: process.env.WOE_BACKUP_DIR ? path.resolve(process.env.WOE_BACKUP_DIR) : path.join(dataDir, 'backups'),
  // GIFs in the chat (routes/klipy.js): a KLIPY API key from https://klipy.com/developers. Empty: no GIF button.
  klipyKey: process.env.WOE_KLIPY_KEY || '',
  klipyBase: process.env.WOE_KLIPY_BASE || 'https://api.klipy.com/api/v1',
  klipyFilter: process.env.WOE_KLIPY_FILTER || '',   // KLIPY's content_filter, when wanted (e.g. 'high')
};
