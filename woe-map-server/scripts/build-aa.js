'use strict';
// Cuts the AA emplacements for the battle scenes (docs/UNITS.md, "AA emplacement") out of the user's art: the three
// twin AA guns in their sandbags and wire, each with the ammunition and wire around it (the loose crates are left out).
// Usage: node scripts/build-aa.js "rob assets/AAEmplacement.png"
// Output: public/assets/aa.png and public/assets/aa.json — frames [x, y, w, h], the anchor (where the gun stands, as
// fractions of the frame) and the two muzzles (the barrel tips, as fractions), all drawn with the barrels to the right.
const fs = require('node:fs');
const path = require('node:path');
const P = require('./png');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/build-aa.js <AAEmplacement.png>'); process.exit(1); }
const OUT = path.join(__dirname, '..', 'public', 'assets');
const SCALE = 3;          // the art is drawn at about three times the size it is shown close up
const GUN_AREA = 60000;   // blobs this big are the three guns; the rest are crates, coils and loose bits
// Measured on the art (source px), gun by gun from the top: where the gun stands (the middle of its mounting) and its
// two barrel tips. The top gun's tips are half hidden in the wire, so they are not found by looking.
const MARKS = [
  { stand: [470, 345], tips: [[637, 65], [655, 92]] },
  { stand: [960, 680], tips: [[1124, 405], [1148, 438]] },
  { stand: [465, 1100], tips: [[631, 835], [655, 868]] },
];

const img = P.decodePng(fs.readFileSync(file));
const lab = P.blobs(img);
const guns = lab.boxes.map((b, id) => ({ id, b, area: lab.area[id] })).filter(x => x.b && x.area >= GUN_AREA)
  .sort((a, b) => (a.b[1] - b.b[1]) || (a.b[0] - b.b[0]));
if (guns.length !== 3) throw new Error(`expected 3 guns, found ${guns.length}`);

const frames = guns.map(({ id, b }, k) => {
  // Only the gun's own pixels and the small bits lying inside its box (another gun's or a loose crate's are left out).
  const [bx, by, bw, bh] = b, masked = { w: img.w, h: img.h, px: Buffer.alloc(img.px.length) };
  for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
    const i = y * img.w + x, l = lab.label[i];
    if (l === id || (l && lab.area[l] < 3000)) img.px.copy(masked.px, i * 4, i * 4, i * 4 + 4);
  }
  const f = P.shrink(masked, b, SCALE);
  // Source px → fractions of the cut frame.
  const fx = x => +(((x - bx) / SCALE + f.ox) / f.w).toFixed(3), fy = y => +(((y - by) / SCALE + f.oy) / f.h).toFixed(3);
  const { stand, tips } = MARKS[k];
  return { ...f, ax: fx(stand[0]), ay: fy(stand[1]), muzzles: tips.map(([x, y]) => [fx(x), fy(y)]) };
});

const sheet = P.pack([frames]);
fs.writeFileSync(path.join(OUT, 'aa.png'), P.encodePng(sheet.w, sheet.h, sheet.px));
const meta = { frames: sheet.place.map(({ f, x, y }) => ({ x, y, w: f.w, h: f.h, ax: f.ax, ay: f.ay, muzzles: f.muzzles })) };
fs.writeFileSync(path.join(OUT, 'aa.json'), JSON.stringify(meta));
console.log(`aa.png ${sheet.w}×${sheet.h}`, JSON.stringify(meta));
