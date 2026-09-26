'use strict';
const { WebSocketServer } = require('ws');
const { getUserFromRequest } = require('./auth');
const { db } = require('./db');
const access = require('./lobbyAccess');

const rooms = new Map(); // lobbyId -> Set<ws>
let wss = null;

const selectMarker = db.prepare('SELECT * FROM markers WHERE id = ? AND lobby_id = ?');

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function viewer(ws) { return { role: ws.lobbyRole, userId: ws.user.id, nation: ws.nation || '' }; }

function presence(lobbyId) {
  const set = rooms.get(Number(lobbyId));
  const seen = new Map();
  if (set) {
    for (const ws of set) {
      if (!seen.has(ws.user.id)) {
        seen.set(ws.user.id, { id: ws.user.id, displayName: ws.user.displayName, role: ws.lobbyRole });
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
  for (const ws of set) {
    if (ws.readyState !== ws.OPEN) continue;
    const v = viewer(ws);
    const sees = after && access.canSee(after, v);
    const saw = before && access.canSee(before, v);
    if (sees) ws.send(JSON.stringify({ type: entity, action: 'upsert', [entity]: after, actorId }));
    else if (saw) ws.send(JSON.stringify({ type: entity, action: 'delete', id, actorId }));
  }
}

/** Send a message only to sockets that can see the given serialized entity (or to GMs when null). */
function broadcastVisible(lobbyId, msg, obj) {
  broadcast(lobbyId, msg, ws => obj ? access.canSee(obj, viewer(ws)) : ws.lobbyRole === 'gm');
}

function leaveRoom(ws) {
  if (ws.lobbyId == null) return;
  const set = rooms.get(ws.lobbyId);
  if (set) { set.delete(ws); if (set.size === 0) rooms.delete(ws.lobbyId); }
  const old = ws.lobbyId;
  ws.lobbyId = null; ws.lobbyRole = null; ws.nation = '';
  broadcastPresence(old);
}

function joinRoom(ws, lobbyId) {
  const lobby = access.getLobby(lobbyId);
  const v = access.viewerFor(lobby, ws.user);
  if (!lobby || !v) { send(ws, { type: 'error', error: 'Not a member of that campaign' }); return; }
  leaveRoom(ws);
  ws.lobbyId = lobby.id; ws.lobbyRole = v.role; ws.nation = v.nation;
  if (!rooms.has(lobby.id)) rooms.set(lobby.id, new Set());
  rooms.get(lobby.id).add(ws);
  send(ws, { type: 'joined', lobbyId: lobby.id, role: v.role, users: presence(lobby.id) });
  broadcastPresence(lobby.id);
}

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'join': return joinRoom(ws, Number(msg.lobbyId));
    case 'leave': return leaveRoom(ws);
    case 'ping': return send(ws, { type: 'pong', t: msg.t });
    case 'drag': {
      // Ephemeral live-drag preview; the final position is persisted through the REST API.
      if (ws.lobbyId == null) return;
      const id = Number(msg.id), x = Number(msg.x), y = Number(msg.y);
      if (!Number.isFinite(id) || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const row = selectMarker.get(id, ws.lobbyId);
      if (!row) return;
      const m = access.serializeMarker(row);
      if (ws.lobbyRole !== 'gm' && (m.ownerId !== ws.user.id || m.adminOnly)) return;
      broadcast(ws.lobbyId, { type: 'drag', id, x, y, userId: ws.user.id },
        other => other !== ws && access.canSee(m, viewer(other)));
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
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
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
  wss.on('close', () => clearInterval(timer));
}

/** Re-evaluate roles and nations for every socket in a lobby after membership changes. */
function refreshRoles(lobbyId) {
  const set = rooms.get(Number(lobbyId));
  if (!set) return;
  const lobby = access.getLobby(lobbyId);
  for (const ws of [...set]) {
    const v = access.viewerFor(lobby, ws.user);
    if (!v) { leaveRoom(ws); send(ws, { type: 'kicked', lobbyId: Number(lobbyId) }); continue; }
    const changed = v.role !== ws.lobbyRole || v.nation !== ws.nation;
    ws.lobbyRole = v.role; ws.nation = v.nation;
    if (changed) send(ws, { type: 'role', role: v.role, nation: v.nation });
  }
  broadcastPresence(Number(lobbyId));
}

module.exports = { attach, broadcast, broadcastEntity, broadcastVisible, broadcastPresence, presence, refreshRoles };
