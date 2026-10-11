'use strict';
const { WebSocketServer } = require('ws');
const { getUserFromRequest } = require('./auth');
const { db } = require('./db');
const access = require('./lobbyAccess');

const rooms = new Map(); // lobbyId -> Set<ws>
let wss = null;

const selectMarker = db.prepare('SELECT * FROM markers WHERE id = ? AND lobby_id = ?');
const selectChat = db.prepare('SELECT members FROM chat_channels WHERE id = ? AND lobby_id = ?');

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function viewer(ws) { return { role: ws.lobbyRole, realRole: ws.realRole, userId: ws.user.id, nation: ws.nation || '', viewAs: ws.viewAs || null, lobbyId: ws.lobbyId }; }
/** Take on a viewer: a GM viewing as a nation is a player of it on this socket (presence still shows the GM). */
function applyViewer(ws, v) {
  ws.lobbyRole = v.role; ws.nation = v.nation; ws.viewAs = v.viewAs || null; ws.realRole = v.realRole || v.role;
}

function presence(lobbyId) {
  const set = rooms.get(Number(lobbyId));
  const seen = new Map();
  if (set) {
    for (const ws of set) {
      if (!seen.has(ws.user.id)) {
        seen.set(ws.user.id, { id: ws.user.id, displayName: ws.user.displayName, role: ws.realRole || ws.lobbyRole });
      }
    }
  }
  return [...seen.values()];
}

/** Broadcast to everyone in a lobby. `filter(ws)` may narrow recipients. */
function broadcast(lobbyId, msg, filter) {
  const set = rooms.get(Number(lobbyId));
  if (!set) return;
  const payload = JSON.stringify(msg);
  for (const ws of set) {
    if (filter && !filter(ws)) continue;
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function broadcastPresence(lobbyId) {
  broadcast(lobbyId, { type: 'presence', users: presence(lobbyId) });
}

/**
 * Push a marker/shape change with per-viewer visibility. Each socket gets an upsert if it can see
 * the new state, a delete if it could see the old state but not the new one, and nothing otherwise.
 * `before`/`after` are serialized entities (null on create/delete).
 */
function broadcastEntity(lobbyId, entity, before, after, actorId) {
  const set = rooms.get(Number(lobbyId));
  if (!set) return;
  const id = (after || before).id;
  const vision = require('./vision');
  for (const ws of set) {
    if (ws.readyState !== ws.OPEN) continue;
    const v = viewer(ws);
    // Another side's trench under fog: the viewer gets the pieces of it in their sight (none, when out of sight).
    if (entity === 'shape') {
      const nowForeign = after && vision.foreignTrench(v, after), wasForeign = before && vision.foreignTrench(v, before);
      if (nowForeign) { syncTrench(ws, v, id, access.canSee(after, v) ? vision.shapeViews(v, after) : [], actorId); continue; }
      if (wasForeign) syncTrench(ws, v, id, [], actorId);   // now the viewer's own side's (or gone): the pieces go, the whole follows below
    }
    const sees = after && access.canSee(after, v);
    const saw = before && access.canSee(before, v);
    if (sees) ws.send(JSON.stringify({ type: entity, action: 'upsert', [entity]: entity === 'marker' ? require('./vision').redact(after, v) : after, actorId }));
    else if (saw) ws.send(JSON.stringify({ type: entity, action: 'delete', id, actorId }));
  }
}

/**
 * Send a message only to sockets that can see the given serialized entity (or to GMs when null). Under fog of
 * war another side's unit is never included, even in sight: its history would show where it has been.
 */
function broadcastVisible(lobbyId, msg, obj) {
  broadcast(lobbyId, msg, ws => obj ? access.canSee(obj, viewer(ws)) && require('./vision').sameSide(viewer(ws), obj) : ws.lobbyRole === 'gm');
}

/**
 * One foreign trench's pieces for a socket, against what it had (ws.fogTrench: trench id -> Map(piece id -> JSON)):
 * new or changed pieces go as upserts, pieces gone from sight as deletes.
 */
function syncTrench(ws, v, trenchId, pieces, actorId = null) {
  if (!ws.fogTrench) ws.fogTrench = new Map();
  const had = ws.fogTrench.get(trenchId) || new Map(), now = new Map();
  for (const p of pieces) {
    const json = JSON.stringify(p);
    now.set(p.id, json);
    if (had.get(p.id) !== json) send(ws, { type: 'shape', action: 'upsert', shape: p, actorId, fog: true });
  }
  for (const id of had.keys()) if (!now.has(id)) send(ws, { type: 'shape', action: 'delete', id, actorId, fog: true });
  if (now.size) ws.fogTrench.set(trenchId, now); else ws.fogTrench.delete(trenchId);
}
/**
 * Fog of war (server/vision.js): after vision changes, send each player the other sides' units that came into
 * sight (upserts) or went out of it (deletes), and their fog overlay and last known positions when those changed.
 * The battlefield too: the pieces of other sides' trenches now in sight, and a fresh fetch of the fighting when
 * what they may see of it changed.
 */
function syncFog(lobbyId, only = null) {
  const set = rooms.get(Number(lobbyId));
  if (!set) return;
  const vision = require('./vision');
  const st = vision.state(lobbyId);
  const byViewer = new Map();   // the same player in several tabs: work it out once
  for (const ws of set) {
    if (ws.readyState !== ws.OPEN || (only && ws !== only)) continue;
    const v = viewer(ws);
    const vk = `${v.role}|${v.userId}|${v.nation}|${v.viewAs || ''}`;
    let view = byViewer.get(vk);
    if (!view) {
      const ov = vision.overlay(v);
      view = { ov, key: JSON.stringify(ov), seen: null };
      if (st.track && v.role !== 'gm') {   // fog of war, or submerged submarines
        view.seen = new Map();
        for (const m of st.markers) if (vision.foreign(v, m) && access.canSee(m, v)) view.seen.set(m.id, m);
      }
      byViewer.set(vk, view);
    }
    if (view.key !== ws.fogKey) { ws.fogKey = view.key; send(ws, { type: 'vision', vision: view.ov }); }
    if (st.on && v.role !== 'gm') {
      if (!view.pieces) { view.pieces = vision.trenchPieces(v); view.fights = vision.fightKey(v); }
      const first = !ws.fogTrench;
      const byTrench = new Map();
      for (const p of view.pieces.values()) { if (!byTrench.has(p.data.of)) byTrench.set(p.data.of, []); byTrench.get(p.data.of).push(p); }
      if (first) { ws.fogTrench = new Map(); for (const [id, list] of byTrench) ws.fogTrench.set(id, new Map(list.map(p => [p.id, JSON.stringify(p)]))); }
      else {
        for (const [id, list] of byTrench) syncTrench(ws, v, id, list);
        for (const id of [...ws.fogTrench.keys()]) if (!byTrench.has(id)) syncTrench(ws, v, id, []);
      }
      // The first load fetched the fighting over HTTP; afterwards a change in what is seen of it means a fresh fetch.
      if (ws.fogFights !== undefined && ws.fogFights !== view.fights) send(ws, { type: 'reload', what: 'battles' });
      ws.fogFights = view.fights;
    } else { ws.fogTrench = null; ws.fogFights = undefined; }
    if (!view.seen) { ws.fogSeen = null; continue; }
    const seen = view.seen;
    const prev = ws.fogSeen;
    if (prev) {
      for (const [id, m] of seen) if (!prev.has(id)) send(ws, { type: 'marker', action: 'upsert', marker: vision.redact(m, v), actorId: null, fog: true });
      for (const id of prev.keys()) if (!seen.has(id)) send(ws, { type: 'marker', action: 'delete', id, actorId: null, fog: true });
    }
    ws.fogSeen = seen;
  }
}

function leaveRoom(ws) {
  if (ws.lobbyId == null) return;
  const set = rooms.get(ws.lobbyId);
  if (set) { set.delete(ws); if (set.size === 0) rooms.delete(ws.lobbyId); }
  const old = ws.lobbyId;
  ws.lobbyId = null; ws.lobbyRole = null; ws.nation = ''; ws.viewAs = null; ws.realRole = null; ws.fogSeen = null; ws.fogKey = null; ws.fogTrench = null; ws.fogFights = undefined;
  broadcastPresence(old);
}

function joinRoom(ws, lobbyId, viewAs) {
  const lobby = access.getLobby(lobbyId);
  const v = lobby && access.viewerFor(lobby, ws.user, viewAs);
  if (!lobby || !v) { send(ws, { type: 'error', error: 'Not a member of that campaign' }); return; }
  if (access.ownerSuspended(lobby)) { send(ws, { type: 'kicked', lobbyId: lobby.id, reason: access.SUSPENDED_LOBBY }); return; }
  leaveRoom(ws);
  ws.lobbyId = lobby.id; applyViewer(ws, v);
  if (!rooms.has(lobby.id)) rooms.set(lobby.id, new Set());
  rooms.get(lobby.id).add(ws);
  send(ws, { type: 'joined', lobbyId: lobby.id, role: v.realRole === 'observer' ? 'observer' : v.role, viewAs: v.viewAs || null, users: presence(lobby.id) });
  broadcastPresence(lobby.id);
  try { syncFog(lobby.id, ws); } catch (e) { console.warn('fog of war on join failed', e); }   // what it sees now, and its overlay
}

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'join': return joinRoom(ws, Number(msg.lobbyId), msg.viewAs);
    case 'leave': return leaveRoom(ws);
    case 'ping': return send(ws, { type: 'pong', t: msg.t });
    case 'typing': {
      if (ws.realRole === 'observer') return;
      // "X is typing…" to the chat's other members (docs/COMMS.md); nothing is stored.
      if (ws.lobbyId == null) return;
      const key = String(msg.channel || '');
      if (key === 'gm' && ws.lobbyRole !== 'gm') return;
      if (Date.now() - (ws.lastTyping || 0) < 1000) return;
      ws.lastTyping = Date.now();
      let inChat = other => other !== ws;
      if (!/^(ooc|gm)$/.test(key)) {
        const m = /^c(\d+)$/.exec(key), row = m && selectChat.get(Number(m[1]), ws.lobbyId);
        const members = row ? access.safeJson(row.members) || [] : [];
        if (!members.includes(ws.user.id)) return;
        inChat = other => other !== ws && members.includes(other.user.id);
      }
      broadcast(ws.lobbyId, { type: 'typing', channel: key, userId: ws.user.id, displayName: ws.user.displayName }, inChat);
      return;
    }
    case 'drag': {
      // Ephemeral live-drag preview; the final position is persisted through the REST API.
      if (ws.lobbyId == null) return;
      const id = Number(msg.id), x = Number(msg.x), y = Number(msg.y);
      if (!Number.isFinite(id) || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const row = selectMarker.get(id, ws.lobbyId);
      if (!row) return;
      const m = access.serializeMarker(row);
      if (!access.canControl(m, viewer(ws))) return;
      // Under fog of war only the unit's own side sees where it is being dragged.
      broadcast(ws.lobbyId, { type: 'drag', id, x, y, userId: ws.user.id },
        other => other !== ws && access.canSee(m, viewer(other)) && require('./vision').sameSide(viewer(other), m));
      return;
    }
    default: return;
  }
}

function attach(server) {
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* ignore */ }
    if (pathname !== '/ws') { socket.destroy(); return; }
    const user = getUserFromRequest(req);
    if (!user || user.suspended) {
      socket.write(`HTTP/1.1 ${user ? '403 Forbidden' : '401 Unauthorized'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.user = user; ws.lobbyId = null; ws.lobbyRole = null; ws.nation = ''; ws.isAlive = true;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', ws => {
    send(ws, { type: 'hello', user: { id: ws.user.id, displayName: ws.user.displayName } });
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', data => handleMessage(ws, data.toString()));
    ws.on('close', () => leaveRoom(ws));
    ws.on('error', () => { /* handled by close */ });
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  const sweep = setInterval(() => { try { sweepIdle(); } catch (e) { console.warn('cache sweep failed', e); } }, 5 * 60000);
  sweep.unref();
  wss.on('close', () => { clearInterval(timer); clearInterval(sweep); });
}

/**
 * Memory: a campaign nobody has had open for IDLE_MS gives back what is cached for it (its provinces, tens of MB on
 * the Earth map, its sight and its railway network). Everything is rebuilt from the database when next needed.
 */
const IDLE_MS = 30 * 60000;
const idleSince = new Map();   // lobbyId -> when it was last seen with nobody connected
function sweepIdle(now = Date.now()) {
  const provinces = require('./provinces'), vision = require('./vision'), rails = require('./rails');
  const ids = new Set([...provinces.cached(), ...vision.cached(), ...rails.cached()].map(Number));
  for (const id of idleSince.keys()) if (!ids.has(id)) idleSince.delete(id);
  for (const id of ids) {
    if (rooms.has(id)) { idleSince.delete(id); continue; }
    if (!idleSince.has(id)) { idleSince.set(id, now); continue; }
    if (now - idleSince.get(id) < IDLE_MS) continue;
    provinces.invalidate(id); vision.invalidate(id); rails.forget(id);
    idleSince.delete(id);
  }
}

/** A suspended account: every socket of theirs closes. */
function dropUser(userId) {
  if (!wss) return;
  for (const ws of wss.clients) if (ws.user?.id === Number(userId)) { send(ws, { type: 'kicked', reason: 'Your account has been suspended' }); ws.close(); }
}
/** Re-evaluate roles and nations for every socket in a lobby after membership changes. */
function refreshRoles(lobbyId) {
  const set = rooms.get(Number(lobbyId));
  if (!set) return;
  const lobby = access.getLobby(lobbyId);
  for (const ws of [...set]) {
    const v = access.viewerFor(lobby, ws.user, ws.viewAs);
    if (!v) { leaveRoom(ws); send(ws, { type: 'kicked', lobbyId: Number(lobbyId) }); continue; }
    const changed = v.role !== ws.lobbyRole || v.realRole !== ws.realRole || v.nation !== ws.nation || (v.viewAs || null) !== ws.viewAs;
    applyViewer(ws, v);
    if (changed) { ws.fogSeen = null; ws.fogTrench = null; ws.fogFights = undefined; send(ws, { type: 'role', role: v.realRole === 'observer' ? 'observer' : v.role, nation: v.nation, viewAs: v.viewAs || null }); }
  }
  broadcastPresence(Number(lobbyId));
  require('./vision').schedulePush(lobbyId);
}

module.exports = { attach, sweepIdle, broadcast, broadcastEntity, broadcastVisible, broadcastPresence, presence, refreshRoles, syncFog, viewerOf: viewer, dropUser };
