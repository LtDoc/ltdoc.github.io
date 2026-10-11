'use strict';
/**
 * Unit orders (docs/UNITS.md), mounted under /api/lobbies/:id/game by routes/game.js:
 *   - replenish: a worn unit takes on replacements (manpower and money) in friendly territory, away from the enemy;
 *   - dive / surface: submarines run submerged, seen only by destroyers close by, and surface to attack;
 *   - dig: engineers dig a planned trench (or reinforce a dug one) a section a turn, finished at End turn (processDigs);
 *   - railbuild: engineers, pioneers and railway troops lay a section of a planned railway a turn, for iron and timber
 *     (processDigs too);
 *   - demolish: sappers blow up a section of an enemy trench (a roll, in the battle phase);
 *   - wreck: sappers knock a resource node's works down a level: their own side's (scorched earth, certain) or an
 *     enemy's (a raid, a roll), in the battle phase;
 *   - corps: named groups of a nation's units that form up on a line the player draws, artillery and support behind;
 *   - goal: marching orders, a destination several turns away walked (or ridden) a turn at a time (processMarches).
 */
const express = require('express');
const crypto = require('node:crypto');
const access = require('../lobbyAccess');
const hub = require('../ws');
const { db, now } = require('../db');
const game = require('../game');
const geo = require('../geo');
const research = require('../research');
const territory = require('../territory');
const trenches = require('../trenches');
const heroRules = require('../heroes');
const supply = require('../supply');
const vision = require('../vision');
const GameData = require('../../public/js/game-data');
const UnitTypes = require('../../public/js/units');

const DIGGERS = new Set(['engineers', 'pioneers']);
const RAIL_BUILDERS = new Set(['engineers', 'pioneers', 'railway']);
const norm = s => String(s || '').trim().toLowerCase();
const typeOf = m => UnitTypes.resolve(m?.data?.unitType);

const qc = {
  list: db.prepare('SELECT * FROM corps WHERE lobby_id = ? ORDER BY name COLLATE NOCASE'),
  one: db.prepare('SELECT * FROM corps WHERE id = ? AND lobby_id = ?'),
  insert: db.prepare('INSERT INTO corps (lobby_id, nation, name, line, front, created_by, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)'),
  rename: db.prepare('UPDATE corps SET name = ?, updated_at = ? WHERE id = ?'),
  setLine: db.prepare('UPDATE corps SET line = ?, front = ?, updated_at = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM corps WHERE id = ?'),
};

module.exports = function orderRoutes(h) {
  const { logEvent, clean, num, writeMarker, canEditMarker, createShape, reshapeShape, removeShape, moveMarkerTo, trenchNation } = h;
  const router = express.Router({ mergeParams: true });
  const units = req => (geo.isEarth(req.lobby) ? 'km' : (req.lobby.scale_label || 'units'));
  const viewerOf = req => ({ role: req.lobbyRole, userId: req.user.id, nation: req.member?.nation || '', viewAs: req.viewAs?.id || null, lobbyId: req.lobby.id });
  const markersOf = req => game.q.markers.all(req.lobby.id).map(access.serializeMarker);
  const factionNamed = (req, name) => game.q.factions.all(req.lobby.id).find(f => norm(f.name) === norm(name)) || null;
  const atWar = (req, a, b) => {
    const fa = factionNamed(req, a), fb = factionNamed(req, b);
    return !!(fa && fb && fa.id !== fb.id && game.relationStatus(req.lobby.id, fa.id, fb.id) === 'war');
  };
  /** A line in the log for the given nations' players (and the GM). */
  function sideLog(req, nations, message, kind = 'system', data = {}) {
    const names = nations.filter(Boolean), set = new Set(names.map(norm));
    return logEvent(req.lobby.id, req.user.id, kind, message, { ...data, audience: { nations: names, users: [req.user.id] } },
      ws => ws.lobbyRole === 'gm' || ws.user.id === req.user.id || set.has(norm(ws.nation)));
  }
  /** Push one faction's treasury to its players and the GM (everyone when treasuries are public). */
  function pushFaction(req, g, f) {
    const markers = markersOf(req);
    const state = game.serializeState(game.q.state.get(f.id) || game.ensureState(req.lobby.id, f.id, g.settings));
    hub.broadcast(req.lobby.id, { type: 'faction', faction: access.serializeFaction(f), state, income: game.incomeFor(req.lobby, g, f, state, markers) },
      ws => ws.lobbyRole === 'gm' || g.settings.publicTreasury || norm(ws.nation) === norm(f.name));
  }
  /** Load a unit the caller commands: { unit, g } or sends the error. */
  function loadUnit(req, res) {
    const row = game.q.markerOne.get(Number(req.params.mid));
    const unit = row && row.lobby_id === req.lobby.id ? access.serializeMarker(row) : null;
    if (!unit || unit.type !== 'unit' || !access.canSee(unit, viewerOf(req))) { res.status(404).json({ error: 'No such unit' }); return null; }
    if (!canEditMarker(req, unit)) { res.status(403).json({ error: `You do not command ${unit.name}` }); return null; }
    return unit;
  }
  /** The nearest town's name, for log lines ("near Ypres"). */
  function placeName(markers, lobby, x, y) {
    let best = null, bd = Infinity;
    for (const m of markers) { if (m.type !== 'town') continue; const d = geo.distance(lobby, x, y, m.x, m.y); if (d < bd) { bd = d; best = m; } }
    return best ? (bd < 25 ? `near ${best.name}` : `${Math.round(bd)} km from ${best.name}`) : 'in the field';
  }

  // ---- Replacements ---------------------------------------------------------------------------------------------
  /**
   * Replenish: a worn unit takes on up to replenishMax strength, paying the manpower and money of a new unit in
   * proportion. It must stand in its own or allied territory (a ship: within supplyTownKm of a friendly town), be
   * supplied, and have no enemy unit its side can see within replenishEnemyKm. It then spends the rest of the turn.
   */
  router.post('/units/:mid/replenish', (req, res) => {
    const unit = loadUnit(req, res);
    if (!unit) return;
    const g = game.get(req.lobby.id), gm = req.lobbyRole === 'gm', s = g.settings, u = units(req);
    if (!g.enabled) return res.status(400).json({ error: 'Replenishing needs game mode' });
    const d = unit.data || {}, from = Math.max(0, Math.min(100, num(d.strength, 100)));
    if (from <= 0 || d.surrendered) return res.status(409).json({ error: `${unit.name} is destroyed` });
    if (from >= 100) return res.status(409).json({ error: `${unit.name} is at full strength` });
    if (d.aboard) return res.status(409).json({ error: `${unit.name} is aboard a convoy` });
    if (!gm) {
      if (num(d.replenishedTurn) === g.turn) return res.status(409).json({ error: `${unit.name} has already taken on replacements this turn` });
      if (d.attacked) return res.status(409).json({ error: `${unit.name} attacked this turn` });
      if (d.supplied === false && s.supplyEnabled !== false) return res.status(409).json({ error: `${unit.name} is out of supply: replacements cannot reach it` });
    }
    const markers = markersOf(req), friends = supply.friendsResolver(req.lobby)(d.nation);
    const t = typeOf(unit);
    if (!gm) {
      if (t?.cat === 'Naval') {
        const km = num(s.supplyTownKm, 30);
        const ports = supply.friendsResolver(req.lobby, 'ports')(d.nation);
        if (!markers.some(m => m.type === 'town' && ports.has(norm(m.data?.nation)) && geo.distance(req.lobby, unit.x, unit.y, m.x, m.y) <= km)) return res.status(409).json({ error: `${unit.name} must be in a friendly port (within ${km} ${u} of a friendly town)` });
      } else {
        const lookup = territory.ownerLookup(req.lobby);
        if (lookup) {
          const owner = lookup(unit.x, unit.y);
          const f = owner ? game.q.faction.get(owner, req.lobby.id) : null;
          const permitted = f && require('../treaties').permission(req.lobby.id, factionNamed(req, d.nation)?.id, f.id, t?.cat === 'Air' ? 'airfields' : 'supply');
          if (!f || !friends.has(norm(f.name)) && !permitted) return res.status(409).json({ error: `${unit.name} needs friendly territory or the appropriate access agreement to refit here` });
        }
      }
      // Engagement distance: an enemy (at war) unit its side can see. Units hidden from it do not count.
      const km = num(s.replenishEnemyKm, 50), v = { role: 'player', userId: req.user.id, nation: d.nation || '', lobbyId: req.lobby.id };
      const enemy = markers.find(m => m.type === 'unit' && num(m.data?.strength, 100) > 0 && !m.data?.aboard && m.data?.nation && !friends.has(norm(m.data.nation)) &&
        atWar(req, d.nation, m.data.nation) && geo.distance(req.lobby, unit.x, unit.y, m.x, m.y) <= km && access.canSee(m, v));
      if (enemy) return res.status(409).json({ error: `${unit.name} is within ${km} ${u} of the enemy (${enemy.name}): pull it back to refit` });
    }
    const f = factionNamed(req, d.nation);
    if (!f) return res.status(409).json({ error: `${unit.name} has no faction to pay for replacements` });
    const amount = Math.min(num(s.replenishMax, 50), 100 - from);
    if (amount <= 0) return res.status(409).json({ error: 'Replenishing is switched off (⚖ Rules)' });
    const fx = game.factionEffects(req.lobby.id, f.id);
    const base = research.applyCost(fx, t?.id || '', t ? t.cat : 'Infantry', GameData.costFor(t?.id || 'infantry', s.unitCosts));
    const cost = { manpower: Math.ceil(num(base.manpower) * amount / 100 * 10) / 10, money: Math.ceil(num(base.money) * amount / 100 * 10) / 10 };
    const state = game.serializeState(game.q.state.get(f.id) || game.ensureState(req.lobby.id, f.id, s));
    if (state.manpower < cost.manpower) return res.status(409).json({ error: `${f.name} needs ${cost.manpower} manpower (has ${state.manpower})` });
    if (state.money < cost.money) return res.status(409).json({ error: `${f.name} needs ${cost.money} money (has ${state.money})` });
    state.manpower = Math.round((state.manpower - cost.manpower) * 10) / 10;
    state.money = Math.round((state.money - cost.money) * 10) / 10;
    game.writeState(state);
    // Refitting takes the unit out of the line for the rest of the turn.
    const allowance = (num(d.movement) + num(research.statBonus(fx, t).movement)) * num(s.kmPerMove, 50);
    const after = writeMarker(req, unit, { data: { strength: from + amount, replenishedTurn: g.turn, movedKm: Math.max(num(d.movedKm), allowance), apUsed: Math.max(num(d.apUsed), num(d.ap)) } });
    pushFaction(req, g, f);
    const msg = `🩹 ${unit.name} took on replacements: ${from}% → ${from + amount}% (${cost.manpower} manpower, ${cost.money} money)`;
    sideLog(req, [d.nation], msg);
    res.json({ marker: after, message: msg, cost });
  });

  // ---- Submarines -------------------------------------------------------------------------------------------------
  /** Dive or surface. Submerged, only destroyers within subDetectKm see it; attacking brings it up for the rest of the turn. */
  router.post('/units/:mid/dive', (req, res) => {
    const unit = loadUnit(req, res);
    if (!unit) return;
    if (typeOf(unit)?.id !== 'submarine') return res.status(400).json({ error: 'Only submarines dive' });
    const g = game.get(req.lobby.id), down = req.body?.submerged !== false;
    if (num(unit.data?.strength, 100) <= 0) return res.status(409).json({ error: `${unit.name} is lost` });
    if (down && g.enabled && unit.data?.attacked && req.lobbyRole !== 'gm') return res.status(409).json({ error: `${unit.name} attacked this turn and stays on the surface until the next` });
    if (!!unit.data?.submerged === down) return res.json({ marker: unit });
    const after = writeMarker(req, unit, { data: { submerged: down } });
    res.json({ marker: after, message: down ? `${unit.name} dives: only destroyers close by can find it` : `${unit.name} surfaces` });
  });

  // ---- Trenches: engineers dig, sappers blow up -----------------------------------------------------------------------
  /** Trenches the side of `nation` may work on: its own and unowned ones (not another nation's). */
  const workable = (friends, s) => !s.data?.nation || friends.has(norm(s.data.nation));
  const trenchState = s => s.data?.state || 'dug';
  function nearestTrench(req, unit, want, km, ok) {
    let best = null;
    for (const row of db.prepare("SELECT * FROM shapes WHERE lobby_id = ? AND kind = 'trench'").all(req.lobby.id)) {
      const s = access.serializeShape(row);
      if (trenchState(s) !== want || !ok(s)) continue;
      const d = trenches.distanceTo(req.lobby, s.points, unit.x, unit.y);
      if (d <= km && (!best || d < best.dist)) best = { shape: s, dist: d };
    }
    return best;
  }

  /** Order an engineer to dig the planned trench nearest it (mode 'dig') or reinforce the dug one nearest it ('reinforce'). */
  router.post('/units/:mid/dig', (req, res) => {
    const unit = loadUnit(req, res);
    if (!unit) return;
    const g = game.get(req.lobby.id), s = g.settings, u = units(req);
    if (!g.enabled) return res.status(400).json({ error: 'Digging needs game mode: outside it, draw the trench as dug' });
    if (!DIGGERS.has(typeOf(unit)?.id)) return res.status(400).json({ error: 'Only engineers and pioneers dig trenches' });
    if (num(unit.data?.strength, 100) <= 0 || unit.data?.aboard) return res.status(409).json({ error: `${unit.name} cannot dig now` });
    const mode = req.body?.mode === 'reinforce' ? 'reinforce' : 'dig';
    const friends = supply.friendsResolver(req.lobby)(unit.data?.nation), km = num(s.trenchDigKm, 20);
    const t = nearestTrench(req, unit, mode === 'dig' ? 'plan' : 'dug', km, sh => workable(friends, sh) && access.canSee(sh, viewerOf(req)));
    if (!t) return res.status(409).json({ error: mode === 'dig' ? `No planned trench within ${km} ${u} of ${unit.name}: draw one with the trench tool (⌇) first` : `No dug trench of your side within ${km} ${u} of ${unit.name}` });
    const build = heroRules.effects(req.lobby, s, markersOf(req), unit).build;
    const after = writeMarker(req, unit, { data: { dig: { mode, turn: g.turn } } });
    const timber = num(mode === 'dig' ? s.trenchDigTimber : s.trenchReinforceTimber, 4) * build;
    res.json({ marker: after, message: `${unit.name} will ${mode === 'dig' ? 'dig' : 'reinforce'} ${num(s.trenchSectionKm, 10) * build} ${u} of ${t.shape.label || 'the trench'} at End turn (${timber} timber), if it is still within ${km} ${u} of it` });
  });
  // ---- Railways: engineers and railway troops build planned lines ----------------------------------------------------
  /** The planned railway of the unit's side nearest it within km: { shape, dist } or null. */
  function nearestRailPlan(req, unit, km, friends) {
    let best = null;
    for (const row of db.prepare("SELECT * FROM shapes WHERE lobby_id = ? AND kind = 'rail'").all(req.lobby.id)) {
      const s = access.serializeShape(row);
      if (s.data?.state !== 'plan' || (s.data?.nation && !friends.has(norm(s.data.nation)))) continue;
      const d = trenches.distanceTo(req.lobby, s.points, unit.x, unit.y);
      if (d <= km && (!best || d < best.dist)) best = { shape: s, dist: d };
    }
    return best;
  }
  /** Order an engineer, pioneer or railway troops unit to lay the next section of the planned railway nearest it. */
  router.post('/units/:mid/railbuild', (req, res) => {
    const unit = loadUnit(req, res);
    if (!unit) return;
    const g = game.get(req.lobby.id), s = g.settings, u = units(req);
    if (!g.enabled) return res.status(400).json({ error: 'Building railways needs game mode: outside it, draw the line' });
    if (!RAIL_BUILDERS.has(typeOf(unit)?.id)) return res.status(400).json({ error: 'Only engineers, pioneers and railway troops lay track' });
    if (num(unit.data?.strength, 100) <= 0 || unit.data?.aboard) return res.status(409).json({ error: `${unit.name} cannot build now` });
    const km = num(s.trenchDigKm, 20), friends = supply.friendsResolver(req.lobby)(unit.data?.nation);
    const t = nearestRailPlan(req, unit, km, friends);
    if (!t) return res.status(409).json({ error: `No planned railway of your side within ${km} ${u} of ${unit.name}: plan one with the railway tool first` });
    const build = heroRules.effects(req.lobby, s, markersOf(req), unit).build;
    const after = writeMarker(req, unit, { data: { dig: { mode: 'rail', turn: g.turn } } });
    res.json({ marker: after, message: `${unit.name} will lay ${num(s.railBuildKm, 15) * build} ${u} of ${t.shape.label || 'the planned railway'} at End turn (${num(s.railBuildIron, 5) * build} iron, ${num(s.railBuildTimber, 5) * build} timber), if it is still within ${km} ${u} of it` });
  });
  /**
   * Lay the section of a planned railway nearest (x, y): it becomes track (a rail drawing of its own, whose ends meet the
   * track already laid, so the network joins it up), and what is left stays planned. Returns { built, length }.
   */
  function buildRailSection(req, shape, x, y, km) {
    const sec = trenches.section(req.lobby, shape.points, x, y, km);
    const { before, section, after } = sec.pieces;
    const plan = { ...(shape.data || {}), cuts: [], state: 'plan' };
    if (before) { reshapeShape(req, shape, before, plan); if (after) createShape(req, { kind: 'rail', label: shape.label, color: shape.color, width: shape.width, adminOnly: shape.adminOnly, visibleTo: shape.visibleTo, createdBy: shape.createdBy, points: after, data: plan }); }
    else if (after) reshapeShape(req, shape, after, plan);
    else removeShape(req, shape);
    const built = createShape(req, { kind: 'rail', label: shape.label, color: shape.color, width: shape.width, adminOnly: shape.adminOnly, visibleTo: shape.visibleTo, createdBy: shape.createdBy, points: section, data: { cuts: [] } });
    return { built, length: sec.s1 - sec.s0 };
  }
  router.delete('/units/:mid/dig', (req, res) => {
    const unit = loadUnit(req, res);
    if (!unit) return;
    res.json({ marker: writeMarker(req, unit, { data: { dig: null } }) });
  });

  /**
   * Cut the section of `km` nearest (x, y) out of a trench and give it `state`. The rest keeps its old state; the new
   * section joins a neighbouring trench of the same state and nation that it runs on from. Returns the section's shape.
   */
  function cutSection(req, shape, x, y, km, state) {
    const sec = trenches.section(req.lobby, shape.points, x, y, km);
    const { before, section, after } = sec.pieces;
    const base = { kind: 'trench', label: shape.label, color: shape.color, width: shape.width, adminOnly: shape.adminOnly, visibleTo: shape.visibleTo, createdBy: shape.createdBy };
    const withNation = (pts, st) => ({ ...(shape.data || {}), state: st, nation: trenchNation(req, pts) });
    let piece;
    if (before) {
      reshapeShape(req, shape, before, withNation(before, trenchState(shape)));
      piece = state ? createShape(req, { ...base, points: section, data: withNation(section, state) }) : null;
    } else if (state) piece = reshapeShape(req, shape, section, withNation(section, state));
    else removeShape(req, shape);
    if (after) createShape(req, { ...base, points: after, data: withNation(after, trenchState(shape)) });
    // A dug section joins the dug trench it runs on from, so a line dug a section a turn stays one trench.
    for (let i = 0; piece && i < 2; i++) {
      const rows = db.prepare("SELECT * FROM shapes WHERE lobby_id = ? AND kind = 'trench' AND id != ?").all(req.lobby.id, piece.id).map(access.serializeShape);
      const nb = rows.find(o => trenchState(o) === state && norm(o.data?.nation) === norm(piece.data?.nation) && trenches.join(o.points, piece.points));
      if (!nb) break;
      const joined = trenches.join(nb.points, piece.points);
      removeShape(req, piece);
      piece = reshapeShape(req, nb, joined, { ...(nb.data || {}), nation: trenchNation(req, joined) });
    }
    return { piece, length: sec.s1 - sec.s0 };
  }

  /**
   * End turn: every engineer with a dig order digs (or reinforces) one section of the nearest suitable trench, if it is
   * still within trenchDigKm of one, alive, supplied and its nation can pay the timber. Called before the turn resolves,
   * so the new cover counts from the next turn. Returns the log lines written.
   */
  function processDigs(req) {
    const g = game.get(req.lobby.id), s = g.settings, u = units(req);
    if (!g.enabled) return [];
    const out = [], friendsOf = supply.friendsResolver(req.lobby), km = num(s.trenchDigKm, 20), sectionKm = num(s.trenchSectionKm, 10);
    const markers = markersOf(req);
    for (const unit of markers.filter(m => m.type === 'unit' && m.data?.dig && (DIGGERS.has(typeOf(m)?.id) || (m.data.dig.mode === 'rail' && RAIL_BUILDERS.has(typeOf(m)?.id))))) {
      const mode = unit.data.dig.mode, nation = unit.data?.nation || '';
      const build = heroRules.effects(req.lobby, s, markers, unit).build;
      if (mode === 'rail') {
        const fail = why => { out.push(sideLog(req, [nation], `🛤 ${unit.name} could not lay track: ${why}`)); };
        if (num(unit.data?.strength, 100) <= 0 || unit.data?.aboard) { fail('it is out of action'); continue; }
        if (require('../supply').exhausted(unit) && s.supplyEnabled !== false) { fail('it is out of supply'); continue; }
        const t = nearestRailPlan(req, unit, km, friendsOf(nation));
        if (!t) { fail(`no planned railway of its side within ${km} ${u}`); continue; }
        const f = factionNamed(req, nation), iron = num(s.railBuildIron, 5) * build, timber = num(s.railBuildTimber, 5) * build;
        let state = null;
        if (f && (iron > 0 || timber > 0)) {
          state = game.serializeState(game.q.state.get(f.id) || game.ensureState(req.lobby.id, f.id, s));
          if (num(state.resources.iron) < iron || num(state.resources.timber) < timber) { fail(`${f.name} is short of iron or timber (needs ${iron} iron, ${timber} timber)`); continue; }
        }
        const r = buildRailSection(req, t.shape, unit.x, unit.y, num(s.railBuildKm, 15) * build);
        if (state) {
          state.resources.iron = Math.round((num(state.resources.iron) - iron) * 10) / 10;
          state.resources.timber = Math.round((num(state.resources.timber) - timber) * 10) / 10;
          game.writeState(state); pushFaction(req, g, f);
        }
        out.push(sideLog(req, [nation], `🛤 ${unit.name} laid ${Math.round(r.length)} ${u} of ${t.shape.label || 'railway'} ${placeName(markers, req.lobby, unit.x, unit.y)} (${iron} iron, ${timber} timber)`));
        continue;
      }
      const fail = why => { out.push(sideLog(req, [nation], `🛠 ${unit.name} could not ${mode === 'dig' ? 'dig' : 'reinforce'} its trench: ${why}`)); };
      if (num(unit.data?.strength, 100) <= 0 || unit.data?.aboard) { fail('it is out of action'); continue; }
      if (require('../supply').exhausted(unit) && s.supplyEnabled !== false) { fail('it is out of supply'); continue; }
      const t = nearestTrench(req, unit, mode === 'dig' ? 'plan' : 'dug', km, sh => workable(friendsOf(nation), sh));
      if (!t) { fail(`no ${mode === 'dig' ? 'planned' : 'dug'} trench of its side within ${km} ${u}`); continue; }
      const f = factionNamed(req, nation);
      const timber = num(mode === 'dig' ? s.trenchDigTimber : s.trenchReinforceTimber, 4) * build;
      let state = null;
      if (f && timber > 0) {
        state = game.serializeState(game.q.state.get(f.id) || game.ensureState(req.lobby.id, f.id, s));
        if (num(state.resources.timber) < timber) { fail(`${f.name} is short of timber (needs ${timber})`); continue; }
      }
      const r = cutSection(req, t.shape, unit.x, unit.y, sectionKm * build, mode === 'dig' ? 'dug' : 'reinforced');
      if (state) { state.resources.timber = Math.round((num(state.resources.timber) - timber) * 10) / 10; game.writeState(state); pushFaction(req, g, f); }
      out.push(sideLog(req, [nation], `🛠 ${unit.name} ${mode === 'dig' ? 'dug' : 'reinforced'} ${Math.round(r.length)} ${u} of ${t.shape.label || 'trench'} ${placeName(markers, req.lobby, unit.x, unit.y)}${timber ? ` (${timber} timber)` : ''}`));
    }
    return out;
  }

  /**
   * Sappers blow up the section of an enemy trench nearest them: d20 + attack against d20 + trenchDemolishDefence + the
   * trench's cover + its best guard's defend (a land unit of its side within trenchRangeKm). Battle phase; uses an action.
   */
  router.post('/units/:mid/demolish', (req, res) => {
    const unit = loadUnit(req, res);
    if (!unit) return;
    const g = game.get(req.lobby.id), s = g.settings, gm = req.lobbyRole === 'gm', u = units(req);
    if (typeOf(unit)?.id !== 'sappers') return res.status(400).json({ error: 'Only sappers blow up trenches' });
    if (num(unit.data?.strength, 100) <= 0) return res.status(409).json({ error: `${unit.name} has no strength left` });
    const apError = game.checkAttack(g, gm, unit);
    if (apError) return res.status(409).json({ error: apError });
    const nation = unit.data?.nation || '', km = num(s.trenchDigKm, 20);
    const enemyTrench = sh => !!sh.data?.nation && (gm || !g.enabled || atWar(req, nation, sh.data.nation)) && access.canSee(sh, viewerOf(req));
    const target = [nearestTrench(req, unit, 'dug', km, enemyTrench), nearestTrench(req, unit, 'reinforced', km, enemyTrench)].filter(Boolean).sort((a, b) => a.dist - b.dist)[0];
    if (!target) return res.status(409).json({ error: `No enemy trench (of a nation you are at war with) within ${km} ${u} of ${unit.name}` });
    const sh = target.shape, holder = sh.data.nation;
    const markers = markersOf(req);
    const fx = game.factionEffects(req.lobby.id, nation);
    const traits = heroRules.effects(req.lobby, s, markers, unit, { enemyEntrenched: !!target.shape });
    const bonus = research.statBonus(fx, typeOf(unit)).attack, gen = heroRules.generalFor(req.lobby, s, markers, unit), worn = g.enabled ? Math.max(0, game.wornPenalty(s, unit) - traits.worn) : 0;
    const atk = num(unit.data?.attack) + bonus + (gen ? gen.bonus : 0) + traits.attack - worn;
    const at = trenches.section(req.lobby, sh.points, unit.x, unit.y, num(s.trenchSectionKm, 10));
    const mid = at.pieces.section[Math.floor(at.pieces.section.length / 2)];
    const guardSide = supply.friendsResolver(req.lobby)(holder);
    const guard = markers.filter(m => territory.isLandUnit(m) && num(m.data?.strength, 100) > 0 && guardSide.has(norm(m.data?.nation)) &&
      geo.distance(req.lobby, m.x, m.y, mid[0], mid[1]) <= num(s.trenchRangeKm, 20)).sort((a, b) => num(b.data?.defend) - num(a.data?.defend))[0] || null;
    const cover = trenchState(sh) === 'reinforced' ? num(s.trenchBonusReinforced, 4) : num(s.trenchBonusDug, 2);
    const def = num(s.trenchDemolishDefence, 2) + cover + (guard ? num(guard.data?.defend) - (g.enabled ? game.wornPenalty(s, guard) : 0) : 0);
    const aRoll = crypto.randomInt(1, 21), dRoll = crypto.randomInt(1, 21);
    const success = aRoll + atk > dRoll + def;
    if (g.enabled) writeMarker(req, unit, { data: { apUsed: num(unit.data?.apUsed) + 1, attacked: true, ...(unit.data?.submerged ? { submerged: false } : {}) } });
    let length = 0;
    if (success) length = cutSection(req, sh, unit.x, unit.y, num(s.trenchSectionKm, 10), null).length;
    const notes = [bonus ? `+${bonus} tech` : '', gen ? `+${gen.bonus} ${gen.hero.name}` : '', traits.attack ? `+${traits.attack} traits (${traits.notes.filter(n => n.fields.attack).map(n => n.name).join(', ')})` : '', worn ? `−${worn} worn` : '', `+${cover} ${trenchState(sh)} works`, guard ? `guarded by ${guard.name}` : ''].filter(Boolean);
    const msg = `💥 ${unit.name} attacked ${sh.label || `${holder}'s trench`} ${placeName(markers, req.lobby, mid[0], mid[1])}: ${aRoll}+${atk}=${aRoll + atk} vs ${dRoll}+${def}=${dRoll + def} (${notes.join(', ')}) → ` +
      (success ? `${Math.round(length)} ${u} of trench blown in` : 'the works hold');
    const fog = vision.on(req.lobby.id);
    const event = fog ? sideLog(req, [...(vision.sideNames(req.lobby.id, nation) || [nation]), ...(vision.sideNames(req.lobby.id, holder) || [holder])], msg, 'combat', { success })
      : logEvent(req.lobby.id, req.user.id, 'combat', msg, { success });
    res.status(201).json({ event, success, message: msg });
  });

  // ---- Scorched earth and raids on the works ---------------------------------------------------------------------
  /**
   * Wreck: sappers within trenchDigKm of a resource node with improvements knock it down one level. Their own or an
   * ally's works go down for certain (scorched earth, before the enemy takes them); an enemy's (a nation at war with
   * theirs) only on a roll, d20 + attack against d20 + trenchDemolishDefence + the defend of its best guard. It uses
   * the sappers' action, in the battle phase. Nodes of a nation at peace with theirs are left alone.
   */
  router.post('/units/:mid/wreck', (req, res) => {
    const unit = loadUnit(req, res);
    if (!unit) return;
    const g = game.get(req.lobby.id), s = g.settings, gm = req.lobbyRole === 'gm', u = units(req);
    if (typeOf(unit)?.id !== 'sappers') return res.status(400).json({ error: 'Only sappers wreck works' });
    if (num(unit.data?.strength, 100) <= 0) return res.status(409).json({ error: `${unit.name} has no strength left` });
    const apError = game.checkAttack(g, gm, unit);
    if (apError) return res.status(409).json({ error: apError });
    const nation = unit.data?.nation || '', km = num(s.trenchDigKm, 20);
    const markers = markersOf(req), v = viewerOf(req);
    const friends = supply.friendsResolver(req.lobby)(nation);
    const target = markers.filter(m => m.type === 'resource' && num(m.data?.improved) > 0 && access.canSee(m, v) && geo.distance(req.lobby, unit.x, unit.y, m.x, m.y) <= km)
      .filter(m => friends.has(norm(m.data?.nation)) || gm || !g.enabled || atWar(req, nation, m.data?.nation))
      .sort((a, b) => geo.distance(req.lobby, unit.x, unit.y, a.x, a.y) - geo.distance(req.lobby, unit.x, unit.y, b.x, b.y))[0];
    if (!target) return res.status(409).json({ error: `No improved works of your side or of a nation you are at war with within ${km} ${u} of ${unit.name}` });
    const holder = target.data?.nation || '', own = friends.has(norm(holder));
    const level = num(target.data?.improved), works = GameData.worksName(target.data?.kind, level).toLowerCase();
    let success = true, roll = '';
    if (!own) {
      const fx = game.factionEffects(req.lobby.id, nation);
      const traits = heroRules.effects(req.lobby, s, markers, unit);
      const bonus = research.statBonus(fx, typeOf(unit)).attack, gen = heroRules.generalFor(req.lobby, s, markers, unit), worn = g.enabled ? Math.max(0, game.wornPenalty(s, unit) - traits.worn) : 0;
      const atk = num(unit.data?.attack) + bonus + (gen ? gen.bonus : 0) + traits.attack - worn;
      const guardSide = supply.friendsResolver(req.lobby)(holder);
      const guard = markers.filter(m => territory.isLandUnit(m) && num(m.data?.strength, 100) > 0 && guardSide.has(norm(m.data?.nation)) &&
        geo.distance(req.lobby, m.x, m.y, target.x, target.y) <= km).sort((a, b) => num(b.data?.defend) - num(a.data?.defend))[0] || null;
      const def = num(s.trenchDemolishDefence, 2) + (guard ? num(guard.data?.defend) - (g.enabled ? game.wornPenalty(s, guard) : 0) : 0);
      const aRoll = crypto.randomInt(1, 21), dRoll = crypto.randomInt(1, 21);
      success = aRoll + atk > dRoll + def;
      const notes = [bonus ? `+${bonus} tech` : '', gen ? `+${gen.bonus} ${gen.hero.name}` : '', traits.attack ? `+${traits.attack} traits (${traits.notes.filter(n => n.fields.attack).map(n => n.name).join(', ')})` : '', worn ? `−${worn} worn` : '', guard ? `guarded by ${guard.name}` : 'unguarded'].filter(Boolean);
      roll = `: ${aRoll}+${atk}=${aRoll + atk} vs ${dRoll}+${def}=${dRoll + def} (${notes.join(', ')})`;
    }
    if (g.enabled) writeMarker(req, unit, { data: { apUsed: num(unit.data?.apUsed) + 1, attacked: true, ...(unit.data?.submerged ? { submerged: false } : {}) } });
    let after = target;
    if (success) after = writeMarker(req, target, { data: { improved: level - 1 } });
    const msg = own
      ? `🔥 ${unit.name} wrecked the ${works} at ${target.name}: its works are down to level ${level - 1}`
      : `💥 ${unit.name} raided the ${works} at ${target.name} (${holder})${roll} → ${success ? `wrecked: down to level ${level - 1}` : 'the works stand'}`;
    const fog = vision.on(req.lobby.id);
    const event = fog ? sideLog(req, [...(vision.sideNames(req.lobby.id, nation) || [nation]), ...(own ? [] : (vision.sideNames(req.lobby.id, holder) || [holder]))], msg, 'combat', { success })
      : logEvent(req.lobby.id, req.user.id, 'combat', msg, { success });
    // The holder's income changes with its works.
    if (success && g.enabled) { const f = factionNamed(req, holder); if (f) pushFaction(req, g, f); }
    res.status(201).json({ event, success, message: msg, marker: after });
  });

  // ---- Corps ------------------------------------------------------------------------------------------------------
  const CORPS_CATS = { front: new Set(['Infantry', 'Mounted & mobile']), art: new Set(['Artillery']), rear: new Set(['Support']) };
  function serializeCorps(row, markers) {
    const members = markers.filter(m => m.type === 'unit' && num(m.data?.corps) === row.id);
    return { id: row.id, nation: row.nation, name: row.name, line: access.safeJson(row.line || 'null'), front: row.front, unitIds: members.map(m => m.id), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  const mayCommandCorps = (req, row) => req.lobbyRole === 'gm' || norm(row.nation) === norm(req.member?.nation);
  function loadCorps(req, res) {
    const row = qc.one.get(Number(req.params.cid), req.lobby.id);
    if (!row || !mayCommandCorps(req, row)) { res.status(404).json({ error: 'No such corps' }); return null; }
    return row;
  }
  /** Units a request names that the caller commands, of one nation; { list, nation } or { error }. */
  function pickUnits(req, ids, nation) {
    const list = [];
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 200)) {
      const row = game.q.markerOne.get(Number(id));
      const m = row && row.lobby_id === req.lobby.id ? access.serializeMarker(row) : null;
      if (!m || m.type !== 'unit' || !canEditMarker(req, m)) continue;
      if (num(m.data?.strength, 100) <= 0) continue;
      const cat = typeOf(m)?.cat;
      if (cat === 'Naval' || cat === 'Air') continue;   // corps are armies on land
      list.push(m);
    }
    const n = nation || list[0]?.data?.nation || '';
    if (!list.length) return { error: 'Pick land units you command' };
    if (list.some(m => norm(m.data?.nation) !== norm(n))) return { error: 'A corps is one nation\'s units' };
    return { list, nation: n };
  }
  const broadcastCorps = (req, nation) => hub.broadcast(req.lobby.id, { type: 'corps' }, ws => ws.lobbyRole === 'gm' || norm(ws.nation) === norm(nation));

  router.get('/corps', (req, res) => {
    const markers = markersOf(req);
    res.json({ corps: qc.list.all(req.lobby.id).filter(r => mayCommandCorps(req, r)).map(r => serializeCorps(r, markers)) });
  });
  router.post('/corps', (req, res) => {
    const name = clean(req.body?.name, 60);
    if (!name) return res.status(400).json({ error: 'Name the corps' });
    const p = pickUnits(req, req.body?.unitIds);
    if (p.error) return res.status(400).json({ error: p.error });
    if (req.lobbyRole !== 'gm' && norm(p.nation) !== norm(req.member?.nation)) return res.status(403).json({ error: 'You can only form corps of your own nation' });
    const t = now();
    const id = qc.insert.run(req.lobby.id, p.nation, name, 'left', req.user.id, t, t).lastInsertRowid;
    for (const m of p.list) if (num(m.data?.corps) !== id) writeMarker(req, m, { data: { corps: id } });
    broadcastCorps(req, p.nation);
    res.status(201).json({ corps: serializeCorps(qc.one.get(id, req.lobby.id), markersOf(req)) });
  });
  router.patch('/corps/:cid', (req, res) => {
    const row = loadCorps(req, res);
    if (!row) return;
    if (req.body?.name !== undefined) { const name = clean(req.body.name, 60); if (!name) return res.status(400).json({ error: 'Name the corps' }); qc.rename.run(name, now(), row.id); }
    if (Array.isArray(req.body?.addIds) && req.body.addIds.length) {
      const p = pickUnits(req, req.body.addIds, row.nation);
      if (p.error) return res.status(400).json({ error: p.error });
      for (const m of p.list) if (num(m.data?.corps) !== row.id) writeMarker(req, m, { data: { corps: row.id } });
    }
    if (Array.isArray(req.body?.removeIds)) {
      for (const m of markersOf(req)) if (req.body.removeIds.map(Number).includes(m.id) && num(m.data?.corps) === row.id && canEditMarker(req, m)) writeMarker(req, m, { data: { corps: null } });
    }
    broadcastCorps(req, row.nation);
    res.json({ corps: serializeCorps(qc.one.get(row.id, req.lobby.id), markersOf(req)) });
  });
  router.delete('/corps/:cid', (req, res) => {
    const row = loadCorps(req, res);
    if (!row) return;
    for (const m of markersOf(req)) if (m.type === 'unit' && num(m.data?.corps) === row.id) writeMarker(req, m, { data: { corps: null } });
    qc.remove.run(row.id);
    broadcastCorps(req, row.nation);
    res.json({ ok: true });
  });

  /**
   * Form a corps on a line: front-line troops (infantry, cavalry, tanks…) spread evenly along it, artillery corpsDepthKm
   * behind them and support units twice as far, each moving by the usual rules (a unit short of movement gets as far as
   * it can; form the line again next turn and it carries on). `front` says which side of the line, walking it from its
   * first point, the enemy is on; every unit then faces that way.
   */
  router.post('/corps/:cid/line', (req, res) => {
    const row = loadCorps(req, res);
    if (!row) return;
    const g = game.get(req.lobby.id), s = g.settings;
    const pe = game.phaseError(g, req.lobbyRole === 'gm', 'move');
    if (pe) return res.status(409).json({ error: pe });
    const pts = (Array.isArray(req.body?.points) ? req.body.points : []).slice(0, 200)
      .filter(p => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))).map(p => [Number(p[0]), Number(p[1])]);
    if (pts.length < 2) return res.status(400).json({ error: 'Draw the line with at least two points' });
    const front = req.body?.front === 'right' ? 'right' : 'left';
    const cum = trenches.lengths(req.lobby, pts), L = cum[cum.length - 1];
    if (L <= 0) return res.status(400).json({ error: 'The line has no length' });
    const members = markersOf(req).filter(m => m.type === 'unit' && num(m.data?.corps) === row.id && num(m.data?.strength, 100) > 0 && !m.data?.aboard);
    if (!members.length) return res.status(409).json({ error: `${row.name} has no units left` });
    const rows = { front: [], art: [], rear: [] }, skipped = [];
    for (const m of members) {
      const cat = typeOf(m)?.cat;
      if (!cat || CORPS_CATS.front.has(cat)) rows.front.push(m);
      else if (CORPS_CATS.art.has(cat)) rows.art.push(m);
      else if (CORPS_CATS.rear.has(cat)) rows.rear.push(m);
      else skipped.push(m);   // fixed works, ships, aircraft
    }
    const depth = num(s.corpsDepthKm, 15);
    /** A slot `s` along the line, `back` km behind it (away from the front), and the front's heading in map space. */
    const slotAt = (sAlong, back) => {
      const p = trenches.pointAt(pts, cum, sAlong);
      // The segment under the point gives the line's direction there; km-space so the Earth's squeezed longitudes do not skew it.
      let i = 1;
      while (i < pts.length - 1 && cum[i] < sAlong) i++;
      const ex = geo.extent(req.lobby, p[0], p[1], 10), kx = 10 / ex.rx, ky = 10 / ex.ry;   // km per map px
      const dx = (pts[i][0] - pts[i - 1][0]) * kx, dy = (pts[i][1] - pts[i - 1][1]) * ky, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const fx = front === 'left' ? uy : -uy, fy = front === 'left' ? -ux : ux;   // toward the enemy, km-space (y down)
      return { x: Math.round((p[0] - fx * back / kx) * 10) / 10, y: Math.round((p[1] - fy * back / ky) * 10) / 10, facing: Math.atan2(fy / ky, fx / kx) };
    };
    // Each row in order along the line; units keep their order along it, so nobody crosses the corps to reach a slot.
    const plan = [];
    for (const [key, back] of [['front', 0], ['art', depth], ['rear', depth * 2]]) {
      const list = rows[key];
      if (!list.length) continue;
      const along = list.map(m => ({ m, s: trenches.nearest(req.lobby, pts, cum, m.x, m.y).s })).sort((a, b) => a.s - b.s);
      along.forEach((a, k) => plan.push({ m: a.m, ...slotAt((k + 0.5) / along.length * L, back) }));
    }
    const moved = [], short = [], errors = [], notes = [];
    for (const p of plan) {
      const r = moveMarkerTo(req, p.m, p.x, p.y, { facing: Math.round(p.facing * 1000) / 1000 });
      if (r.error) { errors.push(r.error); continue; }
      moved.push(r.after);
      if (r.clamped) short.push(p.m.name);
      if (r.note) notes.push(r.note);
    }
    qc.setLine.run(JSON.stringify(pts.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10])), front, now(), row.id);
    broadcastCorps(req, row.nation);
    const msg = `${row.name} forms on its line: ${moved.length} of ${plan.length} unit${plan.length === 1 ? '' : 's'} moved` +
      (short.length ? `; ${short.length} ran out of movement on the way (form the line again next turn)` : '') +
      (skipped.length ? `; ${skipped.length} left out (ships, aircraft or fixed works)` : '');
    res.json({ corps: serializeCorps(qc.one.get(row.id, req.lobby.id), markersOf(req)), moved, errors, short, message: msg, note: notes.join(' · ') || null });
  });

  // ---- Marching orders (docs/COMMS.md) ---------------------------------------------------------------------
  // A destination beyond this turn's reach: the unit goes as far as it can now (when the phase and its movement allow)
  // and keeps data.goal; at each End turn it carries on with the new turn's movement (processMarches). Every leg is an
  // ordinary move (game.checkMove), planned afresh from where the unit stands, so it boards a train whenever the
  // railway is quicker and walks when not. It ends when the unit arrives, a manned enemy trench halts it, or its course
  // proves impossible; moving it by hand, or forming its corps' line, cancels the order.
  const leftOf = (req, u, goal) => geo.distance(req.lobby, u.x, u.y, goal.x, goal.y);
  /** Turns still to go at the unit's walking pace (a railway may well beat it). */
  function turnsLeft(req, g, u, goal) {
    const per = num(u.data?.movement) * num(g.settings.kmPerMove, 50);
    return per > 0 ? Math.ceil(leftOf(req, u, goal) / per - 1e-6) : null;
  }
  /** Could the order ever be carried out? A land unit's course must not cross open water unless a railway goes round; a ship's must stay at sea. */
  function courseError(req, u, x, y) {
    if (territory.isLandUnit(u)) {
      const err = territory.landCourseError(req.lobby, u.x, u.y, x, y, true);
      if (!err) return null;
      const g = game.get(req.lobby.id);
      if (!territory.landCourseError(req.lobby, u.x, u.y, x, y, false) && require('../rails').plan(req.lobby, g.settings, u, x, y)) return null;
      return err;
    }
    if (u.type === 'unit' && typeOf(u)?.cat === 'Naval') return territory.shipCourseError(req.lobby, u.x, u.y, x, y);
    return null;
  }
  /** One leg of a march: { after, arrived, halted, byRail, note } or { waiting: why not this turn } or { cancelled: why never }. */
  function marchStep(req, u, goal, asPlayer) {
    if (u.type === 'unit' && num(u.data?.strength, 100) <= 0) return { cancelled: `${u.name} is gone` };
    if (u.type === 'hero' && u.data?.status === 'captured') return { cancelled: `${u.name} is a prisoner` };
    if (u.type === 'hero' && u.data?.status === 'travelling') return { waiting: `${u.name} is travelling` };
    if (u.data?.aboard) return { waiting: `${u.name} is aboard a convoy` };
    const r = moveMarkerTo(req, u, goal.x, goal.y, { goal }, { asPlayer });
    if (r.error) return r.fatal ? { cancelled: r.error } : { waiting: r.error };
    const arrived = Math.hypot(r.after.x - goal.x, r.after.y - goal.y) < 0.05;
    const after = arrived || r.blocked ? writeMarker(req, r.after, { data: { goal: null } }) : r.after;
    return { after, arrived, halted: r.blocked, byRail: !!r.route, note: r.note };
  }
  const pace = (req, g, u, goal, byRail) => {
    const t = turnsLeft(req, g, u, goal);
    // By rail the walking estimate means little (a train covers several turns' march in one).
    return `${Math.round(leftOf(req, u, goal))} ${units(req)} to go${byRail ? ', by rail' : t ? `, about ${t} more turn${t === 1 ? '' : 's'}` : ''}`;
  };

  /**
   * POST /units/goal { moves: [{ id, x, y }] }: marching orders for the player's units or heroes (a group keeps its shape:
   * the browser sends each its own point). Each sets off now as far as it can; the rest is walked at End turn.
   */
  router.post('/units/goal', (req, res) => {
    const g = game.get(req.lobby.id);
    if (!g.enabled) return res.status(400).json({ error: 'Marching orders need game mode' });
    const all = markersOf(req), v = viewerOf(req);
    const moves = Array.isArray(req.body?.moves) ? req.body.moves.slice(0, 200) : [];
    const moved = [], errors = [], lines = [];
    for (const mv of moves) {
      const u = all.find(m => m.id === Number(mv.id));
      if (!u || !['unit', 'hero'].includes(u.type) || !access.canSee(u, v) || !canEditMarker(req, u)) { errors.push(`${mv.id}: not yours to order`); continue; }
      const x = Math.round(num(mv.x) * 10) / 10, y = Math.round(num(mv.y) * 10) / 10;
      if (x < 0 || y < 0 || x > req.lobby.map_width || y > req.lobby.map_height) { errors.push(`${u.name}: off the map`); continue; }
      const err = courseError(req, u, x, y);
      if (err) { errors.push(`${u.name}: ${err}`); continue; }
      const goal = { x, y, turn: g.turn };
      const r = marchStep(req, u, goal, false);
      if (r.cancelled) { errors.push(r.cancelled); continue; }
      if (r.waiting) {
        const after = writeMarker(req, u, { data: { goal } });
        moved.push(after);
        lines.push(`${u.name} sets off at the start of the next turn (${r.waiting}); ${pace(req, g, after, goal, false)}`);
        continue;
      }
      moved.push(r.after);
      lines.push(r.arrived ? `${u.name} arrived` : r.halted ? r.halted : `${u.name} marches: ${pace(req, g, r.after, goal, r.byRail)}`);
    }
    res.json({ moved, errors, message: lines.join(' · ') || null });
  });
  /** DELETE /units/:mid/goal: cancel a marching order (the unit stays where it is). */
  router.delete('/units/:mid/goal', (req, res) => {
    const u = markersOf(req).find(m => m.id === Number(req.params.mid));
    if (!u || !access.canSee(u, viewerOf(req)) || !canEditMarker(req, u)) return res.status(404).json({ error: 'Not found' });
    res.json({ marker: writeMarker(req, u, { data: { goal: null } }) });
  });
  /** End turn, after movement is reset: every march carries on with the new turn's movement; each side hears how they went. */
  function processMarches(req) {
    const g = game.get(req.lobby.id);
    if (!g.enabled) return 0;
    const byNation = new Map(), say = (n, s) => { if (!byNation.has(n)) byNation.set(n, []); byNation.get(n).push(s); };
    let count = 0;
    for (const u of markersOf(req).filter(m => ['unit', 'hero'].includes(m.type) && m.data?.goal)) {
      const goal = u.data.goal, n = u.data?.nation || '', r = marchStep(req, u, goal, true);
      count++;
      if (r.cancelled) { writeMarker(req, u, { data: { goal: null } }); say(n, `${u.name}'s march is called off: ${r.cancelled}`); }
      else if (r.waiting) say(n, `${u.name} waits: ${r.waiting}`);
      else if (r.arrived) say(n, `${u.name} reached its objective${r.byRail ? ' by rail' : ''}`);
      else if (r.halted) say(n, r.halted);
      else say(n, `${u.name} marched on: ${pace(req, g, r.after, goal, r.byRail)}`);
    }
    for (const [n, list] of byNation) sideLog(req, [n], `🚩 ${n || 'Unaligned'} marches, turn ${g.turn}: ${list.join('; ')}`);
    return count;
  }

  return { router, processDigs, processMarches };
};
