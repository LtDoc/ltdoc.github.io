'use strict';
// Packs the main menu's icons (docs/UI.md, "Main menu") out of the user's art: one picture per rail button, each
// trimmed, centred in a square cell and shrunk, side by side in rail order. CSS picks a cell with --n (app.css, ".ti").
// Usage: node scripts/build-tabs.js "rob assets/Tab Icons"
// Output: public/assets/tabs.png (CELL px high, CELL px a cell)
const fs = require('node:fs');
const path = require('node:path');
const P = require('./png');

const dir = process.argv[2];
if (!dir) { console.error('Usage: node scripts/build-tabs.js <Tab Icons folder>'); process.exit(1); }
const CELL = 96;   // three times the 32 px it shows at on the rail
// Rail order: the n each button's <i class="ti"> carries in map.html.
const ICONS = [
  ['nation', 'National flag over map.png'],
  ['production', 'Pixel factory production icon.png'],
  ['research', 'Blue-violet discovery flask icon.png'],
  ['diplomacy', 'Diplomacy handshake icon.png'],
  ['map', 'Folded map with marked route.png'],
  ['place', 'Place Unit on Map.png'],
  ['people', 'WWI Troops Beneath a Split Flag.png'],
  ['log', 'Open field logbook.png'],
  ['history', 'Antique Chronicle Book with Timeline Clock.png'],
  ['gm', 'WWI Staff Officer Game Master.png'],
  ['rules', 'Pixel field manual with checklist.png'],
];

const W = CELL * ICONS.length, sheet = Buffer.alloc(W * CELL * 4);
ICONS.forEach(([name, file], n) => {
  const img = P.decodePng(fs.readFileSync(path.join(dir, file)));
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    if (img.px[(y * img.w + x) * 4 + 3] < 24) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, side = Math.max(bw, bh);
  // The square around the picture's middle, so the shrink fills the cell along its longer side.
  const box = [x0 - (side - bw) / 2, y0 - (side - bh) / 2, side, side], out = P.shrink(img, box, side / (CELL - 4));
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const sx = x - (CELL - out.w) / 2 | 0, sy = y - (CELL - out.h) / 2 | 0;
    if (sx < 0 || sy < 0 || sx >= out.w || sy >= out.h) continue;
    out.px.copy(sheet, (y * W + n * CELL + x) * 4, (sy * out.w + sx) * 4, (sy * out.w + sx) * 4 + 4);
  }
  console.log(n, name, `${bw}×${bh}`);
});
fs.writeFileSync(path.join(__dirname, '..', 'public', 'assets', 'tabs.png'), P.encodePng(W, CELL, sheet));
console.log(`tabs.png ${W}×${CELL}`);
