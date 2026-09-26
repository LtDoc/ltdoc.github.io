'use strict';
/**
 * Server-side geometry for a campaign map: the same equirectangular projection and great-circle distance
 * the browser uses (public/js/earth.js), plus plain pixel distances for image maps.
 */
const access = require('./lobbyAccess');

const R_EARTH = 6371.0088;

function isEarth(lobby) {
  const s = access.safeJson(lobby.settings);
  return s.projection === 'equirect' && !!s.earth && !lobby.map_file;
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

module.exports = { isEarth, project, unproject, haversineKm, distance };
