'use strict';
/**
 * Fog of war (docs/FOG-OF-WAR.md). With the campaign rule on (game mode, `fogOfWar`), a player sees the units and
 * heroes of nations outside their side (their nation and its allies) only inside the side's vision:
 *
 *   - Earth map: by province. A province is in vision when it is the side's own ground, when a vision source
 *     stands in it, or when its centre is within a source's range. An enemy is seen when its province is.
 *     At sea (no province) it is seen within range of a source.
 *   - Image maps: by radius, plus the side's own territory.
 *   - Sources: living units and active heroes (range by type or category, `settings.vision`, plus research
 *     `vision` effects) and towns by size. Submarines are only seen within `subSpotKm` of a source.
 *
 * The server decides: canSee (lobbyAccess.js) asks `sees()`, so a unit outside vision never reaches a browser
 * (first load, live updates, history, drags, battles). When vision changes, `schedulePush` sends each player the
 * units that came into or went out of sight, their fog overlay, and the last known positions ("ghosts") of
 * enemy units that slipped out of view.
 */
const { db, now } = require('./db');
const access = require('./lobbyAccess');
const geo = require('./geo');
const UnitTypes = require('../public/js/units');

const norm = s => String(s || '').trim().toLowerCase();
const DEFAULT_RANGE = 50;
const BUCKET = 64;   // map px per cell of the source index

const q = {
  fingerprint: db.prepare(`SELECT
    (SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at), 0) FROM markers WHERE lobby_id = ?) || '|' ||
    (SELECT IFNULL(MAX(updated_at), 0) FROM provinces WHERE lobby_id = ?) || '|' ||
    (SELECT IFNULL(MAX(updated_at), 0) FROM territories WHERE lobby_id = ?) || '|' ||
    (SELECT IFNULL(MAX(updated_at), 0) FROM game WHERE lobby_id = ?) || '|' ||
    (SELECT IFNULL(GROUP_CONCAT(a || '-' || b || status), '') FROM relations WHERE lobby_id = ?) || '|' ||
    (SELECT IFNULL(GROUP_CONCAT(id || name), '') FROM factions WHERE lobby_id = ?) AS fp`),
  ghosts: db.prepare('SELECT * FROM fog_ghosts WHERE lobby_id = ? AND nation = ?'),
  allGhosts: db.prepare('SELECT * FROM fog_ghosts WHERE lobby_id = ?'),
  putGhost: db.prepare(`INSERT INTO fog_ghosts (lobby_id, nation, marker_id, x, y, name, type, unit_type, color, flag_nation, turn, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lobby_id, nation, marker_id) DO UPDATE SET x = excluded.x, y = excluded.y, name = excluded.name, type = excluded.type,
      unit_type = excluded.unit_type, color = excluded.color, flag_nation = excluded.flag_nation, turn = excluded.turn, seen_at = excluded.seen_at`),
  dropGhost: db.prepare('DELETE FROM fog_ghosts WHERE lobby_id = ? AND nation = ? AND marker_id = ?'),
  clearGhosts: db.prepare('DELETE FROM fog_ghosts WHERE lobby_id = ?'),
};

// ---- Per-campaign state, rebuilt when anything that feeds vision changes -----------------------------------
const cache = new Map();        // lobbyId -> state
let tick = 0, tickArmed = false;
/** Changes within one burst of synchronous work share a state; the fingerprint is checked once per tick. */
function currentTick() {
  if (!tickArmed) { tickArmed = true; setImmediate(() => { tick++; tickArmed = false; }); }
  return tick;
}
function fingerprint(lobbyId) { return q.fingerprint.get(lobbyId, lobbyId, lobbyId, lobbyId, lobbyId, lobbyId).fp; }
function invalidate(lobbyId) { cache.delete(Number(lobbyId)); }

function state(lobbyId) {
  lobbyId = Number(lobbyId);
  const t = currentTick();
  let st = cache.get(lobbyId);
  if (st && st.tick === t) return st;
  const fp = fingerprint(lobbyId);
  if (st && st.fp === fp) { st.tick = t; return st; }
  const game = require('./game');
  const g = game.get(lobbyId), lobby = access.getLobby(lobbyId);
  st = { lobbyId, tick: t, fp, lobby, g, settings: g.settings, on: !!(lobby && g.enabled && g.settings.fogOfWar), nations: new Map(), sides: new Map() };
  if (st.on) {
    const provinces = require('./provinces');
    st.factions = game.q.factions.all(lobbyId);
    st.byName = new Map(st.factions.map(f => [norm(f.name), f]));
    st.markers = game.q.markers.all(lobbyId).map(access.serializeMarker);
    st.pv = provinces.has(lobbyId) ? provinces : null;
    st.allies = new Map();
    for (const r of game.relations(lobbyId)) {
      if (r.status !== 'alliance') continue;
      for (const [a, b] of [[r.a, r.b], [r.b, r.a]]) { if (!st.allies.has(a)) st.allies.set(a, new Set()); st.allies.get(a).add(b); }
    }
    if (!st.pv) { try { st.lookup = require('./territory').ownerLookup(lobby); } catch { st.lookup = null; } }
  }
  cache.set(lobbyId, st);
  return st;
}

/** The nations (lower case) on a nation's side: itself and its allies. */
function sideOf(st, nation) {
  const n = norm(nation);
  if (st.sides.has(n)) return st.sides.get(n);
  const f = st.byName.get(n), out = new Set(n ? [n] : []);
  if (f) for (const id of st.allies.get(f.id) || []) { const a = st.factions.find(x => x.id === id); if (a) out.add(norm(a.name)); }
  st.sides.set(n, out);
  return out;
}

// ---- Ranges -------------------------------------------------------------------------------------------------
/** Vision range (km, or map units on image maps) of a marker, or 0 when it gives none. */
function rangeOf(m, settings, fx) {
  const v = settings.vision || {};
  if (m.type === 'town') return Number(v[m.data?.size] ?? v.village ?? 30);
  if (m.type === 'hero') return ['captured', 'travelling'].includes(m.data?.status) ? 0 : Number(v.hero ?? DEFAULT_RANGE);
  if (m.type !== 'unit' || Number(m.data?.strength ?? 100) <= 0 || m.data?.surrendered || m.data?.aboard) return 0;
  const t = UnitTypes.resolve(m.data?.unitType);
  let r = Number(v[t?.id] ?? v[t?.cat] ?? DEFAULT_RANGE);
  for (const e of fx?.vision || []) if (e.all || (e.unit && e.unit === t?.id) || (e.cat && e.cat === t?.cat)) r += e.km;
  return Math.max(0, r);
}
/** Half-extents in map px of a range around a point (Earth: degrees shrink towards the poles). */
function extent(st, x, y, km) {
  const l = st.lobby;
  if (geo.isEarth(l)) {
    const ry = km / 111.32 * l.map_height / 180;
    const lat = (90 - y / l.map_height * 180) * Math.PI / 180;
    return { rx: Math.min(l.map_width / 2, ry / Math.max(0.05, Math.cos(lat))), ry };
  }
  const r = km / (l.units_per_px || 1);
  return { rx: r, ry: r };
}

/** One nation's own vision: sources (bucketed for radius checks) and, on the Earth map, the provinces it sees. */
function nationVision(st, nation) {
  const n = norm(nation);
  if (st.nations.has(n)) return st.nations.get(n);
  const f = st.byName.get(n);
  const nv = { faction: f || null, sources: [], buckets: new Map(), provinces: st.pv ? new Set() : null };
  st.nations.set(n, nv);
  if (!f) return nv;
  const fx = require('./game').factionEffects(st.lobbyId, f.id);
  for (const m of st.markers) {
    if (!['unit', 'hero', 'town'].includes(m.type) || norm(m.data?.nation) !== n) continue;
    const km = rangeOf(m, st.settings, fx);
    if (km <= 0) continue;
    const { rx, ry } = extent(st, m.x, m.y, km);
    const src = { x: m.x, y: m.y, km, rx, ry };
    nv.sources.push(src);
    for (let gx = Math.floor((m.x - rx) / BUCKET); gx <= Math.floor((m.x + rx) / BUCKET); gx++)
      for (let gy = Math.floor((m.y - ry) / BUCKET); gy <= Math.floor((m.y + ry) / BUCKET); gy++) {
        const k = gx * 100000 + gy;
        if (!nv.buckets.has(k)) nv.buckets.set(k, []);
        nv.buckets.get(k).push(src);
      }
  }
  if (st.pv) {
    const c = st.pv.get(st.lobbyId), G = st.pv.GRID;
    for (const p of c.list) if (p.factionId === f.id) nv.provinces.add(p.id);
    for (const s of nv.sources) {
      const here = st.pv.at(st.lobbyId, s.x, s.y);
      if (here) nv.provinces.add(here.id);
      for (let gx = Math.floor((s.x - s.rx) / G); gx <= Math.floor((s.x + s.rx) / G); gx++)
        for (let gy = Math.floor((s.y - s.ry) / G); gy <= Math.floor((s.y + s.ry) / G); gy++)
          for (const p of c.grid.get(gx * 100000 + gy) || []) {
            if (nv.provinces.has(p.id)) continue;
            if (geo.distance(st.lobby, s.x, s.y, p.cx, p.cy) <= s.km) nv.provinces.add(p.id);
          }
    }
  }
  return nv;
}
function nearSource(st, nv, x, y, capKm = Infinity) {
  for (const s of nv.buckets.get(Math.floor(x / BUCKET) * 100000 + Math.floor(y / BUCKET)) || []) {
    if (Math.abs(x - s.x) > s.rx || Math.abs(y - s.y) > s.ry) continue;
    if (geo.distance(st.lobby, s.x, s.y, x, y) <= Math.min(s.km, capKm)) return true;
  }
  return false;
}
/** Is a point in sight of a side? `sub`: a submarine, only spotted close in. */
function inVision(st, side, x, y, sub = false) {
  const prov = st.pv && !sub ? st.pv.at(st.lobbyId, x, y) : null;
  const owner = !st.pv && !sub && st.lookup ? st.lookup(x, y) : null;
  for (const n of side) {
    const nv = nationVision(st, n);
    if (!nv.faction) continue;
    if (sub) { if (nearSource(st, nv, x, y, Number(st.settings.subSpotKm ?? 20))) return true; continue; }
    if (prov) { if (nv.provinces.has(prov.id)) return true; continue; }
    if (owner != null && owner === nv.faction.id) return true;
    if (nearSource(st, nv, x, y)) return true;
  }
  return false;
}

// ---- What canSee and the routes ask --------------------------------------------------------------------------
/** Fog on for this campaign? */
function on(lobbyId) { return !!lobbyId && state(lobbyId).on; }
const fogged = m => m && (m.type === 'unit' || m.type === 'hero');
/** Under fog, is this unit or hero another side's (so vision decides whether the viewer sees it)? */
function foreign(viewer, m) {
  if (!viewer || viewer.role === 'gm' || !viewer.lobbyId || !fogged(m)) return false;
  const st = state(viewer.lobbyId);
  if (!st.on) return false;
  return !sideOf(st, viewer.nation).has(norm(m.data?.nation));
}
/** Vision step of canSee: true unless fog hides this unit from the viewer. */
function sees(viewer, m) {
  if (!foreign(viewer, m)) return true;
  if (m.data?.aboard) return false;   // another side's troops aboard a convoy: what it carries is not seen
  const st = state(viewer.lobbyId);
  const sub = m.type === 'unit' && UnitTypes.resolve(m.data?.unitType)?.id === 'submarine';
  return inVision(st, sideOf(st, viewer.nation), m.x, m.y, sub);
}
/** A foreign unit as a viewer may receive it: without the trail, supply link or travel plans that would show where it has been or is going. */
function redact(m, viewer) {
  if (!foreign(viewer, m) || !m.data) return m;
  const { trail, supplyFrom, travel, postedTo, ride, ...data } = m.data;
  return { ...m, data };
}
/** Under fog, does a viewer see this unit's history and drag previews? Only its own side (and the GM) do. */
function sameSide(viewer, m) { return !foreign(viewer, m); }
/** The nations (names as stored) on a nation's side, for log audiences. */
function sideNames(lobbyId, nation) {
  const st = state(lobbyId);
  if (!st.on) return null;
  return [...sideOf(st, nation)].map(n => st.byName.get(n)?.name || n);
}
/** Vision range shown in a unit's panel (km). */
function rangeFor(lobbyId, m) {
  const st = state(lobbyId);
  const f = st.on ? st.byName.get(norm(m.data?.nation)) : null;
  return rangeOf(m, st.settings || {}, f ? require('./game').factionEffects(lobbyId, f.id) : null);
}

/**
 * The fog overlay and last known positions for a viewer: { on, provinces?: [ids in vision], circles?: [[x, y, rx, ry]],
 * ghosts: [...] }, or { on: false } (fog off, or the GM's all-seeing view).
 */
function overlay(viewer) {
  if (!viewer || viewer.role === 'gm' || !viewer.lobbyId) return { on: false };
  const st = state(viewer.lobbyId);
  if (!st.on) return { on: false };
  const side = sideOf(st, viewer.nation), out = { on: true, nations: [...side] };
  if (st.pv) {
    const ids = new Set();
    for (const n of side) for (const id of nationVision(st, n).provinces || []) ids.add(id);
    out.provinces = [...ids];
  } else {
    out.circles = [];
    for (const n of side) for (const s of nationVision(st, n).sources) out.circles.push([s.x, s.y, s.rx, s.ry]);
    out.own = [...side].map(n => st.byName.get(n)?.id).filter(Boolean);
  }
  out.ghosts = ghostsFor(st, viewer.nation);
  return out;
}

// ---- Last known positions -------------------------------------------------------------------------------------
const lastSeen = new Map();   // lobbyId -> Map(nation -> Map(markerId -> serialized marker as last seen))
function serializeGhost(r) {
  return { id: r.marker_id, x: r.x, y: r.y, name: r.name, type: r.type, unitType: r.unit_type, color: r.color, nation: r.flag_nation, turn: r.turn, at: r.seen_at };
}
function ghostsFor(st, nation) { return q.ghosts.all(st.lobbyId, norm(nation)).map(serializeGhost); }
/** Units and heroes of other sides a nation sees now. */
function visibleForeign(st, nation) {
  const side = sideOf(st, nation), out = new Map();
  const viewer = { role: 'player', userId: -1, nation, lobbyId: st.lobbyId };
  for (const m of st.markers) {
    if (!fogged(m) || side.has(norm(m.data?.nation))) continue;
    if (access.canSee(m, viewer)) out.set(m.id, m);
  }
  return out;
}
/**
 * Update every nation's last known positions: an enemy that slips out of sight leaves a ghost where it was last
 * seen; a ghost goes when the unit is seen again, or when the spot is back in sight and the unit is not there.
 * Returns the nations whose ghosts changed.
 */
function updateGhosts(st) {
  if (!lastSeen.has(st.lobbyId)) lastSeen.set(st.lobbyId, new Map());
  const memo = lastSeen.get(st.lobbyId), changed = new Set(), t = now();
  for (const f of st.factions) {
    const n = norm(f.name), seen = visibleForeign(st, n), prev = memo.get(n), side = sideOf(st, n);
    if (prev) {
      for (const [id, m] of prev) {
        if (seen.has(id) || !st.markers.some(x => x.id === id)) continue;   // still seen, or gone from the map (destroyed, removed)
        // Only when our sight has left the spot: an enemy seen walking away is known not to be there.
        if (inVision(st, side, m.x, m.y)) continue;
        q.putGhost.run(st.lobbyId, n, id, m.x, m.y, m.name, m.type, m.data?.unitType || '', m.color || '#888888', m.data?.nation || '', st.g.turn, t);
        changed.add(n);
      }
    }
    for (const gh of q.ghosts.all(st.lobbyId, n)) {
      if (seen.has(gh.marker_id) || inVision(st, side, gh.x, gh.y)) { q.dropGhost.run(st.lobbyId, n, gh.marker_id); changed.add(n); }
    }
    memo.set(n, seen);
  }
  return changed;
}

// ---- Pushing changes to players ------------------------------------------------------------------------------
const pending = new Set();
/** After the current request has finished writing: recompute vision and send each player what changed. */
function schedulePush(lobbyId) {
  lobbyId = Number(lobbyId);
  invalidate(lobbyId);
  if (pending.has(lobbyId)) return;
  pending.add(lobbyId);
  setImmediate(() => {
    pending.delete(lobbyId);
    try { pushNow(lobbyId); } catch (e) { console.warn('fog of war update failed', e); }
  });
}
function pushNow(lobbyId) {
  invalidate(lobbyId);
  const st = state(lobbyId);
  if (st.on) updateGhosts(st);
  require('./ws').syncFog(lobbyId);
}
/** Fog switched on or off: forget what each side last saw, so no ghosts appear from before. */
function reset(lobbyId) { lastSeen.delete(Number(lobbyId)); q.clearGhosts.run(Number(lobbyId)); invalidate(lobbyId); }

module.exports = { on, sees, foreign, redact, sameSide, sideNames, rangeFor, overlay, invalidate, schedulePush, reset, state };
