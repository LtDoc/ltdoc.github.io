'use strict';
const express = require('express');
const { db, now } = require('../db');
const auth = require('../auth');

const router = express.Router();

const countUsers = db.prepare('SELECT COUNT(*) AS n FROM users');
const insertUser = db.prepare(
  'INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)');
const selectByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const selectById = db.prepare('SELECT * FROM users WHERE id = ?');
const updatePassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
const deleteOtherSessions = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?');
const listUsers = db.prepare('SELECT id, username, display_name, role, created_at FROM users ORDER BY id');
const updateRole = db.prepare('UPDATE users SET role = ? WHERE id = ?');
const deleteUser = db.prepare('DELETE FROM users WHERE id = ?');
const countAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
const countOwned = db.prepare('SELECT COUNT(*) AS n FROM lobbies WHERE owner_id = ?');

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
  const { sessionToken, ...user } = req.user;
  res.json({ user });
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
      id: u.id, username: u.username, displayName: u.display_name, role: u.role, createdAt: u.created_at,
    })),
  });
});

router.patch('/users/:id', auth.requireSiteAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { role, password } = req.body || {};
  const row = selectById.get(id);
  if (!row) return res.status(404).json({ error: 'No such user' });
  if (role !== undefined) {
    if (!['admin', 'player'].includes(role)) return res.status(400).json({ error: 'Bad role' });
    if (row.role === 'admin' && role !== 'admin' && countAdmins.get().n <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last site admin' });
    }
    updateRole.run(role, id);
  }
  if (password !== undefined) {
    if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    updatePassword.run(auth.hashPassword(password), id);
    deleteOtherSessions.run(id, '');
  }
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

module.exports = router;
