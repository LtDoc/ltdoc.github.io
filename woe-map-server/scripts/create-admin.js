'use strict';
// Create a site admin (or promote an existing user) from the command line.
// Usage: node scripts/create-admin.js <username> <password> [display name]
const { db, now } = require('../server/db');
const auth = require('../server/auth');

const [username, password, ...rest] = process.argv.slice(2);
const displayName = rest.join(' ').trim() || username;

if (!username || !password) {
  console.error('Usage: node scripts/create-admin.js <username> <password> [display name]');
  process.exit(1);
}
if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username)) { console.error('Username must be 3-24 letters, numbers, . _ or -'); process.exit(1); }
if (password.length < 8) { console.error('Password must be at least 8 characters'); process.exit(1); }

const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  db.prepare("UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?").run(auth.hashPassword(password), existing.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  console.log(`Updated ${username}: now a site admin with the new password.`);
} else {
  db.prepare('INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, displayName, auth.hashPassword(password), 'admin', now());
  console.log(`Created site admin ${username}.`);
}
