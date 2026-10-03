'use strict';
/* global PIXI */
/**
 * No Man's Land: areas drawn with the No Man's Land tag (a drawing's flag; the server makes walking across them cost
 * settings.noMansLandCost times the distance). The ground between the lines, generated from the area's shape and id
 * so every browser sees the same:
 *   - churned mud: a dark wash over the area and ragged blotches of wet earth and standing water (the crater scars),
 *     clipped to its outline, at every zoom;
 *   - shell holes everywhere, from the crater sheet, from 250 % zoom;
 *   - belts of barbed wire running along the area's length, broken by gaps: a dark line from 300 %, coils on pickets
 *     from 600 %;
 *   - the dead of earlier fighting, men of the campaign's armies and here and there a horse with its rider, from
 *     800 % (drawn with the battle figures: Skirmish.setFixed).
 * MapRenderer owns one (renderer.nml), fed from upsertShape / removeShape.
 */
(function () {
  const CRATERS = [0, 3, 6, 22, 36, 40, 60, 72, 75, 95, 96, 98, 108, 117, 119, 127, 134, 135, 138, 139];   // misc-04, as the server's
  const SCAR_PER = 5, CRATER_PER = 2.4, BODY_PER = 9;   // map px² of area per mud blotch, shell hole and body
  const MAX = { scars: 900, craters: 1400, bodies: 260 };
  const rng = seed => { let s = (seed * 2654435761) >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

  class NoMansLand {
    constructor(renderer) {
      this.r = renderer;
      this.layer = new PIXI.Container(); this.layer.eventMode = 'none';
      this.groundC = new PIXI.Container(); this.craterC = new PIXI.Container(); this.wireG = new PIXI.Graphics();
      this.layer.addChild(this.groundC, this.craterC, this.wireG);
      this.areas = new Map();   // shape id -> { key, pts, bbox, ground, craters, belts, bodies }
      this._wireKey = null;
    }
    get size() { return this.areas.size; }
    /** A drawing added or changed: build (or drop) its No Man's Land. */
    upsert(s) {
      if (s.kind !== 'area' || !s.data?.noMansLand || !Array.isArray(s.points) || s.points.length < 3) { this.remove(s.id); return; }
      const key = JSON.stringify(s.points);
      if (this.areas.get(s.id)?.key === key) return;
      this.remove(s.id);
      this.areas.set(s.id, this._build(s, key));
      this._changed();
    }
    remove(id) {
      const a = this.areas.get(id);
      if (!a) return;
      a.ground.destroy({ children: true }); a.mask.destroy();
      for (const sp of a.craters) sp.destroy();
      this.areas.delete(id);
      this._changed();
    }
    clear() { for (const id of [...this.areas.keys()]) this.remove(id); }
    _changed() {
      this._wireKey = null; this._bodiesFor = null;
      if (!this.areas.size) this.r.skirmish?.setFixed([]);   // (tick stops running with no areas left)
      this.r.invalidate();
    }

    _build(s, key) {
      const pts = s.points.map(p => [Number(p[0]), Number(p[1])]), flat = pts.flat(), rand = rng(Number(s.id) * 7 + 3);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      let area = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
      area = Math.abs(area) / 2;
      const inside = (x, y) => {
        let c = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i], [xj, yj] = pts[j];
          if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
        }
        return c;
      };
      const spot = () => { for (let k = 0; k < 30; k++) { const x = bbox[0] + rand() * (bbox[2] - bbox[0]), y = bbox[1] + rand() * (bbox[3] - bbox[1]); if (inside(x, y)) return [x, y]; } return null; };
      // Mud: a dark wash, then blotches of churned earth and water, all clipped to the outline.
      const mask = new PIXI.Graphics().poly(flat).fill(0xffffff);
      const ground = new PIXI.Container();
      ground.addChild(new PIXI.Graphics().poly(flat).fill({ color: 0x4a3b2a, alpha: 0.78 }));
      const scars = this.r._scarTextures();
      const nScars = Math.min(MAX.scars, Math.ceil(area / SCAR_PER));
      for (let i = 0; i < nScars; i++) {
        const x = bbox[0] + rand() * (bbox[2] - bbox[0]), y = bbox[1] + rand() * (bbox[3] - bbox[1]);
        const sp = new PIXI.Sprite(scars[Math.floor(rand() * scars.length)]);
        sp.anchor.set(0.5); sp.position.set(x, y); sp.rotation = rand() * Math.PI * 2;
        sp.scale.set((3 + rand() * 5) / sp.texture.width); sp.alpha = 0.55 + rand() * 0.4;
        if (rand() < 0.35) sp.tint = 0xb8a898;
        ground.addChild(sp);
      }
      ground.mask = mask;
      this.groundC.addChild(mask, ground);
      // Shell holes.
      const craters = [], nCraters = Math.min(MAX.craters, Math.ceil(area / CRATER_PER));
      for (let i = 0; i < nCraters; i++) {
        const p = spot();
        if (!p) continue;
        const sp = new PIXI.Sprite(PIXI.Texture.EMPTY), size = (0.5 + Math.pow(rand(), 2) * 1.1);
        sp.anchor.set(0.5); sp.position.set(p[0], p[1]); sp.rotation = rand() * Math.PI * 2; sp.alpha = 0.75 + rand() * 0.2; sp.eventMode = 'none';
        const id = `sprite:misc-04:${CRATERS[Math.floor(rand() * CRATERS.length)]}`;
        if (window.SpriteAtlas) window.SpriteAtlas.texture(id).then(tex => { if (sp.destroyed || !tex) return; sp.texture = tex; sp.scale.set(size / Math.max(tex.width, tex.height)); this.r.invalidate(); }).catch(() => {});
        this.craterC.addChild(sp);
        craters.push(sp);
      }
      // Wire: belts along the area's long axis (from its outline's spread), each wavering a little and broken by gaps.
      let mx = 0, my = 0;
      for (const [x, y] of pts) { mx += x; my += y; }
      mx /= pts.length; my /= pts.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
      const along = pts.map(([x, y]) => (x - mx) * ux + (y - my) * uy), across = pts.map(([x, y]) => (x - mx) * vx + (y - my) * vy);
      const u0 = Math.min(...along), u1 = Math.max(...along), v0 = Math.min(...across), v1 = Math.max(...across);
      const nBelts = Math.max(1, Math.min(5, Math.round((v1 - v0) / 4)));
      const belts = [];
      for (let b = 0; b < nBelts; b++) {
        const v = v0 + (v1 - v0) * (b + 0.5 + (rand() - 0.5) * 0.4) / nBelts, wob = rand() * 10, step = 0.3;
        let cur = [], gapLeft = 0;
        for (let u = u0; u <= u1; u += step) {
          const vv = v + Math.sin(u * 0.35 + wob) * 0.6 + Math.sin(u * 1.7 + wob * 2) * 0.15;
          const x = mx + ux * u + vx * vv, y = my + uy * u + vy * vv;
          if (gapLeft > 0) gapLeft -= step;
          else if (rand() < 0.012) gapLeft = 1 + rand() * 4;   // a gap cut through the wire
          if (inside(x, y) && gapLeft <= 0) cur.push([x, y]);
          else if (cur.length) { if (cur.length > 2) belts.push(cur); cur = []; }
        }
        if (cur.length > 2) belts.push(cur);
      }
      // The dead: places now, figures when the battle art has loaded (_bodies).
      const spots = [], nBodies = Math.min(MAX.bodies, Math.ceil(area / BODY_PER));
      for (let i = 0; i < nBodies; i++) { const p = spot(); if (p) spots.push({ x: p[0], y: p[1], r: rand() * Math.PI * 2, sg: rand() < 0.5 ? -1 : 1, k: rand(), j: rand(), h: rand() < 0.12 }); }
      return { key, pts, bbox, ground, mask, craters, belts, spots };
    }

    /** The dead lying in every area, as battle-figure remains (Skirmish.setFixed), once that art has loaded. */
    _bodies() {
      const sk = this.r.skirmish;
      if (!sk?.tex || this._bodiesFor === sk.tex) return;
      this._bodiesFor = sk.tex;
      const names = sk.factions?.length ? sk.factions.map(f => f.name) : ['British Empire', 'German Empire', 'France'];
      const kits = [...new Map(names.map(n => { const k = sk.kitFor({ type: 'unit', data: { nation: n } }); return [k.line, k]; })).values()];
      const dead = kits.map(k => sk._frames(k, 'dead')).filter(Boolean), horses = sk.mounts?.dead || [];
      const out = [];
      for (const a of this.areas.values()) {
        for (const b of a.spots) {
          const list = dead[Math.floor(b.k * dead.length)];
          if (!list) continue;
          const man = list[Math.floor(b.j * list.length)];
          const base = { fixed: true, x: b.x, y: b.y, sg: b.sg };
          if (b.h && horses.length) {
            const hf = horses[Math.floor(b.j * horses.length)], hs = 32 / hf.w, lx = (b.k - 0.5) * 0.6 * hf.w * hs, ly = -(hf.ay * hf.h * hs + 4);
            out.push({ ...base, ox: 0, oy: 0, r: b.r, f: 'h', i: hf.idx });
            out.push({ ...base, ox: lx * Math.cos(b.r) - ly * Math.sin(b.r), oy: lx * Math.sin(b.r) + ly * Math.cos(b.r), r: b.r + (b.j - 0.5) * 2.4, f: 's', i: man.idx });
          } else out.push({ ...base, ox: 0, oy: 0, r: b.r, f: 's', i: man.idx });
        }
      }
      sk.setFixed(out);
    }

    /** Each frame: shell holes and wire by zoom (the wire redrawn when the view or zoom has changed). */
    tick(s, view) {
      this._bodies();
      this.craterC.visible = s >= 2.5;
      const g = this.wireG;
      if (s < 3) { if (this._wireKey !== 'off') { g.clear(); this._wireKey = 'off'; } return; }
      const w = view[2] - view[0], h = view[3] - view[1];
      const k = this._wireKey;
      if (k && k !== 'off' && k.s === s && view[0] >= k.v[0] && view[1] >= k.v[1] && view[2] <= k.v[2] && view[3] <= k.v[3]) return;
      const v = [view[0] - w * 0.5, view[1] - h * 0.5, view[2] + w * 0.5, view[3] + h * 0.5];
      this._wireKey = { s, v };
      g.clear();
      const near = ([x, y]) => x >= v[0] && x <= v[2] && y >= v[1] && y <= v[3];
      for (const a of this.areas.values()) {
        if (a.bbox[2] < v[0] || a.bbox[0] > v[2] || a.bbox[3] < v[1] || a.bbox[1] > v[3]) continue;
        for (const belt of a.belts) {
          if (s < 6) {
            // Far off: the belt as a dark, slightly furred line.
            g.moveTo(belt[0][0], belt[0][1]);
            for (let i = 1; i < belt.length; i++) g.lineTo(belt[i][0], belt[i][1]);
            g.stroke({ width: 1.6 / s, color: 0x9d978b, alpha: 0.6 });
            continue;
          }
          // Close in: concertina coils every 4.5 screen px, two rows, on pickets.
          const r = 2.4 / s, step = 4.5 / s;
          let acc = 0, n = 0;
          const pickets = [];
          for (let i = 1; i < belt.length; i++) {
            const [x0, y0] = belt[i - 1], [x1, y1] = belt[i], L = Math.hypot(x1 - x0, y1 - y0);
            if (!near(belt[i])) { acc = 0; continue; }
            let d = acc;
            for (; d < L; d += step) {
              const t = d / L, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t, nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
              g.circle(x + nx * r * 0.8, y + ny * r * 0.8, r);
              g.circle(x - nx * r * 0.8 + (x1 - x0) / L * step / 2, y - ny * r * 0.8 + (y1 - y0) / L * step / 2, r);
              if (n++ % 4 === 0) pickets.push([x, y, nx, ny]);
            }
            acc = d - L;   // carry on the spacing into the next stretch
          }
          g.stroke({ width: 0.75 / s, color: 0xa9a397, alpha: 0.85 });   // steel grey, to read against the mud
          for (const [x, y, nx, ny] of pickets) g.moveTo(x - nx * r * 2, y - ny * r * 2).lineTo(x + nx * r * 2, y + ny * r * 2);
          if (pickets.length) g.stroke({ width: 1.3 / s, color: 0x231b13, alpha: 0.95 });
        }
      }
    }
  }
  window.NoMansLand = NoMansLand;
})();
