'use strict';
/**
 * Supply and support units (docs/UNITS.md).
 *
 * Supply is true or false per land unit, decided at End turn (and when the GM recalculates):
 *   - A Supply Column is linked when it is within supplyLinkKm of a friendly town (own or allied), of open
 *     friendly railway connected to a friendly town, or of another linked column (columns chain forward).
 *   - A land unit is supplied when it is within supplyTownKm of a friendly town (garrison) or within
 *     supplyRangeKm of a linked column. A column itself is supplied when it is linked.
 *   - Ships, aircraft and heroes do not need supply.
 * Support units (alive and supplied) help friendly units around them: HQ (attack and defend), engineers,
 * pioneers and sappers (defend), signals (artillery attack), field hospitals (heal at End turn).
 */
const geo = require('./geo');
const UnitTypes = require('../public/js/units');

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const norm = s => String(s || '').trim().toLowerCase();
const LAND = new Set(['Infantry', 'Mounted & mobile', 'Artillery', 'Support']);
const typeOf = m => UnitTypes.resolve(m.data?.unitType);
const typeId = m => typeOf(m)?.id || '';
const alive = m => num(m.data?.strength, 100) > 0;
/** Land units need supply (unknown custom types count as land, like the capture rule). */
function needsSupply(m) {
  if (m.type !== 'unit') return false;
  const t = typeOf(m);
  return t ? LAND.has(t.cat) : true;
}
const ENGINEERS = new Set(['engineers', 'pioneers', 'sappers']);

/** (nation) → Set of friendly nation names (itself and its allies), cached per call. */
function friendsResolver(lobby) {
  const game = require('./game');
  const factions = game.q.factions.all(lobby.id);
  const cache = new Map();
  return nation => {
    const n = norm(nation);
    if (cache.has(n)) return cache.get(n);
    const me = factions.find(f => norm(f.name) === n);
    const set = new Set(n ? [n] : []);
    if (me) for (const f of factions) if (f.id !== me.id && game.relationStatus(lobby.id, me.id, f.id) === 'alliance') set.add(norm(f.name));
    cache.set(n, set);
    return set;
  };
}

/**
 * Supply for every land unit: Map(markerId → { supplied, via }) where via says why ('town', 'column', 'linked',
 * 'rail', or '' when cut off). Pure apart from reading relations and the rail network.
 */
function compute(lobby, settings, markers) {
  const s = settings || {};
  const townKm = num(s.supplyTownKm, 30), linkKm = num(s.supplyLinkKm, 150), rangeKm = num(s.supplyRangeKm, 80);
  const dist = (a, b) => geo.distance(lobby, a.x, a.y, b.x, b.y);
  const friendsOf = friendsResolver(lobby);
  const towns = markers.filter(m => m.type === 'town' && m.data?.nation);
  const columns = markers.filter(m => m.type === 'unit' && typeId(m) === 'supply' && alive(m));
  const out = new Map();
  const byFriends = new Map();   // friends key → { towns, railNodes, linked }
  const ctxFor = nation => {
    const friends = friendsOf(nation);
    const key = [...friends].sort().join('|');
    if (byFriends.has(key)) return byFriends.get(key);
    const myTowns = towns.filter(t => friends.has(norm(t.data.nation)));
    // Railways carry supply: open track this side may use, reached from within 25 km of one of its towns.
    let railNodes = [];
    try {
      const rails = require('./rails');
      const net = rails.network(lobby, s);
      if (net.edges.length && myTowns.length) {
        const usable = rails.usableFor(lobby, nation);
        const open = net.edges.map(e => !e.cut && (!usable || usable(e)));
        const seen = new Uint8Array(net.nodes.length), stack = [];
        net.nodes.forEach((n, i) => { if (myTowns.some(t => dist(n, t) <= 25)) { seen[i] = 1; stack.push(i); } });
        while (stack.length) {
          const n = stack.pop();
          for (const ei of net.adj[n]) {
            if (!open[ei]) continue;
            const e = net.edges[ei], m = e.a === n ? e.b : e.a;
            if (!seen[m]) { seen[m] = 1; stack.push(m); }
          }
        }
        railNodes = net.nodes.filter((n, i) => seen[i]);
      }
    } catch { railNodes = []; }
    // Columns chain outward from towns and railheads.
    const mine = columns.filter(c => friends.has(norm(c.data?.nation)));
    const linked = new Map();   // column id → via
    const queue = [];
    for (const c of mine) {
      if (myTowns.some(t => dist(c, t) <= linkKm)) { linked.set(c.id, 'town'); queue.push(c); }
      else if (railNodes.some(n => dist(c, n) <= linkKm)) { linked.set(c.id, 'rail'); queue.push(c); }
    }
    while (queue.length) {
      const c = queue.shift();
      for (const o of mine) if (!linked.has(o.id) && dist(c, o) <= linkKm) { linked.set(o.id, 'column'); queue.push(o); }
    }
    const ctx = { friends, myTowns, linked: mine.filter(c => linked.has(c.id)), linkedVia: linked };
    byFriends.set(key, ctx);
    return ctx;
  };
  for (const m of markers) {
    if (!needsSupply(m)) continue;
    const ctx = ctxFor(m.data?.nation);
    if (typeId(m) === 'supply') { const via = ctx.linkedVia.get(m.id); out.set(m.id, { supplied: !!via, via: via ? 'linked' : '' }); continue; }
    if (ctx.myTowns.some(t => dist(m, t) <= townKm)) { out.set(m.id, { supplied: true, via: 'town' }); continue; }
    if (ctx.linked.some(c => dist(m, c) <= rangeKm)) { out.set(m.id, { supplied: true, via: 'column' }); continue; }
    out.set(m.id, { supplied: false, via: '' });
  }
  return out;
}

/** Is a support unit working? Alive, and not cut off from supply. */
const working = m => alive(m) && m.data?.supplied !== false;

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
  if (typeOf(unit)?.cat === 'Artillery') {
    const sig = num(s.signalsArtillery, 1) ? near(id => id === 'signals', num(s.signalsKm, 60)) : null;
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
    if (!needsSupply(u) || !alive(u)) continue;
    const from = num(u.data?.strength, 100);
    if (from >= 100) continue;
    const friends = friendsOf(u.data?.nation);
    const h = hospitals.find(h => h.id !== u.id && friends.has(norm(h.data?.nation)) && geo.distance(lobby, u.x, u.y, h.x, h.y) <= km);
    if (h) out.push({ unit: u, from, to: Math.min(100, from + heal), hospital: h });
  }
  return out;
}

module.exports = { compute, supportBonus, healing, needsSupply, friendsResolver };
