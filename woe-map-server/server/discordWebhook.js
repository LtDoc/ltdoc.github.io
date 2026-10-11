'use strict';

const { db, now } = require('./db');

// Webhook tokens are credentials. Keep them separate from lobby and game settings, which are sent to players.
db.exec(`CREATE TABLE IF NOT EXISTS discord_webhooks (
  lobby_id INTEGER PRIMARY KEY REFERENCES lobbies(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  last_error TEXT
)`);

const q = {
  get: db.prepare('SELECT * FROM discord_webhooks WHERE lobby_id = ?'),
  save: db.prepare(`INSERT INTO discord_webhooks (lobby_id, url, updated_at, last_sent_at, last_error)
    VALUES (?, ?, ?, NULL, NULL) ON CONFLICT(lobby_id) DO UPDATE SET
    url = excluded.url, updated_at = excluded.updated_at, last_sent_at = NULL, last_error = NULL`),
  clear: db.prepare('DELETE FROM discord_webhooks WHERE lobby_id = ?'),
  sent: db.prepare('UPDATE discord_webhooks SET last_sent_at = ?, last_error = NULL WHERE lobby_id = ? AND url = ?'),
  failed: db.prepare('UPDATE discord_webhooks SET last_error = ? WHERE lobby_id = ? AND url = ?'),
};
const pending = new Map();
const COLORS = {
  turn: 0xc9a96a,
  movement: 0x64a778,
  battle: 0xc78b55,
  announcement: 0xc9a96a,
  war: 0xc45f5a,
  peace: 0x78b99b,
  test: 0x64a778,
};

function validateUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(u.hostname) ||
      u.username || u.password || u.port || u.search || u.hash ||
      !/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(u.pathname)) return null;
    return u.href;
  } catch { return null; }
}

function status(lobbyId) {
  const row = q.get.get(lobbyId);
  return { configured: !!row, lastSentAt: row?.last_sent_at || null, lastError: row?.last_error || null };
}

function save(lobbyId, url) {
  const valid = validateUrl(url);
  if (!valid) throw new Error('Paste a Discord webhook URL from Channel Settings → Integrations → Webhooks');
  q.save.run(lobbyId, valid, now());
  return status(lobbyId);
}

function clear(lobbyId) { q.clear.run(lobbyId); return status(lobbyId); }

function payload(campaignName, event) {
  const text = (value, max) => String(value ?? '').trim().slice(0, max);
  const fields = (event.fields || []).slice(0, 4).map(field => ({
    name: text(field.name, 64), value: text(field.value, 200), inline: !!field.inline,
  })).filter(field => field.name && field.value);
  return {
    embeds: [{
      author: { name: 'Over the Wire' },
      title: text(event.title, 256),
      description: text(event.description, 3900),
      color: COLORS[event.kind] || COLORS.test,
      fields,
      footer: { text: text(campaignName, 120) || 'Campaign' },
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}

async function deliver(lobbyId, campaignName, event) {
  const row = q.get.get(lobbyId);
  if (!row) return { ok: false, error: 'No Discord webhook is configured' };
  let error;
  try {
    // wait=true makes Discord confirm that the message was saved before we report success.
    const response = await fetch(`${row.url}?wait=true`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload(campaignName, event)),
    });
    if (response.ok) { q.sent.run(now(), lobbyId, row.url); return { ok: true }; }
    error = `Discord returned HTTP ${response.status}`;
  } catch { error = 'Could not reach Discord'; }
  q.failed.run(error, lobbyId, row.url);
  console.warn(`Discord webhook for campaign ${lobbyId}: ${error}`);
  return { ok: false, error };
}

// A notification must never delay or roll back the game action that caused it.
function emit(lobbyId, campaignName, event) {
  if (!q.get.get(lobbyId)) return;
  const previous = pending.get(lobbyId) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => deliver(lobbyId, campaignName, event));
  pending.set(lobbyId, next);
  void next.then(
    () => { if (pending.get(lobbyId) === next) pending.delete(lobbyId); },
    () => { if (pending.get(lobbyId) === next) pending.delete(lobbyId); },
  );
}

module.exports = { status, save, clear, deliver, emit, validateUrl, payload };
