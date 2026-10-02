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
const vision = require('../vision');   // fog of war
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
  setFactionUniform: db.prepare('UPDATE factions SET uniform = ? WHERE id = ?'),
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

const MARKER_TYPES = ['unit', 'town', 'poi', 'player', 'scenery', 'resource', 'factory', 'hero'];
const Heroes = require('../../public/js/heroes');
const Matchups = require('../../public/js/matchups');
const heroRules = require('../heroes');
/** Hero fields only the GM (or the rules) may change: players move and command heroes, they do not rewrite them. */
const PROTECTED_HERO_FIELDS = ['role', 'stars', 'perception', 'intelligence', 'movement', 'ap', 'nation', 'status', 'postedTo', 'travel', 'capturedBy', 'movedKm', 'apUsed', 'trail'];
const game = require('../game');
const rails = require('../rails');
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

function viewerOf(req) { return { role: req.lobbyRole, userId: req.user.id, nation: req.member?.nation || '', viewAs: req.viewAs?.id || null, lobbyId: req.lobby.id }; }

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
/**
 * Supply is live (docs/UNITS.md): changes to units, places or railways (and to relations) recompute it once
 * the current request has finished writing, and the markers whose status changed are pushed to every viewer.
 */
const supplyPending = new Set();
function scheduleSupply(lobbyId) {
  if (supplyPending.has(lobbyId)) return;
  supplyPending.add(lobbyId);
  setImmediate(() => {
    supplyPending.delete(lobbyId);
    try {
      const g = game.get(lobbyId);
      if (!g.enabled || g.settings.supplyEnabled === false) return;
      const lobby = access.getLobby(lobbyId);
      if (!lobby) return;
      for (const c of game.applySupply(lobby, g.settings).changes) hub.broadcastEntity(lobbyId, 'marker', c.before, c.after, null);
    } catch (e) { console.warn('supply refresh failed', e); }
  });
}
function commitChange(req, entity, action, before, after, reverts = null) {
  const subject = after || before;
  if ((entity === 'marker' && ['unit', 'town'].includes(subject.type)) || (entity === 'shape' && subject.kind === 'rail')) scheduleSupply(req.lobby.id);
  if (entity === 'marker' && ['unit', 'hero', 'town'].includes(subject.type)) vision.schedulePush(req.lobby.id);   // fog of war: sight moved
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
  // "View as player": a GM's page sends X-View-As (a faction id) and is then served as that nation's player.
  const as = access.viewAsFaction(lobby, role, req.get('x-view-as'));
  if (as) {
    req.viewAs = as; req.lobbyRole = 'player';
    req.member = { ...(req.member || { lobby_id: lobby.id, user_id: req.user.id, color: as.color, joined_at: 0 }), role: 'player', nation: as.name };
  }
  next();
});

function requireGm(req, res, next) {
  if (req.lobbyRole !== 'gm') return res.status(403).json({ error: 'Game master only' });
  next();
}

// ---- Game layer hooks ----------------------------------------------------------------------------
/**
 * Change a marker's faction (territory ownership), recording history and broadcasting like any edit.
 * `captured` is true only when a unit took the place (afterMove): game mode then
 * remembers the turn it changed hands (turn reports, the "captured this turn" flash, no yield that turn).
 * Setup, the GM's border tools and End turn's settling just reassign owners: those places keep producing.
 */
function setMarkerNation(req, before, nation, captured = false) {
  const data = { ...before.data, nation };
  const g = game.get(req.lobby.id);
  if (captured && g.enabled && String(before.data?.nation || '') !== String(nation || '')) { data.capturedTurn = g.turn; data.capturedFrom = String(before.data?.nation || ''); }
  q.updateMarker.run(before.type, before.name, before.x, before.y, before.iconFile, before.iconFile ? null : before.iconUrl, before.color,
    before.adminOnly ? 1 : 0, before.visibleTo ? JSON.stringify(before.visibleTo) : null, before.ownerId, JSON.stringify(data), now(), before.locked ? 1 : 0, before.id);
  const after = access.serializeMarker(q.marker.get(before.id, req.lobby.id));
  commitChange(req, 'marker', 'update', before, after);
  return after;
}
function shapeById(req, id, all) {
  if (all) return q.shapes.all(req.lobby.id).map(access.serializeShape);
  const row = q.shape.get(id, req.lobby.id); return row ? access.serializeShape(row) : null;
}
/** Rewrite a marker's position and data (heroes' missions and travel), recording history and broadcasting. */
function writeMarker(req, before, patch) {
  const x = patch.x !== undefined ? patch.x : before.x, y = patch.y !== undefined ? patch.y : before.y;
  const data = sanitizeData(before.type, { ...before.data, ...(patch.data || {}) });
  const adminOnly = patch.adminOnly !== undefined ? (patch.adminOnly ? 1 : 0) : (before.adminOnly ? 1 : 0);
  q.updateMarker.run(before.type, before.name, x, y, before.iconFile, before.iconFile ? null : before.iconUrl, before.color,
    adminOnly, before.visibleTo ? JSON.stringify(before.visibleTo) : null, before.ownerId, JSON.stringify(data), now(), before.locked ? 1 : 0, before.id);
  const after = access.serializeMarker(q.marker.get(before.id, req.lobby.id));
  commitChange(req, 'marker', 'update', before, after);
  return after;
}
/** Change a drawing's owning nation (trenches follow territory), recording history and broadcasting. */
function setShapeNation(req, before, nation) {
  const data = { ...(before.data || {}), nation };
  q.updateShape.run(before.kind, before.label, JSON.stringify(before.points), before.color, before.width, before.adminOnly ? 1 : 0,
    before.visibleTo ? JSON.stringify(before.visibleTo) : null, now(), before.locked ? 1 : 0, JSON.stringify(data), before.id);
  const after = access.serializeShape(q.shape.get(before.id, req.lobby.id));
  commitChange(req, 'shape', 'update', before, after);
  return after;
}

/** Rewrite a drawing's data (railway cuts and repairs), recording history and broadcasting. */
function writeShape(req, before, data) {
  q.updateShape.run(before.kind, before.label, JSON.stringify(before.points), before.color, before.width, before.adminOnly ? 1 : 0,
    before.visibleTo ? JSON.stringify(before.visibleTo) : null, now(), before.locked ? 1 : 0, JSON.stringify(data), before.id);
  const after = access.serializeShape(q.shape.get(before.id, req.lobby.id));
  commitChange(req, 'shape', 'update', before, after);
  return after;
}

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
  if (r.held) return `${unit.name} faces defenders: the ground holds until they are beaten`;
  for (const f of r.flips) setMarkerNation(req, f.marker, f.nation, true);
  if (r.changed.length) hub.broadcast(req.lobby.id, { type: 'territory', territories: r.changed });
  if (r.owners && r.owners.length) hub.broadcast(req.lobby.id, { type: 'provinceOwners', owners: r.owners });
  const ownerName = r.owner === territory.NEUTRAL ? 'neutral' : (factions.find(f => f.id === r.owner)?.name || 'enemy');
  const what = r.cities.length ? `takes ${r.cities.join(', ')} and the surrounding ${ownerName} territory` : `advances into ${ownerName} territory`;
  logEvent(req.lobby.id, req.user.id, 'system', vision.on(req.lobby.id) ? `${r.mine.name} ${what}` : `${unit.name} (${r.mine.name}) ${what}`);
  return r.cities.length ? `${unit.name} takes ${r.cities.join(', ')}!` : null;
}

// Game layer (turns, treasuries, territories, diplomacy): routes/game.js, sharing this router's lobby middleware.
router.use('/:id/game', require('./game')({ logEvent, clean, num, clamp, setMarkerNation, setShapeNation, shapeById, createMarker, writeMarker, writeShape, canEditMarker, scheduleSupply }));

router.get('/:id', (req, res) => {
  const online = new Set(hub.presence(req.lobby.id).map(u => u.id));
  const members = access.getMembers(req.lobby.id).map(m => ({ ...access.serializeMember(m), online: online.has(m.user_id) }));
  res.json({
    lobby: access.serializeLobby(req.lobby, req.lobbyRole),
    members,
    you: {
      id: req.user.id, displayName: req.user.displayName, role: req.lobbyRole,
      member: req.viewAs ? { ...(members.find(m => m.userId === req.user.id) || { userId: req.user.id, displayName: req.user.displayName, color: req.viewAs.color }), role: 'player', nation: req.viewAs.name }
        : members.find(m => m.userId === req.user.id) || null,
      realRole: req.viewAs ? 'gm' : req.lobbyRole,
      viewAs: req.viewAs ? access.serializeFaction(req.viewAs) : null,
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

const Powers = require('../../public/js/powers');
/** A year's borders with ownership resolved (each country has .state and .power; see public/js/powers.js). */
function loadWorld(year) { return require('../territory').world(year); }

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
  const existing = new Set(q.factions.all(req.lobby.id).map(f => Powers.canon(f.name)));
  const powers = new Map();   // canonical key -> { name, territories }
  for (const c of world.countries) {
    if (!c.power) continue;
    const key = Powers.canon(c.power);
    if (!powers.has(key)) powers.set(key, { name: c.power, territories: 0 });
    powers.get(key).territories++;
  }
  const list = [...powers.values()].sort((a, b) => a.name.localeCompare(b.name)).map(p => ({
    ...p, color: tintHex(p.name), flagAsset: matchFlag(p.name, flags), exists: existing.has(Powers.canon(p.name)),
  }));
  res.json({ year: world.year, powers: list });
});

/** Create factions for the chosen powers (names from the preview), skipping ones that exist. */
router.post('/:id/factions/seed', requireGm, (req, res) => {
  const world = loadWorld(req.body?.year);
  if (!world) return res.status(400).json({ error: 'No borders bundled for that year' });
  const wanted = new Set((Array.isArray(req.body?.names) ? req.body.names : []).map(n => String(n)));
  const flags = bundledFlags();
  const existing = new Set(q.factions.all(req.lobby.id).map(f => Powers.canon(f.name)));
  const powers = new Set(world.countries.map(c => c.power).filter(Boolean));
  const created = [];
  for (const power of powers) {
    if (!wanted.has(power) || existing.has(Powers.canon(power))) continue;
    existing.add(Powers.canon(power));
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
  const maxPoints = clamp(num(b.maxPoints, 800), 30, 4000);
  const minArea = (W / 400) ** 2;   // skip specks smaller than ~1/400 of the map width squared
  const existing = new Set(q.shapes.all(req.lobby.id).map(s => s.label.toLowerCase()));
  const created = [];
  const t0 = now();
  for (const c of world.countries) {
    const power = c.power || c.state || c.n;
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
      const label = n === 0 ? (c.state || c.n) : `${c.state || c.n} (${n + 1})`;
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

/** Infantry uniforms for the battle figures ('' = chosen from the faction's name, public/js/skirmish.js). */
const UNIFORMS = ['grey', 'beige', 'green'];

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
  if (UNIFORMS.includes(b.uniform)) q.setFactionUniform.run(b.uniform, id);
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
  if (b.uniform !== undefined) q.setFactionUniform.run(UNIFORMS.includes(b.uniform) ? b.uniform : '', row.id);
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
  res.json({ markers: q.markers.all(req.lobby.id).map(access.serializeMarker).filter(m => access.canSee(m, v)).map(m => vision.redact(m, v)) });
});

function canEditMarker(req, m) { return access.canControl(m, viewerOf(req)); }

/** A trail: up to 120 [x, y] points. */
function cleanTrail(raw) {
  return raw.filter(p => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .slice(-120).map(p => [Math.round(Number(p[0]) * 10) / 10, Math.round(Number(p[1]) * 10) / 10]);
}
/**
 * Game mode: the way a unit or hero has come this turn, drawn on the map until End turn clears it.
 * `path` is the route taken (a rail trip's track), first point the start and last the destination.
 */
function extendTrail(before, x, y, path) {
  const prev = Array.isArray(before.data?.trail) && before.data.trail.length ? before.data.trail : [[before.x, before.y]];
  let mid = Array.isArray(path) ? path.slice(1, -1) : [];
  if (mid.length > 40) { const k = Math.ceil(mid.length / 40); mid = mid.filter((_, i) => i % k === 0); }
  return cleanTrail([...prev, ...mid, [x, y]]);
}

/** Units and heroes in transit: data.ride (the last rail trip, for the train animation) and data.aboard (the convoy carrying it). */
function transitData(d) {
  const out = {};
  if (num(d.aboard) > 0) out.aboard = Math.round(num(d.aboard));
  if (d.ride && typeof d.ride === 'object' && Array.isArray(d.ride.path) && d.ride.path.length >= 2) {
    const path = d.ride.path.filter(q => Array.isArray(q) && Number.isFinite(Number(q[0])) && Number.isFinite(Number(q[1]))).slice(0, 220)
      .map(q => [Math.round(Number(q[0]) * 10) / 10, Math.round(Number(q[1]) * 10) / 10]);
    const on = clamp(Math.round(num(d.ride.on, 1)), 0, path.length - 1), off = clamp(Math.round(num(d.ride.off, path.length - 1)), on, path.length - 1);
    out.ride = { at: num(d.ride.at), path, on, off };
  }
  return out;
}
/**
 * A rail trip as the browser animates it: the route walked, with where the unit boarded and got off. `route` is
 * the planned trip ([a, boarding, ...track, alighting, b]), `points` what was walked of it (less when movement
 * ran out). Null when the unit never reached the track (it simply walked).
 */
function rideOf(route, points) {
  if (!route) return null;
  const full = route.path.map(q => [q[0], q[1]]), n = full.length;
  const walked = Array.isArray(points) && points.length ? points : full;
  let off;
  if (walked.length >= n) off = n - 2;
  else { const k = walked.length - 1; if (k <= 1) return null; off = Math.min(k, n - 2); }
  const on = 1;
  let rail = walked.slice(on, off + 1);
  if (rail.length > 150) { const step = Math.ceil(rail.length / 150); rail = rail.filter((_, i) => i % step === 0 || i === rail.length - 1); }
  return { at: Date.now(), path: [...walked.slice(0, on), ...rail, ...walked.slice(off + 1)], on, off: on + rail.length - 1 };
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
    if (d.supplied === false || d.supplied === true) out.supplied = d.supplied;   // set at End turn (docs/UNITS.md)
    if (num(d.unsuppliedTurns) > 0) out.unsuppliedTurns = Math.round(num(d.unsuppliedTurns));
    if (d.surrendered === true) out.surrendered = true;
    if (d.supplyFrom && typeof d.supplyFrom === 'object') out.supplyFrom = { id: d.supplyFrom.id == null ? null : num(d.supplyFrom.id), name: clean(d.supplyFrom.name, 60), kind: clean(d.supplyFrom.kind, 12) };
    if (Array.isArray(d.trail)) out.trail = cleanTrail(d.trail);
    Object.assign(out, transitData(d));
  } else if (type === 'resource') {
    out.kind = GameData.byKey[d.kind] ? d.kind : 'grain';
    out.yield = clamp(num(d.yield, 1), 0, 50);
    out.nation = clean(d.nation, 60);
  } else if (type === 'factory') {
    out.nation = clean(d.nation, 60);
    out.industry = clamp(Math.round(num(d.industry, 1)), 1, 5);
  } else if (type === 'town') {
    out.size = ['capital', 'city', 'village'].includes(d.size) ? d.size : 'village';
    out.nation = clean(d.nation, 60);
    if (d.industry !== undefined && d.industry !== '') out.industry = clamp(Math.round(num(d.industry, 0)), 0, 10);   // game mode: production and income weight
    if (num(d.developed) > 0) out.developed = clamp(Math.round(num(d.developed)), 0, 5);   // long-term development level (docs/ECONOMY.md)
    if (d.major) out.major = true;
  } else if (type === 'poi') {
    out.category = clean(d.category, 40);
  } else if (type === 'scenery') {
    // Scenery is drawn at map scale: `scale` = map pixels per sprite pixel.
    out.scale = clamp(num(d.scale, 1), 0.05, 50);
    out.rotation = ((num(d.rotation, 0) % 360) + 360) % 360;
    out.flip = !!d.flip;
  } else if (type === 'hero') {
    const def = Heroes.defaults(d.role, d.stars);
    Object.assign(out, {
      nation: clean(d.nation, 60), role: def.role, stars: def.stars, title: clean(d.title, 60),
      perception: clamp(num(d.perception, def.perception), 0, 20), intelligence: clamp(num(d.intelligence, def.intelligence), 0, 20),
      movement: clamp(num(d.movement, def.movement), 0, 20), ap: clamp(num(d.ap, def.ap), 0, 5),
      status: Heroes.STATUS[d.status] ? d.status : 'active',
      movedKm: Math.max(0, num(d.movedKm)), apUsed: Math.max(0, num(d.apUsed)),
    });
    if (Array.isArray(d.trail)) out.trail = cleanTrail(d.trail);
    Object.assign(out, transitData(d));
    if (out.status === 'posted' && d.postedTo) out.postedTo = num(d.postedTo);
    if (out.status === 'travelling' && d.travel && typeof d.travel === 'object') {
      out.travel = { to: num(d.travel.to), toName: clean(d.travel.toName, 60), x: num(d.travel.x), y: num(d.travel.y), arrives: num(d.travel.arrives), home: !!d.travel.home };
    }
    if (out.status === 'captured') { out.capturedBy = clean(d.capturedBy, 60); out.capturedTurn = num(d.capturedTurn); }
  }
  // A spy's recon reveals markers to the spy's nation until the end of the turn (see canSee).
  if (Array.isArray(d.revealTo) && d.revealTo.length) out.revealTo = [...new Set(d.revealTo.map(n => clean(n, 60)).filter(Boolean))].slice(0, 40);
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

/**
 * Create a marker for the acting user (shared by the POST route and production). Throws { status, message }.
 *  skips the role check (finished builds belong to the faction, not the GM).
 */
function createMarker(req, b, system = false) {
  const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
  const isGm = req.lobbyRole === 'gm' || system;
  const type = MARKER_TYPES.includes(b.type) ? b.type : null;
  if (!type) fail(400, 'Bad marker type');
  if (!isGm && type !== 'player') fail(403, 'Players can only add their own player marker');
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
  if (!name) fail(400, 'Marker needs a name');
  const x = num(b.x), y = num(b.y);
  if (!inBounds(req, x, y)) fail(400, 'Position is off the map');
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
  const secret = type === 'hero' && marker.data?.role === 'spy';
  if (!adminOnly && !visibleTo && type !== 'scenery' && !system && !secret) logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} placed ${name}`);
  return marker;
}

router.post('/:id/markers', (req, res) => {
  try { res.status(201).json({ marker: createMarker(req, req.body || {}) }); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
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
  let clampNote = null, railNote = null;
  if (b.data && typeof b.data === 'object' && g.enabled && !isGm && before.type === 'unit') {
    for (const k of game.PROTECTED_UNIT_FIELDS) delete b.data[k];
  }
  if (b.data && typeof b.data === 'object' && !isGm) {
    delete b.data.revealTo; delete b.data.aboard; delete b.data.ride;
    if (before.type === 'hero') for (const k of PROTECTED_HERO_FIELDS) delete b.data[k];
  }
  if (before.type === 'hero' && (x !== before.x || y !== before.y)) {
    if (before.data?.status === 'travelling' && !isGm) return res.status(409).json({ error: `${before.name} is travelling and arrives at the end of the turn` });
    if (before.data?.status === 'posted') b.data = { ...(b.data || {}), status: 'active', postedTo: null };
  }
  if ((x !== before.x || y !== before.y) && before.data?.aboard) {
    const ship = q.marker.get(Number(before.data.aboard), req.lobby.id);
    if (!isGm) return res.status(409).json({ error: `${before.name} is aboard ${ship ? ship.name : 'a convoy'}: disembark first` });
    b.data = { ...(b.data || {}), aboard: 0 };   // the GM lifting a unit off a convoy
  }
  if (x !== before.x || y !== before.y) {
    const mv = game.checkMove(req.lobby, g, isGm, before, x, y);
    if (mv.error) return res.status(409).json({ error: mv.error });
    x = mv.x; y = mv.y;
    if (mv.movedKm !== undefined) b.data = { ...(b.data || {}), movedKm: mv.movedKm };
    // By rail: no trail across the map (the train animation shows the trip); the trail starts again where it got off.
    const ride = rideOf(mv.route, mv.path);
    if (ride) b.data = { ...(b.data || {}), ride, ...(g.enabled ? { trail: [[x, y]] } : {}) };
    else if (g.enabled && ['unit', 'hero'].includes(before.type)) b.data = { ...(b.data || {}), trail: extendTrail(before, x, y, mv.path) };
    if (mv.clamped) clampNote = `${before.name} could only move ${Math.round(mv.remaining)} of ${mv.dist} this turn`;
    if (mv.route) railNote = `${before.name} went by rail (${Math.round(mv.route.railKm)} ${geo.isEarth(req.lobby) ? 'km' : (req.lobby.scale_label || 'units')} of track${mv.clamped ? ', stopped short' : ''})`;
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
  if (isConvoy(after) && (x !== before.x || y !== before.y)) moveCargo(req, after);
  if (isConvoy(after) && num(after.data?.strength, 100) <= 0 && num(before.data?.strength, 100) > 0) sinkCargo(req, after, 'was destroyed');
  const captureNote = (x !== before.x || y !== before.y) ? afterMove(req, after) : null;
  res.json({ marker: after, note: [railNote, clampNote, captureNote].filter(Boolean).join(' · ') || null });
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
    if (before.type === 'hero' && before.data?.status === 'travelling' && !isGm) { errors.push(`${before.name}: travelling`); continue; }
    if (before.data?.aboard) { errors.push(`${before.name}: aboard a convoy`); continue; }
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
  let byRail = 0;
  for (const p of plan) {
    let x = t < 1 ? Math.round((p.before.x + (p.x - p.before.x) * t) * 10) / 10 : p.x;
    let y = t < 1 ? Math.round((p.before.y + (p.y - p.before.y) * t) * 10) / 10 : p.y;
    let path = p.chk.path || null;
    if (p.chk.route) {
      byRail++;
      if (t < 1) { const w = rails.walk(req.lobby, p.chk.route.path, p.chk.cost * t); x = Math.round(w.x * 10) / 10; y = Math.round(w.y * 10) / 10; path = w.points; }
    }
    if (p.chk.movedKm !== undefined || (g.enabled && ['unit', 'hero'].includes(p.before.type))) {
      const data = { ...p.before.data };
      if (p.chk.movedKm !== undefined) {
        const used = num(p.before.data.movedKm);
        const spent = p.chk.cost !== undefined ? p.chk.cost * t : geo.distance(req.lobby, p.before.x, p.before.y, x, y);
        data.movedKm = Math.round((used + spent) * 10) / 10;
      }
      const ride = rideOf(p.chk.route, path);
      if (ride) { data.ride = ride; if (g.enabled) data.trail = [[x, y]]; }
      else if (g.enabled && ['unit', 'hero'].includes(p.before.type)) data.trail = extendTrail(p.before, x, y, path);
      q.updateMarker.run(p.before.type, p.before.name, x, y, p.before.iconFile, p.before.iconFile ? null : p.before.iconUrl, p.before.color,
        p.before.adminOnly ? 1 : 0, p.before.visibleTo ? JSON.stringify(p.before.visibleTo) : null, p.before.ownerId, JSON.stringify(data), now(), p.before.locked ? 1 : 0, p.before.id);
    } else q.moveMarker.run(x, y, now(), p.before.id);
    const after = access.serializeMarker(q.marker.get(p.before.id, req.lobby.id));
    commitChange(req, 'marker', 'update', p.before, after);
    if (isConvoy(after)) moveCargo(req, after);
    out.push(after);
  }
  const notes = out.map(m => afterMove(req, m)).filter(Boolean);
  if (byRail) notes.unshift(`${byRail} unit${byRail === 1 ? '' : 's'} went by rail`);
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
  qb.dropFor.run(req.lobby.id, before.id, before.id);   // its fights end with it (ids can be reused later)
  commitChange(req, 'marker', 'delete', before, null);
  if (isConvoy(before)) sinkCargo(req, before, 'was removed');
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

/**
 * Per-kind extras. Trench: facing (which side is the rear), build state, zigzag flag.
 * Rail: cuts [{ id, x, y, turn, by, at }], which only the game routes (sabotage, repair) and the GM change.
 */
function shapeData(kind, raw, before, isGm) {
  if (kind === 'rail') {
    const prev = Array.isArray(before?.cuts) ? before.cuts : [];
    const cuts = isGm && raw && Array.isArray(raw.cuts)
      ? raw.cuts.filter(c => c && Number.isFinite(Number(c.x)) && Number.isFinite(Number(c.y))).slice(0, 200)
        .map(c => ({ id: clean(c.id, 20) || Math.random().toString(36).slice(2, 10), x: Number(c.x), y: Number(c.y), turn: num(c.turn, 0), by: clean(c.by, 60), at: clean(c.at, 40) }))
      : prev;
    return { cuts };
  }
  if (kind !== 'trench') return null;
  const d = (raw && typeof raw === 'object') ? raw : {}, prev = before || {};
  return {
    facing: ['left', 'right'].includes(d.facing) ? d.facing : (prev.facing || 'left'),
    state: ['plan', 'dug', 'reinforced'].includes(d.state) ? d.state : (prev.state || 'dug'),
    zigzag: d.zigzag !== undefined ? !!d.zigzag : (prev.zigzag !== undefined ? !!prev.zigzag : true),
  };
}

/** Which faction owns the ground under a trench (from territories); '' when there are none. */
function trenchNation(req, points) {
  const territory = require('../territory');
  const lookup = territory.ownerLookup(req.lobby);
  if (!lookup) return '';
  return territory.trenchOwner(lookup, q.factions.all(req.lobby.id).map(access.serializeFaction), { points });
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
  const kind = ['line', 'area', 'trench', 'rail'].includes(b.kind) ? b.kind : null;
  if (!kind) return res.status(400).json({ error: 'Drawing must be a line, an area, a trench or a railway' });
  if (kind === 'rail' && !isGm && game.get(req.lobby.id).enabled) return res.status(403).json({ error: 'Only the GM lays railways while the game is running' });
  let points = parsePoints(req, kind, b.points);
  if (!points) return res.status(400).json({ error: 'Bad points (need 2+ for a line, 3+ for an area, all on the map)' });
  if (kind === 'rail') points = rails.snapEnds(req.lobby, game.get(req.lobby.id).settings, points, null);
  const label = clean(b.label, 60);
  const color = COLOR_RE.test(b.color || '') ? b.color : (req.member?.color || '#f1c40f');
  const width = kind === 'trench' ? clamp(num(b.width, 0.5), 0.05, 50) : clamp(num(b.width, 3), 1, 20);
  const adminOnly = isGm && b.adminOnly ? 1 : 0;
  const visibleTo = isGm ? parseVisibleTo(b.visibleTo) : null;
  const data = shapeData(kind, b.data, null, isGm);
  if (data && kind === 'trench') data.nation = trenchNation(req, points);
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
  if (before.kind === 'rail' && !isGm && game.get(req.lobby.id).enabled) return res.status(403).json({ error: 'Only the GM changes railways while the game is running' });
  let points = b.points !== undefined ? parsePoints(req, before.kind, b.points) : before.points;
  if (!points) return res.status(400).json({ error: 'Bad points' });
  if (before.kind === 'rail' && b.points !== undefined) points = rails.snapEnds(req.lobby, game.get(req.lobby.id).settings, points, before.id);
  if (before.locked && b.points !== undefined && b.locked !== false) {
    return res.status(409).json({ error: `${before.label || 'That drawing'} is locked; unlock it first` });
  }
  const label = b.label !== undefined ? clean(b.label, 60) : before.label;
  const color = b.color !== undefined && COLOR_RE.test(b.color) ? b.color : before.color;
  const width = b.width !== undefined ? (before.kind === 'trench' ? clamp(num(b.width, 0.5), 0.05, 50) : clamp(num(b.width, 3), 1, 20)) : before.width;
  const adminOnly = isGm && b.adminOnly !== undefined ? (b.adminOnly ? 1 : 0) : (before.adminOnly ? 1 : 0);
  const visibleTo = isGm && b.visibleTo !== undefined ? parseVisibleTo(b.visibleTo) : (before.visibleTo ? JSON.stringify(before.visibleTo) : null);
  const locked = b.locked !== undefined ? (b.locked ? 1 : 0) : (before.locked ? 1 : 0);
  const data = b.data !== undefined ? shapeData(before.kind, b.data, before.data, isGm) : (before.data && Object.keys(before.data).length ? { ...before.data } : null);
  if (data && before.kind === 'trench') data.nation = trenchNation(req, points);
  q.updateShape.run(before.kind, label, JSON.stringify(points), color, width, adminOnly, visibleTo, now(), locked, data ? JSON.stringify(data) : null, before.id);
  const after = access.serializeShape(q.shape.get(before.id, req.lobby.id));
  commitChange(req, 'shape', 'update', before, after);
  res.json({ shape: after });
});

router.delete('/:id/shapes/:sid', (req, res) => {
  const before = loadShape(req, res);
  if (!before) return;
  if (!canEditShape(req, before)) return res.status(403).json({ error: 'You cannot delete that drawing' });
  if (before.kind === 'rail' && req.lobbyRole !== 'gm' && game.get(req.lobby.id).enabled) return res.status(403).json({ error: 'Only the GM removes railways while the game is running' });
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
    .filter(e => v.role === 'gm' || (access.canSee(e.after || e.before, v) && vision.sameSide(v, e.after || e.before)));
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

// ---- Private chats (docs/COMMS.md) -----------------------------------------------------------------
// OOC chat is the lobby's chat events and GM announcements are 'announce' events; private chats between
// members live here and only their members receive or read them (the GM too, only when a member).
const qc = {
  channels: db.prepare('SELECT * FROM chat_channels WHERE lobby_id = ? ORDER BY last_at DESC'),
  channel: db.prepare('SELECT * FROM chat_channels WHERE id = ? AND lobby_id = ?'),
  insertChannel: db.prepare('INSERT INTO chat_channels (lobby_id, name, members, created_by, created_at, last_at) VALUES (?, ?, ?, ?, ?, ?)'),
  updateChannel: db.prepare('UPDATE chat_channels SET name = ?, members = ?, last_at = ? WHERE id = ?'),
  deleteChannel: db.prepare('DELETE FROM chat_channels WHERE id = ?'),
  touchChannel: db.prepare('UPDATE chat_channels SET last_at = ? WHERE id = ?'),
  messages: db.prepare(`SELECT c.*, u.display_name FROM chat_messages c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.channel_id = ? AND c.id < ? ORDER BY c.id DESC LIMIT ?`),
  message: db.prepare('SELECT c.*, u.display_name FROM chat_messages c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?'),
  insertMessage: db.prepare('INSERT INTO chat_messages (lobby_id, channel_id, user_id, message, created_at) VALUES (?, ?, ?, ?, ?)'),
};
function serializeChannel(c) {
  return { id: c.id, name: c.name, members: access.safeJson(c.members) || [], createdBy: c.created_by, createdAt: c.created_at, lastAt: c.last_at };
}
function serializeChat(m) {
  return { id: m.id, channelId: m.channel_id, userId: m.user_id, displayName: m.display_name || 'System', message: m.message, createdAt: m.created_at };
}
/** The channel, if the caller is one of its members. */
function myChannel(req, res) {
  const row = qc.channel.get(Number(req.params.cid), req.lobby.id);
  const c = row && serializeChannel(row);
  if (!c || !c.members.includes(req.user.id)) { res.status(404).json({ error: 'No such chat' }); return null; }
  return c;
}
const toMembers = c => ws => c.members.includes(ws.user.id);

router.get('/:id/chats', (req, res) => {
  res.json({ channels: qc.channels.all(req.lobby.id).map(serializeChannel).filter(c => c.members.includes(req.user.id)) });
});

/** Open a chat with other members of the campaign (players or the GM). */
router.post('/:id/chats', (req, res) => {
  const ids = new Set(access.getMembers(req.lobby.id).map(m => m.user_id));
  const members = [...new Set([req.user.id, ...(Array.isArray(req.body?.members) ? req.body.members.map(Number) : [])])].filter(id => ids.has(id)).slice(0, 30);
  if (members.length < 2) return res.status(400).json({ error: 'Pick at least one other person' });
  // Re-use an existing chat with exactly the same people and no name.
  const name = clean(req.body?.name, 60);
  const same = qc.channels.all(req.lobby.id).map(serializeChannel)
    .find(c => !name && !c.name && c.members.length === members.length && members.every(id => c.members.includes(id)));
  if (same) return res.json({ channel: same });
  const t = now();
  const id = qc.insertChannel.run(req.lobby.id, name, JSON.stringify(members), req.user.id, t, t).lastInsertRowid;
  const channel = serializeChannel(qc.channel.get(id, req.lobby.id));
  hub.broadcast(req.lobby.id, { type: 'chatChannel', channel }, toMembers(channel));
  res.status(201).json({ channel });
});

/** Leave a chat; the last member out deletes it. */
router.post('/:id/chats/:cid/leave', (req, res) => {
  const c = myChannel(req, res);
  if (!c) return;
  const members = c.members.filter(id => id !== req.user.id);
  if (!members.length) qc.deleteChannel.run(c.id);
  else {
    qc.updateChannel.run(c.name, JSON.stringify(members), now(), c.id);
    const channel = serializeChannel(qc.channel.get(c.id, req.lobby.id));
    const mid = qc.insertMessage.run(req.lobby.id, c.id, null, `${req.user.displayName} left the chat`, now()).lastInsertRowid;
    hub.broadcast(req.lobby.id, { type: 'chatChannel', channel }, toMembers(channel));
    hub.broadcast(req.lobby.id, { type: 'chatMessage', message: serializeChat(qc.message.get(mid)) }, toMembers(channel));
  }
  res.json({ ok: true });
});

router.get('/:id/chats/:cid/messages', (req, res) => {
  const c = myChannel(req, res);
  if (!c) return;
  const before = num(req.query.before, Number.MAX_SAFE_INTEGER), limit = clamp(num(req.query.limit, 100), 1, 200);
  res.json({ messages: qc.messages.all(c.id, before, limit).reverse().map(serializeChat) });
});

router.post('/:id/chats/:cid/messages', (req, res) => {
  const c = myChannel(req, res);
  if (!c) return;
  const message = clean(req.body?.message, 1000);
  if (!message) return res.status(400).json({ error: 'Empty message' });
  const t = now();
  const id = qc.insertMessage.run(req.lobby.id, c.id, req.user.id, message, t).lastInsertRowid;
  qc.touchChannel.run(t, c.id);
  const msg = serializeChat(qc.message.get(id));
  hub.broadcast(req.lobby.id, { type: 'chatMessage', message: msg }, toMembers(c));
  res.status(201).json({ message: msg });
});

// ---- GM map pings ----------------------------------------------------------------------------
// A ping is a short-lived marker everyone sees for a minute; kept in memory only (late joiners get the live ones).
const PING_MS = 60000;
const pings = new Map();   // lobbyId -> [{ id, x, y, label, by, at, until }]
function livePings(lobbyId) {
  const list = (pings.get(lobbyId) || []).filter(p => p.until > Date.now());
  pings.set(lobbyId, list);
  return list;
}
router.get('/:id/pings', (req, res) => res.json({ pings: livePings(req.lobby.id) }));
router.post('/:id/pings', (req, res) => {
  if (req.lobbyRole !== 'gm') return res.status(403).json({ error: 'Only the GM can ping the map' });
  const x = num(req.body?.x, NaN), y = num(req.body?.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !inBounds(req, x, y)) return res.status(400).json({ error: 'Ping a spot on the map' });
  const t = Date.now();
  const ping = { id: `${t}-${Math.floor(Math.random() * 1e6)}`, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, label: clean(req.body?.label, 60), by: req.user.displayName, at: t, until: t + PING_MS };
  const list = livePings(req.lobby.id);
  list.push(ping);
  if (list.length > 20) list.shift();
  hub.broadcast(req.lobby.id, { type: 'ping', ping });
  res.status(201).json({ ping });
});

// ---- Events / chat / dice / combat -----------------------------------------------------------------
router.get('/:id/events', (req, res) => {
  const since = num(req.query.since, 0);
  const limit = clamp(num(req.query.limit, 100), 1, 200);
  const gm = req.lobbyRole === 'gm';
  const g = game.get(req.lobby.id);
  const myNation = String(req.member?.nation || '').toLowerCase();
  const events = q.events.all(req.lobby.id, since, limit).reverse().map(serializeEvent)
    .filter(e => gm || !(e.data && e.data.hidden) || e.userId === req.user.id)
    // Lines meant for some nations (spy reports, diplomacy in progress, trades, builds) stay with them.
    .filter(e => gm || !e.data?.audience || (e.data.audience.treasury && g.settings.publicTreasury) ||
      (e.data.audience.nations || []).some(n => String(n).toLowerCase() === myNation) || (e.data.audience.users || []).includes(req.user.id))
    // Turn summaries are private to the faction unless treasuries are public.
    .filter(e => gm || e.kind !== 'turn' || g.settings.publicTreasury || String(e.data?.faction || '').toLowerCase() === myNation);
  res.json({ events });
});

const ROLL_RE = /^\/(?:roll|r)\s+(\d{0,2})d(\d{1,4})(?:\s*([+-])\s*(\d{1,4}))?\s*(.*)$/i;

router.post('/:id/chat', (req, res) => {
  const message = clean(req.body?.message, 500);
  if (!message) return res.status(400).json({ error: 'Empty message' });
  if (req.body?.channel === 'gm') {
    // GM channel: announcements everyone reads and only the GM writes.
    if (req.lobbyRole !== 'gm') return res.status(403).json({ error: 'Only the GM posts in the GM channel' });
    return res.status(201).json({ event: logEvent(req.lobby.id, req.user.id, 'announce', message) });
  }
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

// ---- Battle effects (gunfire, shelling) --------------------------------------------------------
const qb = {
  insert: db.prepare('INSERT INTO battles (lobby_id, turn, attacker_id, defender_id, kind, ax, ay, dx, dy, hidden, user_id, until_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  one: db.prepare('SELECT * FROM battles WHERE id = ?'),
  all: db.prepare('SELECT * FROM battles WHERE lobby_id = ? AND turn >= ? AND (until_ms IS NULL OR until_ms > ?) ORDER BY id DESC LIMIT 300'),
  insertCrater: db.prepare('INSERT INTO craters (lobby_id, x, y, size, rotation, sprite, turn, expires_turn, until_ms, hidden, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  crater: db.prepare('SELECT * FROM craters WHERE id = ?'),
  dropFor: db.prepare('DELETE FROM battles WHERE lobby_id = ? AND (attacker_id = ? OR defender_id = ?)'),
  craters: db.prepare('SELECT * FROM craters WHERE lobby_id = ? AND expires_turn > ? AND (until_ms IS NULL OR until_ms > ?) ORDER BY id LIMIT 3000'),
};
/** Crater sprites on the crater sheet (rob assets/tile-B-04.png → sprite atlas misc-04): plain, dark and scorched. */
const CRATER_SPRITES = [0, 3, 6, 22, 36, 40, 60, 72, 75, 95, 96, 98, 108, 117, 119, 127, 134, 135, 138, 139];
function serializeCrater(c) {
  return { id: c.id, x: c.x, y: c.y, size: c.size, rotation: c.rotation, sprite: `sprite:misc-04:${c.sprite}`, turn: c.turn, expiresTurn: c.expires_turn, until: c.until_ms };
}
function serializeBattle(b, lobby) {
  const sea = lobby ? !require('../territory').landAt(lobby, b.dx, b.dy) : false;
  return { id: b.id, turn: b.turn, attackerId: b.attacker_id, defenderId: b.defender_id, kind: b.kind, ax: b.ax, ay: b.ay, dx: b.dx, dy: b.dy, sea, until: b.until_ms, createdAt: b.created_at };
}
// ---- Convoys: troops embark on transports, sail, and land together (docs/UNITS.md) ---------------------------
const isConvoy = m => !!m && m.type === 'unit' && UnitTypes.resolve(m.data?.unitType)?.id === 'transport';
function cargoOf(lobbyId, convoyId) {
  return q.markers.all(lobbyId).map(access.serializeMarker).filter(m => Number(m.data?.aboard) === Number(convoyId));
}
/** A line in the log for a nation's side only under fog of war (everyone otherwise). */
function sideLog(req, nation, message) {
  const names = vision.on(req.lobby.id) ? vision.sideNames(req.lobby.id, nation) : null;
  if (!names) return logEvent(req.lobby.id, req.user.id, 'system', message);
  const set = new Set(names.map(n => n.toLowerCase()));
  return logEvent(req.lobby.id, req.user.id, 'system', message, { audience: { nations: names, users: [req.user.id] } },
    ws => ws.lobbyRole === 'gm' || ws.user.id === req.user.id || set.has(String(ws.nation || '').toLowerCase()));
}
/** Troops aboard sail with their convoy. */
function moveCargo(req, convoy) {
  for (const m of cargoOf(req.lobby.id, convoy.id)) {
    if (m.x === convoy.x && m.y === convoy.y) continue;
    q.moveMarker.run(convoy.x, convoy.y, now(), m.id);
    commitChange(req, 'marker', 'update', m, access.serializeMarker(q.marker.get(m.id, req.lobby.id)));
  }
}
/** A convoy sunk or removed: everyone aboard goes down with it. */
function sinkCargo(req, convoy, why) {
  const lost = cargoOf(req.lobby.id, convoy.id);
  for (const m of lost) {
    q.deleteMarker.run(m.id);
    qb.dropFor.run(req.lobby.id, m.id, m.id);
    commitChange(req, 'marker', 'delete', m, null);
  }
  if (lost.length) sideLog(req, convoy.data?.nation, `⚓ ${convoy.name} ${why}: ${lost.map(m => m.name).join(', ')} went down with it`);
  return lost;
}
function nearestTownName(lobbyId, x, y) {
  let best = null, bd = Infinity;
  for (const r of q.markers.all(lobbyId)) { if (r.type !== 'town') continue; const d = (r.x - x) ** 2 + (r.y - y) ** 2; if (d < bd) { bd = d; best = r.name; } }
  return best;
}
function loadConvoy(req, res) {
  const row = q.marker.get(Number(req.params.cid), req.lobby.id);
  const c = row && access.serializeMarker(row);
  if (!c || !access.canSee(c, viewerOf(req)) || !isConvoy(c)) { res.status(404).json({ error: 'No such convoy' }); return null; }
  if (!canEditMarker(req, c)) { res.status(403).json({ error: `You do not command ${c.name}` }); return null; }
  if (num(c.data?.strength, 100) <= 0) { res.status(409).json({ error: `${c.name} has been destroyed` }); return null; }
  return c;
}
/** Spent for the turn (game mode): boarding or landing takes the rest of a unit's move. */
function spentMove(g, m) { return Math.max(num(m.data?.movedKm), (num(m.data?.movement) + 10) * num(g.settings.kmPerMove, 50)); }

/** Embark land units (and heroes) next to a convoy: up to convoyCapacity aboard at once. */
router.post('/:id/convoys/:cid/embark', (req, res) => {
  const convoy = loadConvoy(req, res);
  if (!convoy) return;
  const g = game.get(req.lobby.id), s = g.settings, gm = req.lobbyRole === 'gm', v = viewerOf(req);
  const cap = num(s.convoyCapacity, 10), boardKm = num(s.convoyBoardKm, 30);
  let aboard = cargoOf(req.lobby.id, convoy.id).length;
  const ids = Array.isArray(req.body?.unitIds) ? req.body.unitIds.slice(0, 50) : [];
  const done = [], errors = [];
  const territory = require('../territory');
  for (const id of ids) {
    const row = q.marker.get(Number(id), req.lobby.id);
    const m = row && access.serializeMarker(row);
    if (!m || !access.canSee(m, v)) { errors.push(`${id}: not found`); continue; }
    if (!canEditMarker(req, m)) { errors.push(`${m.name}: not yours`); continue; }
    const land = m.type === 'hero' ? !['captured', 'travelling'].includes(m.data?.status) : territory.isLandUnit(m);
    if (!land) { errors.push(`${m.name}: only land units and heroes embark`); continue; }
    if (m.data?.aboard) { errors.push(`${m.name}: already aboard`); continue; }
    if (m.type === 'unit' && num(m.data?.strength, 100) <= 0) { errors.push(`${m.name}: destroyed`); continue; }
    if (!gm && String(m.data?.nation || '').toLowerCase() !== String(convoy.data?.nation || '').toLowerCase()) { errors.push(`${m.name}: not of ${convoy.data?.nation || 'the convoy'}'s nation`); continue; }
    if (geo.distance(req.lobby, m.x, m.y, convoy.x, convoy.y) > boardKm) { errors.push(`${m.name}: more than ${boardKm} ${geo.isEarth(req.lobby) ? 'km' : (req.lobby.scale_label || 'units')} from ${convoy.name}`); continue; }
    if (aboard >= cap) { errors.push(`${convoy.name} is full (${cap})`); break; }
    const data = { aboard: convoy.id, supplied: true, unsuppliedTurns: 0, trail: [[convoy.x, convoy.y]] };
    if (g.enabled) data.movedKm = spentMove(g, m);
    done.push(writeMarker(req, m, { x: convoy.x, y: convoy.y, data }));
    aboard++;
  }
  if (done.length) sideLog(req, convoy.data?.nation, `⛴ ${done.map(m => m.name).join(', ')} embarked on ${convoy.name} (${aboard}/${cap} aboard)`);
  if (!done.length) return res.status(409).json({ error: errors.join('; ') || 'Nobody to embark' });
  res.json({ embarked: done, errors, aboard, capacity: cap });
});

/** Land everyone aboard at once on the nearest beach within convoyLandKm; with none in reach they stay aboard. */
router.post('/:id/convoys/:cid/disembark', (req, res) => {
  const convoy = loadConvoy(req, res);
  if (!convoy) return;
  const g = game.get(req.lobby.id), s = g.settings, landKm = num(s.convoyLandKm, 100);
  const cargo = cargoOf(req.lobby.id, convoy.id);
  if (!cargo.length) return res.status(400).json({ error: `Nobody is aboard ${convoy.name}` });
  const territory = require('../territory');
  const beach = territory.nearestLand(req.lobby, convoy.x, convoy.y, landKm);
  if (!beach) return res.status(409).json({ error: `No beach within ${landKm} ${geo.isEarth(req.lobby) ? 'km' : (req.lobby.scale_label || 'units')}: sail ${convoy.name} closer to the coast` });
  // They come ashore together, spread a little along the beach (on land where possible).
  const spots = cargo.map((_, i) => {
    if (i === 0) return beach;
    const ring = 1 + Math.floor((i - 1) / 6), a = ((i - 1) % 6) / 6 * Math.PI * 2 + ring * 0.5, r = 1.1 * ring;
    const x = Math.round((beach.x + Math.cos(a) * r) * 10) / 10, y = Math.round((beach.y + Math.sin(a) * r) * 10) / 10;
    return territory.landAt(req.lobby, x, y) ? { x, y } : beach;
  });
  const landed = cargo.map((m, i) => {
    const data = { aboard: 0, trail: [[spots[i].x, spots[i].y]] };
    if (g.enabled) data.movedKm = spentMove(g, m);
    return writeMarker(req, m, { x: spots[i].x, y: spots[i].y, data });
  });
  const place = nearestTownName(req.lobby.id, beach.x, beach.y);
  sideLog(req, convoy.data?.nation, `⚓ ${landed.length} unit${landed.length === 1 ? '' : 's'} landed from ${convoy.name}${place ? ` near ${place}` : ''}: ${landed.map(m => m.name).join(', ')}`);
  // Landing on enemy ground takes it like any advance (defended ground holds).
  const notes = landed.map(m => afterMove(req, m)).filter(Boolean);
  res.json({ landed, beach, note: notes.join(' · ') || null });
});

/** This turn's battles the viewer may see (hidden ones: the GM and the attacking player). */
router.get('/:id/battles', (req, res) => {
  const g = game.get(req.lobby.id);
  const gm = req.lobbyRole === 'gm';
  const mine = b => gm || !b.hidden || b.user_id === req.user.id;
  // Fog of war: a fight is seen by the two sides in it (and the GM), not by everyone.
  const side = !gm && vision.on(req.lobby.id) ? new Set((vision.sideNames(req.lobby.id, req.member?.nation) || []).map(n => n.toLowerCase())) : null;
  const nationOf = side ? (() => { const by = new Map(q.markers.all(req.lobby.id).map(r => [r.id, String(access.safeJson(r.data).nation || '').toLowerCase()])); return id => by.get(id) || ''; })() : null;
  const ours = b => !side || b.user_id === req.user.id || side.has(nationOf(b.attacker_id)) || side.has(nationOf(b.defender_id));
  res.json({
    battles: qb.all.all(req.lobby.id, g.turn, Date.now()).filter(b => mine(b) && ours(b)).map(b => serializeBattle(b, req.lobby)),
    craters: qb.craters.all(req.lobby.id, g.turn, Date.now()).filter(mine).map(serializeCrater),
  });
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
  if (a.data?.aboard || d.data?.aboard) return res.status(400).json({ error: 'Troops aboard a convoy cannot fight: attack the convoy, or land them first' });
  const g = game.get(req.lobby.id);
  // Never your own side: same nation, or an ally while the game is on.
  const nationA = String(a.data?.nation || '').toLowerCase(), nationD = String(d.data?.nation || '').toLowerCase();
  if (nationA && nationA === nationD) return res.status(400).json({ error: `${d.name} is on ${a.name}'s own side` });
  if (g.enabled && nationA && nationD) {
    const factions = q.factions.all(req.lobby.id);
    const fa = factions.find(f => f.name.toLowerCase() === nationA), fd = factions.find(f => f.name.toLowerCase() === nationD);
    if (fa && fd && game.relationStatus(req.lobby.id, fa.id, fd.id) === 'alliance') return res.status(400).json({ error: `${d.data.nation} is allied with ${a.data.nation}` });
  }
  const apError = game.checkAttack(g, req.lobbyRole === 'gm', a);
  if (apError) return res.status(409).json({ error: apError });
  const rangeError = game.checkRange(req.lobby, g, req.lobbyRole === 'gm', a, d);
  if (rangeError) return res.status(409).json({ error: rangeError });
  if (g.enabled) a.data = { ...a.data, apUsed: num(a.data.apUsed) + 1 };   // spent even if the attack is repelled
  // Fog of war: the fight is news only to the two sides, and firing gives the attacker away: the defender's
  // side sees it until End turn (the same reveal a spy's recon gives).
  const fogSides = vision.on(req.lobby.id) ? [...new Set([...(vision.sideNames(req.lobby.id, a.data?.nation) || []), ...(vision.sideNames(req.lobby.id, d.data?.nation) || [])])] : null;
  if (fogSides && d.data?.nation) {
    const seenBy = vision.sideNames(req.lobby.id, d.data.nation) || [];
    a.data = { ...a.data, revealTo: [...new Set([...(Array.isArray(a.data.revealTo) ? a.data.revealTo : []), ...seenBy])] };
  }

  const cfg = access.serializeLobby(req.lobby, 'player').settings.combat;
  const research = require('../research');
  const fxA = game.factionEffects(req.lobby.id, a.data?.nation), fxD = game.factionEffects(req.lobby.id, d.data?.nation);
  const bonusA = research.statBonus(fxA, UnitTypes.resolve(a.data?.unitType)), bonusD = research.statBonus(fxD, UnitTypes.resolve(d.data?.unitType));
  const cover = require('../territory').trenchCover(req.lobby, g.settings, d, q.shapes.all(req.lobby.id).map(access.serializeShape));
  if (cover) cover.bonus += fxD.cover;
  // Generals: the best general of each side within the aura adds to attack and defend.
  const allMarkers = q.markers.all(req.lobby.id).map(access.serializeMarker);
  const genA = heroRules.generalFor(req.lobby, g.settings, allMarkers, a), genD = heroRules.generalFor(req.lobby, g.settings, allMarkers, d);
  // Support units around each side (HQ, engineers, signals) and the matchup of the two types (docs/UNITS.md).
  const supplyRules = require('../supply');
  const friendsOf = supplyRules.friendsResolver(req.lobby);
  const supA = g.enabled ? supplyRules.supportBonus(req.lobby, g.settings, allMarkers, a, friendsOf) : { attack: 0, defend: 0, notes: [] };
  const supD = g.enabled ? supplyRules.supportBonus(req.lobby, g.settings, allMarkers, d, friendsOf) : { attack: 0, defend: 0, notes: [] };
  const typeA = UnitTypes.resolve(a.data?.unitType), typeD = UnitTypes.resolve(d.data?.unitType);
  const match = Matchups.matchup(typeA, typeD, { entrenched: !!cover });
  const atk = num(a.data.attack) + bonusA.attack + (genA ? genA.bonus : 0) + supA.attack + match.mod;
  const def = num(d.data.defend) + bonusD.defend + (cover ? cover.bonus : 0) + (genD ? genD.bonus : 0) + supD.defend;
  // Cut off from supply, the defender breaks more easily: a successful attack does double damage.
  const cutOffD = g.enabled && g.settings.supplyEnabled !== false && d.data?.supplied === false;
  const aRoll = crypto.randomInt(1, cfg.die + 1), dRoll = crypto.randomInt(1, cfg.die + 1);
  const aTotal = aRoll + atk, dTotal = dRoll + def;
  const margin = aTotal - dTotal;
  let aLoss, dLoss, outcome;
  if (margin > 0) { dLoss = (cfg.baseLoss + margin * cfg.marginMult) * (cutOffD ? 2 : 1); aLoss = cfg.winnerLoss; outcome = 'attacker'; }
  else if (margin < 0) { aLoss = cfg.baseLoss - margin * cfg.marginMult; dLoss = cfg.winnerLoss; outcome = 'defender'; }
  else { aLoss = dLoss = Math.ceil(cfg.baseLoss / 2); outcome = 'tie'; }
  aLoss = Math.round(aLoss); dLoss = Math.round(dLoss);
  // Artillery fires from range: a repelled or drawn bombardment costs the guns nothing.
  const artilleryA = UnitTypes.resolve(a.data?.unitType)?.cat === 'Artillery';
  const sparedA = artilleryA && outcome !== 'attacker' && aLoss > 0;
  if (sparedA) aLoss = 0;

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
  const aAfter = apply(a, aLoss), dAfter = apply(d, dLoss);
  for (const m of [aAfter, dAfter]) if (isConvoy(m) && num(m.data?.strength, 100) <= 0) sinkCargo(req, m, 'was sunk');

  const fmt = (m, l) => `${m.name} ${l.loss ? `loses ${l.loss}% (${l.from}→${l.to}${l.to === 0 ? ', destroyed' : ''})` : 'is unharmed'}`;
  const notes = [bonusA.attack ? `attacker +${bonusA.attack} tech` : '', genA ? `attacker +${genA.bonus} ${genA.hero.name}` : '',
    bonusD.defend ? `defender +${bonusD.defend} tech` : '', genD ? `defender +${genD.bonus} ${genD.hero.name}` : '', cover ? `+${cover.bonus} trench cover` : '',
    ...supA.notes.map(n => `attacker ${n}`), ...supD.notes.filter(n => !/spotting/.test(n)).map(n => `defender ${n}`), ...(supD.defendNotes || []).map(n => `defender ${n}`),
    ...match.notes.map(n => `${n.mod > 0 ? '+' : ''}${n.mod} ${n.text}`),
    cutOffD ? `${d.name} is out of supply${outcome === 'attacker' ? ': double losses' : ''}` : '',
    sparedA ? 'guns out of reach of the reply' : ''].filter(Boolean);
  const text = `⚔ ${a.name} attacked ${d.name}: ${aRoll}+${atk}=${aTotal} vs ${dRoll}+${def}=${dTotal}${notes.length ? ` (${notes.join(', ')})` : ''} → ` +
    (outcome === 'tie' ? 'stalemate. ' : outcome === 'attacker' ? 'attack succeeds. ' : 'attack repelled. ') +
    `${fmt(d, losses[d.id])}; ${fmt(a, losses[a.id])}`;
  const hidden = !!(a.adminOnly || d.adminOnly || a.visibleTo || d.visibleTo);
  const data = { attackerId: a.id, defenderId: d.id, aRoll, dRoll, aTotal, dTotal, margin, outcome, losses, hidden };
  const fogSet = fogSides && !hidden ? new Set(fogSides.map(n => n.toLowerCase())) : null;
  if (fogSet) data.audience = { nations: fogSides, users: [req.user.id] };
  const audience = hidden ? (ws => ws.lobbyRole === 'gm' || ws.user.id === req.user.id)
    : fogSet ? (ws => ws.lobbyRole === 'gm' || ws.user.id === req.user.id || fogSet.has(String(ws.nation || '').toLowerCase())) : null;
  const event = logEvent(req.lobby.id, req.user.id, 'combat', text, data, audience);
  // The fight stays on the map for the rest of the turn: gunfire between the two, or shells around the target.
  const catA = UnitTypes.resolve(a.data?.unitType)?.cat;
  const kind = catA === 'Artillery' || catA === 'Naval' ? 'shells' : 'gunfire';
  const bid = qb.insert.run(req.lobby.id, g.turn, a.id, d.id, kind, a.x, a.y, d.x, d.y, hidden ? 1 : 0, req.user.id, g.enabled ? null : Date.now() + 5 * 60000, now()).lastInsertRowid;
  hub.broadcast(req.lobby.id, { type: 'battle', battle: serializeBattle(qb.one.get(bid), req.lobby) }, audience);
  // A bombardment leaves four or five craters around the target, for ten turns.
  if (kind === 'shells') {
    const made = [];
    const n = 4 + crypto.randomInt(0, 2);
    const territory = require('../territory');
    for (let i = 0; i < n; i++) {
      // Shells landing in the sea leave no crater: try a few spots and keep the first on land.
      let cx = null, cy = null;
      for (let tries = 0; tries < 4 && cx === null; tries++) {
        const ang = Math.random() * Math.PI * 2, r = 0.8 + Math.random() * 3.4;
        const px = d.x + Math.cos(ang) * r, py = d.y + Math.sin(ang) * r * 0.8;
        if (territory.landAt(req.lobby, px, py)) { cx = px; cy = py; }
      }
      if (cx === null) continue;
      const sprite = CRATER_SPRITES[crypto.randomInt(0, CRATER_SPRITES.length)];
      const cid = qb.insertCrater.run(req.lobby.id, Math.round(cx * 10) / 10, Math.round(cy * 10) / 10,
        Math.round((1.2 + Math.random() * 1.1) * 100) / 100, Math.round(Math.random() * 360), sprite, g.turn, g.turn + 10,
        g.enabled ? null : Date.now() + 24 * 3600000, hidden ? 1 : 0, req.user.id, now()).lastInsertRowid;
      made.push(serializeCrater(qb.crater.get(cid)));
    }
    if (made.length) hub.broadcast(req.lobby.id, { type: 'craters', craters: made }, audience);
  }
  // Defended ground falls once its defenders are beaten: an attacker standing on enemy ground that destroys a
  // defender takes the ground now if no other defender holds it (territory.capture).
  let captureNote = null;
  if (g.enabled && losses[d.id].to === 0 && num(aAfter.data?.strength, 100) > 0) captureNote = afterMove(req, aAfter);
  res.status(201).json({ event, captureNote });
});

module.exports = router;
