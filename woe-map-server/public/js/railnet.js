'use strict';
/**
 * Railway network maths, shared by the browser (reach preview, trains) and the server (movement rules,
 * sabotage). Rails are drawings of kind 'rail': a polyline plus data.cuts [{ id, x, y, ... }].
 *
 *   RailNet.build(rails, opt)          → net: nodes, edges and adjacency; edges inside a cut are marked cut
 *   RailNet.route(net, a, b, opt)      → cheapest a → rail → b trip, or null (costs in campaign units)
 *   RailNet.walk(path, budget)         → the point where a movement budget runs out along a route
 *   RailNet.reach(net, a, budget, opt) → how far along each edge a budget carries from a
 *   RailNet.project(points, x, y, kx)  → nearest point on a polyline { x, y, i, t, d2 }
 *
 * `opt.dist(x1, y1, x2, y2)` is the campaign distance (km on the Earth map); `opt.kx(y)` squeezes x
 * for nearest-point searches (cos(latitude) on the equirectangular Earth map, 1 elsewhere).
 * Distances along the track are real distances; a leg by rail costs distance / speed.
 */
(function (root) {
  const DEFAULTS = { speed: 4, stepKm: 10, joinKm: 20, midJoinKm: 5, cutKm: 10 };
  const flat = () => 1;

  /** Nearest point on a polyline to (x, y); d2 is squared (x-squeezed) map distance. */
  function project(points, x, y, kx = flat) {
    let best = null;
    const k = kx(y);
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, ay] = points[i], [bx, by] = points[i + 1];
      const dx = (bx - ax) * k, dy = by - ay, l2 = dx * dx + dy * dy;
      let t = l2 ? (((x - ax) * k) * dx + (y - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      const d2 = ((x - px) * k) ** 2 + (y - py) ** 2;
      if (!best || d2 < best.d2) best = { x: px, y: py, i, t, d2 };
    }
    return best;
  }

  /** Distance along a polyline (campaign units) at a projected point { i, t }. */
  function arcAt(points, p, dist) {
    let s = 0;
    for (let i = 0; i < p.i; i++) s += dist(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
    const [ax, ay] = points[p.i], [bx, by] = points[p.i + 1];
    return s + dist(ax, ay, bx, by) * p.t;
  }

  /** Cut intervals [from, to] along a rail (campaign units), from its cut points. */
  function cutIntervals(points, cuts, opt) {
    const half = opt.cutKm ?? DEFAULTS.cutKm;
    return (cuts || []).map(c => {
      const p = project(points, c.x, c.y, opt.kx || flat);
      if (!p) return null;
      const s = arcAt(points, p, opt.dist);
      return { from: s - half, to: s + half, cut: c };
    }).filter(Boolean);
  }

  /** Where segments p1-p2 and q1-q2 cross: { x, y, t (along p), u (along q) }, or null. */
  function crossing(p1, p2, q1, q2) {
    const rx = p2[0] - p1[0], ry = p2[1] - p1[1], sx = q2[0] - q1[0], sy = q2[1] - q1[1];
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;                       // parallel
    const qx = q1[0] - p1[0], qy = q1[1] - p1[1];
    const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: p1[0] + rx * t, y: p1[1] + ry * t, t, u };
  }
  const bboxOf = pts => pts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);

  /**
   * Build the network. Rails are joined where an end of one lies within joinKm of another rail (end to end,
   * or a branch meeting a main line part-way), where an inner vertex lies within midJoinKm of one (so parallel
   * lines a few km apart stay apart), and wherever two rails cross. Long segments are split into ≤ stepKm
   * pieces so cuts and ownership apply to short sections.
   */
  function build(rails, opt) {
    const o = { ...DEFAULTS, ...opt };
    const dist = o.dist, kx = o.kx || flat;
    const list = rails.filter(r => Array.isArray(r.points) && r.points.length >= 2)
      .map(r => ({ id: r.id, label: r.label || '', points: r.points.map(p => [Number(p[0]), Number(p[1])]), cuts: r.cuts || [] }));

    // 1. Junctions: every vertex of every rail against every other rail.
    const inserts = list.map(() => []);                  // per rail: { seg, t, key }
    const links = [];                                     // [keyA, keyB]
    const midJoin = Math.min(o.joinKm, o.midJoinKm ?? DEFAULTS.midJoinKm);
    const boxes = list.map(r => bboxOf(r.points));
    list.forEach((a, ai) => {
      a.points.forEach(([x, y], vi) => {
        const end = vi === 0 || vi === a.points.length - 1, reach = end ? o.joinKm : midJoin;
        // Map px that reach spans here (with room to spare): a rail whose box lies farther off cannot be in reach.
        const my = 1.5 * reach / (dist(x, y, x, y + 1) || 1), mx = 1.5 * reach / (dist(x, y, x + 1, y) || 1);
        list.forEach((b, bi) => {
          if (bi === ai) return;
          const B = boxes[bi];
          if (x < B[0] - mx || x > B[2] + mx || y < B[1] - my || y > B[3] + my) return;
          const p = project(b.points, x, y, kx);
          if (!p || dist(x, y, p.x, p.y) > reach) return;
          const key = `j${ai}:${vi}>${bi}`;
          inserts[bi].push({ seg: p.i, t: p.t, x: p.x, y: p.y, key });
          links.push([`v${ai}:${vi}`, key]);
        });
      });
    });
    // Crossings: two lines drawn over each other meet where they cross, vertex or not.
    for (let ai = 0; ai < list.length; ai++) for (let bi = ai + 1; bi < list.length; bi++) {
      const A = boxes[ai], B = boxes[bi];
      if (A[0] > B[2] || B[0] > A[2] || A[1] > B[3] || B[1] > A[3]) continue;
      const P = list[ai].points, Q = list[bi].points;
      for (let i = 0; i < P.length - 1; i++) for (let j = 0; j < Q.length - 1; j++) {
        const hit = crossing(P[i], P[i + 1], Q[j], Q[j + 1]);
        if (!hit) continue;
        const key = `x${ai}:${i}:${bi}:${j}`;
        inserts[ai].push({ seg: i, t: hit.t, x: hit.x, y: hit.y, key: key + 'a' });
        inserts[bi].push({ seg: j, t: hit.u, x: hit.x, y: hit.y, key: key + 'b' });
        links.push([key + 'a', key + 'b']);
      }
    }

    // 2. Each rail's points with junction points spliced in, then densified. Points carry keys for linking.
    const nodes = [], edges = [], keyNode = new Map();
    const node = (x, y) => { nodes.push({ x, y }); return nodes.length - 1; };
    list.forEach((r, ri) => {
      const pts = [];
      r.points.forEach((p, vi) => {
        pts.push({ x: p[0], y: p[1], keys: [`v${ri}:${vi}`] });
        if (vi === r.points.length - 1) return;
        const mid = inserts[ri].filter(s => s.seg === vi).sort((a, b) => a.t - b.t);
        for (const s of mid) {
          const last = pts[pts.length - 1];
          if (s.t < 1e-6 || Math.hypot(s.x - last.x, s.y - last.y) < 1e-6) { last.keys.push(s.key); continue; }
          if (s.t > 1 - 1e-6) { s.atEnd = vi + 1; continue; }
          pts.push({ x: s.x, y: s.y, keys: [s.key] });
        }
      });
      // Junctions exactly on the next vertex attach to it.
      for (const s of inserts[ri]) if (s.atEnd !== undefined) pts.find(p => p.keys.includes(`v${ri}:${s.atEnd}`)).keys.push(s.key);

      const cuts = cutIntervals(r.points, r.cuts, o);
      let prev = null, s = 0;
      for (const p of pts) {
        if (prev) {
          const L = dist(prev.x, prev.y, p.x, p.y);
          const n = Math.max(1, Math.ceil(L / o.stepKm));
          let a = prev.node;
          for (let k = 1; k <= n; k++) {
            const t = k / n;
            const b = k === n ? node(p.x, p.y) : node(prev.x + (p.x - prev.x) * t, prev.y + (p.y - prev.y) * t);
            if (k === n) p.node = b;
            const s0 = s + L * (k - 1) / n, s1 = s + L * t;
            const A = nodes[a], B = nodes[b];
            const cut = cuts.find(c => c.from < s1 && c.to > s0) || null;
            edges.push({ a, b, km: L / n, rail: r.id, s0, s1, mx: (A.x + B.x) / 2, my: (A.y + B.y) / 2, cut: cut ? cut.cut : null });
            a = b;
          }
          s += L;
        } else p.node = node(p.x, p.y);
        for (const key of p.keys) keyNode.set(key, p.node);
        prev = p;
      }
      r.length = s;
    });
    for (const [ka, kb] of links) {
      const a = keyNode.get(ka), b = keyNode.get(kb);
      if (a === undefined || b === undefined || a === b) continue;
      const A = nodes[a], B = nodes[b];
      edges.push({ a, b, km: dist(A.x, A.y, B.x, B.y), rail: null, link: true, mx: (A.x + B.x) / 2, my: (A.y + B.y) / 2, cut: null });
    }
    const adj = nodes.map(() => []);
    edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
    return { nodes, edges, adj, rails: list, opt: o };
  }

  /** Is an edge open to this mover? (not cut, and allowed by the caller's ownership test) */
  function openEdge(net, i, usable, cache) {
    const e = net.edges[i];
    if (e.cut) return false;
    if (!usable) return true;
    if (cache[i] === undefined) cache[i] = usable(e) ? 1 : 0;
    return cache[i] === 1;
  }

  /** Nearest open edge point to (x, y): { edge, t, x, y, d } (d in campaign units). */
  function board(net, x, y, usable, cache) {
    const kx = net.opt.kx || flat, k = kx(y);
    let best = null;
    net.edges.forEach((e, i) => {
      if (!openEdge(net, i, usable, cache)) return;
      const A = net.nodes[e.a], B = net.nodes[e.b];
      const dx = (B.x - A.x) * k, dy = B.y - A.y, l2 = dx * dx + dy * dy;
      let t = l2 ? (((x - A.x) * k) * dx + (y - A.y) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = A.x + (B.x - A.x) * t, py = A.y + (B.y - A.y) * t;
      const d2 = ((x - px) * k) ** 2 + (y - py) ** 2;
      if (!best || d2 < best.d2) best = { edge: i, t, x: px, y: py, d2 };
    });
    if (best) best.d = net.opt.dist(x, y, best.x, best.y);
    return best;
  }

  /** Minimal binary heap of [cost, node]. */
  function heap() {
    const h = [];
    return {
      get size() { return h.length; },
      push(c, n) { h.push([c, n]); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } },
      pop() {
        const top = h[0], last = h.pop();
        if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && h[l][0] < h[m][0]) m = l; if (r < h.length && h[r][0] < h[m][0]) m = r; if (m === i) break; [h[m], h[i]] = [h[i], h[m]]; i = m; } }
        return top;
      },
    };
  }

  /** Shortest track distance from a boarding point to every node (Dijkstra over open edges), up to maxKm. */
  function spread(net, start, usable, cache, maxKm = Infinity) {
    const dist = new Float64Array(net.nodes.length).fill(Infinity);
    const via = new Int32Array(net.nodes.length).fill(-1);
    const q = heap();
    const e0 = net.edges[start.edge];
    const seed = (n, c) => { if (c < dist[n]) { dist[n] = c; via[n] = -2; q.push(c, n); } };
    seed(e0.a, e0.km * start.t); seed(e0.b, e0.km * (1 - start.t));
    while (q.size) {
      const [c, n] = q.pop();
      if (c > dist[n] || c > maxKm) continue;
      for (const i of net.adj[n]) {
        if (!openEdge(net, i, usable, cache)) continue;
        const e = net.edges[i], m = e.a === n ? e.b : e.a, nc = c + e.km;
        if (nc < dist[m]) { dist[m] = nc; via[m] = i; q.push(nc, m); }
      }
    }
    return { dist, via };
  }

  /**
   * Cheapest trip from a to b using the network: walk to the track, ride, walk off. Returns null when there
   * is no open track, else { cost, railKm, walkKm, path: [[x, y, factor]] } where each point's factor is the
   * cost per unit of distance of the leg that ends there (1 on foot, 1 / speed by rail).
   */
  function route(net, a, b, opt = {}) {
    if (!net.edges.length) return null;
    const speed = opt.speed || net.opt.speed, cache = {};
    const on = board(net, a.x, a.y, opt.usable, cache), off = board(net, b.x, b.y, opt.usable, cache);
    if (!on || !off) return null;
    const dist = net.opt.dist;
    const walkKm = on.d + off.d;
    const direct = dist(a.x, a.y, b.x, b.y);
    if (walkKm >= direct) return null;                       // walking to and from the track costs more than the trip
    const rf = 1 / speed;
    let railKm, mids = [];
    const eOn = net.edges[on.edge], eOff = net.edges[off.edge];
    const same = on.edge === off.edge;
    const sameKm = same ? eOn.km * Math.abs(on.t - off.t) : Infinity;
    const { dist: d, via } = spread(net, on, opt.usable, cache, (direct - walkKm) * speed);
    const viaA = d[eOff.a] + eOff.km * off.t, viaB = d[eOff.b] + eOff.km * (1 - off.t);
    railKm = Math.min(sameKm, viaA, viaB);
    if (!Number.isFinite(railKm)) return null;
    if (railKm !== sameKm) {
      // Walk back from the exit node along `via` to the boarding edge.
      let n = viaA <= viaB ? eOff.a : eOff.b;
      while (n >= 0) {
        mids.push([net.nodes[n].x, net.nodes[n].y, rf]);
        const i = via[n];
        if (i < 0) break;
        const e = net.edges[i];
        n = e.a === n ? e.b : e.a;
      }
      mids.reverse();
    }
    const cost = walkKm + railKm / speed;
    if (cost >= direct) return null;
    const path = [[a.x, a.y, 1], [on.x, on.y, 1], ...mids, [off.x, off.y, rf], [b.x, b.y, 1]];
    return { cost, railKm, walkKm, path };
  }

  /** Walk a route until the budget (cost units) runs out: { x, y, spent, done, points } (points: the route walked). */
  function walk(path, budget, dist) {
    let left = budget;
    const points = [[path[0][0], path[0][1]]];
    for (let i = 1; i < path.length; i++) {
      const [ax, ay] = path[i - 1], [bx, by, f] = path[i];
      const L = dist(ax, ay, bx, by), c = L * f;
      if (c <= left + 1e-9) { left -= c; points.push([bx, by]); continue; }
      const t = c ? left / c : 0;
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      points.push([x, y]);
      return { x, y, spent: budget, done: false, points };
    }
    const last = path[path.length - 1];
    return { x: last[0], y: last[1], spent: budget - left, done: true, points };
  }

  /**
   * Track reachable with a movement budget from a: [{ edge, from, to }] with from/to as fractions along the
   * edge (a → b). Used for the drag preview.
   */
  function reach(net, a, budget, opt = {}) {
    if (!net.edges.length || budget <= 0) return [];
    const speed = opt.speed || net.opt.speed, cache = {};
    const on = board(net, a.x, a.y, opt.usable, cache);
    if (!on || on.d >= budget) return [];
    const trackKm = (budget - on.d) * speed;
    const { dist: d } = spread(net, on, opt.usable, cache, trackKm);
    const out = [];
    net.edges.forEach((e, i) => {
      if (!openEdge(net, i, opt.usable, cache)) return;
      if (i === on.edge) {
        const back = Math.min(on.t, trackKm / (e.km || 1)), fwd = Math.min(1 - on.t, trackKm / (e.km || 1));
        out.push({ edge: i, from: on.t - back, to: on.t + fwd });
        return;
      }
      const ra = trackKm - d[e.a], rb = trackKm - d[e.b];
      if (ra <= 0 && rb <= 0) return;
      if (ra > 0 && rb > 0 && ra + rb >= e.km) { out.push({ edge: i, from: 0, to: 1 }); return; }
      if (ra > 0) out.push({ edge: i, from: 0, to: Math.min(1, ra / (e.km || 1)) });
      if (rb > 0) out.push({ edge: i, from: Math.max(0, 1 - rb / (e.km || 1)), to: 1 });
    });
    return out;
  }

  const api = { DEFAULTS, build, route, walk, reach, project, arcAt, cutIntervals };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RailNet = api;
})(typeof window !== 'undefined' ? window : globalThis);
