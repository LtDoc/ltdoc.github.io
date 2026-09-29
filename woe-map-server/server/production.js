'use strict';
/**
 * Production (docs/GAME-DESIGN.md §6.4): factions queue units at the cities and factories they own and pay
 * the cost up front; End turn advances every build and spawns finished units beside their site. Players can
 * also build factories near a city or town they own. Routes live in routes/game.js.
 */
const GameData = require('../public/js/game-data');
const UnitTypes = require('../public/js/units');
const geo = require('./geo');
const territory = require('./territory');
const research = require('./research');

const num = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; };
const sameNation = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** Production sites a faction owns: cities/capitals (capacity by size) and factories (capacity = level). */
function sites(lobby, g, faction, markers, fx) {
  const s = g.settings;
  const extra = fx ? fx.capacity : 0;
  const out = [];
  for (const m of markers) {
    if (!sameNation(m.data?.nation, faction.name)) continue;
    if (m.type === 'town') {
      const cap = num(s.cityCapacity?.[m.data?.size], 0);
      if (cap > 0) out.push({ id: m.id, name: m.name, kind: m.data.size, capacity: cap + extra, x: m.x, y: m.y, industry: num(m.data.industry, cap) });
    } else if (m.type === 'factory') {
      const lvl = Math.max(1, num(m.data?.industry, 1));
      out.push({ id: m.id, name: m.name, kind: 'factory', capacity: lvl + extra, x: m.x, y: m.y, industry: lvl });
    }
  }
  return out;
}

function affordable(state, cost) {
  const short = [];
  for (const k of GameData.RESOURCE_KEYS) if (num(state.resources[k]) < cost[k]) short.push(`${cost[k] - num(state.resources[k])} ${GameData.byKey[k].name.toLowerCase()}`);
  if (state.money < cost.money) short.push(`${cost.money - state.money} money`);
  if (state.manpower < cost.manpower) short.push(`${cost.manpower - state.manpower} manpower`);
  return short;
}
function pay(state, cost, sign = -1) {
  for (const k of GameData.RESOURCE_KEYS) state.resources[k] = Math.round((num(state.resources[k]) + sign * cost[k]) * 10) / 10;
  state.money = Math.round((state.money + sign * cost.money) * 10) / 10;
  state.manpower = Math.round((state.manpower + sign * cost.manpower) * 10) / 10;
}

/**
 * Validate and queue a build. Returns the new queue item or throws with a player-readable message.
 * item = { id, typeId, siteId, turnsLeft, turns, cost, x?, y? } — x/y only for factories.
 */
/** A type's cost for this faction: campaign table, then tech effects (multipliers, removed resources, build time). */
function costWith(g, fx, typeId) {
  const t = UnitTypes.LIST.find(u => u.id === typeId);
  return research.applyCost(fx, typeId, t ? t.cat : 'Buildings', GameData.costFor(typeId, g.settings.unitCosts));
}

function queue(lobby, g, faction, state, markers, { typeId, siteId, x, y }, fx) {
  const s = g.settings;
  const cost = costWith(g, fx, typeId);
  const queueOf = state.production || [];
  let item;
  if (typeId === 'factory') {
    if (!Number.isFinite(num(x, NaN)) || !Number.isFinite(num(y, NaN))) throw new Error('Pick a spot for the factory');
    const range = num(s.factoryRangeKm, 50);
    const anchor = markers.find(m => m.type === 'town' && ['city', 'capital', 'town'].includes(m.data?.size) && sameNation(m.data?.nation, faction.name) && geo.distance(lobby, x, y, m.x, m.y) <= range)
      || markers.find(m => m.type === 'town' && m.data?.size !== 'village' && sameNation(m.data?.nation, faction.name) && geo.distance(lobby, x, y, m.x, m.y) <= range);
    if (!anchor) throw new Error(`A factory must be within ${range} ${geo.isEarth(lobby) ? 'km' : lobby.scale_label || 'units'} of one of your cities or towns (not a village)`);
    if (geo.isEarth(lobby) && !territory.isLand(lobby, x, y)) throw new Error('Factories are built on land');
    const lookup = territory.ownerLookup(lobby);
    if (lookup) {
      const owner = lookup(x, y);
      if (owner !== null && owner !== territory.NEUTRAL && owner !== faction.id) throw new Error('That ground belongs to another faction');
    }
    item = { typeId, siteId: anchor.id, siteName: anchor.name, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  } else {
    const t = UnitTypes.LIST.find(u => u.id === typeId);
    if (!t) throw new Error('Unknown unit type');
    if (fx && !research.canBuild(fx, typeId)) throw new Error(`${t.unit} has not been researched yet`);
    const site = sites(lobby, g, faction, markers, fx).find(st => st.id === Number(siteId));
    if (!site) throw new Error('Pick one of your cities or factories');
    const inUse = queueOf.filter(q => q.siteId === site.id && q.typeId !== 'factory').length;
    if (inUse >= site.capacity) throw new Error(`${site.name} is already building ${inUse} unit${inUse === 1 ? '' : 's'} (capacity ${site.capacity})`);
    if (t.cat === 'Naval' && geo.isEarth(lobby) && !territory.isCoastal(lobby, site.x, site.y, num(s.coastalKm, 30))) throw new Error(`${site.name} is not on the coast: ships need a coastal city`);
    if (t.cat === 'Air' && site.industry < 2) throw new Error(`${site.name} needs industry level 2 to build aircraft`);
    item = { typeId, siteId: site.id, siteName: site.name };
  }
  const short = affordable(state, cost);
  if (short.length) throw new Error(`Cannot afford it: short of ${short.join(', ')}`);
  pay(state, cost, -1);
  item.id = Date.now() + Math.floor(Math.random() * 1000);
  item.turns = cost.turns; item.turnsLeft = cost.turns; item.cost = cost; item.queuedTurn = g.turn;
  state.production = [...queueOf, item];
  return item;
}

/** Remove a queued item and refund its cost. */
function cancel(state, itemId) {
  const q = state.production || [];
  const i = q.findIndex(x => x.id === Number(itemId));
  if (i < 0) throw new Error('No such build');
  const [item] = q.splice(i, 1);
  pay(state, item.cost, +1);
  state.production = q;
  return item;
}

/**
 * End of turn: every item loses a turn; finished ones are returned (and removed from the queue) so the caller
 * can create the unit or factory marker. Pure apart from mutating `state.production`.
 */
function advance(state) {
  const done = [], left = [];
  for (const item of state.production || []) {
    const next = { ...item, turnsLeft: item.turnsLeft - 1 };
    if (next.turnsLeft <= 0) done.push(next); else left.push(next);
  }
  state.production = left;
  return done;
}

/** Where a finished unit appears: a short hop from its site so stacks do not pile on the city marker. */
function spawnPoint(lobby, site, index) {
  const a = (index * 0.9) + 0.6, r = 14;
  return { x: Math.round((site.x + Math.cos(a) * r) * 10) / 10, y: Math.round((site.y + Math.sin(a) * r) * 10) / 10 };
}

module.exports = { sites, affordable, pay, queue, cancel, advance, spawnPoint, costWith };
