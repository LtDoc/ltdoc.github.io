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
  upsertGame: db.prepare(`INSERT INTO game (lobby_id, enabled, turn, date, turn_step, deadline, settings, phase, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lobby_id) DO UPDATE SET enabled = excluded.enabled, turn = excluded.turn, date = excluded.date,
      turn_step = excluded.turn_step, deadline = excluded.deadline, settings = excluded.settings, phase = excluded.phase, updated_at = excluded.updated_at`),
  factions: db.prepare('SELECT * FROM factions WHERE lobby_id = ? ORDER BY name COLLATE NOCASE'),
  faction: db.prepare('SELECT * FROM factions WHERE id = ? AND lobby_id = ?'),
  state: db.prepare('SELECT * FROM faction_state WHERE faction_id = ?'),
  states: db.prepare('SELECT * FROM faction_state WHERE lobby_id = ?'),
  insertState: db.prepare(`INSERT OR IGNORE INTO faction_state (faction_id, lobby_id, resources, money, manpower, rp, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  updateState: db.prepare(`UPDATE faction_state SET resources = ?, money = ?, manpower = ?, rp = ?, techs = ?, research = ?,
    production = ?, mods = ?, updated_at = ? WHERE faction_id = ?`),
  markers: db.prepare('SELECT * FROM markers WHERE lobby_id = ?'),
  clearBattles: db.prepare('DELETE FROM battles WHERE lobby_id = ? AND turn <= ?'),
  clearCraters: db.prepare('DELETE FROM craters WHERE lobby_id = ? AND expires_turn <= ?'),
  nmlAreas: db.prepare(`SELECT points FROM shapes WHERE lobby_id = ? AND kind = 'area' AND json_extract(data, '$.noMansLand') = 1`),
  trenchShapes: db.prepare(`SELECT id, label, points, data FROM shapes WHERE lobby_id = ? AND kind = 'trench'`),
  // New turn: movement and action points back (and units that attacked may move again); heldTurns counts the turns a unit has stayed put (it digs in: rifle
  // pits, then wire, in the battle scenes).
  resetUnits: db.prepare(`UPDATE markers SET data = json_remove(json_set(data, '$.movedKm', 0, '$.apUsed', 0, '$.heldTurns',
    CASE WHEN COALESCE(json_extract(data, '$.movedKm'), 0) > 0 OR json_extract(data, '$.ride') IS NOT NULL THEN 0 ELSE COALESCE(json_extract(data, '$.heldTurns'), 0) + 1 END),
    '$.trail', '$.ride', '$.attacked', '$.dig'), updated_at = ? WHERE lobby_id = ? AND type IN ('unit', 'hero')`),
  clearReveals: db.prepare(`UPDATE markers SET data = json_remove(data, '$.revealTo'), updated_at = ? WHERE lobby_id = ? AND json_extract(data, '$.revealTo') IS NOT NULL`),
  setStrength: db.prepare(`UPDATE markers SET data = json_set(data, '$.strength', ?), updated_at = ? WHERE id = ?`),
  markerOne: db.prepare('SELECT * FROM markers WHERE id = ?'),
  setAttrition: db.prepare(`UPDATE markers SET data = json_set(data, '$.strength', ?, '$.unsuppliedTurns', ?, '$.surrendered', json(?), '$.supplies', ?), updated_at = ? WHERE id = ?`),
  setSupplied: db.prepare(`UPDATE markers SET data = json_set(data, '$.supplied', json(?), '$.supplyFrom', json(?), '$.supplies', ?), updated_at = ? WHERE id = ?`),
  setBlockaded: db.prepare(`UPDATE markers SET data = json_set(data, '$.blockaded', json('true')), updated_at = ? WHERE id = ?`),
  clearBlockaded: db.prepare(`UPDATE markers SET data = json_remove(data, '$.blockaded'), updated_at = ? WHERE id = ?`),
  relations: db.prepare('SELECT * FROM relations WHERE lobby_id = ?'),
  relation: db.prepare('SELECT * FROM relations WHERE lobby_id = ? AND a = ? AND b = ?'),
  setRelation: db.prepare(`INSERT INTO relations (lobby_id, a, b, status, since_turn) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(lobby_id, a, b) DO UPDATE SET status = excluded.status, since_turn = excluded.since_turn`),
  diplomacy: db.prepare('SELECT * FROM diplomacy WHERE lobby_id = ? ORDER BY id DESC LIMIT 100'),
  diplomacyOne: db.prepare('SELECT * FROM diplomacy WHERE id = ? AND lobby_id = ?'),
  trades: db.prepare("SELECT * FROM trades WHERE lobby_id = ? AND (status IN ('pending', 'active') OR resolved_at > ?) ORDER BY id DESC LIMIT 200"),
  tradeOne: db.prepare('SELECT * FROM trades WHERE id = ? AND lobby_id = ?'),
  tradesActive: db.prepare("SELECT * FROM trades WHERE lobby_id = ? AND status = 'active' ORDER BY id"),
  insertTrade: db.prepare('INSERT INTO trades (lobby_id, from_faction, to_faction, give, take, mode, turns, turns_left, status, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  updateTrade: db.prepare('UPDATE trades SET status = ?, turns_left = ?, log = ?, resolved_at = ? WHERE id = ?'),
  openTradesBetween: db.prepare("SELECT * FROM trades WHERE lobby_id = ? AND status IN ('pending', 'active') AND ((from_faction = ? AND to_faction = ?) OR (from_faction = ? AND to_faction = ?))"),
  readyAll: db.prepare('SELECT faction_id, turn, user_id, at FROM turn_ready WHERE lobby_id = ?'),
  setReady: db.prepare('INSERT INTO turn_ready (lobby_id, faction_id, turn, user_id, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (lobby_id, faction_id) DO UPDATE SET turn = excluded.turn, user_id = excluded.user_id, at = excluded.at'),
  clearReady: db.prepare('DELETE FROM turn_ready WHERE lobby_id = ? AND faction_id = ?'),
  clearAllReady: db.prepare('DELETE FROM turn_ready WHERE lobby_id = ?'),
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
/**
 * node:sqlite has no transaction helper: run fn inside BEGIN/COMMIT, rolling back on error. Inside another
 * transaction (End turn) fn simply joins it.
 */
let txDepth = 0;
function transaction(fn) {
  if (txDepth || db.isTransaction) return fn();
  txDepth++;
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { txDepth--; }
}
const round = n => Math.round(n * 10) / 10;

// ---- Game row -------------------------------------------------------------------------
function get(lobbyId) {
  const row = q.game.get(lobbyId);
  if (!row) return { lobbyId, enabled: false, turn: 1, date: '1914-07-28', turnStep: 'week', deadline: '', phase: 'move', settings: { ...GameData.DEFAULT_SETTINGS } };
  return serializeGame(row);
}
function serializeGame(row) {
  const settings = GameData.mergeSettings(GameData.DEFAULT_SETTINGS, access.safeJson(row.settings));
  return {
    lobbyId: row.lobby_id, enabled: !!row.enabled, turn: row.turn, date: row.date, turnStep: row.turn_step,
    deadline: row.deadline, settings, updatedAt: row.updated_at,
    // Movement or battle phase; without phased turns everything is allowed all turn ('open').
    phase: settings.phases === false ? 'open' : (row.phase === 'battle' ? 'battle' : 'move'),
  };
}
function save(g) {
  // Store only the settings that differ from the defaults so tuning the defaults later reaches old campaigns.
  const diff = {};
  for (const [k, v] of Object.entries(g.settings || {})) {
    if (JSON.stringify(v) !== JSON.stringify(GameData.DEFAULT_SETTINGS[k])) diff[k] = v;
  }
  q.upsertGame.run(g.lobbyId, g.enabled ? 1 : 0, g.turn, g.date, g.turnStep, g.deadline || '', JSON.stringify(diff), g.phase === 'battle' ? 'battle' : 'move', now());
  return get(g.lobbyId);
}

// ---- Phased turns -----------------------------------------------------------------------
const PHASE_LABEL = { move: 'movement phase', battle: 'battle phase' };
/**
 * Phased turns (settings.phases): units move in the movement phase and fight in the battle phase. Returns an error
 * string when `kind` ('move' or 'attack') is closed in the current phase, else null. The GM is never limited.
 */
function phaseError(g, isGm, kind, name) {
  if (!g.enabled || isGm || g.phase === 'open') return null;
  if (kind === 'move' && g.phase === 'battle') return `Battle phase: ${name ? `${name} holds its position` : 'units hold their positions'} until the movement phase of the next turn`;
  if (kind === 'attack' && g.phase === 'move') return 'Movement phase: attacks open when the GM starts the battle phase';
  return null;
}

// ---- Worn units ------------------------------------------------------------------------------
/** Combat penalty of a worn unit: −1 attack and defend for every settings.wornStep % of strength it has lost. */
function wornPenalty(settings, m) {
  const step = num(settings?.wornStep, 20);
  if (step <= 0 || m?.type !== 'unit') return 0;
  const lost = 100 - Math.max(0, Math.min(100, num(m.data?.strength, 100)));
  return Math.floor(lost / step + 1e-9);
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
      // Improvements (long-term projects) add a share of the base yield per level.
      const y = GameData.resourceYield(m, s), extra = Math.round((y - num(m.data.yield)) * 10) / 10;
      inc.resources[m.data.kind] += y;
      if (y) inc.notes.push(`${m.name}: +${y} ${GameData.byKey[m.data.kind].name.toLowerCase()}${extra > 0 ? ` (${extra} from its works)` : ''}`);
    } else if (m.type === 'town') {
      const c = s.cityIncome[m.data.size] || s.cityIncome.village;
      inc.money += num(c.money); inc.rp += num(c.rp); inc.manpower += num(c.manpower);
      // Development levels (long-term projects) add their own income on top of the town's size.
      const dev = num(m.data.developed), d = s.townDevIncome || {};
      if (dev > 0) { inc.money += dev * num(d.money); inc.rp += dev * num(d.rp); inc.manpower += dev * num(d.manpower); }
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
    // The nation's towns feed a home army for free; units beyond it eat grain. Ships burn coal; engines burn oil.
    const units = mine.filter(m => m.type === 'unit' && num(m.data.strength, 100) > 0 && !m.data?.surrendered);
    const free = s.upkeepFree || {};
    const allowance = mine.filter(m => m.type === 'town').reduce((a, t) => a + num(free[t.data?.size] ?? free.village, 0), 0);
    const fed = Math.max(0, units.length - allowance);
    inc.upkeep.grain += round(fed * num(s.upkeepGrain));
    let ships = 0, engines = 0;
    for (const u of units) {
      const fuel = GameData.fuelOf(UnitTypes.resolve(u.data.unitType));
      if (fuel === 'coal') ships++; else if (fuel === 'oil') engines++;
    }
    inc.upkeep.coal += round(ships * num(s.upkeepCoal));
    inc.upkeep.oil += round(engines * num(s.upkeepOil));
    inc.notes.push(`Upkeep: ${units.length} unit${units.length === 1 ? '' : 's'}, ${Math.min(units.length, allowance)} fed by its towns (${allowance} allowed)${fed ? `, ${fed} more eat ${round(fed * num(s.upkeepGrain))} grain` : ''}${ships ? `; ${ships} ship${ships === 1 ? '' : 's'} burn ${round(ships * num(s.upkeepCoal))} coal` : ''}${engines ? `; ${engines} engine${engines === 1 ? '' : 's'} burn ${round(engines * num(s.upkeepOil))} oil` : ''}`);
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
  require('./vision').schedulePush(lobbyId);   // allies share sight
}
function relations(lobbyId) { return q.relations.all(lobbyId).map(r => ({ a: r.a, b: r.b, status: r.status, sinceTurn: r.since_turn })); }
function serializeDiplomacy(d) {
  return { id: d.id, from: d.from_faction, to: d.to_faction, kind: d.kind, status: d.status, note: d.note, createdBy: d.created_by, createdAt: d.created_at, resolvedAt: d.resolved_at };
}
function diplomacy(lobbyId) { return q.diplomacy.all(lobbyId).map(serializeDiplomacy); }

// ---- Trades (docs/COMMS.md) ---------------------------------------------------------------------
/** Goods a trade can carry: every resource plus money, manpower and research points. */
const TRADE_KEYS = [...GameData.RESOURCE_KEYS, 'money', 'manpower', 'rp'];
function serializeTrade(t) {
  return {
    id: t.id, from: t.from_faction, to: t.to_faction, give: access.safeJson(t.give) || {}, take: access.safeJson(t.take) || {},
    mode: t.mode, turns: t.turns, turnsLeft: t.turns_left, status: t.status, note: t.note, log: access.safeJson(t.log) || [],
    createdBy: t.created_by, createdAt: t.created_at, resolvedAt: t.resolved_at,
  };
}
/** Open trades plus those settled in the last week. */
function trades(lobbyId) { return q.trades.all(lobbyId, Date.now() - 7 * 86400000).map(serializeTrade); }
const stockOf = (state, k) => GameData.RESOURCE_KEYS.includes(k) ? num(state.resources[k]) : num(state[k]);
function addStock(state, k, v) {
  if (GameData.RESOURCE_KEYS.includes(k)) state.resources[k] = round(num(state.resources[k]) + v);
  else state[k] = round(num(state[k]) + v);
}
/** The first good a state cannot cover, or null. */
function shortOf(state, bundle) {
  for (const [k, v] of Object.entries(bundle || {})) if (num(v) > 0 && stockOf(state, k) < num(v) - 1e-9) return k;
  return null;
}
function goodsText(bundle) {
  const parts = Object.entries(bundle || {}).filter(([, v]) => num(v) > 0)
    .map(([k, v]) => `${round(v)} ${k === 'rp' ? 'RP' : (GameData.byKey[k]?.name || k).toLowerCase()}`);
  return parts.length ? parts.join(', ') : 'nothing';
}
const goodName = k => k === 'rp' ? 'research points' : (GameData.byKey[k]?.name || k).toLowerCase();
/**
 * Exchange one delivery between two faction states (in memory): both sides must cover their half or
 * nothing moves. Returns { ok, short: { side, good } | null }.
 */
function exchange(fromState, toState, t) {
  const sf = shortOf(fromState, t.give), st = shortOf(toState, t.take);
  if (sf || st) return { ok: false, short: sf ? { side: 'from', good: sf } : { side: 'to', good: st } };
  for (const [k, v] of Object.entries(t.give)) { addStock(fromState, k, -num(v)); addStock(toState, k, num(v)); }
  for (const [k, v] of Object.entries(t.take)) { addStock(toState, k, -num(v)); addStock(fromState, k, num(v)); }
  return { ok: true, short: null };
}
/** War ends every open trade between the two sides. Returns the trades cancelled. */
function cancelTradesBetween(lobbyId, a, b, reason) {
  const out = [];
  for (const t of q.openTradesBetween.all(lobbyId, a, b, b, a)) {
    const log = [...(access.safeJson(t.log) || []), { turn: get(lobbyId).turn, ok: false, text: reason || 'cancelled' }];
    q.updateTrade.run('cancelled', t.turns_left, JSON.stringify(log), Date.now(), t.id);
    out.push(serializeTrade(q.tradeOne.get(t.id, lobbyId)));
  }
  return out;
}

/** What a queue item is, for reports: a unit's name, 'Factory', or a project ('Develop town to level 2'). */
function buildLabel(item) {
  if (item.typeId === 'factory') return 'Factory';
  const p = GameData.PROJECTS[item.typeId];
  if (p) return `${p.label} to level ${item.toLevel || '?'}`;
  return UnitTypes.LIST.find(u => u.id === item.typeId)?.unit || item.typeId;
}

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
    q.insertSnapshot.run(lobby.id, g.turn, JSON.stringify({ states: fs.map(x => x.state), game: { turn: g.turn, date: g.date }, territories: territory.all(lobby.id), relations: relations(lobby.id), provinces: require('./provinces').ownership(lobby.id), trades: q.tradesActive.all(lobby.id).map(t => ({ id: t.id, status: t.status, turnsLeft: t.turns_left, log: t.log })) }), now());
    q.pruneSnapshots.run(lobby.id, lobby.id);
    // Recurring trades deliver first: both halves or nothing, then one fewer delivery to go.
    const tradeNotes = new Map();
    const note = (fid, text) => { if (!tradeNotes.has(fid)) tradeNotes.set(fid, []); tradeNotes.get(fid).push(text); };
    for (const row of q.tradesActive.all(lobby.id)) {
      const t = serializeTrade(row);
      const A = fs.find(x => x.faction.id === t.from), B = fs.find(x => x.faction.id === t.to);
      if (!A || !B) continue;
      const r = exchange(A.state, B.state, t);
      const left = Math.max(0, t.turnsLeft - 1);
      const text = r.ok ? `${A.faction.name} → ${B.faction.name}: ${goodsText(t.give)} for ${goodsText(t.take)}`
        : `missed: ${(r.short.side === 'from' ? A : B).faction.name} was short of ${goodName(r.short.good)}`;
      q.updateTrade.run(left > 0 ? 'active' : 'completed', left, JSON.stringify([...t.log, { turn: g.turn, ok: r.ok, text }].slice(-60)), left > 0 ? null : Date.now(), t.id);
      const tail = left > 0 ? ` (${left} to go)` : ' (last delivery)';
      note(A.faction.id, r.ok ? `trade with ${B.faction.name}: sent ${goodsText(t.give)}, got ${goodsText(t.take)}${tail}` : `trade with ${B.faction.name} ${text}${tail}`);
      note(B.faction.id, r.ok ? `trade with ${A.faction.name}: sent ${goodsText(t.take)}, got ${goodsText(t.give)}${tail}` : `trade with ${A.faction.name} ${text}${tail}`);
    }
    for (const { faction, state } of fs) {
      const inc = incomeFor(lobby, g, faction, state, markers);
      const parts = [...(tradeNotes.get(faction.id) || [])];
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
      state.money = round(state.money + inc.money); state.manpower = round(state.manpower + inc.manpower);
      if (inc.money) parts.push(`${inc.money >= 0 ? '+' : ''}${round(inc.money)} money`);
      if (inc.rp) parts.push(`+${round(inc.rp)} RP`);
      if (inc.manpower) parts.push(`+${round(inc.manpower)} manpower`);
      // Research: the RP banked during the turn flows into the active project (one tech at most per turn);
      // this turn's RP income is banked afterwards, for the next turn.
      const techs = research.list(lobby.id);
      const researched = research.advance(state, techs, g).map(t => t.name);
      state.rp = round(state.rp + inc.rp);
      if (researched.length) parts.push(`researched ${researched.join(', ')}`);
      // Recovery: damaged units heal when the faction has medical services.
      const fx = research.effectsFor(techs, state.techs || []);
      if (fx.recover > 0) {
        for (const u of markers.filter(m => m.type === 'unit' && String(m.data?.nation || '').toLowerCase() === faction.name.toLowerCase() && num(m.data.strength, 100) > 0 && num(m.data.strength, 100) < 100 && m.data?.supplied !== false)) {   // cut-off units get no medical care
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
        lostBuilds.push({ type: buildLabel(item), site: site.name });
        return false;
      });
      if (gained.length) parts.push(`took ${gained.map(x => x.name).join(', ')}`);
      if (lost.length) parts.push(`lost ${lost.map(x => x.name).join(', ')}`);
      if (lostBuilds.length) parts.push(`${lostBuilds.length} build${lostBuilds.length === 1 ? '' : 's'} lost with ${[...new Set(lostBuilds.map(x => x.site))].join(', ')}`);
      // Production: builds advance; finished ones become markers via the hook.
      const built = [];
      for (const item of production.advance(state, g.turn)) {
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
        queued: (state.production || []).map(item => ({ type: buildLabel(item), site: item.siteName || '', turnsLeft: item.turnsLeft })),
      } });
    }
    // Shortages bite: up to three of the faction's strongest units that need the missing resource lose 10 % strength
    // (coal: ships; oil: aircraft and motor vehicles; anything else: any unit).
    for (const hit of strengthHits) {
      const needs = m => (hit.resource === 'coal' || hit.resource === 'oil') ? GameData.fuelOf(UnitTypes.resolve(m.data?.unitType)) === hit.resource : true;
      const units = markers.filter(m => m.type === 'unit' && String(m.data?.nation || '').toLowerCase() === hit.faction.name.toLowerCase() && num(m.data.strength, 100) > 0 && needs(m))
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
    // Supply is kept live; make sure it is current, then cut-off units suffer attrition (docs/UNITS.md).
    if (g.settings.supplyEnabled !== false) {
      applySupply(lobby, g.settings);
      for (const a of applyAttrition(lobby, g.settings, summaries)) {
        const u = markers.find(m => m.id === a.id);
        if (u) { u.data.strength = a.to; u.data.supplied = false; u.data.supplies = a.supplies; }
      }
    }
    // Field hospitals heal damaged friendly units around them (docs/UNITS.md).
    const supply = require('./supply');
    for (const h of supply.healing(lobby, g.settings, markers)) {
      q.setStrength.run(h.to, now(), h.unit.id);
      h.unit.data.strength = h.to;
      const s = summaries.find(x => x.faction.name.toLowerCase() === String(h.unit.data?.nation || '').toLowerCase());
      if (s) (s.data.healed = s.data.healed || []).push({ name: h.unit.name, from: h.from, to: h.to, hospital: h.hospital.name });
    }
    // Supply for the coming turn, from where everything stands now (new units included).
    if (g.settings.supplyEnabled !== false) applySupply(lobby, g.settings, summaries);
    q.resetUnits.run(now(), lobby.id);
    // Gunfire and shelling last for the turn they happened in; the record stays a little longer, for the dead left
    // lying on the field (the turn of the fight and the next REMAINS_TURNS - 1).
    q.clearBattles.run(lobby.id, g.turn - (REMAINS_TURNS - 1));
    q.clearReveals.run(now(), lobby.id);   // spies' recon lasts until the end of the turn
    const ended = { turn: g.turn, date: g.date };
    g.turn += 1;
    g.date = GameData.stepDate(g.date, g.turnStep);
    q.clearCraters.run(lobby.id, g.turn);   // shell craters fade after ten turns
    g.deadline = '';
    g.phase = 'move';   // a new turn opens with its movement phase
    save(g);
    // One report per faction, kept for the last 60 turns, for the turn report modal.
    for (const s of summaries) {
      if (s.data.healed?.length) s.text += `, field hospitals restored ${s.data.healed.length} unit${s.data.healed.length === 1 ? '' : 's'}`;
      if (s.data.attrition?.length) {
        const gone = s.data.attrition.filter(a => a.surrendered), worn = s.data.attrition.filter(a => !a.surrendered);
        if (worn.length) s.text += `, attrition (out of supplies): ${worn.slice(0, 6).map(a => `${a.name} ${a.from}→${a.to}%`).join(', ')}${worn.length > 6 ? ', …' : ''}`;
        if (gone.length) s.text += `, ⚑ surrendered for want of supply: ${gone.map(a => a.name).join(', ')}`;
      }
      if (s.data.unsupplied?.length) s.text += `, ${s.data.unsupplied.length} unit${s.data.unsupplied.length === 1 ? '' : 's'} cut off (${s.data.unsupplied.slice(0, 6).map(u => typeof u === 'string' ? u : `${u.name} ${u.supplies}/${u.of}`).join(', ')}${s.data.unsupplied.length > 6 ? ', …' : ''})`;
      q.insertReport.run(lobby.id, ended.turn, s.faction.id, JSON.stringify({ ...s.data, turn: ended.turn, date: ended.date, nextDate: g.date, text: s.text }), now());
    }
    q.pruneReports.run(lobby.id, ended.turn - 60);
  });
  return { game: get(lobby.id), summaries, shortages: strengthHits };
}

/**
 * Work out supply for every land unit and store it on the marker (data.supplied), writing only changes. A unit linked
 * to supply is topped up to supplyStock at once (data.supplies); one cut off keeps what it carries (End turn uses it).
 * Optional `summaries` get each faction's list of cut-off units. Returns { supplied, unsupplied, changed }.
 */
function applySupply(lobby, settings, summaries) {
  const markers = q.markers.all(lobby.id).map(access.serializeMarker);
  const supply = require('./supply'), result = supply.compute(lobby, settings, markers), max = supply.stockMax(settings);
  let supplied = 0, unsupplied = 0;
  const changed = [], changes = [], blockades = [];
  transaction(() => {   // one commit for every changed unit, not one each
    for (const m of markers) {
      // Towns: blockaded or not (supply.js), kept on the town for its popup and badge.
      if (m.type === 'town' && !!m.data?.blockaded !== result.blockaded.has(m.id)) {
        const on = result.blockaded.has(m.id);
        (on ? q.setBlockaded : q.clearBlockaded).run(now(), m.id);
        changed.push(m.id);
        changes.push({ before: m, after: access.serializeMarker(q.markerOne.get(m.id)) });
        blockades.push({ town: m, on });
        continue;
      }
      const r = result.get(m.id);
      if (!r) continue;
      if (r.supplied) supplied++; else unsupplied++;
      const from = r.from ? { id: r.from.id ?? null, name: r.from.name || '', kind: r.from.kind } : null;
      const sameFrom = JSON.stringify(m.data?.supplyFrom ?? null) === JSON.stringify(from);
      const stock = r.supplied ? max : Math.min(max, Math.max(0, Math.round(num(m.data?.supplies, max))));
      if ((m.data?.supplied !== false) !== r.supplied || m.data?.supplied === undefined || !sameFrom || num(m.data?.supplies, -1) !== stock) {
        q.setSupplied.run(JSON.stringify(r.supplied), JSON.stringify(from), stock, now(), m.id);
        changed.push(m.id);
        changes.push({ before: m, after: access.serializeMarker(q.markerOne.get(m.id)) });
      }
      if (!r.supplied && summaries) {
        const s = summaries.find(x => x.faction.name.toLowerCase() === String(m.data?.nation || '').toLowerCase());
        if (s) (s.data.unsupplied = s.data.unsupplied || []).push({ name: m.name, supplies: stock, of: max });
      }
    }
  });
  return { supplied, unsupplied, changed, changes, blockades, result };
}

/**
 * Attrition at End turn: a land unit still cut off counts its turns without supply and uses one of the supplies it
 * carries (data.supplies, up to supplyStock). With none left it loses attritionRate % of its remaining strength each
 * turn, and below attritionDisbandBelow % it surrenders (strength 0, white flag). Supplied units start counting again
 * (and were topped up by applySupply).
 */
function applyAttrition(lobby, settings, summaries) {
  const rate = Number(settings.attritionRate ?? 25) / 100, floor = Number(settings.attritionDisbandBelow ?? 10);
  const max = require('./supply').stockMax(settings);
  const out = [];
  for (const m of q.markers.all(lobby.id).map(access.serializeMarker)) {
    if (m.type !== 'unit' || m.data?.supplied === undefined || num(m.data?.strength, 100) <= 0) continue;
    if (!require('./supply').needsSupply(m)) continue;
    if (m.data.supplied !== false) {
      if (num(m.data.unsuppliedTurns)) q.setAttrition.run(num(m.data.strength, 100), 0, 'false', num(m.data.supplies, max), now(), m.id);
      continue;
    }
    const turns = num(m.data.unsuppliedTurns) + 1;
    const from = num(m.data.strength, 100), left = Math.min(max, Math.max(0, Math.round(num(m.data.supplies, max))));
    let to = from, surrendered = false, supplies = left;
    if (left > 0) supplies = left - 1;   // lives on what it carries
    else if (rate > 0) {
      to = Math.round(from * (1 - rate));
      if (to < floor) { to = 0; surrendered = true; }
    }
    q.setAttrition.run(to, turns, surrendered ? 'true' : 'false', supplies, now(), m.id);
    const s = summaries && summaries.find(x => x.faction.name.toLowerCase() === String(m.data?.nation || '').toLowerCase());
    if (s && to < from) (s.data.attrition = s.data.attrition || []).push({ name: m.name, from, to, turns, surrendered });
    out.push({ id: m.id, name: m.name, nation: m.data?.nation, from, to, turns, surrendered, supplies });
  }
  return out;
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
    // Recurring trades go back to where they stood (deliveries are inside the restored treasuries).
    if (Array.isArray(data.trades)) for (const t of data.trades) q.updateTrade.run(t.status, t.turnsLeft, t.log, null, t.id);
    g.turn = data.game.turn; g.date = data.game.date;
    g.phase = 'battle';   // back where End turn was pressed
    save(g);
    q.deleteSnapshot.run(snap.id);
    q.deleteReports.run(lobby.id, data.game.turn);
  });
  return get(lobby.id);
}

// ---- Rules applied by the marker routes --------------------------------------------------
/**
 * Check a unit move against its remaining allowance. Returns { x, y, clamped, movedKm, cost, route, error, fatal (the
 * error is the course itself, open water or a manned trench, not this turn's movement or phase), blocked (a
 * manned enemy trench stopped it), to (the target it was cut back to, when a clamped move would also have met one) }.
 * A land unit or hero takes the railway when walking to the track, riding at settings.railSpeed and walking
 * off is cheaper than going straight (server/rails.js); `cost` is what the move spends, `route` the rail trip.
 * GMs, disabled game mode and the waive switch pass straight through.
 */
/**
 * No Man's Land (areas drawn with that tag): every km walked across it costs settings.noMansLandCost km of movement.
 * A straight walk from (x0, y0) to (x1, y1), sampled every quarter map px: { cost, slowed (it crosses some), frac(budget)
 * (how far along the way, 0..1, that much movement gets it) }.
 */
function walkCost(lobby, settings, x0, y0, x1, y1) {
  const dist = geo.distance(lobby, x0, y0, x1, y1), mult = Math.max(1, num(settings.noMansLandCost, 3));
  const flat = { cost: dist, slowed: false, frac: b => (dist > 0 ? Math.min(1, b / dist) : 1) };
  if (mult <= 1 || dist <= 0) return flat;
  const lo = [Math.min(x0, x1), Math.min(y0, y1)], hi = [Math.max(x0, x1), Math.max(y0, y1)];
  const polys = q.nmlAreas.all(lobby.id).map(r => access.safeJson(r.points)).filter(p => Array.isArray(p) && p.length >= 3).map(p => {
    const xs = p.map(v => v[0]), ys = p.map(v => v[1]);
    return { p, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }).filter(b => b.x1 >= lo[0] && b.x0 <= hi[0] && b.y1 >= lo[1] && b.y0 <= hi[1]);
  if (!polys.length) return flat;
  const inside = (b, x, y) => {
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) return false;
    let c = false;
    for (let i = 0, j = b.p.length - 1; i < b.p.length; j = i++) {
      const [xi, yi] = b.p[i], [xj, yj] = b.p[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const n = Math.max(1, Math.min(4000, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.25))), w = new Float64Array(n);
  let cost = 0, slowed = false;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t, mud = polys.some(b => inside(b, x, y));
    w[i] = dist / n * (mud ? mult : 1); cost += w[i]; slowed = slowed || mud;
  }
  if (!slowed) return flat;
  return { cost, slowed, frac: budget => { let acc = 0; for (let i = 0; i < n; i++) { if (acc + w[i] >= budget) return (i + (budget - acc) / w[i]) / n; acc += w[i]; } return 1; } };
}

/** Where segment a→b crosses segment c→d: the fraction along a→b (0..1), or null. */
function segCross(ax, ay, bx, by, c, d) {
  const rx = bx - ax, ry = by - ay, sx = d[0] - c[0], sy = d[1] - c[1], den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = c[0] - ax, qy = c[1] - ay, t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}
/**
 * Manned trenches hold the line (docs/WARFARE.md): a land unit cannot cross a dug (or reinforced) trench of a nation it
 * is at war with where a land unit of that trench's side (its nation or an ally) stands within trenchRangeKm of the
 * crossing, the distance that gives trench cover. Unmanned stretches, gaps sappers blew and planned trenches let it
 * through; so does going round the end. `pts` is the move's path ([[x, y], …]). Returns the first blocking crossing
 * { k (segment), t (fraction along it), trench, holder } or null.
 */
function trenchBlock(lobby, g, marker, pts) {
  const territory = require('./territory');
  if (g.settings.trenchBlocks === false || !territory.isLandUnit(marker)) return null;
  const norm = s => String(s || '').trim().toLowerCase(), nation = norm(marker.data?.nation);
  if (!nation) return null;
  const factions = q.factions.all(lobby.id), me = factions.find(f => norm(f.name) === nation);
  if (!me) return null;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const lo = [Math.min(...xs), Math.min(...ys)], hi = [Math.max(...xs), Math.max(...ys)];
  const enemy = q.trenchShapes.all(lobby.id).map(r => ({ id: r.id, label: r.label, points: access.safeJson(r.points), data: access.safeJson(r.data) || {} })).filter(s => {
    if (!Array.isArray(s.points) || s.points.length < 2 || !s.data.state || s.data.state === 'plan' || !s.data.nation) return false;
    if (Math.max(...s.points.map(p => p[0])) < lo[0] || Math.min(...s.points.map(p => p[0])) > hi[0] || Math.max(...s.points.map(p => p[1])) < lo[1] || Math.min(...s.points.map(p => p[1])) > hi[1]) return false;
    const f = factions.find(x => norm(x.name) === norm(s.data.nation));
    return !!f && f.id !== me.id && relationStatus(lobby.id, me.id, f.id) === 'war';
  });
  if (!enemy.length) return null;
  const range = num(g.settings.trenchRangeKm, 20);
  let markers = null, friendsOf = null;
  const manned = (holder, x, y) => {
    markers = markers || q.markers.all(lobby.id).map(access.serializeMarker);
    friendsOf = friendsOf || require('./supply').friendsResolver(lobby);
    const side = friendsOf(holder);
    return markers.some(m => m.id !== marker.id && territory.isLandUnit(m) && num(m.data?.strength, 100) > 0 && side.has(norm(m.data?.nation)) && geo.distance(lobby, m.x, m.y, x, y) <= range);
  };
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1], [bx, by] = pts[k], hits = [];
    for (const s of enemy) for (let i = 1; i < s.points.length; i++) {
      const t = segCross(ax, ay, bx, by, s.points[i - 1], s.points[i]);
      if (t !== null) hits.push({ t, s, x: ax + (bx - ax) * t, y: ay + (by - ay) * t });
    }
    hits.sort((a, b) => a.t - b.t);
    for (const h of hits) {
      if (k === 1 && geo.distance(lobby, ax, ay, h.x, h.y) < 0.5) continue;   // standing on the line already
      if (manned(h.s.data.nation, h.x, h.y)) return { k, t: h.t, trench: h.s, holder: h.s.data.nation };
    }
  }
  return null;
}
/**
 * Cut a move short of a manned enemy trench: { x, y, path (with the factors kept), note } just under 1 km before the
 * crossing, or null when nothing blocks it.
 */
function haltAtTrench(lobby, g, marker, path) {
  const tb = trenchBlock(lobby, g, marker, path);
  if (!tb) return null;
  const [ax, ay] = path[tb.k - 1], [bx, by] = path[tb.k], L = geo.distance(lobby, ax, ay, bx, by);
  const t = Math.max(0, tb.t - (L > 0 ? 1 / L : 0));
  const x = round(ax + (bx - ax) * t), y = round(ay + (by - ay) * t);
  const name = tb.trench.label ? ` (${tb.trench.label})` : '';
  return {
    x, y, path: [...path.slice(0, tb.k), path[tb.k].length > 2 ? [x, y, path[tb.k][2]] : [x, y]],
    note: `${marker.name} was halted at ${tb.holder}'s manned trench${name}: beat its defenders or go round`,
    stuck: `${marker.name} cannot cross ${tb.holder}'s manned trench${name}: beat its defenders, or go round`,
  };
}

/** Turns the dead of a fight lie on the field: the turn of the fight and the two after it. */
const REMAINS_TURNS = 3;

function checkMove(lobby, g, isGm, marker, x, y) {
  // Ships stay at sea (or in harbour) for players in any mode; the GM can still place them anywhere.
  if (!isGm && marker.type === 'unit' && UnitTypes.resolve(marker.data?.unitType)?.cat === 'Naval') {
    const err = require('./territory').shipCourseError(lobby, marker.x, marker.y, x, y);
    if (err) return { error: `${marker.name}: ${err}`, fatal: true };
  }
  // Land units keep off the water for players in any mode (seas and lakes need a convoy); the GM can place them
  // anywhere. The end must be on land; walking, the way there must not cross open water (by rail, the track decides).
  const territory = require('./territory');
  const landUnit = !isGm && territory.isLandUnit(marker);
  const wet = direct => (landUnit ? territory.landCourseError(lobby, marker.x, marker.y, x, y, direct) : null);
  let err = wet(false);
  if (err) return { error: `${marker.name}: ${err}`, fatal: true };
  if (['unit', 'hero'].includes(marker.type) && (err = phaseError(g, isGm, 'move', marker.name))) return { error: err };
  if (!g.enabled || isGm || g.settings.waiveMovement || !['unit', 'hero'].includes(marker.type)) {
    if ((err = wet(true))) return { error: `${marker.name}: ${err}`, fatal: true };
    const halt = g.enabled && !isGm ? haltAtTrench(lobby, g, marker, [[marker.x, marker.y], [x, y]]) : null;
    if (halt && geo.distance(lobby, marker.x, marker.y, halt.x, halt.y) < 0.5) return { error: halt.stuck, fatal: true };
    return halt ? { x: halt.x, y: halt.y, clamped: false, blocked: halt.note } : { x, y, clamped: false };
  }
  if (marker.data?.attacked) return { error: `${marker.name} attacked this turn and cannot move until next turn` };
  if (marker.type === 'unit' && require('./supply').exhausted(marker) && g.settings.supplyEnabled !== false) return { error: `${marker.name} is out of supply (it has used up the supplies it carries) and cannot move until a Supply Column reaches it` };
  const dist = geo.distance(lobby, marker.x, marker.y, x, y);
  if (dist < 1e-6) return { x, y, clamped: false };
  const bonus = research.statBonus(factionEffects(lobby.id, marker.data?.nation), UnitTypes.resolve(marker.data?.unitType)).movement;
  const allowance = (num(marker.data.movement) + bonus) * num(g.settings.kmPerMove);
  const used = num(marker.data.movedKm);
  const remaining = Math.max(0, allowance - used);
  const unit = geo.isEarth(lobby) ? 'km' : (lobby.scale_label || 'units');
  if (remaining <= 0.01) return { error: `${marker.name} has no movement left this turn (${round(allowance)} ${unit} per turn)` };
  let route = require('./rails').plan(lobby, g.settings, marker, x, y);
  if (!route && (err = wet(true))) return { error: `${marker.name}: ${err}`, fatal: true };
  // A manned enemy trench across the way: the move ends just short of it.
  const halt = haltAtTrench(lobby, g, marker, route ? route.path : [[marker.x, marker.y], [x, y]]);
  let blocked;
  if (halt) {
    if (geo.distance(lobby, marker.x, marker.y, halt.x, halt.y) < 0.5) return { error: halt.stuck, fatal: true };
    x = halt.x; y = halt.y; blocked = halt.note;
    if (route) route = { ...route, path: halt.path, cost: halt.path.slice(1).reduce((c, p, i) => c + geo.distance(lobby, halt.path[i][0], halt.path[i][1], p[0], p[1]) * (p[2] ?? 1), 0) };
  }
  // Walking: No Man's Land costs several times its distance.
  const walk = route ? null : walkCost(lobby, g.settings, marker.x, marker.y, x, y);
  const cost = route ? route.cost : walk.cost, slowed = !!walk?.slowed;
  if (cost <= remaining + 1e-6) return { x, y, clamped: false, movedKm: round(used + cost), cost, route, slowed, blocked, path: route ? route.path.map(p => [p[0], p[1]]) : null };
  if (route) {
    const w = require('./rails').walk(lobby, route.path, remaining);
    return { x: round(w.x), y: round(w.y), clamped: true, movedKm: round(allowance), remaining, dist: round(cost), cost, route, path: w.points, to: halt ? [x, y] : null };   // ran out before the trench
  }
  const t = walk.frac(remaining), cx = round(marker.x + (x - marker.x) * t), cy = round(marker.y + (y - marker.y) * t);
  // Run out of movement part-way: not in the middle of a strait.
  if (landUnit && territory.landCourseError(lobby, cx, cy, cx, cy, false)) return { error: `${marker.name} would stop in the water short of the far shore: move it to the near side first` };
  return { x: cx, y: cy, clamped: true, movedKm: round(allowance), remaining, dist: round(cost), cost, slowed, to: halt ? [x, y] : null };
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
  const pe = phaseError(g, isGm, 'attack');
  if (pe) return pe;
  if (require('./supply').exhausted(marker) && g.settings.supplyEnabled !== false && UnitTypes.resolve(marker.data?.unitType)?.cat !== 'Emplacements') return `${marker.name} is out of supply (it has used up the supplies it carries) and cannot attack`;
  const ap = num(marker.data.ap);
  if (ap <= 0) return `${marker.name} has no action points and cannot attack`;
  if (num(marker.data.apUsed) >= ap) return `${marker.name} has used its action points this turn`;
  return null;
}

/** Fields a player may not change on their own unit while the game is running. */
const PROTECTED_UNIT_FIELDS = ['attack', 'defend', 'ap', 'range', 'movement', 'strength', 'unitType', 'nation', 'movedKm', 'apUsed', 'trail', 'supplied', 'supplyFrom', 'supplies', 'unsuppliedTurns', 'surrendered', 'aboard', 'ride', 'heldTurns', 'attacked',
  'dig', 'submerged', 'replenishedTurn', 'corps', 'facing'];   // set by orders (routes/orders.js), not by editing

module.exports = {
  REMAINS_TURNS,
  get, save, serializeGame, ensureState, serializeState, writeState, factionStates, incomeFor, endTurn, undoTurn, reports,
  checkMove, trenchBlock, checkAttack, checkRange, attackRange, phaseError, wornPenalty, PHASE_LABEL, PROTECTED_UNIT_FIELDS, emptyResources, q, applySupply, applyAttrition,
  relationStatus, setRelation, relations, diplomacy, serializeDiplomacy, factionEffects,
  TRADE_KEYS, trades, serializeTrade, exchange, shortOf, goodsText, goodName, cancelTradesBetween, transaction,
};
