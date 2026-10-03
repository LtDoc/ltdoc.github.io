'use strict';

/**
 * Hills and mountains (docs/TERRAIN.md), shared by the server (rules) and the browser (drawing).
 *
 * Earth maps read a bundled elevation grid (public/earth/terrain.bin.gz, built by scripts/prepare-terrain.js from
 * NASA's Blue Marble topography: 5400 × 2700 cells of 1/15°, about 7.4 km at the equator, 0..255 = 0..6400 m),
 * equirectangular like the map, so a map point's cell is (x / W · gw, y / H · gh) at any map size.
 * Each cell is classified by its height and its local relief (highest minus lowest ground within two cells, about
 * 35 km): mountains are high or steep ground, hills rolling or raised ground, the rest flat.
 * Image maps have no elevation: the GM paints Hills or Mountains areas instead (shapes with data.terrain).
 */
const Terrain = (() => {
  const FLAT = 0, HILLS = 1, MOUNTAINS = 2;
  const NAMES = ['flat', 'hills', 'mountains'];
  const M_PER_STEP = 6400 / 255;

  /** Parse the inflated grid file: "WOET", u16 width, u16 height, then the bytes. */
  function decode(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'WOET') throw new Error('Not a terrain grid');
    const W = u8[4] | (u8[5] << 8), H = u8[6] | (u8[7] << 8);
    return { W, H, elev: u8.subarray(8, 8 + W * H), cls: null };
  }

  /** Thresholds in metres: [height alone, relief with height, relief alone]. */
  const RULES = {
    mountains: { height: 2400, relief: 750, reliefAbove: 700, reliefAlone: 1150 },
    hills: { height: 1300, relief: 260, reliefAbove: 150 },
  };
  /** Classify every cell (once per grid): grid.cls[i] = FLAT | HILLS | MOUNTAINS. */
  function classify(grid) {
    if (grid.cls) return grid.cls;
    const { W, H, elev } = grid, N = W * H, R = 2;
    // Separable running min / max over a (2R+1)² window: rows first, then columns.
    const rmin = new Uint8Array(N), rmax = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) {
        let lo = 255, hi = 0;
        for (let k = -R; k <= R; k++) {
          const v = elev[o + ((x + k + W) % W)];   // the map wraps east-west
          if (v < lo) lo = v; if (v > hi) hi = v;
        }
        rmin[o + x] = lo; rmax[o + x] = hi;
      }
    }
    const cls = new Uint8Array(N);
    const m = RULES.mountains, h = RULES.hills;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, e = elev[i];
        if (!e) continue;
        let lo = 255, hi = 0;
        for (let k = -R; k <= R; k++) {
          const yy = Math.min(H - 1, Math.max(0, y + k)), j = yy * W + x;
          if (rmin[j] < lo) lo = rmin[j]; if (rmax[j] > hi) hi = rmax[j];
        }
        const em = e * M_PER_STEP, rel = (hi - lo) * M_PER_STEP;
        if (em >= m.height || (rel >= m.relief && em >= m.reliefAbove) || rel >= m.reliefAlone) cls[i] = MOUNTAINS;
        else if (em >= h.height || (rel >= h.relief && em >= h.reliefAbove)) cls[i] = HILLS;
      }
    }
    // Tidy: a lone mountain cell among lower ground is a hill; a lone flat cell inside a range is hills.
    const out = cls.slice();
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        let mtn = 0, low = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const c = cls[i + dy * W + dx];
          if (c === MOUNTAINS) mtn++; else if (c === FLAT) low++;
        }
        if (cls[i] === MOUNTAINS && mtn < 2) out[i] = HILLS;
        else if (cls[i] === FLAT && elev[i] && mtn >= 5) out[i] = HILLS;
      }
    }
    grid.cls = out;
    return out;
  }

  /** The cell under a map point of a mapW × mapH Earth map. */
  function cell(grid, x, y, mapW, mapH) {
    const gx = Math.min(grid.W - 1, Math.max(0, Math.floor(x / mapW * grid.W)));
    const gy = Math.min(grid.H - 1, Math.max(0, Math.floor(y / mapH * grid.H)));
    return gy * grid.W + gx;
  }
  function classAt(grid, x, y, mapW, mapH) { return classify(grid)[cell(grid, x, y, mapW, mapH)]; }
  function heightAt(grid, x, y, mapW, mapH) { return grid.elev[cell(grid, x, y, mapW, mapH)] * M_PER_STEP; }

  /**
   * Where the drawn snow caps begin, in metres, by latitude. The cells average a peak with its valleys (the Alps
   * reach about 3400 m in the grid), so this sits below the real snow line, fitted so the high Alps, Sierra Nevada,
   * Rockies, Caucasus, Pyrenees and Norwegian fjells are white-topped and the Carpathians are not.
   */
  const SNOW = [[0, 5200], [25, 5000], [30, 4000], [38, 2900], [46, 2100], [52, 1900], [61, 1450], [70, 700], [80, 200], [90, 0]];
  function snowLine(lat) {
    const a = Math.min(90, Math.abs(lat));
    for (let i = 1; i < SNOW.length; i++) {
      const [l1, m1] = SNOW[i];
      if (a <= l1) { const [l0, m0] = SNOW[i - 1]; return m0 + (m1 - m0) * (a - l0) / (l1 - l0); }
    }
    return 0;
  }

  return { FLAT, HILLS, MOUNTAINS, NAMES, M_PER_STEP, RULES, decode, classify, cell, classAt, heightAt, snowLine };
})();

if (typeof window !== 'undefined') window.Terrain = Terrain;
if (typeof module !== 'undefined') module.exports = Terrain;
