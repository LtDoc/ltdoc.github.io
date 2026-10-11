'use strict';
// Cuts the war machines for the battle scenes (docs/UNITS.md, "Crews, guns and tanks in a fight") out of the user's
// art into one small atlas: the 20 tanks of the tank sheet and one gun per artillery or machine-gun type.
// Usage: node scripts/build-machines.js "rob assets"
// Output: public/assets/machines.png and public/assets/machines.json
const fs = require('node:fs');
const path = require('node:path');
const P = require('./png');

const dir = process.argv[2];
if (!dir) { console.error('Usage: node scripts/build-machines.js <folder with Tank.png, FieldArtillery.png, ...>'); process.exit(1); }
const OUT = path.join(__dirname, '..', 'public', 'assets');
const SCALE = 2;   // the art is drawn at about twice the size it is ever shown

// Guns: file, and whether it is drawn from above (barrel up) or from the side (barrel to the left); optionally how much
// to shrink it (default SCALE) and 'right' for art drawn from above with the barrels pointing right (turned barrel-up).
const GUNS = {
  field: ['FieldArtillery.png', 'top'],
  heavy: ['HeavyArtilleryBattery.png', 'top'],
  siege: ['SiegeBattery.png', 'top'],
  mortar: ['TrenchMortarBattery.png', 'top'],
  horse: ['HorseArtilleryBattery.png', 'side'],
  hmg: ['HeavyMG.png', 'side'],
  coastal: ['CoastalTurret.png', 'top', 4, 'right', 'ring'],   // a twin-gun turret in its concrete ring, turning on its centre
};

/** The centre of a turret's ring (the widest rows of the frame), as fractions of the frame: where it pivots. */
function ringCentre(f) {
  const rows = [];
  let best = 0;
  for (let y = 0; y < f.h; y++) {
    let x0 = -1, x1 = -1;
    for (let x = 0; x < f.w; x++) if (f.px[(y * f.w + x) * 4 + 3] > 60) { if (x0 < 0) x0 = x; x1 = x; }
    const w = x0 < 0 ? 0 : x1 - x0 + 1;
    rows.push([y, x0, x1, w]); best = Math.max(best, w);
  }
  const top = rows.filter(r => r[3] >= best * 0.98);
  const cx = top.reduce((a, r) => a + (r[1] + r[2] + 1) / 2, 0) / top.length, cy = top.reduce((a, r) => a + r[0], 0) / top.length + 0.5;
  return [cx, cy];
}

/** Turn a cut frame a quarter turn anticlockwise (barrels pointing right → pointing up). */
function turnLeft(f) {
  const out = Buffer.alloc(f.w * f.h * 4);
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    const s = (y * f.w + x) * 4, d = ((f.w - 1 - x) * f.h + y) * 4;
    out[d] = f.px[s]; out[d + 1] = f.px[s + 1]; out[d + 2] = f.px[s + 2]; out[d + 3] = f.px[s + 3];
  }
  return { w: f.h, h: f.w, px: out, cx: f.cy, cy: f.w - 1 - f.cx };
}

/** Where the muzzle is, as fractions of the frame: the top of the barrel (from above) or its left end (from the side). */
function muzzle(f, view) {
  const a = (x, y) => f.px[(y * f.w + x) * 4 + 3] > 60;
  if (view === 'top') {
    for (let y = 0; y < f.h; y++) { let sx = 0, n = 0; for (let x = 0; x < f.w; x++) if (a(x, y)) { sx += x; n++; } if (n) return [+(sx / n / f.w).toFixed(3), +(y / f.h).toFixed(3)]; }
  } else {
    for (let x = 0; x < f.w; x++) { let sy = 0, n = 0; for (let y = 0; y < f.h; y++) if (a(x, y)) { sy += y; n++; } if (n) return [+(x / f.w).toFixed(3), +(sy / n / f.h).toFixed(3)]; }
  }
  return [0.5, 0.5];
}

// Tanks: every big blob on the sheet, in reading order (rows of about 100 px). They face left.
const sheet = P.decodePng(fs.readFileSync(path.join(dir, 'Tank.png')));
const lab = P.blobs(sheet);
const tankBoxes = lab.boxes.map((b, i) => ({ b, a: lab.area[i] })).filter(t => t.b && t.a > 1500)
  .sort((p, q) => (Math.floor(p.b[1] / 90) - Math.floor(q.b[1] / 90)) || (p.b[0] - q.b[0])).map(t => t.b);
const tanks = tankBoxes.map(b => ({ ...P.cut(sheet, [b], SCALE, lab), view: 'side' }));
tanks.forEach(t => { t.muzzle = muzzle(t, 'side'); });

const guns = Object.entries(GUNS).map(([key, [file, view, scale = SCALE, facing, pivot]]) => {
  const img = P.decodePng(fs.readFileSync(path.join(dir, file)));
  const l = P.blobs(img);
  const boxes = l.boxes.filter((b, i) => b && l.area[i] > 40);
  let cut = P.cut(img, boxes, scale);
  if (facing === 'right') cut = turnLeft(cut);
  if (pivot === 'ring') [cut.cx, cut.cy] = ringCentre(cut);
  const f = { ...cut, key, view };
  f.muzzle = muzzle(f, view);
  return f;
});

const packed = P.pack([tanks.slice(0, 10), tanks.slice(10), guns]);
const frame = f => { const p = packed.place.find(q => q.f === f); return { x: p.x, y: p.y, w: f.w, h: f.h, ax: +(f.cx / f.w).toFixed(3), ay: +(f.cy / f.h).toFixed(3), view: f.view, muzzle: f.muzzle }; };
fs.writeFileSync(path.join(OUT, 'machines.png'), P.encodePng(packed.w, packed.h, packed.px));
fs.writeFileSync(path.join(OUT, 'machines.json'), JSON.stringify({ scale: 1 / SCALE, w: packed.w, h: packed.h,
  tanks: tanks.map(frame), guns: Object.fromEntries(guns.map(g => [g.key, frame(g)])) }, null, 1));
console.log(`machines.png ${packed.w}×${packed.h}: ${tanks.length} tanks, ${guns.length} guns`);
