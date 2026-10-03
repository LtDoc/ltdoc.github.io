'use strict';
// Packs the mountain sprites (docs/TERRAIN.md, "How it looks") from the user's art into one atlas.
// Usage: node scripts/build-terrain.js "rob assets/Terrain Assets"
//   reads gl1.png … gl5.png (snow-tipped mountains) and p1.png … p5.png (bare mountains), one sprite per file on a
//   transparent background, from a single peak (1) to a broad cluster of peaks (5), and the trees: dl1–3 (mixed
//   woods), dp1–3 (mostly conifers) and "drzewa lisciaste.png" (a broad deciduous grove), drawn round the foot of the ranges.
// Output: public/assets/terrain.png and public/assets/terrain.json:
//   { snowy: [frame], bare: [frame], trees: [frame] }, each list from the smallest sprite to the largest,
//   frame = { x, y, w, h, ax, ay, span }: ax / ay the anchor (the middle of the sprite's ground) as fractions of the
//   frame; span its width as a share of the widest sprite's of its kind (mountains, trees), so a cluster is drawn wider
//   than a single peak and the grove wider than a clump of trees.
const fs = require('node:fs');
const path = require('node:path');
const P = require('./png');

const dir = process.argv[2];
if (!dir) { console.error('Usage: node scripts/build-terrain.js <folder with gl1.png … gl5.png and p1.png … p5.png>'); process.exit(1); }
const OUT = path.join(__dirname, '..', 'public', 'assets');
const SCALE = 4;   // the art is painted far larger than it is ever shown

function sprite(file) {
  const img = P.decodePng(fs.readFileSync(path.join(dir, file)));
  const { w: W, h: H, px } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const f = P.shrink(img, [x0, y0, x1 - x0 + 1, y1 - y0 + 1], SCALE);
  // Anchor: the alpha-weighted middle of the lower half (the ground the peaks stand on).
  let sx = 0, sy = 0, sa = 0;
  for (let y = Math.floor(f.h / 2); y < f.h; y++) for (let x = 0; x < f.w; x++) { const a = f.px[(y * f.w + x) * 4 + 3]; sx += x * a; sy += y * a; sa += a; }
  return { ...f, file, srcW: x1 - x0 + 1, ax: +(sx / sa / f.w).toFixed(3), ay: +(sy / sa / f.h).toFixed(3) };
}

const snowy = [1, 2, 3, 4, 5].map(i => sprite(`gl${i}.png`)), bare = [1, 2, 3, 4, 5].map(i => sprite(`p${i}.png`));
const trees = ['dl1.png', 'dl2.png', 'dl3.png', 'dp1.png', 'dp2.png', 'dp3.png', 'drzewa lisciaste.png'].map(sprite);
const all = [...snowy, ...bare, ...trees];
const widest = Math.max(...[...snowy, ...bare].map(f => f.srcW)), widestTree = Math.max(...trees.map(f => f.srcW));
for (const f of all) f.span = f.srcW / (trees.includes(f) ? widestTree : widest);
const packed = P.packShelves(all, 1600);
const frame = f => { const p = packed.place.find(q => q.f === f); return { x: p.x, y: p.y, w: f.w, h: f.h, ax: f.ax, ay: f.ay, span: +f.span.toFixed(3) }; };
const bySpan = list => list.map(frame).sort((a, b) => a.span - b.span);
fs.writeFileSync(path.join(OUT, 'terrain.png'), P.encodePng(packed.w, packed.h, packed.px));
fs.writeFileSync(path.join(OUT, 'terrain.json'), JSON.stringify({ scale: 1 / SCALE, w: packed.w, h: packed.h, snowy: bySpan(snowy), bare: bySpan(bare), trees: bySpan(trees) }, null, 1));
console.log(`terrain.png ${packed.w}×${packed.h}: ${snowy.length} snowy, ${bare.length} bare, ${trees.length} trees`);
for (const f of all) console.log(`  ${f.file} ${f.w}×${f.h} span ${f.span.toFixed(2)} anchor ${f.ax},${f.ay}`);
