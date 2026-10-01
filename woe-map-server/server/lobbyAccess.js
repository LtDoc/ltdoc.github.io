'use strict';
const { db } = require('./db');

const selectLobby = db.prepare('SELECT * FROM lobbies WHERE id = ?');
const selectMember = db.prepare('SELECT * FROM lobby_members WHERE lobby_id = ? AND user_id = ?');
const selectFaction = db.prepare('SELECT * FROM factions WHERE id = ? AND lobby_id = ?');
const selectMembers = db.prepare(`
  SELECT m.user_id, m.role, m.nation, m.color, m.joined_at, u.username, u.display_name
  FROM lobby_members m JOIN users u ON u.id = m.user_id
  WHERE m.lobby_id = ? ORDER BY m.role DESC, u.display_name COLLATE NOCASE`);

function getLobby(id) { return selectLobby.get(Number(id)) || null; }
function getMember(lobbyId, userId) { return selectMember.get(Number(lobbyId), Number(userId)) || null; }
function getMembers(lobbyId) { return selectMembers.all(Number(lobbyId)); }

/** Returns 'gm' | 'player' | null for a user in a lobby. Site admins are GMs everywhere. */
function getRole(lobby, user) {
  if (!lobby || !user) return null;
  if (user.role === 'admin' || lobby.owner_id === user.id) return 'gm';
  const m = getMember(lobby.id, user.id);
  return m ? m.role : null;
}

/**
 * "View as player" (docs/UI.md): a GM may use the campaign as one nation's player, seeing what it sees and
 * held to its rules. Returns that faction when `fid` names one of this lobby's and the role really is GM.
 */
function viewAsFaction(lobby, role, fid) {
  if (role !== 'gm' || !fid || !Number.isFinite(Number(fid))) return null;
  return selectFaction.get(Number(fid), lobby.id) || null;
}

/**
 * A "viewer" bundles what visibility rules need: role, user id and nation.
 * Viewing as a nation, a GM is a player of it (`viewAs` its faction id, `realRole` still 'gm').
 */
function viewerFor(lobby, user, viewAs) {
  const role = getRole(lobby, user);
  if (!role) return null;
  const f = viewAsFaction(lobby, role, viewAs);
  if (f) return { role: 'player', realRole: 'gm', userId: user.id, nation: f.name, viewAs: f.id };
  const m = getMember(lobby.id, user.id);
  return { role, userId: user.id, nation: m ? m.nation : '' };
}

const sameNation = (a, b) => !!String(b || '').trim() && String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * May this viewer move, edit or give orders to a marker? GMs anything; players what they own.
 * A GM viewing as a nation commands that nation's units and heroes instead of everything they created.
 */
function canControl(m, viewer) {
  if (!m || !viewer) return false;
  if (viewer.role === 'gm') return true;
  if (m.adminOnly) return false;
  if (viewer.viewAs && (m.type === 'unit' || m.type === 'hero')) return sameNation(m.data?.nation, viewer.nation);
  return m.ownerId === viewer.userId;
}

/**
 * Can this viewer see a serialized marker or shape?
 * GMs see everything. Players never see GM-only items. Owners/creators always see their own.
 * Otherwise an item restricted to nations is visible only if the viewer's nation is listed.
 */
function canSee(obj, viewer) {
  if (!obj || !viewer) return false;
  if (viewer.role === 'gm') return true;
  if (obj.adminOnly) return false;
  const n = String(viewer.nation || '').trim().toLowerCase();
  // A GM viewing as a nation sees what that nation's player would: its own things, not everything the GM made.
  const mine = viewer.viewAs ? sameNation(obj.data?.nation, n)
    : obj.ownerId === viewer.userId || obj.createdBy === viewer.userId;
  if (mine) return true;
  const listed = list => !!n && Array.isArray(list) && list.some(v => String(v).trim().toLowerCase() === n);
  // A spy's recon reveals what it saw to the spy's nation until the end of the turn.
  if (listed(obj.data?.revealTo)) return true;
  // Spies are secret: their own nation sees them, and anyone the GM lists under "Visible to".
  if (obj.type === 'hero' && obj.data?.role === 'spy') {
    return (!!n && String(obj.data.nation || '').trim().toLowerCase() === n) || listed(obj.visibleTo);
  }
  const vt = obj.visibleTo;
  if (!vt || !vt.length) return true;
  return listed(vt);
}

const DEFAULT_COMBAT = { die: 20, baseLoss: 10, marginMult: 2, winnerLoss: 5 };

function serializeLobby(lobby, role) {
  const settings = safeJson(lobby.settings);
  settings.combat = { ...DEFAULT_COMBAT, ...(settings.combat || {}) };
  settings.tokenScale = Number(settings.tokenScale) || 1;
  settings.tokenMode = settings.tokenMode === 'screen' ? 'screen' : 'map';
  const out = {
    id: lobby.id,
    name: lobby.name,
    ownerId: lobby.owner_id,
    mapUrl: lobby.map_file ? `/uploads/${lobby.map_file}` : null,
    mapKind: lobby.map_file ? 'image' : (settings.earth ? 'earth' : 'none'),
    mapWidth: lobby.map_width,
    mapHeight: lobby.map_height,
    scaleLabel: lobby.scale_label,
    unitsPerPx: lobby.units_per_px,
    settings,
    createdAt: lobby.created_at,
    yourRole: role,
  };
  if (role === 'gm') out.joinCode = lobby.join_code;
  return out;
}

function serializeMember(m) {
  return {
    userId: m.user_id, username: m.username, displayName: m.display_name,
    role: m.role, nation: m.nation, color: m.color, joinedAt: m.joined_at,
  };
}

function parseVisibleTo(s) {
  const v = safeJson(s || 'null');
  return Array.isArray(v) && v.length ? v : null;
}

function serializeMarker(row) {
  return {
    id: row.id,
    lobbyId: row.lobby_id,
    type: row.type,
    name: row.name,
    x: row.x,
    y: row.y,
    iconUrl: row.icon_file ? `/uploads/${row.icon_file}` : (row.icon_url || null),
    iconFile: row.icon_file || null,
    color: row.color,
    adminOnly: !!row.admin_only,
    visibleTo: parseVisibleTo(row.visible_to),
    locked: !!row.locked,
    ownerId: row.owner_id,
    data: safeJson(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeFaction(row) {
  return {
    id: row.id, name: row.name, color: row.color,
    flagUrl: row.flag_file ? `/uploads/${row.flag_file}` : (row.flag_asset ? `/flags/${encodeURIComponent(row.flag_asset)}` : null),
    flagAsset: row.flag_asset || null,
  };
}

function serializeShape(row) {
  return {
    id: row.id,
    lobbyId: row.lobby_id,
    kind: row.kind,
    label: row.label,
    points: safeJson(row.points || '[]'),
    color: row.color,
    width: row.width,
    data: safeJson(row.data || "{}"),
    adminOnly: !!row.admin_only,
    visibleTo: parseVisibleTo(row.visible_to),
    locked: !!row.locked,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

module.exports = {
  getLobby, getMember, getMembers, getRole, viewerFor, viewAsFaction, canSee, canControl, DEFAULT_COMBAT,
  serializeLobby, serializeMember, serializeMarker, serializeShape, serializeFaction, safeJson,
};
