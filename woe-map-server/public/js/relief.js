'use strict';
/* global PIXI, Terrain */
/**
 * Hills and mountains drawn on the map (docs/TERRAIN.md). Over the land and the territory colours, so the relief reads
 * whoever holds the ground, and under towns, drawings and units:
 *   - Earth maps: a hillshade of the bundled elevation grid (public/js/terrain.js), lit from the north-west: shadowed
 *     slopes darken, lit ones lighten a little, mountains take a faint brown wash and hills a fainter ochre, and the
 *     rugged tops above the snow line (lower towards the poles) are white. Built once per map in 900-cell tiles
 *     (sea-only tiles skipped), one at a time in idle moments so the page never stalls.
 *   - Image maps: the GM's painted Hills / Mountains areas (area drawings with data.terrain) get a light wash.
 *   - Close in (from 250 % zoom, fading in to 350 %): mountain and hill sprites (public/assets/terrain.png, cut by
 *     scripts/build-terrain.js from the user's sheets) laid out as ranges: the highest ground takes the biggest peaks,
 *     the flanks and foothills smaller ones, overlapping, nearer sprites in front; snow-capped sprites where the snow
 *     lies, bare rock below it. Placed per 64 px chunk of the map from a lattice fixed to the map (the same in every
 *     browser); only the chunks in view are built, and a few hundred are kept.
 * MapRenderer owns one (renderer.relief): setEarth(opts) with the map, clear() when it goes, upsert / remove for
 * drawings, tick(scale, view) every frame.
 */
(function () {
  const TILE = 900;          // grid cells per tile side: the 5400 × 2700 grid is 6 × 3 tiles
  const EXAGGERATE = 28;     // vertical exaggeration of the hillshade (cells are about 7.4 km across)
  const CELL_M = 7400;
  const L = [-Math.cos(40 * Math.PI / 180) * Math.SQRT1_2, -Math.cos(40 * Math.PI / 180) * Math.SQRT1_2, Math.sin(40 * Math.PI / 180)];   // light from the NW, 40° up
  const CHUNK = 64;          // map px per glyph chunk
  const PEAKS_FROM = 2.5, PEAKS_FULL = 3.5, KEEP = 400;
  const STEP = 1.6;          // map px between candidate spots (about one elevation cell on the usual Earth)
  const SIZE = { mtnMin: 5.5, mtnMax: 18, hillMin: 7, hillMax: 12 };   // sprite widths in map px
  const OVERLAP = { mountains: 0.42, hills: 0.62 };   // how close two sprites may stand, as a share of their mean width
  const PAINT_K = 3;         // maps without an Earth grid (image maps) have bigger map px: glyphs, spacing and chunks × 3, shown 3× sooner

  const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
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

  /** How white a grid cell is, 0..1: the 3 × 3 average above the snow line, on a top standing over its surroundings. */
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

  /** Paint colour (rgb 0..255) with alpha a over an RGBA accumulator (straight alpha, 0..1). */
  function over(acc, r, g, b, a) {
    if (a <= 0) return;
    const ao = a + acc[3] * (1 - a);
    acc[0] = (r * a + acc[0] * acc[3] * (1 - a)) / ao;
    acc[1] = (g * a + acc[1] * acc[3] * (1 - a)) / ao;
    acc[2] = (b * a + acc[2] * acc[3] * (1 - a)) / ao;
    acc[3] = ao;
  }

  // ---- Sprites: the atlas of mountains and hills, loaded once per page ------------------------------------------------
  let atlasPromise = null;
  /**
   * { hills, bare, mid, snowy, green }: the mountain sprites sorted into thirds by how much snow they show (the green,
   * alpine one apart), and the hills, each { tex, ax, ay, w, h, warm }, every list ordered from grey to brown.
   */
  function loadAtlas() {
    if (!atlasPromise) {
      atlasPromise = Promise.all([
        fetch('/assets/terrain.json?v=2').then(r => r.json()),
        PIXI.Assets.load({ src: '/assets/terrain.png?v=2', loadParser: 'loadTextures' }),
      ]).then(([meta, base]) => {
        base.source.scaleMode = 'linear';
        const mk = f => ({ ...f, tex: new PIXI.Texture({ source: base.source, frame: new PIXI.Rectangle(f.x, f.y, f.w, f.h) }) });
        const mtn = meta.mountains.map(mk), rocky = mtn.filter(f => f.green <= 0.3).sort((a, b) => a.snow - b.snow);
        const third = Math.ceil(rocky.length / 3), byWarmth = list => list.sort((a, b) => a.warm - b.warm);
        return { hills: byWarmth(meta.hills.map(mk)), bare: byWarmth(rocky.slice(0, third)), mid: byWarmth(rocky.slice(third, 2 * third)), snowy: byWarmth(rocky.slice(2 * third)), green: mtn.filter(f => f.green > 0.3) };
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
      this.paintG = new PIXI.Graphics();
      this.peakC = new PIXI.Container(); this.peakC.visible = false;
      this.layer.addChild(this.shadeC, this.paintG, this.peakC);
      this.grid = null; this.map = null; this._gen = 0;
      this.areas = new Map();   // shape id -> { key, pts, bbox, cls }
      this.chunks = new Map();  // "cx,cy" -> { c, used }
      this._viewKey = '';
    }
    /** Anything to draw (an Earth grid, or painted ground)? */
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

    // ---- Painted ground (image maps, or a ridge the Earth grid misses) ------------------------------------------------
    upsert(s) {
      const t = s.kind === 'area' && Array.isArray(s.points) && s.points.length >= 3 ? s.data?.terrain : null;
      if (t !== 'hills' && t !== 'mountains') { this.remove(s.id); return; }
      const key = `${t}|${JSON.stringify(s.points)}`;
      if (this.areas.get(s.id)?.key === key) return;
      const pts = s.points.map(p => [Number(p[0]), Number(p[1])]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      this.areas.set(s.id, { key, pts, cls: t === 'mountains' ? Terrain.MOUNTAINS : Terrain.HILLS, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
      this._paintedChanged();
    }
    remove(id) { if (this.areas.delete(id)) this._paintedChanged(); }
    _paintedChanged() {
      const g = this.paintG;
      g.clear();
      for (const a of this.areas.values()) {
        g.poly(a.pts.flat()).fill(a.cls === Terrain.MOUNTAINS ? { color: 0x5c4632, alpha: 0.2 } : { color: 0x96784a, alpha: 0.12 });
      }
      this._dropChunks();
      this.r.invalidate();
    }
    _paintedAt(x, y) {
      let c = Terrain.FLAT;
      for (const a of this.areas.values()) {
        const b = a.bbox;
        if (a.cls <= c || x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        let inside = false;
        for (let i = 0, j = a.pts.length - 1; i < a.pts.length; j = i++) {
          const [xi, yi] = a.pts[i], [xj, yj] = a.pts[j];
          if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) c = a.cls;
      }
      return c;
    }

    // ---- Peaks close in ---------------------------------------------------------------------------------------------
    get _k() { return this.grid ? 1 : PAINT_K; }
    tick(s, view) {
      const K = this._k, CH = CHUNK * K, from = PEAKS_FROM / K, full = PEAKS_FULL / K;
      if (K !== this._chunkK) { this._dropChunks(); this._chunkK = K; }
      const show = s >= from && this.active;
      if (show && !this.atlas) {
        if (!this._atlasLoading) {
          this._atlasLoading = true;
          loadAtlas().then(a => { this.atlas = a; this._dropChunks(); this.r.invalidate(); }).catch(() => {}).finally(() => { this._atlasLoading = false; });
        }
        return;
      }
      if (!show) { if (this.peakC.visible) { this.peakC.visible = false; } return; }
      this.peakC.visible = true;
      this.peakC.alpha = smooth((s - from) / (full - from)) * 0.95 + 0.05;
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
            if (ch.c) this.peakC.addChild(ch.c);
          }
          ch.used = stamp;
          if (ch.c) ch.c.visible = true;
        }
      }
      if (this.chunks.size > KEEP) {
        const old = [...this.chunks.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, this.chunks.size - KEEP);
        for (const [k, ch] of old) { if (ch.c) ch.c.destroy({ children: true }); this.chunks.delete(k); }
      }
      if (built) this.r.invalidate();
      if (!this._viewKey) this.r.invalidate();
    }
    _dropChunks() {
      for (const ch of this.chunks.values()) if (ch.c) ch.c.destroy({ children: true });
      this.chunks.clear(); this._viewKey = '';
    }
    /**
     * One chunk's sprites (a Container, nearer ones in front), or null when it has no hills or mountains. Laid out as
     * ranges: candidate spots on a lattice fixed to the map (jittered by a hash of the spot) over the chunk and a margin
     * round it are taken highest ground first, each giving a sprite sized by its height (the crest of the Alps gets
     * peaks three times the width of the foothills'), and a spot is skipped when it would stand too close to a sprite
     * already placed (closer than OVERLAP of their mean width, so neighbours overlap like a range rather than sit
     * apart). Hills come after the mountains. Only the sprites whose foot is in the chunk are kept; the margin makes
     * neighbouring chunks agree near their edges.
     */
    _chunk(cx, cy) {
      const grid = this.grid, map = this.map || this.r.mapSize, A = this.atlas;
      if (!map || !map.w || !A) return null;
      const K = this._k, CH = CHUNK * K, step = STEP * K, wMax = SIZE.mtnMax * K, margin = wMax;
      const x0 = cx * CH, y0 = cy * CH;
      if (x0 >= map.w || y0 >= map.h || x0 + CH <= 0 || y0 + CH <= 0) return null;
      const at = (x, y) => {
        let c = Terrain.FLAT, e = 0, snow = 0;
        if (grid) {
          const gx = Math.min(grid.W - 1, Math.max(0, Math.floor(x / map.w * grid.W))), gy = Math.min(grid.H - 1, Math.max(0, Math.floor(y / map.h * grid.H)));
          const i = gy * grid.W + gx;
          c = grid.cls[i]; e = grid.elev[i] * Terrain.M_PER_STEP;
          if (c === Terrain.MOUNTAINS) snow = snowAt(grid, gx, gy);
        }
        if (this.areas.size && c < Terrain.MOUNTAINS) {
          const p = this._paintedAt(x, y);
          if (p > c) { c = p; e = -1; }   // painted: no height (sized at random below)
        }
        return { c, e, snow };
      };
      const cands = [];
      const i0 = Math.floor((x0 - margin) / step), i1 = Math.ceil((x0 + CH + margin) / step);
      const j0 = Math.floor((y0 - margin) / step), j1 = Math.ceil((y0 + CH + margin) / step);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = (i + 0.5 + (hash(i, j, 1) - 0.5) * 0.9) * step, y = (j + 0.5 + (hash(i, j, 2) - 0.5) * 0.9) * step;
          if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
          const g = at(x, y);
          if (g.c === Terrain.FLAT) continue;
          const r = hash(i, j, 3), r2 = hash(i, j, 4);
          if (g.c === Terrain.MOUNTAINS) {
            const t = g.e < 0 ? 0.35 + r * 0.45 : Math.min(1, Math.max(0, (g.e - 500) / 2800)) ** 0.85;
            const w = (SIZE.mtnMin + (SIZE.mtnMax - SIZE.mtnMin) * t) * (0.82 + 0.36 * r2) * K;
            cands.push({ x, y, w, cls: Terrain.MOUNTAINS, pr: (g.e < 0 ? t * 3000 : g.e) + r * 450, snow: g.snow, e: g.e, pick: hash(i, j, 5), alt: hash(i, j, 6) });
          } else {
            const w = (SIZE.hillMin + (SIZE.hillMax - SIZE.hillMin) * r2) * K;
            cands.push({ x, y, w, cls: Terrain.HILLS, pr: -10000 + r * 1000, pick: hash(i, j, 5) });
          }
        }
      }
      if (!cands.length) return null;
      cands.sort((a, b) => b.pr - a.pr);
      // Greedy, biggest first, with a spatial index of what is placed (cells of the widest sprite).
      const placed = [], index = new Map(), cell = wMax;
      const key = (gx, gy) => gx * 100003 + gy;
      for (const c of cands) {
        const f = c.cls === Terrain.MOUNTAINS ? OVERLAP.mountains : OVERLAP.hills;
        const gx = Math.floor(c.x / cell), gy = Math.floor(c.y / cell);
        let ok = true;
        for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1 && ok; dx++) {
          for (const p of index.get(key(gx + dx, gy + dy)) || []) {
            const min = f * (c.w + p.w) / 2, ddx = c.x - p.x, ddy = (c.y - p.y) * 1.5;   // sprites are wider than deep
            if (ddx * ddx + ddy * ddy < min * min) { ok = false; break; }
          }
        }
        if (!ok) continue;
        placed.push(c);
        const k = key(gx, gy);
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(c);
      }
      const mine = placed.filter(p => p.x >= x0 && p.x < x0 + CH && p.y >= y0 && p.y < y0 + CH);
      if (!mine.length) return null;
      mine.sort((a, b) => a.y - b.y);
      // Neighbouring peaks share a colour: within each list (grey to brown) the pick follows a smooth field about
      // 45 map px across (some 200 km on the Earth), with a little scatter.
      const region = (x, y) => {
        const size = 45 * K, gx = x / size, gy = y / size, i = Math.floor(gx), j = Math.floor(gy), fx = smooth(gx - i), fy = smooth(gy - j);
        const v = (a, b) => hash(a, b, 9), top = v(i, j) + (v(i + 1, j) - v(i, j)) * fx, bot = v(i, j + 1) + (v(i + 1, j + 1) - v(i, j + 1)) * fx;
        return smooth(Math.min(1, Math.max(0, (top + (bot - top) * fy - 0.5) * 1.8 + 0.5)));
      };
      const choose = (list, r, p) => list[Math.min(list.length - 1, Math.max(0, Math.floor((region(p.x, p.y) + (r - 0.5) * 0.4) * list.length)))];
      const c = new PIXI.Container(); c.eventMode = 'none';
      for (const p of mine) {
        let f;
        if (p.cls === Terrain.HILLS) f = choose(A.hills, p.pick, p);
        else if (p.snow > 0.45) f = choose(A.snowy, p.pick, p);
        else if (p.snow > 0.12) f = choose(A.mid, p.pick, p);
        else if (A.green.length && p.e >= 0 && p.e < 1500 && p.alt < 0.2) f = choose(A.green, p.pick, p);
        else f = choose(A.bare, p.pick, p);
        const sp = new PIXI.Sprite(f.tex);
        sp.anchor.set(f.ax, f.ay);
        sp.scale.set(p.w / f.w);
        sp.position.set(p.x, p.y);
        c.addChild(sp);
      }
      return c;
    }

    // ---- Hillshade tiles (Earth) ----------------------------------------------------------------------------------
    /** One tile's sprite (or null when it is all sea). */
    _tile(grid, tx, ty, mapW, mapH) {
      const { W: GW, H: GH, elev, cls } = grid;
      const x0 = tx * TILE, y0 = ty * TILE, w = Math.min(TILE, GW - x0), h = Math.min(TILE, GH - y0);
      let land = false;
      for (let y = y0; y < y0 + h && !land; y++) for (let x = x0; x < x0 + w; x++) if (elev[y * GW + x]) { land = true; break; }
      if (!land) return null;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(w, h), px = img.data;
      const M = Terrain.M_PER_STEP, k = EXAGGERATE / CELL_M, flatLit = L[2];
      const z = (x, y) => elev[Math.min(GH - 1, Math.max(0, y)) * GW + ((x + GW) % GW)] * M;
      const acc = [0, 0, 0, 0];
      for (let y = 0; y < h; y++) {
        const gy = y0 + y;
        for (let x = 0; x < w; x++) {
          const gx = x0 + x, i = gy * GW + gx, e = elev[i];
          if (!e) continue;
          acc[0] = acc[1] = acc[2] = acc[3] = 0;
          const c = cls[i], em = e * M;
          if (c === Terrain.MOUNTAINS) over(acc, 92, 70, 50, 0.13 + Math.min(0.12, em / 30000));
          else if (c === Terrain.HILLS) over(acc, 150, 120, 70, 0.07);
          const sn = c === Terrain.MOUNTAINS || c === Terrain.HILLS ? snowAt(grid, gx, gy) : 0;
          if (sn > 0) over(acc, 248, 250, 255, 0.92 * sn);
          // Hillshade: the surface normal against the light, relative to flat ground, with a little dead zone so the
          // plains stay calm.
          const sx = (z(gx + 1, gy) - z(gx - 1, gy)) / 2 * k, sy = (z(gx, gy + 1) - z(gx, gy - 1)) / 2 * k;
          const raw = (L[0] * -sx + L[1] * -sy + L[2]) / Math.sqrt(sx * sx + sy * sy + 1) - flatLit;
          const v = Math.sign(raw) * Math.max(0, Math.abs(raw) - 0.025);
          if (v < 0) over(acc, 20, 24, 34, Math.min(0.62, -v * 1.6));
          else if (v > 0) over(acc, 255, 250, 235, Math.min(0.3, v * 1.1));
          if (acc[3] <= 0.004) continue;
          const o = (y * w + x) * 4;
          px[o] = acc[0]; px[o + 1] = acc[1]; px[o + 2] = acc[2]; px[o + 3] = Math.round(acc[3] * 255);
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
