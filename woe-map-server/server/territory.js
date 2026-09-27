'use strict';
/**
 * Territories (docs/GAME-DESIGN.md §5): one multipolygon per faction plus neutral (faction_id 0), stored in
 * map pixels. Seeded from a historical year on the Earth map or painted by the GM, and carved by advancing
 * land units. Polygon booleans come from polygon-clipping (pure JS).
 *
 * Geometry format = polygon-clipping's MultiPolygon: [ polygon, ... ], polygon = [ outerRing, hole, ... ],
 * ring = [ [x, y], ... ]. Coordinates are rounded to 0.1 px.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const pc = require('polygon-clipping');
const { db, now } = require('./db');
const config = require('./config');
const access = require('./lobbyAccess');
const geo = require('./geo');
const UnitTypes = require('../public/js/units');

const q = {
  all: db.prepare('SELECT * FROM territories WHERE lobby_id = ?'),
  one: db.prepare('SELECT * FROM territories WHERE lobby_id = ? AND faction_id = ?'),
  upsert: db.prepare(`INSERT INTO territories (lobby_id, faction_id, geometry, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(lobby_id, faction_id) DO UPDATE SET geometry = excluded.geometry, updated_at = excluded.updated_at`),
  remove: db.prepare('DELETE FROM territories WHERE lobby_id = ? AND faction_id = ?'),
  clear: db.prepare('DELETE FROM territories WHERE lobby_id = ?'),
};

const NEUTRAL = 0;
const r1 = n => Math.round(n * 10) / 10;

// ---- Bundled Earth data ------------------------------------------------------------------
const cache = new Map();
function loadGz(name) {
  if (!cache.has(name)) {
    const file = path.join(config.root, 'public', 'earth', `${name}.json.gz`);
    cache.set(name, fs.existsSync(file) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) : null);
  }
  return cache.get(name);
}
function earthYears() {
  try { return JSON.parse(fs.readFileSync(path.join(config.root, 'public', 'earth', 'index.json'), 'utf8')).years || []; }
  catch { return []; }
}
/** Land as a projected multipolygon (with bboxes) for a map size, cached per size. */
function landFor(lobby) {
  const key = `land:${lobby.map_width}x${lobby.map_height}`;
  if (!cache.has(key)) {
    const land = loadGz('land');
    const W = lobby.map_width, H = lobby.map_height;
    const polys = land ? land.polygons.map(poly => poly.map(ring => ring.map(p => geo.project(p[0], p[1], W, H)))) : [];
    cache.set(key, polys.map(p => ({ poly: p, bbox: bboxOf([p]) })));
  }
  return cache.get(key);
}

// ---- Geometry helpers ----------------------------------------------------------------------
function bboxOf(multi) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of multi) for (const ring of poly) for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInMulti(x, y, multi) {
  for (const poly of multi) {
    if (!poly.length || !pointInRing(x, y, poly[0])) continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++) if (pointInRing(x, y, poly[i])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

/** Douglas–Peucker on a ring; keeps at least a triangle. */
function simplifyRing(pts, tol) {
  if (pts.length <= 4) return pts;
  const sq = tol * tol, keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (!len2) d = (px - ax) ** 2 + (py - ay) ** 2;
      else { const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)); d = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2; }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > sq && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = pts.filter((p, i) => keep[i]);
  return out.length >= 4 ? out : pts;
}
function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}
/** Simplify, round and drop slivers so territories stay small after many operations. */
function clean(multi, tol = 1.2, minArea = 6) {
  const out = [];
  for (const poly of multi || []) {
    const rings = [];
    for (let i = 0; i < poly.length; i++) {
      const r = simplifyRing(poly[i].map(p => [r1(p[0]), r1(p[1])]), tol);
      if (r.length < 4 || ringArea(r) < minArea) { if (i === 0) { rings.length = 0; break; } continue; }
      rings.push(r);
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

/** A circle of `km` around a map point as a polygon (an ellipse in pixels on the Earth map). */
function circle(lobby, x, y, km, n = 28) {
  let rx, ry;
  if (geo.isEarth(lobby)) {
    const W = lobby.map_width, H = lobby.map_height;
    const [, lat] = geo.unproject(x, y, W, H);
    const kmPerDegLat = 111.32, kmPerDegLon = 111.32 * Math.max(0.12, Math.cos(lat * Math.PI / 180));
    rx = km / kmPerDegLon * (W / 360); ry = km / kmPerDegLat * (H / 180);
  } else rx = ry = km / (lobby.units_per_px || 1);
  const ring = [];
  for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; ring.push([r1(x + Math.cos(a) * rx), r1(y + Math.sin(a) * ry)]); }
  return [[ring]];
}

/** Is a map point on land (Earth map)? Image maps are all land. */
function isLand(lobby, x, y) {
  if (!geo.isEarth(lobby)) return true;
  for (const l of landFor(lobby)) {
    const b = l.bbox;
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
    if (pointInMulti(x, y, [l.poly])) return true;
  }
  return false;
}
/** Coastal test: any point on a circle of `km` around (x, y) is sea. */
function isCoastal(lobby, x, y, km = 30) {
  if (!geo.isEarth(lobby)) return true;
  const ring = circle(lobby, x, y, km, 24)[0][0];
  return ring.some(p => !isLand(lobby, p[0], p[1]));
}

/** Clip a multipolygon to land on the Earth map (image maps have no sea). */
function landClip(lobby, multi) {
  if (!geo.isEarth(lobby)) return multi;
  const bb = bboxOf(multi);
  const cand = landFor(lobby).filter(l => overlaps(l.bbox, bb)).map(l => l.poly);
  if (!cand.length) return [];
  return pc.intersection(multi, cand);
}

// ---- Storage ---------------------------------------------------------------------------------
function serialize(row) { return { factionId: row.faction_id, geometry: access.safeJson(row.geometry) || [], updatedAt: row.updated_at }; }
function all(lobbyId) { return q.all.all(lobbyId).map(serialize); }
function write(lobbyId, factionId, geometry, opts) {
  const g = clean(geometry, opts?.tol, opts?.minArea);
  if (!g.length) { q.remove.run(lobbyId, factionId); return { factionId, geometry: [], updatedAt: now() }; }
  q.upsert.run(lobbyId, factionId, JSON.stringify(g), now());
  return { factionId, geometry: g, updatedAt: now() };
}
function clear(lobbyId) { q.clear.run(lobbyId); }

/** Faction id owning a point, NEUTRAL for neutral land, null for nobody (sea or unclaimed). */
function ownerAt(terrs, x, y) {
  for (const t of terrs) if (t.factionId !== NEUTRAL && pointInMulti(x, y, t.geometry)) return t.factionId;
  for (const t of terrs) if (t.factionId === NEUTRAL && pointInMulti(x, y, t.geometry)) return NEUTRAL;
  return null;
}

/**
 * Give `multi` to `factionId` (NEUTRAL to make it unowned): subtract it from every other territory that
 * overlaps and union it into the receiver's. Returns the territories that changed (serialized).
 */
function carve(lobbyId, factionId, multi, opts) {
  if (!multi || !multi.length) return [];
  const bb = bboxOf(multi);
  const changed = [];
  for (const t of all(lobbyId)) {
    if (t.factionId === factionId || !t.geometry.length || !overlaps(bboxOf(t.geometry), bb)) continue;
    const next = clean(pc.difference(t.geometry, multi), opts?.tol, opts?.minArea);
    if (JSON.stringify(next) === JSON.stringify(t.geometry)) continue;   // bbox overlapped but nothing was cut
    changed.push(write(lobbyId, t.factionId, next, opts));
  }
  const mine = q.one.get(lobbyId, factionId);
  const merged = pc.union(mine ? access.safeJson(mine.geometry) || [] : [], multi);
  changed.push(write(lobbyId, factionId, merged, opts));
  return changed;
}
/** Lazily required: provinces.js depends on this module. */
const provinces = () => require('./provinces');

// ---- Seeding and GM tools -------------------------------------------------------------------
/**
 * Replace the lobby's territories with a historical year's states: each state (or its overlord for
 * colonies) goes to the faction of the same name; the rest becomes neutral.
 */
function seedFromYear(lobby, year, factions) {
  // With provinces, "the borders of that year" means the states the provinces were cut from.
  if (provinces().has(lobby.id)) return provinces().assignByState(lobby.id, factions);
  const world = earthYears().includes(Number(year)) ? loadGz(`world_${Number(year)}`) : null;
  if (!world) throw new Error('No borders bundled for that year');
  const W = lobby.map_width, H = lobby.map_height;
  const byName = new Map(factions.map(f => [f.name.toLowerCase(), f.id]));
  const groups = new Map();   // factionId -> polygons
  const assigned = [], unassigned = [];
  for (const c of world.countries) {
    const power = c.s || c.n;
    const fid = byName.get(String(power).toLowerCase()) ?? NEUTRAL;
    (fid === NEUTRAL ? unassigned : assigned).push(c.n);
    if (!groups.has(fid)) groups.set(fid, []);
    for (const poly of c.p) groups.get(fid).push(poly.map(ring => ring.map(p => { const [x, y] = geo.project(p[0], p[1], W, H); return [r1(x), r1(y)]; })));
  }
  clear(lobby.id);
  const out = [];
  for (const [fid, polys] of groups) {
    let merged = [];
    for (let i = 0; i < polys.length; i += 40) merged = pc.union(merged, polys.slice(i, i + 40));
    out.push(write(lobby.id, fid, merged));
  }
  return { territories: out, assigned: [...new Set(assigned)], unassigned: [...new Set(unassigned)] };
}
function assignArea(lobby, factionId, points) {
  const ring = points.map(p => [r1(p[0]), r1(p[1])]);
  if (provinces().has(lobby.id)) {
    const ids = provinces().list(lobby.id).filter(p => pointInMulti(p.cx, p.cy, [[ring]])).map(p => p.id);
    return provinces().give(lobby, ids, factionId);
  }
  return carve(lobby.id, factionId, landClip(lobby, [[ring]]));
}
/** Brush: provinces whose centre is within km (0 = the clicked province) when provinces exist, else a circle. */
function brush(lobby, factionId, x, y, km) {
  if (provinces().has(lobby.id)) return provinces().give(lobby, provinces().within(lobby, x, y, km).map(p => p.id), factionId);
  return carve(lobby.id, factionId, landClip(lobby, circle(lobby, x, y, km)));
}

/**
 * Markers that follow territory ownership: resource nodes, factories and towns take the faction that owns
 * the ground under them. Returns [{ marker, nation }] for the ones whose nation should change.
 */
function ownershipChanges(terrs, factions, markers) {
  const byId = new Map(factions.map(f => [f.id, f]));
  const out = [];
  if (!terrs.length) return out;
  for (const m of markers) {
    if (!['resource', 'factory', 'town'].includes(m.type)) continue;
    const owner = ownerAt(terrs, m.x, m.y);
    if (owner === null) continue;                       // sea or unclaimed: leave as is
    const nation = owner === NEUTRAL ? '' : (byId.get(owner)?.name || '');
    if (String(m.data?.nation || '').toLowerCase() !== nation.toLowerCase()) out.push({ marker: m, nation });
  }
  return out;
}

/** A trench belongs to the faction whose territory most of its centreline lies in ('' when unowned). */
function trenchOwner(terrs, factions, shape) {
  const byId = new Map(factions.map(f => [f.id, f]));
  const votes = new Map();
  for (const p of shape.points || []) {
    const o = ownerAt(terrs, p[0], p[1]);
    if (o === null) continue;
    votes.set(o, (votes.get(o) || 0) + 1);
  }
  let best = null, n = 0;
  for (const [o, c] of votes) if (c > n) { n = c; best = o; }
  if (best === null || best === NEUTRAL) return '';
  return byId.get(best)?.name || '';
}
/** Trenches whose owner should change with the territory under them. */
function trenchOwnershipChanges(terrs, factions, shapes) {
  const out = [];
  if (!terrs.length) return out;
  for (const s of shapes) {
    if (s.kind !== 'trench') continue;
    const nation = trenchOwner(terrs, factions, s);
    if (String(s.data?.nation || '').toLowerCase() !== nation.toLowerCase()) out.push({ shape: s, nation });
  }
  return out;
}

/** Distance in campaign units from a point to a polyline (closest point found in pixel space, then measured geodesically). */
function distanceToPath(lobby, x, y, pts) {
  let best = Infinity, bx = x, by = y;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [cx, cy] = pts[i + 1], dx = cx - ax, dy = cy - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const px = ax + dx * t, py = ay + dy * t, d = (x - px) ** 2 + (y - py) ** 2;
    if (d < best) { best = d; bx = px; by = py; }
  }
  return best === Infinity ? Infinity : geo.distance(lobby, x, y, bx, by);
}
/**
 * Cover for a unit: the best dug or reinforced trench of its own nation (or an unowned one) within
 * settings.trenchRangeKm. Returns { bonus, trench } or null.
 */
function trenchCover(lobby, settings, unit, shapes) {
  const range = Number(settings.trenchRangeKm ?? 20), dug = Number(settings.trenchBonusDug ?? 2), reinforced = Number(settings.trenchBonusReinforced ?? 4);
  const nation = String(unit.data?.nation || '').toLowerCase();
  let best = null;
  for (const s of shapes) {
    if (s.kind !== 'trench' || !s.data || s.data.state === 'plan' || (s.points || []).length < 2) continue;
    const owner = String(s.data.nation || '').toLowerCase();
    if (owner && owner !== nation) continue;
    if (distanceToPath(lobby, unit.x, unit.y, s.points) > range) continue;
    const bonus = s.data.state === 'reinforced' ? reinforced : dug;
    if (!best || bonus > best.bonus) best = { bonus, trench: s };
  }
  return best;
}

const LAND_CATEGORIES = new Set(['Infantry', 'Mounted & mobile', 'Artillery', 'Support']);
function isLandUnit(m) {
  if (m.type !== 'unit') return false;
  const t = UnitTypes.resolve(m.data?.unitType);
  return t ? LAND_CATEGORIES.has(t.cat) : true;   // unknown custom types count as land
}

/**
 * The capture rule after a land unit's committed move (§5.2). `relation(a, b)` returns peace|war|alliance.
 * Returns null when nothing happens, else { changed: territories, flips: [{marker, nation}], cities: [names], held }.
 */
function capture(lobby, g, unit, factions, markers, relation) {
  if (!g.enabled || !isLandUnit(unit) || Number(unit.data?.strength ?? 100) <= 0) return null;
  const mine = factions.find(f => f.name.toLowerCase() === String(unit.data?.nation || '').toLowerCase());
  if (!mine) return null;
  const terrs = all(lobby.id);
  if (!terrs.length) return null;
  const owner = ownerAt(terrs, unit.x, unit.y);
  if (owner === null || owner === mine.id) return null;
  if (owner === NEUTRAL) { if (!g.settings.occupyNeutrals) return null; }
  else if (relation(mine.id, owner) !== 'war') return null;
  const s = g.settings;
  const radius = Number(s.captureRadiusKm) || 60;
  const ownerName = owner === NEUTRAL ? '' : (factions.find(f => f.id === owner)?.name || '').toLowerCase();
  // Contested ground: an enemy land unit within the radius holds the front.
  const enemyNear = markers.some(m => m.id !== unit.id && isLandUnit(m) && Number(m.data?.strength ?? 100) > 0 &&
    String(m.data?.nation || '').toLowerCase() !== mine.name.toLowerCase() &&
    (() => { const f = factions.find(x => x.name.toLowerCase() === String(m.data?.nation || '').toLowerCase()); return f && relation(mine.id, f.id) === 'war'; })() &&
    geo.distance(lobby, unit.x, unit.y, m.x, m.y) <= radius);
  if (enemyNear) return { held: true, changed: [], flips: [], cities: [] };
  const cities = [];
  const enemyCities = markers.filter(m => m.type === 'town' && ['city', 'capital'].includes(m.data?.size) &&
    String(m.data?.nation || '').toLowerCase() === ownerName && String(m.data?.nation || '').toLowerCase() !== mine.name.toLowerCase() &&
    geo.distance(lobby, unit.x, unit.y, m.x, m.y) <= radius);
  let changed;
  if (provinces().has(lobby.id)) {
    // Province rule: the province under the unit and the owner's provinces whose centre is within the
    // capture radius; an enemy city inside adds the owner's provinces within the city radius.
    const pv = provinces();
    const theirs = p => p.factionId === owner;
    const ids = new Set(pv.within(lobby, unit.x, unit.y, radius, theirs).map(p => p.id));
    const landing = pv.at(lobby.id, unit.x, unit.y);
    if (landing && theirs(landing)) ids.add(landing.id);
    for (const m of enemyCities) { for (const p of pv.within(lobby, m.x, m.y, Number(s.cityRadiusKm) || 150, theirs)) ids.add(p.id); cities.push(m); }
    changed = pv.give(lobby, [...ids], mine.id);
  } else {
    let multi = circle(lobby, unit.x, unit.y, radius);
    for (const m of enemyCities) { multi = pc.union(multi, circle(lobby, m.x, m.y, Number(s.cityRadiusKm) || 150)); cities.push(m); }
    changed = carve(lobby.id, mine.id, landClip(lobby, multi));
  }
  const flips = ownershipChanges(all(lobby.id), factions, markers).filter(f => f.nation.toLowerCase() === mine.name.toLowerCase());
  return { held: false, changed, flips, cities: cities.map(c => c.name), owner, mine };
}

module.exports = { NEUTRAL, all, write, clear, carve, circle, landClip, ownerAt, seedFromYear, assignArea, brush, ownershipChanges, capture, isLandUnit, earthYears, clean,
  trenchOwner, trenchOwnershipChanges, trenchCover, distanceToPath, isLand, isCoastal, landFor, loadGz, bboxOf, pointInMulti, overlaps };
