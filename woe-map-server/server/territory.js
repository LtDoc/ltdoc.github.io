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
const Powers = require('../public/js/powers');

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
// New Guinea 1885–1914: the dataset has one "Papua New Guinea"; the Anglo-German line ran along 5°S from the Dutch
// border to 144°E, then south-east to the coast at 8°S. Everything north of it (and the Bismarck Archipelago and
// Bougainville) was German New Guinea; the south was British New Guinea (Papua, Australian from 1906).
const GERMAN_NEW_GUINEA = [[[[141, -5], [144, -5], [147.9, -8], [162, -8], [162, 0], [141, 0], [141, -5]]]];
/**
 * A year's historical states with ownership resolved (public/js/powers.js): each country gets `state` (its name,
 * nameless islands named by position) and `power` (its overlord's display name, e.g. "British Empire").
 * Every reader of the bundled borders should use this rather than the raw file. Cached per year.
 */
function world(year) {
  year = Number(year);
  if (!earthYears().includes(year)) return null;
  const key = `world+${year}`;
  if (!cache.has(key)) {
    const raw = loadGz(`world_${year}`);
    if (!raw) return null;
    const countries = [];
    for (const c of raw.countries) {
      if (c.n === 'Papua New Guinea' && year >= 1885 && year <= 1914) {
        const north = pc.intersection(c.p, GERMAN_NEW_GUINEA), south = pc.difference(c.p, GERMAN_NEW_GUINEA);
        if (north.length) countries.push({ n: 'German New Guinea', s: '', p: north });
        if (south.length) countries.push({ n: 'British New Guinea (Papua)', s: '', p: south });
        continue;
      }
      countries.push(c);
    }
    cache.set(key, { year, countries: countries.map(c => ({ ...c, ...Powers.resolve(year, c) })) });
  }
  return cache.get(key);
}
/** Land as a projected multipolygon (with bboxes) for a map size, cached per size. */
/**
 * The Earth's land in map pixels, as [{ poly, bbox }], with its lakes cut out: lakes are water (no troops, no
 * craters, no provinces; ships may sail on them), islands in them land again. Cached per map size.
 */
function landFor(lobby) {
  const key = `land:${lobby.map_width}x${lobby.map_height}`;
  if (!cache.has(key)) {
    const land = loadGz('land');
    const W = lobby.map_width, H = lobby.map_height;
    const polys = land ? land.polygons.map(poly => poly.map(ring => ring.map(p => geo.project(p[0], p[1], W, H)))) : [];
    const lakes = lakesFor(lobby), out = [];
    for (const p of polys) {
      const bb = bboxOf([p]), wet = lakes.filter(l => overlaps(l.bbox, bb)).map(l => l.poly);
      let cut = [p];
      if (wet.length) { try { cut = pc.difference([p], ...wet); } catch { cut = [p]; } }
      for (const q of cut) out.push({ poly: q, bbox: bboxOf([q]) });
    }
    cache.set(key, out);
  }
  return cache.get(key);
}
/** The Earth's lakes in map pixels, as [{ poly, bbox }] (a lake's holes are its islands). Cached per map size. */
function lakesFor(lobby) {
  const key = `lakes:${lobby.map_width}x${lobby.map_height}`;
  if (!cache.has(key)) {
    const lakes = loadGz('lakes');
    const W = lobby.map_width, H = lobby.map_height;
    const polys = lakes ? lakes.polygons.map(poly => poly.map(ring => ring.map(p => geo.project(p[0], p[1], W, H)))) : [];
    cache.set(key, polys.filter(p => p.length && p[0].length > 2).map(p => ({ poly: p, bbox: bboxOf([p]) })));
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

// ---- Land raster (fast land / sea tests for ships, craters and spawn points) ------------------------
const MASK_CELL = 2;   // map px per cell (about 10 km on the Earth map)
/**
 * A cached raster of the Earth's land at MASK_CELL resolution, filled by scanline (even-odd over every ring).
 * Returns { W, H, cell, data } with data[i] = 1 on land, or null for image maps (which have no sea).
 */
function landMask(lobby) {
  if (!geo.isEarth(lobby)) return null;
  const key = `mask:${lobby.map_width}x${lobby.map_height}`;
  if (cache.has(key)) return cache.get(key);
  const W = Math.ceil(lobby.map_width / MASK_CELL), H = Math.ceil(lobby.map_height / MASK_CELL);
  const data = new Uint8Array(W * H);
  // Bucket every edge by the rows it crosses, then fill between crossings row by row.
  const rows = Array.from({ length: H }, () => []);
  for (const l of landFor(lobby)) for (const ring of l.poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j], [x2, y2] = ring[i];
      if (y1 === y2) continue;
      const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
      const r0 = Math.max(0, Math.ceil(lo / MASK_CELL - 0.5)), r1 = Math.min(H - 1, Math.floor(hi / MASK_CELL - 0.5));
      for (let r = r0; r <= r1; r++) {
        const yc = (r + 0.5) * MASK_CELL;
        if (yc < lo || yc >= hi) continue;
        rows[r].push(x1 + (yc - y1) * (x2 - x1) / (y2 - y1));
      }
    }
  }
  for (let r = 0; r < H; r++) {
    const xs = rows[r].sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] / MASK_CELL - 0.5)), c1 = Math.min(W - 1, Math.floor(xs[k + 1] / MASK_CELL - 0.5));
      for (let c = c0; c <= c1; c++) data[r * W + c] = 1;
    }
  }
  const mask = { W, H, cell: MASK_CELL, data };
  cache.set(key, mask);
  return mask;
}
/** Fast land test from the raster (image maps: always land). */
function landAt(lobby, x, y) {
  const m = landMask(lobby);
  if (!m) return true;
  const c = Math.floor(x / m.cell), r = Math.floor(y / m.cell);
  if (c < 0 || r < 0 || c >= m.W || r >= m.H) return false;
  return m.data[r * m.W + c] === 1;
}
/** Is there water within `cells` raster cells of (x, y)? (a harbour, a coast) */
function nearWater(lobby, x, y, cells = 2) {
  const m = landMask(lobby);
  if (!m) return true;
  const c0 = Math.floor(x / m.cell), r0 = Math.floor(y / m.cell);
  for (let r = r0 - cells; r <= r0 + cells; r++) for (let c = c0 - cells; c <= c0 + cells; c++) {
    if (r < 0 || c < 0 || r >= m.H || c >= m.W || m.data[r * m.W + c] === 0) return true;
  }
  return false;
}
/**
 * Where a ship may go: open water or a coastal spot (within about 15 km of water, for harbours). Checks the
 * destination and samples the straight course for any stretch inland. Returns an error string or null.
 */
function shipCourseError(lobby, x0, y0, x1, y1) {
  const m = landMask(lobby);
  if (!m) return null;
  const ok = (x, y) => !landAt(lobby, x, y) || nearWater(lobby, x, y, 1);
  if (!ok(x1, y1)) return 'Ships cannot sail onto land: pick a spot at sea or on the coast';
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / m.cell);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!ok(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return 'Ships cannot sail over land: go round by sea';
  }
  return null;
}
/** The nearest water point to (x, y) within `maxPx` (searching outwards), or null. For launching new ships. */
/**
 * The nearest land to a point (a beach to put troops ashore), no further than maxKm, or null. On image maps (no
 * sea) the point itself.
 */
function nearestLand(lobby, x, y, maxKm) {
  const m = landMask(lobby);
  if (!m || landAt(lobby, x, y)) return { x, y };
  for (let rad = m.cell / 2; ; rad += m.cell / 2) {
    if (geo.distance(lobby, x, y, x + rad, y) > maxKm) return null;      // the ring's nearest side is out of reach
    let best = null;
    const n = Math.max(12, Math.round(rad * 1.6));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
      if (!landAt(lobby, px, py)) continue;
      const d = geo.distance(lobby, x, y, px, py);
      if (d <= maxKm && (!best || d < best.d)) best = { x: Math.round(px * 10) / 10, y: Math.round(py * 10) / 10, d };
    }
    if (best) return best;
  }
}
function nearestWater(lobby, x, y, maxPx = 80) {
  const m = landMask(lobby);
  if (!m) return { x, y };
  if (!landAt(lobby, x, y)) return { x, y };
  for (let rad = m.cell; rad <= maxPx; rad += m.cell) {
    const n = Math.max(8, Math.round(rad * 0.8));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
      if (!landAt(lobby, px, py)) return { x: Math.round(px * 10) / 10, y: Math.round(py * 10) / 10 };
    }
  }
  return null;
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
/**
 * Who owns the ground at a point, for either land model: (x, y) => factionId | 0 (neutral) | null (sea or
 * unclaimed). Provinces answer from a grid index; free-form territories by polygon tests. Null when the
 * campaign has neither.
 */
function ownerLookup(lobby) {
  if (provinces().has(lobby.id)) return (x, y) => provinces().ownerAt(lobby.id, x, y);
  const terrs = all(lobby.id);
  if (!terrs.length) return null;
  return (x, y) => ownerAt(terrs, x, y);
}

// ---- Seeding and GM tools -------------------------------------------------------------------
/**
 * Replace the lobby's territories with a historical year's states: each state (or its overlord for
 * colonies) goes to the faction of the same name; the rest becomes neutral.
 */
function seedFromYear(lobby, year, factions) {
  // With provinces, "the borders of that year" means the states the provinces were cut from.
  if (provinces().has(lobby.id)) return provinces().assignByState(lobby, factions);
  return { ...seedFreeForm(lobby, year, factions), owners: [] };
}
function seedFreeForm(lobby, year, factions) {
  const w = world(year);
  if (!w) throw new Error('No borders bundled for that year');
  const W = lobby.map_width, H = lobby.map_height;
  const groups = new Map();   // factionId -> polygons
  const assigned = [], unassigned = [];
  for (const c of w.countries) {
    // A faction takes every state whose power has its name under any alias ("British Empire" = "United Kingdom…").
    const f = c.power ? factions.find(x => Powers.same(x.name, c.power)) : null;
    const fid = f ? f.id : NEUTRAL;
    if (c.state) (fid === NEUTRAL ? unassigned : assigned).push(c.state);
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
/**
 * One faction's historical land, leaving every other border alone (docs/GAME-DESIGN.md §5.1): with provinces, the
 * provinces of those states or powers; without, the states' outlines of `year` carved out for it (from neutral
 * ground only when `onlyNeutral`). Returns { territories, owners, matched, taken }.
 */
function assignHistory(lobby, year, factionId, names, onlyNeutral, colonies = false) {
  if (provinces().has(lobby.id)) return { territories: [], ...provinces().assignHistory(lobby, factionId, names, onlyNeutral, colonies) };
  const w = world(year);
  if (!w) throw new Error('No borders bundled for that year');
  const W = lobby.map_width, H = lobby.map_height, want = (names || []).filter(Boolean);
  const isState = n => w.countries.some(c => Powers.same(n, c.state));
  const hit = w.countries.filter(c => want.some(n => Powers.same(n, c.state) || ((colonies || !isState(n)) && Powers.same(n, c.power))));
  if (!hit.length) return { territories: [], owners: [], matched: 0, taken: 0 };
  let multi = [];
  const polys = hit.flatMap(c => c.p.map(poly => poly.map(ring => ring.map(q => { const [x, y] = geo.project(q[0], q[1], W, H); return [r1(x), r1(y)]; }))));
  for (let i = 0; i < polys.length; i += 40) multi = pc.union(multi, polys.slice(i, i + 40));
  if (onlyNeutral) {
    const held = all(lobby.id).filter(t => t.factionId && t.factionId !== factionId).map(t => t.geometry).filter(g => g && g.length);
    for (const g of held) multi = pc.difference(multi, g);
  }
  const territories = carve(lobby.id, factionId, multi);
  return { territories, owners: [], matched: hit.length, taken: territories.length ? hit.length : 0 };
}
/** Names a faction can take its land from: the states and powers of the provinces, or of the year's map. */
function historyNames(lobby, year) {
  if (provinces().has(lobby.id)) return provinces().historyNames(lobby);
  const w = world(year);
  if (!w) return [];
  const names = new Set();
  for (const c of w.countries) for (const n of [c.state, c.power]) if (n) names.add(n);
  return [...names].sort((a, b) => a.localeCompare(b)).map(name => ({ name }));
}
function assignArea(lobby, factionId, points) {
  const ring = points.map(p => [r1(p[0]), r1(p[1])]);
  if (provinces().has(lobby.id)) {
    const ids = provinces().list(lobby.id).filter(p => pointInMulti(p.cx, p.cy, [[ring]])).map(p => p.id);
    return { territories: [], owners: provinces().give(lobby, ids, factionId) };
  }
  return { territories: carve(lobby.id, factionId, landClip(lobby, [[ring]])), owners: [] };
}
/** Brush: provinces whose centre is within km (0 = the clicked province) when provinces exist, else a circle. */
function brush(lobby, factionId, x, y, km) {
  if (provinces().has(lobby.id)) return { territories: [], owners: provinces().give(lobby, provinces().within(lobby, x, y, km).map(p => p.id), factionId) };
  return { territories: carve(lobby.id, factionId, landClip(lobby, circle(lobby, x, y, km))), owners: [] };
}

/**
 * Markers that follow territory ownership: resource nodes, factories and towns take the faction that owns
 * the ground under them. Returns [{ marker, nation }] for the ones whose nation should change.
 */
function ownershipChanges(lookup, factions, markers, lobby) {
  const byId = new Map(factions.map(f => [f.id, f]));
  const out = [];
  if (!lookup) return out;
  for (const m of markers) {
    if (!['resource', 'factory', 'town'].includes(m.type)) continue;
    let owner = lookup(m.x, m.y);
    // A port a little offshore on the coastline data takes the owner of the nearest province.
    if (owner === null && lobby && provinces().has(lobby.id)) owner = provinces().nearestOwner(lobby, m.x, m.y);
    if (owner === null) continue;                       // sea or unclaimed: leave as is
    const nation = owner === NEUTRAL ? '' : (byId.get(owner)?.name || '');
    if (String(m.data?.nation || '').toLowerCase() !== nation.toLowerCase()) out.push({ marker: m, nation });
  }
  return out;
}

/** A trench belongs to the faction whose territory most of its centreline lies in ('' when unowned). */
function trenchOwner(lookup, factions, shape) {
  const byId = new Map(factions.map(f => [f.id, f]));
  const votes = new Map();
  if (!lookup) return '';
  for (const p of shape.points || []) {
    const o = lookup(p[0], p[1]);
    if (o === null) continue;
    votes.set(o, (votes.get(o) || 0) + 1);
  }
  let best = null, n = 0;
  for (const [o, c] of votes) if (c > n) { n = c; best = o; }
  if (best === null || best === NEUTRAL) return '';
  return byId.get(best)?.name || '';
}
/** Trenches whose owner should change with the territory under them. */
function trenchOwnershipChanges(lookup, factions, shapes) {
  const out = [];
  if (!lookup) return out;
  for (const s of shapes) {
    if (s.kind !== 'trench') continue;
    const nation = trenchOwner(lookup, factions, s);
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
  if (m.type !== 'unit' || m.data?.aboard) return false;   // aboard a convoy: at sea, not holding or taking ground
  const t = UnitTypes.resolve(m.data?.unitType);
  return t ? LAND_CATEGORIES.has(t.cat) : true;   // unknown custom types count as land
}

/**
 * The capture rule after a land unit's committed move (§5.2). `relation(a, b)` returns peace|war|alliance.
 * Returns null when nothing happens, else { changed: territories, flips: [{marker, nation}], cities: [names], held }.
 * Defended ground does not fall: a province (or, without provinces, the ground within the capture radius) with a
 * defender in it stays with its owner until the defenders are beaten. Landing in one, the front holds.
 */
function capture(lobby, g, unit, factions, markers, relation) {
  if (!g.enabled || !isLandUnit(unit) || Number(unit.data?.strength ?? 100) <= 0) return null;
  const mine = factions.find(f => f.name.toLowerCase() === String(unit.data?.nation || '').toLowerCase());
  if (!mine) return null;
  const lookup = ownerLookup(lobby);
  if (!lookup) return null;
  const owner = lookup(unit.x, unit.y);
  if (owner === null || owner === mine.id) return null;
  if (owner === NEUTRAL) { if (!g.settings.occupyNeutrals) return null; }
  else if (relation(mine.id, owner) !== 'war') return null;
  const s = g.settings;
  const radius = Number(s.captureRadiusKm) || 30;
  const ownerName = owner === NEUTRAL ? '' : (factions.find(f => f.id === owner)?.name || '').toLowerCase();
  // Defenders: living land units of the ground's owner, or of anyone at war with the mover (the owner's allies in the war).
  const isDefender = m => {
    if (m.id === unit.id || !isLandUnit(m) || Number(m.data?.strength ?? 100) <= 0 || m.data?.surrendered) return false;
    const n = String(m.data?.nation || '').toLowerCase();
    if (!n || n === mine.name.toLowerCase()) return false;
    if (ownerName && n === ownerName) return true;
    const f = factions.find(x => x.name.toLowerCase() === n);
    return !!f && relation(mine.id, f.id) === 'war';
  };
  const defenders = markers.filter(isDefender);
  const held = { held: true, changed: [], owners: [], flips: [], cities: [], owner, mine };
  // Contested ground: a defender within the radius holds the front.
  if (defenders.some(m => geo.distance(lobby, unit.x, unit.y, m.x, m.y) <= radius)) return held;
  const pv = provinces().has(lobby.id) ? provinces() : null;
  // Provinces with a defender anywhere in them (province maps).
  const defended = new Set();
  if (pv) for (const m of defenders) { const p = pv.at(lobby.id, m.x, m.y); if (p) defended.add(p.id); }
  const landing = pv ? pv.at(lobby.id, unit.x, unit.y) : null;
  if (landing && defended.has(landing.id)) return held;
  // A defended city does not fall, nor bring its surroundings with it.
  const cityDefended = m => pv ? (() => { const p = pv.at(lobby.id, m.x, m.y); return !!p && defended.has(p.id); })()
    : defenders.some(d => geo.distance(lobby, m.x, m.y, d.x, d.y) <= radius);
  const cities = [];
  const enemyCities = markers.filter(m => m.type === 'town' && ['city', 'capital'].includes(m.data?.size) &&
    String(m.data?.nation || '').toLowerCase() === ownerName && String(m.data?.nation || '').toLowerCase() !== mine.name.toLowerCase() &&
    geo.distance(lobby, unit.x, unit.y, m.x, m.y) <= radius && !cityDefended(m));
  let changed = [], owners = [];
  if (pv) {
    // Province rule: the province under the unit and the owner's provinces whose centre is within the
    // capture radius; an enemy city inside adds the owner's provinces within the city radius. Defended ones stay.
    const theirs = p => p.factionId === owner && !defended.has(p.id);
    const ids = new Set(pv.within(lobby, unit.x, unit.y, radius, theirs).map(p => p.id));
    if (landing && theirs(landing)) ids.add(landing.id);
    for (const m of enemyCities) { for (const p of pv.within(lobby, m.x, m.y, Number(s.cityRadiusKm) || 75, theirs)) ids.add(p.id); cities.push(m); }
    owners = pv.give(lobby, [...ids], mine.id);
  } else {
    let multi = circle(lobby, unit.x, unit.y, radius);
    for (const m of enemyCities) { multi = pc.union(multi, circle(lobby, m.x, m.y, Number(s.cityRadiusKm) || 75)); cities.push(m); }
    // Ground within the capture radius of a defender stays with its owner.
    const reach = radius + (enemyCities.length ? (Number(s.cityRadiusKm) || 75) * 2 : 0) + radius;
    for (const d of defenders) if (geo.distance(lobby, unit.x, unit.y, d.x, d.y) <= reach) multi = pc.difference(multi, circle(lobby, d.x, d.y, radius));
    changed = carve(lobby.id, mine.id, landClip(lobby, multi));
  }
  const flips = ownershipChanges(ownerLookup(lobby), factions, markers, lobby).filter(f => f.nation.toLowerCase() === mine.name.toLowerCase());
  return { held: false, changed, owners, flips, cities: cities.map(c => c.name), owner, mine };
}

module.exports = { assignHistory, historyNames, landMask, landAt, nearWater, shipCourseError, nearestWater, nearestLand, NEUTRAL, all, write, clear, carve, circle, landClip, ownerAt, seedFromYear, assignArea, brush, ownershipChanges, capture, isLandUnit, earthYears, clean,
  trenchOwner, trenchOwnershipChanges, trenchCover, distanceToPath, isLand, isCoastal, landFor, lakesFor, loadGz, world, bboxOf, pointInMulti, overlaps, ownerLookup };
