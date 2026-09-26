'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { db, now } = require('../db');
const { requireAuth } = require('../auth');
const access = require('../lobbyAccess');
const geo = require('../geo');
const hub = require('../ws');
const hist = require('../history');
const { imageSize } = require('../imageSize');
const UnitTypes = require('../../public/js/units');   // shared catalogue: formation names and default stats
const Naming = require('../../public/js/naming');     // shared ordinal rules for sequential unit names

const router = express.Router();
router.use(requireAuth);

// ---- Uploads ------------------------------------------------------------------
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const storage = multer.diskStorage({
  destination: config.uploadsDir,
  filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + (EXT[file.mimetype] || '')),
});
const fileFilter = (req, file, cb) => cb(null, !!EXT[file.mimetype]);
// Map images may be large (they are shrunk in the browser first); icons and flags are capped at 5 MB.
const upload = multer({ storage, limits: { fileSize: config.maxUploadBytes, files: 1 }, fileFilter });
const uploadSmall = multer({ storage, limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter });

const FLAGS_DIR = path.join(config.root, 'public', 'flags');
function bundledFlags() {
  try { return fs.readdirSync(FLAGS_DIR).filter(n => /\.(png|jpe?g|webp|gif|svg)$/i.test(n)).sort((a, b) => a.localeCompare(b)); }
  catch { return []; }
}

function removeUpload(file) {
  if (!file) return;
  fs.promises.unlink(path.join(config.uploadsDir, file)).catch(() => {});
}

// ---- Prepared statements ---------------------------------------------------------
const q = {
  myLobbies: db.prepare(`
    SELECT l.* FROM lobbies l
    JOIN lobby_members m ON m.lobby_id = l.id WHERE m.user_id = ?
    ORDER BY l.created_at DESC`),
  allLobbies: db.prepare('SELECT * FROM lobbies ORDER BY created_at DESC'),
  byCode: db.prepare('SELECT * FROM lobbies WHERE join_code = ?'),
  insertLobby: db.prepare('INSERT INTO lobbies (name, join_code, owner_id, created_at) VALUES (?, ?, ?, ?)'),
  updateLobby: db.prepare('UPDATE lobbies SET name = ?, scale_label = ?, units_per_px = ?, settings = ? WHERE id = ?'),
  updateMap: db.prepare('UPDATE lobbies SET map_file = ?, map_width = ?, map_height = ? WHERE id = ?'),
  rotateCode: db.prepare('UPDATE lobbies SET join_code = ? WHERE id = ?'),
  deleteLobby: db.prepare('DELETE FROM lobbies WHERE id = ?'),
  insertMember: db.prepare(
    'INSERT OR IGNORE INTO lobby_members (lobby_id, user_id, role, nation, color, joined_at) VALUES (?, ?, ?, ?, ?, ?)'),
  updateMember: db.prepare('UPDATE lobby_members SET role = ?, nation = ?, color = ? WHERE lobby_id = ? AND user_id = ?'),
  deleteMember: db.prepare('DELETE FROM lobby_members WHERE lobby_id = ? AND user_id = ?'),
  memberCount: db.prepare('SELECT COUNT(*) AS n FROM lobby_members WHERE lobby_id = ?'),

  factions: db.prepare('SELECT * FROM factions WHERE lobby_id = ? ORDER BY name COLLATE NOCASE'),
  faction: db.prepare('SELECT * FROM factions WHERE id = ? AND lobby_id = ?'),
  insertFaction: db.prepare('INSERT INTO factions (lobby_id, name, color, flag_file, flag_asset, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  updateFaction: db.prepare('UPDATE factions SET name = ?, color = ?, flag_file = ?, flag_asset = ? WHERE id = ?'),
  deleteFaction: db.prepare('DELETE FROM factions WHERE id = ?'),
  factionFiles: db.prepare('SELECT flag_file FROM factions WHERE lobby_id = ? AND flag_file IS NOT NULL'),
  renameMemberNation: db.prepare('UPDATE lobby_members SET nation = ? WHERE lobby_id = ? AND nation = ? COLLATE NOCASE'),

  markers: db.prepare('SELECT * FROM markers WHERE lobby_id = ? ORDER BY id'),
  marker: db.prepare('SELECT * FROM markers WHERE id = ? AND lobby_id = ?'),
  insertMarker: db.prepare(`
    INSERT INTO markers (id, lobby_id, type, name, x, y, icon_file, icon_url, color, admin_only, visible_to, owner_id, data, created_at, updated_at, locked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateMarker: db.prepare(`
    UPDATE markers SET type = ?, name = ?, x = ?, y = ?, icon_file = ?, icon_url = ?, color = ?, admin_only = ?, visible_to = ?,
      owner_id = ?, data = ?, updated_at = ?, locked = ? WHERE id = ?`),
  moveMarker: db.prepare('UPDATE markers SET x = ?, y = ?, updated_at = ? WHERE id = ?'),
  lockMarker: db.prepare('UPDATE markers SET locked = ?, updated_at = ? WHERE id = ?'),
  lockShape: db.prepare('UPDATE shapes SET locked = ?, updated_at = ? WHERE id = ?'),
  deleteMarker: db.prepare('DELETE FROM markers WHERE id = ?'),
  markerFiles: db.prepare('SELECT icon_file FROM markers WHERE lobby_id = ? AND icon_file IS NOT NULL'),

  shapes: db.prepare('SELECT * FROM shapes WHERE lobby_id = ? ORDER BY id'),
  shape: db.prepare('SELECT * FROM shapes WHERE id = ? AND lobby_id = ?'),
  insertShape: db.prepare(`
    INSERT INTO shapes (id, lobby_id, kind, label, points, color, width, admin_only, visible_to, created_by, created_at, updated_at, locked, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateShape: db.prepare(`
    UPDATE shapes SET kind = ?, label = ?, points = ?, color = ?, width = ?, admin_only = ?, visible_to = ?, updated_at = ?, locked = ?, data = ? WHERE id = ?`),
  deleteShape: db.prepare('DELETE FROM shapes WHERE id = ?'),

  events: db.prepare(`
    SELECT e.*, u.display_name FROM events e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.lobby_id = ? AND e.id > ? ORDER BY e.id DESC LIMIT ?`),
  insertEvent: db.prepare('INSERT INTO events (lobby_id, user_id, kind, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  event: db.prepare('SELECT e.*, u.display_name FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?'),
};

const MARKER_TYPES = ['unit', 'town', 'poi', 'player', 'scenery', 'resource', 'factory'];
const game = require('../game');
const GameData = require('../../public/js/game-data');
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const PALETTE = ['#3498db', '#e74c3c', '#2ecc71', '#9b59b6', '#f1c40f', '#1abc9c', '#e67e22', '#ecf0f1', '#95a5a6', '#d35400'];

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(6)) s += alphabet[b % alphabet.length];
  return s;
}

function clean(s, max) { return String(s ?? '').trim().slice(0, max); }
function num(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function viewerOf(req) { return { role: req.lobbyRole, userId: req.user.id, nation: req.member?.nation || '' }; }

/** Accepts an array or comma-separated string of nation names; returns a JSON string or null. */
function parseVisibleTo(v) {
  if (v === undefined || v === null) return null;
  const list = Array.isArray(v) ? v : String(v).split(',');
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const s = clean(item, 40);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= 20) break;
  }
  return out.length ? JSON.stringify(out) : null;
}

function serializeEvent(e) {
  return {
    id: e.id, kind: e.kind, message: e.message, userId: e.user_id,
    displayName: e.display_name || 'System', data: e.data ? access.safeJson(e.data) : null, createdAt: e.created_at,
  };
}

/** Insert an event and push it to the room (optionally only to sockets passing `filter`). */
function logEvent(lobbyId, userId, kind, message, data = null, filter = null) {
  const id = q.insertEvent.run(lobbyId, userId, kind, message, data ? JSON.stringify(data) : null, now()).lastInsertRowid;
  const ev = serializeEvent(q.event.get(id));
  hub.broadcast(lobbyId, { type: 'event', event: ev }, filter);
  return ev;
}

/** Push lobby settings to everyone in the room; GMs also get the join code. */
function broadcastLobby(lobby) {
  hub.broadcast(lobby.id, { type: 'lobby', lobby: access.serializeLobby(lobby, 'gm') }, ws => ws.lobbyRole === 'gm');
  hub.broadcast(lobby.id, { type: 'lobby', lobby: access.serializeLobby(lobby, 'player') }, ws => ws.lobbyRole !== 'gm');
}

/** Record history and push both the entity change and the history entry to the right viewers. */
function commitChange(req, entity, action, before, after, reverts = null) {
  const entry = hist.record({
    lobbyId: req.lobby.id, userId: req.user.id, entity, entityId: (after || before).id, action, before, after, reverts,
  });
  hub.broadcastEntity(req.lobby.id, entity, before, after, req.user.id);
  hub.broadcastVisible(req.lobby.id, { type: 'history', entry }, after || before);
  return entry;
}

function pickColor(lobbyId) {
  const used = new Set(access.getMembers(lobbyId).map(m => m.color));
  return PALETTE.find(c => !used.has(c)) || PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

// ---- Bundled flags (public/flags) ------------------------------------------------------
router.get('/flags/bundled', (req, res) => {
  res.json({ flags: bundledFlags().map(n => ({ file: n, url: `/flags/${encodeURIComponent(n)}`, name: n.replace(/\.[^.]+$/, '').replace(/([a-z])([A-Z])/g, '$1 $2') })) });
});

// ---- Lobby list / create / join ---------------------------------------------------
router.get('/', (req, res) => {
  const rows = req.user.role === 'admin' ? q.allLobbies.all() : q.myLobbies.all(req.user.id);
  const lobbies = rows.map(l => {
    const out = access.serializeLobby(l, access.getRole(l, req.user));
    out.memberCount = q.memberCount.get(l.id).n;
    return out;
  });
  res.json({ lobbies });
});

router.post('/', (req, res) => {
  const name = clean(req.body?.name, 60);
  if (!name) return res.status(400).json({ error: 'Campaign needs a name' });
  let id;
  for (let tries = 0; ; tries++) {
    try { id = q.insertLobby.run(name, genCode(), req.user.id, now()).lastInsertRowid; break; }
    catch (e) { if (!/UNIQUE/.test(String(e.message)) || tries >= 4) throw e; }
  }
  q.insertMember.run(id, req.user.id, 'gm', '', '#e67e22', now());
  logEvent(id, req.user.id, 'system', `${req.user.displayName} created the campaign`);
  res.status(201).json({ lobby: access.serializeLobby(access.getLobby(id), 'gm') });
});

router.post('/join', (req, res) => {
  const code = clean(req.body?.code, 12).toUpperCase();
  const lobby = q.byCode.get(code);
  if (!lobby) return res.status(404).json({ error: 'No campaign with that join code' });
  if (!access.getMember(lobby.id, req.user.id)) {
    q.insertMember.run(lobby.id, req.user.id, 'player', '', pickColor(lobby.id), now());
    logEvent(lobby.id, req.user.id, 'system', `${req.user.displayName} joined the campaign`);
    hub.broadcast(lobby.id, { type: 'members' });
  }
  res.json({ lobby: access.serializeLobby(lobby, access.getRole(lobby, req.user)) });
});

// ---- Per-lobby middleware -----------------------------------------------------------
router.param('id', (req, res, next, id) => {
  const lobby = access.getLobby(id);
  if (!lobby) return res.status(404).json({ error: 'No such campaign' });
  const role = access.getRole(lobby, req.user);
  if (!role) return res.status(403).json({ error: 'You are not a member of this campaign' });
  req.lobby = lobby; req.lobbyRole = role; req.member = access.getMember(lobby.id, req.user.id);
  next();
});

function requireGm(req, res, next) {
  if (req.lobbyRole !== 'gm') return res.status(403).json({ error: 'Game master only' });
  next();
}

// ---- Game layer hooks ----------------------------------------------------------------------------
/** Change a marker's faction (territory ownership), recording history and broadcasting like any edit. */
function setMarkerNation(req, before, nation) {
  const data = { ...before.data, nation };
  q.updateMarker.run(before.type, before.name, before.x, before.y, before.iconFile, before.iconFile ? null : before.iconUrl, before.color,
    before.adminOnly ? 1 : 0, before.visibleTo ? JSON.stringify(before.visibleTo) : null, before.ownerId, JSON.stringify(data), now(), before.locked ? 1 : 0, before.id);
  const after = access.serializeMarker(q.marker.get(before.id, req.lobby.id));
  commitChange(req, 'marker', 'update', before, after);
  return after;
}
function shapeById(req, id) { const row = q.shape.get(id, req.lobby.id); return row ? access.serializeShape(row) : null; }

/**
 * After a committed move: if game mode is on and the unit is a land unit standing on enemy or neutral
 * ground, carve territory (docs/GAME-DESIGN.md §5.2) and flip the places inside. Returns a note or null.
 */
function afterMove(req, unit) {
  const g = game.get(req.lobby.id);
  if (!g.enabled || unit.type !== 'unit') return null;
  const factions = q.factions.all(req.lobby.id).map(access.serializeFaction);
  const markers = q.markers.all(req.lobby.id).map(access.serializeMarker);
  const territory = require('../territory');
  let r;
  try { r = territory.capture(req.lobby, g, unit, factions, markers, (a, b) => game.relationStatus(req.lobby.id, a, b)); }
  catch (e) { console.warn('capture failed', e); return null; }
  if (!r) return null;
  if (r.held) return `${unit.name} faces enemy troops: the front holds`;
  for (const f of r.flips) setMarkerNation(req, f.marker, f.nation);
  if (r.changed.length) hub.broadcast(req.lobby.id, { type: 'territory', territories: r.changed });
  const ownerName = r.owner === territory.NEUTRAL ? 'neutral' : (factions.find(f => f.id === r.owner)?.name || 'enemy');
  const what = r.cities.length ? `takes ${r.cities.join(', ')} and the surrounding ${ownerName} territory` : `advances into ${ownerName} territory`;
  logEvent(req.lobby.id, req.user.id, 'system', `${unit.name} (${r.mine.name}) ${what}`);
  return r.cities.length ? `${unit.name} takes ${r.cities.join(', ')}!` : null;
}

// Game layer (turns, treasuries, territories, diplomacy): routes/game.js, sharing this router's lobby middleware.
router.use('/:id/game', require('./game')({ logEvent, clean, num, clamp, setMarkerNation, shapeById }));

router.get('/:id', (req, res) => {
  const online = new Set(hub.presence(req.lobby.id).map(u => u.id));
  const members = access.getMembers(req.lobby.id).map(m => ({ ...access.serializeMember(m), online: online.has(m.user_id) }));
  res.json({
    lobby: access.serializeLobby(req.lobby, req.lobbyRole),
    members,
    you: {
      id: req.user.id, displayName: req.user.displayName, role: req.lobbyRole,
      member: members.find(m => m.userId === req.user.id) || null,
    },
  });
});

router.patch('/:id', requireGm, (req, res) => {
  const b = req.body || {};
  const name = b.name !== undefined ? clean(b.name, 60) : req.lobby.name;
  if (!name) return res.status(400).json({ error: 'Campaign needs a name' });
  const scaleLabel = b.scaleLabel !== undefined ? (clean(b.scaleLabel, 12) || 'km') : req.lobby.scale_label;
  const upp = b.unitsPerPx !== undefined ? num(b.unitsPerPx, 1) : req.lobby.units_per_px;
  if (!(upp > 0)) return res.status(400).json({ error: 'Scale must be a positive number' });
  const settings = access.safeJson(req.lobby.settings);
  if (b.settings && typeof b.settings === 'object') {
    if (b.settings.tokenScale !== undefined) settings.tokenScale = clamp(num(b.settings.tokenScale, 1), 0.5, 3);
    if (b.settings.tokenMode !== undefined) settings.tokenMode = b.settings.tokenMode === 'screen' ? 'screen' : 'map';
    if (b.settings.combat && typeof b.settings.combat === 'object') {
      const c = b.settings.combat;
      settings.combat = {
        die: clamp(Math.round(num(c.die, 20)), 2, 100),
        baseLoss: clamp(num(c.baseLoss, 10), 0, 100),
        marginMult: clamp(num(c.marginMult, 2), 0, 20),
        winnerLoss: clamp(num(c.winnerLoss, 5), 0, 100),
      };
    }
    // Per-campaign unit stat overrides: { typeId: [attack, defend, ap, range, movement] }. A null entry
    // removes that type's override (back to the catalogue); an empty object clears them all.
    if (b.settings.unitStats !== undefined) {
      const src = b.settings.unitStats;
      if (src === null) delete settings.unitStats;
      else if (typeof src === 'object') {
        const out = b.settings.replaceUnitStats ? {} : { ...(settings.unitStats || {}) };
        for (const [key, val] of Object.entries(src).slice(0, 200)) {
          if (!/^[a-z0-9_-]{1,40}$/.test(key)) continue;
          if (val === null) { delete out[key]; continue; }
          if (!Array.isArray(val) || val.length !== 5) continue;
          out[key] = val.map(v => clamp(Math.round(num(v, 0) * 10) / 10, -99, 999));
        }
        if (Object.keys(out).length) settings.unitStats = out; else delete settings.unitStats;
      }
    }
  }
  q.updateLobby.run(name, scaleLabel, upp, JSON.stringify(settings), req.lobby.id);
  const lobby = access.getLobby(req.lobby.id);
  broadcastLobby(lobby);
  res.json({ lobby: access.serializeLobby(lobby, req.lobbyRole) });
});

router.post('/:id/code', requireGm, (req, res) => {
  const code = genCode();
  q.rotateCode.run(code, req.lobby.id);
  broadcastLobby(access.getLobby(req.lobby.id));
  res.json({ joinCode: code });
});

router.post('/:id/map', requireGm, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a PNG, JPEG, WebP or GIF image' });
  let size = null;
  try { size = imageSize(req.file.path); } catch { /* fall through */ }
  const width = size?.width || num(req.body?.width);
  const height = size?.height || num(req.body?.height);
  if (!(width > 0 && height > 0)) {
    removeUpload(req.file.filename);
    return res.status(400).json({ error: 'Could not read image dimensions' });
  }
  const old = req.lobby.map_file;
  q.updateMap.run(req.file.filename, width, height, req.lobby.id);
  if (old && old !== req.file.filename) removeUpload(old);
  // An uploaded image replaces a generated Earth map.
  const settings = access.safeJson(req.lobby.settings);
  if (settings.earth) {
    delete settings.earth; delete settings.projection;
    q.updateLobby.run(req.lobby.name, req.lobby.scale_label, req.lobby.units_per_px, JSON.stringify(settings), req.lobby.id);
  }
  const lobby = access.getLobby(req.lobby.id);
  logEvent(lobby.id, req.user.id, 'system', `${req.user.displayName} changed the map image`);
  broadcastLobby(lobby);
  res.json({ lobby: access.serializeLobby(lobby, req.lobbyRole) });
});

/** Years of historical borders bundled in public/earth (world_<year>.json.gz). */
function earthYears() {
  try { return JSON.parse(fs.readFileSync(path.join(config.root, 'public', 'earth', 'index.json'), 'utf8')).years || []; }
  catch { return []; }
}
router.get('/earth/years', (req, res) => res.json({ years: earthYears() }));

const zlib = require('node:zlib');
const worldCache = new Map();
function loadWorld(year) {
  year = Number(year);
  if (!earthYears().includes(year)) return null;
  if (!worldCache.has(year)) {
    const gz = fs.readFileSync(path.join(config.root, 'public', 'earth', `world_${year}.json.gz`));
    worldCache.set(year, JSON.parse(zlib.gunzipSync(gz).toString('utf8')));
  }
  return worldCache.get(year);
}

/** Same stable pastel tint the client uses for a power's territory (earth.js tintFor). */
function tintHex(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360, sat = 0.55, light = 0.6;
  const c = (1 - Math.abs(2 * light - 1)) * sat, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = light - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
// Bundled flag file name → the powers it stands for, when the file name alone is not enough to guess.
const FLAG_ALIASES = {
  ahemp: ['austriahungary', 'austrohungarianempire', 'austrianempire'],
  ruemp: ['russianempire', 'russia'],
  britishempire: ['unitedkingdomofgreatbritainandireland', 'unitedkingdom', 'britishempire', 'greatbritain'],
  kingitaly: ['kingdomofitaly', 'italy'],
  us: ['unitedstates', 'unitedstatesofamerica'],
  germanempire: ['germanempire', 'germany'],
  repspain: ['spanishrepublic', 'republicofspain'],
  ussr: ['sovietunion', 'ussr', 'unionofsovietsocialistrepublics'],
};

/** Best bundled flag for a power name: alias table first, then all name tokens contained in the power name. */
function matchFlag(power, flags) {
  const n = norm(power);
  for (const f of flags) {
    const base = f.replace(/\.[^.]+$/, '');
    const aliases = FLAG_ALIASES[base.toLowerCase()] || [];
    if (aliases.includes(n)) return f;
  }
  let best = null, bestLen = 0;
  for (const f of flags) {
    const base = f.replace(/\.[^.]+$/, '');
    if (FLAG_ALIASES[base.toLowerCase()]) continue;
    const tokens = base.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(t => t.length >= 3);
    if (tokens.length && tokens.every(t => n.includes(t))) {
      const len = tokens.join('').length;
      if (len > bestLen) { best = f; bestLen = len; }
    }
  }
  return best;
}

/** The sovereign powers of a year, with a suggested colour and flag, and whether the faction already exists. */
router.get('/:id/factions/seed-preview', requireGm, (req, res) => {
  const world = loadWorld(req.query.year);
  if (!world) return res.status(400).json({ error: 'No borders bundled for that year' });
  const flags = bundledFlags();
  const existing = new Set(q.factions.all(req.lobby.id).map(f => f.name.toLowerCase()));
  const powers = new Map();
  for (const c of world.countries) {
    const power = c.s || c.n;
    if (!power) continue;
    if (!powers.has(power)) powers.set(power, { name: power, territories: 0 });
    powers.get(power).territories++;
  }
  const list = [...powers.values()].sort((a, b) => a.name.localeCompare(b.name)).map(p => ({
    ...p, color: tintHex(p.name), flagAsset: matchFlag(p.name, flags), exists: existing.has(p.name.toLowerCase()),
  }));
  res.json({ year: world.year, powers: list });
});

/** Create factions for the chosen powers (names from the preview), skipping ones that exist. */
router.post('/:id/factions/seed', requireGm, (req, res) => {
  const world = loadWorld(req.body?.year);
  if (!world) return res.status(400).json({ error: 'No borders bundled for that year' });
  const wanted = new Set((Array.isArray(req.body?.names) ? req.body.names : []).map(n => String(n)));
  const flags = bundledFlags();
  const existing = new Set(q.factions.all(req.lobby.id).map(f => f.name.toLowerCase()));
  const powers = new Set(world.countries.map(c => c.s || c.n).filter(Boolean));
  const created = [];
  for (const power of powers) {
    if (!wanted.has(power) || existing.has(power.toLowerCase())) continue;
    const overrides = (req.body?.flags && typeof req.body.flags === 'object') ? req.body.flags[power] : undefined;
    const asset = overrides !== undefined ? factionFlagAsset(overrides) : matchFlag(power, flags);
    try {
      const id = q.insertFaction.run(req.lobby.id, power.slice(0, 60), tintHex(power), null, asset || null, now()).lastInsertRowid;
      created.push(access.serializeFaction(q.faction.get(id, req.lobby.id)));
    } catch { /* duplicate after truncation: skip */ }
  }
  if (created.length) hub.broadcast(req.lobby.id, { type: 'factions' });
  res.status(201).json({ created });
});

// ---- Borders → editable drawings -------------------------------------------------------------
function simplify(pts, tol) {
  // Douglas–Peucker on [x,y] pairs (closed ring treated as open; first == last is fine).
  if (pts.length <= 3) return pts;
  const sq = tol * tol;
  const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (!len2) d = (px - ax) ** 2 + (py - ay) ** 2;
      else { const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)); d = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2; }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > sq && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function ringArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]; }
  return Math.abs(a) / 2;
}

/**
 * Convert a year's borders into locked area drawings (one per country polygon) so they can be edited.
 * Body: { year, bbox?: [minLon, minLat, maxLon, maxLat], maxPoints?, hideLayer? }
 */
router.post('/:id/shapes/import-borders', requireGm, (req, res) => {
  const b = req.body || {};
  const world = loadWorld(b.year);
  if (!world) return res.status(400).json({ error: 'No borders bundled for that year' });
  const settings = access.safeJson(req.lobby.settings);
  if (!settings.earth) return res.status(400).json({ error: 'Switch the campaign to the Earth map first' });
  const W = req.lobby.map_width, H = req.lobby.map_height;
  const project = ([lon, lat]) => [(lon + 180) / 360 * W, (90 - lat) / 180 * H];
  const bbox = Array.isArray(b.bbox) && b.bbox.length === 4 ? b.bbox.map(Number) : null;
  const maxPoints = clamp(num(b.maxPoints, 300), 30, 500);
  const minArea = (W / 400) ** 2;   // skip specks smaller than ~1/400 of the map width squared
  const existing = new Set(q.shapes.all(req.lobby.id).map(s => s.label.toLowerCase()));
  const created = [];
  const t0 = now();
  for (const c of world.countries) {
    const power = c.s || c.n;
    const color = tintHex(power);
    const polys = c.p.map(poly => poly[0]);   // outer rings only
    if (bbox) {
      const inView = polys.some(r => r.some(([lon, lat]) => lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]));
      if (!inView) continue;
    }
    const projected = polys.map(r => r.map(project)).map(r => ({ r, area: ringArea(r) })).sort((a, b) => b.area - a.area);
    let n = 0;
    for (const { r, area } of projected) {
      if (n > 0 && area < minArea) continue;         // always keep the main polygon, drop small islands
      if (n >= 6) break;                             // at most six pieces per country
      let pts = r, tol = W / 4000;
      while (pts.length > maxPoints) { pts = simplify(r, tol); tol *= 1.6; }
      if (pts.length < 3) continue;
      const label = n === 0 ? c.n : `${c.n} (${n + 1})`;
      if (existing.has(label.toLowerCase())) { n++; continue; }
      const points = pts.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
      const id = q.insertShape.run(null, req.lobby.id, 'area', label.slice(0, 60), JSON.stringify(points), color, 2, 0, null, req.user.id, t0, t0, 1, null).lastInsertRowid;
      const shape = access.serializeShape(q.shape.get(id, req.lobby.id));
      commitChange(req, 'shape', 'create', null, shape);
      created.push(shape.id);
      n++;
    }
  }
  if (b.hideLayer !== false && settings.earth.borders !== 'none') {
    settings.earth = { ...settings.earth, borders: 'none' };
    q.updateLobby.run(req.lobby.name, req.lobby.scale_label, req.lobby.units_per_px, JSON.stringify(settings), req.lobby.id);
    broadcastLobby(access.getLobby(req.lobby.id));
  }
  logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} imported ${created.length} borders of ${world.year} as drawings`);
  res.status(201).json({ created: created.length });
});

/** Switch the campaign to the bundled vector Earth map (equirectangular, W × W/2 pixels). */
router.post('/:id/map/earth', requireGm, (req, res) => {
  const b = req.body || {};
  const width = [4096, 8192, 16384, 32768].includes(Number(b.width)) ? Number(b.width) : 8192;
  const height = width / 2;
  let borders = String(b.borders ?? (b.showBorders ? 'modern' : 'none'));
  if (borders !== 'none' && borders !== 'modern' && !earthYears().includes(Number(borders))) borders = 'none';
  const earth = {
    width, height,
    style: ['atlas', 'parchment', 'dark'].includes(b.style) ? b.style : 'atlas',
    showRivers: b.showRivers !== false,
    showLakes: b.showLakes !== false,
    borders,
    tint: b.tint !== false,
    labels: b.labels !== false,
    showGraticule: !!b.showGraticule,
  };
  const settings = { ...access.safeJson(req.lobby.settings), earth, projection: 'equirect' };
  const old = req.lobby.map_file;
  q.updateMap.run(null, width, height, req.lobby.id);
  // Equator scale: 40075 km around the globe = `width` px. The measure tool uses true great-circle distances.
  q.updateLobby.run(req.lobby.name, 'km', 40075.017 / width, JSON.stringify(settings), req.lobby.id);
  if (old) removeUpload(old);
  const lobby = access.getLobby(req.lobby.id);
  logEvent(lobby.id, req.user.id, 'system', `${req.user.displayName} switched to the Earth map`);
  broadcastLobby(lobby);
  res.json({ lobby: access.serializeLobby(lobby, req.lobbyRole) });
});

router.delete('/:id', (req, res) => {
  if (req.lobby.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the owner can delete a campaign' });
  }
  const files = [...q.markerFiles.all(req.lobby.id).map(r => r.icon_file), ...q.factionFiles.all(req.lobby.id).map(r => r.flag_file)];
  q.deleteLobby.run(req.lobby.id);
  removeUpload(req.lobby.map_file);
  files.forEach(removeUpload);
  hub.broadcast(req.lobby.id, { type: 'kicked', lobbyId: req.lobby.id });
  res.json({ ok: true });
});

// ---- Factions (name, colour, flag) -----------------------------------------------------------
router.get('/:id/factions', (req, res) => {
  res.json({ factions: q.factions.all(req.lobby.id).map(access.serializeFaction) });
});

function factionFlagAsset(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const name = path.basename(String(v));
  return bundledFlags().includes(name) ? name : undefined;
}

router.post('/:id/factions', requireGm, (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 60);
  if (!name) return res.status(400).json({ error: 'Faction needs a name' });
  const color = COLOR_RE.test(b.color || '') ? b.color : PALETTE[q.factions.all(req.lobby.id).length % PALETTE.length];
  const asset = factionFlagAsset(b.flagAsset);
  if (b.flagAsset && asset === undefined) return res.status(400).json({ error: 'Unknown bundled flag' });
  let id;
  try { id = q.insertFaction.run(req.lobby.id, name, color, null, asset || null, now()).lastInsertRowid; }
  catch (e) { if (/UNIQUE/.test(String(e.message))) return res.status(409).json({ error: 'A faction with that name already exists' }); throw e; }
  hub.broadcast(req.lobby.id, { type: 'factions' });
  res.status(201).json({ faction: access.serializeFaction(q.faction.get(id, req.lobby.id)) });
});

/** Rename cascades to members and markers so visibility and grouping keep working. */
function renameNation(lobbyId, from, to) {
  q.renameMemberNation.run(to, lobbyId, from);
  for (const row of q.markers.all(lobbyId)) {
    const d = access.safeJson(row.data);
    if (typeof d.nation === 'string' && d.nation.toLowerCase() === from.toLowerCase()) {
      d.nation = to;
      db.prepare('UPDATE markers SET data = ? WHERE id = ?').run(JSON.stringify(d), row.id);
    }
  }
}

router.patch('/:id/factions/:fid', requireGm, (req, res) => {
  const row = q.faction.get(Number(req.params.fid), req.lobby.id);
  if (!row) return res.status(404).json({ error: 'No such faction' });
  const b = req.body || {};
  const name = b.name !== undefined ? clean(b.name, 60) : row.name;
  if (!name) return res.status(400).json({ error: 'Faction needs a name' });
  const color = b.color !== undefined && COLOR_RE.test(b.color) ? b.color : row.color;
  let flagFile = row.flag_file, flagAsset = row.flag_asset;
  if (b.flagAsset !== undefined) {
    const asset = factionFlagAsset(b.flagAsset);
    if (b.flagAsset && asset === undefined) return res.status(400).json({ error: 'Unknown bundled flag' });
    if (flagFile) removeUpload(flagFile);
    flagFile = null; flagAsset = asset;
  }
  try { q.updateFaction.run(name, color, flagFile, flagAsset, row.id); }
  catch (e) { if (/UNIQUE/.test(String(e.message))) return res.status(409).json({ error: 'A faction with that name already exists' }); throw e; }
  if (name !== row.name) renameNation(req.lobby.id, row.name, name);
  hub.refreshRoles(req.lobby.id);
  hub.broadcast(req.lobby.id, { type: 'factions' });
  res.json({ faction: access.serializeFaction(q.faction.get(row.id, req.lobby.id)) });
});

router.post('/:id/factions/:fid/flag', requireGm, uploadSmall.single('file'), (req, res) => {
  const row = q.faction.get(Number(req.params.fid), req.lobby.id);
  if (!row) { removeUpload(req.file?.filename); return res.status(404).json({ error: 'No such faction' }); }
  if (!req.file) return res.status(400).json({ error: 'Upload a PNG, JPEG, WebP or GIF image (max 5 MB)' });
  if (row.flag_file) removeUpload(row.flag_file);
  q.updateFaction.run(row.name, row.color, req.file.filename, null, row.id);
  hub.broadcast(req.lobby.id, { type: 'factions' });
  res.json({ faction: access.serializeFaction(q.faction.get(row.id, req.lobby.id)) });
});

router.delete('/:id/factions/:fid', requireGm, (req, res) => {
  const row = q.faction.get(Number(req.params.fid), req.lobby.id);
  if (!row) return res.status(404).json({ error: 'No such faction' });
  q.deleteFaction.run(row.id);
  removeUpload(row.flag_file);
  hub.broadcast(req.lobby.id, { type: 'factions' });
  res.json({ ok: true });
});

// ---- Members -----------------------------------------------------------------------
router.patch('/:id/members/:userId', requireGm, (req, res) => {
  const userId = Number(req.params.userId);
  const m = access.getMember(req.lobby.id, userId);
  if (!m) return res.status(404).json({ error: 'Not a member' });
  const b = req.body || {};
  const role = b.role !== undefined ? b.role : m.role;
  if (!['gm', 'player'].includes(role)) return res.status(400).json({ error: 'Bad role' });
  if (userId === req.lobby.owner_id && role !== 'gm') return res.status(400).json({ error: 'The owner is always a GM' });
  const nation = b.nation !== undefined ? clean(b.nation, 40) : m.nation;
  const color = b.color !== undefined && COLOR_RE.test(b.color) ? b.color : m.color;
  q.updateMember.run(role, nation, color, req.lobby.id, userId);
  hub.refreshRoles(req.lobby.id);
  hub.broadcast(req.lobby.id, { type: 'members' });
  res.json({ ok: true });
});

router.delete('/:id/members/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  const self = userId === req.user.id;
  if (!self && req.lobbyRole !== 'gm') return res.status(403).json({ error: 'Game master only' });
  if (userId === req.lobby.owner_id) return res.status(400).json({ error: 'The owner cannot leave; delete the campaign instead' });
  q.deleteMember.run(req.lobby.id, userId);
  logEvent(req.lobby.id, req.user.id, 'system',
    self ? `${req.user.displayName} left the campaign` : `${req.user.displayName} removed a member`);
  hub.refreshRoles(req.lobby.id);
  hub.broadcast(req.lobby.id, { type: 'members' });
  res.json({ ok: true });
});

// ---- Markers ---------------------------------------------------------------------------
router.get('/:id/markers', (req, res) => {
  const v = viewerOf(req);
  res.json({ markers: q.markers.all(req.lobby.id).map(access.serializeMarker).filter(m => access.canSee(m, v)) });
});

function canEditMarker(req, m) {
  if (req.lobbyRole === 'gm') return true;
  return m.ownerId === req.user.id && !m.adminOnly;
}

function sanitizeData(type, data) {
  const d = (data && typeof data === 'object') ? data : {};
  const out = { notes: clean(d.notes, 2000) };
  if (type === 'unit') {
    Object.assign(out, {
      nation: clean(d.nation, 40), unitType: clean(d.unitType, 40),
      attack: num(d.attack), defend: num(d.defend), ap: num(d.ap), range: num(d.range), movement: num(d.movement),
      abilities: Array.isArray(d.abilities) ? d.abilities.map(a => clean(a, 80)).filter(Boolean).slice(0, 6) : [],
      strength: clamp(num(d.strength, 100), 0, 100),
      movedKm: Math.max(0, num(d.movedKm)), apUsed: Math.max(0, num(d.apUsed)),   // game mode: used this turn
    });
  } else if (type === 'resource') {
    out.kind = GameData.byKey[d.kind] ? d.kind : 'grain';
    out.yield = clamp(num(d.yield, 1), 0, 50);
    out.nation = clean(d.nation, 60);
  } else if (type === 'factory') {
    out.nation = clean(d.nation, 60);
    out.industry = clamp(Math.round(num(d.industry, 1)), 1, 5);
  } else if (type === 'town') {
    out.size = ['capital', 'city', 'village'].includes(d.size) ? d.size : 'village';
    out.nation = clean(d.nation, 40);
  } else if (type === 'poi') {
    out.category = clean(d.category, 40);
  } else if (type === 'scenery') {
    // Scenery is drawn at map scale: `scale` = map pixels per sprite pixel.
    out.scale = clamp(num(d.scale, 1), 0.05, 50);
    out.rotation = ((num(d.rotation, 0) % 360) + 360) % 360;
    out.flip = !!d.flip;
  }
  return out;
}

function inBounds(req, x, y) {
  const w = req.lobby.map_width || 1e9, h = req.lobby.map_height || 1e9;
  return x >= -w * 0.25 && x <= w * 1.25 && y >= -h * 0.25 && y <= h * 1.25;
}

/** Look a marker up, serialized, and check the caller can see it at all. */
function loadMarker(req, res) {
  const row = q.marker.get(Number(req.params.mid), req.lobby.id);
  const m = row && access.serializeMarker(row);
  if (!m || !access.canSee(m, viewerOf(req))) { res.status(404).json({ error: 'No such marker' }); return null; }
  return m;
}

router.post('/:id/markers', (req, res) => {
  const b = req.body || {};
  const isGm = req.lobbyRole === 'gm';
  const type = MARKER_TYPES.includes(b.type) ? b.type : null;
  if (!type) return res.status(400).json({ error: 'Bad marker type' });
  if (!isGm && type !== 'player') return res.status(403).json({ error: 'Players can only add their own player marker' });
  let name = clean(b.name, 60) || (type === 'scenery' ? 'Scenery' : '');
  if (!name && type === 'unit' && b.autoName) {
    // Quick add: "<ordinal> <formation>", numbered per faction and formation, ordinal style from the faction name.
    const d = (b.data && typeof b.data === 'object') ? b.data : {};
    const ut = UnitTypes.resolve(d.unitType);
    const formation = ut ? ut.unit : (clean(d.unitType, 40) || 'Unit');
    const nation = clean(d.nation, 60).toLowerCase();
    const names = q.markers.all(req.lobby.id)
      .filter(m => m.type === 'unit' && clean(access.safeJson(m.data).nation, 60).toLowerCase() === nation)
      .map(m => m.name);
    name = Naming.nextName(names, formation, nation);
    // Fill any stats the client left out from the campaign's stat table.
    const defaults = ut ? UnitTypes.defaults(ut, access.safeJson(req.lobby.settings).unitStats) : null;
    if (defaults) for (const k of UnitTypes.STAT_KEYS) if (d[k] === undefined || d[k] === '') d[k] = defaults[k];
    b.data = d;
  }
  if (!name) return res.status(400).json({ error: 'Marker needs a name' });
  const x = num(b.x), y = num(b.y);
  if (!inBounds(req, x, y)) return res.status(400).json({ error: 'Position is off the map' });
  const color = COLOR_RE.test(b.color || '') ? b.color : (req.member?.color || '#3498db');
  const adminOnly = isGm && b.adminOnly ? 1 : 0;
  const visibleTo = isGm ? parseVisibleTo(b.visibleTo) : null;
  const ownerId = isGm ? (b.ownerId ? num(b.ownerId, null) : null) : req.user.id;
  const iconUrl = clean(b.iconUrl, 500) || null;
  // Towns, POIs and scenery start locked (they rarely move); units and players start unlocked.
  const locked = b.locked !== undefined ? (b.locked ? 1 : 0) : (['town', 'poi', 'scenery', 'resource', 'factory'].includes(type) ? 1 : 0);
  const t = now();
  const id = q.insertMarker.run(null, req.lobby.id, type, name, x, y, null, iconUrl, color, adminOnly, visibleTo, ownerId,
    JSON.stringify(sanitizeData(type, b.data)), t, t, locked).lastInsertRowid;
  const marker = access.serializeMarker(q.marker.get(id, req.lobby.id));
  commitChange(req, 'marker', 'create', null, marker);
  if (!adminOnly && !visibleTo && type !== 'scenery') logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} placed ${name}`);
  res.status(201).json({ marker });
});

router.patch('/:id/markers/:mid', (req, res) => {
  const before = loadMarker(req, res);
  if (!before) return;
  if (!canEditMarker(req, before)) return res.status(403).json({ error: 'You cannot edit that marker' });
  const b = req.body || {};
  const isGm = req.lobbyRole === 'gm';
  const type = isGm && MARKER_TYPES.includes(b.type) ? b.type : before.type;
  const name = (b.name !== undefined ? clean(b.name, 60) : before.name) || (type === 'scenery' ? 'Scenery' : '');
  if (!name) return res.status(400).json({ error: 'Marker needs a name' });
  let x = b.x !== undefined ? num(b.x, before.x) : before.x;
  let y = b.y !== undefined ? num(b.y, before.y) : before.y;
  if (!inBounds(req, x, y)) return res.status(400).json({ error: 'Position is off the map' });
  if (before.locked && (x !== before.x || y !== before.y) && b.locked !== false) {
    return res.status(409).json({ error: `${before.name} is locked; unlock it first` });
  }
  // Game mode: players move within their allowance and cannot rewrite their units' stats.
  const g = game.get(req.lobby.id);
  let clampNote = null;
  if (b.data && typeof b.data === 'object' && g.enabled && !isGm && before.type === 'unit') {
    for (const k of game.PROTECTED_UNIT_FIELDS) delete b.data[k];
  }
  if (x !== before.x || y !== before.y) {
    const mv = game.checkMove(req.lobby, g, isGm, before, x, y);
    if (mv.error) return res.status(409).json({ error: mv.error });
    x = mv.x; y = mv.y;
    if (mv.movedKm !== undefined) b.data = { ...(b.data || {}), movedKm: mv.movedKm };
    if (mv.clamped) clampNote = `${before.name} could only move ${Math.round(mv.remaining)} of ${mv.dist} this turn`;
  }
  let iconFile = before.iconFile;
  let iconUrl = iconFile ? null : before.iconUrl;
  if (b.iconUrl !== undefined) {
    const u = clean(b.iconUrl, 500) || null;
    if (u && u !== before.iconUrl) { iconUrl = u; iconFile = null; }      // external URL replaces the upload
    else if (!u && !iconFile) iconUrl = null;
  }
  const color = b.color !== undefined && COLOR_RE.test(b.color) ? b.color : before.color;
  const adminOnly = isGm && b.adminOnly !== undefined ? (b.adminOnly ? 1 : 0) : (before.adminOnly ? 1 : 0);
  const visibleTo = isGm && b.visibleTo !== undefined ? parseVisibleTo(b.visibleTo) : (before.visibleTo ? JSON.stringify(before.visibleTo) : null);
  const ownerId = isGm && b.ownerId !== undefined ? (b.ownerId ? num(b.ownerId, null) : null) : before.ownerId;
  const data = b.data !== undefined ? sanitizeData(type, { ...before.data, ...b.data }) : sanitizeData(type, before.data);
  const locked = b.locked !== undefined ? (b.locked ? 1 : 0) : (before.locked ? 1 : 0);
  q.updateMarker.run(type, name, x, y, iconFile, iconUrl, color, adminOnly, visibleTo, ownerId, JSON.stringify(data), now(), locked, before.id);
  const after = access.serializeMarker(q.marker.get(before.id, req.lobby.id));
  commitChange(req, 'marker', 'update', before, after);
  const captureNote = (x !== before.x || y !== before.y) ? afterMove(req, after) : null;
  res.json({ marker: after, note: [clampNote, captureNote].filter(Boolean).join(' · ') || null });
});

/** Move several markers at once (group drag). Each move is validated and recorded individually. */
router.post('/:id/markers/move', (req, res) => {
  const moves = Array.isArray(req.body?.moves) ? req.body.moves.slice(0, 200) : [];
  const v = viewerOf(req);
  const g = game.get(req.lobby.id);
  const isGm = req.lobbyRole === 'gm';
  const out = [], errors = [], plan = [];
  for (const mv of moves) {
    const row = q.marker.get(Number(mv.id), req.lobby.id);
    const before = row && access.serializeMarker(row);
    if (!before || !access.canSee(before, v)) { errors.push(`${mv.id}: not found`); continue; }
    if (!canEditMarker(req, before) || before.locked) { errors.push(`${before.name}: not movable`); continue; }
    const x = num(mv.x, before.x), y = num(mv.y, before.y);
    if (!inBounds(req, x, y)) { errors.push(`${before.name}: off the map`); continue; }
    if (x === before.x && y === before.y) { out.push(before); continue; }
    const chk = game.checkMove(req.lobby, g, isGm, before, x, y);
    if (chk.error) { errors.push(chk.error); continue; }
    plan.push({ before, x, y, chk });
  }
  // A formation moves as one: if any unit would be clamped, scale every move by the slowest unit's fraction.
  let t = 1;
  for (const p of plan) if (p.chk.clamped) t = Math.min(t, p.chk.remaining / p.chk.dist);
  if (t < 1) errors.push(`Formation moved ${Math.round(t * 100)}% of the way: the slowest unit ran out of movement`);
  for (const p of plan) {
    const x = t < 1 ? Math.round((p.before.x + (p.x - p.before.x) * t) * 10) / 10 : p.x;
    const y = t < 1 ? Math.round((p.before.y + (p.y - p.before.y) * t) * 10) / 10 : p.y;
    if (p.chk.movedKm !== undefined) {
      const used = num(p.before.data.movedKm), dist = geo.distance(req.lobby, p.before.x, p.before.y, x, y);
      const data = { ...p.before.data, movedKm: Math.round((used + dist) * 10) / 10 };
      q.updateMarker.run(p.before.type, p.before.name, x, y, p.before.iconFile, p.before.iconFile ? null : p.before.iconUrl, p.before.color,
        p.before.adminOnly ? 1 : 0, p.before.visibleTo ? JSON.stringify(p.before.visibleTo) : null, p.before.ownerId, JSON.stringify(data), now(), p.before.locked ? 1 : 0, p.before.id);
    } else q.moveMarker.run(x, y, now(), p.before.id);
    const after = access.serializeMarker(q.marker.get(p.before.id, req.lobby.id));
    commitChange(req, 'marker', 'update', p.before, after);
    out.push(after);
  }
  const notes = out.map(m => afterMove(req, m)).filter(Boolean);
  res.json({ markers: out, errors, note: notes.join(' · ') || null });
});

/** Lock or unlock many markers and/or drawings at once. */
router.post('/:id/lock', (req, res) => {
  const locked = req.body?.locked ? 1 : 0;
  const markerIds = Array.isArray(req.body?.markerIds) ? req.body.markerIds.slice(0, 500) : [];
  const shapeIds = Array.isArray(req.body?.shapeIds) ? req.body.shapeIds.slice(0, 500) : [];
  const v = viewerOf(req);
  let changed = 0;
  for (const id of markerIds) {
    const row = q.marker.get(Number(id), req.lobby.id);
    const before = row && access.serializeMarker(row);
    if (!before || !access.canSee(before, v) || !canEditMarker(req, before) || before.locked === !!locked) continue;
    q.lockMarker.run(locked, now(), before.id);
    commitChange(req, 'marker', 'update', before, access.serializeMarker(q.marker.get(before.id, req.lobby.id)));
    changed++;
  }
  for (const id of shapeIds) {
    const row = q.shape.get(Number(id), req.lobby.id);
    const before = row && access.serializeShape(row);
    if (!before || !access.canSee(before, v) || !canEditShape(req, before) || before.locked === !!locked) continue;
    q.lockShape.run(locked, now(), before.id);
    commitChange(req, 'shape', 'update', before, access.serializeShape(q.shape.get(before.id, req.lobby.id)));
    changed++;
  }
  res.json({ changed });
});

router.post('/:id/markers/:mid/icon', uploadSmall.single('file'), (req, res) => {
  const before = loadMarker(req, res);
  if (!before) { removeUpload(req.file?.filename); return; }
  if (!canEditMarker(req, before)) { removeUpload(req.file?.filename); return res.status(403).json({ error: 'You cannot edit that marker' }); }
  if (!req.file) return res.status(400).json({ error: 'Upload a PNG, JPEG, WebP or GIF image' });
  q.updateMarker.run(before.type, before.name, before.x, before.y, req.file.filename, null, before.color,
    before.adminOnly ? 1 : 0, before.visibleTo ? JSON.stringify(before.visibleTo) : null, before.ownerId,
    JSON.stringify(before.data), now(), before.locked ? 1 : 0, before.id);
  const after = access.serializeMarker(q.marker.get(before.id, req.lobby.id));
  commitChange(req, 'marker', 'update', before, after);
  res.json({ marker: after });
});

router.delete('/:id/markers/:mid', (req, res) => {
  const before = loadMarker(req, res);
  if (!before) return;
  if (!canEditMarker(req, before)) return res.status(403).json({ error: 'You cannot delete that marker' });
  q.deleteMarker.run(before.id);
  commitChange(req, 'marker', 'delete', before, null);
  if (!before.adminOnly && !before.visibleTo) logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} removed ${before.name}`);
  res.json({ ok: true });
});

// ---- Shapes (drawing layer) ---------------------------------------------------------------
router.get('/:id/shapes', (req, res) => {
  const v = viewerOf(req);
  res.json({ shapes: q.shapes.all(req.lobby.id).map(access.serializeShape).filter(s => access.canSee(s, v)) });
});

function canEditShape(req, s) {
  return req.lobbyRole === 'gm' || (s.createdBy === req.user.id && !s.adminOnly);
}

/** Per-kind extras. Trench: facing (which side is the rear), build state, zigzag flag. */
function shapeData(kind, raw, before) {
  if (kind !== 'trench') return null;
  const d = (raw && typeof raw === 'object') ? raw : {}, prev = before || {};
  return {
    facing: ['left', 'right'].includes(d.facing) ? d.facing : (prev.facing || 'left'),
    state: ['plan', 'dug', 'reinforced'].includes(d.state) ? d.state : (prev.state || 'dug'),
    zigzag: d.zigzag !== undefined ? !!d.zigzag : (prev.zigzag !== undefined ? !!prev.zigzag : true),
  };
}

function parsePoints(req, kind, raw) {
  if (!Array.isArray(raw) || raw.length > 500) return null;
  const pts = [];
  for (const p of raw) {
    const x = num(Array.isArray(p) ? p[0] : p?.x, NaN), y = num(Array.isArray(p) ? p[1] : p?.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !inBounds(req, x, y)) return null;
    pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  }
  if (pts.length < (kind === 'area' ? 3 : 2)) return null;
  return pts;
}

function loadShape(req, res) {
  const row = q.shape.get(Number(req.params.sid), req.lobby.id);
  const s = row && access.serializeShape(row);
  if (!s || !access.canSee(s, viewerOf(req))) { res.status(404).json({ error: 'No such drawing' }); return null; }
  return s;
}

router.post('/:id/shapes', (req, res) => {
  const b = req.body || {};
  const isGm = req.lobbyRole === 'gm';
  const kind = ['line', 'area', 'trench'].includes(b.kind) ? b.kind : null;
  if (!kind) return res.status(400).json({ error: 'Drawing must be a line, an area or a trench' });
  const points = parsePoints(req, kind, b.points);
  if (!points) return res.status(400).json({ error: 'Bad points (need 2+ for a line, 3+ for an area, all on the map)' });
  const label = clean(b.label, 60);
  const color = COLOR_RE.test(b.color || '') ? b.color : (req.member?.color || '#f1c40f');
  const width = kind === 'trench' ? clamp(num(b.width, 10), 2, 80) : clamp(num(b.width, 3), 1, 20);
  const adminOnly = isGm && b.adminOnly ? 1 : 0;
  const visibleTo = isGm ? parseVisibleTo(b.visibleTo) : null;
  const data = shapeData(kind, b.data, null);
  const t = now();
  const id = q.insertShape.run(null, req.lobby.id, kind, label, JSON.stringify(points), color, width, adminOnly, visibleTo, req.user.id, t, t, b.locked ? 1 : 0, data ? JSON.stringify(data) : null).lastInsertRowid;
  const shape = access.serializeShape(q.shape.get(id, req.lobby.id));
  commitChange(req, 'shape', 'create', null, shape);
  res.status(201).json({ shape });
});

router.patch('/:id/shapes/:sid', (req, res) => {
  const before = loadShape(req, res);
  if (!before) return;
  if (!canEditShape(req, before)) return res.status(403).json({ error: 'You cannot edit that drawing' });
  const b = req.body || {};
  const isGm = req.lobbyRole === 'gm';
  const points = b.points !== undefined ? parsePoints(req, before.kind, b.points) : before.points;
  if (!points) return res.status(400).json({ error: 'Bad points' });
  if (before.locked && b.points !== undefined && b.locked !== false) {
    return res.status(409).json({ error: `${before.label || 'That drawing'} is locked; unlock it first` });
  }
  const label = b.label !== undefined ? clean(b.label, 60) : before.label;
  const color = b.color !== undefined && COLOR_RE.test(b.color) ? b.color : before.color;
  const width = b.width !== undefined ? (before.kind === 'trench' ? clamp(num(b.width, 10), 2, 80) : clamp(num(b.width, 3), 1, 20)) : before.width;
  const adminOnly = isGm && b.adminOnly !== undefined ? (b.adminOnly ? 1 : 0) : (before.adminOnly ? 1 : 0);
  const visibleTo = isGm && b.visibleTo !== undefined ? parseVisibleTo(b.visibleTo) : (before.visibleTo ? JSON.stringify(before.visibleTo) : null);
  const locked = b.locked !== undefined ? (b.locked ? 1 : 0) : (before.locked ? 1 : 0);
  const data = b.data !== undefined ? shapeData(before.kind, b.data, before.data) : (before.data && Object.keys(before.data).length ? before.data : null);
  q.updateShape.run(before.kind, label, JSON.stringify(points), color, width, adminOnly, visibleTo, now(), locked, data ? JSON.stringify(data) : null, before.id);
  const after = access.serializeShape(q.shape.get(before.id, req.lobby.id));
  commitChange(req, 'shape', 'update', before, after);
  res.json({ shape: after });
});

router.delete('/:id/shapes/:sid', (req, res) => {
  const before = loadShape(req, res);
  if (!before) return;
  if (!canEditShape(req, before)) return res.status(403).json({ error: 'You cannot delete that drawing' });
  q.deleteShape.run(before.id);
  commitChange(req, 'shape', 'delete', before, null);
  res.json({ ok: true });
});

// ---- History / revert ----------------------------------------------------------------------
router.get('/:id/history', (req, res) => {
  const v = viewerOf(req);
  const entity = ['marker', 'shape'].includes(req.query.entity) ? req.query.entity : '';
  const entityId = num(req.query.entityId, 0);
  const limit = clamp(num(req.query.limit, 100), 1, 300);
  const entries = hist.listFor(req.lobby.id, { entity, entityId, limit })
    .filter(e => v.role === 'gm' || access.canSee(e.after || e.before, v));
  res.json({ entries });
});

function canRevert(req, entry) {
  if (req.lobbyRole === 'gm') return true;
  if (entry.userId !== req.user.id) return false;
  const obj = entry.after || entry.before;
  return obj && (obj.ownerId === req.user.id || obj.createdBy === req.user.id) && !obj.adminOnly;
}

router.post('/:id/history/:hid/revert', (req, res) => {
  const entry = hist.get(req.params.hid);
  if (!entry || entry.lobbyId !== req.lobby.id) return res.status(404).json({ error: 'No such history entry' });
  if (!canRevert(req, entry)) return res.status(403).json({ error: 'You cannot revert that change' });
  if (entry.revertedBy) return res.status(409).json({ error: 'That change was already reverted' });

  const isMarker = entry.entity === 'marker';
  const getRow = isMarker ? q.marker : q.shape;
  const serialize = isMarker ? access.serializeMarker : access.serializeShape;
  const current = getRow.get(entry.entityId, req.lobby.id);
  const currentObj = current ? serialize(current) : null;

  if (entry.action === 'create') {
    if (!current) return res.status(409).json({ error: 'It no longer exists' });
    (isMarker ? q.deleteMarker : q.deleteShape).run(entry.entityId);
    const e = commitChange(req, entry.entity, 'delete', currentObj, null, entry.id);
    return res.json({ entry: e });
  }

  const target = entry.before;
  if (entry.action === 'delete' && current) return res.status(409).json({ error: 'Something with that id already exists' });
  if (entry.action === 'update' && !current) return res.status(409).json({ error: 'It no longer exists; restore its deletion first' });
  const t = now();
  if (isMarker) {
    const vt = target.visibleTo ? JSON.stringify(target.visibleTo) : null;
    const iconUrl = target.iconFile ? null : target.iconUrl;
    if (entry.action === 'delete') {
      q.insertMarker.run(target.id, req.lobby.id, target.type, target.name, target.x, target.y, target.iconFile, iconUrl,
        target.color, target.adminOnly ? 1 : 0, vt, target.ownerId, JSON.stringify(target.data), target.createdAt || t, t, target.locked ? 1 : 0);
    } else {
      q.updateMarker.run(target.type, target.name, target.x, target.y, target.iconFile, iconUrl, target.color,
        target.adminOnly ? 1 : 0, vt, target.ownerId, JSON.stringify(target.data), t, target.locked ? 1 : 0, target.id);
    }
  } else {
    const vt = target.visibleTo ? JSON.stringify(target.visibleTo) : null;
    if (entry.action === 'delete') {
      q.insertShape.run(target.id, req.lobby.id, target.kind, target.label, JSON.stringify(target.points), target.color,
        target.width, target.adminOnly ? 1 : 0, vt, target.createdBy, target.createdAt || t, t, target.locked ? 1 : 0);
    } else {
      q.updateShape.run(target.kind, target.label, JSON.stringify(target.points), target.color, target.width,
        target.adminOnly ? 1 : 0, vt, t, target.locked ? 1 : 0, target.id);
    }
  }
  const after = serialize(getRow.get(entry.entityId, req.lobby.id));
  const e = commitChange(req, entry.entity, entry.action === 'delete' ? 'create' : 'update', currentObj, after, entry.id);
  res.json({ entry: e, [entry.entity]: after });
});

// ---- Events / chat / dice / combat -----------------------------------------------------------------
router.get('/:id/events', (req, res) => {
  const since = num(req.query.since, 0);
  const limit = clamp(num(req.query.limit, 100), 1, 200);
  const gm = req.lobbyRole === 'gm';
  const g = game.get(req.lobby.id);
  const myNation = String(req.member?.nation || '').toLowerCase();
  const events = q.events.all(req.lobby.id, since, limit).reverse().map(serializeEvent)
    .filter(e => gm || !(e.data && e.data.hidden))
    // Turn summaries are private to the faction unless treasuries are public.
    .filter(e => gm || e.kind !== 'turn' || g.settings.publicTreasury || String(e.data?.faction || '').toLowerCase() === myNation);
  res.json({ events });
});

const ROLL_RE = /^\/(?:roll|r)\s+(\d{0,2})d(\d{1,4})(?:\s*([+-])\s*(\d{1,4}))?\s*(.*)$/i;

router.post('/:id/chat', (req, res) => {
  const message = clean(req.body?.message, 500);
  if (!message) return res.status(400).json({ error: 'Empty message' });
  const m = ROLL_RE.exec(message);
  if (m) {
    const n = clamp(num(m[1], 1) || 1, 1, 20);
    const sides = clamp(num(m[2], 6), 2, 1000);
    const mod = m[3] ? (m[3] === '-' ? -1 : 1) * num(m[4], 0) : 0;
    const note = clean(m[5], 120);
    const rolls = Array.from({ length: n }, () => crypto.randomInt(1, sides + 1));
    const total = rolls.reduce((a, b) => a + b, 0) + mod;
    const expr = `${n}d${sides}${mod ? (mod > 0 ? '+' : '-') + Math.abs(mod) : ''}`;
    const text = `🎲 rolled ${expr} → [${rolls.join(', ')}]${mod ? ` ${mod > 0 ? '+' : '-'} ${Math.abs(mod)}` : ''} = ${total}${note ? ` (${note})` : ''}`;
    return res.status(201).json({ event: logEvent(req.lobby.id, req.user.id, 'roll', text, { n, sides, mod, rolls, total, note }) });
  }
  if (message.startsWith('/')) return res.status(400).json({ error: 'Unknown command. Try /roll 2d6+3' });
  res.status(201).json({ event: logEvent(req.lobby.id, req.user.id, 'chat', message) });
});

router.post('/:id/combat', (req, res) => {
  const v = viewerOf(req);
  const rows = [Number(req.body?.attackerId), Number(req.body?.defenderId)].map(id => q.marker.get(id, req.lobby.id));
  const [a, d] = rows.map(r => r && access.serializeMarker(r));
  if (!a || !d || !access.canSee(a, v) || !access.canSee(d, v)) return res.status(404).json({ error: 'Pick two units you can see' });
  if (a.id === d.id) return res.status(400).json({ error: 'A unit cannot attack itself' });
  if (a.type !== 'unit' || d.type !== 'unit') return res.status(400).json({ error: 'Only units can fight' });
  if (!canEditMarker(req, a)) return res.status(403).json({ error: 'You can only attack with units you control' });
  if ((a.data.strength ?? 100) <= 0) return res.status(400).json({ error: `${a.name} has no strength left` });
  const g = game.get(req.lobby.id);
  const apError = game.checkAttack(g, req.lobbyRole === 'gm', a);
  if (apError) return res.status(409).json({ error: apError });
  if (g.enabled) a.data = { ...a.data, apUsed: num(a.data.apUsed) + 1 };   // spent even if the attack is repelled

  const cfg = access.serializeLobby(req.lobby, 'player').settings.combat;
  const atk = num(a.data.attack), def = num(d.data.defend);
  const aRoll = crypto.randomInt(1, cfg.die + 1), dRoll = crypto.randomInt(1, cfg.die + 1);
  const aTotal = aRoll + atk, dTotal = dRoll + def;
  const margin = aTotal - dTotal;
  let aLoss, dLoss, outcome;
  if (margin > 0) { dLoss = cfg.baseLoss + margin * cfg.marginMult; aLoss = cfg.winnerLoss; outcome = 'attacker'; }
  else if (margin < 0) { aLoss = cfg.baseLoss - margin * cfg.marginMult; dLoss = cfg.winnerLoss; outcome = 'defender'; }
  else { aLoss = dLoss = Math.ceil(cfg.baseLoss / 2); outcome = 'tie'; }
  aLoss = Math.round(aLoss); dLoss = Math.round(dLoss);

  const losses = {};
  const apply = (m, loss) => {
    const from = clamp(num(m.data.strength, 100), 0, 100);
    const to = clamp(from - loss, 0, 100);
    losses[m.id] = { name: m.name, from, to, loss: from - to };
    if (to === from && !(m === a && g.enabled)) return m;   // the attacker is always rewritten in game mode (AP spent)
    const data = { ...m.data, strength: to };
    q.updateMarker.run(m.type, m.name, m.x, m.y, m.iconFile, m.iconFile ? null : m.iconUrl, m.color, m.adminOnly ? 1 : 0,
      m.visibleTo ? JSON.stringify(m.visibleTo) : null, m.ownerId, JSON.stringify(data), now(), m.locked ? 1 : 0, m.id);
    const after = access.serializeMarker(q.marker.get(m.id, req.lobby.id));
    commitChange(req, 'marker', 'update', m, after);
    return after;
  };
  apply(a, aLoss); apply(d, dLoss);

  const fmt = (m, l) => `${m.name} ${l.loss ? `loses ${l.loss}% (${l.from}→${l.to}${l.to === 0 ? ', destroyed' : ''})` : 'is unharmed'}`;
  const text = `⚔ ${a.name} attacked ${d.name}: ${aRoll}+${atk}=${aTotal} vs ${dRoll}+${def}=${dTotal} → ` +
    (outcome === 'tie' ? 'stalemate. ' : outcome === 'attacker' ? 'attack succeeds. ' : 'attack repelled. ') +
    `${fmt(d, losses[d.id])}; ${fmt(a, losses[a.id])}`;
  const hidden = !!(a.adminOnly || d.adminOnly || a.visibleTo || d.visibleTo);
  const data = { attackerId: a.id, defenderId: d.id, aRoll, dRoll, aTotal, dTotal, margin, outcome, losses, hidden };
  const event = logEvent(req.lobby.id, req.user.id, 'combat', text, data,
    hidden ? (ws => ws.lobbyRole === 'gm' || ws.user.id === req.user.id) : null);
  res.status(201).json({ event });
});

module.exports = router;
