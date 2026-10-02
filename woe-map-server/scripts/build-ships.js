'use strict';
// Cuts the warships and merchantmen for the sea fights (docs/UNITS.md, "Ships in a fight") out of the user's art into
// one atlas. The ships are drawn in profile, seen a little from above, bow to the right.
// Usage: node scripts/build-ships.js "rob assets"
// Output: public/assets/ships.png and public/assets/ships.json
const fs = require('node:fs');
const path = require('node:path');
const P = require('./png');

const dir = process.argv[2];
if (!dir) { console.error('Usage: node scripts/build-ships.js <folder with Battleship.png, DestroyerSprites.png, ...>'); process.exit(1); }
const OUT = path.join(__dirname, '..', 'public', 'assets');
const SCALE = 2;   // drawn at about twice the size they are ever shown

// Each class: its file, and the rows and columns of ships it holds (sheets hold variants: one per nation for warships,
// a mix of freighters for a convoy). Gunboat.png, Minelayer.png and TorpedoBoat.png are one picture: the small
// craft share it.
const CLASSES = {
  battleship: ['Battleship.png', 1], predreadnought: ['Predreadnought.png', 1], battlecruiser: ['Battlecruiser.png', 1],
  armouredcruiser: ['ArmouredCruiser.png', 1], lightcruiser: ['LightCruiser.png', 1],
  destroyer: ['DestroyerSprites.png', 16], submarine: ['SubSprites.png', 2, 4], smallcraft: ['TorpedoBoat.png', 6], merchant: ['CargoConvoy.png', 16],
};

/**
 * The ships on a sheet laid out in a grid of `rows` × `cols` cells: each cell's edges are moved to the emptiest
 * line near where they should be (where a mast reaches across it, its tip is cut off), then trimmed to the ship. Returns boxes in reading order.
 */
function ships(img, rows, cols) {
  const { w, h, px } = img, op = (x, y) => px[(y * w + x) * 4 + 3] > 24;
  const cuts = (n, len, count) => {
    const out = [0], pitch = len / n;
    for (let k = 1; k < n; k++) {
      let best = Infinity, at = Math.round(k * pitch);
      for (let p = Math.round(k * pitch - pitch * 0.3); p <= k * pitch + pitch * 0.3; p++) { const c = count(p); if (c < best) { best = c; at = p; } }
      out.push(at);
    }
    out.push(len);
    return out;
  };
  const rowCount = y => { let c = 0; for (let x = 0; x < w; x++) if (op(x, y)) c++; return c; };
  const ys = cuts(rows, h, rowCount), boxes = [];
  for (let r = 0; r < rows; r++) {
    const colCount = x => { let c = 0; for (let y = ys[r]; y < ys[r + 1]; y++) if (op(x, y)) c++; return c; };
    const xs = cuts(cols, w, colCount);
    for (let c = 0; c < cols; c++) {
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      for (let y = ys[r]; y < ys[r + 1]; y++) for (let x = xs[c]; x < xs[c + 1]; x++) if (op(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      if (x1 < 0) throw new Error('empty cell');
      boxes.push([x0, y0, x1 - x0 + 1, y1 - y0 + 1]);
    }
  }
  return boxes;
}

// Pixels of a sheet outside one box are left out of its cut (another ship's mast tip).
function only(img, b) {
  const px = Buffer.alloc(img.px.length);
  for (let y = b[1]; y < b[1] + b[3]; y++) img.px.copy(px, (y * img.w + b[0]) * 4, (y * img.w + b[0]) * 4, (y * img.w + b[0] + b[2]) * 4);
  return { w: img.w, h: img.h, px };
}

const frames = {}, all = [];
for (const [cls, [file, rows, cols = 1]] of Object.entries(CLASSES)) {
  const img = P.decodePng(fs.readFileSync(path.join(dir, file)));
  frames[cls] = ships(img, rows, cols).map(b => { const f = { ...P.shrink(only(img, b), b, SCALE), cls }; all.push(f); return f; });
}
const packed = P.packShelves(all, 1024);
const out = f => {
  const p = packed.place.find(q => q.f === f);
  // Pivot: the middle of the hull at the waterline (about a fifth up from the keel).
  return [p.x, p.y, f.w, f.h, 0.5, +((f.h - f.oy - (f.h - 2 * f.oy) * 0.2) / f.h).toFixed(3)];
};
fs.writeFileSync(path.join(OUT, 'ships.png'), P.encodePng(packed.w, packed.h, packed.px));
fs.writeFileSync(path.join(OUT, 'ships.json'), JSON.stringify({
  // [x, y, w, h, pivot x, pivot y]; bow to the right
  classes: Object.fromEntries(Object.entries(frames).map(([k, l]) => [k, l.map(out)])),
}));
console.log(`ships.png ${packed.w}×${packed.h}: ${all.length} ships`);
