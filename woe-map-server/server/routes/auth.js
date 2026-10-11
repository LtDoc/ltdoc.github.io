'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { db, now } = require('../db');
const auth = require('../auth');
const config = require('../config');
const UnitTypes = require('../../public/js/units');
const Packs = require('../packs');
const { imageSize } = require('../imageSize');

const router = express.Router();

const countUsers = db.prepare('SELECT COUNT(*) AS n FROM users');
const insertUser = db.prepare(
  'INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)');
const selectByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const selectById = db.prepare('SELECT * FROM users WHERE id = ?');
const updatePassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
const deleteOtherSessions = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?');
const listUsers = db.prepare('SELECT id, username, display_name, role, avatar_url, site_vip, created_at, suspended_at, suspended_reason FROM users ORDER BY id');
const updateProfile = db.prepare('UPDATE users SET display_name = ? WHERE id = ?');
const selectAudio = db.prepare('SELECT music_volume AS musicVolume, music_enabled AS musicEnabled FROM users WHERE id = ?');
const updateAudio = db.prepare('UPDATE users SET music_volume = COALESCE(?, music_volume), music_enabled = COALESCE(?, music_enabled) WHERE id = ?');
function audioSettings(userId) {
  const settings = selectAudio.get(userId);
  if (settings.musicEnabled !== null) settings.musicEnabled = !!settings.musicEnabled;
  return settings;
}
const updateAvatar = db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?');
const updateVip = db.prepare('UPDATE users SET site_vip = ? WHERE id = ?');
const ownedPacks = db.prepare('SELECT pack_id FROM user_packs WHERE user_id = ?');
const grantPack = db.prepare('INSERT OR IGNORE INTO user_packs (user_id, pack_id, granted_at, granted_by) VALUES (?, ?, ?, ?)');
const revokePack = db.prepare('DELETE FROM user_packs WHERE user_id = ? AND pack_id = ?');
const setSuspended = db.prepare('UPDATE users SET suspended_at = ?, suspended_reason = ? WHERE id = ?');
const ownedLobbies = db.prepare('SELECT id FROM lobbies WHERE owner_id = ?');
const updateRole = db.prepare('UPDATE users SET role = ? WHERE id = ?');
const deleteUser = db.prepare('DELETE FROM users WHERE id = ?');
const countAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
const countOwned = db.prepare('SELECT COUNT(*) AS n FROM lobbies WHERE owner_id = ?');
const memberLobbies = db.prepare('SELECT lobby_id FROM lobby_members WHERE user_id = ?');
function refreshMembership(userId) {
  const hub = require('../ws');
  for (const row of memberLobbies.all(userId)) hub.broadcast(row.lobby_id, { type: 'members' });
}

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
// A throwaway hash so failed logins for unknown users take as long as real ones.
const DUMMY_HASH = auth.hashPassword('dummy-password-for-timing');

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
}

router.post('/register', auth.loginLimiter, (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!USERNAME_RE.test(String(username || ''))) {
    return res.status(400).json({ error: 'Username must be 3-24 letters, numbers, . _ or -' });
  }
  if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const display = String(displayName || username).trim().slice(0, 40) || username;
  const role = countUsers.get().n === 0 ? 'admin' : 'player';
  let id;
  try {
    id = insertUser.run(username, display, auth.hashPassword(password), role, now()).lastInsertRowid;
  } catch (e) {
    if (/UNIQUE/.test(String(e.message))) return res.status(409).json({ error: 'That username is taken' });
    throw e;
  }
  const user = auth.publicUser(selectById.get(id));
  auth.setSessionCookie(res, auth.createSession(id, req.headers['user-agent']));
  res.status(201).json({ user, firstUser: role === 'admin' });
});

router.post('/login', auth.loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const row = selectByUsername.get(String(username || ''));
  const ok = row
    ? auth.verifyPassword(String(password || ''), row.password_hash)
    : (auth.verifyPassword(String(password || ''), DUMMY_HASH), false);
  if (!ok) return res.status(401).json({ error: 'Wrong username or password' });
  if (row.suspended_at) return res.status(403).json({ error: `Your account has been suspended${row.suspended_reason ? `: ${row.suspended_reason}` : ''}`, suspended: true });
  auth.setSessionCookie(res, auth.createSession(row.id, req.headers['user-agent']));
  res.json({ user: auth.publicUser(row) });
});

router.post('/logout', (req, res) => {
  if (req.user) auth.destroySession(req.user.sessionToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (auth.refuseSuspended(req, res)) return;
  const { sessionToken, ...user } = req.user;
  res.json({ user });
});

router.get('/me/audio', auth.requireAuth, (req, res) => {
  res.json({ settings: audioSettings(req.user.id) });
});
router.patch('/me/audio', auth.requireAuth, (req, res) => {
  const { musicVolume, musicEnabled } = req.body || {};
  if ((musicVolume === undefined && musicEnabled === undefined) ||
      (musicVolume !== undefined && (typeof musicVolume !== 'number' || !Number.isFinite(musicVolume) || musicVolume < 0 || musicVolume > 20)) ||
      (musicEnabled !== undefined && typeof musicEnabled !== 'boolean')) {
    return res.status(400).json({ error: 'Use a music volume from 0 to 20 and a boolean music enabled setting' });
  }
  updateAudio.run(musicVolume ?? null, musicEnabled === undefined ? null : Number(musicEnabled), req.user.id);
  res.json({ settings: audioSettings(req.user.id) });
});

router.patch('/me/profile', auth.requireAuth, (req, res) => {
  const displayName = String(req.body?.displayName || '').trim();
  if (!displayName || displayName.length > 40 || /[\x00-\x1f\x7f]/.test(displayName)) return res.status(400).json({ error: 'Display name must be 1–40 characters' });
  updateProfile.run(displayName, req.user.id);
  refreshMembership(req.user.id);
  res.json({ user: auth.publicUser(selectById.get(req.user.id)) });
});

const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
router.post('/me/avatar', auth.requireAuth, avatarUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image' });
  const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
  const ext = extensions[req.file.mimetype];
  if (!ext) return res.status(400).json({ error: 'Use a PNG, JPEG, WebP or GIF image' });
  const filename = `avatar-${crypto.randomBytes(12).toString('hex')}${ext}`;
  const file = path.join(config.uploadsDir, filename);
  fs.writeFileSync(file, req.file.buffer);
  const size = imageSize(file);
  if (!size || size.width < 1 || size.height < 1 || size.width > 4096 || size.height > 4096) {
    fs.unlinkSync(file);
    return res.status(400).json({ error: 'Image must be valid and at most 4096 pixels wide or tall' });
  }
  const url = `/uploads/${filename}`;
  updateAvatar.run(url, req.user.id);
  refreshMembership(req.user.id);
  res.json({ user: auth.publicUser(selectById.get(req.user.id)) });
});
router.delete('/me/avatar', auth.requireAuth, (req, res) => {
  updateAvatar.run('', req.user.id);
  refreshMembership(req.user.id);
  res.json({ user: auth.publicUser(selectById.get(req.user.id)) });
});

router.get('/me/packs', auth.requireAuth, (req, res) => {
  const owned = new Set(ownedPacks.all(req.user.id).map(p => p.pack_id));
  res.json({ packs: Packs.all().map(p => ({ ...p, owned: p.included || owned.has(p.id) })) });
});
router.get('/packs', auth.requireSiteAdmin, (req, res) => res.json({ packs: Packs.all() }));

// ---- Notices for the account page: how your reports and takeover requests were answered ----------------
const myReports = db.prepare("SELECT id, lobby_name, user_name, reason, status, close_reason, closed_at, seen_at, created_at FROM reports WHERE reporter_id = ? ORDER BY id DESC LIMIT 30");
const myTakeovers = db.prepare('SELECT id, lobby_id, lobby_name, note, status, reason, resolved_at, seen_at, created_at FROM takeovers WHERE user_id = ? ORDER BY id DESC LIMIT 30');
const seenReports = db.prepare("UPDATE reports SET seen_at = ? WHERE reporter_id = ? AND status = 'closed' AND seen_at IS NULL");
const seenTakeovers = db.prepare("UPDATE takeovers SET seen_at = ? WHERE user_id = ? AND status != 'open' AND seen_at IS NULL");
router.get('/me/notices', auth.requireAuth, (req, res) => {
  const notices = [
    ...myReports.all(req.user.id).map(r => ({ kind: 'report', id: r.id, lobbyName: r.lobby_name, about: r.user_name || '', reason: r.reason, status: r.status,
      answer: r.close_reason || '', answeredAt: r.closed_at, seen: !!r.seen_at || r.status !== 'closed', createdAt: r.created_at })),
    ...myTakeovers.all(req.user.id).map(t => ({ kind: 'takeover', id: t.id, lobbyId: t.lobby_id, lobbyName: t.lobby_name, note: t.note, status: t.status,
      answer: t.reason || '', answeredAt: t.resolved_at, seen: !!t.seen_at || t.status === 'open', createdAt: t.created_at })),
  ].sort((a, b) => (b.answeredAt || b.createdAt) - (a.answeredAt || a.createdAt));
  res.json({ notices, unseen: notices.filter(n => !n.seen).length });
});
router.post('/me/notices/seen', auth.requireAuth, (req, res) => {
  seenReports.run(now(), req.user.id); seenTakeovers.run(now(), req.user.id);
  res.json({ ok: true });
});

router.post('/password', auth.requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  const row = selectById.get(req.user.id);
  if (!auth.verifyPassword(String(current || ''), row.password_hash)) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  if (!validPassword(next)) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  updatePassword.run(auth.hashPassword(next), row.id);
  deleteOtherSessions.run(row.id, req.user.sessionToken);
  res.json({ ok: true });
});

// ---- Site admin: user management --------------------------------------------
router.get('/users', auth.requireSiteAdmin, (req, res) => {
  res.json({
    users: listUsers.all().map(u => ({
      id: u.id, username: u.username, displayName: u.display_name, role: u.role, avatarUrl: u.avatar_url || '', siteVip: !!u.site_vip,
      packs: ownedPacks.all(u.id).map(p => p.pack_id), createdAt: u.created_at,
      suspendedAt: u.suspended_at, suspendedReason: u.suspended_reason || '',
    })),
  });
});

router.patch('/users/:id', auth.requireSiteAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { role, password, suspended, reason, siteVip } = req.body || {};
  const row = selectById.get(id);
  if (!row) return res.status(404).json({ error: 'No such user' });
  // Suspend: signed out everywhere, kept out, and every campaign they own is shut (README, "Accounts and roles").
  if (suspended !== undefined) {
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot suspend yourself' });
    const hub = require('../ws');
    if (suspended) {
      setSuspended.run(now(), String(reason || '').trim().slice(0, 300), id);
      deleteOtherSessions.run(id, '');
      hub.dropUser(id);
      const access = require('../lobbyAccess');
      for (const l of ownedLobbies.all(id)) hub.broadcast(l.id, { type: 'kicked', lobbyId: l.id, reason: access.SUSPENDED_LOBBY });
    } else setSuspended.run(null, null, id);
  }
  if (role !== undefined) {
    if (!['admin', 'player'].includes(role)) return res.status(400).json({ error: 'Bad role' });
    if (row.role === 'admin' && role !== 'admin' && countAdmins.get().n <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last site admin' });
    }
    updateRole.run(role, id);
    refreshMembership(id);
  }
  if (password !== undefined) {
    if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    updatePassword.run(auth.hashPassword(password), id);
    deleteOtherSessions.run(id, '');
  }
  if (siteVip !== undefined) { updateVip.run(siteVip ? 1 : 0, id); refreshMembership(id); }
  res.json({ ok: true });
});

router.put('/users/:id/packs/:packId', auth.requireSiteAdmin, (req, res) => {
  const id = Number(req.params.id), packId = req.params.packId;
  if (!selectById.get(id)) return res.status(404).json({ error: 'No such user' });
  if (!Packs.all().some(p => p.id === packId)) return res.status(400).json({ error: 'Unknown pack' });
  grantPack.run(id, packId, now(), req.user.id);
  res.json({ ok: true });
});
router.delete('/users/:id/packs/:packId', auth.requireSiteAdmin, (req, res) => {
  const id = Number(req.params.id), packId = req.params.packId;
  if (!selectById.get(id)) return res.status(404).json({ error: 'No such user' });
  if (packId === UnitTypes.DEFAULT_PACK) return res.status(400).json({ error: 'The included pack cannot be removed' });
  revokePack.run(id, packId);
  res.json({ ok: true });
});

router.delete('/users/:id', auth.requireSiteAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  const row = selectById.get(id);
  if (!row) return res.status(404).json({ error: 'No such user' });
  if (countOwned.get(id).n > 0) {
    return res.status(400).json({ error: 'User still owns campaigns; delete those first' });
  }
  deleteUser.run(id);
  res.json({ ok: true });
});

// ---- Site admin: every campaign (public/admin.html) ---------------------------------------------
const allLobbies = db.prepare(`SELECT l.id, l.name, l.owner_id, l.created_at, u.display_name AS owner_name,
  (SELECT COUNT(*) FROM lobby_members m WHERE m.lobby_id = l.id) AS members,
  EXISTS(SELECT 1 FROM lobby_members m WHERE m.lobby_id = l.id AND m.user_id = ?) AS member
  FROM lobbies l LEFT JOIN users u ON u.id = l.owner_id ORDER BY l.created_at DESC`);
const lobbyMembers = db.prepare('SELECT m.user_id, m.role, u.display_name FROM lobby_members m JOIN users u ON u.id = m.user_id WHERE m.lobby_id = ? ORDER BY m.role DESC, u.display_name COLLATE NOCASE');
router.get('/lobbies', auth.requireSiteAdmin, (req, res) => {
  const access = require('../lobbyAccess');
  res.json({ lobbies: allLobbies.all(req.user.id).map(l => ({ id: l.id, name: l.name, ownerId: l.owner_id, ownerName: l.owner_name || '?', memberCount: l.members, member: !!l.member, createdAt: l.created_at,
    suspended: access.ownerSuspended({ owner_id: l.owner_id }),
    members: lobbyMembers.all(l.id).map(m => ({ userId: m.user_id, role: m.role, displayName: m.display_name })) })) });
});
/** Hand a campaign to another user (its co-GM after the owner was suspended, or anyone). */
router.post('/lobbies/:id/transfer', auth.requireSiteAdmin, (req, res) => {
  const access = require('../lobbyAccess');
  const lobby = access.getLobby(Number(req.params.id)), user = selectById.get(Number(req.body?.userId));
  if (!lobby) return res.status(404).json({ error: 'No such campaign' });
  if (!user) return res.status(404).json({ error: 'No such user' });
  if (user.suspended_at) return res.status(400).json({ error: 'That account is suspended' });
  if (user.id === lobby.owner_id) return res.status(400).json({ error: 'They own it already' });
  require('./lobbies').transferOwner(lobby, user, req.user);
  res.json({ ok: true });
});
// ---- Takeover requests: a co-GM asking for a shut campaign; approve hands it over ------------------------
const listTakeovers = db.prepare(`SELECT t.*, u.display_name AS user_name, a.display_name AS resolved_by_name FROM takeovers t
  LEFT JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.resolved_by ORDER BY t.status = 'open' DESC, t.id DESC LIMIT 100`);
const takeoverOne = db.prepare('SELECT * FROM takeovers WHERE id = ?');
const resolveTakeover = db.prepare("UPDATE takeovers SET status = ?, reason = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'");
router.get('/takeovers', auth.requireSiteAdmin, (req, res) => {
  res.json({ takeovers: listTakeovers.all().map(t => ({ id: t.id, lobbyId: t.lobby_id, lobbyName: t.lobby_name, userId: t.user_id, userName: t.user_name || '?', note: t.note,
    status: t.status, reason: t.reason, resolvedByName: t.resolved_by_name || '', resolvedAt: t.resolved_at, createdAt: t.created_at })) });
});
router.post('/takeovers/:id/:action', auth.requireSiteAdmin, (req, res) => {
  const t = takeoverOne.get(Number(req.params.id)), action = req.params.action;
  if (!t || t.status !== 'open') return res.status(404).json({ error: 'No such open request' });
  if (!['approve', 'decline'].includes(action)) return res.status(400).json({ error: 'approve or decline' });
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (action === 'approve') {
    const access = require('../lobbyAccess');
    const lobby = t.lobby_id && access.getLobby(t.lobby_id), user = selectById.get(t.user_id);
    if (!lobby || !user) return res.status(404).json({ error: 'The campaign or the user is gone' });
    require('./lobbies').transferOwner(lobby, user, req.user);
  }
  resolveTakeover.run(action === 'approve' ? 'approved' : 'declined', reason, req.user.id, now(), t.id);
  res.json({ ok: true });
});
// A site admin is no GM: to look inside a campaign they join it as a player (and leave from its People panel after).
const access = require('../lobbyAccess');
const joinAsPlayer = db.prepare("INSERT OR IGNORE INTO lobby_members (lobby_id, user_id, role, nation, color, joined_at) VALUES (?, ?, 'player', '', '#95a5a6', ?)");
router.post('/lobbies/:id/join', auth.requireSiteAdmin, (req, res) => {
  const lobby = access.getLobby(Number(req.params.id));
  if (!lobby) return res.status(404).json({ error: 'No such campaign' });
  joinAsPlayer.run(lobby.id, req.user.id, now());
  const hub = require('../ws');
  hub.broadcast(lobby.id, { type: 'members' });
  hub.refreshRoles(lobby.id);
  res.json({ ok: true });
});
/** Delete any campaign (an abusive one), member or not. */
router.delete('/lobbies/:id', auth.requireSiteAdmin, (req, res) => {
  const lobby = access.getLobby(Number(req.params.id));
  if (!lobby) return res.status(404).json({ error: 'No such campaign' });
  require('./lobbies').destroyLobby(lobby);
  res.json({ ok: true });
});

// ---- Site admin: reports from the chats (docs/COMMS.md, "Reporting") ----------------------------
const listReports = db.prepare(`SELECT r.*, a.display_name AS reporter_name, c.display_name AS closed_by_name FROM reports r
  LEFT JOIN users a ON a.id = r.reporter_id LEFT JOIN users c ON c.id = r.closed_by ORDER BY r.status = 'open' DESC, r.id DESC LIMIT 200`);
const closeReport = db.prepare("UPDATE reports SET status = 'closed', closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ? AND status = 'open'");
router.get('/reports', auth.requireSiteAdmin, (req, res) => {
  res.json({ reports: listReports.all().map(r => ({
    id: r.id, kind: r.user_id || r.user_name ? 'user' : 'campaign', lobbyId: r.lobby_id, lobbyName: r.lobby_name, reporterId: r.reporter_id, reporterName: r.reporter_name || '?',
    userId: r.user_id, userName: r.user_name, channel: r.channel, messageId: r.message_id, messageText: r.message_text, reason: r.reason,
    status: r.status, closedByName: r.closed_by_name || '', closedAt: r.closed_at, closeReason: r.close_reason || '', createdAt: r.created_at,
  })) });
});
/** Close a report with a reason: the reporter reads it among the notices on their campaigns page. */
router.post('/reports/:id/close', auth.requireSiteAdmin, (req, res) => {
  closeReport.run(req.user.id, now(), String(req.body?.reason || '').trim().slice(0, 500), Number(req.params.id));
  res.json({ ok: true });
});
/** Delete the message a report is about, member of that campaign or not. */
const reportOne = db.prepare('SELECT * FROM reports WHERE id = ?');
router.delete('/reports/:id/message', auth.requireSiteAdmin, (req, res) => {
  const r = reportOne.get(Number(req.params.id));
  const lobby = r && r.lobby_id && access.getLobby(r.lobby_id);
  if (!r || !lobby || !r.message_id || !r.channel) return res.status(404).json({ error: 'No message to delete' });
  const msg = require('./lobbies').wipeMessage(lobby, r.channel, r.message_id, req.user);
  if (!msg) return res.status(404).json({ error: 'That message is gone already' });
  res.json({ ok: true, message: msg });
});

module.exports = router;
