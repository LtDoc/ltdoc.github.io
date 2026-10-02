'use strict';
/* global PIXI */
/**
 * Province ownership drawn straight from the provinces (docs/GAME-DESIGN.md §5.1), so recolouring a province
 * costs milliseconds instead of rebuilding faction polygons:
 *
 *   - fills: every province triangulated once into one mesh with a colour per vertex; an owner change
 *     rewrites the colours of that province's vertices only;
 *   - borders: the province edges are matched into segments once (shared edges exactly, the rest by probing the
 *     far side), then each change rebuilds one border mesh from the segments whose two sides have different
 *     owners: a dark core with a band of each owner's colour on its side, a fixed width in screen pixels;
 *   - edges: hairlines between all provinces, shown when zoomed in;
 *   - labels: each faction's name on every sizeable connected group of its provinces;
 *   - fog of war: a second mesh over the same triangles darkens the provinces out of the player's sight.
 *
 * Ownership arrives as [[provinceId, factionId], ...] (0 = neutral).
 */
const ProvinceLayer = (() => {
  const VERT_FILL = `
    in vec2 aPosition;
    in vec4 aColor;
    out vec4 vColor;
    uniform mat3 uProjectionMatrix;
    uniform mat3 uWorldTransformMatrix;
    uniform mat3 uTransformMatrix;
    void main() {
      mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
      gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
      vColor = aColor;
    }`;
  const VERT_LINE = `
    in vec2 aPosition;
    in vec2 aNormal;
    in vec4 aColor;
    out vec4 vColor;
    uniform mat3 uProjectionMatrix;
    uniform mat3 uWorldTransformMatrix;
    uniform mat3 uTransformMatrix;
    uniform highp float uPx;
    void main() {
      mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
      vec2 p = aPosition + aNormal * uPx;         // aNormal is in screen pixels; uPx = map units per pixel
      gl_Position = vec4((mvp * vec3(p, 1.0)).xy, 0.0, 1.0);
      vColor = aColor;
    }`;
  const FRAG = `
    precision highp float;
    in vec4 vColor;
    out vec4 finalColor;
    void main() { finalColor = vColor; }`;

  let fillProgram = null, lineProgram = null;
  const programs = () => {
    if (!fillProgram) fillProgram = PIXI.GlProgram.from({ vertex: VERT_FILL, fragment: FRAG, name: 'province-fill' });
    if (!lineProgram) lineProgram = PIXI.GlProgram.from({ vertex: VERT_LINE, fragment: FRAG, name: 'province-line' });
  };

  const NEUTRAL_COLOR = 0x9aa5a1;
  const CORE_PX = 1.6, BAND_PX = 1.5;           // border core and each owner band, in screen pixels
  const GRID = 32;

  function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(a / 2); }
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function pointInMulti(x, y, multi) {
    for (const poly of multi) {
      if (!poly.length || !pointInRing(x, y, poly[0])) continue;
      let hole = false;
      for (let i = 1; i < poly.length; i++) if (pointInRing(x, y, poly[i])) { hole = true; break; }
      if (!hole) return true;
    }
    return false;
  }

  class Layer {
    constructor(renderer) {
      this.r = renderer;
      this.container = new PIXI.Container();
      this.container.eventMode = 'none';
      this.list = [];                 // [{ id, n, s, x, y, g, bbox, area, v0, v1 }]
      this.index = new Map();         // province id -> index in list
      this.owner = new Int32Array(0); // owner faction id per province index (-1 = unknown yet)
      this.colors = new Map();        // faction id -> 0xRRGGBB
      this.names = new Map();         // faction id -> name
      this.labels = [];
    }
    get size() { return this.list.length; }
    get hasOwners() { return this.list.length > 0 && this._owned; }

    /** Build everything from the province set [{ id, n, s, x, y, g }]. Owners follow with setOwners(). */
    setProvinces(list) {
      this.destroyMeshes();
      this.list = (list || []).map(p => ({ ...p }));
      this.index = new Map(this.list.map((p, i) => [p.id, i]));
      this.owner = new Int32Array(this.list.length).fill(-1);
      this._owned = false;
      if (!this.list.length) { this.r.invalidate(); return; }
      programs();
      this._buildGrid();
      this._buildFill();
      this._buildSegments();
      this._buildEdges();
      if (this.fogIds) this._paintFog();
      this.r.invalidate();
    }
    destroyMeshes() {
      for (const k of ['fill', 'fog', 'border', 'edges']) if (this[k]) { this.container.removeChild(this[k]); this[k].destroy(); this[k] = null; }
      for (const t of this.labels) t.destroy();
      this.labels = [];
    }

    _buildGrid() {
      this.grid = new Map();
      this.list.forEach((p, i) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, area = 0;
        for (const poly of p.g) {
          for (const [x, y] of poly[0]) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
          area += ringArea(poly[0]);
          for (let h = 1; h < poly.length; h++) area -= ringArea(poly[h]);
        }
        p.bbox = [x0, y0, x1, y1]; p.area = area;
        for (let gx = Math.floor(x0 / GRID); gx <= Math.floor(x1 / GRID); gx++)
          for (let gy = Math.floor(y0 / GRID); gy <= Math.floor(y1 / GRID); gy++) {
            const k = gx * 100000 + gy;
            if (!this.grid.has(k)) this.grid.set(k, []);
            this.grid.get(k).push(i);
          }
      });
    }
    /** Index of the province containing a point, or -1; `skip` excludes one province. */
    indexAt(x, y, skip = -1) {
      for (const i of this.grid.get(Math.floor(x / GRID) * 100000 + Math.floor(y / GRID)) || []) {
        if (i === skip) continue;
        const b = this.list[i].bbox;
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        if (pointInMulti(x, y, this.list[i].g)) return i;
      }
      return -1;
    }
    provinceAt(x, y) { const i = this.indexAt(x, y); return i < 0 ? null : this.list[i]; }
    /** Owner at a point: faction id, 0 neutral, null at sea or before owners arrive. */
    ownerAt(x, y) { const i = this.indexAt(x, y); return i < 0 || this.owner[i] < 0 ? null : this.owner[i]; }

    // ---- Fill ---------------------------------------------------------------------------------------------
    _buildFill() {
      const pos = [], idx = [];
      let v = 0;
      for (const p of this.list) {
        p.v0 = v;
        for (const poly of p.g) {
          const flat = [], holes = [];
          for (let r = 0; r < poly.length; r++) {
            if (r > 0) holes.push(flat.length / 2);
            for (const [x, y] of poly[r]) flat.push(x, y);
          }
          const tris = PIXI.earcut(flat, holes, 2);
          for (let k = 0; k < flat.length; k++) pos.push(flat[k]);
          for (const t of tris) idx.push(v + t);
          v += flat.length / 2;
        }
        p.v1 = v;
      }
      this.fillPos = new Float32Array(pos);
      this.fillIdx = new Uint32Array(idx);
      this.fillCol = new Float32Array(v * 4);
      const geometry = new PIXI.Geometry({
        attributes: { aPosition: { buffer: this.fillPos, format: 'float32x2' }, aColor: { buffer: this.fillCol, format: 'float32x4' } },
        indexBuffer: new Uint32Array(idx),
      });
      this.fill = new PIXI.Mesh({ geometry, shader: new PIXI.Shader({ glProgram: fillProgram, resources: {} }) });
      this.fill.eventMode = 'none';
      this.container.addChildAt(this.fill, 0);
    }
    _rgba(fid) {
      if (fid < 0) return [0, 0, 0, 0];
      const neutral = fid === 0;
      const c = neutral ? NEUTRAL_COLOR : (this.colors.get(fid) ?? 0x888888);
      const a = neutral ? 0.1 : 0.3;
      return [((c >> 16) & 255) / 255 * a, ((c >> 8) & 255) / 255 * a, (c & 255) / 255 * a, a];   // premultiplied
    }
    _paint(i) {
      const p = this.list[i], [r, g, b, a] = this._rgba(this.owner[i]), c = this.fillCol;
      for (let v = p.v0; v < p.v1; v++) { const o = v * 4; c[o] = r; c[o + 1] = g; c[o + 2] = b; c[o + 3] = a; }
    }

    // ---- Fog of war: provinces out of sight are darkened (ids in sight from server/vision.js; null = no fog) ----
    setFog(ids) {
      this.fogIds = ids ? new Set(ids) : null;
      if (!this.list.length) return;
      if (!this.fogIds) { if (this.fog) this.fog.visible = false; this.r.invalidate(); return; }
      this._paintFog();
      this.r.invalidate();
    }
    _paintFog() {
      if (!this.fog) {
        this.fogCol = new Float32Array(this.fillCol.length);
        const geometry = new PIXI.Geometry({
          attributes: { aPosition: { buffer: this.fillPos, format: 'float32x2' }, aColor: { buffer: this.fogCol, format: 'float32x4' } },
          indexBuffer: new Uint32Array(this.fillIdx),
        });
        this.fog = new PIXI.Mesh({ geometry, shader: new PIXI.Shader({ glProgram: fillProgram, resources: {} }) });
        this.fog.eventMode = 'none';
        this.container.addChildAt(this.fog, this.container.children.indexOf(this.fill) + 1);
      }
      const a = 0.5, r = 0x12 / 255 * a, g = 0x18 / 255 * a, b = 0x20 / 255 * a, c = this.fogCol;   // premultiplied slate
      for (const p of this.list) {
        const dark = !this.fogIds.has(p.id);
        for (let v = p.v0; v < p.v1; v++) { const o = v * 4; c[o] = dark ? r : 0; c[o + 1] = dark ? g : 0; c[o + 2] = dark ? b : 0; c[o + 3] = dark ? a : 0; }
      }
      this.fog.geometry.getBuffer('aColor').update();
      this.fog.visible = true;
    }

    // ---- Segments: every province edge once, with the province on each side -----------------------------
    _buildSegments() {
      const key = (x, y) => `${Math.round(x * 10)},${Math.round(y * 10)}`;
      const map = new Map();
      const segs = [];     // { ax, ay, bx, by, a: index, b: index | -1 }
      this.list.forEach((p, i) => {
        for (const poly of p.g) for (const ring of poly) {
          for (let k = 0; k < ring.length - 1; k++) {
            const [x1, y1] = ring[k], [x2, y2] = ring[k + 1];
            const k1 = key(x1, y1), k2 = key(x2, y2);
            if (k1 === k2) continue;
            const sk = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
            const s = map.get(sk);
            if (s) { if (s.b < 0 && s.a !== i) s.b = i; continue; }
            const seg = { ax: x1, ay: y1, bx: x2, by: y2, a: i, b: -1 };
            map.set(sk, seg); segs.push(seg);
          }
        }
      });
      // Segments seen once are coast, or a neighbour whose points do not line up exactly: probe the far side.
      const n = segs.length;
      this.segA = new Int32Array(n); this.segB = new Int32Array(n); this.segP = new Float32Array(n * 4); this.segN = new Float32Array(n * 2);
      for (let s = 0; s < n; s++) {
        const g = segs[s];
        const dx = g.bx - g.ax, dy = g.by - g.ay, L = Math.hypot(dx, dy) || 1;
        const nx = -dy / L, ny = dx / L, mx = (g.ax + g.bx) / 2, my = (g.ay + g.by) / 2, e = Math.min(0.3, L / 4);
        // Which province lies on the +normal side?
        const aPlus = pointInMulti(mx + nx * e, my + ny * e, this.list[g.a].g);
        let other = g.b;
        if (other < 0) other = this.indexAt(mx - (aPlus ? nx : -nx) * e, my - (aPlus ? ny : -ny) * e, g.a);
        this.segA[s] = aPlus ? g.a : other;          // + side
        this.segB[s] = aPlus ? other : g.a;          // − side
        this.segP.set([g.ax, g.ay, g.bx, g.by], s * 4);
        this.segN[s * 2] = nx; this.segN[s * 2 + 1] = ny;
      }
      this.segCount = n;
    }

    /** Hairlines along every province edge, for the zoomed-in view. */
    _buildEdges() {
      const g = new PIXI.Graphics();
      g.eventMode = 'none';
      for (let s = 0; s < this.segCount; s++) {
        if (this.segA[s] < 0 || this.segB[s] < 0) continue;   // coasts are drawn by the Earth layer
        const o = s * 4;
        g.moveTo(this.segP[o], this.segP[o + 1]).lineTo(this.segP[o + 2], this.segP[o + 3]);
      }
      g.stroke({ width: 1, pixelLine: true, color: 0x0e1a14, alpha: 0.22 });
      this.edges = g;
      this.container.addChildAt(g, this.fill ? 1 : 0);
      this.setZoom(this.r.scale);
    }

    // ---- Borders: rebuilt from the segments whose sides differ -----------------------------------------------
    _buildBorders() {
      const own = i => (i < 0 ? -2 : this.owner[i]);             // -2 = sea
      let quads = 0;
      for (let s = 0; s < this.segCount; s++) {
        const A = own(this.segA[s]), B = own(this.segB[s]);
        if (A === B) continue;
        if (A >= 0) quads++;
        if (B >= 0) quads++;
        if (A !== -2 && B !== -2) quads++;                        // dark core on land borders only
      }
      const pos = new Float32Array(quads * 8), nor = new Float32Array(quads * 8), col = new Float32Array(quads * 16), idx = new Uint32Array(quads * 6);
      let q = 0;
      const quad = (s, from, to, rgba) => {
        const o = s * 4, n0 = this.segN[s * 2], n1 = this.segN[s * 2 + 1];
        const x1 = this.segP[o], y1 = this.segP[o + 1], x2 = this.segP[o + 2], y2 = this.segP[o + 3];
        const v = q * 4;
        pos.set([x1, y1, x2, y2, x2, y2, x1, y1], v * 2);
        nor.set([n0 * from, n1 * from, n0 * from, n1 * from, n0 * to, n1 * to, n0 * to, n1 * to], v * 2);
        for (let k = 0; k < 4; k++) col.set(rgba, (v + k) * 4);
        idx.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
        q++;
      };
      const band = fid => {
        const c = fid === 0 ? NEUTRAL_COLOR : (this.colors.get(fid) ?? 0x888888), a = fid === 0 ? 0.5 : 0.95;
        return [((c >> 16) & 255) / 255 * a, ((c >> 8) & 255) / 255 * a, (c & 255) / 255 * a, a];
      };
      const core = [0.063 * 0.7, 0.11 * 0.7, 0.082 * 0.7, 0.7];
      for (let s = 0; s < this.segCount; s++) {
        const A = own(this.segA[s]), B = own(this.segB[s]);
        if (A === B) continue;
        const land = A !== -2 && B !== -2;
        const c = land ? CORE_PX / 2 : 0;
        if (A >= 0) quad(s, c, c + BAND_PX, band(A));
        if (B >= 0) quad(s, -c, -c - BAND_PX, band(B));
        if (land) quad(s, -CORE_PX / 2, CORE_PX / 2, core);
      }
      if (this.border) { this.container.removeChild(this.border); this.border.destroy(); this.border = null; }
      if (!quads) return;
      const geometry = new PIXI.Geometry({
        attributes: { aPosition: { buffer: pos, format: 'float32x2' }, aNormal: { buffer: nor, format: 'float32x2' }, aColor: { buffer: col, format: 'float32x4' } },
        indexBuffer: idx,
      });
      this.lineUniforms = this.lineUniforms || new PIXI.UniformGroup({ uPx: { value: 1 / this.r.scale, type: 'f32' } });
      this.border = new PIXI.Mesh({ geometry, shader: new PIXI.Shader({ glProgram: lineProgram, resources: { lineUniforms: this.lineUniforms } }) });
      this.border.eventMode = 'none';
      this.container.addChild(this.border);
    }

    // ---- Ownership and colours -----------------------------------------------------------------------------
    /** Faction colours and names: [{ id, color: '#rrggbb', name }]. Recolours everything. */
    setFactionInfo(list) {
      this.colors = new Map(list.map(f => [f.id, parseInt(String(f.color || '#888888').slice(1), 16) || 0x888888]));
      this.names = new Map(list.map(f => [f.id, f.name]));
      if (this.list.length && this._owned) this._repaintAll();
    }
    /** Apply owner pairs [[id, fid], ...]; `replace` means the list is complete (everything else keeps its owner). */
    setOwners(pairs, replace) {
      if (!this.list.length) { this._pendingOwners = { pairs, replace }; return; }
      let touched = 0;
      for (const [id, fid] of pairs || []) {
        const i = this.index.get(id);
        if (i === undefined || this.owner[i] === fid) continue;
        this.owner[i] = fid; touched++;
        if (!replace) this._paint(i);
      }
      this._owned = this._owned || (pairs || []).length > 0;
      if (replace) { this._repaintAll(); return; }
      if (!touched) return;
      this.fill.geometry.getBuffer('aColor').update();
      this._buildBorders();
      this._scheduleLabels();
      this.r.invalidate();
    }
    _repaintAll() {
      for (let i = 0; i < this.list.length; i++) this._paint(i);
      this.fill.geometry.getBuffer('aColor').update();
      this._buildBorders();
      this._scheduleLabels();
      this.r.invalidate();
    }
    /** Apply owners that arrived before the geometry. */
    flushPending() { if (this._pendingOwners && this.list.length) { const p = this._pendingOwners; this._pendingOwners = null; this.setOwners(p.pairs, p.replace); } }

    // ---- Labels: one per sizeable connected group of a faction's provinces --------------------------------
    _scheduleLabels() { clearTimeout(this._labelTimer); this._labelTimer = setTimeout(() => this._buildLabels(), 60); }
    _buildLabels() {
      const n = this.list.length, parent = new Int32Array(n);
      for (let i = 0; i < n; i++) parent[i] = i;
      const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      for (let s = 0; s < this.segCount; s++) {
        const a = this.segA[s], b = this.segB[s];
        if (a < 0 || b < 0 || this.owner[a] !== this.owner[b] || this.owner[a] <= 0) continue;
        const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb;
      }
      const groups = new Map();
      for (let i = 0; i < n; i++) {
        if (this.owner[i] <= 0) continue;
        const r = find(i), p = this.list[i];
        let g = groups.get(r);
        if (!g) { g = { fid: this.owner[i], area: 0, sx: 0, sy: 0, members: [] }; groups.set(r, g); }
        g.area += p.area; g.sx += p.x * p.area; g.sy += p.y * p.area; g.members.push(i);
      }
      const style = { fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 14, fontWeight: '700', fontStyle: 'italic', fill: 0xffffff, stroke: { color: 0x1a1a1a, width: 3 } };
      const want = [...groups.values()].filter(g => g.area > 400).sort((a, b) => b.area - a.area).slice(0, 400);
      while (this.labels.length < want.length) {
        const t = new PIXI.Text({ text: '', style, resolution: 2 });
        t.anchor.set(0.5); t.alpha = 0.85; t.eventMode = 'none';
        this.container.addChild(t); this.labels.push(t);
      }
      this.labels.forEach((t, k) => {
        const g = want[k];
        t.visible = false;
        if (!g) { t._size = 0; return; }
        // Anchor on the member province nearest the group's centre, so the name sits inside the group.
        const cx = g.sx / g.area, cy = g.sy / g.area;
        let best = g.members[0], bd = Infinity;
        for (const i of g.members) { const p = this.list[i], d = (p.x - cx) ** 2 + (p.y - cy) ** 2; if (d < bd) { bd = d; best = i; } }
        t.text = this.names.get(g.fid) || '';
        t.position.set(this.list[best].x, this.list[best].y);
        t._size = Math.sqrt(g.area);
      });
      this.setZoom(this.r.scale);
      this.r.invalidate();
    }

    /** Zoom: line widths stay in screen pixels, hairlines appear from about a third, labels when a group is big enough. */
    setZoom(scale) {
      if (this.lineUniforms) this.lineUniforms.uniforms.uPx = 1 / scale;
      if (this.edges) this.edges.visible = scale >= 0.35;
      for (const t of this.labels) {
        t.scale.set(1 / scale);
        t.visible = !!t.text && t._size * scale > 90;
      }
    }
  }

  return { Layer };
})();

window.ProvinceLayer = ProvinceLayer;
