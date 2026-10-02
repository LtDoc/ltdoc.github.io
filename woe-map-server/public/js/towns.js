'use strict';
/* global PIXI */

/**
 * Towns drawn from above, at map scale, under the counters: each town marker (capital, city or village) is grown
 * procedurally from its name, so it always looks the same.
 *
 *   - Main roads leave the centre in every direction, bending as they go, and run on out into the country; capitals
 *     have two ring boulevards, cities one.
 *   - Side streets branch off the main roads and rings every half a map px, and lanes off those, so the old town is a
 *     dense, irregular web; it thins out towards the edge, where only the main roads keep a ribbon of houses.
 *   - Houses line every street, up to four rows deep in the centre, set back a little, roofs pitched (a shaded half);
 *     the old centre is filled in with bigger blocks. A square at the heart (a green in a village), a cathedral or
 *     church beside it, parks in a capital.
 *   - Round the town, a patchwork of fields on a rough polar grid (shared corners, so they tile like a real
 *     enclosure map): wheat, stubble, young crops, pasture, ploughed land and woodland, hedged, with furrows and
 *     trees along the hedges; villages sit in the middle of a wide spread of them, towns and capitals ring theirs.
 *
 *   TownArt.plan(marker, isLand)              → plan (local coordinates, map px): pure and deterministic
 *   TownArt.draw(plan, damageOf, detail)      → PIXI.Graphics; damageOf(building) 0 intact, 1 burnt-out, 2 rubble;
 *                                               detail false: a cheaper drawing for zoomed-out views
 *
 * Purely visual: nothing here affects the game.
 */
const TownArt = (() => {
  // Each kind, in map px: R the built-up radius; main roads; ring roads (fractions of R); a side street every `lane`
  // along the main roads and rings; house frontage; rows of houses at most; parks; the square's radius; the ring of
  // fields round it (multiples of R).
  const KINDS = {
    capital: { R: 10, roads: 8, rings: [0.33, 0.68], lane: 0.5, front: [0.15, 0.3], rows: 4, parks: 3, square: 0.75, fields: [0.7, 1.55] },
    city: { R: 5, roads: 6, rings: [0.5], lane: 0.5, front: [0.14, 0.26], rows: 3, parks: 1, square: 0.5, fields: [0.7, 1.7] },
    village: { R: 1.5, roads: 3, rings: [], lane: 0.65, front: [0.13, 0.2], rows: 1, parks: 0, square: 0.2, fields: [0.5, 3.3] },
  };
  // Roofs: terracotta, slate, weathered brown, tile red, lead grey, dark tile; [roof, the shaded side of the ridge].
  const ROOFS = [[0xa4553c, 0x7f3f2c], [0x5f646b, 0x474b51], [0x8a6a4c, 0x6a5038], [0xb06848, 0x87503a], [0x707272, 0x555757], [0x96503a, 0x733d2c]];
  const CROPS = [
    { c: 0xc9b062, furrow: 0x9f8a48 },   // ripe wheat
    { c: 0xd6c27a, furrow: 0xb09c58 },   // stubble
    { c: 0x7f9a4a, furrow: 0x667d3a },   // young crop
    { c: 0x93a85a, furrow: null },       // pasture
    { c: 0x8a6c49, furrow: 0x6c533a },   // ploughed
    { c: 0xa4b866, furrow: null },       // meadow
    { c: 0xb7a35a, furrow: 0x957f42 },   // barley
  ];

  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function hashStr(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  const rect = (x, y, w, h, a) => {
    const c = Math.cos(a), s = Math.sin(a), hw = w / 2, hh = h / 2;
    return [x - c * hw + s * hh, y - s * hw - c * hh, x + c * hw + s * hh, y + s * hw - c * hh, x + c * hw - s * hh, y + s * hw + c * hh, x - c * hw - s * hh, y - s * hw + c * hh];
  };

  /** A town's plan: streets, buildings, square, church, parks, fields and trees, in map px about its centre. */
  function plan(m, isLand = () => true) {
    const kind = KINDS[m.data?.size] ? m.data.size : 'village', K = KINDS[kind];
    const rnd = rng(hashStr(`${m.name}|${m.id}`)), R = K.R * (0.88 + rnd() * 0.24);
    const land = (x, y) => isLand(m.x + x, m.y + y);
    const streets = [], buildings = [], fields = [], parks = [], trees = [];
    // Footprints of everything placed (circles on a grid), so nothing overlaps; and the streets, sampled.
    const CELL = 0.5, key = (x, y) => (Math.floor(x / CELL) + 4096) * 8192 + Math.floor(y / CELL) + 4096;
    const taken = new Map(), road = new Map();
    const near = (grid, x, y, r, pad) => {
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), n = Math.ceil((r + pad) / CELL);
      for (let i = cx - n; i <= cx + n; i++) for (let j = cy - n; j <= cy + n; j++) { const l = grid.get((i + 4096) * 8192 + j + 4096); if (l) for (const o of l) { const dx = o.x - x, dy = o.y - y, rr = o.r + r; if (dx * dx + dy * dy < rr * rr) return true; } }
      return false;
    };
    const put = (grid, x, y, r) => { const k = key(x, y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push({ x, y, r }); };

    // ---- Streets ----
    const wander = (x, y, a, len, steps, bend) => {
      const pts = [[x, y]];
      for (let i = 0; i < steps; i++) { a += (rnd() - 0.5) * bend; x += Math.cos(a) * len / steps; y += Math.sin(a) * len / steps; pts.push([x, y]); }
      return pts;
    };
    const addStreet = (pts, w, type) => {
      // Roads stop at the shore.
      const wet = pts.findIndex(p => !land(p[0], p[1]));
      if (wet === 0 || wet === 1) return;
      if (wet > 0) pts = pts.slice(0, wet);
      streets.push({ pts, w, type });
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.05));
        for (let j = 0; j <= n; j++) put(road, x0 + (x1 - x0) * j / n, y0 + (y1 - y0) * j / n, w / 2 + 0.015);
      }
    };
    const a0 = rnd() * Math.PI * 2, outer = R * K.fields[1] * 1.08;
    const mainW = kind === 'capital' ? 0.1 : kind === 'city' ? 0.08 : 0.065;
    for (let i = 0; i < K.roads; i++) {
      // A main road through the town, then on out into the country as a narrower road.
      const a = a0 + i * Math.PI * 2 / K.roads + (rnd() - 0.5) * 0.6;
      const town = wander(0, 0, a, R * (0.9 + rnd() * 0.2), 14, 0.22), [ex, ey] = town[town.length - 1], [px, py] = town[town.length - 2];
      addStreet(town, mainW, 'main');
      addStreet(wander(ex, ey, Math.atan2(ey - py, ex - px), Math.max(0.5, outer - Math.hypot(ex, ey)), 8, 0.3), 0.045, 'country');
    }
    for (const f of K.rings) {
      const pts = [], rr = R * f, wob = rnd() * 9;
      for (let i = 0; i <= 40; i++) { const a = i / 40 * Math.PI * 2, r = rr * (1 + 0.12 * Math.sin(a * 3 + wob) + 0.05 * Math.sin(a * 7 + wob * 2)); pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
      addStreet(pts, mainW * 0.9, 'main');
    }
    // Side streets off the main roads and rings, and lanes off those.
    const sideW = kind === 'village' ? 0.04 : 0.05;
    for (const st of streets.filter(s => s.type === 'main')) {
      let carry = rnd() * K.lane;
      for (let i = 1; i < st.pts.length; i++) {
        const [x0, y0] = st.pts[i - 1], [x1, y1] = st.pts[i], seg = Math.hypot(x1 - x0, y1 - y0);
        for (let t = carry; t < seg; t += K.lane * (0.7 + rnd() * 0.6)) {
          const x = x0 + (x1 - x0) * t / seg, y = y0 + (y1 - y0) * t / seg, r = Math.hypot(x, y) / R;
          if (r > 0.95 || r < 0.06 || rnd() < r * 0.6) continue;
          const dir = Math.atan2(y1 - y0, x1 - x0) + (rnd() < 0.5 ? 1 : -1) * (Math.PI / 2 + (rnd() - 0.5) * 0.4);
          const len = R * (0.06 + rnd() * 0.12) * (1.2 - r) + 0.25, pts = wander(x, y, dir, len, 4, 0.45);
          addStreet(pts, sideW, 'side');
          if (kind !== 'village' && rnd() < 0.55) {
            const [mx, my] = pts[2], la = dir + (rnd() < 0.5 ? 1 : -1) * Math.PI / 2;
            addStreet(wander(mx, my, la, 0.25 + rnd() * 0.45, 3, 0.4), sideW * 0.8, 'lane');
          }
        }
        carry = 0;
      }
    }

    // ---- The square (a green in a village), the church beside it, parks: kept clear of houses ----
    const square = { r: K.square * (0.85 + rnd() * 0.3), green: kind === 'village' };
    put(taken, 0, 0, square.r);
    const ca = rnd() * Math.PI * 2, cs = kind === 'capital' ? 0.85 : kind === 'city' ? 0.55 : 0.32;
    const church = { x: Math.cos(ca) * (square.r + cs * 0.55), y: Math.sin(ca) * (square.r + cs * 0.55), a: ca, s: cs, w: cs, h: cs * 0.5 };
    put(taken, church.x, church.y, cs * 0.6);
    for (let p = 0; p < K.parks; p++) {
      const a = rnd() * Math.PI * 2, r = R * (0.3 + rnd() * 0.35), x = Math.cos(a) * r, y = Math.sin(a) * r, s = R * (0.06 + rnd() * 0.05);
      if (!land(x, y) || near(taken, x, y, s, 0.3)) continue;
      parks.push({ x, y, s, wob: rnd() * 9 });
      put(taken, x, y, s);
      for (let t = 0; t < 22; t++) { const ta = rnd() * Math.PI * 2, tr = Math.sqrt(rnd()) * s * 0.85; trees.push({ x: x + Math.cos(ta) * tr, y: y + Math.sin(ta) * tr, r: 0.06 + rnd() * 0.06 }); }
    }

    // ---- Houses ----
    const palette = ROOFS.slice().sort(() => rnd() - 0.5).slice(0, 4);
    const house = (x, y, w, h, a, r) => {
      const fr = 0.42 * Math.min(w, h) + 0.12 * Math.max(w, h);
      if (near(taken, x, y, fr, 0.4) || near(road, x, y, Math.min(w, h) * 0.45, 0.2) || !land(x, y)) return false;
      put(taken, x, y, fr);
      buildings.push({ x, y, w, h, a, r, roof: palette[Math.floor(rnd() * rnd() * palette.length)] });   // the first colours most often
      return true;
    };
    for (const st of streets) {
      const country = st.type === 'country';
      for (let i = 1; i < st.pts.length; i++) {
        const [x0, y0] = st.pts[i - 1], [x1, y1] = st.pts[i], seg = Math.hypot(x1 - x0, y1 - y0);
        if (seg < 1e-6) continue;
        const ux = (x1 - x0) / seg, uy = (y1 - y0) / seg, nx = -uy, ny = ux, a = Math.atan2(uy, ux);
        let t = 0;
        while (t < seg) {
          const sx = x0 + ux * t, sy = y0 + uy * t, rr = Math.hypot(sx, sy) / R;
          const f = (K.front[0] + rnd() * (K.front[1] - K.front[0])) * (1 - 0.25 * Math.min(1, rr));
          t += f + 0.02;
          const rows = country ? 1 : Math.max(1, Math.round(K.rows * Math.pow(Math.max(0, 1 - rr), 0.6)));
          for (const side of [-1, 1]) {
            let off = st.w / 2 + 0.025;
            for (let k = 0; k < rows; k++) {
              const d = f * (0.8 + rnd() * 0.7), x = sx + nx * side * (off + d / 2), y = sy + ny * side * (off + d / 2), r = Math.hypot(x, y) / R;
              off += d + 0.02 + rnd() * 0.03;
              const p = country ? 0.05 : Math.max(0, Math.min(1, 1.3 - r * r * (st.type === 'main' ? 1.0 : 1.35))) * (k ? 0.85 : 1);
              if (rnd() > p) continue;
              house(x, y, f, d, a + (rnd() - 0.5) * 0.1, r);
            }
          }
        }
      }
    }
    // The old centre filled in between the streets: bigger blocks, set round the square.
    if (kind !== 'village') {
      for (let i = 0; i < (kind === 'capital' ? 2600 : 800); i++) {
        const a = rnd() * Math.PI * 2, r = R * 0.6 * Math.sqrt(rnd()), x = Math.cos(a) * r, y = Math.sin(a) * r;
        const f = K.front[1] * (0.9 + rnd() * 0.9), d = f * (0.6 + rnd() * 0.6);
        house(x, y, f, d, a + Math.PI / 2 + (rnd() - 0.5) * 0.3, r / R);
      }
    }
    // Farms out in the country: a farmhouse and a barn or two, by a road or alone in the fields.
    const farms = kind === 'village' ? 6 : kind === 'city' ? 8 : 12;
    for (let i = 0; i < farms; i++) {
      const a = rnd() * Math.PI * 2, r = R * (K.fields[0] + rnd() * (K.fields[1] - K.fields[0])), x = Math.cos(a) * r, y = Math.sin(a) * r, fa = rnd() * Math.PI;
      if (house(x, y, 0.2, 0.13, fa, 2)) {
        house(x + Math.cos(fa + 1.3) * 0.26, y + Math.sin(fa + 1.3) * 0.26, 0.26, 0.15, fa + Math.PI / 2, 2);
        if (rnd() < 0.5) house(x + Math.cos(fa - 1.6) * 0.24, y + Math.sin(fa - 1.6) * 0.24, 0.18, 0.12, fa, 2);
        for (let t = 0; t < 4; t++) trees.push({ x: x + (rnd() - 0.5) * 0.7, y: y + (rnd() - 0.5) * 0.7, r: 0.06 + rnd() * 0.05 });
      }
    }

    // ---- Fields: a patchwork on a rough polar grid with shared corners, so neighbouring fields meet; each ring of
    // corners turned a little from the last, so the fields lean every way rather than all pointing at the town. They
    // start where the houses stop (any field with a house on it is left out) and fray out at the far edge. ----
    // Farmland is not a ring: how far it reaches varies round the town in a few broad lobes, furthest out along the
    // roads (farms follow them), so its edge wanders and the town sits off-centre in its fields.
    const lobes = [1, 2, 3, 5].map(n => ({ n, amp: (0.5 + rnd()) / n, ph: rnd() * Math.PI * 2 }));
    const roadDirs = streets.filter(st => st.type === 'country').map(st => { const p = st.pts[st.pts.length - 1]; return Math.atan2(p[1], p[0]); });
    const reachAt = a => {
      let v = 0;
      for (const l of lobes) v += Math.sin(a * l.n + l.ph) * l.amp;
      let road = 0;
      for (const d of roadDirs) { const x = Math.atan2(Math.sin(a - d), Math.cos(a - d)); road = Math.max(road, Math.exp(-x * x / 0.08)); }
      return Math.max(0.1, 0.42 + v * 0.3 + road * 0.5);   // fraction of the way out to the far limit
    };
    const r0 = R * K.fields[0], r1 = R * K.fields[1] * 1.2, rings = Math.max(2, Math.round((r1 - r0) / 0.8));
    const sectors = Math.max(10, Math.round(Math.PI * (r0 + r1) / 0.9)), dr = (r1 - r0) / rings, da = Math.PI * 2 / sectors;
    const lat = [];
    let turn = 0;
    for (let k = 0; k <= rings; k++) {
      lat.push([]);
      turn += (rnd() - 0.5) * 0.9;
      for (let j = 0; j < sectors; j++) {
        const rr = r0 + dr * k + (k && k < rings ? (rnd() - 0.5) * dr * 0.5 : (rnd() - 0.5) * dr * 0.2), aa = a0 + da * (j + turn + (rnd() - 0.5) * 0.45);
        lat[k].push([Math.cos(aa) * rr, Math.sin(aa) * rr]);
      }
    }
    for (let k = 0; k < rings; k++) for (let j = 0; j < sectors; j++) {
      const c = [lat[k][j], lat[k][(j + 1) % sectors], lat[k + 1][(j + 1) % sectors], lat[k + 1][j]];
      const mid = lerp2(c, 0.5, 0.5);
      if ([...c, mid].some(p => near(taken, p[0], p[1], 0.08, 0.4)) || !c.every(p => land(p[0], p[1]))) continue;
      // Beyond the farmland's reach in this direction: open country (a field or two still straggles out).
      const out = (Math.hypot(mid[0], mid[1]) - r0) / (r1 - r0), lim = reachAt(Math.atan2(mid[1], mid[0]));
      if (out > lim + (rnd() - 0.5) * 0.15 && rnd() > 0.04) continue;
      if (rnd() < 0.16) continue;   // rough ground here and there
      const wood = rnd() < 0.1;
      // Some are divided into strips, as old open fields were.
      // Wide fields (out where the grid's wedges open up) are always divided, so none is too big.
      const across = Math.hypot(c[2][0] - c[3][0], c[2][1] - c[3][1]);
      const strips = wood ? 1 : Math.max(rnd() < (kind === 'village' ? 0.4 : 0.2) ? 2 + Math.floor(rnd() * 2) : 1, Math.round(across / 0.75));
      for (let s = 0; s < strips; s++) {
        const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        const q = strips === 1 ? c : [lerp(c[0], c[1], s / strips), lerp(c[0], c[1], (s + 1) / strips), lerp(c[3], c[2], (s + 1) / strips), lerp(c[3], c[2], s / strips)];
        fields.push({ pts: q.flat(), crop: wood ? null : CROPS[Math.floor(rnd() * CROPS.length)], wood });
      }
      if (wood) for (let t = 0; t < 12; t++) { const u = rnd(), v = rnd(), p = lerp2(c, u, v); trees.push({ x: p[0], y: p[1], r: 0.07 + rnd() * 0.06 }); }
      else for (let e = 0; e < 4; e++) if (rnd() < 0.3) { const p = c[e], q = c[(e + 1) % 4], u = rnd(); trees.push({ x: p[0] + (q[0] - p[0]) * u, y: p[1] + (q[1] - p[1]) * u, r: 0.06 + rnd() * 0.04 }); }
    }
    return { x: m.x, y: m.y, kind, R, reach: Math.max(r1, outer) + 0.5, streets, buildings, fields, parks, trees, square, church };
  }
  // A point inside a quad at (u, v).
  function lerp2(c, u, v) {
    const a = [c[0][0] + (c[1][0] - c[0][0]) * u, c[0][1] + (c[1][1] - c[0][1]) * u], b = [c[3][0] + (c[2][0] - c[3][0]) * u, c[3][1] + (c[2][1] - c[3][1]) * u];
    return [a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v];
  }

  /** Draw a plan. damageOf(building) → 0 intact, 1 burnt-out shell, 2 rubble. `detail` false: the zoomed-out version. */
  function draw(p, damageOf = () => 0, detail = true) {
    const g = new PIXI.Graphics();
    // Fields, with furrows and hedges; woods.
    for (const f of p.fields) {
      g.poly(f.pts).fill({ color: f.wood ? 0x506d34 : f.crop.c, alpha: 0.9 });
      if (!detail) continue;
      if (f.crop?.furrow) {
        const P = f.pts, n = 5;
        for (let i = 1; i < n; i++) {
          const t = i / n;
          g.moveTo(P[0] + (P[6] - P[0]) * t, P[1] + (P[7] - P[1]) * t).lineTo(P[2] + (P[4] - P[2]) * t, P[3] + (P[5] - P[3]) * t);
        }
        g.stroke({ width: 0.014, color: f.crop.furrow, alpha: 0.5 });
      }
      g.poly(f.pts).stroke({ width: 0.035, color: 0x4b6531, alpha: 0.8, join: 'round' });
    }
    // The built-up ground: a soft greyish blotch along the town's streets, giving it its outline.
    for (const st of p.streets) {
      if (st.type === 'country' || st.type === 'lane') continue;
      for (let i = 0; i < st.pts.length; i += 2) {
        const [x, y] = st.pts[i], r = Math.hypot(x, y) / p.R;
        if (r > 1.05) continue;
        g.circle(x, y, (st.type === 'main' ? 0.5 : 0.38) * (1.15 - Math.min(1, r) * 0.5) * (p.kind === 'village' ? 0.7 : 1)).fill({ color: 0x8f8676, alpha: 0.14 });
      }
    }
    for (const pk of p.parks) {
      const pts = [];
      for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2, r = pk.s * (1 + 0.15 * Math.sin(a * 3 + pk.wob)); pts.push(pk.x + Math.cos(a) * r, pk.y + Math.sin(a) * r); }
      g.poly(pts).fill({ color: 0x6c8c43, alpha: 0.95 });
    }
    // Streets: a darker kerb, then the road; country roads as dirt tracks.
    for (const kerb of detail ? [true, false] : [false]) for (const st of p.streets) {
      if (!detail && st.type === 'lane') continue;
      g.moveTo(st.pts[0][0], st.pts[0][1]);
      for (let i = 1; i < st.pts.length; i++) g.lineTo(st.pts[i][0], st.pts[i][1]);
      const color = st.type === 'country' ? 0x9b8a6a : st.type === 'main' ? 0xa79c86 : 0x9a8f7a;
      g.stroke(kerb ? { width: st.w * 1.45, color: 0x5f574a, alpha: 0.45, cap: 'round', join: 'round' } : { width: st.w, color, alpha: 0.95, cap: 'round', join: 'round' });
    }
    // The square (with a fountain or a statue), or the village green.
    if (p.square.green) g.circle(0, 0, p.square.r).fill({ color: 0x7d9a4c });
    else g.circle(0, 0, p.square.r).fill({ color: 0xb8ad94 }).circle(0, 0, p.square.r * 0.14).fill({ color: 0x7f8b80 });
    // Houses: a shadow, the roof and its shaded half; burnt-out shells and rubble where shells fell.
    const rubble = [];
    for (const b of p.buildings) {
      const dmg = damageOf(b);
      if (dmg === 2) { rubble.push(b); continue; }
      if (detail) g.poly(rect(b.x + 0.025, b.y + 0.035, b.w, b.h, b.a)).fill({ color: 0x1d1a16, alpha: 0.38 });
      if (dmg === 1) {
        g.poly(rect(b.x, b.y, b.w, b.h, b.a)).fill({ color: 0x7a7066 });
        g.poly(rect(b.x, b.y, b.w * 0.74, b.h * 0.66, b.a)).fill({ color: 0x29231f });
        continue;
      }
      g.poly(rect(b.x, b.y, b.w, b.h, b.a)).fill({ color: b.roof[0] });
      if (detail) { const c = Math.cos(b.a), s = Math.sin(b.a); g.poly(rect(b.x - s * b.h / 4, b.y + c * b.h / 4, b.w, b.h / 2, b.a)).fill({ color: b.roof[1] }); }
    }
    for (const b of rubble) {
      // A low ragged heap of brick and stone, spilling into the street.
      const pts = [];
      for (let i = 0; i < 7; i++) { const a = b.a + i / 7 * Math.PI * 2, r = Math.max(b.w, b.h) * (0.45 + 0.22 * Math.sin(i * 2.3 + b.x * 9)); pts.push(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r); }
      g.poly(pts).fill({ color: 0x7b7064, alpha: 0.95 });
      if (detail) g.circle(b.x + b.w * 0.15, b.y - b.h * 0.1, Math.min(b.w, b.h) * 0.24).fill({ color: 0x4a4138 }).circle(b.x - b.w * 0.2, b.y + b.h * 0.15, Math.min(b.w, b.h) * 0.17).fill({ color: 0x9d917f });
    }
    {
      // The cathedral or church: a long nave crossed by transepts, slate-roofed, with its tower at the west end.
      const { x, y, a, s } = p.church, c = Math.cos(a), sn = Math.sin(a), dmg = damageOf(p.church);
      const roof = dmg ? 0x29231f : 0x4c535b, wall = dmg ? 0x7a7066 : 0x3a4047;
      if (dmg < 2) {
        g.poly(rect(x + 0.04, y + 0.05, s, s * 0.3, a)).fill({ color: 0x1d1a16, alpha: 0.38 });
        g.poly(rect(x, y, s, s * 0.3, a)).fill({ color: wall });
        g.poly(rect(x + c * s * 0.14, y + sn * s * 0.14, s * 0.24, s * 0.68, a)).fill({ color: wall });
        g.poly(rect(x, y, s * 0.95, s * 0.19, a)).fill({ color: roof });
        g.poly(rect(x + c * s * 0.14, y + sn * s * 0.14, s * 0.15, s * 0.62, a)).fill({ color: roof });
      }
      g.poly(rect(x - c * s * 0.46, y - sn * s * 0.46, s * 0.17, s * 0.17, a)).fill({ color: dmg ? 0x5a5249 : 0x6b6f72 });
    }
    // Trees (parks, hedgerows, woods, farmyards): a shadow and a crown.
    if (detail) for (const t of p.trees) g.circle(t.x + 0.02, t.y + 0.025, t.r).fill({ color: 0x1d2a12, alpha: 0.35 }).circle(t.x, t.y, t.r).fill({ color: 0x46622c });
    else for (const t of p.trees) g.circle(t.x, t.y, t.r).fill({ color: 0x46622c });
    return g;
  }

  return { plan, draw, KINDS };
})();
window.TownArt = TownArt;
