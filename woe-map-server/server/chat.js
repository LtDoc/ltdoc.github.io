'use strict';
// Chat-only metadata and queries. Rooms retain their existing event IDs so old
// conversations/read receipts survive upgrades; the game Log filters them out.
const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS chat_preferences (
  lobby_id INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  notifications TEXT NOT NULL DEFAULT 'all',
  PRIMARY KEY(lobby_id, user_id, channel)
);
CREATE TABLE IF NOT EXISTS chat_pins (
  lobby_id INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, message_id INTEGER NOT NULL,
  PRIMARY KEY(lobby_id, channel, message_id)
);
CREATE TABLE IF NOT EXISTS chat_requests (
  lobby_id INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL, channel TEXT NOT NULL, message_id INTEGER,
  PRIMARY KEY(lobby_id, user_id, token)
);`);

const roomKinds = { ooc: ['chat', 'roll'], gm: ['announce', 'announce'] };
const isRoom = key => Object.hasOwn(roomKinds, key);
function source(lobbyId, channel) {
  return isRoom(channel)
    ? { table: 'events', where: 'm.lobby_id = ? AND m.kind IN (?, ?)', args: [lobbyId, ...roomKinds[channel]] }
    : { table: 'chat_messages', where: 'm.lobby_id = ? AND m.channel_id = ?', args: [lobbyId, Number(channel.slice(1))] };
}
function rows(lobbyId, channel, { after, before, limit = 60, q = '', mentioned, pins = false } = {}) {
  const s = source(lobbyId, channel), args = [...s.args];
  let where = s.where;
  if (after != null) { where += ' AND m.id > ?'; args.push(after); }
  if (before != null) { where += ' AND m.id < ?'; args.push(before); }
  if (q || mentioned || pins) where += " AND json_extract(m.data, '$.deleted') IS NULL";
  if (q) { where += " AND m.message LIKE ? ESCAPE '\\'"; args.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`); }
  if (mentioned) { where += " AND EXISTS (SELECT 1 FROM json_each(m.data, '$.mentions') j WHERE json_extract(j.value, '$.userId') = ?)"; args.push(mentioned); }
  if (pins) { where += ' AND m.id IN (SELECT message_id FROM chat_pins WHERE lobby_id = ? AND channel = ?)'; args.push(lobbyId, channel); }
  const direction = after != null ? 'ASC' : 'DESC';
  args.push(limit + 1);
  const result = db.prepare(`SELECT m.*, u.display_name FROM ${s.table} m LEFT JOIN users u ON u.id = m.user_id WHERE ${where} ORDER BY m.id ${direction} LIMIT ?`).all(...args);
  const more = result.length > limit;
  result.length = Math.min(result.length, limit);
  if (direction === 'DESC') result.reverse();
  return { rows: result, more };
}
function row(lobbyId, channel, id) {
  const s = source(lobbyId, channel);
  return db.prepare(`SELECT m.*, u.display_name FROM ${s.table} m LEFT JOIN users u ON u.id = m.user_id WHERE ${s.where} AND m.id = ?`).get(...s.args, id);
}
function metadata(message, members, replyTo, lobbyId, channel) {
  const mentions = [];
  // Resolve names on the server, and only against this conversation's members.
  const resolve = name => members.find(m => m.username === name) || (() => {
    const matches = members.filter(m => m.username.toLowerCase() === name.toLowerCase());
    return matches.length === 1 ? matches[0] : null;
  })();
  for (const match of message.matchAll(/(^|[^\w@])@([A-Za-z0-9_.-]+)/g)) {
    let name = match[2], user = resolve(name);
    // Prefer an exact username (dots are legal), then treat trailing dots as punctuation.
    while (!user && name.endsWith('.')) { name = name.slice(0, -1); user = resolve(name); }
    const start = match.index + match[1].length;
    if (user) mentions.push({ userId: user.user_id, start, end: start + name.length + 1 });
  }
  const data = { ...(mentions.length ? { mentions } : {}) };
  if (replyTo != null) {
    const reply = row(lobbyId, channel, Number(replyTo));
    if (!reply) throw new Error('The message you are replying to is not in this chat');
    data.replyTo = reply.id;
  }
  return data;
}
function decorate(message, lobbyId) {
  if (!message.data?.deleted && message.data?.replyTo) {
    const reply = row(lobbyId, message.channel, message.data.replyTo);
    message.reply = reply ? { id: reply.id, name: reply.display_name || 'System', text: reply.message.slice(0, 180) } : { id: message.data.replyTo, name: '', text: 'Message unavailable' };
  }
  message.pinned = !!db.prepare('SELECT 1 FROM chat_pins WHERE lobby_id = ? AND channel = ? AND message_id = ?').get(lobbyId, message.channel, message.id);
  return message;
}
function mentionCount(lobbyId, channel, userId, after) {
  const s = source(lobbyId, channel);
  return db.prepare(`SELECT COUNT(*) AS n FROM ${s.table} m WHERE ${s.where} AND m.id > ? AND m.user_id != ? AND json_extract(m.data, '$.deleted') IS NULL AND EXISTS (SELECT 1 FROM json_each(m.data, '$.mentions') j WHERE json_extract(j.value, '$.userId') = ?)`).get(...s.args, after, userId, userId).n;
}
function preference(lobbyId, userId, channel) {
  return db.prepare('SELECT notifications FROM chat_preferences WHERE lobby_id = ? AND user_id = ? AND channel = ?').get(lobbyId, userId, channel)?.notifications || 'all';
}
function setPreference(lobbyId, userId, channel, mode) {
  db.prepare('INSERT INTO chat_preferences VALUES (?, ?, ?, ?) ON CONFLICT(lobby_id, user_id, channel) DO UPDATE SET notifications = excluded.notifications').run(lobbyId, userId, channel, mode);
}
const tokenOf = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{8,100}$/.test(value) ? value : null;
function request(lobbyId, userId, token) {
  return token && db.prepare('SELECT channel, message_id FROM chat_requests WHERE lobby_id = ? AND user_id = ? AND token = ?').get(lobbyId, userId, token);
}
function remember(lobbyId, userId, token, channel, messageId = null) {
  if (token) db.prepare('INSERT INTO chat_requests VALUES (?, ?, ?, ?, ?)').run(lobbyId, userId, token, channel, messageId);
}
module.exports = { rows, row, metadata, decorate, mentionCount, preference, setPreference, tokenOf, request, remember, isRoom };
