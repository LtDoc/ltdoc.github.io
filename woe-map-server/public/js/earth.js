'use strict';
/* global PIXI */

/**
 * Vector Earth map drawn in WebGL from Natural Earth 1:50m data (public domain), in an
 * equirectangular projection so the map is a flat W×H pixel plane like an uploaded image:
 *   x = (lon + 180) / 360 * W,  y = (90 - lat) / 180 * H
 * Fills (ocean, land, lakes) are built once. Strokes (coast, rivers, borders, graticule) are rebuilt
 * on zoom so they stay a constant width on screen and look crisp at any scale.
 */
const EarthMap = {
  STYLES: {
    atlas:     { ocean: 0x27506f, land: 0x6a9455, coast: 0x2a4630, lake: 0x2d6a92, river: 0x4a90c2, border: 0xf3ead0, graticule: 0xffffff },
    parchment: { ocean: 0xb8a57a, land: 0xeadcb6, coast: 0x6a5637, lake: 0xb8a57a, river: 0x7a6543, border: 0x5b3f2a, graticule: 0x5b3f2a },
    dark:      { ocean: 0x0f161d, land: 0x2d3b33, coast: 0x62806f, lake: 0x0f161d, river: 0x3e7ca3, border: 0xd7c29a, graticule: 0x8fa3b5 },
  },
  _cache: {},

  load(name) {
    if (!this._cache[name]) {
      this._cache[name] = fetch(`/earth/${name}.json.gz`).then(r => {
        if (!r.ok) throw new Error(`Earth layer "${name}" is missing on the server`);
        return r.json();
      });
    }
    return this._cache[name];
  },

  project(lon, lat, W, H) { return [(lon + 180) / 360 * W, (90 - lat) / 180 * H]; },
  unproject(x, y, W, H) { return [x / W * 360 - 180, 90 - y / H * 180]; },

  /** Great-circle distance in km between two pixel positions on a W×H equirectangular map. */
  distanceKm(x1, y1, x2, y2, W, H) {
    const [lon1, lat1] = this.unproject(x1, y1, W, H), [lon2, lat2] = this.unproject(x2, y2, W, H);
    const r = Math.PI / 180, R = 6371.0088;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  },

  /** Stable pastel tint per country name (colonies take their overlord's tint). */
  tintFor(name) {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = h % 360, sat = 0.55, light = 0.6;
    const c = (1 - Math.abs(2 * light - 1)) * sat, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = light - c / 2;
    const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
    return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
  },

  /**
   * Build the map. Returns { container, redraw(scale), destroy() }.
   * opts: { width, height, style, showRivers, showLakes, showGraticule,
   *         borders: 'none' | 'modern' | <year>, tint: bool, labels: bool }
   *   (legacy showBorders:true means borders:'modern')
   */
  async build(opts) {
    const W = opts.width, H = opts.height;
    const st = this.STYLES[opts.style] || this.STYLES.atlas;
    const borders = opts.borders || (opts.showBorders ? 'modern' : 'none');
    const isYear = /^\d{3,4}$/.test(String(borders));
    const [land, lakes, rivers, modern, world] = await Promise.all([
      this.load('land'),
      opts.showLakes !== false ? this.load('lakes') : null,
      opts.showRivers !== false ? this.load('rivers') : null,
      borders === 'modern' ? this.load('borders') : null,
      isYear ? this.load(`world_${borders}`) : null,
    ]);
    const P = (p) => this.project(p[0], p[1], W, H);
    const flat = ring => { const out = []; for (const p of ring) { const q = P(p); out.push(q[0], q[1]); } return out; };

    const container = new PIXI.Container();
    container.addChild(new PIXI.Graphics().rect(0, 0, W, H).fill(st.ocean));

    const landG = new PIXI.Graphics();
    for (const poly of land.polygons) {
      const [outer, ...holes] = poly;
      landG.poly(flat(outer)).fill(st.land);
      for (const h of holes) landG.poly(flat(h)).cut();
    }
    container.addChild(landG);

    // Historical states: faint tint per power (so an empire and its colonies match), drawn over the land.
    const stateRings = [];
    const labelData = [];
    let tintLayer = null;   // exposed so game-mode territories can hide the historical tint
    if (world) {
      const tintG = new PIXI.Graphics();
      for (const c of world.countries) {
        const power = c.s || c.n;
        const color = this.tintFor(power);
        let best = null;
        for (const poly of c.p) {
          const [outer, ...holes] = poly;
          const pts = flat(outer);
          if (opts.tint !== false) {
            tintG.poly(pts).fill({ color, alpha: 0.28 });
            for (const h of holes) tintG.poly(flat(h)).cut();
          }
          stateRings.push(pts);
          // label anchor: centroid of the largest ring
          let area = 0, cx = 0, cy = 0;
          for (let i = 0; i < pts.length; i += 2) {
            const j = (i + 2) % pts.length;
            const cross = pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
            area += cross; cx += (pts[i] + pts[j]) * cross; cy += (pts[i + 1] + pts[j + 1]) * cross;
          }
          area /= 2;
          if (Math.abs(area) > Math.abs(best?.area || 0)) best = { area, x: cx / (6 * area), y: cy / (6 * area) };
        }
        if (best && c.n) labelData.push({ name: c.n, sub: c.s, x: best.x, y: best.y, size: Math.sqrt(Math.abs(best.area)) });
      }
      if (opts.tint !== false) { container.addChild(tintG); tintLayer = tintG; }
    }

    if (lakes) {
      const lakeG = new PIXI.Graphics();
      for (const poly of lakes.polygons) {
        const [outer, ...holes] = poly;
        lakeG.poly(flat(outer)).fill(st.lake);
        for (const h of holes) lakeG.poly(flat(h)).cut();
      }
      container.addChild(lakeG);
    }

    const strokes = new PIXI.Graphics();
    container.addChild(strokes);

    // Country labels: constant on-screen size, shown only when the state is large enough on screen.
    const labelLayer = new PIXI.Container();
    labelLayer.eventMode = 'none';
    const labels = [];
    if (world && opts.labels !== false) {
      for (const l of labelData) {
        const t = new PIXI.Text({
          text: l.sub ? `${l.name}\n(${l.sub})` : l.name,
          style: { fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 12, fontWeight: '600', fill: st.border,
            stroke: { color: st.ocean, width: 3 }, align: 'center' },
          resolution: 2,
        });
        t.anchor.set(0.5); t.position.set(l.x, l.y); t.visible = false;
        labelLayer.addChild(t);
        labels.push({ t, size: l.size });
      }
      container.addChild(labelLayer);
    }

    const coastRings = land.polygons.flat().map(flat);
    const lakeRings = lakes ? lakes.polygons.flat().map(flat) : [];
    const riverLines = rivers ? rivers.lines.map(l => flat(Array.isArray(l) ? l : l.p)) : [];
    const borderLines = modern ? modern.lines.map(l => flat(Array.isArray(l) ? l : l.p)) : [];

    const drawPath = (g, pts, close) => {
      g.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      if (close) g.closePath();
    };

    const api = { hidePolitical: false };   // game-mode territories replace the political borders and tint
    function redraw(scale) {
      const g = strokes;
      g.clear();
      const w = 1 / scale;
      const political = !api.hidePolitical;
      if (opts.showGraticule) {
        for (let lon = -180; lon <= 180; lon += 15) { const [x] = P([lon, 0]); g.moveTo(x, 0).lineTo(x, H); }
        for (let lat = -90; lat <= 90; lat += 15) { const [, y] = P([0, lat]); g.moveTo(0, y).lineTo(W, y); }
        g.stroke({ width: w, color: st.graticule, alpha: 0.18 });
      }
      for (const r of coastRings) drawPath(g, r, true);
      g.stroke({ width: 1.1 * w, color: st.coast, alpha: 0.9 });
      if (lakeRings.length) {
        for (const r of lakeRings) drawPath(g, r, true);
        g.stroke({ width: 0.8 * w, color: st.coast, alpha: 0.7 });
      }
      if (riverLines.length) {
        for (const l of riverLines) drawPath(g, l, false);
        g.stroke({ width: Math.max(0.8 * w, Math.min(2.2 * w, 1.4 * w)), color: st.river, alpha: 0.85 });
      }
      if (political && borderLines.length) {
        for (const l of borderLines) drawPath(g, l, false);
        g.stroke({ width: 1.2 * w, color: st.border, alpha: 0.75 });
      }
      if (political && stateRings.length) {
        for (const r of stateRings) drawPath(g, r, true);
        g.stroke({ width: 1.3 * w, color: st.border, alpha: 0.8 });
      }
      if (tintLayer) tintLayer.visible = political;
      for (const l of labels) {
        l.t.scale.set(1 / scale);
        l.t.visible = political && l.size * scale > 70;   // roughly: the state spans 70+ screen px
      }
    }

    return Object.assign(api, {
      container, redraw, tintLayer,
      destroy() { container.destroy({ children: true }); },
    });
  },
};

window.EarthMap = EarthMap;
