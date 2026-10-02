'use strict';
/**
 * Research (docs/GAME-DESIGN.md §7): a per-campaign tech tree (seeded from defaults/techtree-ww1.json),
 * per-faction unlocked techs, one active project fed by the faction's research points each turn, and the
 * effects engine that turns unlocked techs into bonuses. Effects are recomputed from the unlocked set every
 * time they are needed, never stored, so locking a tech again cleanly removes its bonuses.
 *
 * Effect shapes (a tech's `effects` array):
 *   { type: 'unlockUnit', unit }                          type becomes buildable (types no tech unlocks are always buildable)
 *   { type: 'stat', unit?|cat?, attack?, defend?, movement?, range?, ap? }   added to units of that type / category
 *   { type: 'cost', unit?|cat?|all, resource?, factor }  production cost multiplier (resource: one key, else all)
 *   { type: 'buildTime', cat?|unit?, delta }             build turns change (never below 1)
 *   { type: 'income', key: money|rp|manpower|<resource>, add?, factor? }
 *   { type: 'removeCost', resource }                     that resource no longer costs anything
 *   { type: 'cover', add }                               trench cover bonus
 *   { type: 'capacity', add }                            extra parallel builds per site
 *   { type: 'recover', add }                             strength regained per turn by damaged units
 *   { type: 'vision', unit?|cat?|all?, km }              fog of war: units of that type / category (or all) see further
 *   { type: 'flag', name }                               free-form marker for future rules
 */
const fs = require('node:fs');
const path = require('node:path');
const { db, now } = require('./db');
const access = require('./lobbyAccess');
const UnitTypes = require('../public/js/units');
const GameData = require('../public/js/game-data');

const q = {
  all: db.prepare('SELECT * FROM techs WHERE lobby_id = ? ORDER BY sort, year, id'),
  one: db.prepare('SELECT * FROM techs WHERE lobby_id = ? AND key = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM techs WHERE lobby_id = ?'),
  upsert: db.prepare(`INSERT INTO techs (lobby_id, key, branch, name, year, rp, money, prereqs, effects, description, sort, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lobby_id, key) DO UPDATE SET branch = excluded.branch, name = excluded.name, year = excluded.year, rp = excluded.rp,
      money = excluded.money, prereqs = excluded.prereqs, effects = excluded.effects, description = excluded.description, sort = excluded.sort, updated_at = excluded.updated_at`),
  remove: db.prepare('DELETE FROM techs WHERE lobby_id = ? AND key = ?'),
  clear: db.prepare('DELETE FROM techs WHERE lobby_id = ?'),
  patched: db.prepare('SELECT 1 FROM tree_patches WHERE lobby_id = ? AND patch = ?'),
  markPatched: db.prepare('INSERT OR IGNORE INTO tree_patches (lobby_id, patch, applied_at) VALUES (?, ?, ?)'),
};
/**
 * Techs added to the bundled tree after campaigns already had one. Each patch is merged into an existing tree
 * once (techs the GM already has under the same key are left alone); a GM can still delete them afterwards.
 */
const PATCHES = [
  { id: 'fog-2026-10', keys: ['aerial_photography'] },
  { id: 'economy-2026-09', keys: ['econ_statistics', 'econ_municipal', 'econ_machine_tools', 'econ_savings', 'econ_scientific_management', 'econ_electrification', 'econ_reconstruction'] },
];
const num = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; };

function serialize(row) {
  return { key: row.key, branch: row.branch, name: row.name, year: row.year, rp: row.rp, money: row.money,
    prereqs: access.safeJson(row.prereqs || '[]') || [], effects: access.safeJson(row.effects || '[]') || [], desc: row.description || '', sort: row.sort };
}
function list(lobbyId) { return q.all.all(lobbyId).map(serialize); }
function get(lobbyId, key) { const r = q.one.get(lobbyId, key); return r ? serialize(r) : null; }
function count(lobbyId) { return q.count.get(lobbyId).n; }

/** Validate and store a tech (GM editor and seeding). Returns the stored tech. */
function upsert(lobbyId, t, sort) {
  const key = String(t.key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40);
  if (!key) throw new Error('Tech needs a key');
  const name = String(t.name || '').trim().slice(0, 80);
  if (!name) throw new Error('Tech needs a name');
  const prereqs = (Array.isArray(t.prereqs) ? t.prereqs : []).map(p => String(p).toLowerCase()).filter(p => p && p !== key).slice(0, 8);
  const effects = (Array.isArray(t.effects) ? t.effects : []).filter(e => e && typeof e === 'object' && typeof e.type === 'string').slice(0, 12);
  q.upsert.run(lobbyId, key, String(t.branch || 'General').slice(0, 40), name, Math.round(num(t.year, 1914)), Math.max(0, num(t.rp, 10)),
    Math.max(0, num(t.money, 0)), JSON.stringify(prereqs), JSON.stringify(effects), String(t.desc || '').slice(0, 400), num(sort ?? t.sort, 0), now());
  return get(lobbyId, key);
}
function remove(lobbyId, key) { q.remove.run(lobbyId, key); }

/** Load the bundled default tree into a campaign. `replace` wipes the current tree first. */
function seedDefault(lobbyId, replace = false) {
  const file = path.join(__dirname, '..', 'defaults', 'techtree-ww1.json');
  const techs = JSON.parse(fs.readFileSync(file, 'utf8')).techs;
  if (replace) q.clear.run(lobbyId);
  let n = 0;
  techs.forEach((t, i) => { if (replace || !q.one.get(lobbyId, t.key)) { upsert(lobbyId, t, i); n++; } });
  for (const p of PATCHES) q.markPatched.run(lobbyId, p.id, now());   // a fresh copy already has every addition
  return n;
}
/** Make sure a campaign has a tree (first enable), and merge any bundled additions it has not had yet. */
function ensureTree(lobbyId) {
  if (count(lobbyId) === 0) { seedDefault(lobbyId, false); return; }
  const pending = PATCHES.filter(p => !q.patched.get(lobbyId, p.id));
  if (!pending.length) return;
  const file = path.join(__dirname, '..', 'defaults', 'techtree-ww1.json');
  const techs = JSON.parse(fs.readFileSync(file, 'utf8')).techs;
  for (const p of pending) {
    for (const key of p.keys) {
      const i = techs.findIndex(t => t.key === key);
      if (i >= 0 && !q.one.get(lobbyId, key)) upsert(lobbyId, techs[i], i);
    }
    q.markPatched.run(lobbyId, p.id, now());
  }
}

const yearOf = iso => Number(String(iso || '').slice(0, 4)) || 1914;
/** Keys every faction starts with: techs dated on or before the campaign's start year. */
function startingKeys(techs, startYear) { return techs.filter(t => t.year <= startYear).map(t => t.key); }

// ---- Effects engine ---------------------------------------------------------------------------
const STAT_KEYS = ['attack', 'defend', 'movement', 'range', 'ap'];
function emptyEffects(techs) {
  const gated = new Set();
  for (const t of techs || []) for (const e of t.effects) if (e.type === 'unlockUnit' && e.unit) gated.add(e.unit);
  return { gated, unlocked: new Set(), statUnit: {}, statCat: {}, cost: [], buildTime: [], income: {}, removeCost: new Set(), cover: 0, capacity: 0, recover: 0, flags: new Set(), vision: [] };
}
/** Aggregate the effects of the unlocked techs. */
function effectsFor(techs, unlockedKeys) {
  const fx = emptyEffects(techs);
  const have = new Set(unlockedKeys || []);
  const addStat = (target, e) => { for (const k of STAT_KEYS) if (e[k]) target[k] = (target[k] || 0) + num(e[k]); };
  for (const t of techs) {
    if (!have.has(t.key)) continue;
    for (const e of t.effects) {
      switch (e.type) {
        case 'unlockUnit': if (e.unit) fx.unlocked.add(e.unit); break;
        case 'stat':
          if (e.unit) { fx.statUnit[e.unit] = fx.statUnit[e.unit] || {}; addStat(fx.statUnit[e.unit], e); }
          else if (e.cat) { fx.statCat[e.cat] = fx.statCat[e.cat] || {}; addStat(fx.statCat[e.cat], e); }
          break;
        case 'cost': fx.cost.push({ unit: e.unit, cat: e.cat, all: !!e.all || (!e.unit && !e.cat), resource: e.resource, factor: num(e.factor, 1) }); break;
        case 'buildTime': fx.buildTime.push({ unit: e.unit, cat: e.cat, delta: Math.round(num(e.delta)) }); break;
        case 'income': if (e.key) { const cur = fx.income[e.key] || { add: 0, factor: 1 }; cur.add += num(e.add); cur.factor *= num(e.factor, 1); fx.income[e.key] = cur; } break;
        case 'removeCost': if (e.resource) fx.removeCost.add(e.resource); break;
        case 'cover': fx.cover += num(e.add); break;
        case 'capacity': fx.capacity += Math.round(num(e.add)); break;
        case 'recover': fx.recover += num(e.add); break;
        case 'vision': fx.vision.push({ unit: e.unit, cat: e.cat, all: !!e.all || (!e.unit && !e.cat), km: num(e.km) }); break;
        case 'flag': if (e.name) fx.flags.add(e.name); break;
        default: break;
      }
    }
  }
  return fx;
}
/** Is a unit type buildable with these effects? Types no tech gates are always available. */
function canBuild(fx, typeId) { return !fx.gated.has(typeId) || fx.unlocked.has(typeId); }
/** Bonus stats for a unit (resolved catalogue type) from its faction's techs. */
function statBonus(fx, type) {
  const out = { attack: 0, defend: 0, movement: 0, range: 0, ap: 0 };
  if (!fx || !type) return out;
  for (const src of [fx.statCat[type.cat], fx.statUnit[type.id]]) if (src) for (const k of STAT_KEYS) out[k] += num(src[k]);
  return out;
}
/** Apply cost multipliers, removed resources and build-time changes to a cost row. */
function applyCost(fx, typeId, cat, cost) {
  const out = { ...cost };
  if (!fx) return out;
  for (const c of fx.cost) {
    const hit = c.all || (c.unit && c.unit === typeId) || (c.cat && c.cat === cat);
    if (!hit) continue;
    const keys = c.resource ? [c.resource] : [...GameData.RESOURCE_KEYS, 'money', 'manpower'];
    for (const k of keys) if (out[k] !== undefined) out[k] = Math.round(out[k] * c.factor * 10) / 10;
  }
  for (const r of fx.removeCost) if (out[r] !== undefined) out[r] = 0;
  for (const b of fx.buildTime) if ((b.unit && b.unit === typeId) || (b.cat && b.cat === cat)) out.turns = Math.max(1, out.turns + b.delta);
  return out;
}
/** Apply income effects to { resources, money, rp, manpower }. */
function applyIncome(fx, inc) {
  if (!fx) return inc;
  for (const [key, m] of Object.entries(fx.income)) {
    if (key in inc && typeof inc[key] === 'number') inc[key] = Math.round((inc[key] * m.factor + m.add) * 10) / 10;
    else if (inc.resources && key in inc.resources) inc.resources[key] = Math.round((inc.resources[key] * m.factor + m.add) * 10) / 10;
  }
  return inc;
}

// ---- A faction's research ----------------------------------------------------------------------
function researchState(state) {
  const r = state.research && typeof state.research === 'object' ? state.research : {};
  return { active: r.active || null, progress: r.progress && typeof r.progress === 'object' ? r.progress : {}, queue: Array.isArray(r.queue) ? r.queue : [] };
}
/** Why a faction cannot research a tech right now; null when it can. */
function blocker(tech, state, techs, g) {
  if (!tech) return 'No such tech';
  if ((state.techs || []).includes(tech.key)) return 'Already researched';
  const have = new Set(state.techs || []);
  const missing = tech.prereqs.filter(p => !have.has(p)).map(p => techs.find(t => t.key === p)?.name || p);
  if (missing.length) return `Needs ${missing.join(', ')}`;
  const lead = num(g.settings.researchLead, 1);
  if (tech.year > yearOf(g.date) + lead) return `Not before ${tech.year - lead}`;
  return null;
}
/** Start (or queue) a project. Money is paid when a project becomes active. */
function start(state, tech, techs, g) {
  const err = blocker(tech, state, techs, g);
  if (err) throw new Error(err);
  const r = researchState(state);
  if (r.active === tech.key || r.queue.includes(tech.key)) throw new Error('Already planned');
  if (!r.active) {
    if (state.money < tech.money) throw new Error(`Needs ${tech.money} money to start (you have ${state.money})`);
    state.money = Math.round((state.money - tech.money) * 10) / 10;
    r.active = tech.key;
  } else {
    if (r.queue.length >= 5) throw new Error('The research queue is full (5)');
    r.queue.push(tech.key);
  }
  state.research = r;
  return r;
}
/** Drop a project from the plan. Progress already made is kept for later; an active project's money is not refunded. */
function drop(state, key) {
  const r = researchState(state);
  if (r.active === key) r.active = null;
  r.queue = r.queue.filter(k => k !== key);
  state.research = r;
  return r;
}
/** Pull the next queued project into the active slot if it can be paid for. */
function promote(state, techs, g) {
  const r = researchState(state);
  while (!r.active && r.queue.length) {
    const key = r.queue.shift();
    const tech = techs.find(t => t.key === key);
    if (!tech || blocker(tech, state, techs, g) || state.money < tech.money) continue;
    state.money = Math.round((state.money - tech.money) * 10) / 10;
    r.active = key;
  }
  state.research = r;
}
/** End of turn: the faction's research points flow into the active project. Returns completed techs. */
function advance(state, techs, g) {
  const done = [];
  promote(state, techs, g);
  let r = researchState(state);
  let guard = 0;
  while (r.active && guard++ < 6) {
    const tech = techs.find(t => t.key === r.active);
    if (!tech) { r.active = null; break; }
    const have = num(r.progress[tech.key]);
    const need = Math.max(0, tech.rp - have);
    const spend = Math.min(need, Math.max(0, state.rp));
    r.progress[tech.key] = have + spend;
    state.rp = Math.round((state.rp - spend) * 10) / 10;
    if (r.progress[tech.key] + 1e-9 >= tech.rp) {
      delete r.progress[tech.key];
      r.active = null;
      state.techs = [...new Set([...(state.techs || []), tech.key])];
      done.push(tech);
      state.research = r;
      promote(state, techs, g);
      r = researchState(state);
    } else break;
  }
  state.research = r;
  return done;
}
function setUnlocked(state, key, on) {
  const set = new Set(state.techs || []);
  if (on) set.add(key); else set.delete(key);
  state.techs = [...set];
  const r = researchState(state);
  if (on) { if (r.active === key) r.active = null; r.queue = r.queue.filter(k => k !== key); delete r.progress[key]; state.research = r; }
}

module.exports = { list, get, count, upsert, remove, seedDefault, ensureTree, startingKeys, yearOf, effectsFor, emptyEffects, canBuild, statBonus, applyCost, applyIncome,
  researchState, blocker, start, drop, promote, advance, setUnlocked, STAT_KEYS };
