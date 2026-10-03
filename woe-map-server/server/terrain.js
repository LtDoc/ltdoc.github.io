'use strict';
/**
 * Hills and mountains on the server (docs/TERRAIN.md): the Earth elevation grid (public/js/terrain.js) and the
 * Hills / Mountains areas a GM paints (area shapes with data.terrain), on any map. Where both apply the higher
 * ground counts. Everything here is off when the campaign rule `terrain` is false.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { db } = require('./db');
const access = require('./lobbyAccess');
const geo = require('./geo');
const Terrain = require('../public/js/terrain');
const UnitTypes = require('../public/js/units');

const { FLAT, HILLS, MOUNTAINS } = Terrain;
const q = {
  painted: db.prepare(`SELECT id, points, data, updated_at FROM shapes WHERE lobby_id = ? AND kind = 'area'
    AND json_extract(data, '$.terrain') IN ('hills', 'mountains')`),
};
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

let grid = null;
/** The Earth grid, read and classified on first use (about half a second). */
function earthGrid() {
  if (grid) return grid;
  try {
    grid = Terrain.decode(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'public', 'earth', 'terrain.bin.gz'))));
    Terrain.classify(grid);
  } catch (e) { console.warn('terrain: no elevation grid', e.message); grid = false; }
  return grid;
}

const paintedCache = new Map();   // lobbyId -> { key, list }
/** The lobby's painted Hills / Mountains areas with bounding boxes. */
function painted(lobbyId) {
  const rows = q.painted.all(lobbyId);
  const key = rows.map(r => `${r.id}:${r.updated_at}`).join(',');
  const hit = paintedCache.get(lobbyId);
  if (hit && hit.key === key) return hit.list;
  const list = rows.map(r => {
    const p = access.safeJson(r.points), d = access.safeJson(r.data) || {};
    if (!Array.isArray(p) || p.length < 3) return null;
    const xs = p.map(v => v[0]), ys = p.map(v => v[1]);
    return { p, cls: d.terrain === 'mountains' ? MOUNTAINS : HILLS, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }).filter(Boolean);
  paintedCache.set(lobbyId, { key, list });
  return list;
}
function inside(b, x, y) {
  if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) return false;
  let c = false;
  for (let i = 0, j = b.p.length - 1; i < b.p.length; j = i++) {
    const [xi, yi] = b.p[i], [xj, yj] = b.p[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Is the terrain rule on for this campaign (game settings)? */
function enabled(settings) { return !settings || settings.terrain !== false; }

/**
 * A lookup for one lobby: { any, classAt(x, y), heightAt(x, y) (metres; null off the Earth grid), earth }.
 * `any` is false when the map has no terrain at all (an image map with nothing painted).
 */
function lookup(lobby) {
  const earth = geo.isEarth(lobby) ? earthGrid() : null;
  const areas = painted(lobby.id);
  const W = lobby.map_width, H = lobby.map_height;
  const paintedAt = (x, y) => { let c = FLAT; for (const b of areas) if (b.cls > c && inside(b, x, y)) c = b.cls; return c; };
  return {
    any: !!earth || areas.length > 0,
    earth: earth || null,
    areas,
    classAt(x, y) {
      const e = earth ? earth.cls[Terrain.cell(earth, x, y, W, H)] : FLAT;
      return areas.length && e < MOUNTAINS ? Math.max(e, paintedAt(x, y)) : e;
    },
    earthClassAt(x, y) { return earth ? earth.cls[Terrain.cell(earth, x, y, W, H)] : FLAT; },
    paintedAt: (x, y) => (areas.length ? paintedAt(x, y) : FLAT),
    heightAt(x, y) { return earth ? Terrain.heightAt(earth, x, y, W, H) : null; },
  };
}
function classAt(lobby, x, y) { return lookup(lobby).classAt(x, y); }

/** How a unit type fares on rough ground: 'mountain' (mountain troops), 'blocked' (tanks, artillery) or 'normal'. */
function moveKind(marker) {
  if (marker.type === 'hero') return 'normal';
  const t = UnitTypes.resolve(marker.data?.unitType);
  if (!t) return 'normal';
  if (t.id === 'mountain') return 'mountain';
  if (t.id === 'tank' || t.cat === 'Artillery') return 'blocked';
  return 'normal';
}
/** Movement cost multiplier of a ground class for a kind of unit (Infinity: may not enter). */
function moveMult(settings, kind, cls) {
  const s = settings || {};
  if (cls === HILLS) return kind === 'mountain' ? 1 : Math.max(1, num(s.hillsMoveCost, 1.5));
  if (cls === MOUNTAINS) {
    if (kind === 'blocked') return Infinity;
    return kind === 'mountain' ? Math.max(1, num(s.mountainTroopsCost, 1)) : Math.max(1, num(s.mountainMoveCost, 4));
  }
  return 1;
}

/**
 * The defender's edge from higher ground (docs/TERRAIN.md): each class's value (flat 0, hills settings.hillsDefend,
 * mountains settings.mountainsDefend) at the defender's position minus the value at the attacker's, when positive.
 * Attacking downhill brings nothing extra. Not for aircraft (attacking or attacked) or ships attacked at sea; a ship
 * attacking from the sea stands on flat ground. Returns { bonus, text } (bonus 0 when there is none).
 */
function heightBonus(lobby, settings, attacker, defender) {
  const none = { bonus: 0, text: '' };
  if (!enabled(settings)) return none;
  const tA = UnitTypes.resolve(attacker.data?.unitType), tD = UnitTypes.resolve(defender.data?.unitType);
  if (tA?.cat === 'Air' || tD?.cat === 'Air' || tD?.cat === 'Naval') return none;
  const look = lookup(lobby);
  if (!look.any) return none;
  const s = settings || {};
  const value = c => (c === MOUNTAINS ? num(s.mountainsDefend, 2) : c === HILLS ? num(s.hillsDefend, 1) : 0);
  const cD = look.classAt(defender.x, defender.y), cA = tA?.cat === 'Naval' ? FLAT : look.classAt(attacker.x, attacker.y);
  const bonus = Math.round((value(cD) - value(cA)) * 10) / 10;
  if (bonus <= 0) return none;
  return { bonus, text: `defender +${bonus} on higher ground (${Terrain.NAMES[cD]} above ${Terrain.NAMES[cA]})` };
}

/** Km of mountains along the straight line (x0, y0) → (x1, y1), sampled every 0.75 map px (half an Earth grid cell). */
function mountainKm(lobby, look, x0, y0, x1, y1) {
  if (!look.any) return 0;
  const n = Math.max(1, Math.min(4000, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.75)));
  let m = 0;
  for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; if (look.classAt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t) === MOUNTAINS) m++; }
  return m ? geo.distance(lobby, x0, y0, x1, y1) * m / n : 0;
}

/**
 * Can an observer at (x0, y0) see (x1, y1) past the mountains (docs/TERRAIN.md)? Only mountain ground blocks a
 * sightline:
 *   - Earth grid: a mountain cell between them (not the cells the two stand in) that rises above both (higher than
 *     the observer's eye, 30 m over its ground, and the target, 10 m over its own) hides the target. So a crest hides
 *     what lies on the far side, below it, while a unit climbing the slope facing the observer, or on the crest, stays
 *     in view. (A ridge test rather than a true sightline: on 7 km cells a bulging slope would otherwise hide its own
 *     upper part.)
 *   - Painted Mountains (no heights): a line crossing a painted range is blocked, unless the observer or the target
 *     stands in painted mountains itself (on its slopes).
 * Sampled every 0.75 map px (half an Earth grid cell).
 */
function lineOfSight(lobby, look, x0, y0, x1, y1) {
  if (!look.any) return true;
  const px = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.min(4000, Math.ceil(px / 0.75))), skip = Math.ceil(1.5 / Math.max(1e-6, px / n));   // the end cells
  if (n <= 2 * skip) return true;
  const h0 = look.earth ? look.heightAt(x0, y0) + 30 : 0, h1 = look.earth ? look.heightAt(x1, y1) + 10 : 0;
  const top = Math.max(h0, h1) + 25;
  let onSlope = null;
  for (let i = skip; i < n - skip; i++) {
    const t = (i + 0.5) / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    if (look.earth && look.earthClassAt(x, y) === MOUNTAINS) {
      if (look.heightAt(x, y) > top) return false;
    } else if (look.areas.length && look.paintedAt(x, y) === MOUNTAINS) {
      if (onSlope === null) onSlope = look.paintedAt(x0, y0) === MOUNTAINS || look.paintedAt(x1, y1) === MOUNTAINS;
      if (!onSlope) return false;
    }
  }
  return true;
}

module.exports = { FLAT, HILLS, MOUNTAINS, earthGrid, painted, lookup, classAt, enabled, moveKind, moveMult, inside, heightBonus, mountainKm, lineOfSight };
