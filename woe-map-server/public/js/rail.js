'use strict';
/* global PIXI, RailNet */

/**
 * Railways on the map: a drawing kind whose centreline is the gameplay object (movement, sabotage; see
 * public/js/railnet.js) and whose look is a ribbon textured with the track tile from the train sheet
 * (/assets/trains.png, the user's pixel art), with top-down trains running along the open sections and
 * smoke over cut ones.
 *
 *   Rail.load()                 sheet → track tile + car frames (once, async)
 *   new Rail.View(layer, r)     one rail: track mesh, wrecked sections, smoke, trains
 *   view.update(shape, scale, cutHalfPx)   rebuild when the centreline or cuts change
 *   view.tick(dt, visible)      move the trains; returns true while anything animates
 */
const Rail = (() => {
  const SHEET = '/assets/trains.png';
  // Frames on the sheet (x, y, w, h). Top-down cars face up (their front is at the top).
  const F = {
    tile: [116, 128, 25, 16],                       // one seamless period of straight track, sleepers across
    loco: [244, 195, 23, 61],
    tender: [244, 128, 24, 64],
    wagons: [[276, 128, 24, 63], [308, 128, 24, 63], [276, 193, 24, 67], [308, 193, 24, 65]],
  };
  const MAP_WIDTH = 1.4;          // track width in map px (about 7 km on the Earth map)…
  const MIN_PX = 2.5, MAX_PX = 24; // …clamped on screen (24 px is the art's own size)
  const TRAIN_MIN_PX = 8;         // trains appear once the track is this wide on screen
  let ready = null, tileTex = null, frames = null;

  function load() {
    if (ready) return ready;
    ready = (async () => {
      const img = new Image();
      img.src = SHEET;
      await img.decode();
      // The track tile gets its own texture so it can repeat along the rail.
      const [tx, ty, tw, th] = F.tile;
      const c = document.createElement('canvas'); c.width = tw; c.height = th;
      c.getContext('2d').drawImage(img, tx, ty, tw, th, 0, 0, tw, th);
      tileTex = PIXI.Texture.from(c);
      tileTex.source.scaleMode = 'linear';            // the art is only ever shown at or below its own size
      tileTex.source.addressMode = 'repeat';
      const source = new PIXI.ImageSource({ resource: img, scaleMode: 'linear' });
      const tex = ([x, y, w, h]) => new PIXI.Texture({ source, frame: new PIXI.Rectangle(x, y, w, h) });
      frames = { loco: tex(F.loco), tender: tex(F.tender), wagons: F.wagons.map(tex) };
    })().catch(e => { console.warn('Train sheet not available', e); });
    return ready;
  }

  /** On-screen width of the track at a zoom, in screen px. */
  function screenWidth(scale) { return Math.max(MIN_PX, Math.min(MAX_PX, MAP_WIDTH * scale)); }

  // ---- Ribbon ---------------------------------------------------------------------------------
  /** Polyline → ribbon in half-width units (aPosition + aOffset × uHalfWidth), u = distance along in map px. */
  function ribbon(pts, u0 = 0) {
    const n = pts.length, positions = [], offsets = [], uvs = [], indices = [];
    let u = u0;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      const nx = -ty, ny = tx;
      let m = 1;
      if (i > 0) {
        const sx = pts[i][0] - pts[i - 1][0], sy = pts[i][1] - pts[i - 1][1], sl = Math.hypot(sx, sy) || 1;
        m = 1 / Math.max(0.5, nx * (-sy / sl) + ny * (sx / sl));
        u += sl;
      }
      positions.push(pts[i][0], pts[i][1], pts[i][0], pts[i][1]);
      offsets.push(nx * m, ny * m, -nx * m, -ny * m);
      uvs.push(u, 0, u, 1);
    }
    for (let i = 0; i < n - 1; i++) { const a = i * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    return { positions: new Float32Array(positions), offsets: new Float32Array(offsets), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
  }

  const VERT = `
    in vec2 aPosition;
    in vec2 aOffset;
    in vec2 aUV;
    out vec2 vUV;
    uniform mat3 uProjectionMatrix;
    uniform mat3 uWorldTransformMatrix;
    uniform mat3 uTransformMatrix;
    uniform highp float uHalfWidth;
    void main() {
      mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
      vec2 p = aPosition + aOffset * uHalfWidth;
      gl_Position = vec4((mvp * vec3(p, 1.0)).xy, 0.0, 1.0);
      vUV = aUV;
    }`;
  const FRAG = `
    precision highp float;
    in vec2 vUV;
    out vec4 finalColor;
    uniform sampler2D uTexture;
    uniform highp float uHalfWidth;  // map units
    uniform float uPx;               // track width on screen, px
    uniform float uMode;             // 0 open track, 1 wrecked section
    uniform float uAlpha;
    float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
    void main() {
      // The tile is 25 px across and 16 px along; keep that aspect whatever the width.
      float along = vUV.x / (uHalfWidth * 2.0 * 16.0 / 25.0);
      vec4 c = texture(uTexture, vec2(vUV.y, fract(along)));
      // Zoomed far out the pixel art would shimmer: fade to a plain dark line with two pale rails.
      float across = abs(vUV.y - 0.5) * 2.0;
      vec3 plain = mix(vec3(0.17, 0.16, 0.15), vec3(0.55, 0.53, 0.5), smoothstep(0.35, 0.5, across) * (1.0 - smoothstep(0.62, 0.75, across)));
      float detail = smoothstep(5.0, 8.0, uPx);
      vec4 simple = vec4(plain, 1.0) * (across > 0.95 ? 0.0 : 1.0);
      c = mix(simple, c, detail);
      if (uMode > 0.5) {
        // Torn up: sleepers missing, rails twisted away, everything scorched.
        float cell = floor(along * 2.6);
        float h = hash(cell), h2 = hash(cell + 17.0);
        if (h < 0.42 && across < 0.8) discard;
        if (h2 < 0.3 && across > 0.35) discard;
        c.rgb *= 0.45 + 0.25 * h;
        c.rgb = mix(c.rgb, vec3(0.12, 0.09, 0.07) * c.a, 0.45);
      }
      finalColor = c * uAlpha;
    }`;
  let program = null;
  function mesh(rib, mode) {
    if (!program) program = PIXI.GlProgram.from({ vertex: VERT, fragment: FRAG, name: 'rail' });
    const geometry = new PIXI.Geometry({
      attributes: {
        aPosition: { buffer: rib.positions, format: 'float32x2' }, aOffset: { buffer: rib.offsets, format: 'float32x2' },
        aUV: { buffer: rib.uvs, format: 'float32x2' },
      },
      indexBuffer: rib.indices,
    });
    const shader = new PIXI.Shader({
      glProgram: program,
      resources: {
        uTexture: tileTex.source, uSampler: tileTex.source.style,
        railUniforms: {
          uHalfWidth: { value: 1, type: 'f32' }, uPx: { value: 9, type: 'f32' },
          uMode: { value: mode, type: 'f32' }, uAlpha: { value: 1, type: 'f32' },
        },
      },
    });
    const m = new PIXI.Mesh({ geometry, shader });
    m.eventMode = 'none';
    return m;
  }

  // ---- Arc-length helpers ------------------------------------------------------------------------
  function cumulative(pts) {
    const s = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return s;
  }
  /** Point and heading at arc position d along pts (with cumulative lengths cum). */
  function at(pts, cum, d) {
    d = Math.max(0, Math.min(cum[cum.length - 1], d));
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    const L = cum[hi] - cum[lo] || 1, t = (d - cum[lo]) / L;
    const [ax, ay] = pts[lo], [bx, by] = pts[hi];
    return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, a: Math.atan2(by - ay, bx - ax) };
  }
  /** The sub-polyline between arc positions d0 and d1. */
  function slice(pts, cum, d0, d1) {
    const out = [];
    const p0 = at(pts, cum, d0); out.push([p0.x, p0.y]);
    for (let i = 0; i < pts.length; i++) if (cum[i] > d0 && cum[i] < d1) out.push(pts[i]);
    const p1 = at(pts, cum, d1); out.push([p1.x, p1.y]);
    return out;
  }

  // ---- Trains ------------------------------------------------------------------------------------------
  const rand = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  class Train {
    constructor(container, run, rnd) {
      this.run = run;
      this.cars = [];
      const kinds = [frames.loco, frames.tender];
      const nWagons = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < nWagons; i++) kinds.push(frames.wagons[Math.floor(rnd() * frames.wagons.length)]);
      for (const tex of kinds) {
        const sp = new PIXI.Sprite(tex); sp.anchor.set(0.5); sp.eventMode = 'none'; sp.visible = false;   // shown once placed
        container.addChild(sp);
        this.cars.push({ sp, len: tex.frame.height });
      }
      this.pxLen = this.cars.reduce((a, c) => a + c.len, 0);   // sheet px
      this.dir = rnd() < 0.5 ? 1 : -1;
      this.pos = rnd();                  // head position as a fraction of the run
      this.speed = 0.8 + rnd() * 0.5;
      this.wait = 0;
    }
    /**
     * Advance and place. k = map units per sheet px (cars are as wide as the track); the speed is in track
     * widths per second so trains look the same at any zoom. At the end of the line (or a cut) the train
     * waits, the engine runs round, and it heads back.
     */
    step(dt, k, hw) {
      const L = this.run.cum[this.run.cum.length - 1];
      // Short stretches (between cuts, near a line's end) get a shorter train: wagons are left behind to fit.
      let shown = 0, px = 0;
      for (const c of this.cars) { if ((px + c.len) * k > L * 0.8) break; px += c.len; shown++; }
      if (shown < 2) { this.hide(); return false; }
      const len = px * k;
      let head = this.pos * L;
      if (this.wait > 0) {
        this.wait -= dt;
        if (this.wait <= 0) { head -= this.dir * len; this.dir = -this.dir; }
      } else {
        head += this.dir * this.speed * hw * 2 * 2.4 * dt / 1000;
        if (this.dir > 0 && head >= L) { head = L; this.wait = 1500; }
        else if (this.dir < 0 && head <= 0) { head = 0; this.wait = 1500; }
      }
      // The whole consist stays on the track: behind the head lies len of train.
      head = this.dir > 0 ? Math.max(len, Math.min(L, head)) : Math.max(0, Math.min(L - len, head));
      this.pos = head / L;
      let d = head;
      const sc = k;
      for (let i = 0; i < this.cars.length; i++) {
        const c = this.cars[i];
        if (i >= shown) { c.sp.visible = false; continue; }
        const mid = d - this.dir * c.len * sc / 2;
        const p = at(this.run.pts, this.run.cum, mid);
        c.sp.visible = true;
        c.sp.position.set(p.x, p.y);
        c.sp.rotation = p.a + Math.PI / 2 + (this.dir < 0 ? Math.PI : 0);
        c.sp.scale.set(sc);
        d -= this.dir * c.len * sc;
      }
      return true;
    }
    hide() { for (const c of this.cars) c.sp.visible = false; }
    destroy() { for (const c of this.cars) c.sp.destroy(); }
  }

  // ---- View ----------------------------------------------------------------------------------------
  class View {
    constructor(layer, renderer) {
      this.r = renderer;
      this.container = new PIXI.Container(); this.container.eventMode = 'none';
      this.trackLayer = new PIXI.Container(); this.smokeLayer = new PIXI.Container(); this.trainLayer = new PIXI.Container();
      this.container.addChild(this.trackLayer, this.trainLayer, this.smokeLayer);
      layer.addChild(this.container);
      this.meshes = []; this.trains = []; this.smoke = []; this.runs = [];
      this.key = null; this.seed = Math.floor(Math.random() * 1e9);
      this.hw = 1; this.bbox = null;
    }
    /** Rebuild when the centreline or the cuts change. cutHalfPx(x, y) → half-length of a cut in map px there. */
    update(shape, scale, cutHalfPx) {
      const pts = (shape.points || []).map(p => [Number(p[0]), Number(p[1])]);
      const cuts = shape.data?.cuts || [];
      const key = `${JSON.stringify(pts)}|${JSON.stringify(cuts.map(c => [c.x, c.y]))}|${tileTex ? 1 : 0}`;
      if (key !== this.key && pts.length >= 2) {
        this.key = key;
        this._dispose();
        if (tileTex) this._build(pts, cuts, cutHalfPx);
      }
      this.setZoom(scale);
    }
    _build(pts, cuts, cutHalfPx) {
      const cum = cumulative(pts), L = cum[cum.length - 1];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      this.bbox = { x0, y0, x1, y1 };
      // Cut intervals along the drawn line (map px), merged.
      const iv = cuts.map(c => {
        const p = RailNet.project(pts, c.x, c.y);
        if (!p) return null;
        const s = cum[p.i] + Math.hypot(pts[p.i + 1][0] - pts[p.i][0], pts[p.i + 1][1] - pts[p.i][1]) * p.t;
        const h = cutHalfPx(p.x, p.y);
        return { from: Math.max(0, s - h), to: Math.min(L, s + h), x: p.x, y: p.y };
      }).filter(Boolean).sort((a, b) => a.from - b.from);
      const merged = [];
      for (const c of iv) { const last = merged[merged.length - 1]; if (last && c.from <= last.to) last.to = Math.max(last.to, c.to); else merged.push({ ...c }); }
      // Open runs between the cuts carry trains; wrecked stretches get the torn-up look and smoke.
      let d = 0;
      const open = [];
      for (const c of merged) { if (c.from > d) open.push([d, c.from]); d = Math.max(d, c.to); }
      if (d < L) open.push([d, L]);
      for (const [a, b] of open) {
        const sub = slice(pts, cum, a, b);
        if (sub.length < 2) continue;
        const m = mesh(ribbon(sub, a), 0);
        this.trackLayer.addChild(m); this.meshes.push(m);
        this.runs.push({ pts: sub, cum: cumulative(sub) });
      }
      for (const c of merged) {
        const sub = slice(pts, cum, c.from, c.to);
        if (sub.length < 2) continue;
        const m = mesh(ribbon(sub, c.from), 1);
        this.trackLayer.addChild(m); this.meshes.push(m);
      }
      for (const c of iv) this._addSmoke(c.x, c.y);
      this._placeTrains(L);
    }
    _addSmoke(x, y) {
      const f = this.r.burningFrames;
      if (!f) { this._smokePending = true; return; }
      const sp = new PIXI.AnimatedSprite(f);
      sp.anchor.set(0.5, 0.85); sp.position.set(x, y);
      sp.animationSpeed = 0.3; sp.loop = true; sp.alpha = 0.95; sp.eventMode = 'none';
      sp.gotoAndPlay(Math.floor(Math.random() * f.length));
      this.smokeLayer.addChild(sp); this.smoke.push(sp);
    }
    /** One train per ~250 km of open track (at least one per run long enough), from a stable seed. */
    _placeTrains() {
      if (!frames) return;
      const rnd = rand(this.seed);
      for (const run of this.runs) {
        const L = run.cum[run.cum.length - 1];
        const mid = run.pts[Math.floor(run.pts.length / 2)];
        const pxPerKm = this.r.unitsToPx ? this.r.unitsToPx(mid[0], mid[1], 1) : 1;
        const km = L / (pxPerKm || 1);
        const n = Math.max(1, Math.min(12, Math.round(km / 250)));
        for (let i = 0; i < n; i++) {
          const t = new Train(this.trainLayer, run, rnd);
          t.pos = (i + 0.5) / n; t.dir = i % 2 ? -1 : 1;
          this.trains.push(t);
        }
      }
    }
    halfWidth(scale) { return screenWidth(scale) / 2 / (scale || 1); }
    setZoom(scale) {
      this.scale = scale;
      const hw = this.halfWidth(scale), px = hw * 2 * scale;
      this.hw = hw;
      for (const m of this.meshes) { const u = m.shader.resources.railUniforms.uniforms; u.uHalfWidth = hw; u.uPx = px; }
      // Smoke is sized to the track, never smaller than a small puff.
      const smokeS = Math.max(hw * 8, 40 / scale) / (this.r.burningFrameSize || 128);
      for (const sp of this.smoke) sp.scale.set(smokeS);
      this.trainLayer.visible = px >= TRAIN_MIN_PX;
    }
    /** Animate. `onScreen` is false when the rail is out of view (trains then sleep). */
    tick(dt, onScreen) {
      if (this._smokePending && this.r.burningFrames) { this._smokePending = false; this.key = null; }
      let anim = this.smoke.length > 0 && onScreen;
      if (!onScreen || !this.trainLayer.visible || !this.trains.length) return anim;
      const k = (this.hw * 2 * 0.94) / 24;
      for (const t of this.trains) t.step(dt, k, this.hw);
      return true;
    }
    _dispose() {
      for (const m of this.meshes) m.destroy();
      for (const t of this.trains) t.destroy();
      for (const s of this.smoke) s.destroy();
      this.trackLayer.removeChildren(); this.trainLayer.removeChildren(); this.smokeLayer.removeChildren();
      this.meshes = []; this.trains = []; this.smoke = []; this.runs = [];
    }
    destroy() { this._dispose(); this.container.destroy({ children: true }); }
  }

  return { load, View, screenWidth, cumulative, at, frames: () => frames };
})();

window.Rail = Rail;
