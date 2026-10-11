'use strict';
/**
 * Goods and unrest (docs/ECONOMY.md, Goods and unrest).
 *
 *   - Towns make goods: GameData.townOutput a turn (size, industry, development), split by the nation's war economy
 *     (state.policy.warEconomy %): that share is military goods, the rest consumer goods. Factories make factoryOutput
 *     goods a turn per industry level, split by the same policy and delivered to the nearest town of their nation.
 *   - Towns store them (data.goods = { consumer, military }), at most goodsStoreTurns turns of their output of each.
 *   - Networks: a nation's towns within goodsLinkKm of one another share their stores, unless the way between them crosses
 *     ground held by a nation at war with theirs; towns further apart share them only by railway (open track their side
 *     may use, within 25 km of each town). Stores are levelled across a network at End turn in proportion to what each
 *     town makes, so a captured town takes its share with it.
 *   - Consumer goods: each town consumes consumerNeed × its output a turn. Met, its unrest falls by unrestFall; short, it
 *     rises by up to unrestRise (scaled by the shortfall). At unrestCritical it has unrestGrace End turns to come back
 *     below, or it rises in revolt (routes/economy.js).
 *   - Military goods feed supply (server/supply.js): a land unit supplied from a town draws unitDraw a turn from the
 *     town's network, one supplied by a Supply Column or a convoy from that one's pool (columnPool, convoyPool; the
 *     column draws for itself too). At End turn columns refill from the network of the town they are linked to (through
 *     other columns, a railhead or a convoy), convoys from a town of their nation within convoyLoadKm.
 * Writes go straight to the markers (End turn broadcasts a reload); everything here is in map units of the lobby.
 */
const access = require('./lobbyAccess');
const geo = require('./geo');
const { db, now } = require('./db');
const GameData = require('../public/js/game-data');
const UnitTypes = require('../public/js/units');

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const norm = s => String(s || '').trim().toLowerCase();
const round = n => Math.round(n * 10) / 10;
const typeId = m => UnitTypes.resolve(m?.data?.unitType)?.id || '';
const alive = m => num(m.data?.strength, 100) > 0;

const q = {
  markers: db.prepare('SELECT * FROM markers WHERE lobby_id = ?'),
  setGoods: db.prepare(`UPDATE markers SET data = json_set(data, '$.goods', json(?)), updated_at = ? WHERE id = ?`),
  setUnrest: db.prepare(`UPDATE markers SET data = json_set(data, '$.unrest', ?, '$.unrestTurns', ?), updated_at = ? WHERE id = ?`),
  setPool: db.prepare(`UPDATE markers SET data = json_set(data, '$.pool', ?), updated_at = ? WHERE id = ?`),
};

const on = s => !!s && s.goodsEnabled !== false;
const markersOf = lobby => q.markers.all(lobby.id).map(access.serializeMarker);
/** A town's store of a good (a town not yet counted starts with goodsStartTurns turns of half its output). */
function stockOf(town, key, s) {
  const v = town.data?.goods?.[key];
  return v === undefined || v === null ? round(num(s.goodsStartTurns, 4) * GameData.townOutput(town, s) * 0.5) : num(v);
}
const capOf = (town, s) => num(s.goodsStoreTurns, 12) * Math.max(1, GameData.townOutput(town, s));
/** A column's or convoy's pool (full when not yet counted). */
function poolOf(m, s) {
  const max = GameData.poolMax(typeId(m), s);
  if (max === null) return 0;
  const v = m.data?.pool;
  return v === undefined || v === null ? max : Math.max(0, num(v));
}

/** (factionId, factionId) → at war, cached. */
function warResolver(lobby) {
  const game = require('./game'), cache = new Map();
  return (a, b) => {
    if (!a || !b || a === b) return false;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!cache.has(k)) cache.set(k, game.relationStatus(lobby.id, a, b) === 'war');
    return cache.get(k);
  };
}

/**
 * The goods networks: { netOf: Map(townId → key), nets: Map(key → { key, nation, towns: [town] }) } for every town held
 * by a faction. Union-find over towns: rail components first, then towns within goodsLinkKm whose straight way does not
 * cross enemy-held ground.
 */
function networks(lobby, s, markers) {
  const game = require('./game'), territory = require('./territory');
  const factions = game.q.factions.all(lobby.id);
  const idOf = new Map(factions.map(f => [norm(f.name), f.id]));
  const towns = markers.filter(m => m.type === 'town' && idOf.has(norm(m.data?.nation)));
  const parent = new Map(towns.map(t => [t.id, t.id]));
  const find = a => { let r = a; while (parent.get(r) !== r) r = parent.get(r); while (parent.get(a) !== r) { const n = parent.get(a); parent.set(a, r); a = n; } return r; };
  const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(x, y); };
  const atWar = warResolver(lobby);
  let net = null, owners = null;
  try {
    const rails = require('./rails');
    net = rails.network(lobby, s);
    if (net.edges.length) owners = rails.edgeOwners(lobby, net); else net = null;
  } catch { net = null; }
  let lookup;
  const enemyGround = (fid, x, y) => {
    if (lookup === undefined) lookup = territory.ownerLookup(lobby);
    if (!lookup) return false;
    const o = lookup(x, y);
    return !!o && o !== territory.NEUTRAL && o !== fid && atWar(fid, o);
  };
  const linkKm = num(s.goodsLinkKm, 500);
  const byNation = new Map();
  for (const t of towns) { const n = norm(t.data.nation); if (!byNation.has(n)) byNation.set(n, []); byNation.get(n).push(t); }
  for (const [n, list] of byNation) {
    const fid = idOf.get(n);
    // Railways: towns on one open stretch of track their side may use share their stores, however far apart.
    if (net) {
      const friends = new Set([fid]);
      for (const f of factions) if (f.id !== fid && game.relationStatus(lobby.id, fid, f.id) === 'alliance') friends.add(f.id);
      const open = net.edges.map((e, i) => !e.cut && (!owners || owners[i] === null || friends.has(owners[i])));
      const comp = new Int32Array(net.nodes.length).fill(-1);
      let c = 0;
      for (let i = 0; i < net.nodes.length; i++) {
        if (comp[i] >= 0) continue;
        const stack = [i]; comp[i] = c;
        while (stack.length) {
          const a = stack.pop();
          for (const ei of net.adj[a]) {
            if (!open[ei]) continue;
            const e = net.edges[ei], b = e.a === a ? e.b : e.a;
            if (comp[b] < 0) { comp[b] = c; stack.push(b); }
          }
        }
        c++;
      }
      const rep = new Map();
      const nodeIdx = geo.index(lobby, net.nodes.map((p, i) => ({ x: p.x, y: p.y, comp: comp[i] })));
      for (const t of list) nodeIdx.near(t.x, t.y, 25, nd => { if (rep.has(nd.comp)) union(t.id, rep.get(nd.comp)); else rep.set(nd.comp, t.id); });
    }
    // Nearby towns, by road and river: not across ground held by an enemy.
    const idx = geo.index(lobby, list);
    for (const t of list) {
      idx.near(t.x, t.y, linkKm, (o, d) => {
        if (o.id === t.id || find(o.id) === find(t.id)) return;
        const steps = Math.max(1, Math.ceil(d / 25));
        for (let i = 1; i < steps; i++) if (enemyGround(fid, t.x + (o.x - t.x) * i / steps, t.y + (o.y - t.y) * i / steps)) return;
        union(t.id, o.id);
      });
    }
  }
  const netOf = new Map(), nets = new Map();
  for (const t of towns) {
    const k = find(t.id);
    netOf.set(t.id, k);
    if (!nets.has(k)) nets.set(k, { key: k, nation: t.data.nation, towns: [] });
    nets.get(k).towns.push(t);
  }
  return { netOf, nets };
}

/** Spread a network's total of a good over its towns in proportion to their output (each to its store's size). */
function level(net, key, total, s) {
  const w = net.towns.map(t => Math.max(1, GameData.townOutput(t, s))), W = w.reduce((a, b) => a + b, 0);
  const cap = net.towns.reduce((a, t) => a + capOf(t, s), 0);
  const amount = Math.max(0, Math.min(total, cap));
  net.towns.forEach((t, i) => {
    const v = round(amount * w[i] / W);
    if (num(t.data?.goods?.[key], -1) === v) return;
    t.data.goods = { ...(t.data.goods || {}), [key]: v };
    for (const k of GameData.GOODS_KEYS) if (t.data.goods[k] === undefined) t.data.goods[k] = stockOf(t, k, s);
    q.setGoods.run(JSON.stringify(t.data.goods), now(), t.id);
  });
}
const netTotal = (net, key, s) => round(net.towns.reduce((a, t) => a + stockOf(t, key, s), 0));

/**
 * End turn, after income: towns make goods, consume consumer goods, and their unrest moves. Returns
 * { rebels: [townId], byNation: Map(nation → { made: { consumer, military }, need, covered, critical: [...], revolt: [...] }) }.
 * `states` maps a nation's name (lower case) to its faction state (for the war economy).
 */
function endTurn(lobby, g, states) {
  const s = g.settings, out = { rebels: [], byNation: new Map() };
  if (!on(s)) return out;
  const markers = markersOf(lobby);
  const { netOf, nets } = networks(lobby, s, markers);
  const crit = num(s.unrestCritical, 75), grace = Math.max(1, Math.round(num(s.unrestGrace, 3)));
  const report = n => { const k = norm(n); if (!out.byNation.has(k)) out.byNation.set(k, { made: { consumer: 0, military: 0 }, need: 0, covered: 1, critical: [], revolt: [], short: [] }); return out.byNation.get(k); };
  // Factories deliver to the nearest town of their nation.
  const factoryGoods = new Map();   // net key → { consumer, military }
  const townsBy = new Map();
  for (const n of nets.values()) for (const t of n.towns) { const k = norm(t.data.nation); if (!townsBy.has(k)) townsBy.set(k, []); townsBy.get(k).push(t); }
  for (const f of markers.filter(m => m.type === 'factory' && m.data?.nation)) {
    if (s.capturedIdle && num(f.data?.capturedTurn, -1) === g.turn) continue;
    const list = townsBy.get(norm(f.data.nation));
    if (!list) continue;
    let best = null, bd = Infinity;
    for (const t of list) { const d = Math.hypot(t.x - f.x, t.y - f.y); if (d < bd) { bd = d; best = t; } }
    const k = netOf.get(best.id), share = GameData.warEconomyOf(states.get(norm(f.data.nation)), s) / 100;
    const output = GameData.factoryOutput({ ...f, data: { ...f.data, industry: num(f.data.industry, 1) + require('./heroes').effects(lobby, s, markers, f).factory } }, s), mg = output * share, cg = output * (1 - share);
    const made = factoryGoods.get(k) || { consumer: 0, military: 0 };
    made.consumer += cg; made.military += mg;
    factoryGoods.set(k, made);
    report(f.data.nation).made.consumer += cg;
    report(f.data.nation).made.military += mg;
  }
  for (const n of nets.values()) {
    const share = GameData.warEconomyOf(states.get(norm(n.nation)), s) / 100;
    let cg = netTotal(n, 'consumer', s) + (factoryGoods.get(n.key)?.consumer || 0);
    let mg = netTotal(n, 'military', s) + (factoryGoods.get(n.key)?.military || 0), need = 0;
    const r = report(n.nation);
    for (const t of n.towns) {
      const o = GameData.townOutput(t, s);
      need += num(s.consumerNeed, 0.5) * o;
      if (s.capturedIdle && num(t.data?.capturedTurn, -1) === g.turn) continue;   // still being secured
      cg += o * (1 - share); mg += o * share;
      r.made.consumer += o * (1 - share); r.made.military += o * share;
    }
    const covered = need > 0 ? Math.min(1, cg / need) : 1;
    cg = Math.max(0, cg - need);
    r.need += need;
    if (covered < 0.999) r.short.push({ towns: n.towns.length, covered });
    for (const t of n.towns) {
      const u = num(t.data?.unrest), turns = num(t.data?.unrestTurns);
      const u2 = covered >= 0.999 ? Math.max(0, u - num(s.unrestFall, 10)) : Math.min(100, u + Math.max(2, Math.round(num(s.unrestRise, 25) * (1 - covered))));
      let t2 = 0;
      if (u2 >= crit) {
        t2 = u >= crit && turns > 0 ? turns - 1 : grace;
        if (t2 <= 0) {
          if (s.rebellions !== false) { out.rebels.push(t.id); r.revolt.push(t.name); }
          t2 = 0;
        } else r.critical.push({ name: t.name, turns: t2 });
      }
      if (u2 !== u || t2 !== turns) { q.setUnrest.run(u2, t2, now(), t.id); t.data.unrest = u2; t.data.unrestTurns = t2; }
    }
    level(n, 'consumer', cg, s);
    level(n, 'military', mg, s);
  }
  for (const r of out.byNation.values()) { r.made.consumer = round(r.made.consumer); r.made.military = round(r.made.military); r.need = round(r.need); }
  return out;
}

/**
 * End turn: every supplied land unit draws unitDraw supplies from its source (supply.compute's `result`): its town's
 * network, the Supply Column or convoy supplying it; a column draws for itself from its own pool. Returns the Set of
 * units whose source had run dry (they live on what they carry this turn, like units cut off).
 */
function draw(lobby, s, result) {
  const unfed = new Set();
  if (!on(s)) return unfed;
  const markers = markersOf(lobby), byId = new Map(markers.map(m => [m.id, m]));
  const { netOf, nets } = networks(lobby, s, markers);
  const totals = new Map([...nets.values()].map(n => [n.key, netTotal(n, 'military', s)])), touched = new Set();
  const pools = new Map();
  const pool = m => { if (!pools.has(m.id)) pools.set(m.id, poolOf(m, s)); return pools.get(m.id); };
  const per = num(s.unitDraw, 1);
  const supply = require('./supply');
  for (const m of markers.filter(x => x.type === 'unit' && alive(x) && supply.needsSupply(x)).sort((a, b) => a.id - b.id)) {
    const r = result.get(m.id);
    if (!r || !r.supplied || r.via === 'emplacement') continue;
    let take = null;
    if (typeId(m) === 'supply') take = { pool: m };
    else if (r.via === 'town' && r.from?.id != null && netOf.has(r.from.id)) take = { net: netOf.get(r.from.id) };
    else if ((r.via === 'column' || r.via === 'convoy' || r.via === 'fort') && byId.has(r.from?.id)) take = { pool: byId.get(r.from.id) };
    if (!take) continue;
    if (take.pool) {
      const left = pool(take.pool);
      if (left + 1e-9 >= per) pools.set(take.pool.id, round(left - per)); else unfed.add(m.id);
    } else {
      const left = totals.get(take.net) || 0;
      if (left + 1e-9 >= per) { totals.set(take.net, round(left - per)); touched.add(take.net); } else unfed.add(m.id);
    }
  }
  for (const [id, v] of pools) if (num(byId.get(id).data?.pool, -1) !== v) q.setPool.run(v, now(), id);
  for (const k of touched) level(nets.get(k), 'military', totals.get(k), s);
  return unfed;
}

/**
 * End turn, after the draws: Supply Columns linked to a town (directly, through other columns, a railhead or a convoy)
 * fill up from it (its network's military goods, or the convoy's pool); convoys from a town of their nation within
 * convoyLoadKm. Returns { [nation]: [text] } for columns that could not fill.
 */
function refill(lobby, s, result) {
  const notes = new Map();
  if (!on(s)) return notes;
  const note = (n, t) => { const k = norm(n); if (!notes.has(k)) notes.set(k, []); notes.get(k).push(t); };
  const markers = markersOf(lobby), byId = new Map(markers.map(m => [m.id, m]));
  const { netOf, nets } = networks(lobby, s, markers);
  const totals = new Map([...nets.values()].map(n => [n.key, netTotal(n, 'military', s)])), touched = new Set();
  const pools = new Map();
  const pool = m => (pools.has(m.id) ? pools.get(m.id) : poolOf(m, s));
  const takeFromNet = (k, want) => { const have = totals.get(k) || 0, got = Math.min(have, want); if (got > 0) { totals.set(k, round(have - got)); touched.add(k); } return got; };
  for (const c of markers.filter(m => m.type === 'unit' && typeId(m) === 'supply' && alive(m) && !m.data?.aboard)) {
    const free = GameData.poolMax('supply', s) - pool(c), root = result.get(c.id)?.root;
    if (free <= 0) continue;
    if (!root) continue;
    let got = 0;
    if (root.kind === 'town' && netOf.has(root.id)) got = takeFromNet(netOf.get(root.id), free);
    else if ((root.kind === 'convoy' || root.kind === 'fort') && byId.has(root.id)) { const cv = byId.get(root.id), have = pool(cv); got = Math.min(have, free); pools.set(cv.id, round(have - got)); }
    if (got > 0) pools.set(c.id, round(pool(c) + got));
    if (got < free - 1e-9) note(c.data?.nation, `${c.name} could fill only ${Math.round(got)} of ${Math.round(free)} (its depot is ${got > 0 ? 'running low' : 'empty'})`);
  }
  const townIdx = geo.index(lobby, markers.filter(m => m.type === 'town' && netOf.has(m.id)));
  for (const cv of markers.filter(m => m.type === 'unit' && typeId(m) === 'transport' && alive(m))) {
    const free = GameData.poolMax('transport', s) - pool(cv);
    if (free <= 0) continue;
    let port = null, bd = Infinity;
    townIdx.near(cv.x, cv.y, num(s.convoyLoadKm, 50), (t, d) => { if (norm(t.data.nation) === norm(cv.data?.nation) && d < bd) { bd = d; port = t; } });
    if (!port) continue;
    const got = takeFromNet(netOf.get(port.id), free);
    if (got > 0) pools.set(cv.id, round(pool(cv) + got));
  }
  // Forts restock from the nearest town of their nation within goodsLinkKm (its network's stores).
  for (const ft of markers.filter(m => m.type === 'unit' && typeId(m) === 'fortress' && alive(m) && m.data?.nation)) {
    const free = GameData.poolMax('fortress', s) - pool(ft);
    if (free <= 0) continue;
    let home = null, bd = Infinity;
    townIdx.near(ft.x, ft.y, num(s.goodsLinkKm, 500), (t, d) => { if (norm(t.data.nation) === norm(ft.data.nation) && d < bd) { bd = d; home = t; } });
    if (!home) { note(ft.data.nation, `${ft.name} is cut off from its towns and cannot restock`); continue; }
    const got = takeFromNet(netOf.get(home.id), free);
    if (got > 0) pools.set(ft.id, round(pool(ft) + got));
  }
  for (const [id, v] of pools) if (num(byId.get(id).data?.pool, -1) !== v) q.setPool.run(v, now(), id);
  for (const k of touched) level(nets.get(k), 'military', totals.get(k), s);
  return notes;
}

// ---- National totals, for trades and the treasury --------------------------------------------------------------
const townsOf = (markers, nation) => markers.filter(m => m.type === 'town' && norm(m.data?.nation) === norm(nation));
/** A nation's goods across all its towns: { consumer, military }. */
function totals(lobby, s, nation, markers) {
  const list = townsOf(markers || markersOf(lobby), nation), out = {};
  for (const k of GameData.GOODS_KEYS) out[k] = round(list.reduce((a, t) => a + stockOf(t, k, s), 0));
  return out;
}
/** Take `amount` of a good from a nation's towns (the fullest stores first). Returns what was taken. */
function take(lobby, s, nation, key, amount) {
  let left = amount;
  for (const t of townsOf(markersOf(lobby), nation).sort((a, b) => stockOf(b, key, s) - stockOf(a, key, s))) {
    if (left <= 1e-9) break;
    const have = stockOf(t, key, s), got = Math.min(have, left);
    if (got <= 0) continue;
    setStock(t, key, round(have - got), s);
    left -= got;
  }
  return round(amount - left);
}
/** Deliver goods to a nation: into its capital (or its biggest town); End turn spreads them over its network. */
function give(lobby, s, nation, key, amount) {
  const list = townsOf(markersOf(lobby), nation);
  if (!list.length) return 0;
  const t = list.find(x => x.data?.size === 'capital') || list.sort((a, b) => GameData.townOutput(b, s) - GameData.townOutput(a, s))[0];
  setStock(t, key, round(stockOf(t, key, s) + amount), s);
  return amount;
}
function setStock(t, key, v, s) {
  const goods = {};
  for (const k of GameData.GOODS_KEYS) goods[k] = k === key ? v : stockOf(t, k, s);
  t.data.goods = goods;
  q.setGoods.run(JSON.stringify(goods), now(), t.id);
}

/**
 * The Nation panel's goods: { enabled, warEconomy, stock, made, need, draw, towns, networks, unrest: { critical, high } }.
 * `draw` counts the land units of the nation supplied now (each draws unitDraw a turn); `N` (networks()) for the count of
 * separate networks its towns form.
 */
function summary(lobby, s, faction, state, markers, N) {
  if (!on(s)) return { enabled: false };
  const name = norm(faction.name), share = GameData.warEconomyOf(state, s) / 100;
  const towns = townsOf(markers, faction.name);
  const made = { consumer: 0, military: 0 };
  let need = 0;
  for (const t of towns) { const o = GameData.townOutput(t, s); made.consumer += o * (1 - share); made.military += o * share; need += num(s.consumerNeed, 0.5) * o; }
  for (const f of markers.filter(m => m.type === 'factory' && norm(m.data?.nation) === name)) {
    const output = GameData.factoryOutput({ ...f, data: { ...f.data, industry: num(f.data.industry, 1) + require('./heroes').effects(lobby, s, markers, f).factory } }, s);
    made.consumer += output * (1 - share);
    made.military += output * share;
  }
  const supply = require('./supply');
  const draw = markers.filter(m => m.type === 'unit' && norm(m.data?.nation) === name && alive(m) && supply.needsSupply(m) && m.data?.supplied === true && typeOf(m)?.cat !== 'Emplacements').length * num(s.unitDraw, 1);
  const crit = num(s.unrestCritical, 75);
  const unrest = towns.filter(t => num(t.data?.unrest) > 0).map(t => ({ id: t.id, name: t.name, unrest: num(t.data.unrest), turns: num(t.data?.unrestTurns), critical: num(t.data.unrest) >= crit }))
    .sort((a, b) => b.unrest - a.unrest);
  const nets = N ? new Set(towns.map(t => N.netOf.get(t.id))).size : null;   // separate networks (cut-off pockets, colonies)
  return {
    enabled: true, warEconomy: Math.round(share * 100), stock: totals(lobby, s, faction.name, markers),
    made: { consumer: round(made.consumer), military: round(made.military) }, need: round(need), draw: round(draw),
    towns: towns.length, nets, unrest: { critical: unrest.filter(u => u.critical).length, list: unrest.slice(0, 12) },
  };
}
const typeOf = m => UnitTypes.resolve(m?.data?.unitType);

module.exports = { on, stockOf, poolOf, capOf, networks, level, netTotal, endTurn, draw, refill, totals, take, give, setStock, summary };
