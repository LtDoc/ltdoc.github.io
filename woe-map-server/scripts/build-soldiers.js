'use strict';
// Cuts the infantry figures out of the soldier sheet into a small atlas for the battle skirmishers
// (docs/UNITS.md, "Riflemen in a firefight").
// Usage: node scripts/build-soldiers.js "rob assets/soldier+sprites.png"
// Output: public/assets/soldiers.png and public/assets/soldiers.json
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const src = process.argv[2];
if (!src) { console.error('Usage: node scripts/build-soldiers.js <soldier sheet .png>'); process.exit(1); }
const OUT = path.join(__dirname, '..', 'public', 'assets');
const SCALE = 4;   // shrink factor: the figures are drawn ~16 px tall on the map, so a quarter is plenty

// Where each figure sits on the 2500 × 1826 source sheet: [x, y, w, h] boxes (several boxes are joined,
// e.g. a fallen soldier and his helmet). Four uniforms: beige (khaki), green (olive), grey (blue-grey field
// uniform) and assault (armoured stormtroopers, bottom right). Top-down poses: aim (rifle levelled), up (rifle
// held upright: advancing or running), crawl, hands (surrender); front views: back, stand, wounded, dead.
const SETS = {
  beige: { aim: [[19, 90, 237, 218]], up: [[314, 80, 191, 237]], crawl: [[537, 118, 238, 199]], hands: [[808, 71, 238, 237]], bayonet: [[1101, 30, 176, 317]],
    back: [[103, 347, 239, 548]], stand: [[342, 430, 245, 458]], wounded: [[616, 428, 252, 460]], dead: [[891, 396, 303, 480]] },
  green: { aim: [[1351, 58, 237, 223]], up: [[1638, 25, 211, 252]], hands: [[1876, 24, 238, 253]], crawl: [[2140, 58, 243, 202]],
    back: [[1351, 337, 216, 547]], stand: [[1632, 410, 254, 451]], wounded: [[1906, 407, 253, 446]], dead: [[2184, 430, 285, 452], [2333, 407, 87, 82]] },
  grey: { aim: [[78, 979, 238, 213]], up: [[367, 956, 200, 236]], hands: [[603, 955, 238, 237]], crawl: [[876, 994, 226, 198]],
    dead: [[85, 1367, 286, 436], [248, 1350, 115, 58]], stand: [[370, 1329, 263, 478]], wounded: [[632, 1338, 263, 478]], back: [[894, 1276, 217, 531]] },
  assault: { aim: [[1336, 971, 252, 230]], up: [[1628, 918, 194, 277]], hands: [[1859, 955, 237, 240]], crawl: [[2130, 997, 239, 198]],
    back: [[1320, 1209, 219, 560]], stand: [[1562, 1321, 246, 445]], wounded: [[1831, 1321, 253, 448]], dead: [[2108, 1322, 284, 447], [2248, 1291, 90, 87]] },
};

// ---- PNG in and out (8-bit RGBA, non-interlaced) ---------------------------------------------------
function decodePng(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), depth = buf[24], ct = buf[25];
  if (depth !== 8 || ct !== 6 || buf[28] !== 0) throw new Error('expected an 8-bit RGBA PNG');
  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * 4, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], s = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride), prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0, b = prev ? prev[i] : 0, c = prev && i >= 4 ? prev[i - 4] : 0;
      let v = s[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
  }
  return { w, h, px };
}
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, px) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Cut, shrink, pack ------------------------------------------------------------------------------
const img = decodePng(fs.readFileSync(src));
// Label the opaque blobs so a figure's box never picks up a piece of its neighbour (a rifle poking in).
const { w: W, h: H, px } = img;
const label = new Int32Array(W * H), area = [0];
{
  const stack = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (px[s * 4 + 3] < 24 || label[s]) continue;
    const id = area.length; area.push(0);
    let sp = 0; stack[sp++] = s; label[s] = id;
    while (sp) {
      const i = stack[--sp], x = i % W, y = (i - x) / W; area[id]++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
        const j = yy * W + xx; if (px[j * 4 + 3] >= 24 && !label[j]) { label[j] = id; stack[sp++] = j; }
      }
    }
  }
}
const BIG = 3000;   // blobs this size are figures (or helmets); smaller ones are blood drops and specks
function cut(boxes) {
  const x0 = Math.min(...boxes.map(b => b[0])) - 4, y0 = Math.min(...boxes.map(b => b[1])) - 4;
  const x1 = Math.max(...boxes.map(b => b[0] + b[2])) + 4, y1 = Math.max(...boxes.map(b => b[1] + b[3])) + 4;
  // The figure's own big blobs: those whose pixels fall inside its boxes' centres.
  const own = new Set();
  for (const [bx, by, bw, bh] of boxes) for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
    const l = label[y * W + x]; if (l && area[l] >= BIG) own.add(l);
  }
  // Keep the largest own blob per box (the figure) plus every small speck; drop other figures' pieces.
  const sw = Math.ceil((x1 - x0) / SCALE), sh = Math.ceil((y1 - y0) / SCALE), out = Buffer.alloc(sw * sh * 4);
  let cx = 0, cy = 0, ca = 0;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let yy = 0; yy < SCALE; yy++) for (let xx = 0; xx < SCALE; xx++) {
      const X = x0 + x * SCALE + xx, Y = y0 + y * SCALE + yy;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const i = Y * W + X, l = label[i];
      if (!l || (area[l] >= BIG && !own.has(l))) continue;
      const al = px[i * 4 + 3];
      r += px[i * 4] * al; g += px[i * 4 + 1] * al; b += px[i * 4 + 2] * al; a += al;
    }
    const o = (y * sw + x) * 4;
    if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); out[o + 3] = Math.round(a / (SCALE * SCALE)); }
    cx += x * out[o + 3]; cy += y * out[o + 3]; ca += out[o + 3];
  }
  return { w: sw, h: sh, px: out, cx: ca ? cx / ca : sw / 2, cy: ca ? cy / ca : sh / 2 };
}
const frames = {}, rows = [];
for (const [set, poses] of Object.entries(SETS)) {
  const row = [];
  for (const [pose, boxes] of Object.entries(poses)) row.push({ set, pose, ...cut(boxes) });
  rows.push(row);
}
const GAP = 2;
const sheetW = Math.max(...rows.map(r => r.reduce((s, f) => s + f.w + GAP, GAP)));
const sheetH = rows.reduce((s, r) => s + Math.max(...r.map(f => f.h)) + GAP, GAP);
const sheet = Buffer.alloc(sheetW * sheetH * 4);
let y = GAP;
for (const row of rows) {
  let x = GAP;
  for (const f of row) {
    for (let yy = 0; yy < f.h; yy++) f.px.copy(sheet, ((y + yy) * sheetW + x) * 4, yy * f.w * 4, (yy + 1) * f.w * 4);
    (frames[f.set] = frames[f.set] || {})[f.pose] = { x, y, w: f.w, h: f.h, ax: +(f.cx / f.w).toFixed(3), ay: +(f.cy / f.h).toFixed(3) };
    x += f.w + GAP;
  }
  y += Math.max(...row.map(f => f.h)) + GAP;
}
fs.writeFileSync(path.join(OUT, 'soldiers.png'), encodePng(sheetW, sheetH, sheet));
fs.writeFileSync(path.join(OUT, 'soldiers.json'), JSON.stringify({ source: path.basename(src), scale: 1 / SCALE, w: sheetW, h: sheetH, frames }, null, 1));
console.log(`soldiers.png ${sheetW}×${sheetH}, ${rows.flat().length} figures`);
