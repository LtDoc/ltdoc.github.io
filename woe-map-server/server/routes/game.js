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

module.exports = function gameRoutes({ logEvent, clean, num, clamp }) {
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
    res.json({ game: g, factions: g.enabled ? stateView(req, g, markers) : [], myFactionId: mine ? mine.id : null, canUndo: req.lobbyRole === 'gm' && !!game.q.lastSnapshot.get(req.lobby.id) });
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
    let result;
    try { result = game.endTurn(req.lobby); } catch (e) { return res.status(400).json({ error: e.message }); }
    const g = result.game;
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
