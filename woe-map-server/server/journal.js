'use strict';
const express = require('express');
const { db, now } = require('./db');
const hub = require('./ws');

const q = {
  entries: db.prepare(`SELECT j.*, f.name AS faction_name FROM journal_entries j JOIN factions f ON f.id = j.faction_id WHERE j.lobby_id = ? AND j.faction_id = ? ORDER BY j.entry_date DESC, j.id DESC`),
  one: db.prepare('SELECT * FROM journal_entries WHERE id = ? AND lobby_id = ?'),
  insert: db.prepare('INSERT INTO journal_entries (lobby_id, faction_id, author_id, author_name, entry_date, kind, title, body, private, link, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  update: db.prepare('UPDATE journal_entries SET entry_date = ?, kind = ?, title = ?, body = ?, private = ?, link = ?, updated_at = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM journal_entries WHERE id = ?'),
  stolen: db.prepare('SELECT * FROM stolen_journal WHERE lobby_id = ? AND thief_faction_id = ? ORDER BY stolen_at DESC'),
  candidate: db.prepare(`SELECT j.* FROM journal_entries j WHERE j.lobby_id = ? AND j.faction_id = ? AND j.private = 1 AND NOT EXISTS (SELECT 1 FROM stolen_journal s WHERE s.lobby_id = j.lobby_id AND s.thief_faction_id = ? AND s.source_entry_id = j.id) ORDER BY RANDOM() LIMIT 1`),
  copy: db.prepare('INSERT INTO stolen_journal (lobby_id, thief_faction_id, source_entry_id, source_faction_name, entry_date, kind, title, body, author_name, link, stolen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
};
const kinds = new Set(['event', 'speech', 'law', 'crisis', 'turning-point', 'note']);
const ownFaction = req => db.prepare('SELECT id, name FROM factions WHERE lobby_id = ? AND name = ? COLLATE NOCASE').get(req.lobby.id, req.member?.nation || '');
const faction = (req, id) => db.prepare('SELECT id, name FROM factions WHERE id = ? AND lobby_id = ?').get(Number(id), req.lobby.id);
const mayWrite = (req, f) => req.lobbyRole === 'gm' || ownFaction(req)?.id === f.id;
const safeLink = value => {
  const s = String(value || '').trim();
  return !s || (s.startsWith('/') && !s.startsWith('//') && !/[\s\\<>]/.test(s) && s.length <= 500);
};
function fields(body) {
  const title = String(body?.title || '').trim().slice(0, 160);
  const text = String(body?.body || '').trim().slice(0, 12000);
  const date = String(body?.date || '');
  const kind = String(body?.kind || 'event');
  const link = String(body?.link || '').trim();
  if (!title || !text) return { error: 'Add a title and text' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return { error: 'Choose a valid date' };
  if (!kinds.has(kind)) return { error: 'Choose an entry type' };
  if (!safeLink(link)) return { error: 'Links must be paths within this site' };
  return { date, kind, title, body: text, private: body?.private ? 1 : 0, link };
}
function notify(req, factionId, publicChange = false) {
  hub.broadcast(req.lobby.id, { type: 'journalChanged', factionId }, ws => publicChange || ws.lobbyRole === 'gm' || ws.nation?.toLowerCase() === faction(req, factionId)?.name.toLowerCase());
}
function router() {
  const r = express.Router({ mergeParams: true });
  r.get('/', (req, res) => {
    const f = faction(req, req.query.factionId);
    if (!f) return res.status(404).json({ error: 'No such nation' });
    const privileged = mayWrite(req, f);
    const entries = q.entries.all(req.lobby.id, f.id).filter(e => privileged || !e.private);
    const own = ownFaction(req);
    const stolen = (req.lobbyRole === 'gm' ? f : own)?.id === f.id ? q.stolen.all(req.lobby.id, f.id) : [];
    res.json({ faction: f, entries, stolen, canWrite: privileged });
  });
  r.post('/', (req, res) => {
    const f = faction(req, req.body?.factionId);
    if (!f) return res.status(404).json({ error: 'No such nation' });
    if (!mayWrite(req, f)) return res.status(403).json({ error: 'Only this nation may write its journal' });
    const v = fields(req.body);
    if (v.error) return res.status(400).json(v);
    const t = now();
    const id = q.insert.run(req.lobby.id, f.id, req.user.id, req.user.displayName, v.date, v.kind, v.title, v.body, v.private, v.link, t, t).lastInsertRowid;
    notify(req, f.id, !v.private);
    res.status(201).json({ entry: q.one.get(id, req.lobby.id) });
  });
  r.patch('/:entryId', (req, res) => {
    const e = q.one.get(Number(req.params.entryId), req.lobby.id);
    if (!e) return res.status(404).json({ error: 'No such entry' });
    const f = faction(req, e.faction_id);
    if (!mayWrite(req, f) || (req.lobbyRole !== 'gm' && e.author_id !== req.user.id)) return res.status(403).json({ error: 'Only the author or GM may edit this entry' });
    const v = fields(req.body);
    if (v.error) return res.status(400).json(v);
    q.update.run(v.date, v.kind, v.title, v.body, v.private, v.link, now(), e.id);
    notify(req, f.id, !e.private || !v.private);
    res.json({ entry: q.one.get(e.id, req.lobby.id) });
  });
  r.delete('/:entryId', (req, res) => {
    const e = q.one.get(Number(req.params.entryId), req.lobby.id);
    if (!e) return res.status(404).json({ error: 'No such entry' });
    const f = faction(req, e.faction_id);
    if (!mayWrite(req, f) || (req.lobbyRole !== 'gm' && e.author_id !== req.user.id)) return res.status(403).json({ error: 'Only the author or GM may remove this entry' });
    q.remove.run(e.id);
    notify(req, f.id, !e.private);
    res.json({ ok: true });
  });
  return r;
}
function steal(req, thief, victim) {
  const entry = q.candidate.get(req.lobby.id, victim.id, thief.id);
  if (!entry) return null;
  const id = q.copy.run(req.lobby.id, thief.id, entry.id, victim.name, entry.entry_date, entry.kind, entry.title, entry.body, entry.author_name, entry.link, now()).lastInsertRowid;
  notify(req, thief.id);
  return { id, title: entry.title };
}
function hasStealable(req, thief, victim) { return !!q.candidate.get(req.lobby.id, victim.id, thief.id); }
module.exports = { router, steal, hasStealable };
