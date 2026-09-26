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
  resetUnits: db.prepare(`UPDATE markers SET data = json_set(data, '$.movedKm', 0, '$.apUsed', 0), updated_at = ? WHERE lobby_id = ? AND type = 'unit'`),
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
  const s = (settings || get(lobbyId).settings).startStock || GameData.DEFAULT_SETTINGS.startStock;
  q.insertState.run(factionId, lobbyId, JSON.stringify(emptyResources(num(s.resources))), num(s.money), num(s.manpower), num(s.rp), now());
  return q.state.get(factionId);
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
  return q.factions.all(lobbyId).map(f => ({
    faction: access.serializeFaction(f),
    state: serializeState(q.state.get(f.id) || ensureState(lobbyId, f.id, settings)),
  }));
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
function endTurn(lobby) {
  const g = get(lobby.id);
  if (!g.enabled) throw new Error('Game mode is off');
  const markers = q.markers.all(lobby.id).map(access.serializeMarker);
  const fs = factionStates(lobby.id, g.settings);
  const summaries = [], strengthHits = [];
  const territory = require('./territory');
  transaction(() => {
    q.insertSnapshot.run(lobby.id, g.turn, JSON.stringify({ states: fs.map(x => x.state), game: { turn: g.turn, date: g.date }, territories: territory.all(lobby.id), relations: relations(lobby.id) }), now());
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
      writeState(state);
      summaries.push({ faction, text: parts.length ? parts.join(', ') : 'no income', data: { income: inc } });
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
    }
    q.resetUnits.run(now(), lobby.id);
    g.turn += 1;
    g.date = GameData.stepDate(g.date, g.turnStep);
    g.deadline = '';
    save(g);
  });
  return { game: get(lobby.id), summaries, shortages: strengthHits };
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
      for (const t of data.territories) territory.write(lobby.id, t.factionId, t.geometry);
    }
    if (Array.isArray(data.relations)) for (const r of data.relations) setRelation(lobby.id, r.a, r.b, r.status, r.sinceTurn);
    g.turn = data.game.turn; g.date = data.game.date;
    save(g);
    q.deleteSnapshot.run(snap.id);
  });
  return get(lobby.id);
}

// ---- Rules applied by the marker routes --------------------------------------------------
/**
 * Check a unit move against its remaining allowance. Returns { x, y, clamped, movedKm, error }.
 * GMs, disabled game mode and the waive switch pass straight through.
 */
function checkMove(lobby, g, isGm, marker, x, y) {
  if (!g.enabled || isGm || g.settings.waiveMovement || marker.type !== 'unit') return { x, y, clamped: false };
  const dist = geo.distance(lobby, marker.x, marker.y, x, y);
  if (dist < 1e-6) return { x, y, clamped: false };
  const allowance = num(marker.data.movement) * num(g.settings.kmPerMove);
  const used = num(marker.data.movedKm);
  const remaining = Math.max(0, allowance - used);
  const unit = geo.isEarth(lobby) ? 'km' : (lobby.scale_label || 'units');
  if (remaining <= 0.01) return { error: `${marker.name} has no movement left this turn (${round(allowance)} ${unit} per turn)` };
  if (dist <= remaining + 1e-6) return { x, y, clamped: false, movedKm: round(used + dist) };
  const t = remaining / dist;
  return { x: round(marker.x + (x - marker.x) * t), y: round(marker.y + (y - marker.y) * t), clamped: true, movedKm: round(allowance), remaining, dist: round(dist) };
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
  get, save, serializeGame, ensureState, serializeState, writeState, factionStates, incomeFor, endTurn, undoTurn,
  checkMove, checkAttack, PROTECTED_UNIT_FIELDS, emptyResources, q,
  relationStatus, setRelation, relations, diplomacy, serializeDiplomacy,
};
