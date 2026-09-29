'use strict';
/**
 * Provinces (docs/GAME-DESIGN.md §5.1): the land of the Earth map cut into pieces about `sizeKm` across that
 * follow the state borders of a seed year and the Natural Earth coastline. Ownership lives per province;
 * the faction territories in territory.js are derived from the provinces a faction holds, so rendering,
 * ownerAt, trench ownership, income and undo keep working on top of them.
 *
 * Generation: Voronoi cells around jittered seeds (about one per province, plus one per major city), each
 * clipped to land and cut along the seed's state border. Land the coarse historical borders miss (coastal
 * slivers, islands nobody owned) goes to the nearest cell so every bit of land belongs to exactly one
 * province. Tiny fragments merge into their neighbour; provinces are named after the city inside them or
 * the nearest one ("Reims NE").
 */
const fs = require('node:fs');
const path = require('node:path');
const pc = require('polygon-clipping');
const { Delaunay } = require('d3-delaunay');
const { db, now } = require('./db');
const config = require('./config');
const access = require('./lobbyAccess');
const geo = require('./geo');
const territory = require('./territory');
const Powers = require('../public/js/powers');

const q = {
  all: db.prepare('SELECT * FROM provinces WHERE lobby_id = ? ORDER BY id'),
  count: db.prepare('SELECT COUNT(*) AS n FROM provinces WHERE lobby_id = ?'),
  clear: db.prepare('DELETE FROM provinces WHERE lobby_id = ?'),
  insert: db.prepare('INSERT INTO provinces (lobby_id, name, state, subject, cx, cy, faction_id, geometry, updated_at, year) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  setOwner: db.prepare('UPDATE provinces SET faction_id = ?, updated_at = ? WHERE id = ? AND lobby_id = ?'),
  owners: db.prepare('SELECT id, faction_id FROM provinces WHERE lobby_id = ?'),
};

/** Province edges are shared exactly between neighbours: territories built from them must not be simplified away. */
const CLEAN = { tol: 0.05, minArea: 0.5 };
const r1 = n => Math.round(n * 10) / 10;
const tick = () => new Promise(r => setImmediate(r));
const { bboxOf, pointInMulti, overlaps } = territory;
const inBbox = (x, y, b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}
function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}
/** Centre of a multipolygon: the centroid of its largest outer ring. */
function centreOf(multi) {
  let best = null, ba = -1;
  for (const poly of multi) { const a = ringArea(poly[0]); if (a > ba) { ba = a; best = poly[0]; } }
  return best ? centroid(best) : [0, 0];
}
function areaOf(multi) {
  let a = 0;
  for (const poly of multi) { a += ringArea(poly[0]); for (let i = 1; i < poly.length; i++) a -= ringArea(poly[i]); }
  return a;
}
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
function unionAll(multis) {
  let acc = [];
  for (let i = 0; i < multis.length; i += 300) acc = pc.union(acc, ...multis.slice(i, i + 300));
  return acc;
}
function roundMulti(multi, k = 10) { return multi.map(poly => poly.map(ring => ring.map(p => [Math.round(p[0] * k) / k, Math.round(p[1] * k) / k]))); }
/**
 * polygon-clipping occasionally throws on near-degenerate input ("Unable to find segment"). Retry with
 * rounded, then slightly shifted, coordinates before falling back to the caller's guess.
 */
let clipFailures = 0;
function clip(kind, a, b, fallback) {
  const f = pc[kind];
  try { return f(a, b); } catch { /* retry */ }
  try { return f(roundMulti(a), roundMulti(b)); } catch { /* retry */ }
  try { return f(a.map(poly => poly.map(ring => ring.map(p => [p[0] + 0.0137, p[1] + 0.0071]))), roundMulti(b)); } catch { /* give up */ }
  clipFailures++;
  return fallback();
}

// ---- Cache and storage -----------------------------------------------------------------------
const cache = new Map();   // lobbyId -> { list, byId }
function serialize(row) {
  return { id: row.id, name: row.name, state: row.state, subject: row.subject, year: row.year || 1914, cx: row.cx, cy: row.cy, factionId: row.faction_id, geometry: access.safeJson(row.geometry) || [] };
}
const GRID = 32;   // map px per index cell (provinces are ~20 px across on the default Earth map)
function get(lobbyId) {
  if (!cache.has(lobbyId)) {
    const list = q.all.all(lobbyId).map(r => { const p = serialize(r); p.bbox = bboxOf(p.geometry); return p; });
    // Grid index: every cell a province's bbox touches lists it, so a point lookup tests only a handful.
    const grid = new Map();
    for (const p of list) {
      for (let gx = Math.floor(p.bbox[0] / GRID); gx <= Math.floor(p.bbox[2] / GRID); gx++)
        for (let gy = Math.floor(p.bbox[1] / GRID); gy <= Math.floor(p.bbox[3] / GRID); gy++) {
          const k = gx * 100000 + gy;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(p);
        }
    }
    cache.set(lobbyId, { list, byId: new Map(list.map(p => [p.id, p])), grid });
  }
  return cache.get(lobbyId);
}
function invalidate(lobbyId) { cache.delete(lobbyId); }
function count(lobbyId) { return q.count.get(lobbyId).n; }
function has(lobbyId) { return count(lobbyId) > 0; }
function list(lobbyId) { return get(lobbyId).list; }
/** The province under a map point, or null (sea). */
function at(lobbyId, x, y) {
  const cell = get(lobbyId).grid.get(Math.floor(x / GRID) * 100000 + Math.floor(y / GRID));
  for (const p of cell || []) {
    if (!inBbox(x, y, p.bbox)) continue;
    if (pointInMulti(x, y, p.geometry)) return p;
  }
  return null;
}
/** Faction owning the ground at a point (0 = neutral), or null at sea. */
function ownerAt(lobbyId, x, y) { const p = at(lobbyId, x, y); return p ? p.factionId : null; }
/** Provinces whose centre lies within `km` of a point (km = 0: just the province under the point). */
function within(lobby, x, y, km, filter = null) {
  if (!(km > 0)) { const p = at(lobby.id, x, y); return p && (!filter || filter(p)) ? [p] : []; }
  return get(lobby.id).list.filter(p => (!filter || filter(p)) && geo.distance(lobby, x, y, p.cx, p.cy) <= km);
}
function setOwner(lobbyId, ids, factionId) {
  const t = now(), c = get(lobbyId);
  for (const id of ids) { q.setOwner.run(factionId, t, id, lobbyId); const p = c.byId.get(id); if (p) p.factionId = factionId; }
}
function ownership(lobbyId) { return q.owners.all(lobbyId).map(r => [r.id, r.faction_id]); }
function restoreOwnership(lobbyId, pairs) {
  const t = now();
  for (const [id, f] of pairs || []) q.setOwner.run(f, t, id, lobbyId);
  invalidate(lobbyId);
}
function clear(lobbyId) { q.clear.run(lobbyId); invalidate(lobbyId); }

/**
 * Hand provinces to a faction (NEUTRAL = 0). Ownership is the province table itself: clients recolour the
 * provinces from the returned [[id, factionId], ...] pairs, so no faction polygons are rebuilt (that used to cost
 * seconds per brush stroke on a world map).
 */
function give(lobby, ids, factionId) {
  const c = get(lobby.id);
  const provs = ids.map(id => c.byId.get(id)).filter(p => p && p.factionId !== factionId);
  if (!provs.length) return [];
  db.exec('BEGIN');
  try { setOwner(lobby.id, provs.map(p => p.id), factionId); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  return provs.map(p => [p.id, factionId]);
}
/** Assign every province to the faction named like its state (or its state's overlord); the rest is neutral. */
function assignByState(lobby, factions) {
  const lobbyId = lobby.id;
  const assigned = new Set(), unassigned = new Set();
  const byFaction = new Map(), memo = new Map();
  const list = get(lobbyId).list;
  // Provinces cut before stateless coastal land adopted a state: borrow the nearest province that has one.
  const stated = list.filter(p => p.state);
  const pxY = 150 * lobby.map_height / 20037;
  const stateOf = p => {
    if (p.state || !stated.length) return p;
    let best = null, bd = 150;
    for (const o of stated) {
      if (Math.abs(o.cy - p.cy) > pxY) continue;
      const d = geo.distance(lobby, p.cx, p.cy, o.cx, o.cy);
      if (d < bd) { bd = d; best = o; }
    }
    return best || p;
  };
  for (const p0 of list) {
    const p = stateOf(p0);
    // The province's power: the holdings table first (fixes rows cut before it existed), then the stored overlord,
    // then the state itself; matched to a faction under any of its names ("British Empire" = "United Kingdom…").
    const key = `${p.year}|${p.state}|${p.subject}`;
    if (!memo.has(key)) {
      const power = p.state ? Powers.display(Powers.overlordOf(p.year, p.state, p.subject) || p.state) : '';
      memo.set(key, power ? (factions.find(f => Powers.same(f.name, power))?.id ?? 0) : 0);
    }
    const fid = memo.get(key);
    if (p.state) (fid ? assigned : unassigned).add(p.state);
    const p1 = p0;
    if (!byFaction.has(fid)) byFaction.set(fid, []);
    byFaction.get(fid).push(p1.id);
  }
  db.exec('BEGIN');
  try { for (const [fid, ids] of byFaction) setOwner(lobbyId, ids, fid); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  territory.clear(lobbyId);   // free-form territories are not used once a campaign has provinces
  return { owners: ownership(lobbyId), replace: true, territories: [], assigned: [...assigned], unassigned: [...unassigned] };
}

/**
 * The historical state outlines are coarser than the coastline, so land along the coast (and most port cities,
 * which sit right on it) often lies outside every state. Such a seed takes the state of the nearest seed that has
 * one, if that seed is within maxKm; land far from any state (remote islands nobody claimed) stays stateless.
 */
function adoptNearestState(lobby, seeds, maxKm) {
  const W = lobby.map_width;
  const cell = Math.max(4, maxKm * W / 40075);        // grid cell ≈ maxKm at the equator, in map px
  const grid = new Map();
  for (const s of seeds) {
    if (s.state < 0) continue;
    const k = `${Math.floor(s.x / cell)},${Math.floor(s.y / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  for (const s of seeds) {
    if (s.state >= 0) continue;
    const [, lat] = geo.unproject(s.x, s.y, lobby.map_width, lobby.map_height);
    const rx = Math.min(12, Math.ceil(1 / Math.max(0.1, Math.cos(lat * Math.PI / 180))));   // a km spans more px east-west near the poles
    const gx = Math.floor(s.x / cell), gy = Math.floor(s.y / cell);
    let best = null, bd = maxKm;
    for (let dx = -rx; dx <= rx; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const o of grid.get(`${gx + dx},${gy + dy}`) || []) {
        const d = geo.distance(lobby, s.x, s.y, o.x, o.y);
        if (d < bd) { bd = d; best = o; }
      }
    }
    if (best) s.state = best.state;
  }
}

/**
 * Owner of the province nearest to a point no province contains (a port city a little offshore on the coastline
 * data): the faction id (0 = neutral), or null when there are no provinces or none within maxKm.
 */
function nearestOwner(lobby, x, y, maxKm = 80) {
  const list = get(lobby.id).list;
  if (!list.length) return null;
  const pxY = maxKm * lobby.map_height / 20037;            // km → px north-south
  let best = null, bd = maxKm;
  for (const p of list) {
    if (Math.abs(p.cy - y) > pxY * 1.5) continue;
    const d = geo.distance(lobby, x, y, p.cx, p.cy);
    if (d < bd) { bd = d; best = p; }
  }
  return best ? best.factionId : null;
}

// ---- Land tiles: the coastline chopped into a grid so clipping a small cell stays cheap -------------------
const tileCache = new Map();
function landTiles(lobby) {
  const W = lobby.map_width, H = lobby.map_height, key = `${W}x${H}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const land = territory.landFor(lobby);
  const nx = 24, ny = 12, tw = W / nx, th = H / ny;
  const tiles = [];
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const x0 = r1(ix * tw), y0 = r1(iy * th), x1 = r1((ix + 1) * tw), y1 = r1((iy + 1) * th);
    const bbox = [x0, y0, x1, y1];
    const cand = land.filter(l => overlaps(l.bbox, bbox)).map(l => l.poly);
    if (!cand.length) continue;
    const multi = roundMulti(pc.intersection([[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]], cand));
    if (!multi.length) continue;
    tiles.push({ bbox, multi, full: areaOf(multi) >= (x1 - x0) * (y1 - y0) * 0.9995 });
  }
  tileCache.set(key, tiles);
  return tiles;
}

// ---- Generation ------------------------------------------------------------------------------
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const ROMAN = ['', '', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];

/**
 * Cut the Earth into provinces for a lobby. `progress(text, done, total)` is called as it goes (it takes
 * a minute or two for the whole world). Replaces existing provinces and territories.
 */
async function generate(lobby, opts = {}, progress = () => {}) {
  if (!geo.isEarth(lobby)) throw new Error('Provinces need the Earth map');
  const year = Number(opts.year) || 1914;
  const sizeKm = Math.max(40, Math.min(400, Number(opts.sizeKm) || 100));
  const world = territory.world(year);   // ownership resolved: public/js/powers.js
  if (!world) throw new Error('No borders bundled for that year');
  const W = lobby.map_width, H = lobby.map_height;
  const P = (lon, lat) => { const [x, y] = geo.project(lon, lat, W, H); return [r1(x), r1(y)]; };
  const rand = mulberry32(year * 7919 + Math.round(sizeKm) * 31 + 12345);

  progress('Preparing the coastline…', 0, 1);
  await tick();
  const tiles = landTiles(lobby);
  const tilesAt = bb => tiles.filter(t => overlaps(t.bbox, bb));
  const onLand = (x, y) => tiles.some(t => inBbox(x, y, t.bbox) && (t.full || pointInMulti(x, y, t.multi)));

  // States of the seed year in map pixels.
  const states = world.countries.map((c, i) => {
    const multi = c.p.map(poly => poly.map(ring => ring.map(p => P(p[0], p[1]))));
    return { i, name: c.state, subject: c.power && !Powers.same(c.power, c.state) ? c.power : '', multi, bbox: bboxOf(multi) };
  });
  const stateAt = (x, y) => { for (const s of states) if (inBbox(x, y, s.bbox) && pointInMulti(x, y, s.multi)) return s.i; return -1; };

  // Seeds: a jittered grid about sizeKm apart inside every state, one at least, plus every major city.
  progress('Placing seeds…', 0, 1);
  await tick();
  const seeds = [];
  const degLat = sizeKm / 111.32;
  const gridSeeds = (latMin, latMax, lonMin, lonMax, keep) => {
    for (let lat = latMin + degLat / 2; lat < latMax; lat += degLat) {
      const degLon = degLat / Math.max(0.15, Math.cos(lat * Math.PI / 180));
      for (let lon = lonMin + degLon / 2; lon < lonMax; lon += degLon) {
        const [x, y] = P(lon + (rand() - 0.5) * 0.7 * degLon, lat + (rand() - 0.5) * 0.7 * degLat);
        const st = keep(x, y);
        if (st !== null) seeds.push({ x, y, state: st, city: '' });
      }
    }
  };
  for (const s of states) {
    const [lonMin, latMax] = geo.unproject(s.bbox[0], s.bbox[1], W, H);
    const [lonMax, latMin] = geo.unproject(s.bbox[2], s.bbox[3], W, H);
    const before = seeds.length;
    gridSeeds(latMin, latMax, lonMin, lonMax, (x, y) => pointInMulti(x, y, s.multi) && onLand(x, y) ? s.i : null);
    if (seeds.length === before) { const c = centreOf(s.multi); seeds.push({ x: r1(c[0]), y: r1(c[1]), state: s.i, city: '' }); }
  }
  // Land no state of that year claims (Antarctica is skipped): its own neutral provinces.
  gridSeeds(-60, 84, -180, 180, (x, y) => onLand(x, y) && stateAt(x, y) < 0 ? -1 : null);
  // Cities become seeds of their own so a province carries the city's name and its district.
  let cities = [];
  try { cities = JSON.parse(fs.readFileSync(path.join(config.root, 'public', 'earth', 'cities.json'), 'utf8')).cities || []; } catch { /* no cities bundled */ }
  const cityPts = cities.map(c => { const [x, y] = P(c.lon, c.lat); return { name: c.n, x, y, cap: c.cap ? 1 : 0, ind: Number(c.ind) || 0 }; });
  for (const c of cityPts) {
    if (!onLand(c.x, c.y)) continue;
    const near = sizeKm * 0.45;
    for (let i = seeds.length - 1; i >= 0; i--) if (!seeds[i].city && geo.distance(lobby, c.x, c.y, seeds[i].x, seeds[i].y) < near) seeds.splice(i, 1);
    seeds.push({ x: c.x, y: c.y, state: stateAt(c.x, c.y), city: c.name });
  }
  adoptNearestState(lobby, seeds, Math.max(150, sizeKm * 1.5));

  // Voronoi cells, clipped to land and cut along state borders.
  const pts = new Float64Array(seeds.length * 2);
  seeds.forEach((s, i) => { pts[i * 2] = s.x; pts[i * 2 + 1] = s.y; });
  const voronoi = new Delaunay(pts).voronoi([0, 0, W, H]);
  const provs = new Array(seeds.length).fill(null);
  const orphans = [];
  const seedsOfState = new Map();
  seeds.forEach((s, i) => { if (!seedsOfState.has(s.state)) seedsOfState.set(s.state, []); seedsOfState.get(s.state).push(i); });
  for (let i = 0; i < seeds.length; i++) {
    if (i % 100 === 0) { progress('Cutting provinces…', i, seeds.length); await tick(); }
    const cell = voronoi.cellPolygon(i);
    if (!cell || cell.length < 4) continue;
    const ring = cell.map(p => [r1(p[0]), r1(p[1])]);
    const cellMulti = [[ring]], bb = bboxOf(cellMulti);
    const tl = tilesAt(bb);
    if (!tl.length) continue;
    const s = seeds[i];
    const A = tl.every(t => t.full) ? cellMulti : clip('intersection', cellMulti, tl.flatMap(t => t.multi), () => onLand(s.x, s.y) ? cellMulti : []);
    if (!A.length) continue;
    const own = s.state >= 0 ? states[s.state] : null;
    const others = states.filter(st => st !== own && overlaps(st.bbox, bb));
    let prov;
    if (own && !others.length && ring.every(p => pointInMulti(p[0], p[1], own.multi))) prov = A;   // interior cell: nothing to cut
    else {
      let rest = A;
      if (own) { prov = clip('intersection', A, own.multi, () => A); rest = clip('difference', A, own.multi, () => []); } else prov = [];
      for (const st of others) {
        if (!rest.length) break;
        const piece = clip('intersection', rest, st.multi, () => []);
        if (piece.length) { orphans.push({ piece, state: st.i }); rest = clip('difference', rest, st.multi, () => []); }
      }
      // Land outside every state (coastal slivers the coarse borders miss) stays with this cell.
      prov = prov.length ? (rest.length ? clip('union', prov, rest, () => prov) : prov) : rest;
    }
    if (prov.length) provs[i] = prov;
  }
  // Pieces of a cell that lie in another state go to that state's nearest seed, so borders stay exact.
  progress('Settling borders…', 0, 1);
  await tick();
  for (const o of orphans) {
    const c = centreOf(o.piece);
    let best = -1, bd = Infinity;
    for (const j of seedsOfState.get(o.state) || []) { const d = (seeds[j].x - c[0]) ** 2 + (seeds[j].y - c[1]) ** 2; if (d < bd) { bd = d; best = j; } }
    if (best < 0) continue;
    provs[best] = provs[best] ? clip('union', provs[best], o.piece, () => provs[best]) : o.piece;
  }
  // Fragments far smaller than a province merge into the nearest province of the same state.
  const kmPerPxY = 111.32 * 180 / H;
  const areaKm2 = (multi, cy) => { const [, lat] = geo.unproject(0, cy, W, H); return areaOf(multi) * kmPerPxY * (111.32 * Math.cos(lat * Math.PI / 180) * 360 / W); };
  const tiny = sizeKm * sizeKm * 0.12;
  for (let i = 0; i < provs.length; i++) {
    if (!provs[i] || seeds[i].city) continue;
    const c = centreOf(provs[i]);
    if (areaKm2(provs[i], c[1]) >= tiny) continue;
    let best = -1, bd = Infinity;
    for (const j of seedsOfState.get(seeds[i].state) || []) {
      if (j === i || !provs[j]) continue;
      const d = (seeds[j].x - c[0]) ** 2 + (seeds[j].y - c[1]) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    if (best < 0) continue;
    provs[best] = clip('union', provs[best], provs[i], () => provs[best]);
    provs[i] = null;
  }

  // Names: the city inside, else the nearest city with a compass direction; made unique per campaign.
  progress('Naming and saving…', 0, 1);
  await tick();
  const used = new Map();
  const rows = [];
  for (let i = 0; i < provs.length; i++) {
    const multi = territory.clean(provs[i], CLEAN.tol, CLEAN.minArea);
    if (!multi.length) continue;
    const c = centreOf(multi), bb = bboxOf(multi);
    const inside = cityPts.filter(ct => inBbox(ct.x, ct.y, bb) && pointInMulti(ct.x, ct.y, multi)).sort((a, b) => b.cap - a.cap || b.ind - a.ind);
    let name;
    if (inside.length) name = inside[0].name;
    else {
      let best = null, bd = Infinity;
      for (const ct of cityPts) { const d = (ct.x - c[0]) ** 2 + (ct.y - c[1]) ** 2; if (d < bd) { bd = d; best = ct; } }
      if (best) {
        const ang = Math.atan2(-(c[1] - best.y), c[0] - best.x);   // y grows downward
        const dir = COMPASS[((Math.round((Math.PI / 2 - ang) / (Math.PI / 4)) % 8) + 8) % 8];
        name = `${best.name} ${dir}`;
      } else name = 'Province';
    }
    const n = (used.get(name) || 0) + 1; used.set(name, n);
    if (n > 1) name = `${name} ${ROMAN[Math.min(n, ROMAN.length - 1)]}`;
    const st = seeds[i].state >= 0 ? states[seeds[i].state] : null;
    rows.push({ name: name.slice(0, 60), state: st ? st.name : '', subject: st ? st.subject : '', cx: r1(c[0]), cy: r1(c[1]), geometry: multi });
  }
  db.exec('BEGIN');
  try {
    q.clear.run(lobby.id);
    const t = now();
    for (const r of rows) q.insert.run(lobby.id, r.name, r.state, r.subject, r.cx, r.cy, 0, JSON.stringify(r.geometry), t, year);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  invalidate(lobby.id);
  if (clipFailures) console.warn(`province generation: ${clipFailures} clip operations fell back to a guess`);
  clipFailures = 0;
  return { count: rows.length, year, sizeKm, seeds: seeds.length };
}

module.exports = { CLEAN, nearestOwner, ownerAt, get, list, count, has, at, within, setOwner, ownership, restoreOwnership, clear, give, assignByState, generate, invalidate, unionAll, landTiles };
