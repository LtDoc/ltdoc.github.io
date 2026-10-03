'use strict';
/* global PIXI, Terrain */
/**
 * Mountains drawn on the map (docs/TERRAIN.md). Over the land and the territory colours, so the relief reads whoever
 * holds the ground, and under towns, drawings and units. Hills have no drawing of their own (their rules stand);
 * they show only through the shading.
 *   - Earth maps: a hillshade of the bundled elevation grid (public/js/terrain.js), lit from the north-west, heights
 *     smoothed over 3 × 3 cells: shadowed slopes darken, lit ones lighten a little, nothing else. Built once per map in
 *     900-cell tiles (sea-only tiles skipped), one at a time in idle moments so the page never stalls.
 *   - Close in (from 220 % zoom, fading in to 300 %): the user's mountain sprites (public/assets/terrain.png, packed
 *     by scripts/build-terrain.js), sparse: a few clusters along each range, the broadest and snow-tipped on the highest
 *     ground, single bare peaks on the lower; and trees round the foot of the ranges, so the mountains meet the plain.
 *     Placed per 64 px chunk of the map from a lattice fixed to the map (the same in every browser); only the chunks in
 *     view are built, and a few hundred are kept. Painted Mountains areas (image maps) get the same, their spine
 *     standing for the crest.
 * MapRenderer owns one (renderer.relief): setEarth(opts) with the map, clear() when it goes, upsert / remove for
 * drawings, tick(scale, view) every frame.
 */
(function () {
  const TILE = 900;          // grid cells per tile side: the 5400 × 2700 grid is 6 × 3 tiles
  const EXAGGERATE = 28;     // vertical exaggeration of the hillshade (cells are about 7.4 km across)
  const CELL_M = 7400;
  const L = [-Math.cos(40 * Math.PI / 180) * Math.SQRT1_2, -Math.cos(40 * Math.PI / 180) * Math.SQRT1_2, Math.sin(40 * Math.PI / 180)];   // light from the NW, 40° up
  const CHUNK = 64;          // map px per sprite chunk
  const SHOW_FROM = 2.2, SHOW_FULL = 3, KEEP = 400;
  const MTN_W = 30;          // map px across the broadest mountain sprite (a single peak is about half that)
  const TREE_W = 14;         // map px across the broad grove (a clump of trees is a quarter to two thirds of that)
  const MTN_STEP = 3, TREE_STEP = 3;   // map px between candidate spots
  const PAINT_K = 3;         // maps without an Earth grid (image maps) have bigger map px: sizes, spacing and chunks × 3, shown 3× sooner

  const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const clamp01 = v => Math.min(1, Math.max(0, v));
  const idle = fn => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 16));
  /** A fixed pseudo-random number in [0, 1) for a lattice spot (i, j) and a purpose k: the same in every browser. */
  const hash = (i, j, k) => {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };

  let gridPromise = null;
  /** The elevation grid, fetched and classified once per page (shared with every map shown). */
  function loadGrid() {
    if (!gridPromise) {
      gridPromise = fetch('/earth/terrain.bin.gz').then(r => {
        if (!r.ok) throw new Error('terrain grid missing');
        return r.arrayBuffer();
      }).then(buf => { const g = Terrain.decode(new Uint8Array(buf)); Terrain.classify(g); return g; });
      gridPromise.catch(() => { gridPromise = null; });
    }
    return gridPromise;
  }

  /** How snowy a grid cell is, 0..1: the 3 × 3 average above the snow line, on a top standing over its surroundings. */
  function snowAt(grid, gx, gy) {
    const { W: GW, H: GH, elev, cls } = grid, M = Terrain.M_PER_STEP;
    const i = gy * GW + gx, e = elev[i];
    if (!e || cls[i] === Terrain.FLAT) return 0;
    const snow = Terrain.snowLine(90 - (gy + 0.5) / GH * 180);
    if (e * M < snow - 500) return 0;
    const at = (dx, dy) => elev[Math.min(GH - 1, Math.max(0, gy + dy)) * GW + ((gx + dx + GW) % GW)];
    let sum = 0, lo = 255;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += at(dx, dy);
    for (let dy = -3; dy <= 3; dy += 3) for (let dx = -3; dx <= 3; dx += 3) lo = Math.min(lo, at(dx, dy));
    return smooth((sum / 9 * M - snow + 250) / 500) * smooth(((e - lo) * M - 150) / 400);
  }

  // ---- Sprites: the atlas, loaded once per page ------------------------------------------------------------------
  let atlasPromise = null;
  /** { snowy, bare, trees }: lists of { tex, ax, ay, w, h, span }, each from the smallest sprite to the broadest. */
  function loadAtlas() {
    if (!atlasPromise) {
      atlasPromise = Promise.all([
        fetch('/assets/terrain.json?v=3').then(r => r.json()),
        PIXI.Assets.load({ src: '/assets/terrain.png?v=3', loadParser: 'loadTextures' }),
      ]).then(([meta, base]) => {
        base.source.scaleMode = 'linear';
        const mk = f => ({ ...f, tex: new PIXI.Texture({ source: base.source, frame: new PIXI.Rectangle(f.x, f.y, f.w, f.h) }) });
        return { snowy: meta.snowy.map(mk), bare: meta.bare.map(mk), trees: meta.trees.map(mk) };
      });
      atlasPromise.catch(() => { atlasPromise = null; });
    }
    return atlasPromise;
  }

  class Relief {
    constructor(renderer) {
      this.r = renderer;
      this.layer = new PIXI.Container(); this.layer.eventMode = 'none';
      this.shadeC = new PIXI.Container();
      this.spriteC = new PIXI.Container(); this.spriteC.visible = false;
      this.layer.addChild(this.shadeC, this.spriteC);
      this.grid = null; this.map = null; this._gen = 0;
      this.areas = new Map();   // painted Mountains: shape id -> { key, pts, bbox }
      this.chunks = new Map();  // "cx,cy" -> { c, used }
      this._viewKey = '';
    }
    /** Anything to draw (an Earth grid, or painted mountains)? */
    get active() { return !!this.grid || this.areas.size > 0; }

    /** Draw the relief of an Earth map of opts.width × opts.height px. */
    async setEarth(opts) {
      const gen = ++this._gen;
      this.clear(false);
      let grid;
      try { grid = await loadGrid(); } catch { return; }
      if (gen !== this._gen) return;
      this.grid = grid; this.map = { w: opts.width, h: opts.height };
      this._dropChunks();
      const tiles = [];
      for (let ty = 0; ty < Math.ceil(grid.H / TILE); ty++) for (let tx = 0; tx < Math.ceil(grid.W / TILE); tx++) tiles.push([tx, ty]);
      const next = () => {
        if (gen !== this._gen || !tiles.length) return;
        const [tx, ty] = tiles.shift();
        const sp = this._tile(grid, tx, ty, opts.width, opts.height);
        if (sp) { this.shadeC.addChild(sp); this.r.invalidate(); }
        idle(next);
      };
      idle(next);
    }

    clear(bump = true) {
      if (bump) this._gen++;
      for (const c of this.shadeC.removeChildren()) { c.texture.destroy(true); c.destroy(); }
      this.grid = null; this.map = null;
      this._dropChunks();
      this.r.invalidate();
    }

    // ---- Painted mountains (image maps, or a ridge the Earth grid misses) -------------------------------------------
    upsert(s) {
      const ok = s.kind === 'area' && Array.isArray(s.points) && s.points.length >= 3 && s.data?.terrain === 'mountains';
      if (!ok) { this.remove(s.id); return; }
      const key = JSON.stringify(s.points);
      if (this.areas.get(s.id)?.key === key) return;
      const pts = s.points.map(p => [Number(p[0]), Number(p[1])]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      this.areas.set(s.id, { key, pts, bbox, depth: 0.3 * Math.min(bbox[2] - bbox[0], bbox[3] - bbox[1]) });
      this._paintedChanged();
    }
    remove(id) { if (this.areas.delete(id)) this._paintedChanged(); }
    _paintedChanged() { this._dropChunks(); this.r.invalidate(); }
    /** The painted range a point is in, with how deep inside it (0 at the edge, 1 along its spine), or null. */
    _painted(x, y) {
      for (const a of this.areas.values()) {
        const b = a.bbox;
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        let inside = false, d = Infinity;
        for (let i = 0, j = a.pts.length - 1; i < a.pts.length; j = i++) {
          const [x1, y1] = a.pts[j], [x2, y2] = a.pts[i], dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
          if ((y2 > y) !== (y1 > y) && x < (x1 - x2) * (y - y2) / (y1 - y2) + x2) inside = !inside;
          const t = l2 ? clamp01(((x - x1) * dx + (y - y1) * dy) / l2) : 0;
          d = Math.min(d, Math.hypot(x - x1 - dx * t, y - y1 - dy * t));
        }
        if (inside) return { depth: Math.min(1, d / Math.max(1e-6, a.depth)) };
      }
      return null;
    }

    // ---- Sprites close in -------------------------------------------------------------------------------------------
    get _k() { return this.grid ? 1 : PAINT_K; }
    tick(s, view) {
      const K = this._k, CH = CHUNK * K, from = SHOW_FROM / K, full = SHOW_FULL / K;
      if (K !== this._chunkK) { this._dropChunks(); this._chunkK = K; }
      const show = s >= from && this.active;
      if (show && !this.atlas) {
        if (!this._atlasLoading) {
          this._atlasLoading = true;
          loadAtlas().then(a => { this.atlas = a; this._dropChunks(); this.r.invalidate(); }).catch(() => {}).finally(() => { this._atlasLoading = false; });
        }
        return;
      }
      if (!show) { if (this.spriteC.visible) this.spriteC.visible = false; return; }
      this.spriteC.visible = true;
      this.spriteC.alpha = smooth((s - from) / (full - from)) * 0.95 + 0.05;
      const cx0 = Math.floor(view[0] / CH) - 1, cy0 = Math.floor(view[1] / CH) - 1, cx1 = Math.floor(view[2] / CH) + 1, cy1 = Math.floor(view[3] / CH) + 1;
      const key = `${cx0},${cy0},${cx1},${cy1}`;
      if (key === this._viewKey) return;
      this._viewKey = key;
      const stamp = performance.now();
      for (const ch of this.chunks.values()) if (ch.c) ch.c.visible = false;
      let built = 0;
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = `${cx},${cy}`;
          let ch = this.chunks.get(k);
          if (!ch) {
            if (built >= 10) { this._viewKey = ''; continue; }   // a big jump: finish on the next frames
            ch = { c: this._chunk(cx, cy), used: 0 }; built++;
            this.chunks.set(k, ch);
            if (ch.c) this.spriteC.addChild(ch.c);
          }
          ch.used = stamp;
          if (ch.c) ch.c.visible = true;
        }
      }
      if (this.chunks.size > KEEP) {
        const old = [...this.chunks.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, this.chunks.size - KEEP);
        for (const [k, ch] of old) { if (ch.c) ch.c.destroy({ children: true }); this.chunks.delete(k); }
      }
      if (built || !this._viewKey) this.r.invalidate();
    }
    _dropChunks() {
      for (const ch of this.chunks.values()) if (ch.c) ch.c.destroy({ children: true });
      this.chunks.clear(); this._viewKey = '';
    }

    /**
     * The ground at a map point: { mtn (it is mountains), e (height in m; painted: -1), level (0..1: how high within
     * mountains: the height on the Earth, the depth inside a painted range), snow (0..1), foot (0..1: how much this is
     * the foot of a range, where trees go), lat }.
     */
    _ground(x, y, map) {
      const grid = this.grid;
      const out = { mtn: false, e: 0, level: 0, snow: 0, foot: 0, lat: 45 };
      if (grid) {
        const gx = Math.min(grid.W - 1, Math.max(0, Math.floor(x / map.w * grid.W))), gy = Math.min(grid.H - 1, Math.max(0, Math.floor(y / map.h * grid.H)));
        const i = gy * grid.W + gx, c = grid.cls[i];
        out.lat = 90 - (gy + 0.5) / grid.H * 180;
        if (!grid.elev[i]) return out;   // sea
        out.e = grid.elev[i] * Terrain.M_PER_STEP;
        out.mtn = c === Terrain.MOUNTAINS;
        if (out.mtn) { out.level = clamp01((out.e - 500) / 2000) ** 0.8; out.snow = snowAt(grid, gx, gy); }
        // The foot of a range: below 1400 m, with mountains within about 20 km, not on the high ground itself.
        if (out.e < 1400 && out.snow === 0) {
          let near = 0;
          for (let dy = -3; dy <= 3; dy += 3) for (let dx = -3; dx <= 3; dx += 3) {
            const j = Math.min(grid.H - 1, Math.max(0, gy + dy)) * grid.W + ((gx + dx + grid.W) % grid.W);
            if (grid.cls[j] === Terrain.MOUNTAINS) near++;
          }
          if (near && !(out.mtn && near >= 8)) out.foot = smooth((1400 - out.e) / 600) * Math.min(1, near / 3);
        }
      }
      if (this.areas.size && !out.mtn) {
        const p = this._painted(x, y);
        if (p) {
          out.mtn = true; out.e = -1; out.level = 0.1 + 0.9 * p.depth; out.snow = smooth((p.depth - 0.55) / 0.35);
          out.foot = p.depth < 0.22 ? 1 - p.depth / 0.22 : 0;
        }
      }
      return out;
    }

    /**
     * One chunk's sprites (a Container, nearer ones in front), or null. Less is more:
     *   - Mountains: candidate spots on a lattice fixed to the map (jittered by a hash of the spot) over the chunk and a
     *     margin are taken highest ground first; each picks a sprite by height (single peaks low, broad clusters on the
     *     crests; snow-tipped where the snow lies), drawn at its own width, and is skipped if it would crowd one already
     *     placed (closer than their mean width: small gaps between) or spill well off the mountains. So a range gets a few clusters
     *     along its spine rather than a carpet.
     *   - Trees: round the foot of the ranges (below 1400 m with mountains near; fewer in the dry subtropics), sparse stands,
     *     clear of the mountain sprites.
     * Only the sprites whose foot is in the chunk are kept; the margin makes neighbouring chunks agree near their edges.
     */
    _chunk(cx, cy) {
      const map = this.map || this.r.mapSize, A = this.atlas;
      if (!map || !map.w || !A) return null;
      const K = this._k, CH = CHUNK * K, margin = MTN_W * K;
      const x0 = cx * CH, y0 = cy * CH;
      if (x0 >= map.w || y0 >= map.h || x0 + CH <= 0 || y0 + CH <= 0) return null;
      const placed = [], index = new Map(), cell = margin;
      const key = (gx, gy) => gx * 100003 + gy;
      const fits = (c, f) => {
        const gx = Math.floor(c.x / cell), gy = Math.floor(c.y / cell);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          for (const p of index.get(key(gx + dx, gy + dy)) || []) {
            const min = f * (c.w + p.w) / 2, ddx = c.x - p.x, ddy = (c.y - p.y) * 1.8;   // the sprites are wide and shallow
            if (ddx * ddx + ddy * ddy < min * min) return false;
          }
        }
        return true;
      };
      const place = c => {
        placed.push(c);
        const k = key(Math.floor(c.x / cell), Math.floor(c.y / cell));
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(c);
      };
      const lattice = (step, salt, fn) => {
        const i0 = Math.floor((x0 - margin) / step), i1 = Math.ceil((x0 + CH + margin) / step);
        const j0 = Math.floor((y0 - margin) / step), j1 = Math.ceil((y0 + CH + margin) / step);
        const out = [];
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const x = (i + 0.5 + (hash(i, j, salt) - 0.5) * 0.9) * step, y = (j + 0.5 + (hash(i, j, salt + 1) - 0.5) * 0.9) * step;
          if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
          const c = fn(x, y, i, j);
          if (c) out.push(c);
        }
        return out;
      };
      // Mountains, highest first.
      const mtns = lattice(MTN_STEP * K, 1, (x, y, i, j) => {
        const g = this._ground(x, y, map);
        if (!g.mtn) return null;
        const r = hash(i, j, 3);
        if (g.level < 0.35 && hash(i, j, 5) < 0.35) return null;   // the low ground of a range: thinned out
        return { x, y, g, r, pick: hash(i, j, 4), pr: g.level * 3000 + r * 400 };
      }).sort((a, b) => b.pr - a.pr);
      for (const c of mtns) {
        const list = c.g.snow > 0.2 ? A.snowy : A.bare;
        let lv = Math.min(list.length - 1, Math.max(0, Math.round(c.g.level * (list.length - 1) + (c.pick - 0.5) * 1.6)));
        for (; lv >= 0; lv--) {
          const f = list[lv];
          c.f = f; c.w = f.span * MTN_W * K * (0.9 + 0.2 * c.r);
          // Most of its breadth must stand on mountains: a cluster that would spill onto the plain steps down a size.
          const spill = [-0.32, 0.32].filter(dx => !this._ground(c.x + dx * c.w, c.y, map).mtn).length;
          if (spill === 0 || lv === 0) break;
        }
        if (fits(c, 1.05)) place(c);
      }
      // Trees round the foot of the ranges.
      const trees = lattice(TREE_STEP * K, 7, (x, y, i, j) => {
        const g = this._ground(x, y, map);
        if (g.foot <= 0) return null;
        const dry = Math.abs(g.lat) > 14 && Math.abs(g.lat) < 36 ? 0.3 : 1;   // the subtropical dry belt: fewer
        if (hash(i, j, 9) > g.foot * 0.22 * dry) return null;
        const pick = hash(i, j, 10), f = A.trees[Math.min(A.trees.length - 1, Math.floor((0.35 + 0.65 * Math.sqrt(pick)) * A.trees.length))];   // mostly the bigger stands
        return { x, y, f, w: f.span * TREE_W * K * (0.85 + 0.3 * hash(i, j, 11)), pr: hash(i, j, 12) };
      }).sort((a, b) => b.pr - a.pr);
      for (const c of trees) if (fits(c, 1.1)) place(c);

      const mine = placed.filter(p => p.x >= x0 && p.x < x0 + CH && p.y >= y0 && p.y < y0 + CH);
      if (!mine.length) return null;
      mine.sort((a, b) => a.y - b.y);
      const out = new PIXI.Container(); out.eventMode = 'none';
      for (const p of mine) {
        const sp = new PIXI.Sprite(p.f.tex);
        sp.anchor.set(p.f.ax, p.f.ay);
        sp.scale.set(p.w / p.f.w);
        sp.position.set(p.x, p.y);
        out.addChild(sp);
      }
      return out;
    }

    // ---- Hillshade tiles (Earth) ----------------------------------------------------------------------------------
    /** One tile's sprite (or null when it is all sea): shading only, from heights smoothed over 3 × 3 cells. */
    _tile(grid, tx, ty, mapW, mapH) {
      const { W: GW, H: GH, elev } = grid;
      const x0 = tx * TILE, y0 = ty * TILE, w = Math.min(TILE, GW - x0), h = Math.min(TILE, GH - y0);
      let land = false;
      for (let y = y0; y < y0 + h && !land; y++) for (let x = x0; x < x0 + w; x++) if (elev[y * GW + x]) { land = true; break; }
      if (!land) return null;
      // Smoothed heights for the tile and a 2-cell border.
      const B = 2, SW = w + 2 * B, SH = h + 2 * B, sm = new Float32Array(SW * SH), M = Terrain.M_PER_STEP;
      const raw = (x, y) => elev[Math.min(GH - 1, Math.max(0, y)) * GW + ((x + GW) % GW)];
      for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
        const gx = x0 + x - B, gy = y0 + y - B;
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += raw(gx + dx, gy + dy) * (dx || dy ? (dx && dy ? 1 : 2) : 4);
        sm[y * SW + x] = s / 16 * M;
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(w, h), px = img.data;
      const k = EXAGGERATE / CELL_M, flatLit = L[2];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!elev[(y0 + y) * GW + x0 + x]) continue;
          const o = (y + B) * SW + x + B;
          const sx = (sm[o + 1] - sm[o - 1]) / 2 * k, sy = (sm[o + SW] - sm[o - SW]) / 2 * k;
          const raw0 = (L[0] * -sx + L[1] * -sy + L[2]) / Math.sqrt(sx * sx + sy * sy + 1) - flatLit;
          const v = Math.sign(raw0) * Math.max(0, Math.abs(raw0) - 0.025);   // a little dead zone: the plains stay calm
          if (!v) continue;
          const q = (y * w + x) * 4;
          if (v < 0) { px[q] = 20; px[q + 1] = 24; px[q + 2] = 34; px[q + 3] = Math.round(Math.min(0.55, -v * 1.5) * 255); }
          else { px[q] = 255; px[q + 1] = 250; px[q + 2] = 235; px[q + 3] = Math.round(Math.min(0.26, v * 1.0) * 255); }
        }
      }
      ctx.putImageData(img, 0, 0);
      const tex = PIXI.Texture.from(canvas);
      tex.source.scaleMode = 'linear';   // smooth between cells (the app defaults to crisp pixel art)
      const sp = new PIXI.Sprite(tex);
      sp.position.set(x0 / GW * mapW, y0 / GH * mapH);
      sp.scale.set(mapW / GW, mapH / GH);
      sp.eventMode = 'none';
      return sp;
    }
  }

  window.Relief = Relief;
})();
