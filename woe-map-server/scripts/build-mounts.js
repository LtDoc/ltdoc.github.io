'use strict';
// Cuts the horsemen and aircraft for the battle scenes (docs/UNITS.md, "Cavalry and aircraft in a fight") out of the
// user's art into one small atlas: the rider from Cavalry.png in each army's uniform (the Russians ride their own, from
// Russian Infantry/…-Cavalry.png, and the Arabs their camels, from Arab Infantry/…mounted….png), and the 36
// biplanes of PlaneSprites.png,
// sorted into liveries (planes painted alike, with the same national markings) so a squadron flies matching planes.
// Usage: node scripts/build-mounts.js "rob assets"
// Output: public/assets/mounts.png and public/assets/mounts.json
const fs = require('node:fs');
const path = require('node:path');
const P = require('./png');

const dir = process.argv[2];
if (!dir) { console.error('Usage: node scripts/build-mounts.js <folder with Cavalry.png and Army Assets/PlaneSprites.png>'); process.exit(1); }
const OUT = path.join(__dirname, '..', 'public', 'assets');

// Liveries, by the planes' place on the sheet (reading order, rows of about 96 px). Sorted by eye: one colour scheme
// and one kind of marking each. `mark`: 'cross' (Iron Cross, the Central Powers), 'roundel' (the Allies) or 'plain'.
const LIVERIES = {
  'grey-cross': ['cross', [5, 9]],
  'olive-cross': ['cross', [26]],
  'striped-cross': ['cross', [32]],
  'sand-cross': ['cross', [17]],
  'linen-cross': ['cross', [8]],
  'cream-cross': ['cross', [27]],
  'brown-cross': ['cross', [33]],
  'red-cross': ['cross', [13]],
  'blue-cross': ['cross', [15]],
  'olive-roundel': ['roundel', [2, 6]],
  'green-roundel': ['roundel', [4, 7, 16]],
  'linen-roundel': ['roundel', [0, 1, 11]],
  'khaki-tricolour': ['roundel', [19, 22]],
  'brown-roundel': ['roundel', [14, 24]],
  'silver-roundel': ['roundel', [23, 31, 30, 18]],
  'purple-roundel': ['roundel', [25]],
  'camo-roundel': ['roundel', [20]],
  'brown-plain': ['plain', [3, 10]],
  'green-plain': ['plain', [21, 34]],
  'splinter': ['plain', [12]],
  'grey-plain': ['plain', [29]],
  'sky-plain': ['plain', [35]],
  'tan-plain': ['plain', [28]],
};

// ---- Aircraft (drawn from above, nose up) ----
const sheet = P.decodePng(fs.readFileSync(path.join(dir, 'Army Assets', 'PlaneSprites.png')));
const lab = P.blobs(sheet);
const boxes = lab.boxes.map((b, i) => ({ b, a: lab.area[i] })).filter(t => t.b && t.a > 1500)
  .sort((p, q) => (Math.floor(p.b[1] / 90) - Math.floor(q.b[1] / 90)) || (p.b[0] - q.b[0])).map(t => t.b);
if (boxes.length !== 36) throw new Error(`expected 36 planes on the sheet, found ${boxes.length}`);
const used = Object.values(LIVERIES).flatMap(([, ids]) => ids);
if (new Set(used).size !== 36 || used.some(i => i < 0 || i > 35)) throw new Error('every plane must be in exactly one livery');
const planes = boxes.map(b => P.cut(sheet, [b], 2, lab));

// ---- Horsemen (from above, horse's head up), recoloured into the three infantry uniforms ----
// The rider and his kit are the khaki pixels of the middle band (the bridle's brass above and the hooves below are
// the same hue, so they are left alone); each keeps its shading against the uniform's average.
const cav = P.decodePng(fs.readFileSync(path.join(dir, 'Cavalry.png')));
const hsv = (r, g, b) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0;
  if (mx > mn) h = mx === r ? ((g - b) / (mx - mn)) * 60 : mx === g ? (2 + (b - r) / (mx - mn)) * 60 : (4 + (r - g) / (mx - mn)) * 60;
  return [h < 0 ? h + 360 : h, mx ? (mx - mn) / mx : 0]; };
const isKit = i => { const y = Math.floor(i / cav.w); if (y < cav.h * 0.31 || y > cav.h * 0.68 || cav.px[i * 4 + 3] < 30) return false;
  const [h, s] = hsv(cav.px[i * 4], cav.px[i * 4 + 1], cav.px[i * 4 + 2]); return h >= 32 && h <= 80 && s > 0.12; };
const lum = i => 0.3 * cav.px[i * 4] + 0.59 * cav.px[i * 4 + 1] + 0.11 * cav.px[i * 4 + 2];
let sum = 0, n = 0;
for (let i = 0; i < cav.w * cav.h; i++) if (isKit(i)) { sum += lum(i); n++; }
const mean = sum / n;
// field grey; olive drab; horizon blue; Ottoman khaki
const TINTS = { beige: null, grey: [104, 107, 99], green: [108, 110, 68], french: [112, 132, 160], ottoman: [104, 92, 68] };
const riders = Object.entries(TINTS).map(([key, rgb]) => {
  const px = Buffer.from(cav.px);
  if (rgb) for (let i = 0; i < cav.w * cav.h; i++) if (isKit(i)) {
    const k = lum(i) / mean;
    for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.max(0, Math.min(255, Math.round(rgb[c] * k)));
  }
  const img = { w: cav.w, h: cav.h, px };
  return { ...P.cut(img, [[0, 0, cav.w, cav.h]], 3), key };
});

// The Russian horseman, brought to the same height as the others.
const ruDir = path.join(dir, 'Russian Infantry'), ruFile = fs.existsSync(ruDir) && fs.readdirSync(ruDir).find(f => /cavalry.png$/i.test(f));
if (ruFile) {
  const img = P.decodePng(fs.readFileSync(path.join(ruDir, ruFile)));
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.px[(y * img.w + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const box = [x0, y0, x1 - x0 + 1, y1 - y0 + 1], r = P.shrink(img, box, box[3] / (riders[0].h - 8));
  let cx = 0, cy = 0, ca = 0;
  for (let i = 0; i < r.w * r.h; i++) { const a = r.px[i * 4 + 3]; cx += (i % r.w) * a; cy += Math.floor(i / r.w) * a; ca += a; }
  riders.push({ ...r, cx: cx / ca, cy: cy / ca, key: 'russian' });
}

// The Arab camel riders (one with a rifle, one with a sabre: "arab", "arab-2"), drawn heading up and to the right:
// turned head-up (along the long axis of the figure, the head the end nearer the top right) and brought to the
// same height as the horses.
const arDir = path.join(dir, 'Arab Infantry');
const arFiles = fs.existsSync(arDir) ? fs.readdirSync(arDir).filter(f => /mounted/i.test(f)).sort((a, b) => /rifle/i.test(b) - /rifle/i.test(a)) : [];
arFiles.forEach((file, k) => {
  const img = P.decodePng(fs.readFileSync(path.join(arDir, file)));
  let mx = 0, my = 0, ma = 0;
  for (let i = 0; i < img.w * img.h; i++) { const a = img.px[i * 4 + 3]; mx += (i % img.w) * a; my += Math.floor(i / img.w) * a; ma += a; }
  mx /= ma; my /= ma;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < img.w * img.h; i++) { const a = img.px[i * 4 + 3], dx = (i % img.w) - mx, dy = Math.floor(i / img.w) - my; sxx += a * dx * dx; syy += a * dy * dy; sxy += a * dx * dy; }
  let axis = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  if (Math.cos(axis) - Math.sin(axis) < 0) axis += Math.PI;   // towards the top right
  const rot = rotate(img, -Math.PI / 2 - axis);
  let x0 = rot.w, y0 = rot.h, x1 = -1, y1 = -1;
  for (let y = 0; y < rot.h; y++) for (let x = 0; x < rot.w; x++) if (rot.px[(y * rot.w + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const box = [x0, y0, x1 - x0 + 1, y1 - y0 + 1], r = P.shrink(rot, box, box[3] / (riders[0].h - 8));
  let cx = 0, cy = 0, ca = 0;
  for (let i = 0; i < r.w * r.h; i++) { const a = r.px[i * 4 + 3]; cx += (i % r.w) * a; cy += Math.floor(i / r.w) * a; ca += a; }
  riders.push({ ...r, cx: cx / ca, cy: cy / ca, key: k ? 'arab-' + (k + 1) : 'arab' });
});
/** An image turned by `a` radians (clockwise on screen) about its centre, onto a canvas big enough to hold it. */
function rotate(img, a) {
  const n = Math.ceil(Math.hypot(img.w, img.h)), px = Buffer.alloc(n * n * 4), c = Math.cos(a), sn = Math.sin(a);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = x - n / 2, dy = y - n / 2, sx = img.w / 2 + dx * c + dy * sn - 0.5, sy = img.h / 2 - dx * sn + dy * c - 0.5;
    const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy, acc = [0, 0, 0, 0];
    for (const [ox, oy, wgt] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
      const qx = ix + ox, qy = iy + oy; if (qx < 0 || qy < 0 || qx >= img.w || qy >= img.h) continue;
      const q = (qy * img.w + qx) * 4, al = img.px[q + 3] * wgt;
      for (let ch = 0; ch < 3; ch++) acc[ch] += img.px[q + ch] * al;
      acc[3] += al;
    }
    if (acc[3] > 0) { const d = (y * n + x) * 4; for (let ch = 0; ch < 3; ch++) px[d + ch] = Math.round(acc[ch] / acc[3]); px[d + 3] = Math.round(acc[3]); }
  }
  return { w: n, h: n, px };
}

const packed = P.pack([planes.slice(0, 12), planes.slice(12, 24), planes.slice(24), riders]);
const frame = f => { const p = packed.place.find(q => q.f === f); return { x: p.x, y: p.y, w: f.w, h: f.h, ax: +(f.cx / f.w).toFixed(3), ay: +(f.cy / f.h).toFixed(3) }; };
fs.writeFileSync(path.join(OUT, 'mounts.png'), P.encodePng(packed.w, packed.h, packed.px));
fs.writeFileSync(path.join(OUT, 'mounts.json'), JSON.stringify({
  planes: planes.map(frame),
  liveries: Object.fromEntries(Object.entries(LIVERIES).map(([k, [mark, ids]]) => [k, { mark, planes: ids }])),
  riders: Object.fromEntries(riders.map(r => [r.key, frame(r)])),
}, null, 1));
console.log(`mounts.png ${packed.w}×${packed.h}: ${planes.length} planes in ${Object.keys(LIVERIES).length} liveries, ${riders.length} riders`);
