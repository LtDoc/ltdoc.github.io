'use strict';
/**
 * Game layer core (docs/GAME-DESIGN.md): per-campaign game row, per-faction treasuries, income, turn
 * resolution, undo, and the movement / action-point rules the marker routes enforce.
 * Routes live in routes/game.js; this module never touches req/res.
 */
const { db, now } = require('./db');
const access = require('./lobbyAccess');
const geo = require('./geo');
const GameData = require('../public/js/game-data');
const UnitTypes = require('../public/js/units');
const research = require('./research');

const q = {
  game: db.prepare('SELECT * FROM game WHERE lobby_id = ?'),
  upsertGame: db.prepare(`INSERT INTO game (lobby_id, enabled, turn, date, turn_step, deadline, settings, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lobby_id) DO UPDATE SET enabled = excluded.enabled, turn = excluded.turn, date = excluded.date,
      turn_step = excluded.turn_step, deadline = excluded.deadline, settings = excluded.settings, updated_at = excluded.updated_at`),
  factions: db.prepare('SELECT * FROM factions WHERE lobby_id = ? ORDER BY name COLLATE NOCASE'),
  faction: db.prepare('SELECT * FROM factions WHERE id = ? AND lobby_id = ?'),
  state: db.prepare('SELECT * FROM faction_state WHERE faction_id = ?'),
  states: db.prepare('SELECT * FROM faction_state WHERE lobby_id = ?'),
  insertState: db.prepare(`INSERT OR IGNORE INTO faction_state (faction_id, lobby_id, resources, money, manpower, rp, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  updateState: db.prepare(`UPDATE faction_state SET resources = ?, money = ?, manpower = ?, rp = ?, techs = ?, research = ?,
    production = ?, mods = ?, updated_at = ? WHERE faction_id = ?`),
  markers: db.prepare('SELECT * FROM markers WHERE lobby_id = ?'),
  resetUnits: db.prepare(`UPDATE markers SET data = json_set(data, '$.movedKm', 0, '$.apUsed', 0), updated_at = ? WHERE lobby_id = ? AND type IN ('unit', 'hero')`),
  clearReveals: db.prepare(`UPDATE markers SET data = json_remove(data, '$.revealTo'), updated_at = ? WHERE lobby_id = ? AND json_extract(data, '$.revealTo') IS NOT NULL`),
  setStrength: db.prepare(`UPDATE markers SET data = json_set(data, '$.strength', ?), updated_at = ? WHERE id = ?`),
  relations: db.prepare('SELECT * FROM relations WHERE lobby_id = ?'),
  relation: db.prepare('SELECT * FROM relations WHERE lobby_id = ? AND a = ? AND b = ?'),
  setRelation: db.prepare(`INSERT INTO relations (lobby_id, a, b, status, since_turn) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(lobby_id, a, b) DO UPDATE SET status = excluded.status, since_turn = excluded.since_turn`),
  diplomacy: db.prepare('SELECT * FROM diplomacy WHERE lobby_id = ? ORDER BY id DESC LIMIT 100'),
  diplomacyOne: db.prepare('SELECT * FROM diplomacy WHERE id = ? AND lobby_id = ?'),
  insertDiplomacy: db.prepare('INSERT INTO diplomacy (lobby_id, from_faction, to_faction, kind, status, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  resolveDiplomacy: db.prepare('UPDATE diplomacy SET status = ?, resolved_at = ? WHERE id = ?'),
  insertSnapshot: db.prepare('INSERT INTO turn_snapshots (lobby_id, turn, data, created_at) VALUES (?, ?, ?, ?)'),
  lastSnapshot: db.prepare('SELECT * FROM turn_snapshots WHERE lobby_id = ? ORDER BY turn DESC, id DESC LIMIT 1'),
  deleteSnapshot: db.prepare('DELETE FROM turn_snapshots WHERE id = ?'),
  pruneSnapshots: db.prepare(`DELETE FROM turn_snapshots WHERE lobby_id = ? AND id NOT IN
    (SELECT id FROM turn_snapshots WHERE lobby_id = ? ORDER BY turn DESC, id DESC LIMIT 5)`),
  insertReport: db.prepare(`INSERT INTO turn_reports (lobby_id, turn, faction_id, data, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(lobby_id, turn, faction_id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`),
  reports: db.prepare('SELECT * FROM turn_reports WHERE lobby_id = ? AND turn = ? ORDER BY faction_id'),
  reportTurns: db.prepare('SELECT DISTINCT turn FROM turn_reports WHERE lobby_id = ? ORDER BY turn DESC LIMIT 60'),
  deleteReports: db.prepare('DELETE FROM turn_reports WHERE lobby_id = ? AND turn = ?'),
  pruneReports: db.prepare('DELETE FROM turn_reports WHERE lobby_id = ? AND turn < ?'),
  enabledGames: db.prepare("SELECT * FROM game WHERE enabled = 1 AND deadline != ''"),
  setDeadlineNotified: db.prepare('UPDATE game SET deadline_notified = ? WHERE lobby_id = ?'),
};

const num = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; };
/** node:sqlite has no transaction helper: run fn inside BEGIN/COMMIT, rolling back on error. */
function transaction(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const round = n => Math.round(n * 10) / 10;

// ---- Game row -------------------------------------------------------------------------
function get(lobbyId) {
  const row = q.game.get(lobbyId);
  if (!row) return { lobbyId, enabled: false, turn: 1, date: '1914-07-28', turnStep: 'week', deadline: '', settings: { ...GameData.DEFAULT_SETTINGS } };
  return serializeGame(row);
}
function serializeGame(row) {
  return {
    lobbyId: row.lobby_id, enabled: !!row.enabled, turn: row.turn, date: row.date, turnStep: row.turn_step,
    deadline: row.deadline, settings: GameData.mergeSettings(GameData.DEFAULT_SETTINGS, access.safeJson(row.settings)),
    updatedAt: row.updated_at,
  };
}
function save(g) {
  // Store only the settings that differ from the defaults so tuning the defaults later reaches old campaigns.
  const diff = {};
  for (const [k, v] of Object.entries(g.settings || {})) {
    if (JSON.stringify(v) !== JSON.stringify(GameData.DEFAULT_SETTINGS[k])) diff[k] = v;
  }
  q.upsertGame.run(g.lobbyId, g.enabled ? 1 : 0, g.turn, g.date, g.turnStep, g.deadline || '', JSON.stringify(diff), now());
  return get(g.lobbyId);
}

// ---- Faction state --------------------------------------------------------------------
function emptyResources(fill = 0) { return Object.fromEntries(GameData.RESOURCE_KEYS.map(k => [k, fill])); }

function ensureState(lobbyId, factionId, settings) {
  const gm = get(lobbyId);
  const s = (settings || gm.settings).startStock || GameData.DEFAULT_SETTINGS.startStock;
  const inserted = q.insertState.run(factionId, lobbyId, JSON.stringify(emptyResources(num(s.resources))), num(s.money), num(s.manpower), num(s.rp), now()).changes > 0;
  if (inserted) {
    // A new faction starts with every tech dated on or before the campaign's start year.
    research.ensureTree(lobbyId);
    const st = serializeState(q.state.get(factionId));
    st.techs = research.startingKeys(research.list(lobbyId), research.yearOf(gm.settings.startYear || gm.date));
    writeState(st);
  }
  return q.state.get(factionId);
}

/** Aggregated tech effects for a faction (by id or name); empty effects when the faction is unknown. */
function factionEffects(lobbyId, factionRef) {
  const techs = research.list(lobbyId);
  const f = typeof factionRef === 'number' ? q.faction.get(factionRef, lobbyId)
    : q.factions.all(lobbyId).find(x => x.name.toLowerCase() === String(factionRef || '').toLowerCase());
  if (!f) return research.emptyEffects(techs);
  const st = q.state.get(f.id);
  return research.effectsFor(techs, st ? (access.safeJson(st.techs) || []) : []);
}
function serializeState(row) {
  const res = { ...emptyResources(), ...access.safeJson(row.resources) };
  return {
    factionId: row.faction_id, resources: res, money: row.money, manpower: row.manpower, rp: row.rp,
    techs: access.safeJson(row.techs || '[]'), research: access.safeJson(row.research || '{}'),
    production: access.safeJson(row.production || '[]'), mods: access.safeJson(row.mods || '{}'), updatedAt: row.updated_at,
  };
}
function writeState(s) {
  q.updateState.run(JSON.stringify(s.resources), round(s.money), round(s.manpower), round(s.rp), JSON.stringify(s.techs || []),
    JSON.stringify(s.research || {}), JSON.stringify(s.production || []), JSON.stringify(s.mods || {}), now(), s.factionId);
}
/** Every faction of the lobby with its state (created on demand). */
function factionStates(lobbyId, settings) {
  const gm = get(lobbyId);
  let starting = null;   // lazily computed: states created before the tree existed get the starting kit
  return q.factions.all(lobbyId).map(f => {
    const state = serializeState(q.state.get(f.id) || ensureState(lobbyId, f.id, settings));
    if (gm.enabled && !state.techs.length) {
      if (!starting) { research.ensureTree(lobbyId); starting = research.startingKeys(research.list(lobbyId), research.yearOf(gm.settings.startYear || gm.date)); }
      if (starting.length) { state.techs = starting; writeState(state); }
    }
    return { faction: access.serializeFaction(f), state };
  });
}

// ---- Income -----------------------------------------------------------------------------
/**
 * Projected income for one faction this turn: resource nodes it owns, towns and factories in its colours,
 * the base allowance, the GM's modifiers, and upkeep when enabled. Pure: nothing is written.
 */
function incomeFor(lobby, g, faction, state, markers) {
  const s = g.settings;
  const name = faction.name.toLowerCase();
  const mine = markers.filter(m => String(m.data?.nation || '').toLowerCase() === name);
  const inc = { resources: emptyResources(), money: num(s.baseMoney), rp: num(s.baseRp), manpower: num(s.baseManpower), notes: [], upkeep: emptyResources() };
  for (const m of mine) {
    // Phase 5: a place taken this turn is still being secured and yields nothing until the next turn.
    if (s.capturedIdle && ['resource', 'town', 'factory'].includes(m.type) && num(m.data?.capturedTurn, -1) === g.turn) {
      inc.notes.push(`${m.name}: captured this turn, no yield yet`);
      continue;
    }
    if (m.type === 'resource' && GameData.byKey[m.data.kind]) {
      const y = num(m.data.yield);
      inc.resources[m.data.kind] += y;
      if (y) inc.notes.push(`${m.name}: +${y} ${GameData.byKey[m.data.kind].name.toLowerCase()}`);
    } else if (m.type === 'town') {
      const c = s.cityIncome[m.data.size] || s.cityIncome.village;
      inc.money += num(c.money); inc.rp += num(c.rp); inc.manpower += num(c.manpower);
    } else if (m.type === 'factory') {
      const lvl = Math.max(1, num(m.data.industry, 1));
      inc.money += num(s.factoryIncome.money) * lvl; inc.rp += num(s.factoryIncome.rp) * lvl; inc.manpower += num(s.factoryIncome.manpower) * lvl;
    }
  }
  const mods = state.mods || {};
  inc.money += num(mods.money); inc.rp += num(mods.rp); inc.manpower += num(mods.manpower);
  for (const k of GameData.RESOURCE_KEYS) inc.resources[k] += num(mods.resources?.[k]);
  research.applyIncome(research.effectsFor(research.list(lobby.id), state.techs || []), inc);
  if (s.upkeep) {
    for (const u of mine.filter(m => m.type === 'unit' && num(m.data.strength, 100) > 0)) {
      inc.upkeep.grain += num(s.upkeepGrain);
      const t = UnitTypes.resolve(u.data.unitType);
      if (t && (GameData.OIL_CATEGORIES.has(t.cat) || GameData.OIL_TYPES.has(t.id))) inc.upkeep.oil += num(s.upkeepOil);
    }
  }
  return inc;
}

// ---- Relations and diplomacy ------------------------------------------------------------------
const pair = (a, b) => (a < b ? [a, b] : [b, a]);
function relationStatus(lobbyId, a, b) {
  if (a === b) return 'self';
  const [x, y] = pair(Number(a), Number(b));
  return q.relation.get(lobbyId, x, y)?.status || 'peace';
}
function setRelation(lobbyId, a, b, status, turn) {
  const [x, y] = pair(Number(a), Number(b));
  q.setRelation.run(lobbyId, x, y, status, turn || 1);
}
function relations(lobbyId) { return q.relations.all(lobbyId).map(r => ({ a: r.a, b: r.b, status: r.status, sinceTurn: r.since_turn })); }
function serializeDiplomacy(d) {
  return { id: d.id, from: d.from_faction, to: d.to_faction, kind: d.kind, status: d.status, note: d.note, createdBy: d.created_by, createdAt: d.created_at, resolvedAt: d.resolved_at };
}
function diplomacy(lobbyId) { return q.diplomacy.all(lobbyId).map(serializeDiplomacy); }

// ---- Turn resolution --------------------------------------------------------------------
/**
 * End the current turn. Returns { game, summaries: [{faction, text, data}], shortages }.
 * The caller logs events and broadcasts; this function only changes the database (in one transaction).
 */
/**
 * hooks.spawn(faction, state, item) is called for every finished build inside the transaction and should
 * create the marker (or throw to skip it); it returns the marker for the summary.
 */
function endTurn(lobby, hooks = {}) {
  const g = get(lobby.id);
  const production = require('./production');
  if (!g.enabled) throw new Error('Game mode is off');
  const markers = q.markers.all(lobby.id).map(access.serializeMarker);
  const fs = factionStates(lobby.id, g.settings);
  const summaries = [], strengthHits = [];
  const territory = require('./territory');
  transaction(() => {
    q.insertSnapshot.run(lobby.id, g.turn, JSON.stringify({ states: fs.map(x => x.state), game: { turn: g.turn, date: g.date }, territories: territory.all(lobby.id), relations: relations(lobby.id), provinces: require('./provinces').ownership(lobby.id) }), now());
    q.pruneSnapshots.run(lobby.id, lobby.id);
    for (const { faction, state } of fs) {
      const inc = incomeFor(lobby, g, faction, state, markers);
      const parts = [];
      for (const k of GameData.RESOURCE_KEYS) {
        const delta = inc.resources[k] - inc.upkeep[k];
        if (!delta && !inc.upkeep[k]) continue;
        let next = state.resources[k] + delta;
        if (next < 0) {
          // Shortage: the stockpile hits zero and the faction's best units lose strength.
          strengthHits.push({ faction, resource: k, short: -next });
          next = 0;
        }
        state.resources[k] = round(next);
        parts.push(`${delta >= 0 ? '+' : ''}${round(delta)} ${GameData.byKey[k].name.toLowerCase()}`);
      }
      state.money = round(state.money + inc.money); state.rp = round(state.rp + inc.rp); state.manpower = round(state.manpower + inc.manpower);
      if (inc.money) parts.push(`${inc.money >= 0 ? '+' : ''}${round(inc.money)} money`);
      if (inc.rp) parts.push(`+${round(inc.rp)} RP`);
      if (inc.manpower) parts.push(`+${round(inc.manpower)} manpower`);
      // Research: the bank of research points flows into the active project.
      const techs = research.list(lobby.id);
      const researched = research.advance(state, techs, g).map(t => t.name);
      if (researched.length) parts.push(`researched ${researched.join(', ')}`);
      // Recovery: damaged units heal when the faction has medical services.
      const fx = research.effectsFor(techs, state.techs || []);
      if (fx.recover > 0) {
        for (const u of markers.filter(m => m.type === 'unit' && String(m.data?.nation || '').toLowerCase() === faction.name.toLowerCase() && num(m.data.strength, 100) > 0 && num(m.data.strength, 100) < 100)) {
          const st = Math.min(100, num(u.data.strength, 100) + fx.recover);
          q.setStrength.run(st, now(), u.id); u.data.strength = st;
        }
      }
      // Places that changed hands during the turn (stamped by setMarkerNation).
      const flipped = markers.filter(m => ['resource', 'town', 'factory'].includes(m.type) && num(m.data?.capturedTurn, -1) === g.turn);
      const gained = flipped.filter(m => String(m.data.nation || '').toLowerCase() === faction.name.toLowerCase()).map(m => ({ name: m.name, from: m.data.capturedFrom || 'neutral' }));
      const lost = flipped.filter(m => String(m.data.capturedFrom || '').toLowerCase() === faction.name.toLowerCase()).map(m => ({ name: m.name, to: m.data.nation || 'neutral' }));
      // A build at a site the faction no longer holds is lost with the site (no refund: the enemy has the works).
      const lostBuilds = [];
      state.production = (state.production || []).filter(item => {
        if (item.typeId === 'factory' || !item.siteId) return true;
        const site = markers.find(m => m.id === item.siteId);
        if (!site || String(site.data?.nation || '').toLowerCase() === faction.name.toLowerCase()) return true;
        lostBuilds.push({ type: UnitTypes.LIST.find(u => u.id === item.typeId)?.unit || item.typeId, site: site.name });
        return false;
      });
      if (gained.length) parts.push(`took ${gained.map(x => x.name).join(', ')}`);
      if (lost.length) parts.push(`lost ${lost.map(x => x.name).join(', ')}`);
      if (lostBuilds.length) parts.push(`${lostBuilds.length} build${lostBuilds.length === 1 ? '' : 's'} lost with ${[...new Set(lostBuilds.map(x => x.site))].join(', ')}`);
      // Production: builds advance; finished ones become markers via the hook.
      const built = [];
      for (const item of production.advance(state)) {
        try { const m = hooks.spawn ? hooks.spawn(faction, state, item) : null; if (m) built.push(m.name); }
        catch (e) { parts.push(`build failed: ${e.message}`); }
      }
      if (built.length) parts.push(`completed ${built.join(', ')}`);
      const queued = (state.production || []).length;
      if (queued) parts.push(`${queued} build${queued === 1 ? '' : 's'} in progress`);
      writeState(state);
      const rs = research.researchState(state);
      const active = rs.active ? techs.find(t => t.key === rs.active) : null;
      summaries.push({ faction, text: parts.length ? parts.join(', ') : 'no income', data: {
        income: inc, built, researched, gained, lost, lostBuilds, shortages: [],
        stock: { resources: { ...state.resources }, money: state.money, manpower: state.manpower, rp: state.rp },
        research: active ? { name: active.name, progress: num(rs.progress[active.key]), rp: active.rp, queue: rs.queue.map(k => techs.find(t => t.key === k)?.name || k) } : null,
        queued: (state.production || []).map(item => ({ type: item.typeId === 'factory' ? 'Factory' : (UnitTypes.LIST.find(u => u.id === item.typeId)?.unit || item.typeId), site: item.siteName || '', turnsLeft: item.turnsLeft })),
      } });
    }
    // Shortages bite: up to three of the faction's strongest units lose 10 % strength per short resource.
    for (const hit of strengthHits) {
      const units = markers.filter(m => m.type === 'unit' && String(m.data?.nation || '').toLowerCase() === hit.faction.name.toLowerCase() && num(m.data.strength, 100) > 0)
        .sort((a, b) => num(b.data.attack) - num(a.data.attack)).slice(0, 3);
      for (const u of units) {
        const st = Math.max(0, num(u.data.strength, 100) - 10);
        q.setStrength.run(st, now(), u.id);
        u.data.strength = st;
      }
      hit.units = units.map(u => u.name);
      const s = summaries.find(x => x.faction.id === hit.faction.id);
      if (s) s.data.shortages.push({ resource: hit.resource, units: hit.units });
    }
    q.resetUnits.run(now(), lobby.id);
    q.clearReveals.run(now(), lobby.id);   // spies' recon lasts until the end of the turn
    const ended = { turn: g.turn, date: g.date };
    g.turn += 1;
    g.date = GameData.stepDate(g.date, g.turnStep);
    g.deadline = '';
    save(g);
    // One report per faction, kept for the last 60 turns, for the turn report modal.
    for (const s of summaries) {
      q.insertReport.run(lobby.id, ended.turn, s.faction.id, JSON.stringify({ ...s.data, turn: ended.turn, date: ended.date, nextDate: g.date, text: s.text }), now());
    }
    q.pruneReports.run(lobby.id, ended.turn - 60);
  });
  return { game: get(lobby.id), summaries, shortages: strengthHits };
}

/** Turn reports of one ended turn (the latest when turn is omitted): [{ turn, factionId, data }]. */
function reports(lobbyId, turn) {
  const turns = q.reportTurns.all(lobbyId).map(r => r.turn);
  const t = turn ? Number(turn) : turns[0];
  if (!t) return { turn: null, turns, reports: [] };
  return { turn: t, turns, reports: q.reports.all(lobbyId, t).map(r => ({ turn: r.turn, factionId: r.faction_id, data: access.safeJson(r.data) || {}, createdAt: r.created_at })) };
}

/** Restore the faction states and calendar from the last snapshot. Returns the restored game or null. */
function undoTurn(lobby) {
  const snap = q.lastSnapshot.get(lobby.id);
  if (!snap) return null;
  const data = access.safeJson(snap.data);
  const g = get(lobby.id);
  const territory = require('./territory');
  transaction(() => {
    for (const s of data.states || []) if (q.state.get(s.factionId)) writeState(s);
    if (Array.isArray(data.territories)) {
      territory.clear(lobby.id);
      for (const t of data.territories) territory.write(lobby.id, t.factionId, t.geometry, require('./provinces').CLEAN);
    }
    if (Array.isArray(data.provinces)) require('./provinces').restoreOwnership(lobby.id, data.provinces);
    if (Array.isArray(data.relations)) for (const r of data.relations) setRelation(lobby.id, r.a, r.b, r.status, r.sinceTurn);
    g.turn = data.game.turn; g.date = data.game.date;
    save(g);
    q.deleteSnapshot.run(snap.id);
    q.deleteReports.run(lobby.id, data.game.turn);
  });
  return get(lobby.id);
}

// ---- Rules applied by the marker routes --------------------------------------------------
/**
 * Check a unit move against its remaining allowance. Returns { x, y, clamped, movedKm, cost, route, error }.
 * A land unit or hero takes the railway when walking to the track, riding at settings.railSpeed and walking
 * off is cheaper than going straight (server/rails.js); `cost` is what the move spends, `route` the rail trip.
 * GMs, disabled game mode and the waive switch pass straight through.
 */
function checkMove(lobby, g, isGm, marker, x, y) {
  if (!g.enabled || isGm || g.settings.waiveMovement || !['unit', 'hero'].includes(marker.type)) return { x, y, clamped: false };
  const dist = geo.distance(lobby, marker.x, marker.y, x, y);
  if (dist < 1e-6) return { x, y, clamped: false };
  const bonus = research.statBonus(factionEffects(lobby.id, marker.data?.nation), UnitTypes.resolve(marker.data?.unitType)).movement;
  const allowance = (num(marker.data.movement) + bonus) * num(g.settings.kmPerMove);
  const used = num(marker.data.movedKm);
  const remaining = Math.max(0, allowance - used);
  const unit = geo.isEarth(lobby) ? 'km' : (lobby.scale_label || 'units');
  if (remaining <= 0.01) return { error: `${marker.name} has no movement left this turn (${round(allowance)} ${unit} per turn)` };
  const route = require('./rails').plan(lobby, g.settings, marker, x, y);
  const cost = route ? route.cost : dist;
  if (cost <= remaining + 1e-6) return { x, y, clamped: false, movedKm: round(used + cost), cost, route };
  if (route) {
    const w = require('./rails').walk(lobby, route.path, remaining);
    return { x: round(w.x), y: round(w.y), clamped: true, movedKm: round(allowance), remaining, dist: round(cost), cost, route };
  }
  const t = remaining / dist;
  return { x: round(marker.x + (x - marker.x) * t), y: round(marker.y + (y - marker.y) * t), clamped: true, movedKm: round(allowance), remaining, dist: round(dist), cost };
}

/** Attack reach of a unit in campaign units: (range + tech bonus) × kmPerRange. */
function attackRange(lobby, g, marker) {
  const bonus = research.statBonus(factionEffects(lobby.id, marker.data?.nation), UnitTypes.resolve(marker.data?.unitType)).range;
  return Math.max(0, num(marker.data?.range) + num(bonus)) * num(g.settings.kmPerRange, 50);
}
/** Is the defender within the attacker's reach? Returns an error string or null. GMs and the waive switch pass. */
function checkRange(lobby, g, isGm, attacker, defender) {
  if (!g.enabled || isGm || g.settings.waiveMovement) return null;
  const reach = attackRange(lobby, g, attacker);
  const dist = geo.distance(lobby, attacker.x, attacker.y, defender.x, defender.y);
  if (dist <= reach + 1e-6) return null;
  const unit = geo.isEarth(lobby) ? 'km' : (lobby.scale_label || 'units');
  return `${defender.name} is ${round(dist)} ${unit} away; ${attacker.name} reaches ${round(reach)} ${unit}`;
}
/** Whether a unit may attack this turn; returns an error string or null. */
function checkAttack(g, isGm, marker) {
  if (!g.enabled || isGm) return null;
  const ap = num(marker.data.ap);
  if (ap <= 0) return `${marker.name} has no action points and cannot attack`;
  if (num(marker.data.apUsed) >= ap) return `${marker.name} has used its action points this turn`;
  return null;
}

/** Fields a player may not change on their own unit while the game is running. */
const PROTECTED_UNIT_FIELDS = ['attack', 'defend', 'ap', 'range', 'movement', 'strength', 'unitType', 'nation', 'movedKm', 'apUsed'];

module.exports = {
  get, save, serializeGame, ensureState, serializeState, writeState, factionStates, incomeFor, endTurn, undoTurn, reports,
  checkMove, checkAttack, checkRange, attackRange, PROTECTED_UNIT_FIELDS, emptyResources, q,
  relationStatus, setRelation, relations, diplomacy, serializeDiplomacy, factionEffects,
};
