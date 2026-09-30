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

/** Rails that carry traffic: every rail drawing except GM-only ones (plans). */
function railShapes(lobbyId) {
  return q.rails.all(lobbyId).map(access.serializeShape).filter(s => !s.adminOnly);
}

const cache = new Map();   // lobbyId -> { key, net }
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
function usableFor(lobby, nation) {
  const territory = require('./territory');
  const game = require('./game');
  const lookup = territory.ownerLookup(lobby);
  if (!lookup) return null;
  const n = String(nation || '').toLowerCase();
  const factions = game.q.factions.all(lobby.id);
  const me = factions.find(f => f.name.toLowerCase() === n);
  const friends = new Set(me ? [me.id] : []);
  if (me) for (const f of factions) if (f.id !== me.id && game.relationStatus(lobby.id, me.id, f.id) === 'alliance') friends.add(f.id);
  return e => {
    const owner = lookup(e.mx, e.my);
    return owner === null || owner === undefined || owner === territory.NEUTRAL || friends.has(owner);
  };
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
  return RailNet.route(net, { x: marker.x, y: marker.y }, { x, y }, { usable: usableFor(lobby, marker.data?.nation), speed: num(settings.railSpeed, 4) });
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

/** Track length of a rail drawing in campaign units. */
function length(lobby, rail) {
  const d = metric(lobby).dist;
  let s = 0;
  for (let i = 1; i < rail.points.length; i++) s += d(rail.points[i - 1][0], rail.points[i - 1][1], rail.points[i][0], rail.points[i][1]);
  return s;
}

module.exports = { network, plan, walk, usableFor, canRide, nearestOn, cutAt, length, metric, railShapes };
