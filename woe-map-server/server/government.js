'use strict';
const express = require('express');
const { db, now } = require('./db');
const hub = require('./ws');

const q = {
  faction: db.prepare('SELECT id, name FROM factions WHERE id = ? AND lobby_id = ?'),
  row: db.prepare('SELECT * FROM nation_governments WHERE faction_id = ? AND lobby_id = ?'),
  hero: db.prepare('SELECT id, name, admin_only, visible_to, data FROM markers WHERE id = ? AND lobby_id = ? AND type = ?'),
  save: db.prepare(`INSERT INTO nation_governments (faction_id, lobby_id, government_form, character, priorities, political_factions, figures, revision, updated_by, updated_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(faction_id) DO UPDATE SET government_form = excluded.government_form, character = excluded.character,
      priorities = excluded.priorities, political_factions = excluded.political_factions, figures = excluded.figures,
      revision = nation_governments.revision + 1, updated_by = excluded.updated_by, updated_name = excluded.updated_name, updated_at = excluded.updated_at
    WHERE nation_governments.revision = ?`),
};
const short = (v, max) => String(v ?? '').trim().slice(0, max);
const parse = s => { try { return JSON.parse(s); } catch { return []; } };
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
function publicHero(req, id, nation) {
  const h = q.hero.get(id, req.lobby.id, 'hero');
  if (!h || h.admin_only || h.visible_to) return null;
  const d = parse(h.data);
  if (!same(d.nation, nation) || !['statesman', 'general', 'diplomat'].includes(d.role)) return null;
  return { id: h.id, name: h.name, role: d.role, title: d.title || '' };
}
function profile(req, faction) {
  const row = q.row.get(faction.id, req.lobby.id);
  const figures = row ? parse(row.figures) : [];
  return {
    faction, governmentForm: row?.government_form || '', character: row?.character || '',
    priorities: row ? parse(row.priorities) : [], politicalFactions: row ? parse(row.political_factions) : [],
    figures: figures.map(f => ({ ...f, hero: f.heroId ? publicHero(req, f.heroId, faction.name) : null })),
    revision: row?.revision || 0, updatedBy: row?.updated_by || null, updatedName: row?.updated_name || '', updatedAt: row?.updated_at || null,
  };
}
function validate(req, faction, body) {
  if (!Array.isArray(body?.priorities) || body.priorities.length > 8 ||
      !Array.isArray(body?.politicalFactions) || body.politicalFactions.length > 12 ||
      !Array.isArray(body?.figures) || body.figures.length > 20) return { error: 'Too many priorities, factions or figures' };
  const governmentForm = short(body.governmentForm, 120), character = short(body.character, 2000);
  const priorities = body.priorities.map(x => short(x, 300)).filter(Boolean);
  const politicalFactions = body.politicalFactions.map(x => ({ name: short(x?.name, 100), description: short(x?.description, 600) })).filter(x => x.name);
  const figures = [];
  for (const x of body.figures) {
    const heroId = x?.heroId ? Number(x.heroId) : null;
    const hero = heroId && Number.isSafeInteger(heroId) ? publicHero(req, heroId, faction.name) : null;
    if (x?.heroId && !hero) return { error: 'A linked figure must be a public statesman, general or diplomat of this nation' };
    const name = short(x?.name, 100) || hero?.name || '';
    if (!name) continue;
    figures.push({ name, title: short(x?.title, 100), description: short(x?.description, 600), heroId });
  }
  return { governmentForm, character, priorities, politicalFactions, figures };
}
function router() {
  const r = express.Router({ mergeParams: true });
  r.get('/:factionId', (req, res) => {
    const faction = q.faction.get(Number(req.params.factionId), req.lobby.id);
    if (!faction) return res.status(404).json({ error: 'No such nation' });
    res.json({ profile: profile(req, faction), canEdit: req.lobbyRole === 'gm' || same(req.member?.nation, faction.name) });
  });
  r.put('/:factionId', (req, res) => {
    const faction = q.faction.get(Number(req.params.factionId), req.lobby.id);
    if (!faction) return res.status(404).json({ error: 'No such nation' });
    if (req.lobbyRole !== 'gm' && !same(req.member?.nation, faction.name)) return res.status(403).json({ error: 'Only this nation or the GM may edit its government' });
    const revision = Number(req.body?.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) return res.status(400).json({ error: 'Missing revision' });
    const v = validate(req, faction, req.body);
    if (v.error) return res.status(400).json(v);
    const current = q.row.get(faction.id, req.lobby.id);
    if (revision !== (current?.revision || 0)) return res.status(409).json({ error: 'Another player changed this government. Reload it before saving.', profile: profile(req, faction) });
    const result = q.save.run(faction.id, req.lobby.id, v.governmentForm, v.character, JSON.stringify(v.priorities), JSON.stringify(v.politicalFactions), JSON.stringify(v.figures), req.user.id, req.user.displayName, now(), revision);
    if (!result.changes) return res.status(409).json({ error: 'Another player changed this government. Reload it before saving.', profile: profile(req, faction) });
    hub.broadcast(req.lobby.id, { type: 'governmentChanged', factionId: faction.id });
    res.json({ profile: profile(req, faction) });
  });
  return r;
}
module.exports = { router };
