'use strict';
const crypto = require('node:crypto');
const { db, now } = require('./db');
const config = require('./config');

// ---- Password hashing (scrypt, built into Node; no native deps) -------------
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), key.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const key = crypto.scryptSync(password, salt, expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// ---- Sessions (random token stored server-side, HttpOnly cookie) -----------
const insertSession = db.prepare(
  'INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)');
const selectSession = db.prepare(`
  SELECT s.token, s.expires_at, u.id, u.username, u.display_name, u.role, u.avatar_url, u.site_vip, u.suspended_at, u.suspended_reason
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = ?`);
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
const deleteExpired = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

function createSession(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  insertSession.run(token, userId, t, t + config.sessionTtlMs, String(userAgent || '').slice(0, 300));
  if (Math.random() < 0.05) deleteExpired.run(t);
  return token;
}

function destroySession(token) { if (token) deleteSession.run(token); }

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  }
  return out;
}

function publicUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role,
    avatarUrl: row.avatar_url || '', siteVip: !!row.site_vip };
}

/** Resolve the logged-in user from a raw http request (works for HTTP and WS upgrade). */
function getUserFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[config.cookieName];
  if (!token) return null;
  const row = selectSession.get(token);
  if (!row) return null;
  if (row.expires_at < now()) { deleteSession.run(token); return null; }
  const user = publicUser(row);
  user.sessionToken = token;
  if (row.suspended_at) user.suspended = { at: row.suspended_at, reason: row.suspended_reason || '' };
  return user;
}
/** What a suspended account is told, everywhere it knocks. */
function suspendedMessage(user) {
  return `Your account has been suspended${user.suspended?.reason ? `: ${user.suspended.reason}` : ''}`;
}
function refuseSuspended(req, res) {
  if (!req.user?.suspended) return false;
  res.status(403).json({ error: suspendedMessage(req.user), suspended: true });
  return true;
}

function cookieAttrs(maxAgeSec) {
  return [
    'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`,
    config.secureCookies ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${config.cookieName}=${encodeURIComponent(token)}; ${cookieAttrs(Math.floor(config.sessionTtlMs / 1000))}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${config.cookieName}=; ${cookieAttrs(0)}`);
}

// ---- Express middleware ------------------------------------------------------
function attachUser(req, res, next) {
  req.user = getUserFromRequest(req);
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (refuseSuspended(req, res)) return;
  next();
}

function requireSiteAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (refuseSuspended(req, res)) return;
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Site admin only' });
  next();
}

// ---- Tiny in-memory login rate limiter ---------------------------------------
const attempts = new Map(); // key -> { count, resetAt }
function loginLimiter(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const t = now();
  let rec = attempts.get(key);
  if (!rec || rec.resetAt < t) { rec = { count: 0, resetAt: t + 15 * 60 * 1000 }; attempts.set(key, rec); }
  if (rec.count >= 20) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  rec.count++;
  res.on('finish', () => { if (res.statusCode < 400) rec.count = Math.max(0, rec.count - 1); });
  next();
}

module.exports = {
  hashPassword, verifyPassword,
  createSession, destroySession, getUserFromRequest,
  setSessionCookie, clearSessionCookie,
  attachUser, requireAuth, requireSiteAdmin, loginLimiter, publicUser, suspendedMessage, refuseSuspended,
};
