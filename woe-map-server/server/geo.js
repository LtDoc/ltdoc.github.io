'use strict';
/**
 * Server-side geometry for a campaign map: the same equirectangular projection and great-circle distance
 * the browser uses (public/js/earth.js), plus plain pixel distances for image maps.
 */
const access = require('./lobbyAccess');

const R_EARTH = 6371.0088;

// Distances run in tight loops (supply, vision, rails): parse a lobby's settings once, not on every call.
const earthMemo = new WeakMap();   // lobby row -> { settings, mapFile, earth }
function isEarth(lobby) {
  const hit = earthMemo.get(lobby);
  if (hit && hit.settings === lobby.settings && hit.mapFile === lobby.map_file) return hit.earth;
  const s = access.safeJson(lobby.settings);
  const earth = s.projection === 'equirect' && !!s.earth && !lobby.map_file;
  earthMemo.set(lobby, { settings: lobby.settings, mapFile: lobby.map_file, earth });
  return earth;
}
function project(lon, lat, W, H) { return [(lon + 180) / 360 * W, (90 - lat) / 180 * H]; }
function unproject(x, y, W, H) { return [x / W * 360 - 180, 90 - y / H * 180]; }

function haversineKm(lon1, lat1, lon2, lat2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Distance between two map points in the campaign's units (km on the Earth map, map units elsewhere). */
function distance(lobby, x1, y1, x2, y2) {
  if (isEarth(lobby)) {
    const W = lobby.map_width, H = lobby.map_height;
    const [lon1, lat1] = unproject(x1, y1, W, H), [lon2, lat2] = unproject(x2, y2, W, H);
    return haversineKm(lon1, lat1, lon2, lat2);
  }
  return Math.hypot(x2 - x1, y2 - y1) * (lobby.units_per_px || 1);
}

/** Half-extents in map px of a `km` range around (x, y): degrees of longitude shrink towards the poles. */
function extent(lobby, x, y, km) {
  if (isEarth(lobby)) {
    const ry = km / 111.32 * lobby.map_height / 180;
    const lat = (90 - y / lobby.map_height * 180) * Math.PI / 180;
    return { rx: ry / Math.max(0.05, Math.cos(lat)), ry };
  }
  const r = km / (lobby.units_per_px || 1);
  return { rx: r, ry: r };
}

/**
 * Points (anything with x, y) bucketed on a coarse grid, so "what lies within km of here" tests a few cells instead
 * of every point. On the Earth map the search wraps round the date line.
 * `near(x, y, km, fn)` calls fn(point, distanceKm) for each point within km.
 */
function index(lobby, list) {
  const C = 32, cells = new Map(), earth = isEarth(lobby);
  const cols = earth ? Math.max(1, Math.ceil(lobby.map_width / C)) : 0;
  const key = (gx, gy) => gx * 100000 + gy;
  for (const o of list) {
    const gx = Math.floor(o.x / C), k = key(earth ? ((gx % cols) + cols) % cols : gx, Math.floor(o.y / C));
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(o);
  }
  return {
    size: list.length,
    near(x, y, km, fn) {
      if (!cells.size) return;
      const { rx, ry } = extent(lobby, x, y, km);
      let gx0 = Math.floor((x - rx) / C), gx1 = Math.floor((x + rx) / C);
      if (earth && gx1 - gx0 + 1 > cols) { gx0 = 0; gx1 = cols - 1; }
      const gy0 = Math.floor((y - ry) / C), gy1 = Math.floor((y + ry) / C);
      for (let gx = gx0; gx <= gx1; gx++) {
        const cx = earth ? ((gx % cols) + cols) % cols : gx;
        for (let gy = gy0; gy <= gy1; gy++) {
          const list = cells.get(key(cx, gy));
          if (!list) continue;
          for (const o of list) { const d = distance(lobby, x, y, o.x, o.y); if (d <= km) fn(o, d); }
        }
      }
    },
  };
}

module.exports = { isEarth, project, unproject, haversineKm, distance, extent, index };
