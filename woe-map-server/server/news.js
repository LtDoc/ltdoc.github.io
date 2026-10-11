'use strict';
const express = require('express');
const { db, now } = require('./db');
const hub = require('./ws');
const game = require('./game');

const KINDS = new Set(['statement', 'newspaper', 'diplomatic-note', 'report', 'announcement', 'world-event', 'briefing']);
const GM_KINDS = new Set(['announcement', 'world-event', 'briefing']);
const q = {
  faction: db.prepare('SELECT id, name FROM factions WHERE id = ? AND lobby_id = ?'),
  mine: db.prepare('SELECT id, name FROM factions WHERE lobby_id = ? AND name = ? COLLATE NOCASE'),
  factions: db.prepare('SELECT id, name FROM factions WHERE lobby_id = ?'),
  page: db.prepare(`SELECT * FROM news_posts WHERE lobby_id = ? AND id < ? AND
    (public_body <> '' OR ? = 1 OR EXISTS (SELECT 1 FROM json_each(private_to) WHERE CAST(value AS INTEGER) = ?))
    ORDER BY id DESC LIMIT 51`),
  insert: db.prepare(`INSERT INTO news_posts (lobby_id, faction_id, source_name, author_id, author_name, kind, headline, public_body, private_body, private_to, game_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  one: db.prepare('SELECT * FROM news_posts WHERE id = ? AND lobby_id = ?'),
};
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const cut = (s, n) => String(s ?? '').trim().slice(0, n);
const recipients = row => { try { return JSON.parse(row.private_to); } catch { return []; } };
const mine = req => q.mine.get(req.lobby.id, req.member?.nation || '') || null;
function serialize(row, gm, mineId) {
  const allowed = !!row.private_body && (gm || recipients(row).includes(mineId));
  return { id: row.id, factionId: row.faction_id, sourceName: row.source_name, authorName: row.author_name,
    kind: row.kind, headline: row.headline, publicBody: row.public_body, gameDate: row.game_date, createdAt: row.created_at,
    ...(allowed ? { privateBody: row.private_body } : {}),
    ...(gm || row.faction_id === mineId ? { privateTo: recipients(row) } : {}) };
}
function router() {
  const r = express.Router({ mergeParams: true });
  r.get('/', (req, res) => {
    const gm = req.lobbyRole === 'gm', own = mine(req);
    const raw = Number(req.query.before);
    const before = Number.isSafeInteger(raw) && raw > 0 ? raw : Number.MAX_SAFE_INTEGER;
    const rows = q.page.all(req.lobby.id, before, gm ? 1 : 0, own?.id || -1);
    res.json({ posts: rows.slice(0, 50).map(row => serialize(row, gm, own?.id || -1)), nextBefore: rows.length > 50 ? rows[49].id : null, myFactionId: own?.id || null });
  });
  r.post('/', (req, res) => {
    const gm = req.lobbyRole === 'gm', own = mine(req);
    const faction = gm ? (req.body?.factionId ? q.faction.get(Number(req.body.factionId), req.lobby.id) : null) : own;
    if (gm && req.body?.factionId && !faction) return res.status(400).json({ error: 'Choose a nation in this campaign' });
    if (!gm && !faction) return res.status(403).json({ error: 'The GM must assign you a nation before you can publish' });
    const kind = String(req.body?.kind || 'statement');
    if (!KINDS.has(kind) || (!gm && GM_KINDS.has(kind))) return res.status(403).json({ error: 'This post type is for the GM' });
    const headline = cut(req.body?.headline, 160), publicBody = cut(req.body?.publicBody, 8000), privateBody = cut(req.body?.privateBody, 8000);
    if (!headline || (!publicBody && !privateBody)) return res.status(400).json({ error: 'Add a headline and public or private text' });
    let to = [];
    if (privateBody) {
      const audience = String(req.body?.audience || 'leadership');
      if (!['leadership', 'allies', 'selected'].includes(audience)) return res.status(400).json({ error: 'Choose private recipients' });
      if (faction) to.push(faction.id);
      if (audience === 'leadership' && !faction) return res.status(400).json({ error: 'Choose a nation or specific recipients for a private briefing' });
      const all = q.factions.all(req.lobby.id);
      if (audience === 'allies') {
        if (!faction) return res.status(400).json({ error: 'Choose a nation before addressing its allies' });
        to.push(...all.filter(f => f.id !== faction.id && game.relationStatus(req.lobby.id, faction.id, f.id) === 'alliance').map(f => f.id));
      }
      if (audience === 'selected') {
        const selected = req.body?.targets;
        if (!Array.isArray(selected) || selected.length > 30) return res.status(400).json({ error: 'Choose up to 30 recipient nations' });
        const valid = new Set(all.map(f => f.id));
        if (selected.some(id => !Number.isSafeInteger(Number(id)) || !valid.has(Number(id)))) return res.status(400).json({ error: 'Unknown recipient nation' });
        to.push(...selected.map(Number));
      }
      to = [...new Set(to)];
      if (!to.length) return res.status(400).json({ error: 'Choose at least one recipient nation' });
    }
    const id = q.insert.run(req.lobby.id, faction?.id || null, faction?.name || 'Game master', req.user.id,
      req.user.displayName, kind, headline, publicBody, privateBody, JSON.stringify(to), game.get(req.lobby.id).date || '', now()).lastInsertRowid;
    const row = q.one.get(id, req.lobby.id);
    hub.broadcast(req.lobby.id, { type: 'newsChanged', id }, ws => !!publicBody || ws.lobbyRole === 'gm' || to.some(fid => same(ws.nation, q.faction.get(fid, req.lobby.id)?.name)));
    res.status(201).json({ post: serialize(row, gm, own?.id || -1) });
  });
  return r;
}
module.exports = { router };
