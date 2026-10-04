'use strict';
/**
 * Trench sections (docs/UNITS.md): the geometry behind engineers digging and reinforcing a trench one section a turn
 * and sappers blowing one up. A section is `km` of a trench's centreline centred on the point nearest a unit; cutting
 * it out leaves up to three pieces (the part before it, the section, the part after it). Distances follow the
 * campaign (great-circle km on the Earth map); points are map pixels.
 */
const geo = require('./geo');

/** Cumulative distance along a polyline: cum[i] = length from the first point to point i. */
function lengths(lobby, pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + geo.distance(lobby, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  return cum;
}

/** The point `s` along the line (s in the campaign's distance units). */
function pointAt(pts, cum, s) {
  if (s <= 0) return [pts[0][0], pts[0][1]];
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] >= s) {
      const seg = cum[i] - cum[i - 1], t = seg > 0 ? (s - cum[i - 1]) / seg : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
  }
  const p = pts[pts.length - 1];
  return [p[0], p[1]];
}

/** The part of the line from s0 to s1, with interpolated ends. */
function slice(pts, cum, s0, s1) {
  const out = [pointAt(pts, cum, s0)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) out.push([pts[i][0], pts[i][1]]);
  out.push(pointAt(pts, cum, s1));
  return out.map(p => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
}

/** Where along the line (s) the point nearest (x, y) lies, and how far away it is: { s, dist }. */
function nearest(lobby, pts, cum, x, y) {
  let best = { s: 0, dist: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    const px = ax + dx * t, py = ay + dy * t;
    const d = geo.distance(lobby, x, y, px, py);
    if (d < best.dist) best = { s: cum[i - 1] + (cum[i] - cum[i - 1]) * t, dist: d };
  }
  return best;
}

/**
 * The section of `km` centred on the point of the line nearest (x, y), kept inside the line. Leftovers shorter than a
 * fifth of a section are taken into it, so no slivers are left. Returns { s0, s1, dist, length, pieces: { before,
 * section, after } } (before/after null when nothing is left there).
 */
function section(lobby, pts, x, y, km) {
  const cum = lengths(lobby, pts), L = cum[cum.length - 1];
  const at = nearest(lobby, pts, cum, x, y);
  let s0 = Math.max(0, at.s - km / 2), s1 = Math.min(L, s0 + km);
  s0 = Math.max(0, Math.min(s0, s1 - km));
  const sliver = km / 5;
  if (s0 < sliver) s0 = 0;
  if (L - s1 < sliver) s1 = L;
  return {
    s0, s1, dist: at.dist, length: L,
    pieces: { before: s0 > 0 ? slice(pts, cum, 0, s0) : null, section: slice(pts, cum, s0, s1), after: s1 < L ? slice(pts, cum, s1, L) : null },
  };
}

/** Distance from a point to the line (campaign units). */
function distanceTo(lobby, pts, x, y) {
  if (!Array.isArray(pts) || pts.length < 2) return Infinity;
  return nearest(lobby, pts, lengths(lobby, pts), x, y).dist;
}

/**
 * Join two lines that run on from one another (a's end on b's start, or b's end on a's start, within `tol` map px), so
 * which side is the rear stays the same; null when they do not.
 */
function join(a, b, tol = 0.05) {
  const same = (p, q) => Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;
  if (same(a[a.length - 1], b[0])) return [...a, ...b.slice(1)];
  if (same(b[b.length - 1], a[0])) return [...b, ...a.slice(1)];
  return null;
}

module.exports = { lengths, pointAt, slice, nearest, section, distanceTo, join };
