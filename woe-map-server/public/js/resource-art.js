'use strict';
/* global PIXI */

/**
 * Resource nodes drawn from above, at map scale, under the towns: each node grows the works of its resource
 * procedurally from its name, so it always looks the same, and grows with its yield and its improvements
 * (docs/ECONOMY.md, Resource works).
 *
 *   - Grain: a village at the heart of the estate and farmsteads round it, working a patchwork of fields: one grid
 *     of rough oblongs over the whole estate, gently warped so its rows bend, some fields two long, some in strips,
 *     hedged, its edge ragged. Ripe fields are painted with the wheat textures (public/sprites/fields), turned to run
 *     the way the field does. Machine sheds, granaries and a rail siding come with the works.
 *   - Cotton: the same, planted in rows, with gin houses and cabins (irrigation canals, a baling press).
 *   - Horses: fenced paddocks with horses in them, stables round a yard, an exercise ring (remount depot).
 *   - Rubber: plantation blocks in a grid, laterite tracks, labour lines, jungle round the edge.
 *   - Timber: forest with clear-cut patches, stumps and log stacks, logging tracks, a sawmill by its log pond
 *     (logging railway, pulp mill).
 *   - Coal: pit heads (headframe, engine house, chimney), black spoil heaps, miners' terraces, a railway with
 *     sidings (coking ovens, a marshalling yard).
 *   - Iron and copper: stepped open pits with a haul road down, waste dumps, crushers; copper's tailings ponds
 *     (steam shovels, ore railway, blast furnaces or a smelter).
 *   - Oil: leases crowded with derricks in rows over oil-soaked ground, a tank farm, pipelines (a refinery, its flare).
 *   - Nitrates: pale desert diggings, oficinas with their leaching vats and chimneys, spent-ore heaps, a railway.
 *
 *   ResourceArt.plan(marker, isLand, isFree) → plan (local coordinates, map px): pure and deterministic. isFree(x, y)
 *                                              is false on ground taken by a town (its streets and houses).
 *   ResourceArt.draw(plan, detail, textures) → PIXI.Graphics; detail false: a cheaper drawing for zoomed-out views
 *   ResourceArt.textures()                   → Promise of the field textures (loaded once), or null
 *   ResourceArt.radius(marker)               → about how far the works reach (map px)
 *
 * Purely visual: nothing here affects the game.
 */
const ResourceArt = (() => {
  const TAU = Math.PI * 2;
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function hashStr(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  const rect = (x, y, w, h, a) => {
    const c = Math.cos(a), s = Math.sin(a), hw = w / 2, hh = h / 2;
    return [x - c * hw + s * hh, y - s * hw - c * hh, x + c * hw + s * hh, y + s * hw - c * hh, x + c * hw - s * hh, y + s * hw + c * hh, x - c * hw - s * hh, y - s * hw + c * hh];
  };
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const KINDS = ['grain', 'coal', 'iron', 'oil', 'copper', 'rubber', 'nitrates', 'timber', 'cotton', 'horses'];
  const levelOf = m => Math.max(0, Math.min(3, Math.round(Number(m.data?.improved) || 0)));

  /** How far a node's works reach (map px): more with its yield, a little more with each improvement. */
  function radius(m) {
    const y = Math.max(0.5, Number(m.data?.yield) || 1);
    return (2.2 + 1.5 * Math.sqrt(y)) * (1 + 0.15 * levelOf(m));
  }

  // Roofs: [roof, the shaded side]. Farm (tile and thatch), works (slate, tar, corrugated iron), huts.
  const ROOF = {
    farm: [[0xa4553c, 0x7f3f2c], [0x8a6a4c, 0x6a5038], [0xb79d6a, 0x8e7a50], [0x96503a, 0x733d2c]],
    works: [[0x5f646b, 0x474b51], [0x4a4744, 0x34322f], [0x8b8f8e, 0x6c706f], [0x7a4a3a, 0x5a362a]],
    hut: [[0xb59a68, 0x8d774f], [0x9c8a66, 0x7a6a4c], [0x8b8f8e, 0x6c706f]],
  };

  // ---- Plan ---------------------------------------------------------------------------------------------------
  function plan(m, isLand = () => true, isFree = () => true) {
    const kind = KINDS.includes(m.data?.kind) ? m.data.kind : 'grain';
    const lvl = levelOf(m), yieldN = Math.max(0.5, Number(m.data?.yield) || 1);
    const rnd = rng(hashStr(`${m.name}|${m.id}|${kind}`));
    const R = radius(m) * (0.9 + rnd() * 0.2);
    // The site's outline: a blob with a few broad lobes, so no two look alike and none is round.
    const lobes = [1, 2, 3, 5].map(n => ({ n, amp: (0.35 + rnd() * 0.5) / n, ph: rnd() * TAU }));
    const edge = a => { let v = 0; for (const l of lobes) v += Math.sin(a * l.n + l.ph) * l.amp; return R * Math.max(0.45, 0.85 + v * 0.35); };
    const within = (x, y, k = 1) => Math.hypot(x, y) <= edge(Math.atan2(y, x)) * k;
    const ok = (x, y) => isLand(m.x + x, m.y + y) && isFree(m.x + x, m.y + y);
    const items = [];
    // Footprints of everything placed (circles on a grid), so nothing overlaps.
    const CELL = 0.5, taken = new Map();
    const key = (i, j) => (i + 4096) * 8192 + j + 4096;
    const clear = (x, y, r) => {
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), n = Math.ceil((r + 0.6) / CELL);
      for (let i = cx - n; i <= cx + n; i++) for (let j = cy - n; j <= cy + n; j++) {
        const l = taken.get(key(i, j));
        if (l) for (const o of l) if (Math.hypot(o.x - x, o.y - y) < o.r + r) return false;
      }
      return true;
    };
    const take = (x, y, r) => { const k = key(Math.floor(x / CELL), Math.floor(y / CELL)); if (!taken.has(k)) taken.set(k, []); taken.get(k).push({ x, y, r }); };
    const c = {
      rnd, R, lvl, yieldN, ok, within, edge, clear, take,
      poly: (z, pts, color, extra = {}) => items.push({ t: 'poly', z, pts, color, ...extra }),
      line: (z, pts, w, color, extra = {}) => { if (pts.length > 1) items.push({ t: 'line', z, pts, w, color, ...extra }); },
      rail: (z, pts) => { if (pts.length > 1) items.push({ t: 'rail', z, pts }); },
      circle: (z, x, y, r, color, extra = {}) => items.push({ t: 'circle', z, x, y, r, color, ...extra }),
      mark: (z, t, x, y, s, a, extra = {}) => items.push({ t, z, x, y, s, a, ...extra }),
      /** A building: a roof (shaded half) with a shadow, if the ground is free. */
      house(x, y, w, h, a, roof, pad = 0.04) {
        const r = 0.5 * Math.hypot(w, h);
        if (!ok(x, y) || !clear(x, y, r + pad)) return false;
        take(x, y, r);
        items.push({ t: 'rect', z: 60, x, y, w, h, a, roof });
        return true;
      },
      /**
       * A block of n long buildings side by side (terraces, labour lines, stables): the block's ground is checked and
       * taken once, so its rows do not crowd each other out. Returns whether it was built.
       */
      rows(x, y, a, n, len, depth, gap, roofs, pad = 0.05) {
        const r = 0.5 * Math.hypot(len, n * gap);
        const cx = x - Math.sin(a) * (n - 1) * gap / 2, cy = y + Math.cos(a) * (n - 1) * gap / 2;
        if (!ok(cx, cy) || !within(cx, cy, 1.05) || !clear(cx, cy, r + pad)) return false;
        take(cx, cy, r);
        for (let i = 0; i < n; i++) {
          const rx = x - Math.sin(a) * i * gap, ry = y + Math.cos(a) * i * gap;
          if (ok(rx, ry)) items.push({ t: 'rect', z: 60, x: rx, y: ry, w: len, h: depth, a, roof: roofs[i % roofs.length] });
        }
        return true;
      },
      /** A wandering line from (x, y) heading a, cut where it leaves the land or the site (k × its outline). */
      wander(x, y, a, len, steps, bend, k = 1.25) {
        const pts = [[x, y]];
        for (let i = 0; i < steps; i++) {
          a += (rnd() - 0.5) * bend; x += Math.cos(a) * len / steps; y += Math.sin(a) * len / steps;
          if (!ok(x, y) || !within(x, y, k)) break;
          pts.push([x, y]);
        }
        return pts;
      },
      /** A line from p to q that bends a little on the way. */
      path(p, q, steps = 6, wob = 0.18) {
        const pts = [p], d = Math.hypot(q[0] - p[0], q[1] - p[1]), nx = -(q[1] - p[1]) / (d || 1), ny = (q[0] - p[0]) / (d || 1), ph = rnd() * TAU;
        for (let i = 1; i < steps; i++) { const t = i / steps, o = Math.sin(t * Math.PI * 2 + ph) * d * wob * (rnd() * 0.5 + 0.5) * Math.sin(t * Math.PI); pts.push([p[0] + (q[0] - p[0]) * t + nx * o, p[1] + (q[1] - p[1]) * t + ny * o]); }
        pts.push(q);
        return pts;
      },
      /** An irregular blob of n points. */
      blob(x, y, r, n = 10, wob = 0.25) {
        const ph = rnd() * TAU, ph2 = rnd() * TAU, pts = [];
        for (let i = 0; i < n; i++) { const a = i / n * TAU, rr = r * (1 + wob * Math.sin(a * 2 + ph) * 0.6 + wob * Math.sin(a * 3 + ph2) * 0.4 + (rnd() - 0.5) * wob * 0.5); pts.push(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
        return pts;
      },
      /**
       * A free spot inside the site, at most `rMax` (fraction of R) out, with `room` around it; null if none. When
       * nothing near the middle is free (a node on a city), the search widens to the whole site.
       */
      spot(room, rMax = 0.8, tries = 40) {
        for (let i = 0; i < tries * 2; i++) {
          const reach = i < tries ? rMax : Math.max(rMax, 0.95);
          const a = rnd() * TAU, r = Math.sqrt(rnd()) * R * reach, x = Math.cos(a) * r, y = Math.sin(a) * r;
          if (within(x, y) && ok(x, y) && clear(x, y, room)) return [x, y];
        }
        return null;
      },
      /** Trees: a shadow and a crown. */
      tree(x, y, r, color = 0x46622c) { if (ok(x, y)) items.push({ t: 'tree', z: 70, x, y, r, color }); },
    };
    // The ground the works stand on, tinted by what is worked there.
    const tint = GROUND[kind];
    if (tint) {
      // Pulled in from the sea along each ray, so a coastal field does not spill over the water.
      const pts = [];
      for (let i = 0; i < 48; i++) {
        const a = i / 48 * TAU;
        let r = edge(a) * 1.05;
        while (r > R * 0.1 && !isLand(m.x + Math.cos(a) * r, m.y + Math.sin(a) * r)) r *= 0.9;
        pts.push(Math.cos(a) * r, Math.sin(a) * r);
      }
      c.poly(1, pts, tint.c, { alpha: tint.a });
    }
    BUILD[kind](c);
    items.sort((a, b) => a.z - b.z);
    return { x: m.x, y: m.y, kind, R, lvl, reach: R * 1.35 + 0.5, items };
  }
  const GROUND = {
    coal: { c: 0x4a4744, a: 0.22 }, iron: { c: 0x8d5a3c, a: 0.2 }, copper: { c: 0xa08a5c, a: 0.22 }, oil: { c: 0x6e6050, a: 0.22 },
    nitrates: { c: 0xd9ceb0, a: 0.45 }, timber: { c: 0x3d5a2a, a: 0.85 }, rubber: { c: 0x2f4a24, a: 0.55 },
  };

  // ---- Farmland: farms with their fields (grain, cotton, horses, rubber) -----------------------------------
  /**
   * Farmsteads over the site (the first a hamlet, for `village`), each working the fields nearest it. `crop(rnd, hub,
   * quad)` gives each field's look: { color, tex?, tint?, rows?, edge? }. Returns the farms.
   */
  function farmland(c, { hubs, spacing = 0.32, cell = 1.0, yard = 0.3, crop, farm, village = false }) {
    const H = [];
    for (let tries = 0; H.length < hubs && tries < hubs * 40; tries++) {
      // The first farm near the middle (further out when a town has the middle), the rest anywhere.
      const a = c.rnd() * TAU, r = H.length ? Math.sqrt(c.rnd()) * c.R * 0.78 : c.rnd() * c.R * Math.min(0.8, 0.25 + tries * 0.02), x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (!c.ok(x, y) || !c.within(x, y, 0.9) || H.some(h => Math.hypot(h.x - x, h.y - y) < c.R * spacing)) continue;
      H.push({ x, y, i: H.length });
    }
    if (!H.length) return H;
    // The first farm is the estate's village (where it has one); the rest are farmsteads.
    for (const h of H) {
      if (village && h.i === 0) { c.take(h.x, h.y, 0.85); hamlet(c, h); }
      else { c.take(h.x, h.y, yard); farm?.(h); }
    }
    // Tracks: each farm to the nearest one placed before it, and two or three out into the country.
    for (const h of H.slice(1)) {
      let b = H[0];
      for (const o of H) if (o.i < h.i && Math.hypot(o.x - h.x, o.y - h.y) < Math.hypot(b.x - h.x, b.y - h.y)) b = o;
      c.line(30, c.path([h.x, h.y], [b.x, b.y], 6, 0.12), 0.045, 0x9b8a6a, { alpha: 0.95 });
    }
    for (let i = 0; i < 2 + (c.rnd() < 0.5 ? 1 : 0); i++) { const a = c.rnd() * TAU; c.line(30, c.wander(H[0].x, H[0].y, a, c.R * 1.3, 9, 0.35, 1.35), 0.05, 0x9b8a6a, { alpha: 0.95 }); }
    // The fields: one grid over the whole estate with shared, jittered corners, so they tile it like an enclosure map,
    // gently warped (its direction drifts across the estate) so the rows bend rather than run ruler-straight. Fields
    // are rough oblongs, some two long, some split into strips; each belongs to the farm nearest it.
    const th0 = c.rnd() * Math.PI, ph1 = c.rnd() * TAU, ph2 = c.rnd() * TAU;
    const L = cell * (1.15 + c.rnd() * 0.3), Wd = cell * (0.7 + c.rnd() * 0.2);   // a field's length and breadth
    const n = Math.ceil(c.R * 1.25 / Wd), jit = new Map();
    const corner = (i, j) => {
      const k = (i + 512) * 1024 + j + 512;
      if (!jit.has(k)) jit.set(k, [(c.rnd() - 0.5) * L * 0.28, (c.rnd() - 0.5) * Wd * 0.28]);
      const [ju, jv] = jit.get(k), u = i * L + ju, v = j * Wd + jv;
      const th = th0 + 0.32 * Math.sin(u * 0.22 + ph1) * Math.cos(v * 0.2 + ph2);
      return [Math.cos(th) * u - Math.sin(th) * v, Math.sin(th) * u + Math.cos(th) * v];
    };
    const used = new Set();
    for (let i = -n; i < n; i++) for (let j = -n; j < n; j++) {
      if (used.has(i * 4096 + j)) continue;
      // Some fields run two cells long.
      const long = c.rnd() < 0.3 && !used.has((i + 1) * 4096 + j) ? 2 : 1;
      const q = [corner(i, j), corner(i + long, j), corner(i + long, j + 1), corner(i, j + 1)];
      const mid = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
      if (!c.within(mid[0], mid[1]) || !q.every(p => c.ok(p[0], p[1]) && c.within(p[0], p[1], 1.08)) || !c.ok(mid[0], mid[1])) continue;
      if (!q.every(p => c.clear(p[0], p[1], 0.02)) || !c.clear(mid[0], mid[1], 0.15)) continue;
      for (let k = 0; k < long; k++) used.add((i + k) * 4096 + j);
      if (c.rnd() < 0.05) continue;   // rough ground here and there
      let h = H[0];
      for (const o of H) if (Math.hypot(o.x - mid[0], o.y - mid[1]) < Math.hypot(h.x - mid[0], h.y - mid[1])) h = o;
      // Some are split into strips along their length, as old open fields were.
      const strips = c.rnd() < 0.2 ? 2 + Math.floor(c.rnd() * 2) : 1;
      const a = Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]);
      for (let s = 0; s < strips; s++) {
        const f = strips === 1 ? q : [lerp(q[0], q[3], s / strips), lerp(q[1], q[2], s / strips), lerp(q[1], q[2], (s + 1) / strips), lerp(q[0], q[3], (s + 1) / strips)];
        const look = crop(c.rnd, h, f);
        if (!look) continue;
        // The way the field runs (its furrows and its crop): along its length.
        c.poly(10, f.flat(), look.color, { ...look, a, quad: true, ox: c.rnd() * 5, oy: c.rnd() * 5 });
      }
    }
    return H;
  }
  /** A hamlet at a crossroads: two lanes and a few houses along them, a church or chapel. */
  function hamlet(c, h, roofs = ROOF.farm) {
    const a0 = c.rnd() * Math.PI;
    for (const a of [a0, a0 + Math.PI / 2 + (c.rnd() - 0.5) * 0.5]) {
      const pts = [[h.x - Math.cos(a) * 0.75, h.y - Math.sin(a) * 0.75], [h.x, h.y], [h.x + Math.cos(a) * 0.75, h.y + Math.sin(a) * 0.75]];
      c.line(32, pts, 0.05, 0xa79c86);
      for (let t = -0.6; t <= 0.6; t += 0.17) {
        if (Math.abs(t) < 0.12) continue;
        for (const side of [-1, 1]) {
          if (c.rnd() < 0.3) continue;
          const x = h.x + Math.cos(a) * t - Math.sin(a) * side * 0.13, y = h.y + Math.sin(a) * t + Math.cos(a) * side * 0.13;
          houseAt(c, x, y, 0.13, 0.1, a + (c.rnd() - 0.5) * 0.1, roofs[Math.floor(c.rnd() * c.rnd() * roofs.length)]);
        }
      }
    }
    houseAt(c, h.x + Math.cos(a0 + 0.8) * 0.22, h.y + Math.sin(a0 + 0.8) * 0.22, 0.22, 0.09, a0, [0x4c535b, 0x3a4047]);
    for (let t = 0; t < 6; t++) c.tree(h.x + (c.rnd() - 0.5) * 1.3, h.y + (c.rnd() - 0.5) * 1.3, 0.06 + c.rnd() * 0.05);
  }
  /** A farmstead: house, barn and a shed round a yard, a few trees. */
  function farmstead(c, h, s = 1, roofs = ROOF.farm) {
    const fa = c.rnd() * Math.PI, roof = roofs[Math.floor(c.rnd() * roofs.length)];
    houseAt(c, h.x, h.y, 0.24 * s, 0.15 * s, fa, roof);
    houseAt(c, h.x + Math.cos(fa + 1.3) * 0.3 * s, h.y + Math.sin(fa + 1.3) * 0.3 * s, 0.34 * s, 0.18 * s, fa + Math.PI / 2, roofs[Math.floor(c.rnd() * roofs.length)]);
    if (c.rnd() < 0.6) houseAt(c, h.x + Math.cos(fa - 1.6) * 0.28 * s, h.y + Math.sin(fa - 1.6) * 0.28 * s, 0.2 * s, 0.13 * s, fa, roof);
    for (let t = 0; t < 4; t++) c.tree(h.x + (c.rnd() - 0.5) * 0.8 * s, h.y + (c.rnd() - 0.5) * 0.8 * s, 0.07 + c.rnd() * 0.05);
  }
  /** A building on ground already reserved (farm yards): no overlap check against its own yard. */
  function houseAt(c, x, y, w, h, a, roof) { if (c.ok(x, y)) c.mark(60, 'rect', x, y, 0, 0, { w, h, a, roof }); }
  /** Railway: from beyond the site's edge in through (x, y), with a siding and a goods shed. */
  function railIn(c, x, y, sheds = 1) {
    const a = c.rnd() * TAU, far = [x + Math.cos(a) * c.R * 1.4, y + Math.sin(a) * c.R * 1.4], on = [x - Math.cos(a) * c.R * 0.3, y - Math.sin(a) * c.R * 0.3];
    const main = c.path(far, on, 8, 0.08).filter(p => c.ok(p[0], p[1]));
    c.rail(40, main);
    // A siding alongside, and the goods shed by it.
    const nx = -Math.sin(a) * 0.14, ny = Math.cos(a) * 0.14;
    c.rail(40, [[x + Math.cos(a) * 0.9 + nx, y + Math.sin(a) * 0.9 + ny], [x - Math.cos(a) * 0.1 + nx, y - Math.sin(a) * 0.1 + ny]]);
    for (let i = 0; i < sheds; i++) c.house(x + Math.cos(a) * (0.35 + i * 0.4) + nx * 2.4, y + Math.sin(a) * (0.35 + i * 0.4) + ny * 2.4, 0.36, 0.16, a, ROOF.works[0]);
    return a;
  }

  // ---- Each resource --------------------------------------------------------------------------------------------
  const BUILD = {
    grain(c) {
      const hubs = farmland(c, {
        hubs: Math.min(10, 2 + Math.round(c.yieldN / 1.5) + c.lvl), cell: 1.05, village: true,
        farm: h => farmstead(c, h, 1),
        crop: rnd => {
          const r = rnd();
          if (r < 0.52) return { color: 0xdcc47a, tex: Math.floor(rnd() * 5), tint: [0xffffff, 0xf4e7c4, 0xe9dcb0, 0xfff3d6][Math.floor(rnd() * 4)], ts: 1.1 + rnd() * 0.5, edge: 'hedge' };
          if (r < 0.64) return { color: 0xd6c27a, rows: { c: 0xb09c58, n: 6 }, edge: 'hedge' };      // stubble
          if (r < 0.76) return { color: 0x8a6c49, rows: { c: 0x6c533a, n: 7 }, edge: 'hedge' };      // ploughed
          if (r < 0.88) return { color: 0x8fa04e, rows: { c: 0x6f8a3c, n: 6 }, edge: 'hedge' };      // young crop
          return { color: 0x93a85a, edge: 'hedge' };                                                  // pasture
        },
      });
      if (!hubs.length) return;
      const h0 = hubs[0];
      // Mechanised farms: machine sheds (corrugated iron) at the bigger farms.
      if (c.lvl >= 1) for (const h of hubs.slice(0, 4)) c.house(h.x + (c.rnd() - 0.5) * 0.9, h.y + (c.rnd() - 0.5) * 0.9, 0.4, 0.2, c.rnd() * Math.PI, ROOF.works[2], 0.02);
      // Granaries: a cluster of round silos by the main farm.
      if (c.lvl >= 2) {
        const a = c.rnd() * TAU, x = h0.x + Math.cos(a) * 0.65, y = h0.y + Math.sin(a) * 0.65;
        for (let i = 0; i < 5; i++) { const sx = x + (i % 3) * 0.17, sy = y + Math.floor(i / 3) * 0.17; if (c.ok(sx, sy)) c.circle(62, sx, sy, 0.075, 0xb3ada2, { rim: 0x6f6a62, shadow: true }); }
      }
      if (c.lvl >= 3) railIn(c, h0.x, h0.y, 2);
    },
    cotton(c) {
      const hubs = farmland(c, {
        hubs: Math.min(9, 2 + Math.round(c.yieldN / 1.6) + c.lvl), cell: 1.0, village: true,
        farm: h => {
          farmstead(c, h, 1.1, ROOF.hut);
          // Cabins in a row.
          const a = c.rnd() * TAU;
          for (let i = 0; i < 5; i++) houseAt(c, h.x + Math.cos(a) * (0.5 + i * 0.16), h.y + Math.sin(a) * (0.5 + i * 0.16), 0.1, 0.08, a, ROOF.hut[i % 3]);
        },
        crop: rnd => {
          const r = rnd();
          if (r < 0.7) return { color: 0x8f9a5c, rows: { c: 0xf1ece0, n: 9, w: 0.04, a: 0.85 }, edge: 'none' };   // cotton in boll
          if (r < 0.85) return { color: 0x9a6a46, rows: { c: 0x7c5236, n: 8 }, edge: 'none' };                  // red earth, ploughed
          return { color: 0x9aa060, edge: 'none' };
        },
      });
      if (!hubs.length) return;
      const h0 = hubs[0];
      c.house(h0.x + 0.6, h0.y - 0.3, 0.5, 0.3, 0.3, ROOF.works[2]);   // the gin house
      // Irrigation: canals along the tracks.
      if (c.lvl >= 2) for (let i = 0; i < 3; i++) c.line(25, c.wander(h0.x, h0.y, c.rnd() * TAU, c.R, 10, 0.25), 0.05, 0x5f8fa0, { alpha: 0.9 });
      if (c.lvl >= 3) { const a = railIn(c, h0.x, h0.y, 1); for (let i = 0; i < 6; i++) c.circle(64, h0.x + Math.cos(a + 1.2) * (0.5 + (i % 3) * 0.08), h0.y + Math.sin(a + 1.2) * (0.5 + (i % 3) * 0.08) + Math.floor(i / 3) * 0.08, 0.035, 0xeee8da, { d: 1 }); }
    },
    horses(c) {
      const hubs = farmland(c, {
        hubs: Math.min(8, 2 + Math.round(c.yieldN / 2) + c.lvl), cell: 0.85, yard: 0.45,
        farm: h => {
          // Stables round a yard.
          const a = c.rnd() * Math.PI, roof = ROOF.farm[Math.floor(c.rnd() * 4)];
          houseAt(c, h.x, h.y - 0.22, 0.5, 0.11, a, roof); houseAt(c, h.x - 0.2 * Math.cos(a), h.y + 0.05, 0.11, 0.4, a, roof);
          houseAt(c, h.x + 0.24, h.y + 0.12, 0.2, 0.14, a + 0.1, ROOF.farm[0]);
          for (let t = 0; t < 3; t++) c.tree(h.x + (c.rnd() - 0.5) * 0.9, h.y + (c.rnd() - 0.5) * 0.9, 0.07 + c.rnd() * 0.04);
        },
        crop: (rnd, h, f) => {
          // Paddocks, fenced, with a few horses grazing.
          const col = [0x8fae5a, 0x9bb562, 0x86a456, 0xa3b86a][Math.floor(rnd() * 4)];
          const n = Math.floor(rnd() * 4), horses = [];
          for (let i = 0; i < n; i++) {
            const u = 0.2 + rnd() * 0.6, v = 0.2 + rnd() * 0.6, p = lerp(lerp(f[0], f[1], u), lerp(f[3], f[2], u), v);
            horses.push([p[0], p[1], [0x5a3a24, 0x3a2a1e, 0x8a5a34, 0xd8d0c0][Math.floor(rnd() * 4)], rnd() * Math.PI]);
          }
          return { color: col, edge: 'fence', horses };
        },
      });
      if (!hubs.length) return;
      // The exercise ring by the main stud.
      const h0 = hubs[0], s = c.spot(0.3, 0.5);
      if (s) { c.take(s[0], s[1], 0.25); c.circle(58, s[0], s[1], 0.22, 0xc8b48a, { ring: 0.06 }); }
      if (c.lvl >= 3) {
        // Remount depot: rows of long stable sheds.
        const a = c.rnd() * TAU, x = h0.x + Math.cos(a) * 0.9, y = h0.y + Math.sin(a) * 0.9;
        c.rows(x, y, a, 4, 0.7, 0.1, 0.16, [ROOF.works[0]]);
        railIn(c, h0.x, h0.y, 1);
      }
    },
    rubber(c) {
      const hubs = farmland(c, {
        hubs: Math.min(7, 1 + Math.round(c.yieldN / 2) + c.lvl), cell: 1.1, yard: 0.4,
        farm: h => {
          // Labour lines: long huts in rows; the bungalow.
          const a = c.rnd() * Math.PI;
          for (let i = 0; i < 3; i++) houseAt(c, h.x + Math.cos(a + Math.PI / 2) * (i - 1) * 0.14, h.y + Math.sin(a + Math.PI / 2) * (i - 1) * 0.14, 0.42, 0.08, a, ROOF.hut[i % 3]);
          houseAt(c, h.x + Math.cos(a) * 0.36, h.y + Math.sin(a) * 0.36, 0.18, 0.14, a, ROOF.farm[2]);
        },
        crop: rnd => (rnd() < 0.85
          ? { color: 0x4e6b34, rows: { c: 0x2f4721, n: 8, w: 0.05, cross: 0x6a8a46 }, edge: 'track' }    // trees in rows
          : { color: 0x8a9a52, rows: { c: 0x6c7c3c, n: 5 }, edge: 'track' }),                               // young plantings
      });
      // Jungle round the edge.
      for (let i = 0; i < 220; i++) {
        const a = c.rnd() * TAU, r = c.edge(a) * (0.95 + c.rnd() * 0.3), x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (c.clear(x, y, 0.02)) c.tree(x, y, 0.08 + c.rnd() * 0.07, [0x2f4a22, 0x3a5a2a, 0x46622c][Math.floor(c.rnd() * 3)]);
      }
      if (!hubs.length) return;
      if (c.lvl >= 1) c.house(hubs[0].x - 0.5, hubs[0].y + 0.4, 0.45, 0.24, 0.2, ROOF.works[2]);   // processing shed
      if (c.lvl >= 3) railIn(c, hubs[0].x, hubs[0].y, 1);
    },
    timber(c) {
      // Clear-cuts: open patches of stumps and stacked logs, joined to the sawmill by logging tracks.
      const mill = c.spot(0.9, 0.35) || [0, 0];
      c.take(mill[0], mill[1], 0.8);
      const cuts = [];
      for (let i = 0; i < 4 + Math.round(c.yieldN) + c.lvl * 2; i++) {
        const s = c.spot(0.6, 0.85);
        if (!s) continue;
        const r = 0.5 + c.rnd() * 0.5;
        c.poly(8, c.blob(s[0], s[1], r, 11, 0.4), [0x9d8a5c, 0xa8966a, 0x8f7e55][Math.floor(c.rnd() * 3)], { alpha: 0.95 });
        c.take(s[0], s[1], r);
        for (let k = 0; k < 22; k++) { const a = c.rnd() * TAU, rr = Math.sqrt(c.rnd()) * r * 0.85; c.circle(50, s[0] + Math.cos(a) * rr, s[1] + Math.sin(a) * rr, 0.025, 0x6a5232, { d: 1 }); }
        const la = c.rnd() * Math.PI;
        for (let k = 0; k < 4; k++) c.mark(55, 'rect', s[0] + Math.cos(la + Math.PI / 2) * k * 0.09, s[1] + Math.sin(la + Math.PI / 2) * k * 0.09, 0, 0, { w: 0.32, h: 0.07, a: la, roof: [0x8a6440, 0x6a4a2e], d: 1 });
        cuts.push(s);
      }
      for (const s of cuts) c.line(30, c.path(mill, s, 6, 0.2), 0.06, 0x8f7a56, { alpha: 0.95 });
      // The forest: crowns everywhere else.
      const n = Math.min(1800, Math.round(c.R * c.R * 16));
      for (let i = 0; i < n; i++) {
        const a = c.rnd() * TAU, r = Math.sqrt(c.rnd()) * c.R * 1.05, x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (!c.within(x, y, 1.02) || !c.clear(x, y, 0.04)) continue;
        c.mark(70, 'tree', x, y, 0, 0, { r: 0.12 + c.rnd() * 0.1, color: [0x2f4a22, 0x3a5a2a, 0x46622c, 0x2c4420, 0x50703a][Math.floor(c.rnd() * 5)], d: 1 });
      }
      // The sawmill by its log pond.
      const pa = c.rnd() * TAU, px = mill[0] + Math.cos(pa) * 0.55, py = mill[1] + Math.sin(pa) * 0.55;
      c.poly(20, c.blob(px, py, 0.35, 10, 0.3), 0x55686b);
      for (let k = 0; k < 10; k++) { const a = c.rnd() * Math.PI, x = px + (c.rnd() - 0.5) * 0.4, y = py + (c.rnd() - 0.5) * 0.3; c.line(22, [[x - Math.cos(a) * 0.09, y - Math.sin(a) * 0.09], [x + Math.cos(a) * 0.09, y + Math.sin(a) * 0.09]], 0.035, 0x7a5a38, { d: 1 }); }
      houseAt(c, mill[0], mill[1], 0.55, 0.3, pa + Math.PI / 2, ROOF.works[0]);
      houseAt(c, mill[0] - Math.cos(pa) * 0.4, mill[1] - Math.sin(pa) * 0.4, 0.3, 0.2, pa, ROOF.works[1]);
      for (let k = 0; k < 5; k++) c.mark(55, 'rect', mill[0] + Math.cos(pa + 1.6) * 0.45 + k * 0.09 * Math.cos(pa), mill[1] + Math.sin(pa + 1.6) * 0.45 + k * 0.09 * Math.sin(pa), 0, 0, { w: 0.07, h: 0.4, a: pa, roof: [0xa47a4c, 0x7a5a38] });
      if (c.lvl >= 2 && cuts.length) for (const s of cuts.slice(-2)) c.rail(40, c.path(mill, s, 7, 0.15));   // logging railway
      if (c.lvl >= 3) {
        // Pulp mill: a big block, a chimney and its settling pond.
        const s = c.spot(0.9, 0.5);
        if (s) { c.take(s[0], s[1], 0.8); houseAt(c, s[0], s[1], 0.9, 0.5, pa, ROOF.works[1]); c.circle(66, s[0] + 0.55, s[1], 0.08, 0x5a3a30, { rim: 0x2a1a14 }); c.poly(20, c.blob(s[0] - 0.3, s[1] + 0.65, 0.28, 8, 0.2), 0x8a8a6a); }
        railIn(c, mill[0], mill[1], 1);
      }
    },
    coal(c) {
      const pits = [];
      for (let i = 0; i < Math.min(9, 2 + Math.round(c.yieldN / 1.5) + c.lvl); i++) {
        const s = c.spot(1.0, pits.length ? 0.78 : 0.3, 60);
        if (s) { pits.push(s); c.take(s[0], s[1], 0.4); }
      }
      if (!pits.length) return;
      // The railway through the field, and a line to every pit.
      const a = railIn(c, pits[0][0], pits[0][1], 0);
      for (const p of pits.slice(1)) {
        let b = pits[0];
        for (const o of pits) if (o !== p && pits.indexOf(o) < pits.indexOf(p) && Math.hypot(o[0] - p[0], o[1] - p[1]) < Math.hypot(b[0] - p[0], b[1] - p[1])) b = o;
        c.rail(40, c.path(b, p, 5, 0.12));
      }
      for (const [k, p] of pits.entries()) {
        const fa = c.rnd() * TAU;
        // The blackened yard.
        c.poly(5, c.blob(p[0], p[1], 0.9, 10, 0.3), 0x3d3a36, { alpha: 0.4 });
        // Spoil heap: a black cone to one side, lit from the north-west.
        const ha = fa + Math.PI * (0.7 + c.rnd() * 0.6), hr = 0.5 + c.rnd() * 0.4 + c.lvl * 0.08, hx = p[0] + Math.cos(ha) * (0.55 + hr), hy = p[1] + Math.sin(ha) * (0.55 + hr);
        if (c.ok(hx, hy)) {
          c.poly(44, c.blob(hx + 0.08, hy + 0.11, hr, 9, 0.25), 0x14120f, { alpha: 0.4 });
          c.poly(45, c.blob(hx, hy, hr, 9, 0.25), 0x2b2825);
          c.poly(46, c.blob(hx - hr * 0.25, hy - hr * 0.25, hr * 0.45, 7, 0.2), 0x4a4640, { alpha: 0.9 });
          c.take(hx, hy, hr);
        }
        // Pit head: headframe(s) over the shaft, engine house, boiler chimney.
        c.mark(66, 'headframe', p[0], p[1], 0.3, fa);
        if (c.lvl >= 1) c.mark(66, 'headframe', p[0] + Math.cos(fa) * 0.5, p[1] + Math.sin(fa) * 0.5, 0.26, fa);   // deeper shafts: a second
        houseAt(c, p[0] - Math.cos(fa) * 0.45, p[1] - Math.sin(fa) * 0.45, 0.42, 0.24, fa, [0x8a4a35, 0x6a3626]);
        houseAt(c, p[0] - Math.cos(fa + 0.9) * 0.5, p[1] - Math.sin(fa + 0.9) * 0.5, 0.3, 0.18, fa, ROOF.works[0]);
        c.circle(67, p[0] + Math.cos(fa + 1.6) * 0.4, p[1] + Math.sin(fa + 1.6) * 0.4, 0.07, 0x5a3a30, { rim: 0x2a1a14 });
        // Miners' terraces: blocks of long rows of narrow houses, round the pit, with a lane to it.
        for (let b = 0, built = 0; b < 12 && built < 2 + (k === 0 ? 3 : 0); b++) {
          const ba = c.rnd() * TAU, bd = 1.2 + c.rnd() * 1.6, tx = p[0] + Math.cos(ba) * bd, ty = p[1] + Math.sin(ba) * bd;
          if (c.rows(tx, ty, ba + Math.PI / 2 + (c.rnd() - 0.5) * 0.4, 4 + Math.floor(c.rnd() * 3), 0.9 + c.rnd() * 0.4, 0.1, 0.2, [ROOF.works[0], ROOF.works[1], ROOF.farm[0]], 0.02)) {
            built++;
            c.line(31, c.path(p, [tx, ty], 3, 0.1), 0.05, 0x8a8478, { alpha: 0.9 });
          }
        }
      }
      // Coking ovens: a long battery glowing along the top.
      if (c.lvl >= 2) {
        const p = pits[0], ox = p[0] + Math.cos(a + Math.PI / 2) * 0.8, oy = p[1] + Math.sin(a + Math.PI / 2) * 0.8;
        c.mark(61, 'rect', ox, oy, 0, 0, { w: 1.6, h: 0.2, a, roof: [0x7a4a3a, 0x5a362a] });
        for (let i = 0; i < 16; i++) c.circle(63, ox + Math.cos(a) * (i - 7.5) * 0.095, oy + Math.sin(a) * (i - 7.5) * 0.095, 0.024, 0xff8a3a, { d: 1, alpha: 0.9 });
      }
      // Colliery railway: a yard of parallel sidings.
      if (c.lvl >= 3) {
        const p = pits[0], nx = -Math.sin(a), ny = Math.cos(a);
        for (let i = 1; i <= 5; i++) c.rail(41, [[p[0] + Math.cos(a) * 2.4 + nx * i * 0.13, p[1] + Math.sin(a) * 2.4 + ny * i * 0.13], [p[0] + Math.cos(a) * 0.7 + nx * i * 0.13, p[1] + Math.sin(a) * 0.7 + ny * i * 0.13]]);
      }
    },
    iron(c) { openPits(c, false); },
    copper(c) { openPits(c, true); },
    oil(c) {
      // Leases: patches crowded with derricks on a rough grid, each over its own oil stain, with lanes between the rows;
      // more and bigger patches with the yield and the works. Dirt roads join them to the tank farm in the middle.
      const tf = c.spot(0.9, 0.3) || [0, 0];
      c.take(tf[0], tf[1], 0.7);
      const leases = [], cap = Math.min(420, 60 + Math.round(c.yieldN * 30) + c.lvl * 40);
      let count = 0;
      for (let i = 0; i < 3 + Math.round(c.yieldN / 2) + c.lvl * 2 && count < cap; i++) {
        const s0 = c.spot(0.5, 0.85, 30);
        if (!s0) continue;
        const lr = 0.7 + c.rnd() * 0.7, la = c.rnd() * Math.PI, ux = Math.cos(la), uy = Math.sin(la), gap = 0.26 + c.rnd() * 0.06;
        const shape = c.blob(s0[0], s0[1], lr, 9, 0.35), inside = (x, y) => {
          let w = false;
          for (let k = 0, j = shape.length - 2; k < shape.length; j = k, k += 2) if ((shape[k + 1] > y) !== (shape[j + 1] > y) && x < (shape[j] - shape[k]) * (y - shape[k + 1]) / (shape[j + 1] - shape[k + 1]) + shape[k]) w = !w;
          return w;
        };
        c.poly(7, shape, 0x4a3f33, { alpha: 0.35 });   // the trodden, oil-soaked ground of the lease
        const n = Math.ceil(lr / gap) + 1;
        for (let p = -n; p <= n; p++) {
          // A lane along every other row.
          if (p % 2 === 0) {
            const inRow = [];
            for (let t = -1.2; t <= 1.2; t += 0.1) { const x = s0[0] + ux * lr * t - uy * (p + 0.5) * gap, y = s0[1] + uy * lr * t + ux * (p + 0.5) * gap; if (inside(x, y)) inRow.push([x, y]); }
            if (inRow.length > 1) c.line(29, [inRow[0], inRow[inRow.length - 1]], 0.03, 0x8f7c5c, { alpha: 0.6, d: 1 });
          }
          for (let q = -n; q <= n && count < cap; q++) {
            const x = s0[0] + ux * q * gap - uy * p * gap + (c.rnd() - 0.5) * gap * 0.35, y = s0[1] + uy * q * gap + ux * p * gap + (c.rnd() - 0.5) * gap * 0.35;
            if (!inside(x, y) || !c.ok(x, y) || !c.within(x, y, 1.05) || c.rnd() < 0.15) continue;
            c.poly(8, c.blob(x, y, 0.07 + c.rnd() * 0.07, 6, 0.4), 0x231e18, { alpha: 0.6 });
            c.mark(66, 'derrick', x, y, 0.13, la + (c.rnd() - 0.5) * 0.2);
            count++;
          }
        }
        c.take(s0[0], s0[1], lr);
        leases.push(s0);
        c.line(30, c.path(s0, tf, 4, 0.12), 0.05, 0x8f7c5c, { alpha: 0.9 });
      }
      if (!leases.length) return;
      // Tank farm.
      for (let i = 0; i < 4 + c.lvl * 2; i++) { const x = tf[0] + (i % 3 - 1) * 0.42, y = tf[1] + (Math.floor(i / 3) - 0.5) * 0.42; if (c.ok(x, y)) c.circle(62, x, y, 0.17, 0xbdb9ae, { rim: 0x77736a, shadow: true }); }
      houseAt(c, tf[0] - 0.75, tf[1] + 0.1, 0.35, 0.2, 0.2, ROOF.works[0]);
      // Pipelines: a gathering line from every lease to the tanks, and a trunk line away.
      if (c.lvl >= 2) {
        for (const l of leases) c.line(35, c.path(l, tf, 3, 0.05), 0.035, 0x2a2622, { alpha: 0.85 });
        c.line(35, c.wander(tf[0], tf[1], c.rnd() * TAU, c.R * 1.6, 12, 0.2, 1.5), 0.045, 0x2a2622, { alpha: 0.9 });
      }
      // Refinery: columns, sheds and the flare.
      if (c.lvl >= 3) {
        const s = c.spot(0.9, 0.5);
        if (s) {
          c.take(s[0], s[1], 0.8);
          for (let i = 0; i < 8; i++) c.circle(64, s[0] + (i % 4) * 0.16 - 0.24, s[1] + Math.floor(i / 4) * 0.2 - 0.1, 0.06, 0x8f8b84, { rim: 0x4a4744 });
          houseAt(c, s[0], s[1] + 0.45, 0.8, 0.24, 0, ROOF.works[2]);
          c.circle(68, s[0] + 0.45, s[1] - 0.35, 0.07, 0xff9a3a, { glow: true });
          c.line(35, [s, tf], 0.04, 0x2a2622, { alpha: 0.9 });
        }
        railIn(c, tf[0], tf[1], 1);
      }
    },
    nitrates(c) {
      // Caliche diggings: pale scars all over the pampa.
      for (let i = 0; i < Math.round(c.R * c.R * 8); i++) {
        const a = c.rnd() * TAU, r = Math.sqrt(c.rnd()) * c.R, x = Math.cos(a) * r, y = Math.sin(a) * r, la = c.rnd() * Math.PI;
        if (c.within(x, y) && c.ok(x, y)) c.line(12, [[x - Math.cos(la) * 0.16, y - Math.sin(la) * 0.16], [x + Math.cos(la) * 0.16, y + Math.sin(la) * 0.16]], 0.07, 0xf2ecdc, { alpha: 0.8 });
      }
      // Oficinas: the works with its leaching vats in a grid, a tall chimney, a spent-ore heap and the camp.
      const n = Math.min(6, 1 + Math.round(c.yieldN / 2) + c.lvl), works = [];
      for (let i = 0; i < n; i++) {
        const s = c.spot(1.3, works.length ? 0.72 : 0.3, 60);
        if (!s) continue;
        works.push(s); c.take(s[0], s[1], 0.5);
        const a = c.rnd() * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
        for (let v = 0; v < (c.lvl >= 2 ? 12 : 8); v++) { const u = (v % 4 - 1.5) * 0.17, w = (Math.floor(v / 4) - 0.5) * 0.17; c.mark(61, 'rect', s[0] + ca * u - sa * w, s[1] + sa * u + ca * w, 0, 0, { w: 0.14, h: 0.14, a, roof: [0x8fa3a8, 0x6f8388] }); }
        houseAt(c, s[0] - ca * 0.6, s[1] - sa * 0.6, 0.5, 0.28, a, ROOF.works[2]);
        c.circle(67, s[0] + ca * 0.5 + sa * 0.3, s[1] + sa * 0.5 - ca * 0.3, 0.07, 0x6a5a50, { rim: 0x2a1a14 });
        const hx = s[0] + Math.cos(a + 1.8) * 1.1, hy = s[1] + Math.sin(a + 1.8) * 1.1;
        if (c.ok(hx, hy)) { c.poly(44, c.blob(hx, hy, 0.55, 9, 0.2), 0xcfc7b4); c.poly(45, c.blob(hx - 0.08, hy - 0.08, 0.32, 7, 0.2), 0xe2dccb); c.take(hx, hy, 0.55); }
        const cx = s[0] + Math.cos(a - 1.4) * 1.05, cy = s[1] + Math.sin(a - 1.4) * 1.05;
        c.rows(cx, cy, a, 5, 0.75, 0.09, 0.16, [ROOF.hut[2], ROOF.hut[0]]);
      }
      if (!works.length) return;
      railIn(c, works[0][0], works[0][1], 0);
      for (const w of works.slice(1)) (c.lvl >= 3 ? c.rail : (z, p) => c.line(z, p, 0.06, 0xa8987a))(40, c.path(works[0], w, 6, 0.1));
    },
  };
  /** Iron and copper: stepped open pits with a haul road, dumps and crushers; copper adds tailings ponds. */
  function openPits(c, copper) {
    const steps = copper ? [0xb39a6a, 0xa38c60, 0x938057, 0x7f8f78, 0x6a8f84, 0x5f8a80] : [0xa0623e, 0x915737, 0x824c30, 0x734229, 0x653a24, 0x5e3622];
    const pits = [];
    for (let i = 0; i < Math.min(5, 1 + Math.floor(c.yieldN / 3) + (c.lvl >= 1 ? 1 : 0)); i++) {
      const r = 0.95 + c.rnd() * 0.55 + c.lvl * 0.15, s = c.spot(r + 0.4, pits.length ? 0.6 : 0.25, 60);
      if (!s) continue;
      pits.push([...s, r]); c.take(s[0], s[1], r + 0.1);
      // Benches, each a step down and in; the shadowed lip of each.
      const k = 6, ph = c.rnd() * TAU, ph2 = c.rnd() * TAU, el = 0.75 + c.rnd() * 0.25;
      for (let b = 0; b < k; b++) {
        const rr = r * (1 - b / (k + 0.6)), pts = [];
        for (let j = 0; j < 26; j++) { const a = j / 26 * TAU, w = 1 + 0.12 * Math.sin(a * 2 + ph) + 0.06 * Math.sin(a * 3 + ph2); pts.push(s[0] + Math.cos(a) * rr * w, s[1] + Math.sin(a) * rr * w * el); }
        c.poly(20 + b, pts, steps[b], { edge: 'lip' });
      }
      // The haul road spiralling down.
      const road = [];
      for (let j = 0; j <= 40; j++) { const t = j / 40, a = ph + t * TAU * 1.3, rr = r * (0.95 - t * 0.7); road.push([s[0] + Math.cos(a) * rr, s[1] + Math.sin(a) * rr * el]); }
      c.line(27, road, 0.06, copper ? 0xc8b48a : 0xb88a64, { alpha: 0.9 });
      // Waste dumps: flat-topped, beside the pit.
      for (let d = 0; d < 3; d++) {
        const a = c.rnd() * TAU, dr = 0.45 + c.rnd() * 0.3, x = s[0] + Math.cos(a) * (r + dr + 0.15), y = s[1] + Math.sin(a) * (r + dr + 0.15);
        if (!c.ok(x, y) || !c.within(x, y, 1.05) || !c.clear(x, y, dr)) continue;
        c.take(x, y, dr);
        c.poly(44, c.blob(x + 0.07, y + 0.09, dr, 9, 0.2), 0x1d1a16, { alpha: 0.3 });
        c.poly(45, c.blob(x, y, dr, 9, 0.2), copper ? 0x9a8a6a : 0x8a5a3e);
        c.poly(46, c.blob(x - 0.05, y - 0.05, dr * 0.65, 8, 0.15), copper ? 0xb0a07c : 0x9e6a48, { alpha: 0.9 });
      }
      // Steam shovels at work on the benches.
      if (c.lvl >= 1) for (let q = 0; q < 3; q++) { const a = c.rnd() * TAU, rr = r * (0.4 + c.rnd() * 0.4); c.mark(66, 'rect', s[0] + Math.cos(a) * rr, s[1] + Math.sin(a) * rr * el, 0, 0, { w: 0.16, h: 0.1, a, roof: [0x3a3632, 0x24211e] }); }
    }
    if (!pits.length) return;
    const p0 = pits[0];
    // The mine works: crusher (stepped sheds) and the camp.
    const w = c.spot(0.9, 0.8) || [p0[0] + p0[2] + 0.6, p0[1]];
    c.take(w[0], w[1], 0.5);
    houseAt(c, w[0], w[1], 0.55, 0.3, 0.4, ROOF.works[0]);
    houseAt(c, w[0] + 0.32, w[1] + 0.3, 0.38, 0.24, 0.4, ROOF.works[2]);
    for (let b = 0; b < 2 + c.lvl; b++) { const ba = c.rnd() * TAU; c.rows(w[0] + Math.cos(ba) * 1.2, w[1] + Math.sin(ba) * 1.2, ba + Math.PI / 2, 5, 0.7, 0.1, 0.17, [ROOF.works[0], ROOF.works[1]]); }
    if (copper) {
      // Tailings ponds: turquoise, with pale beaches.
      for (let i = 0; i < 1 + c.lvl; i++) {
        const s = c.spot(0.75, 0.9);
        if (!s) continue;
        c.take(s[0], s[1], 0.7);
        c.poly(18, c.blob(s[0], s[1], 0.7, 10, 0.25), 0xd9d0b8);
        c.poly(19, c.blob(s[0], s[1], 0.55, 10, 0.25), 0x6fb3a8);
      }
    }
    const a = c.lvl >= 2 ? railIn(c, w[0], w[1], 0) : 0;
    if (c.lvl >= 2) for (const p of pits) c.rail(40, c.path(w, [p[0] + p[2] * 0.9, p[1]], 5, 0.1));
    else for (const p of pits) c.line(30, c.path(w, [p[0] + p[2] * 0.9, p[1]], 5, 0.1), 0.06, 0xa8906c);
    if (c.lvl >= 3) {
      // Blast furnaces (iron) or the smelter and its stack (copper).
      const s = c.spot(0.8, 0.6) || [w[0] + 0.9, w[1] - 0.6];
      c.take(s[0], s[1], 0.6);
      if (copper) { houseAt(c, s[0], s[1], 0.9, 0.45, a, ROOF.works[1]); c.circle(67, s[0] + 0.6, s[1] - 0.3, 0.1, 0x6a5a50, { rim: 0x2a1a14 }); }
      else for (let i = 0; i < 3; i++) { c.circle(64, s[0] + i * 0.3, s[1], 0.12, 0x4a4440, { rim: 0x2a2420 }); c.circle(65, s[0] + i * 0.3, s[1], 0.05, 0xff8a3a, { d: 1 }); c.circle(64, s[0] + i * 0.3, s[1] + 0.28, 0.08, 0x8a8580, { rim: 0x4a4744 }); }
    }
  }

  // ---- Field textures -------------------------------------------------------------------------------------------
  /**
   * The wheat textures (public/sprites/fields): the single tile and the four quarters of the 2×2 sheet, each mirrored
   * into a 2×2 so it repeats without a seam. Loaded once; null when unavailable.
   */
  let texPromise = null;
  function textures() {
    if (texPromise) return texPromise;
    const load = url => new Promise(ok => { const img = new Image(); img.onload = () => ok(img); img.onerror = () => ok(null); img.src = url; });
    const seamless = (img, sx, sy, sw, sh) => {
      const cv = document.createElement('canvas');
      cv.width = sw * 2; cv.height = sh * 2;
      const g = cv.getContext('2d');
      for (const [fx, fy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        g.save(); g.translate(fx < 0 ? sw * 2 : 0, fy < 0 ? sh * 2 : 0); g.scale(fx, fy);
        g.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        g.restore();
      }
      const source = new PIXI.CanvasSource({ resource: cv, autoGenerateMipmaps: true, addressMode: 'repeat', scaleMode: 'linear', mipmapFilter: 'linear' });
      return new PIXI.Texture({ source });
    };
    texPromise = Promise.all([load('/sprites/fields/wheat-1.png'), load('/sprites/fields/wheat-2.png')]).then(([a, b]) => {
      const out = [];
      // The single tile has a dark vignette round its edge (worst along the bottom): cut it off, or mirroring doubles
      // it into dark seams across the fields. The 2×2 sheet only darkens along its last few rows.
      if (a) out.push(seamless(a, 5, 8, a.width - 11, Math.round(a.height * 0.84) - 8));
      if (b) { const w = Math.floor(b.width / 2), h = Math.floor((b.height - 4) / 2); for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) out.push(seamless(b, x + 1, y + 1, w - 2, h - 2)); }
      return out.length ? out : null;
    }).catch(() => null);
    return texPromise;
  }

  // ---- Draw -----------------------------------------------------------------------------------------------------
  const STROKE = { join: 'round', cap: 'round' };
  function draw(p, detail = true, tex = null) {
    const g = new PIXI.Graphics();
    const trees = [];
    for (const it of p.items) {
      if (it.d && !detail) continue;
      switch (it.t) {
        case 'poly': {
          const T = it.tex !== undefined && tex ? tex[it.tex % tex.length] : null;
          if (T) {
            // The texture repeats across the field, turned to run the way the field does.
            const s = it.ts || 1.2, mtx = new PIXI.Matrix().scale(s / T.width, s / T.height).rotate(it.a || 0).translate(it.ox || 0, it.oy || 0);
            // Over a golden base: the sprites are darker than the painted fields round them.
            g.poly(it.pts).fill({ color: it.color, alpha: 0.95 });
            g.poly(it.pts).fill({ texture: T, matrix: mtx, color: it.tint ?? 0xffffff, alpha: it.alpha ?? 0.72, textureSpace: 'global' });
          } else g.poly(it.pts).fill({ color: it.color, alpha: it.alpha ?? (it.quad ? 0.92 : 1) });
          if (detail && it.rows && it.quad) {
            // Furrows or rows across the field (and, for plantations, across them again).
            const P = it.pts, n = it.rows.n || 5;
            for (let i = 1; i < n; i++) { const t = i / n; g.moveTo(P[0] + (P[6] - P[0]) * t, P[1] + (P[7] - P[1]) * t).lineTo(P[2] + (P[4] - P[2]) * t, P[3] + (P[5] - P[3]) * t); }
            if (it.rows.cross) for (let i = 1; i < n; i++) { const t = i / n; g.moveTo(P[0] + (P[2] - P[0]) * t, P[1] + (P[3] - P[1]) * t).lineTo(P[6] + (P[4] - P[6]) * t, P[7] + (P[5] - P[7]) * t); }
            g.stroke({ width: it.rows.w || 0.016, color: it.rows.c, alpha: it.rows.a ?? 0.55 });
          }
          if (it.horses && detail) for (const [x, y, col, a] of it.horses) g.ellipse(x, y, 0.035, 0.016).fill({ color: col }).circle(x + Math.cos(a) * 0.035, y + Math.sin(a) * 0.035, 0.012).fill({ color: col });
          if (it.edge === 'hedge' && detail) g.poly(it.pts).stroke({ width: 0.04, color: 0x4b6531, alpha: 0.8, ...STROKE });
          else if (it.edge === 'fence') g.poly(it.pts).stroke({ width: detail ? 0.022 : 0.03, color: 0xe8e2d2, alpha: 0.85, ...STROKE });
          else if (it.edge === 'track' && detail) g.poly(it.pts).stroke({ width: 0.035, color: 0xa0603a, alpha: 0.8, ...STROKE });
          else if (it.edge === 'lip' && detail) g.poly(it.pts).stroke({ width: 0.025, color: 0x2a1c14, alpha: 0.35, ...STROKE });
          break;
        }
        case 'line': {
          g.moveTo(it.pts[0][0], it.pts[0][1]);
          for (let i = 1; i < it.pts.length; i++) g.lineTo(it.pts[i][0], it.pts[i][1]);
          g.stroke({ width: it.w, color: it.color, alpha: it.alpha ?? 1, ...STROKE });
          break;
        }
        case 'rail': {
          // Ballast, the rails, and (close up) the sleepers.
          const pts = it.pts;
          const line = () => { g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); };
          line(); g.stroke({ width: 0.085, color: 0x8f877a, alpha: 0.9, ...STROKE });
          if (detail) {
            for (let i = 1; i < pts.length; i++) {
              const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], d = Math.hypot(x1 - x0, y1 - y0), nx = -(y1 - y0) / (d || 1) * 0.04, ny = (x1 - x0) / (d || 1) * 0.04;
              for (let t = 0; t < d; t += 0.07) { const x = x0 + (x1 - x0) * t / d, y = y0 + (y1 - y0) * t / d; g.moveTo(x - nx, y - ny).lineTo(x + nx, y + ny); }
            }
            g.stroke({ width: 0.018, color: 0x5a4a3a, alpha: 0.8 });
          }
          line(); g.stroke({ width: 0.03, color: 0x3a3632, alpha: 0.95, ...STROKE });
          break;
        }
        case 'circle': {
          if (it.shadow && detail) g.circle(it.x + 0.025, it.y + 0.035, it.r).fill({ color: 0x1d1a16, alpha: 0.35 });
          if (it.ring) { g.circle(it.x, it.y, it.r).stroke({ width: it.ring, color: it.color, alpha: 0.95 }); break; }
          if (it.glow) g.circle(it.x, it.y, it.r * 2.2).fill({ color: it.color, alpha: 0.25 });
          g.circle(it.x, it.y, it.r).fill({ color: it.color, alpha: it.alpha ?? 1 });
          if (it.rim && detail) g.circle(it.x, it.y, it.r).stroke({ width: Math.max(0.012, it.r * 0.18), color: it.rim, alpha: 0.9 });
          break;
        }
        case 'rect': {
          if (detail) g.poly(rect(it.x + 0.025, it.y + 0.035, it.w, it.h, it.a)).fill({ color: 0x1d1a16, alpha: 0.38 });
          g.poly(rect(it.x, it.y, it.w, it.h, it.a)).fill({ color: it.roof[0] });
          if (detail) { const cs = Math.cos(it.a), sn = Math.sin(it.a); g.poly(rect(it.x - sn * it.h / 4, it.y + cs * it.h / 4, it.w, it.h / 2, it.a)).fill({ color: it.roof[1] }); }
          break;
        }
        case 'derrick': {
          // A timber derrick from above: its square base, the legs meeting at the crown block, its shadow.
          const s = it.s, P = rect(it.x, it.y, s, s, it.a);
          if (detail) {
            g.poly(rect(it.x + 0.05, it.y + 0.06, s * 0.35, s * 1.4, it.a + 0.6)).fill({ color: 0x1d1a16, alpha: 0.3 });
            g.poly(P).stroke({ width: 0.014, color: 0x3a2c22, alpha: 1 });
            for (let k = 0; k < 8; k += 2) g.moveTo(P[k], P[k + 1]).lineTo(it.x, it.y);
            g.stroke({ width: 0.012, color: 0x4a3828, alpha: 1 });
            g.circle(it.x, it.y, 0.018).fill({ color: 0x2a2018 });
          } else g.poly(P).fill({ color: 0x3a2c22, alpha: 0.9 });
          break;
        }
        case 'headframe': {
          // A pit headframe: the steel legs, braced, and its winding wheels.
          const s = it.s, P = rect(it.x, it.y, s, s * 0.7, it.a);
          if (detail) {
            g.poly(rect(it.x + 0.06, it.y + 0.08, s * 0.5, s * 1.6, it.a + 0.6)).fill({ color: 0x1d1a16, alpha: 0.3 });
            g.poly(P).stroke({ width: 0.016, color: 0x2b2b2b });
            g.moveTo(P[0], P[1]).lineTo(P[4], P[5]).moveTo(P[2], P[3]).lineTo(P[6], P[7]).stroke({ width: 0.012, color: 0x2b2b2b });
            const cs = Math.cos(it.a), sn = Math.sin(it.a);
            for (const k of [-1, 1]) g.circle(it.x + cs * s * 0.22 * k, it.y + sn * s * 0.22 * k, s * 0.2).stroke({ width: 0.012, color: 0x3a3a3a });
          } else g.poly(P).fill({ color: 0x2b2b2b });
          break;
        }
        case 'tree': trees.push(it); break;
      }
    }
    // Trees last, over everything: shadow, then crown.
    if (detail) { for (const t of trees) g.circle(t.x + 0.02, t.y + 0.025, t.r).fill({ color: 0x1d2a12, alpha: 0.35 }); }
    for (const t of trees) g.circle(t.x, t.y, t.r).fill({ color: t.color || 0x46622c });
    return g;
  }

  return { plan, draw, textures, radius, KINDS };
})();
window.ResourceArt = ResourceArt;
