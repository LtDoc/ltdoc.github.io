'use strict';
/**
 * Game-layer routes, mounted by routes/lobbies.js under /api/lobbies/:id/game so the lobby middleware
 * (req.lobby, req.lobbyRole, req.member) is already in place.
 */
const express = require('express');
const access = require('../lobbyAccess');
const hub = require('../ws');
const game = require('../game');
const GameData = require('../../public/js/game-data');

const territory = require('../territory');

module.exports = function gameRoutes({ logEvent, clean, num, clamp, setMarkerNation, setShapeNation, shapeById }) {
  const router = express.Router({ mergeParams: true });

  function requireGm(req, res, next) {
    if (req.lobbyRole !== 'gm') return res.status(403).json({ error: 'Game master only' });
    next();
  }
  /** A faction's treasury is visible to the GM, to its player(s), and to everyone when the treasury is public. */
  function canSeeState(req, g, faction) {
    if (req.lobbyRole === 'gm' || g.settings.publicTreasury) return true;
    return String(req.member?.nation || '').toLowerCase() === faction.name.toLowerCase();
  }
  function myFaction(req) {
    const n = String(req.member?.nation || '').toLowerCase();
    return n ? game.q.factions.all(req.lobby.id).find(f => f.name.toLowerCase() === n) || null : null;
  }
  function stateView(req, g, markers) {
    return game.factionStates(req.lobby.id, g.settings).map(({ faction, state }) => {
      const visible = canSeeState(req, g, faction);
      const units = markers.filter(m => m.type === 'unit' && String(m.data?.nation || '').toLowerCase() === faction.name.toLowerCase());
      const out = { faction, unitCount: units.length, visible };
      if (visible) {
        out.state = state;
        out.income = game.incomeFor(req.lobby, g, faction, state, markers);
      }
      return out;
    });
  }
  function broadcastGame(lobbyId, g) { hub.broadcast(lobbyId, { type: 'game', game: g }); }
  /** Push one faction's state to its player(s) and the GM (everyone when treasuries are public). */
  function broadcastFaction(req, g, faction) {
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const state = game.serializeState(game.q.state.get(faction.id) || game.ensureState(req.lobby.id, faction.id, g.settings));
    const msg = { type: 'faction', faction: access.serializeFaction(faction), state, income: game.incomeFor(req.lobby, g, faction, state, markers) };
    hub.broadcast(req.lobby.id, msg, ws => ws.lobbyRole === 'gm' || g.settings.publicTreasury || String(ws.nation || '').toLowerCase() === faction.name.toLowerCase());
  }

  router.get('/', (req, res) => {
    const g = game.get(req.lobby.id);
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const mine = myFaction(req);
    res.json({
      game: g, factions: g.enabled ? stateView(req, g, markers) : [], myFactionId: mine ? mine.id : null,
      canUndo: req.lobbyRole === 'gm' && !!game.q.lastSnapshot.get(req.lobby.id),
      relations: game.relations(req.lobby.id),
      diplomacy: game.diplomacy(req.lobby.id).filter(d => req.lobbyRole === 'gm' || d.from === (mine && mine.id) || d.to === (mine && mine.id)),
      hasTerritories: territory.all(req.lobby.id).length > 0,
    });
  });

  // ---- Territories ----------------------------------------------------------------------------
  function broadcastTerritories(lobbyId, changed) {
    if (changed && changed.length) hub.broadcast(lobbyId, { type: 'territory', territories: changed });
  }
  /** Apply territory-driven ownership to nodes, factories and towns; returns the markers that changed. */
  function applyOwnership(req) {
    const factions = game.q.factions.all(req.lobby.id).map(access.serializeFaction);
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const terrs = territory.all(req.lobby.id);
    const changes = territory.ownershipChanges(terrs, factions, markers);
    const out = changes.map(c => setMarkerNation(req, c.marker, c.nation));
    for (const c of territory.trenchOwnershipChanges(terrs, factions, shapeById(req, null, true))) out.push(setShapeNation(req, c.shape, c.nation));
    return out;
  }

  router.get('/territories', (req, res) => res.json({ territories: territory.all(req.lobby.id) }));

  router.post('/territory/seed-earth', requireGm, (req, res) => {
    const g = game.get(req.lobby.id);
    const factions = game.q.factions.all(req.lobby.id).map(access.serializeFaction);
    let r;
    try { r = territory.seedFromYear(req.lobby, req.body?.year, factions); } catch (e) { return res.status(400).json({ error: e.message }); }
    const flipped = applyOwnership(req);
    logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} assigned the borders of ${Number(req.body.year)} to ${r.assigned.length} factions (${r.unassigned.length} states left neutral)`);
    hub.broadcast(req.lobby.id, { type: 'territory', territories: territory.all(req.lobby.id), replace: true });
    res.json({ territories: territory.all(req.lobby.id), assigned: r.assigned, unassigned: r.unassigned, flipped: flipped.length, game: g });
  });

  router.post('/territory/assign', requireGm, (req, res) => {
    const shape = shapeById(req, Number(req.body?.shapeId));
    if (!shape || shape.kind !== 'area') return res.status(400).json({ error: 'Pick an area drawing' });
    const fid = Number(req.body?.factionId) || territory.NEUTRAL;
    if (fid && !game.q.faction.get(fid, req.lobby.id)) return res.status(404).json({ error: 'No such faction' });
    const changed = territory.assignArea(req.lobby, fid, shape.points);
    const flipped = applyOwnership(req);
    broadcastTerritories(req.lobby.id, changed);
    res.json({ changed: changed.length, flipped: flipped.length });
  });

  router.post('/territory/brush', requireGm, (req, res) => {
    const fid = Number(req.body?.factionId) || territory.NEUTRAL;
    if (fid && !game.q.faction.get(fid, req.lobby.id)) return res.status(404).json({ error: 'No such faction' });
    const x = num(req.body?.x), y = num(req.body?.y), km = clamp(num(req.body?.radiusKm, 60), 1, 5000);
    const changed = territory.brush(req.lobby, fid, x, y, km);
    const flipped = applyOwnership(req);
    broadcastTerritories(req.lobby.id, changed);
    res.json({ changed: changed.length, flipped: flipped.length });
  });

  router.post('/territory/clear', requireGm, (req, res) => {
    territory.clear(req.lobby.id);
    hub.broadcast(req.lobby.id, { type: 'territory', territories: [], replace: true });
    logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} cleared all territories`);
    res.json({ ok: true });
  });

  // ---- Relations and diplomacy ---------------------------------------------------------------
  function broadcastRelations(lobbyId) {
    hub.broadcast(lobbyId, { type: 'relations', relations: game.relations(lobbyId), diplomacy: game.diplomacy(lobbyId) });
  }
  function factionName(req, id) { return game.q.faction.get(Number(id), req.lobby.id)?.name || '?'; }

  router.patch('/relations', requireGm, (req, res) => {
    const a = Number(req.body?.a), b = Number(req.body?.b), status = ['peace', 'war', 'alliance'].includes(req.body?.status) ? req.body.status : null;
    if (!status || !a || !b || a === b) return res.status(400).json({ error: 'Pick two factions and a status' });
    if (!game.q.faction.get(a, req.lobby.id) || !game.q.faction.get(b, req.lobby.id)) return res.status(404).json({ error: 'No such faction' });
    const g = game.get(req.lobby.id);
    game.setRelation(req.lobby.id, a, b, status, g.turn);
    logEvent(req.lobby.id, req.user.id, 'system', `${factionName(req, a)} and ${factionName(req, b)} are now at ${status === 'alliance' ? 'alliance' : status}`);
    broadcastRelations(req.lobby.id);
    res.json({ relations: game.relations(req.lobby.id) });
  });

  /** A player (for their faction) or the GM queues a declaration or proposal. War waits for the GM; peace and alliance too, then the other side. */
  router.post('/diplomacy', (req, res) => {
    const kind = ['war', 'peace', 'alliance'].includes(req.body?.kind) ? req.body.kind : null;
    const to = Number(req.body?.toFactionId);
    const mine = req.lobbyRole === 'gm' && req.body?.fromFactionId ? game.q.faction.get(Number(req.body.fromFactionId), req.lobby.id) : myFaction(req);
    if (!kind || !mine) return res.status(400).json({ error: 'You need a faction to conduct diplomacy' });
    if (!game.q.faction.get(to, req.lobby.id) || to === mine.id) return res.status(400).json({ error: 'Pick another faction' });
    const cur = game.relationStatus(req.lobby.id, mine.id, to);
    if (kind === 'war' && cur === 'war') return res.status(400).json({ error: 'Already at war' });
    if (kind === 'peace' && cur !== 'war') return res.status(400).json({ error: 'Not at war' });
    if (kind === 'alliance' && cur === 'alliance') return res.status(400).json({ error: 'Already allied' });
    const g = game.get(req.lobby.id);
    const id = game.q.insertDiplomacy.run(req.lobby.id, mine.id, to, kind, 'pending', clean(req.body?.note, 200), req.user.id, Date.now()).lastInsertRowid;
    const verb = kind === 'war' ? 'queued a declaration of war on' : kind === 'peace' ? 'offered peace to' : 'proposed an alliance to';
    logEvent(req.lobby.id, req.user.id, 'system', `${mine.name} ${verb} ${factionName(req, to)} (awaiting the GM)`, { diplomacyId: id },
      ws => ws.lobbyRole === 'gm' || String(ws.nation || '').toLowerCase() === mine.name.toLowerCase());
    broadcastRelations(req.lobby.id);
    res.status(201).json({ diplomacy: game.serializeDiplomacy(game.q.diplomacyOne.get(id, req.lobby.id)), turn: g.turn });
  });

  /** GM approves or blocks; the other faction's player accepts or declines an approved offer. */
  router.post('/diplomacy/:did/:action', (req, res) => {
    const d = game.q.diplomacyOne.get(Number(req.params.did), req.lobby.id);
    if (!d) return res.status(404).json({ error: 'No such proposal' });
    const action = req.params.action, gm = req.lobbyRole === 'gm';
    const g = game.get(req.lobby.id);
    const from = factionName(req, d.from_faction), to = factionName(req, d.to_faction);
    const mine = myFaction(req);
    const finish = (status, message) => {
      game.q.resolveDiplomacy.run(status, Date.now(), d.id);
      if (message) logEvent(req.lobby.id, req.user.id, 'system', message);
      broadcastRelations(req.lobby.id);
      res.json({ diplomacy: game.serializeDiplomacy(game.q.diplomacyOne.get(d.id, req.lobby.id)), relations: game.relations(req.lobby.id) });
    };
    if (action === 'withdraw') {
      if (!gm && !(mine && mine.id === d.from_faction)) return res.status(403).json({ error: 'Not yours to withdraw' });
      if (!['pending', 'offered'].includes(d.status)) return res.status(400).json({ error: 'Already resolved' });
      return finish('withdrawn', null);
    }
    if (action === 'approve' || action === 'block') {
      if (!gm) return res.status(403).json({ error: 'Game master only' });
      if (d.status !== 'pending') return res.status(400).json({ error: 'Not awaiting the GM' });
      if (action === 'block') return finish('blocked', `The GM blocked ${from}'s ${d.kind === 'war' ? 'declaration of war on' : d.kind + ' offer to'} ${to}`);
      if (d.kind === 'war') {
        game.setRelation(req.lobby.id, d.from_faction, d.to_faction, 'war', g.turn);
        return finish('accepted', `⚔ ${from} declares war on ${to}!`);
      }
      // Peace and alliance: approved, now the other side decides.
      game.q.resolveDiplomacy.run('offered', null, d.id);
      logEvent(req.lobby.id, req.user.id, 'system', `${from} ${d.kind === 'peace' ? 'offers peace to' : 'proposes an alliance to'} ${to}`);
      broadcastRelations(req.lobby.id);
      return res.json({ diplomacy: game.serializeDiplomacy(game.q.diplomacyOne.get(d.id, req.lobby.id)), relations: game.relations(req.lobby.id) });
    }
    if (action === 'accept' || action === 'decline') {
      if (!gm && !(mine && mine.id === d.to_faction)) return res.status(403).json({ error: 'Only the other faction can answer' });
      if (d.status !== 'offered') return res.status(400).json({ error: 'Not open for an answer' });
      if (action === 'decline') return finish('declined', `${to} declined ${from}'s ${d.kind === 'peace' ? 'peace offer' : 'alliance proposal'}`);
      game.setRelation(req.lobby.id, d.from_faction, d.to_faction, d.kind === 'peace' ? 'peace' : 'alliance', g.turn);
      return finish('accepted', d.kind === 'peace' ? `🕊 ${from} and ${to} make peace` : `🤝 ${from} and ${to} form an alliance`);
    }
    res.status(400).json({ error: 'Unknown action' });
  });

  router.post('/enable', requireGm, (req, res) => {
    const g = game.get(req.lobby.id);
    const on = !!req.body?.enabled;
    if (on && !g.enabled) {
      const start = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.startDate || '')) ? req.body.startDate : g.date;
      g.date = start;
      if (req.body?.resetTurn) g.turn = 1;
    }
    g.enabled = on;
    const saved = game.save(g);
    if (on) for (const f of game.q.factions.all(req.lobby.id)) game.ensureState(req.lobby.id, f.id, saved.settings);
    logEvent(req.lobby.id, req.user.id, 'system', on ? `${req.user.displayName} switched game mode on: turn ${saved.turn}, ${GameData.fmtDate(saved.date)}` : `${req.user.displayName} switched game mode off`);
    broadcastGame(req.lobby.id, saved);
    res.json({ game: saved });
  });

  router.patch('/', requireGm, (req, res) => {
    const g = game.get(req.lobby.id);
    const b = req.body || {};
    if (b.turnStep !== undefined && GameData.TURN_STEPS[b.turnStep]) g.turnStep = b.turnStep;
    if (b.deadline !== undefined) g.deadline = clean(b.deadline, 80);
    if (b.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) g.date = b.date;
    if (b.turn !== undefined) g.turn = clamp(Math.round(num(b.turn, g.turn)), 1, 100000);
    if (b.settings && typeof b.settings === 'object') {
      const s = b.settings, out = {};
      const numIn = (k, lo, hi) => { if (s[k] !== undefined) out[k] = clamp(num(s[k], g.settings[k]), lo, hi); };
      numIn('kmPerMove', 1, 100000); numIn('captureRadiusKm', 1, 5000); numIn('cityRadiusKm', 1, 5000);
      numIn('researchLead', 0, 50); numIn('baseMoney', -1000, 100000); numIn('baseRp', -1000, 100000); numIn('baseManpower', -1000, 100000);
      numIn('upkeepGrain', 0, 100); numIn('upkeepOil', 0, 100);
      numIn('trenchRangeKm', 0, 1000); numIn('trenchBonusDug', 0, 50); numIn('trenchBonusReinforced', 0, 50);
      for (const k of ['waiveMovement', 'occupyNeutrals', 'upkeep', 'publicTreasury']) if (s[k] !== undefined) out[k] = !!s[k];
      for (const grp of ['cityIncome', 'factoryIncome', 'startStock']) {
        if (s[grp] && typeof s[grp] === 'object') {
          out[grp] = {};
          for (const [k, v] of Object.entries(s[grp])) {
            if (v && typeof v === 'object') { out[grp][k] = {}; for (const [k2, v2] of Object.entries(v)) if (['money', 'rp', 'manpower'].includes(k2)) out[grp][k][k2] = clamp(num(v2), -1000, 100000); }
            else if (['money', 'rp', 'manpower', 'resources'].includes(k)) out[grp][k] = clamp(num(v), -1000, 100000);
          }
        }
      }
      g.settings = GameData.mergeSettings(g.settings, out);
    }
    const saved = game.save(g);
    broadcastGame(req.lobby.id, saved);
    res.json({ game: saved });
  });

  router.post('/end-turn', requireGm, (req, res) => {
    const before = game.get(req.lobby.id);
    if (!before.enabled) return res.status(400).json({ error: 'Game mode is off' });
    // Ownership follows territory: settle nodes, factories and towns before income is counted.
    const settled = applyOwnership(req);
    let result;
    try { result = game.endTurn(req.lobby); } catch (e) { return res.status(400).json({ error: e.message }); }
    const g = result.game;
    if (settled.length) logEvent(req.lobby.id, null, 'system', `${settled.length} place${settled.length === 1 ? '' : 's'} changed hands with the front line`);
    logEvent(req.lobby.id, req.user.id, 'system', `Turn ${before.turn} ended. Turn ${g.turn} begins: ${GameData.fmtDate(g.date)}. Movement and action points are reset.`);
    for (const s of result.summaries) {
      const nation = s.faction.name.toLowerCase();
      logEvent(req.lobby.id, null, 'turn', `${s.faction.name}, turn ${before.turn}: ${s.text}`, { faction: s.faction.name, factionId: s.faction.id, income: s.data.income, turn: before.turn },
        ws => ws.lobbyRole === 'gm' || g.settings.publicTreasury || String(ws.nation || '').toLowerCase() === nation);
    }
    for (const hit of result.shortages) {
      logEvent(req.lobby.id, null, 'system', `${hit.faction.name} ran short of ${GameData.byKey[hit.resource].name.toLowerCase()}: ${hit.units.length ? hit.units.join(', ') + ' lose 10% strength' : 'no units to suffer'}`);
    }
    broadcastGame(req.lobby.id, g);
    hub.broadcast(req.lobby.id, { type: 'reload', what: 'markers' });
    for (const f of game.q.factions.all(req.lobby.id)) broadcastFaction(req, g, f);
    res.json({ game: g, summaries: result.summaries.map(s => ({ faction: s.faction.name, text: s.text })) });
  });

  router.post('/undo-turn', requireGm, (req, res) => {
    const g = game.undoTurn(req.lobby);
    if (!g) return res.status(400).json({ error: 'Nothing to undo' });
    logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} undid the last turn: back to turn ${g.turn}, ${GameData.fmtDate(g.date)}`);
    broadcastGame(req.lobby.id, g);
    hub.broadcast(req.lobby.id, { type: 'territory', territories: territory.all(req.lobby.id), replace: true });
    broadcastRelations(req.lobby.id);
    for (const f of game.q.factions.all(req.lobby.id)) broadcastFaction(req, g, f);
    res.json({ game: g });
  });

  /** GM edits a faction's stockpiles or per-turn modifiers (absolute values). */
  router.patch('/factions/:fid', requireGm, (req, res) => {
    const f = game.q.faction.get(Number(req.params.fid), req.lobby.id);
    if (!f) return res.status(404).json({ error: 'No such faction' });
    const g = game.get(req.lobby.id);
    const s = game.serializeState(game.q.state.get(f.id) || game.ensureState(req.lobby.id, f.id, g.settings));
    const b = req.body || {};
    const val = (v, cur) => clamp(num(v, cur), -1e6, 1e9);
    if (b.money !== undefined) s.money = val(b.money, s.money);
    if (b.manpower !== undefined) s.manpower = val(b.manpower, s.manpower);
    if (b.rp !== undefined) s.rp = val(b.rp, s.rp);
    if (b.resources && typeof b.resources === 'object') for (const k of GameData.RESOURCE_KEYS) if (b.resources[k] !== undefined) s.resources[k] = val(b.resources[k], s.resources[k]);
    if (b.mods && typeof b.mods === 'object') {
      const m = { ...s.mods };
      for (const k of ['money', 'rp', 'manpower']) if (b.mods[k] !== undefined) m[k] = val(b.mods[k], 0);
      if (b.mods.resources && typeof b.mods.resources === 'object') {
        m.resources = { ...(m.resources || {}) };
        for (const k of GameData.RESOURCE_KEYS) if (b.mods.resources[k] !== undefined) m.resources[k] = val(b.mods.resources[k], 0);
      }
      s.mods = m;
    }
    game.writeState(s);
    broadcastFaction(req, g, f);
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    res.json({ faction: access.serializeFaction(f), state: game.serializeState(game.q.state.get(f.id)), income: game.incomeFor(req.lobby, g, access.serializeFaction(f), s, markers) });
  });

  return router;
};
