'use strict';

/**
 * Movement reach (docs/COMMS.md): the ground a selected unit can still get to this turn, as the server will judge it,
 * drawn instead of a plain circle.
 *
 * The server checks every move as a straight line from the unit (server/game.js checkMove), so the reachable area is
 * star-shaped round it: cast rays outward and walk each one in steps of about a map pixel,
 *   - paying No Man's Land at its multiple of the distance (walkCost);
 *   - a land unit stops where open water begins, unless it is a strait of up to 20 km with land beyond
 *     (territory.landCourseError), and never ends in the water;
 *   - a ship stops where land begins (it may lie on the coast; territory.shipCourseError);
 *   - a land unit stops just short of a manned enemy trench it can see (game.trenchBlock).
 * The land raster is the server's own (GET /landmask, about 90 KB run-length encoded, fetched once), so the coast
 * matches the server's to the cell.
 *
 * Cost: rays × steps cheap lookups (a bit test and bounding-box checks), a few ms; the caller computes it only when the
 * selection or the ground around it changes and keeps the result until then.
 */
const Reach = (() => {
  const STRAIT_KM = 20;
  let mask = null, maskP = null;   // mask: null not loaded yet, false none (image maps), else { W, H, cell, bits }

  /** Fetch and unpack the land raster: Uint32 W, H, cell, then per row a Uint16 count and its run lengths, water first. */
  function loadMask(url) {
    if (maskP) return maskP;
    maskP = fetch(url, { credentials: 'same-origin' }).then(async r => {
      if (r.status !== 200) { mask = false; return; }
      const buf = await r.arrayBuffer(), dv = new DataView(buf);
      const W = dv.getUint32(0, true), H = dv.getUint32(4, true), cell = dv.getUint32(8, true);
      const bits = new Uint8Array(Math.ceil(W * H / 8));
      let o = 12;
      for (let row = 0; row < H; row++) {
        const n = dv.getUint16(o, true); o += 2;
        let i = row * W, land = false;
        for (let k = 0; k < n; k++) {
          const len = dv.getUint16(o, true); o += 2;
          if (land) for (let e = i + len; i < e; i++) bits[i >> 3] |= 1 << (i & 7);
          else i += len;
          land = !land;
        }
      }
      mask = { W, H, cell, bits };
    }).catch(() => { mask = false; });
    return maskP;
  }
  /** Whether the raster is known (or known not to exist). */
  const ready = () => mask !== null;

  function landAt(x, y) {
    if (!mask) return true;
    const c = Math.floor(x / mask.cell), r = Math.floor(y / mask.cell);
    if (c < 0 || r < 0 || c >= mask.W || r >= mask.H) return false;
    const i = r * mask.W + c;
    return (mask.bits[i >> 3] >> (i & 7) & 1) === 1;
  }
  /** Water within one cell (a coast or harbour): a ship may lie there. */
  function nearWater(x, y) {
    if (!mask) return true;
    const c0 = Math.floor(x / mask.cell), r0 = Math.floor(y / mask.cell);
    for (let r = r0 - 1; r <= r0 + 1; r++) for (let c = c0 - 1; c <= c0 + 1; c++) {
      if (r < 0 || c < 0 || r >= mask.H || c >= mask.W) return true;
      const i = r * mask.W + c;
      if (!(mask.bits[i >> 3] >> (i & 7) & 1)) return true;
    }
    return false;
  }

  function bbox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  }
  function inRing(pts, x, y) {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  /** Where segment a→b crosses segment c→d: the fraction along a→b, or null. */
  function cross(ax, ay, bx, by, c, d) {
    const rx = bx - ax, ry = by - ay, sx = d[0] - c[0], sy = d[1] - c[1], den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    const qx = c[0] - ax, qy = c[1] - ay, t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
  }

  /**
   * The reachable area: { poly: [x0, y0, x1, y1, …] (map px, one point per ray), bbox }.
   * o: { x, y, remaining (campaign units), kind: 'land' | 'ship' | 'free', dist(x0, y0, x1, y1) (campaign units),
   *      perKm: [map px per unit eastward, southward] at the unit, nml: { mult, areas: [[[x, y], …], …] },
   *      walls: [{ a: [x, y], b: [x, y], manned(x, y) }] (manned enemy trench segments), rays }
   */
  function compute(o) {
    const N = o.rays || 240, rem = o.remaining, [kx, ky] = o.perKm;
    // Steps of about a map pixel (the raster is 2 px), but no more than 400 a ray however far it reaches.
    const ds = Math.max(rem / 400, 0.75 / Math.max(kx, ky));
    const span = rem * 1.25, rx = span * kx, ry = span * ky;
    const box = [o.x - rx, o.y - ry, o.x + rx, o.y + ry];
    const hits = b => b[2] >= box[0] && b[0] <= box[2] && b[3] >= box[1] && b[1] <= box[3];
    const mult = Math.max(1, Number(o.nml?.mult) || 1);
    const areas = mult > 1 ? (o.nml?.areas || []).map(p => ({ p, b: bbox(p) })).filter(a => hits(a.b)) : [];
    const inNml = (x, y) => areas.some(a => x >= a.b[0] && x <= a.b[2] && y >= a.b[1] && y <= a.b[3] && inRing(a.p, x, y));
    const walls = (o.walls || []).filter(w => hits(bbox([w.a, w.b])));
    const land = o.kind === 'land', ship = o.kind === 'ship';
    const startWet = land && !landAt(o.x, o.y);
    const poly = [], out = [Infinity, Infinity, -Infinity, -Infinity];
    for (let k = 0; k < N; k++) {
      const a = k / N * Math.PI * 2, ux = Math.cos(a) * kx, uy = Math.sin(a) * ky;   // map px per campaign unit along the ray
      // The nearest manned enemy trench across this ray: stop 1 unit (km) short of it.
      let wallT = Infinity;
      const ex = o.x + ux * span, ey = o.y + uy * span;
      for (const w of walls) {
        const f = cross(o.x, o.y, ex, ey, w.a, w.b);
        if (f === null) continue;
        const t = f * span;
        if (t > 0.5 && t < wallT && w.manned(o.x + ux * t, o.y + uy * t)) wallT = t;
      }
      const stopAt = wallT - 1;
      let t = 0, cost = 0, okT = 0, wetFrom = startWet ? 0 : null, limit = startWet ? STRAIT_KM + 30 : STRAIT_KM;
      for (let guard = 0; guard < 2000; guard++) {
        let t1 = t + ds, last = false;
        if (t1 >= stopAt) { t1 = Math.max(t, stopAt); last = true; }
        const ax = o.x + ux * t, ay = o.y + uy * t, bx = o.x + ux * t1, by = o.y + uy * t1;
        const d = o.dist(ax, ay, bx, by), c = d * (areas.length && inNml((ax + bx) / 2, (ay + by) / 2) ? mult : 1);
        if (cost + c >= rem) { t1 = t + (t1 - t) * (c > 0 ? (rem - cost) / c : 0); last = true; } else cost += c;
        const px = o.x + ux * t1, py = o.y + uy * t1;
        if (land) {
          if (landAt(px, py)) { wetFrom = null; limit = STRAIT_KM; okT = t1; }
          else {
            if (wetFrom === null) wetFrom = t;
            if (t1 - wetFrom > limit || last) { t1 = okT; last = true; }   // open water, or it would end afloat
          }
        } else if (ship) {
          if (!landAt(px, py) || nearWater(px, py)) okT = t1; else { t1 = okT; last = true; }
        } else okT = t1;
        t = t1;
        if (last) break;
      }
      const px = Math.round((o.x + ux * t) * 100) / 100, py = Math.round((o.y + uy * t) * 100) / 100;
      poly.push(px, py);
      if (px < out[0]) out[0] = px; if (py < out[1]) out[1] = py; if (px > out[2]) out[2] = px; if (py > out[3]) out[3] = py;
    }
    return { poly, bbox: out };
  }

  /** Is (x, y) inside a reach polygon? */
  function contains(r, x, y) {
    if (!r) return false;
    const [x0, y0, x1, y1] = r.bbox;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const p = r.poly;
    let c = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      if ((p[i + 1] > y) !== (p[j + 1] > y) && x < (p[j] - p[i]) * (y - p[i + 1]) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
    }
    return c;
  }

  return { loadMask, ready, landAt, compute, contains };
})();
window.Reach = Reach;
