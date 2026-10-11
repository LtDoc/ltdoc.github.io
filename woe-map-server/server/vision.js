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
 * Submerged submarines (data.submerged, routes/orders.js) are hidden in any game, fog or not: another side sees one only
 * while one of its destroyers is within `subDetectKm` of it (or a spy's reveal names it). With fog off the state then
 * tracks just the submarines, so the same pushes add and remove them as destroyers close in or draw off.
 *
 * The server decides: canSee (lobbyAccess.js) asks `sees()`, so a unit outside vision never reaches a browser
 * (first load, live updates, history, drags, battles). When vision changes, `schedulePush` sends each player the
 * units that came into or went out of sight, their fog overlay, and the last known positions ("ghosts") of
 * enemy units that slipped out of view. The battlefield follows the same rule (shapeViews, fightSeen, craterSeen):
 * another side's trenches reach a player only where they run through their vision, fights they are not in only
 * with both ends in sight, craters only on ground they can see.
 */
const { db, now } = require('./db');
const access = require('./lobbyAccess');
const geo = require('./geo');
const UnitTypes = require('../public/js/units');

const norm = s => String(s || '').trim().toLowerCase();
const wreck = m => m?.type === 'unit' && Number(m.data?.strength ?? 100) <= 0;
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
  othersFp: db.prepare('SELECT COUNT(*) AS n, IFNULL(MAX(updated_at), 0) AS t FROM markers WHERE lobby_id = ? AND id != ?'),
  anySubmerged: db.prepare("SELECT COUNT(*) AS n FROM markers WHERE lobby_id = ? AND type = 'unit' AND COALESCE(json_extract(data, '$.strength'), 100) > 0 AND json_extract(data, '$.submerged') = 1"),
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
function cached() { return [...cache.keys()]; }
/**
 * One marker has just been written (moved, edited, placed or deleted; `before`/`after` serialized, null when
 * absent): patch it into the cached state instead of reloading every marker, so the visibility checks that follow
 * stay cheap. Only its nation's sight is worked out again. False when there is no state to patch.
 */
function patchMarker(lobbyId, before, after) {
  const st = cache.get(lobbyId);
  if (!st || !st.track) return false;
  if (!!before?.data?.submerged !== !!after?.data?.submerged) return false;   // a submarine dived or surfaced: what is tracked changes
  if (wreck(before) !== wreck(after) && (before?.data?.submerged || after?.data?.submerged)) return false;
  const id = (after || before).id;
  // Only when this write is the sole change since the state was built: the fingerprint as it was before it
  // (every other marker, plus this one as it stood) must match. Anything else changed too: rebuild instead.
  const fp = fingerprint(lobbyId), rest = fp.slice(fp.indexOf('|'));
  const o = q.othersFp.get(lobbyId, id);
  const was = before ? `${o.n + 1}:${Math.max(o.t, before.updatedAt)}` : `${o.n}:${o.t}`;
  if (st.fp !== was + rest) return false;
  const i = st.markers.findIndex(m => m.id === id);
  if (after) { if (i >= 0) st.markers[i] = after; else st.markers.push(after); }
  else if (i >= 0) st.markers.splice(i, 1);
  for (const m of [before, after]) if (m && !wreck(m)) st.nations.delete(norm(m.data?.nation));
  if ([before, after].some(m => m && !wreck(m))) st.hunters = null;   // living destroyers may have moved (sonar)
  st.fp = fp;
  return true;
}

function state(lobbyId) {
  lobbyId = Number(lobbyId);
  const t = currentTick();
  let st = cache.get(lobbyId);
  if (st && st.tick === t) return st;
  const fp = fingerprint(lobbyId);
  if (st && st.fp === fp) { st.tick = t; return st; }
  const game = require('./game');
  const g = game.get(lobbyId), lobby = access.getLobby(lobbyId);
  st = { lobbyId, tick: t, fp, lobby, g, settings: g.settings, on: !!(lobby && g.enabled && g.settings.fogOfWar), nations: new Map(), sides: new Map(), provAt: new Map() };
  st.subs = !!(lobby && g.enabled) && q.anySubmerged.get(lobbyId).n > 0;
  st.track = st.on || st.subs;
  if (st.track) {
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
    if (!st.on) st.pv = null;
    else if (!st.pv) { try { st.lookup = require('./territory').ownerLookup(lobby); } catch { st.lookup = null; } }
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
    if (wreck(m) || !['unit', 'hero', 'town'].includes(m.type) || norm(m.data?.nation) !== n) continue;
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
      const here = provinceAt(st, s.x, s.y);
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
/** The province under a point, remembered for the life of the state (every side asks about the same units). */
function provinceAt(st, x, y) {
  const k = x + ',' + y;
  let p = st.provAt.get(k);
  if (p === undefined) { p = st.pv.at(st.lobbyId, x, y); st.provAt.set(k, p); }
  return p;
}
/** Is a point in sight of a side? `sub`: a submarine, only spotted close in. */
function inVision(st, side, x, y, sub = false) {
  const prov = st.pv && !sub ? provinceAt(st, x, y) : null;
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
const isSub = m => m?.type === 'unit' && UnitTypes.resolve(m.data?.unitType)?.id === 'submarine';
/** Is vision deciding who sees this marker? Under fog every unit and hero; otherwise only submarines, while any is submerged. */
const tracked = (st, m) => (st.on ? fogged(m) : st.subs && isSub(m));
/** Is this unit or hero another side's, and tracked (so vision decides whether the viewer sees it)? */
function foreign(viewer, m) {
  if (!viewer || viewer.role === 'gm' || !viewer.lobbyId || !fogged(m)) return false;
  const st = state(viewer.lobbyId);
  if (!st.track || !tracked(st, m)) return false;
  return !sideOf(st, viewer.nation).has(norm(m.data?.nation));
}
/** Is a point within subDetectKm of one of the side's destroyers (the only ships that find a submerged submarine)? */
function sonar(st, side, x, y) {
  if (!st.hunters) {
    st.hunters = st.markers.filter(m => m.type === 'unit' && !m.data?.aboard && Number(m.data?.strength ?? 100) > 0 && UnitTypes.resolve(m.data?.unitType)?.id === 'destroyer');
  }
  const km = Number(st.settings.subDetectKm ?? 20);
  return st.hunters.some(h => side.has(norm(h.data?.nation)) && geo.distance(st.lobby, h.x, h.y, x, y) <= km);
}
/** Vision step of canSee: true unless fog (or the sea) hides this unit from the viewer. */
function sees(viewer, m) {
  // Wrecks remain on the battlefield, without per-viewer radius/province/sonar checks.
  // Explicit marker access restrictions are still enforced by canSee before this call.
  if (wreck(m)) return true;
  if (!foreign(viewer, m)) return true;
  if (m.data?.aboard) return false;   // another side's troops aboard a convoy: what it carries is not seen
  const st = state(viewer.lobbyId), side = sideOf(st, viewer.nation);
  if (m.data?.submerged) return sonar(st, side, m.x, m.y);
  if (!st.on) return true;
  return inVision(st, side, m.x, m.y, isSub(m));
}
/** Is a unit on the viewer's side (its nation or an ally)? For orders no one else may read, fog or no fog. */
function ownSide(viewer, m) {
  if (!viewer || viewer.role === 'gm') return true;
  const lobby = access.getLobby(viewer.lobbyId);
  return !!lobby && require('./supply').friendsResolver(lobby)(viewer.nation).has(norm(m.data?.nation));
}
/**
 * A foreign unit as a viewer may receive it: without the trail, supply link or travel plans that would show where it has
 * been or is going. Marching orders (data.goal) are the owner's side's alone, fog or no fog.
 */
function redact(m, viewer) {
  if (m.data?.goal && !ownSide(viewer, m)) { const { goal, ...rest } = m.data; m = { ...m, data: rest }; }
  // Under fog of war a town's stores (server/goods.js) are its own side's to know; its unrest is public, like a revolt.
  if (m.type === 'town' && m.data?.goods && viewer && viewer.role !== 'gm' && on(viewer.lobbyId) && !ownSide(viewer, m)) { const { goods, ...rest } = m.data; m = { ...m, data: rest }; }
  if (!foreign(viewer, m) || !m.data) return m;
  const { trail, supplyFrom, travel, postedTo, ride, dig, corps, ...data } = m.data;
  return { ...m, data };
}
/** Under fog, does a viewer see this unit's history and drag previews? Only its own side (and the GM) do. */
function sameSide(viewer, m) { return !foreign(viewer, m) && !foreignTrench(viewer, m); }
/** The nations (names as stored) on a nation's side, for log audiences. */
function sideNames(lobbyId, nation) {
  const st = state(lobbyId);
  if (!st.on) return null;
  return [...sideOf(st, nation)].map(n => st.byName.get(n)?.name || n);
}
/** Vision range shown in a unit's panel (km). */
function rangeFor(lobbyId, m) {
  if (wreck(m)) return 0;
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
    if (wreck(m) || !fogged(m) || side.has(norm(m.data?.nation))) continue;
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
  const wrecks = new Set(st.markers.filter(wreck).map(m => m.id));
  const onMap = new Set(st.markers.filter(m => !wreck(m)).map(m => m.id));
  for (const f of st.factions) {
    const n = norm(f.name), seen = visibleForeign(st, n), prev = memo.get(n), side = sideOf(st, n);
    if (prev) {
      for (const [id, m] of prev) {
        if (seen.has(id) || !onMap.has(id)) continue;   // still seen, or gone from the map (destroyed, removed)
        // Only when our sight has left the spot: an enemy seen walking away is known not to be there.
        if (inVision(st, side, m.x, m.y)) continue;
        q.putGhost.run(st.lobbyId, n, id, m.x, m.y, m.name, m.type, m.data?.unitType || '', m.color || '#888888', m.data?.nation || '', st.g.turn, t);
        changed.add(n);
      }
    }
    for (const gh of q.ghosts.all(st.lobbyId, n)) {
      if (wrecks.has(gh.marker_id) || seen.has(gh.marker_id) || inVision(st, side, gh.x, gh.y)) { q.dropGhost.run(st.lobbyId, n, gh.marker_id); changed.add(n); }
    }
    memo.set(n, seen);
  }
  return changed;
}

// ---- Pushing changes to players ------------------------------------------------------------------------------
const pending = new Set();
const PUSH_MS = 100;   // moves landing within this of each other (several players at once) share one recompute
/**
 * Shortly after the current request has finished writing: recompute vision and send each player what changed.
 * The state is brought up to date at once (patched for a single marker given as `before`/`after`, else dropped),
 * so visibility checks in the meantime see the new positions.
 */
function schedulePush(lobbyId, before = null, after = null) {
  lobbyId = Number(lobbyId);
  if (!(before || after) || !patchMarker(lobbyId, before, after)) invalidate(lobbyId);
  if ((before || after) && [before, after].every(m => !m || wreck(m))) return;
  if (pending.has(lobbyId)) return;
  pending.add(lobbyId);
  setTimeout(() => {
    pending.delete(lobbyId);
    try { pushNow(lobbyId); } catch (e) { console.warn('fog of war update failed', e); }
  }, PUSH_MS);
}
function pushNow(lobbyId) {
  const st = state(lobbyId);   // current: rebuilt after any change (schedulePush drops it, the fingerprint catches the rest)
  if (st.on) require('./game').transaction(() => updateGhosts(st));
  require('./ws').syncFog(lobbyId);
}
/** Fog switched on or off: forget what each side last saw, so no ghosts appear from before. */
function reset(lobbyId) { lastSeen.delete(Number(lobbyId)); q.clearGhosts.run(Number(lobbyId)); invalidate(lobbyId); }

// ---- The battlefield under fog: trenches, fights and craters --------------------------------------------------
// Nobody knows the shape of a battlefield without having looked at it. Another side's trench reaches a player only
// where it runs through their vision (clipped on the server into pieces, so the browser never holds the rest), a
// fight they are not in only when both ends are in sight, and craters only where they can see the ground.
const qf = {
  trenches: db.prepare("SELECT * FROM shapes WHERE lobby_id = ? AND kind = 'trench'"),
  battles: db.prepare('SELECT id, hidden, user_id, ax, ay, dx, dy, losses FROM battles WHERE lobby_id = ? AND turn >= ? AND (until_ms IS NULL OR until_ms > ?)'),
  craters: db.prepare('SELECT id, hidden, user_id, x, y FROM craters WHERE lobby_id = ? AND expires_turn > ? AND (until_ms IS NULL OR until_ms > ?)'),
};
const SAMPLE_PX = 6;    // a trench is tested for sight at least this often along its line (about 30 km on the Earth map)
const MAX_PIECES = 99;
/** Is this trench another side's (or nobody's) under fog, so that only what is in sight of the viewer reaches them? */
function foreignTrench(viewer, s) {
  if (!viewer || viewer.role === 'gm' || !viewer.lobbyId || !s || s.kind !== 'trench') return false;
  const st = state(viewer.lobbyId);
  if (!st.on) return false;
  const n = norm(s.data?.nation);
  return !n || !sideOf(st, viewer.nation).has(n);
}
/**
 * A shape as a viewer receives it: itself, or, for another side's trench under fog, the pieces of it inside the
 * viewer's vision (none when nothing of it is in sight). A piece keeps the trench's look and state, with
 * data.of (the trench) and data.part, and an id of its own below zero.
 */
function shapeViews(viewer, s) {
  if (!foreignTrench(viewer, s)) return [s];
  const pts = Array.isArray(s.points) ? s.points : [];
  if (pts.length < 2) return [];
  const st = state(viewer.lobbyId), side = sideOf(st, viewer.nation);
  // Walk the line, a sample at least every SAMPLE_PX, and keep the runs in sight.
  const runs = [];
  let run = null;
  const take = (x, y) => {
    if (inVision(st, side, x, y)) { if (!run) { run = []; runs.push(run); } run.push([x, y]); }
    else run = null;
  };
  take(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], n = Math.ceil(Math.hypot(bx - ax, by - ay) / SAMPLE_PX);
    for (let k = 1; k < n; k++) take(Math.round((ax + (bx - ax) * k / n) * 10) / 10, Math.round((ay + (by - ay) * k / n) * 10) / 10);
    take(bx, by);
  }
  return runs.filter(r => r.length >= 2).slice(0, MAX_PIECES)
    .map((points, k) => ({ ...s, id: -(s.id * 100 + k), points, locked: true, data: { ...(s.data || {}), of: s.id, part: k } }));
}
/** Every trench piece a viewer sees now: Map(piece id -> its JSON), for the push that follows vision changes. */
function trenchPieces(viewer) {
  const out = new Map();
  for (const row of qf.trenches.all(viewer.lobbyId)) {
    const s = access.serializeShape(row);
    if (!foreignTrench(viewer, s) || !access.canSee(s, viewer)) continue;
    for (const p of shapeViews(viewer, s)) out.set(p.id, p);
  }
  return out;
}
/** Does a viewer see a fight (its tracers, shells, and later its dead)? b: a battles row or serialized battle. */
function fightSeen(viewer, b) {
  if (!viewer || viewer.role === 'gm') return true;
  const hidden = b.hidden, user = b.user_id ?? b.userId;
  if (hidden && user !== viewer.userId) return false;
  if (!viewer.lobbyId) return true;
  const st = state(viewer.lobbyId);
  if (!st.on) return true;
  const side = sideOf(st, viewer.nation);
  // By nation, not by account: a GM viewing as a nation sees what that nation would, not the fights the GM ran.
  const losses = typeof b.losses === 'string' ? access.safeJson(b.losses) : b.losses;
  if (side.has(norm(losses?.a?.nation)) || side.has(norm(losses?.d?.nation))) return true;
  return inVision(st, side, b.ax, b.ay) && inVision(st, side, b.dx, b.dy);
}
/** Does a viewer see a crater? Its own fights' and the GM's always; otherwise where they can see the ground. */
function craterSeen(viewer, c) {
  if (!viewer || viewer.role === 'gm') return true;
  const user = c.user_id ?? c.userId;
  if (c.hidden && user !== viewer.userId) return false;
  if (!viewer.lobbyId) return true;
  const st = state(viewer.lobbyId);
  if (!st.on) return true;
  return inVision(st, sideOf(st, viewer.nation), c.x, c.y);
}
/** What a viewer sees of the fighting, as one string: when it changes, their map fetches the battles again. */
function fightKey(viewer) {
  const st = state(viewer.lobbyId), t = Date.now(), turn = st.g?.turn || 1;
  const b = qf.battles.all(viewer.lobbyId, turn - 2, t - 30 * 60000).filter(x => fightSeen(viewer, x)).map(x => x.id);
  const c = qf.craters.all(viewer.lobbyId, turn, t).filter(x => craterSeen(viewer, x)).map(x => x.id);
  return `${b.join(',')}|${c.join(',')}`;
}

module.exports = { on, sees, foreign, redact, sameSide, sideNames, rangeFor, overlay, invalidate, cached, schedulePush, reset, state,
  foreignTrench, shapeViews, trenchPieces, fightSeen, craterSeen, fightKey };
