'use strict';
// Import markers from a Firebase Realtime Database JSON export of the old WoE-Player-Map.
//
// Usage: node scripts/import-firebase.js <export.json> <lobbyId> [--height N] [--owner USERID]
//
// The export can be the whole database ({ "markers": { ... } }) or just the markers node.
// The old map used Leaflet CRS.Simple where "lat" counts up from the BOTTOM of the image,
// so y = mapHeight - lat. The lobby's map height is used unless --height is given.
const fs = require('node:fs');
const { db, now } = require('../server/db');

const args = process.argv.slice(2);
const file = args[0];
const lobbyId = Number(args[1]);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (!file || !lobbyId) {
  console.error('Usage: node scripts/import-firebase.js <export.json> <lobbyId> [--height N] [--owner USERID]');
  process.exit(1);
}
const lobby = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(lobbyId);
if (!lobby) { console.error(`No lobby with id ${lobbyId}`); process.exit(1); }
const height = Number(opt('--height') || lobby.map_height);
if (!(height > 0)) { console.error('Map height unknown: upload a map to the lobby first or pass --height'); process.exit(1); }
const ownerId = opt('--owner') ? Number(opt('--owner')) : null;

let json = JSON.parse(fs.readFileSync(file, 'utf8'));
if (json && json.markers && typeof json.markers === 'object') json = json.markers;
const entries = Object.entries(json || {});

const TYPE = { player: 'player', town: 'town', poi: 'poi', army: 'unit' };
const SIZE_COLOR = { capital: '#f1c40f', city: '#e67e22', village: '#3498db' };
const insert = db.prepare(`
  INSERT INTO markers (lobby_id, type, name, x, y, icon_file, icon_url, color, admin_only, owner_id, data, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`);

let count = 0, skipped = 0;
const t = now();
const tx = db.prepare('BEGIN'); const commit = db.prepare('COMMIT');
tx.run();
for (const [key, m] of entries) {
  if (!m || typeof m !== 'object') { skipped++; continue; }
  const type = TYPE[String(m.type || '').trim().toLowerCase()];
  const lat = Number(m.lat), lng = Number(m.lng);
  if (!type || !Number.isFinite(lat) || !Number.isFinite(lng)) { skipped++; continue; }
  const name = String(m.name || key).slice(0, 60);
  const data = { notes: '' };
  const tooltip = m.tooltipType === 'text' ? String(m.tooltipContent || '') : '';
  let iconUrl = null;
  if (type === 'unit') {
    Object.assign(data, {
      nation: String(m.nation || ''), unitType: String(m.unitType || ''),
      attack: Number(m.attack) || 0, defend: Number(m.defend) || 0, ap: Number(m.actionPoints) || 0,
      range: Number(m.range) || 0, movement: Number(m.movement) || 0,
      abilities: [m.ap1, m.ap2, m.ap3].map(s => String(s || '').trim()).filter(Boolean),
      strength: 100, notes: String(m.abilityDesc || tooltip || ''),
    });
    iconUrl = m.iconUrl && /^https?:/.test(m.iconUrl) ? m.iconUrl : null;
  } else if (type === 'town') {
    data.size = ['capital', 'city', 'village'].includes(m.size) ? m.size : 'village';
    data.nation = ''; data.notes = tooltip;
  } else if (type === 'poi') {
    data.category = ''; data.notes = tooltip;
  } else {
    data.notes = tooltip || (m.tooltipType === 'image' && m.tooltipContent ? `Image: ${m.tooltipContent}` : '');
    iconUrl = m.iconUrl && /^https?:/.test(m.iconUrl) ? m.iconUrl : null;
  }
  const color = type === 'town' ? SIZE_COLOR[data.size] : (type === 'unit' ? '#c0392b' : (type === 'poi' ? '#f39c12' : '#2ecc71'));
  insert.run(lobbyId, type, name, lng, height - lat, iconUrl, color, m.adminOnly ? 1 : 0, ownerId, JSON.stringify(data), t, t);
  count++;
}
commit.run();
console.log(`Imported ${count} marker(s) into lobby ${lobbyId} (${skipped} skipped). Restart clients or reload the map page to see them.`);
