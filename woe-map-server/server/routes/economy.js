'use strict';
/**
 * Goods and unrest (docs/ECONOMY.md), mounted under /api/lobbies/:id/game by routes/game.js:
 *   - policy: a nation's war economy, the share of its towns' output that is military goods (the rest consumer goods);
 *   - goods orders for Supply Columns: load from a friendly town, unload into one (a depot), salvage a destroyed column;
 *   - rebellions (End turn): a town left in critical unrest revolts. "<Nation> Rebels" (a faction, made on first need,
 *     at war with the nation) take the town and the provinces around it; the nation's units standing on that ground go
 *     over to them, and militia take up arms round the town.
 * The economics themselves (making, storing, levelling, drawing) live in server/goods.js.
 */
const express = require('express');
const access = require('../lobbyAccess');
const hub = require('../ws');
const { db, now } = require('../db');
const game = require('../game');
const geo = require('../geo');
const goods = require('../goods');
const provinces = require('../provinces');
const supply = require('../supply');
const GameData = require('../../public/js/game-data');
const UnitTypes = require('../../public/js/units');

const norm = s => String(s || '').trim().toLowerCase();
const typeId = m => UnitTypes.resolve(m?.data?.unitType)?.id || '';
const insertFaction = db.prepare('INSERT INTO factions (lobby_id, name, color, flag_file, flag_asset, created_at) VALUES (?, ?, ?, ?, ?, ?)');

/** A darker, redder shade of a nation's colour for its rebels. */
function rebelColor(hex) {
  const n = parseInt(String(hex || '#888888').slice(1), 16);
  const ch = (sh, t) => Math.round(((n >> sh) & 255) * 0.55 + t * 0.45);
  return '#' + [ch(16, 150), ch(8, 30), ch(0, 30)].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

module.exports = function economyRoutes(h) {
  const { logEvent, num, clamp, writeMarker, createMarker, setMarkerNation, canEditMarker, applyOwnership, broadcastLand, broadcastRelations, broadcastFaction } = h;
  const router = express.Router({ mergeParams: true });
  const units = req => (geo.isEarth(req.lobby) ? 'km' : (req.lobby.scale_label || 'units'));
  const viewerOf = req => ({ role: req.lobbyRole, userId: req.user.id, nation: req.member?.nation || '', viewAs: req.viewAs?.id || null, lobbyId: req.lobby.id });
  const markersOf = req => game.q.markers.all(req.lobby.id).map(access.serializeMarker);
  const factionNamed = (req, name) => game.q.factions.all(req.lobby.id).find(f => norm(f.name) === norm(name)) || null;
  const myFaction = req => factionNamed(req, req.member?.nation);

  /** POST /policy { warEconomy, factionId? }: a player sets their nation's war economy (the GM any nation's). */
  router.post('/policy', (req, res) => {
    const g = game.get(req.lobby.id);
    const gm = req.lobbyRole === 'gm';
    const f = gm && req.body?.factionId ? game.q.faction.get(Number(req.body.factionId), req.lobby.id) : myFaction(req);
    if (!f) return res.status(400).json({ error: 'You need a nation' });
    const st = game.serializeState(game.q.state.get(f.id) || game.ensureState(req.lobby.id, f.id, g.settings));
    const v = Math.round(clamp(num(req.body?.warEconomy, GameData.warEconomyOf(st, g.settings)), 0, 100));
    st.policy = { ...(st.policy || {}), warEconomy: v };
    game.writeState(st);
    broadcastFaction(req, g, f);
    res.json({ policy: st.policy });
  });

  /** Load a Supply Column the caller commands, or send the error. */
  function loadColumn(req, res) {
    const row = game.q.markerOne.get(Number(req.params.mid));
    const unit = row && row.lobby_id === req.lobby.id ? access.serializeMarker(row) : null;
    if (!unit || unit.type !== 'unit' || !access.canSee(unit, viewerOf(req))) { res.status(404).json({ error: 'No such unit' }); return null; }
    if (!canEditMarker(req, unit)) { res.status(403).json({ error: `You do not command ${unit.name}` }); return null; }
    if (typeId(unit) !== 'supply') { res.status(400).json({ error: 'Only Supply Columns carry goods' }); return null; }
    if (num(unit.data?.strength, 100) <= 0) { res.status(409).json({ error: `${unit.name} is destroyed` }); return null; }
    if (unit.data?.aboard) { res.status(409).json({ error: `${unit.name} is aboard a convoy` }); return null; }
    return unit;
  }
  /** The town or fort of its own nation a column stands at (a town's streets, or within supplyTownKm). */
  function depotFor(req, unit, s, markers) {
    const km = num(s.supplyTownKm, 30), px = supply.TOWN_PX;
    let best = null, bd = Infinity;
    for (const t of markers) {
      const fort = t.type === 'unit' && typeId(t) === 'fortress' && num(t.data?.strength, 100) > 0;
      if ((t.type !== 'town' && !fort) || norm(t.data?.nation) !== norm(unit.data?.nation)) continue;
      const d = geo.distance(req.lobby, unit.x, unit.y, t.x, t.y);
      if ((d <= km || (!fort && Math.hypot(unit.x - t.x, unit.y - t.y) <= (px[t.data?.size] ?? px.village))) && d < bd) { bd = d; best = t; }
    }
    return best;
  }

  /**
   * POST /units/:mid/goods { action: 'load' | 'unload' | 'salvage', amount? }: a Supply Column fills up from the town it
   * stands in, leaves its supplies there (a depot for later), or takes what a destroyed column within salvageKm still
   * carries (anyone's: an enemy's spoils or its own side's losses).
   */
  router.post('/units/:mid/goods', (req, res) => {
    const unit = loadColumn(req, res);
    if (!unit) return;
    const g = game.get(req.lobby.id), s = g.settings, u = units(req);
    if (!g.enabled || !goods.on(s)) return res.status(400).json({ error: 'Goods need game mode with goods switched on (⚖ Rules → Goods)' });
    const action = req.body?.action, max = GameData.poolMax('supply', s), have = goods.poolOf(unit, s);
    const markers = markersOf(req);
    const want = req.body?.amount !== undefined ? Math.max(0, num(req.body.amount)) : Infinity;
    if (action === 'load' || action === 'unload') {
      const town = depotFor(req, unit, s, markers);
      if (!town) return res.status(409).json({ error: `${unit.name} must stand in a town or at a fort of ${unit.data?.nation || 'its nation'} (within ${num(s.supplyTownKm, 30)} ${u})` });
      const isFort = town.type === 'unit', store = isFort ? goods.poolOf(town, s) : goods.stockOf(town, 'military', s);
      const amount = Math.round(Math.min(want, action === 'load' ? Math.min(max - have, store) : have) * 10) / 10;
      if (amount <= 0) return res.status(409).json({ error: action === 'load' ? (have >= max ? `${unit.name} is full` : `${town.name} has no military goods to spare`) : `${unit.name} carries nothing` });
      const sign = action === 'load' ? 1 : -1;
      const after = writeMarker(req, unit, { data: { pool: Math.round((have + sign * amount) * 10) / 10 } });
      const left = Math.round((store - sign * amount) * 10) / 10;
      const tAfter = isFort ? writeMarker(req, town, { data: { pool: left } })
        : writeMarker(req, town, { data: { goods: { ...Object.fromEntries(GameData.GOODS_KEYS.map(k => [k, goods.stockOf(town, k, s)])), military: left } } });
      return res.json({ marker: after, town: tAfter, message: action === 'load' ? `${unit.name} loads ${amount} supplies at ${town.name} (${Math.round(after.data.pool)}/${max})` : `${unit.name} leaves ${amount} supplies in ${town.name}'s stores` });
    }
    if (action === 'salvage') {
      const km = num(s.salvageKm, 30);
      const wreck = markers.filter(m => m.type === 'unit' && typeId(m) === 'supply' && m.id !== unit.id && num(m.data?.strength, 100) <= 0 && goods.poolOf(m, s) > 0 &&
        access.canSee(m, viewerOf(req)) && geo.distance(req.lobby, unit.x, unit.y, m.x, m.y) <= km)
        .sort((a, b) => geo.distance(req.lobby, unit.x, unit.y, a.x, a.y) - geo.distance(req.lobby, unit.x, unit.y, b.x, b.y))[0];
      if (!wreck) return res.status(409).json({ error: `No destroyed Supply Column with anything left within ${km} ${u} of ${unit.name}` });
      if (have >= max) return res.status(409).json({ error: `${unit.name} is full` });
      const left = goods.poolOf(wreck, s), amount = Math.round(Math.min(want, max - have, left) * 10) / 10;
      const after = writeMarker(req, unit, { data: { pool: Math.round((have + amount) * 10) / 10 } });
      writeMarker(req, wreck, { data: { pool: Math.round((left - amount) * 10) / 10 } });
      const msg = `📦 ${unit.name} salvaged ${amount} supplies from the wreck of ${wreck.name}${norm(wreck.data?.nation) !== norm(unit.data?.nation) ? ` (${wreck.data?.nation || 'unknown'})` : ''}`;
      logEvent(req.lobby.id, req.user.id, 'system', msg, { audience: { nations: [unit.data?.nation].filter(Boolean), users: [req.user.id] } },
        ws => ws.lobbyRole === 'gm' || ws.user.id === req.user.id || norm(ws.nation) === norm(unit.data?.nation));
      return res.json({ marker: after, message: msg });
    }
    res.status(400).json({ error: 'Unknown goods order' });
  });

  /**
   * End turn: each town whose unrest stayed critical too long (goods.endTurn) rises in revolt. Returns the log lines.
   */
  function processRebellions(req, townIds) {
    const out = [];
    for (const id of townIds || []) {
      try { const r = rebel(req, id); if (r) out.push(r); } catch (e) { console.warn('rebellion failed', e); }
    }
    return out;
  }
  function rebel(req, townId) {
    const g = game.get(req.lobby.id), s = g.settings;
    const row = game.q.markerOne.get(townId);
    const town = row && row.lobby_id === req.lobby.id ? access.serializeMarker(row) : null;
    if (!town || town.type !== 'town' || !town.data?.nation) return null;
    const home = factionNamed(req, town.data.nation);
    if (!home) return null;
    const name = `${home.name} Rebels`.slice(0, 60);
    let f = factionNamed(req, name);
    if (!f) {
      const id = insertFaction.run(req.lobby.id, name, rebelColor(home.color), null, null, now()).lastInsertRowid;
      f = game.q.faction.get(id, req.lobby.id);
      game.ensureState(req.lobby.id, f.id, s);
      hub.broadcast(req.lobby.id, { type: 'factions' });
    }
    if (game.relationStatus(req.lobby.id, f.id, home.id) !== 'war') { require('../treaties').declare(req.lobby, f.id, home.id); broadcastRelations(req.lobby.id); }
    const size = ['capital', 'city', 'village'].includes(town.data.size) ? town.data.size : 'village';
    // The ground: the town's province and the nation's nearest others within rebelRadiusKm.
    let ids = [];
    if (provinces.has(req.lobby.id)) {
      const here = provinces.at(req.lobby.id, town.x, town.y);
      const near = provinces.within(req.lobby, town.x, town.y, num(s.rebelRadiusKm, 200), p => p.factionId === home.id)
        .map(p => ({ p, d: geo.distance(req.lobby, town.x, town.y, p.cx, p.cy) })).sort((a, b) => a.d - b.d).map(x => x.p.id);
      ids = [...new Set([...(here && here.factionId === home.id ? [here.id] : []), ...near])].slice(0, Math.max(1, Math.round(num(s.rebelProvinces?.[size], 1))));
      const pairs = provinces.give(req.lobby, ids, f.id);
      if (pairs.length) broadcastLand(req.lobby.id, { owners: pairs });
    }
    const taken = setMarkerNation(req, town, f.name, true);
    writeMarker(req, taken, { color: f.color, data: { unrest: 0, unrestTurns: 0 } });
    applyOwnership(req);   // nodes, factories and other towns on the ground that went over
    // The nation's troops on that ground go over to the rebels.
    const idSet = new Set(ids);
    const onRebelGround = m => idSet.size ? idSet.has(provinces.at(req.lobby.id, m.x, m.y)?.id) : geo.distance(req.lobby, m.x, m.y, town.x, town.y) <= num(s.supplyTownKm, 30);
    const defectors = [];
    for (const m of markersOf(req)) {
      if (m.type !== 'unit' || norm(m.data?.nation) !== norm(home.name) || num(m.data?.strength, 100) <= 0 || m.data?.aboard) continue;
      if (UnitTypes.resolve(m.data?.unitType)?.cat === 'Naval' || !onRebelGround(m)) continue;
      writeMarker(req, m, { color: f.color, ownerId: null, data: { nation: f.name, corps: null, goal: null, dig: null } });
      defectors.push(m.name);
    }
    // Militia take up arms round the town.
    const t = UnitTypes.LIST.find(x => x.id === 'militia');
    const raised = [];
    const n = Math.max(0, Math.round(num(s.rebelMilitia?.[size], 1)));
    for (let i = 0; t && i < n; i++) {
      const a = i * 2.4 + 0.5, r = 2.5 + i * 0.8;
      const d = UnitTypes.defaults(t, s.unitStats) || {};
      const m = createMarker(req, { type: 'unit', autoName: true, x: Math.round((town.x + Math.cos(a) * r) * 10) / 10, y: Math.round((town.y + Math.sin(a) * r) * 10) / 10,
        color: f.color, data: { nation: f.name, unitType: t.name, ...d, strength: 100 } }, true);
      raised.push(m.name);
    }
    const msg = `🔥 ${town.name} rises in revolt! Unrest boiled over: the ${name} hold the town${ids.length > 1 ? ` and ${ids.length - 1} province${ids.length === 2 ? '' : 's'} around it` : ''}` +
      `${defectors.length ? `; ${defectors.join(', ')} went over to them` : ''}${raised.length ? `; ${raised.length} militia took up arms` : ''}. ${name} are at war with ${home.name}.`;
    logEvent(req.lobby.id, null, 'system', msg);
    for (const fac of [home, f]) broadcastFaction(req, g, fac);
    return { town: town.name, faction: name, provinces: ids.length, defectors, raised, message: msg };
  }

  return { router, processRebellions };
};
