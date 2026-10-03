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
 *   - Close in (from 250 % zoom, fading in to 350 %): peaks drawn over the mountains, rock faces lit on the west and
 *     shadowed on the east, white-capped above the snow line, and low rounded mounds over the hills, placed on a
 *     jittered lattice per 64 px chunk of the map (seeded by the chunk, the same in every browser), nearer ones
 *     overlapping those behind. Only the chunks in view are built, and a few hundred are kept.
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
  const SPACING = { mountains: 4.2, hills: 5 };   // map px between glyphs
  const PAINT_K = 3;         // maps without an Earth grid (image maps) have bigger map px: glyphs, spacing and chunks × 3, shown 3× sooner

  const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const idle = fn => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 16));
  const rng = seed => { let s = (seed * 2654435761) >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

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

  // ---- Glyphs: a few peak and mound drawings, made once per page ---------------------------------------------------
  let glyphs = null;
  function makeGlyphs() {
    if (glyphs) return glyphs;
    const S = 4;   // drawn at 4× the base 24 × 20 px
    const tex = draw => {
      const c = document.createElement('canvas'); c.width = 24 * S; c.height = 20 * S;
      const g = c.getContext('2d'); g.scale(S, S); g.lineJoin = 'round';
      draw(g);
      const t = PIXI.Texture.from(c);
      t.source.scaleMode = 'linear';
      return t;
    };
    const poly = (g, pts, fill) => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) g.lineTo(p[0], p[1]); g.closePath(); g.fillStyle = fill; g.fill(); };
    // A peak: ridge points [x, y] from the left foot to the right foot; the west faces are lit, the east in shadow.
    const peak = (ridge, snow) => tex(g => {
      const base = 19.5;
      g.globalAlpha = 0.28; poly(g, [[ridge[0][0] + 1.5, base], ...ridge.slice(1, -1).map(p => [p[0] + 2.5, p[1] + 2]), [ridge[ridge.length - 1][0] + 2.5, base]], '#1a140e'); g.globalAlpha = 1;
      for (let k = 1; k < ridge.length - 1; k++) {
        const top = ridge[k], l = ridge[k - 1], r = ridge[k + 1], mid = [top[0] + (r[0] - top[0]) * 0.15 + 0.4, base];
        poly(g, [[l[0], base], l, top, mid], k % 2 ? '#a8977d' : '#b4a487');          // lit west face
        poly(g, [mid, top, r, [r[0], base]], k % 2 ? '#6c5c49' : '#75644f');           // shadowed east face
        if (snow) {
          const h = (base - top[1]) * 0.44, sl = [top[0] - (top[0] - l[0]) * 0.44, top[1] + h], sr = [top[0] + (r[0] - top[0]) * 0.44, top[1] + h];
          const zig = [top[0] + (sr[0] - top[0]) * 0.1, top[1] + h * 0.72];
          poly(g, [sl, top, zig, [zig[0] - 0.6, sl[1] + 0.4]], '#f6f8fc');
          poly(g, [zig, top, sr, [sr[0] - 1, sr[1] - 0.5]], '#c8d2df');
        }
      }
      g.strokeStyle = 'rgba(40,30,20,0.55)'; g.lineWidth = 0.55;
      g.beginPath(); g.moveTo(ridge[0][0], base); for (const p of ridge) g.lineTo(p[0], p[1]); g.lineTo(ridge[ridge.length - 1][0], base); g.stroke();
    });
    const shapes = [
      [[1, 19.5], [12, 2.5], [23, 19.5]],
      [[1, 19.5], [8, 7], [11, 10], [16, 3], [23, 19.5]],
      [[0.5, 19.5], [9, 4], [13.5, 9.5], [17.5, 7.5], [23.5, 19.5]],
      [[2, 19.5], [11, 5.5], [14, 8], [22, 19.5]],
    ];
    const mound = (w, h) => tex(g => {
      const base = 19, cx = 12;
      g.globalAlpha = 0.22; g.fillStyle = '#1a140e'; g.beginPath(); g.ellipse(cx + 1.5, base, w / 2 + 1, 1.6, 0, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
      g.beginPath(); g.moveTo(cx - w / 2, base); g.bezierCurveTo(cx - w / 3, base - h, cx + w / 4, base - h * 1.05, cx + w / 2, base); g.closePath();
      const gr = g.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
      gr.addColorStop(0, 'rgba(178,170,108,0.97)'); gr.addColorStop(0.5, 'rgba(138,134,78,0.97)'); gr.addColorStop(1, 'rgba(88,84,48,0.97)');
      g.fillStyle = gr; g.fill();
      g.strokeStyle = 'rgba(50,40,25,0.45)'; g.lineWidth = 0.5; g.stroke();
    });
    glyphs = {
      peaks: shapes.map(s => peak(s, false)), snowy: shapes.map(s => peak(s, true)),
      mounds: [mound(22, 12), mound(18, 10), mound(23, 9)],
    };
    return glyphs;
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
            if (built > 40) { this._viewKey = ''; continue; }   // a big jump: finish on the next frames
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
    /** One chunk's glyphs (a Container sorted by depth), or null when it has no hills or mountains. */
    _chunk(cx, cy) {
      const grid = this.grid, map = this.map || this.r.mapSize;
      if (!map || !map.w) return null;
      const K = this._k, CH = CHUNK * K;
      const x0 = cx * CH, y0 = cy * CH;
      if (x0 >= map.w || y0 >= map.h || x0 + CH <= 0 || y0 + CH <= 0) return null;
      const G = makeGlyphs(), rand = rng(cx * 73856093 ^ cy * 19349663 ^ 0x5bd1e995);
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
          if (p > c) { c = p; e = p === Terrain.MOUNTAINS ? 2500 : 600; }
        }
        return { c, e, snow };
      };
      const items = [];
      for (const [cls, sp] of [[Terrain.MOUNTAINS, SPACING.mountains * K], [Terrain.HILLS, SPACING.hills * K]]) {
        for (let y = y0 + sp / 2; y < y0 + CH; y += sp) {
          for (let x = x0 + sp / 2 + ((Math.round(y / sp) % 2) ? sp / 2 : 0); x < x0 + CH; x += sp) {
            const px = x + (rand() - 0.5) * sp * 0.7, py = y + (rand() - 0.5) * sp * 0.7, roll = rand(), pick = rand();
            if (px < 0 || py < 0 || px >= map.w || py >= map.h) continue;
            const g = at(px, py);
            if (g.c !== cls) continue;
            if (cls === Terrain.MOUNTAINS) {
              if (roll < 0.08) continue;   // a gap now and then: ranges, not a carpet
              const hgt = 3.6 + 3.4 * Math.min(1, g.e / 4200) + roll * 0.9;
              const snowy = g.snow > 0.12 + roll * 0.25;
              items.push({ y: py, tex: (snowy ? G.snowy : G.peaks)[Math.floor(pick * 4)], x: px, h: hgt * K, flip: false });
            } else {
              if (roll < 0.12) continue;
              items.push({ y: py, tex: G.mounds[Math.floor(pick * 3)], x: px, h: (3.6 + roll * 1.6) * K, flip: pick > 0.5 });
            }
          }
        }
      }
      if (!items.length) return null;
      items.sort((a, b) => a.y - b.y);
      const c = new PIXI.Container(); c.eventMode = 'none';
      for (const it of items) {
        const sp = new PIXI.Sprite(it.tex);
        sp.anchor.set(0.5, 0.97);
        const k = it.h / 20;   // the glyphs are 24 × 20 units
        sp.scale.set(it.flip ? -k / 4 : k / 4, k / 4);   // (textures are drawn at 4×)
        sp.position.set(it.x, it.y);
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
