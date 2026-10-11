'use strict';
// Shrinks the supply wagon for the battle scenes (docs/UNITS.md, "Supply columns") out of the user's art: a wagon
// loaded with crates, two drivers and a pair of horses, drawn from above with the horses to the right.
// Usage: node scripts/build-wagon.js "rob assets/SupplyWagon.png"
// Output: public/assets/wagon.png (trimmed, WIDTH px wide; the middle of the picture is where it pivots)
const fs = require('node:fs');
const path = require('node:path');
const P = require('./png');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/build-wagon.js <SupplyWagon.png>'); process.exit(1); }
const WIDTH = 320;   // px across in the atlas: about twice its widest on screen, close up

const img = P.decodePng(fs.readFileSync(file));
let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
  if (img.px[(y * img.w + x) * 4 + 3] < 24) continue;
  if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
}
const box = [x0, y0, x1 - x0 + 1, y1 - y0 + 1], out = P.shrink(img, box, box[2] / (WIDTH - 4));
fs.writeFileSync(path.join(__dirname, '..', 'public', 'assets', 'wagon.png'), P.encodePng(out.w, out.h, out.px));
console.log(`wagon.png ${out.w}×${out.h}`);
