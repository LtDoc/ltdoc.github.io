'use strict';
/**
 * Railways (docs/RAILWAYS.md): drawings of kind 'rail'. Land units and heroes move along open track at
 * settings.railSpeed times their normal pace; sections can be cut by sabotage and repaired.
 * The network maths is shared with the browser (public/js/railnet.js).
 */
const RailNet = require('../public/js/railnet');
const access = require('./lobbyAccess');
const geo = require('./geo');
const { db } = require('./db');

const q = {
  rails: db.prepare("SELECT * FROM shapes WHERE lobby_id = ? AND kind = 'rail' ORDER BY id"),
};

/** Distance and nearest-point squeeze for a lobby's map (km on the Earth map). */
function metric(lobby) {
  const earth = geo.isEarth(lobby), H = lobby.map_height;
  return {
    dist: (x1, y1, x2, y2) => geo.distance(lobby, x1, y1, x2, y2),
    kx: earth ? (y => Math.max(0.05, Math.cos((90 - y / H * 180) * Math.PI / 180))) : (() => 1),
  };
}

/** Rails that carry traffic: every rail drawing except GM-only ones and planned lines not yet built. */
function railShapes(lobbyId) {
  return q.rails.all(lobbyId).map(access.serializeShape).filter(s => !s.adminOnly && s.data?.state !== 'plan');
}

const cache = new Map();   // lobbyId -> { key, net }
/** Drop a campaign's network from memory (rebuilt when next needed). */
function forget(lobbyId) { cache.delete(Number(lobbyId)); }
function cached() { return [...cache.keys()]; }
/** The lobby's network, rebuilt only when a rail or a rule it depends on changes. */
function network(lobby, settings) {
  const shapes = railShapes(lobby.id);
  const s = settings || {};
  const key = `${shapes.map(r => `${r.id}:${r.updatedAt}`).join(',')}|${s.railJoinKm}|${s.railCutKm}`;
  const hit = cache.get(lobby.id);
  if (hit && hit.key === key) return hit.net;
  const net = RailNet.build(shapes.map(r => ({ id: r.id, label: r.label, points: r.points, cuts: r.data?.cuts || [] })), {
    ...metric(lobby), joinKm: num(s.railJoinKm, 5), cutKm: num(s.railCutKm, 10), speed: num(s.railSpeed, 4),
  });
  cache.set(lobby.id, { key, net });
  return net;
}
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/**
 * Which track a nation may ride: its own and its allies' ground, neutral ground and the sea (bridges,
 * ferries). Another power's railways are closed to it, at peace or at war. Without territories, all track.
 */
function usableFor(lobby, nation, net) {
  const territory = require('./territory');
  const game = require('./game');
  const owners = net && edgeOwners(lobby, net) ? net._owners.byEdge : null;
  let lookup = owners ? undefined : territory.ownerLookup(lobby);   // for track not in the network: looked up when first needed
  if (!owners && !lookup) return null;
  const n = String(nation || '').toLowerCase();
  const factions = game.q.factions.all(lobby.id);
  const me = factions.find(f => f.name.toLowerCase() === n);
  const friends = new Set(me ? [me.id] : []);
  if (me) for (const f of factions) if (f.id !== me.id && require('./treaties').permission(lobby.id, me.id, f.id, 'land')) friends.add(f.id);
  return e => {
    if (owners && owners.has(e)) { const owner = owners.get(e); return owner === null || friends.has(owner); }
    if (lookup === undefined) lookup = territory.ownerLookup(lobby);
    const owner = lookup ? lookup(e.mx, e.my) : null;
    return owner === null || owner === undefined || owner === territory.NEUTRAL || friends.has(owner);
  };
}

/**
 * The ground under each edge of a network (a faction id, or null for neutral ground and the sea), looked up once
 * and kept on the network until ground changes hands, so moves and supply do not test every stretch of track
 * against the borders again. Null when the campaign has no territories: all track is open.
 */
function edgeOwners(lobby, net) {
  const territory = require('./territory');
  const key = territory.ownershipKey(lobby);
  if (net._owners && net._owners.key === key) return net._owners.list;
  const lookup = territory.ownerLookup(lobby);
  const list = lookup ? net.edges.map(e => {
    const owner = lookup(e.mx, e.my);
    return owner === null || owner === undefined || owner === territory.NEUTRAL ? null : owner;
  }) : null;
  net._owners = { key, list, byEdge: list ? new Map(net.edges.map((e, i) => [e, list[i]])) : null };
  return list;
}

/** Land units and heroes ride trains; ships and aircraft do not. */
function canRide(marker) {
  if (marker.type === 'hero') return true;
  return require('./territory').isLandUnit(marker);
}

/** The cheaper-than-walking rail trip for a marker, or null. { cost, railKm, walkKm, path } */
function plan(lobby, settings, marker, x, y) {
  if (!canRide(marker)) return null;
  const net = network(lobby, settings);
  if (!net.edges.length) return null;
  const game = require('./game'), traits = require('./heroes').effects(lobby, settings, game.q.markers.all(lobby.id).map(access.serializeMarker), marker);
  return RailNet.route(net, { x: marker.x, y: marker.y }, { x, y }, { usable: usableFor(lobby, marker.data?.nation, net), speed: num(settings.railSpeed, 4) * traits.rail, walkSpeed: traits.walk });
}

/** Walk a route until the budget runs out. */
function walk(lobby, path, budget) { return RailNet.walk(path, budget, metric(lobby).dist); }

/** Nearest point on a rail drawing to (x, y), with the distance to it. */
function nearestOn(lobby, rail, x, y) {
  const m = metric(lobby);
  const p = RailNet.project(rail.points, x, y, m.kx);
  if (!p) return null;
  return { ...p, d: m.dist(x, y, p.x, p.y) };
}

/** The cut (if any) whose section covers a point on the rail. */
function cutAt(lobby, settings, rail, x, y) {
  const m = metric(lobby);
  const p = RailNet.project(rail.points, x, y, m.kx);
  if (!p) return null;
  const s = RailNet.arcAt(rail.points, p, m.dist);
  return RailNet.cutIntervals(rail.points, rail.data?.cuts || [], { ...m, cutKm: num(settings.railCutKm, 10) })
    .find(c => c.from <= s && c.to >= s)?.cut || null;
}

/**
 * A railway's ends snapped onto other track within railJoinKm (another line's end if one is in reach, else the
 * nearest point on it), so lines drawn to meet are stored joined. The network joins them either way.
 */
function snapEnds(lobby, settings, points, selfId) {
  const others = railShapes(lobby.id).filter(r => r.id !== selfId && r.points.length >= 2);
  if (!others.length || points.length < 2) return points;
  const m = metric(lobby), joinKm = num(settings?.railJoinKm, 20), r1 = v => Math.round(v * 10) / 10;
  const out = points.map(q => [q[0], q[1]]);
  for (const i of [0, out.length - 1]) {
    const [x, y] = out[i];
    let end = null, line = null;
    for (const r of others) {
      for (const e of [r.points[0], r.points[r.points.length - 1]]) {
        const d = m.dist(x, y, e[0], e[1]);
        if (d <= joinKm && (!end || d < end.d)) end = { x: e[0], y: e[1], d };
      }
      const q = RailNet.project(r.points, x, y, m.kx);
      if (q) { const d = m.dist(x, y, q.x, q.y); if (d <= joinKm && (!line || d < line.d)) line = { x: q.x, y: q.y, d }; }
    }
    const best = end || line;
    if (best && best.d > 0) out[i] = [r1(best.x), r1(best.y)];
  }
  return out;
}

/** Track length of a rail drawing in campaign units. */
function length(lobby, rail) {
  const d = metric(lobby).dist;
  let s = 0;
  for (let i = 1; i < rail.points.length; i++) s += d(rail.points[i - 1][0], rail.points[i - 1][1], rail.points[i][0], rail.points[i][1]);
  return s;
}

module.exports = { network, forget, cached, plan, walk, usableFor, edgeOwners, canRide, nearestOn, cutAt, length, metric, railShapes, snapEnds };
