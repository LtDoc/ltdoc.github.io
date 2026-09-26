'use strict';
/* global PIXI */

/**
 * Trenches: a drawing kind whose centreline is the gameplay object (cover, occupancy, editing) and whose
 * look is a triangulated ribbon with a cheap dirt shader. Nothing here derives logic from the mesh.
 *
 *   Trench.processPath(points, opts)   pointer samples → simplified, smoothed, optionally zigzagged centreline
 *   Trench.buildRibbon(points, hw)     centreline → { positions, uvs, caps, indices } (mitred, capped)
 *   new Trench.View(layer)             PixiJS container: shadow + dirt ribbon + spoil + plan line + props
 *
 * Shape data: { width (full width, map px), facing: 'left'|'right' (which side is the rear), state:
 * 'plan'|'dug'|'reinforced', zigzag: bool }. Stored on the shape row; the renderer only reads it.
 */
const Trench = (() => {
  const r1 = n => Math.round(n * 10) / 10;
  const MIN_SCREEN_PX = 10;   // a trench stays at least this wide on screen, however far you zoom out

  // ---- Path processing ----------------------------------------------------------------------
  function rdp(pts, tol) {
    if (pts.length <= 2) return pts.slice();
    const sq = tol * tol, keep = new Uint8Array(pts.length);
    keep[0] = 1; keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = 0, idx = -1;
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      for (let i = a + 1; i < b; i++) {
        const [px, py] = pts[i];
        let d;
        if (!len2) d = (px - ax) ** 2 + (py - ay) ** 2;
        else { const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)); d = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2; }
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > sq && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((p, i) => keep[i]);
  }
  /** One round of Chaikin corner cutting; endpoints stay put. */
  function chaikin(pts) {
    if (pts.length < 3) return pts.slice();
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }
  /** Fire-trench traverses: long straights get short bays offset alternately to either side. */
  function zigzag(pts, width) {
    const bay = width * 3.2, lateral = width * 0.85;
    const out = [pts[0]];
    let flip = 1;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      if (len > bay * 2.2) {
        const n = Math.floor(len / bay), tx = dx / len, ty = dy / len, nx = -ty, ny = tx;
        for (let k = 1; k < n; k++) {
          const t = k / n;
          const px = ax + dx * t, py = ay + dy * t;
          out.push([px + nx * lateral * flip, py + ny * lateral * flip], [px + nx * lateral * flip + tx * bay * 0.35, py + ny * lateral * flip + ty * bay * 0.35]);
          flip = -flip;
        }
      }
      out.push([bx, by]);
    }
    return out;
  }
  /**
   * Pointer samples (map units) → centreline. `tol` in map units (about 2 screen px); `width` for zigzag.
   * Order: simplify, smooth (one Chaikin pass), then traverses so the bays stay crisp.
   */
  function processPath(points, { tol = 2, smooth = true, zig = true, width = 10 } = {}) {
    let pts = rdp(points.map(p => [Number(p[0]), Number(p[1])]), tol);
    if (smooth && pts.length >= 3) pts = chaikin(pts);
    if (zig) pts = zigzag(pts, width);
    // Drop near-duplicates so the ribbon never has a zero-length segment.
    const out = [];
    for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.3) out.push([r1(p[0]), r1(p[1])]); }
    return out.length >= 2 ? out : points.slice(0, 2).map(p => [r1(p[0]), r1(p[1])]);
  }

  // ---- Ribbon mesh -------------------------------------------------------------------------------
  /**
   * Extrude a polyline into an indexed triangle ribbon. Each centreline point yields a left/right vertex
   * pair at ±halfWidth (slightly varied along the path) along a stable mitred normal (mitre length capped so
   * sharp corners bevel instead of spiking). Both ends get a cap pair (aCap = 1) that the shader rounds.
   * Attributes: aPosition (x,y), aUV (u = distance along the path in map units, v = 0..1 across), aCap.
   */
  /**
   * The ribbon is built in "half-width units": aPosition is the centreline point and aOffset the vector
   * (in half-widths) to the vertex. The vertex shader multiplies by uHalfWidth, so the width can follow the
   * zoom (a minimum on-screen width) without rebuilding the geometry. `side`/`offset` shift a whole ribbon
   * sideways (spoil), `widthFactor` narrows it.
   */
  function buildRibbon(pts, { capLen = 1, wobble = 0.14, side = 0, offset = 0, widthFactor = 1 } = {}) {
    const n = pts.length;
    const positions = [], offsets = [], uvs = [], caps = [], indices = [];
    const tangents = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      if (i === 0) { tx = pts[1][0] - pts[0][0]; ty = pts[1][1] - pts[0][1]; }
      if (i === n - 1) { tx = pts[n - 1][0] - pts[n - 2][0]; ty = pts[n - 1][1] - pts[n - 2][1]; }
      const l = Math.hypot(tx, ty) || 1;
      tangents.push([tx / l, ty / l]);
    }
    let u = 0;
    const push = (px, py, ox, oy, v, cap) => { positions.push(px, py); offsets.push(ox, oy); uvs.push(u, v); caps.push(cap); };
    for (let i = 0; i < n; i++) {
      const [px, py] = pts[i], [tx, ty] = tangents[i];
      const nx = -ty, ny = tx;
      // Mitre factor against the incoming segment's normal, capped at 2 (bevel-ish on hairpins).
      let m = 1;
      if (i > 0) {
        const sx = pts[i][0] - pts[i - 1][0], sy = pts[i][1] - pts[i - 1][1], sl = Math.hypot(sx, sy) || 1;
        const snx = -sy / sl, sny = sx / sl;
        m = 1 / Math.max(0.5, nx * snx + ny * sny);
      }
      if (i > 0) u += Math.hypot(px - pts[i - 1][0], py - pts[i - 1][1]);
      const w = widthFactor * (1 + wobble * Math.sin(i * 1.93 + 0.4) * 0.6 + wobble * Math.sin(i * 0.61) * 0.4) * m;
      const sx = nx * side * offset, sy = ny * side * offset;             // sideways shift (spoil) in half-widths
      if (i === 0) push(px, py, sx - tx * capLen + nx * w, sy - ty * capLen + ny * w, 0, 1), push(px, py, sx - tx * capLen - nx * w, sy - ty * capLen - ny * w, 1, 1);
      push(px, py, sx + nx * w, sy + ny * w, 0, 0);
      push(px, py, sx - nx * w, sy - ny * w, 1, 0);
      if (i === n - 1) push(px, py, sx + tx * capLen + nx * w, sy + ty * capLen + ny * w, 0, 1), push(px, py, sx + tx * capLen - nx * w, sy + ty * capLen - ny * w, 1, 1);
    }
    const pairs = positions.length / 4;
    for (let i = 0; i < pairs - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      indices.push(a, b, c, b, d, c);
    }
    return { positions: new Float32Array(positions), offsets: new Float32Array(offsets), uvs: new Float32Array(uvs), caps: new Float32Array(caps), indices: new Uint32Array(indices), length: u };
  }

  // ---- Dirt texture and shader ------------------------------------------------------------------
  let dirtTexture = null, glProgram = null, propTexture = null;
  /** Seamless value-noise dirt, 128 px, generated once. */
  function dirt() {
    if (dirtTexture) return dirtTexture;
    const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
    const lattice = (n, seed) => { const a = new Float32Array(n * n); let s = seed; for (let i = 0; i < a.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = (s >>> 8) / 16777216; } return a; };
    const sample = (a, n, x, y) => {   // bilinear, wrapping
      const fx = x * n, fy = y * n, x0 = Math.floor(fx) % n, y0 = Math.floor(fy) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n, tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
      const sm = t => t * t * (3 - 2 * t);
      const ux = sm(tx), uy = sm(ty);
      return (a[y0 * n + x0] * (1 - ux) + a[y0 * n + x1] * ux) * (1 - uy) + (a[y1 * n + x0] * (1 - ux) + a[y1 * n + x1] * ux) * uy;
    };
    const l1 = lattice(6, 7), l2 = lattice(16, 91), l3 = lattice(40, 1337);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fx = x / S, fy = y / S;
      const v = 0.5 * sample(l1, 6, fx, fy) + 0.3 * sample(l2, 16, fx, fy) + 0.2 * sample(l3, 40, fx, fy);
      const g = Math.round(v * 255), i = (y * S + x) * 4;
      img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    dirtTexture = PIXI.Texture.from(c);
    dirtTexture.source.addressMode = 'repeat';
    dirtTexture.source.scaleMode = 'linear';
    return dirtTexture;
  }
  /** Sandbag / pit prop: a small stack of pale bags, drawn once. */
  function prop() {
    if (propTexture) return propTexture;
    const c = document.createElement('canvas'); c.width = 24; c.height = 16;
    const ctx = c.getContext('2d');
    const bag = (x, y) => { ctx.fillStyle = '#b3a37a'; ctx.beginPath(); ctx.ellipse(x, y, 5.5, 3, 0, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#6f6448'; ctx.lineWidth = 1; ctx.stroke(); };
    bag(6, 12); bag(17, 12); bag(11.5, 7); bag(12, 3.5);
    propTexture = PIXI.Texture.from(c);
    return propTexture;
  }

  const VERT = `
    in vec2 aPosition;
    in vec2 aOffset;
    in vec2 aUV;
    in float aCap;
    out vec2 vUV;
    out float vCap;
    uniform mat3 uProjectionMatrix;
    uniform mat3 uWorldTransformMatrix;
    uniform mat3 uTransformMatrix;
    uniform highp float uHalfWidth;
    void main() {
      mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
      vec2 p = aPosition + aOffset * uHalfWidth;
      gl_Position = vec4((mvp * vec3(p, 1.0)).xy, 0.0, 1.0);
      vUV = aUV;
      vCap = aCap;
    }`;
  const FRAG = `
    precision highp float;
    in vec2 vUV;
    in float vCap;
    out vec4 finalColor;
    uniform sampler2D uTexture;
    uniform float uMode;    // 0 dirt ribbon, 1 drop shadow, 2 spoil heaps
    uniform float uState;   // 1 dug, 2 reinforced
    uniform float uZoom;    // screen px per map unit
    uniform float uAlpha;
    uniform highp float uHalfWidth;   // map units; the dirt grain tiles relative to it so it keeps its aspect at any width
    uniform float uSeed;
    void main() {
      float across = abs(vUV.y - 0.5) * 2.0;                 // 0 centre .. 1 edge
      if (length(vec2(vCap, across)) > 1.0) discard;          // rounded caps
      vec2 tuv = vec2(vUV.x / (uHalfWidth * 4.4) + uSeed, vUV.y * 0.9);
      float n1 = texture(uTexture, tuv).r;
      float n2 = texture(uTexture, tuv * 3.7 + vec2(0.31, 0.77)).r;
      float detail = smoothstep(0.12, 0.55, uZoom);            // texture fades out when zoomed far out
      if (uMode > 1.5) {
        // Spoil: drier dirt thrown up behind the line, broken so the coverage is patchy.
        if (n1 * 0.6 + n2 * 0.4 < 0.46 || across > 0.9 - 0.35 * n2) discard;
        vec3 sc = vec3(0.55, 0.45, 0.30) * (0.8 + 0.4 * n2);
        finalColor = vec4(sc, 1.0) * (uAlpha * (0.95 - 0.55 * across));
        return;
      }
      if (uMode > 0.5) {
        float a = (1.0 - across * across) * 0.42;
        finalColor = vec4(0.0, 0.0, 0.0, 1.0) * (a * uAlpha);
        return;
      }
      float edge = 1.0 - 0.18 * n2 * detail;                   // uneven lip
      if (across > edge) discard;
      vec3 floorC = vec3(0.19, 0.135, 0.085);
      vec3 lipC = uState > 1.5 ? vec3(0.36, 0.285, 0.18) : vec3(0.53, 0.43, 0.285);
      float lip = smoothstep(0.22, 0.74, across);
      vec3 col = mix(floorC, lipC, lip);
      col *= mix(1.0, 0.68 + 0.64 * n1, detail);
      col += vec3(0.02, 0.03, 0.045) * (1.0 - smoothstep(0.0, 0.3, across)) * n2;   // wet sheen in the bottom
      if (uState > 1.5 && across > 0.6) {                      // reinforced: timber revetment along the lips
        float d = fract(vUV.x / (uHalfWidth * 4.9));
        if (d < 0.42) col = mix(col, vec3(0.56, 0.45, 0.27), 0.6 * detail);
      }
      float rim = smoothstep(0.72, 1.0, across);                // zoomed out: dark stroke with a light rim
      vec3 far = mix(vec3(0.19, 0.145, 0.095), vec3(0.62, 0.52, 0.36), rim);
      col = mix(far, col, detail);
      finalColor = vec4(col, 1.0) * uAlpha;
    }`;
  function program() {
    if (!glProgram) glProgram = PIXI.GlProgram.from({ vertex: VERT, fragment: FRAG, name: 'trench' });
    return glProgram;
  }
  function makeShader(mode, seed) {
    const tex = dirt();
    return new PIXI.Shader({
      glProgram: program(),
      resources: {
        uTexture: tex.source, uSampler: tex.source.style,
        trenchUniforms: {
          uMode: { value: mode, type: 'f32' }, uState: { value: 1, type: 'f32' }, uZoom: { value: 1, type: 'f32' },
          uAlpha: { value: 1, type: 'f32' }, uHalfWidth: { value: 1, type: 'f32' }, uSeed: { value: seed, type: 'f32' },
        },
      },
    });
  }
  function makeMesh(rib, mode, seed) {
    const geometry = new PIXI.Geometry({
      attributes: {
        aPosition: { buffer: rib.positions, format: 'float32x2' }, aOffset: { buffer: rib.offsets, format: 'float32x2' },
        aUV: { buffer: rib.uvs, format: 'float32x2' }, aCap: { buffer: rib.caps, format: 'float32' },
      },
      indexBuffer: rib.indices,
    });
    const mesh = new PIXI.Mesh({ geometry, shader: makeShader(mode, seed) });
    mesh.eventMode = 'none';
    return mesh;
  }

  // ---- View -----------------------------------------------------------------------------------------
  class View {
    constructor(layer) {
      this.container = new PIXI.Container();
      this.container.eventMode = 'none';
      this.shadow = null; this.mesh = null; this.spoil = null;
      this.plan = new PIXI.Graphics(); this.plan.eventMode = 'none';
      this.props = new PIXI.Container(); this.props.eventMode = 'none';
      this.container.addChild(this.plan, this.props);
      this.key = null; this.scale = 1; this.seed = Math.random() * 10;
      layer.addChild(this.container);
    }
    /**
     * Rebuild the meshes only when the centreline or facing changed; width and zoom are uniforms.
     * `pxWidth` is the trench's real width in map pixels; on screen it never drops below MIN_SCREEN_PX.
     */
    update(shape, scale, pxWidth) {
      const d = shape.data || {};
      const facing = d.facing === 'right' ? 1 : -1;
      const state = d.state === 'plan' ? 0 : d.state === 'reinforced' ? 2 : 1;
      const key = `${JSON.stringify(shape.points)}|${facing}`;
      this.pxWidth = Math.max(0.01, Number(pxWidth) || 1);
      if (key !== this.key) {
        this.key = key;
        this._dispose();
        if (shape.points.length >= 2) {
          const rib = buildRibbon(shape.points, { capLen: 1 });
          this.shadow = makeMesh(rib, 1, this.seed);
          this.mesh = makeMesh(rib, 0, this.seed);
          // Spoil rides on the rear side, narrower, a little further out.
          const spoilRib = buildRibbon(shape.points, { capLen: 0.4, wobble: 0.3, side: facing, offset: 1.55, widthFactor: 0.6 });
          this.spoil = makeMesh(spoilRib, 2, this.seed + 3);
          this.container.addChildAt(this.spoil, 0);
          this.container.addChildAt(this.mesh, 0);
          this.container.addChildAt(this.shadow, 0);
          this.length = rib.length;
        }
        this._planPts = shape.points;
        this._propsKey = null;
      }
      this.state = state; this.facing = facing;
      const dug = state > 0;
      for (const m of [this.shadow, this.mesh, this.spoil]) if (m) { m.visible = dug; m.shader.resources.trenchUniforms.uniforms.uState = Math.max(1, state); }
      this.plan.visible = !dug;
      this.props.visible = state === 2;
      this.setZoom(scale);
    }
    /** Effective half-width in map units at this zoom: the real width, but never thinner than MIN_SCREEN_PX on screen. */
    halfWidth(scale) { return Math.max(this.pxWidth / 2, MIN_SCREEN_PX / 2 / (scale || 1)); }
    setZoom(scale) {
      this.scale = scale;
      const hw = this.halfWidth(scale), hwPx = hw * scale;
      this.hw = hw;
      for (const m of [this.shadow, this.mesh, this.spoil]) if (m) {
        const u = m.shader.resources.trenchUniforms.uniforms;
        u.uHalfWidth = hw; u.uZoom = hwPx / 6;
      }
      if (this.shadow) this.shadow.position.set(1.5 / scale, 2.5 / scale);
      if (this.spoil) this.spoil.visible = this.state > 0 && hwPx > 4;     // skip spoil when zoomed far out
      // Props and the plan line are drawn in map units, so they follow the effective width too.
      const propsKey = `${this.key}|${Math.round(hw * 100)}`;
      if (this._propsKey !== propsKey && this._planPts) { this._propsKey = propsKey; this._placeProps(this._planPts, hw, this.facing); }
      if (this.plan.visible) this._drawPlan(this._planPts, hw);
      for (const c of this.container.children) if (c.isNode) c.scale.set(hw / 10);   // junction nodes follow the width too
    }
    _drawPlan(pts, hw) {
      this._planPts = pts;
      const g = this.plan; g.clear();
      if (!pts || pts.length < 2) return;
      const s = this.scale, dash = 6 / s, gap = 4 / s;
      // Pale thin engineer line: dashed centreline with faint edge guides.
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
        let t = 0;
        while (t < len) { const e = Math.min(len, t + dash); g.moveTo(ax + dx * t / len, ay + dy * t / len).lineTo(ax + dx * e / len, ay + dy * e / len); t = e + gap; }
      }
      g.stroke({ width: 1.6 / s, color: 0xe8e2c8, alpha: 0.9 });
      g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.stroke({ width: hw * 2, color: 0xe8e2c8, alpha: 0.12 });
    }
    _placeProps(pts, hw, facing) {
      for (const c of this.props.removeChildren()) c.destroy();
      if (pts.length < 2) return;
      const tex = prop();
      const every = hw * 9;
      let carry = every * 0.5;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
        const tx = dx / len, ty = dy / len, nx = -ty, ny = tx;
        let t = carry;
        while (t < len) {
          const sp = new PIXI.Sprite(tex); sp.anchor.set(0.5, 0.7);
          sp.position.set(ax + tx * t + nx * facing * hw * 0.95, ay + ty * t + ny * facing * hw * 0.95);
          sp.rotation = Math.atan2(ty, tx); sp.scale.set(hw / 13); sp.eventMode = 'none';
          this.props.addChild(sp);
          t += every;
        }
        carry = t - len;
      }
    }
    /** Junction node: a sandbag heap where this trench's end meets another trench. */
    addNode(x, y) {
      const sp = new PIXI.Sprite(prop()); sp.anchor.set(0.5); sp.position.set(x, y); sp.scale.set(this.halfWidth(this.scale) / 10); sp.eventMode = 'none';
      sp.isNode = true;
      this.container.addChild(sp);
    }
    clearNodes() { for (const c of this.container.children.filter(c => c.isNode)) { this.container.removeChild(c); c.destroy(); } }
    _dispose() {
      for (const m of [this.shadow, this.mesh, this.spoil]) if (m) { this.container.removeChild(m); m.destroy({ children: true }); }
      this.shadow = this.mesh = this.spoil = null;
    }
    destroy() { this._dispose(); this.container.destroy({ children: true }); }
  }

  /** Distance from a point to a polyline. */
  function distToPath(x, y, pts) {
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
    }
    return best;
  }

  return { processPath, buildRibbon, View, distToPath, rdp, chaikin, zigzag, sources: { VERT, FRAG } };
})();

window.Trench = Trench;
