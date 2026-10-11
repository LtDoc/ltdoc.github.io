'use strict';
/**
 * Supply and support units (docs/UNITS.md).
 *
 * Supply per land unit is two things: whether it is linked to a source now (data.supplied, kept live), and the supplies it
 * carries (data.supplies, 0 to supplyStock, 3 by default). Linked, it is topped up at once; cut off, it uses one at each
 * End turn, and only once it has none left (exhausted) does it stop moving and attacking and suffer attrition.
 * A unit is linked when:
 *   - A Supply Column is linked when a friendly place (own or allied) is close enough for its size
 *     (supplyLinkBySize: capitals 600 km, cities 400 km, villages 200 km), or when it is within
 *     supplyLinkKm of open friendly railway connected to a friendly place or of another linked column.
 *   - A land unit is supplied when it is within supplyTownKm of a friendly town (garrison) or within
 *     supplyRangeKm of a linked column. A column itself is supplied when it is linked.
 *   - A convoy (transport ships) is a source anywhere: it supplies land units within convoyRangeKm and links
 *     columns within convoyLinkKm, so an invasion can be supplied far from home.
 *   - Ships, aircraft and heroes do not need supply.
 *   - Blockade: a coastal town with enemy warships (at war; not transports, not submerged submarines) within blockadeKm
 *     and none of its own side's supplies nothing and feeds no column until the blockade is lifted.
 * With goods on (settings.goodsEnabled, server/goods.js) supply is finite: a town supplies its garrison only while it holds
 * military goods, and a Supply Column or convoy supplies units (and a column itself) only while its pool lasts, linked or
 * not; the link decides where it refills at End turn (`root`: the town, or convoy, its chain of links starts from).
 * Support units (alive and supplied) help friendly units around them: HQ (attack and defend), engineers,
 * pioneers and sappers (defend), signals (artillery attack), field hospitals (heal at End turn).
 */
const geo = require('./geo');
const UnitTypes = require('../public/js/units');
const GameData = require('../public/js/game-data');
const heroes = require('./heroes');

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const norm = s => String(s || '').trim().toLowerCase();
const LAND = new Set(['Infantry', 'Mounted & mobile', 'Artillery', 'Support']);
const typeOf = m => UnitTypes.resolve(m.data?.unitType);
const typeId = m => typeOf(m)?.id || '';
const alive = m => num(m.data?.strength, 100) > 0;
/** Land units need supply (unknown custom types count as land, like the capture rule). */
function needsSupply(m) {
  if (m.type !== 'unit' || !alive(m) || m.data?.aboard) return false;   // wrecks and troops aboard a convoy need no supply
  const t = typeOf(m);
  return t ? LAND.has(t.cat) : true;   // (emplacements are not in LAND: they need none)
}
const ENGINEERS = new Set(['engineers', 'pioneers', 'sappers']);
/** Turns of supplies a land unit carries at most (rules: supplyStock). */
const stockMax = s => Math.max(0, Math.round(num((s || {}).supplyStock, 3)));
/** Out of supply: cut off with nothing left of what it carries (cannot move or attack, double losses, attrition). */
const exhausted = m => !!m && alive(m) && m.data?.supplied === false && num(m.data.supplies, 1) <= 0;
// A town's drawn built-up area (public/js/towns.js: KINDS R, up to 1.12 times, in map px). A unit standing in it is in
// the town however far that is in km: on the Earth map a capital is drawn up to ~55 km from its centre north to south.
const TOWN_PX = { capital: 11.2, city: 5.6, village: 1.7 };
const inTown = (m, t) => Math.hypot(m.x - t.x, m.y - t.y) <= (TOWN_PX[t.data?.size] ?? TOWN_PX.village);

/** (nation) → Set of friendly nation names (itself and its allies), cached per call. */
function friendsResolver(lobby, right = null) {
  const game = require('./game');
  const factions = game.q.factions.all(lobby.id);
  const cache = new Map();
  return nation => {
    const n = norm(nation);
    if (cache.has(n)) return cache.get(n);
    const me = factions.find(f => norm(f.name) === n);
    const set = new Set(n ? [n] : []);
    if (me) for (const f of factions) if (f.id !== me.id && (game.relationStatus(lobby.id, me.id, f.id) === 'alliance' || right && require('./treaties').permission(lobby.id, me.id, f.id, right))) set.add(norm(f.name));
    cache.set(n, set);
    return set;
  };
}

/**
 * Supply for every land unit: Map(markerId → { supplied, via, from }) where `via` says how ('town', 'column',
 * 'convoy', 'rail', 'linked', or '' when cut off) and `from` names the marker it comes from
 * ({ id, name, kind } — a place, a column, a convoy; or { kind: 'rail' } for a railhead).
 * Sources: friendly places (by size), open friendly railway connected to a place, and convoys at sea (transport
 * ships), which work anywhere so that an invasion can be supplied. Columns chain from any linked column.
 * Pure apart from reading relations and the rail network.
 */
function compute(lobby, settings, markers) {
  // Remove wrecks before building source indexes, resolving types or traversing supply links.
  markers = markers.filter(m => m.type !== 'unit' || alive(m));
  if (!markers.some(m => m.type === 'unit')) {
    const out = new Map(); out.blockaded = new Set(); return out;
  }
  const s = settings || {};
  const townKm = num(s.supplyTownKm, 30), linkKm = num(s.supplyLinkKm, 150), rangeKm = num(s.supplyRangeKm, 100);
  const convoyLinkKm = num(s.convoyLinkKm, 200), convoyRangeKm = num(s.convoyRangeKm, 100);
  const bySize = { capital: 600, city: 400, village: 200, ...(s.supplyLinkBySize || {}) };
  const feeds = t => num(bySize[t.data?.size] ?? bySize.village, 200);   // how far a place reaches a column
  const ref = (m, kind) => ({ id: m.id, name: m.name, kind });
  const townReach = Math.max(townKm, geo.distance(lobby, 0, 0, 0, TOWN_PX.capital) + 1);
  const friendsOf = friendsResolver(lobby, 'supply');
  const blockaded = blockades(lobby, s, markers, friendsResolver(lobby));
  const towns = markers.filter(m => m.type === 'town' && m.data?.nation && !blockaded.has(m.id));
  const logisticsCache = new Map();
  const logistics = m => { if (!logisticsCache.has(m.id)) logisticsCache.set(m.id, heroes.effects(lobby, s, markers, m).supply); return logisticsCache.get(m.id); };
  const columns = markers.filter(m => m.type === 'unit' && typeId(m) === 'supply' && alive(m));
  const convoys = markers.filter(m => m.type === 'unit' && typeId(m) === 'transport' && alive(m));
  // Forts are nodes like towns: they supply the units round them and feed columns, from their own stores (goods on).
  const forts = markers.filter(m => m.type === 'unit' && typeId(m) === 'fortress' && alive(m) && m.data?.nation);
  const fortKm = num(s.fortLinkKm, 200);
  const out = new Map();
  const byFriends = new Map();   // friends key → context
  // Lists are spatially indexed (geo.index), so each unit tests only what lies near it, not every place on the map.
  const maxFeed = Math.max(0, ...towns.map(feeds));
  const nearest = (m, idx, reach, km) => {
    let best = null, bd = Infinity;
    idx.near(m.x, m.y, reach, (o, d) => { if (o.id !== m.id && d <= km(o) && d < bd) { bd = d; best = o; } });
    return best;
  };
  const goods = s.goodsEnabled !== false;
  const pool = m => { const v = m.data?.pool, max = GameData.poolMax(typeId(m), s); return v === undefined || v === null ? max : num(v); };
  const stocked = t => !goods || num(t.data?.goods?.military, 1) > 0;   // a town not yet counted starts with stores
  // Railways: the network and the ground under each stretch of track are worked out once for every side.
  let net = null, owners = null, factionIds = null;
  try {
    const rails = require('./rails');
    net = rails.network(lobby, s);
    if (net.edges.length) {
      owners = rails.edgeOwners(lobby, net);
      factionIds = new Map(require('./game').q.factions.all(lobby.id).map(f => [norm(f.name), f.id]));
    } else net = null;
  } catch { net = null; }
  const ctxFor = nation => {
    const friends = friendsOf(nation);
    const key = [...friends].sort().join('|');
    if (byFriends.has(key)) return byFriends.get(key);
    const myTowns = towns.filter(t => friends.has(norm(t.data.nation)));
    const myConvoys = convoys.filter(c => friends.has(norm(c.data?.nation)));
    const myForts = forts.filter(c => friends.has(norm(c.data?.nation)));
    const fortIdx = geo.index(lobby, myForts), stockedFortIdx = goods ? geo.index(lobby, myForts.filter(f => pool(f) > 0)) : fortIdx;
    const townIdx = geo.index(lobby, myTowns), convoyIdx = geo.index(lobby, myConvoys);
    // Railways carry supply: open track this side may use (its own and allied ground, neutral ground, the sea),
    // reached from within 25 km of one of its towns.
    let railNodes = [];
    if (net && myTowns.length) {
      const ids = new Set([...friends].map(n => factionIds.get(n)).filter(v => v != null));
      const open = net.edges.map((e, i) => !e.cut && (!owners || owners[i] === null || ids.has(owners[i])));
      // Each node remembers the town its track is reached from (where a column fed by this railhead refills).
      const seen = new Uint8Array(net.nodes.length), seed = new Array(net.nodes.length).fill(null), stack = [];
      net.nodes.forEach((n, i) => { townIdx.near(n.x, n.y, 25, t => { if (!seen[i]) { seen[i] = 1; seed[i] = t.id; stack.push(i); } }); });
      while (stack.length) {
        const n = stack.pop();
        for (const ei of net.adj[n]) {
          if (!open[ei]) continue;
          const e = net.edges[ei], m = e.a === n ? e.b : e.a;
          if (!seen[m]) { seen[m] = 1; seed[m] = seed[n]; stack.push(m); }
        }
      }
      railNodes = [];
      net.nodes.forEach((n, i) => { if (seen[i]) railNodes.push({ x: n.x, y: n.y, seed: seed[i] }); });
    }
    const railIdx = geo.index(lobby, railNodes);
    // Columns link to a place, a railhead or a convoy, then chain outward from one another.
    const mine = columns.filter(c => friends.has(norm(c.data?.nation)));
    const mineIdx = geo.index(lobby, mine);
    const linked = new Map();   // column id → { via, from, root }
    const queue = [];
    for (const c of mine) {
      const boost = logistics(c);
      const t = nearest(c, townIdx, maxFeed * boost, t => feeds(t) * boost);
      if (t) { linked.set(c.id, { via: 'town', from: ref(t, 'place'), root: { kind: 'town', id: t.id } }); queue.push(c); continue; }
      const ft = nearest(c, fortIdx, fortKm * boost, () => fortKm * boost);
      if (ft) { linked.set(c.id, { via: 'fort', from: ref(ft, 'fort'), root: { kind: 'fort', id: ft.id } }); queue.push(c); continue; }
      const cv = nearest(c, convoyIdx, convoyLinkKm * boost, () => convoyLinkKm * boost);
      if (cv) { linked.set(c.id, { via: 'convoy', from: ref(cv, 'convoy'), root: { kind: 'convoy', id: cv.id } }); queue.push(c); continue; }
      const rn = nearest(c, railIdx, linkKm * boost, () => linkKm * boost);
      if (rn) { linked.set(c.id, { via: 'rail', from: { kind: 'rail', name: 'railhead' }, root: rn.seed != null ? { kind: 'town', id: rn.seed } : null }); queue.push(c); }
    }
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i], root = linked.get(c.id).root;
      mineIdx.near(c.x, c.y, linkKm * 1.25, (o, d) => { if (d <= linkKm * Math.max(logistics(c), logistics(o)) && !linked.has(o.id)) { linked.set(o.id, { via: 'column', from: ref(c, 'column'), root }); queue.push(o); } });
    }
    // With goods, a column supplies while its pool lasts, linked or not; without, while it is linked.
    const suppliers = goods ? mine.filter(c => pool(c) > 0) : mine.filter(c => linked.has(c.id));
    const ctx = { friends, townIdx, convoyIdx, stockedFortIdx, supplyConvoyIdx: goods ? geo.index(lobby, myConvoys.filter(c => pool(c) > 0)) : convoyIdx,
      linkedIdx: geo.index(lobby, suppliers), linkedVia: linked };
    byFriends.set(key, ctx);
    return ctx;
  };
  for (const m of markers) {
    // Emplacements are fixed works with their own magazines: never out of supply.
    if (m.type === 'unit' && !m.data?.aboard && typeOf(m)?.cat === 'Emplacements') { out.set(m.id, { supplied: true, via: 'emplacement', from: null }); continue; }
    if (!needsSupply(m)) continue;
    const ctx = ctxFor(m.data?.nation);
    if (typeId(m) === 'supply') {
      const l = ctx.linkedVia.get(m.id);
      if (goods) out.set(m.id, pool(m) > 0 ? { supplied: true, via: l ? l.via : 'pool', from: l ? l.from : null, root: l?.root || null } : { supplied: false, via: '', from: null, root: l?.root || null });
      else out.set(m.id, l ? { supplied: true, via: l.via, from: l.from, root: l.root } : { supplied: false, via: '', from: null });
      continue;
    }
    // In a friendly town (its drawn streets) or within supplyTownKm of one.
    let t = null, td = Infinity;
    ctx.townIdx.near(m.x, m.y, townReach, (o, d) => { if ((d <= townKm || inTown(m, o)) && d < td && stocked(o)) { td = d; t = o; } });
    if (t) { out.set(m.id, { supplied: true, via: 'town', from: ref(t, 'place') }); continue; }
    const ft = nearest(m, ctx.stockedFortIdx, townKm, () => townKm);
    if (ft) { out.set(m.id, { supplied: true, via: 'fort', from: ref(ft, 'fort') }); continue; }
    const c = nearest(m, ctx.linkedIdx, rangeKm * 1.25, o => rangeKm * logistics(o));
    if (c) { out.set(m.id, { supplied: true, via: 'column', from: ref(c, 'column') }); continue; }
    const cv = nearest(m, ctx.supplyConvoyIdx, convoyRangeKm, () => convoyRangeKm);
    if (cv) { out.set(m.id, { supplied: true, via: 'convoy', from: ref(cv, 'convoy') }); continue; }
    out.set(m.id, { supplied: false, via: '', from: null });
  }
  out.blockaded = blockaded;
  return out;
}

/**
 * Blockaded towns: Set of town ids. A town is blockaded when it is coastal and enemy warships (of a nation at war with its
 * owner) lie within blockadeKm with none of its own side's there to contest them. Transports and submerged submarines
 * do not blockade.
 */
function blockades(lobby, s, markers, friendsOf) {
  const out = new Set(), km = num(s.blockadeKm, 50);
  if (km <= 0) return out;
  const ships = markers.filter(m => m.type === 'unit' && alive(m) && !m.data?.aboard && !m.data?.submerged && m.data?.nation &&
    typeOf(m)?.cat === 'Naval' && typeId(m) !== 'transport');
  if (!ships.length) return out;
  const game = require('./game'), territory = require('./territory');
  const ids = new Map(game.q.factions.all(lobby.id).map(f => [norm(f.name), f.id]));
  const war = new Map();
  const atWar = (a, b) => {
    const k = a < b ? a + '|' + b : b + '|' + a;
    if (!war.has(k)) war.set(k, ids.has(a) && ids.has(b) && game.relationStatus(lobby.id, ids.get(a), ids.get(b)) === 'war');
    return war.get(k);
  };
  const idx = geo.index(lobby, ships);
  for (const t of markers) {
    if (t.type !== 'town' || !t.data?.nation) continue;
    const owner = norm(t.data.nation), friends = friendsOf(t.data.nation);
    let enemy = false, friend = false;
    idx.near(t.x, t.y, km, o => { const n = norm(o.data.nation); if (friends.has(n)) friend = true; else if (atWar(owner, n)) enemy = true; });
    if (enemy && !friend && territory.isCoastal(lobby, t.x, t.y, Math.min(km, num(s.coastalKm, 30)))) out.add(t.id);
  }
  return out;
}

/** Is a support unit working? Alive, and not out of supply (cut off with nothing left of what it carries). */
const working = m => alive(m) && !exhausted(m);

/**
 * Bonuses friendly support units give a unit in combat: { attack, defend, notes: [text] }.
 * HQ: +hqBonus attack and defend within hqKm. Engineers / pioneers / sappers: +engineerDefend defend within
 * engineerKm. Signals: +signalsArtillery attack for artillery within signalsKm. The best of each kind counts once.
 */
function supportBonus(lobby, settings, markers, unit, friendsOf) {
  const s = settings || {};
  const out = { attack: 0, defend: 0, notes: [] };
  if (unit.type !== 'unit') return out;
  const friends = (friendsOf || friendsResolver(lobby))(unit.data?.nation);
  const near = (ids, km) => markers.find(m => m.id !== unit.id && m.type === 'unit' && ids(typeId(m)) && working(m) &&
    friends.has(norm(m.data?.nation)) && geo.distance(lobby, unit.x, unit.y, m.x, m.y) <= km);
  const hq = num(s.hqBonus, 1) ? near(id => id === 'hq', num(s.hqKm, 40)) : null;
  if (hq) { out.attack += num(s.hqBonus, 1); out.defend += num(s.hqBonus, 1); out.notes.push(`+${num(s.hqBonus, 1)} ${hq.name}`); }
  const eng = num(s.engineerDefend, 1) ? near(id => ENGINEERS.has(id), num(s.engineerKm, 20)) : null;
  if (eng) { out.defend += num(s.engineerDefend, 1); out.defendNotes = [`+${num(s.engineerDefend, 1)} works by ${eng.name}`]; }
  if (UnitTypes.firesFromRange(typeOf(unit))) {
    const sig = num(s.signalsArtillery, 1) ? near(id => id === 'signals', num(s.signalsKm, 60) * heroes.effects(lobby, s, markers, unit).spotting) : null;
    if (sig) { out.attack += num(s.signalsArtillery, 1); out.notes.push(`+${num(s.signalsArtillery, 1)} spotting by ${sig.name}`); }
  }
  return out;
}

/** Field hospitals at End turn: [{ unit, from, to, hospital }] — each damaged friendly land unit healed once. */
function healing(lobby, settings, markers) {
  const s = settings || {};
  const km = num(s.hospitalKm, 40), heal = num(s.hospitalHeal, 10);
  if (heal <= 0) return [];
  const friendsOf = friendsResolver(lobby);
  const hospitals = markers.filter(m => m.type === 'unit' && typeId(m) === 'medical' && working(m));
  const out = [];
  for (const u of markers) {
    if (!needsSupply(u) || !alive(u) || u.data?.supplied === false) continue;   // no medicine reaches a cut-off unit (whatever it carries)
    const from = num(u.data?.strength, 100);
    if (from >= 100) continue;
    const friends = friendsOf(u.data?.nation);
    const h = hospitals.filter(h => h.id !== u.id && friends.has(norm(h.data?.nation)) && geo.distance(lobby, u.x, u.y, h.x, h.y) <= km).sort((a, b) => (norm(b.data.nation) === norm(u.data.nation) ? heroes.effects(lobby, s, markers, b).heal : 0) - (norm(a.data.nation) === norm(u.data.nation) ? heroes.effects(lobby, s, markers, a).heal : 0))[0];
    if (h) out.push({ unit: u, from, to: Math.min(100, from + heal + (norm(h.data.nation) === norm(u.data.nation) ? heroes.effects(lobby, s, markers, h).heal : 0)), hospital: h });
  }
  return out;
}

module.exports = { compute, blockades, supportBonus, healing, needsSupply, friendsResolver, stockMax, exhausted, TOWN_PX };
