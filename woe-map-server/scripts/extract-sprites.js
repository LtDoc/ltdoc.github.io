'use strict';
// Builds the sprite atlas from irregular pixel-art sheets (no fixed grid needed).
// Every connected blob of opaque pixels becomes a sprite; large tile-based blobs are also cut into 96 px cells.
// Usage: node scripts/extract-sprites.js "<folder with sheets>"
// Output: public/sprites/<sheetId>.png (copies) and public/sprites/atlas.json
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const src = process.argv[2];
if (!src) { console.error('Usage: node scripts/extract-sprites.js <folder>'); process.exit(1); }
const out = path.join(__dirname, '..', 'public', 'sprites');
fs.mkdirSync(out, { recursive: true });

// ---- Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) ------------------------------------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), depth = buf[24], ct = buf[25], il = buf[28];
  if (depth !== 8 || il !== 0 || ![2, 6].includes(ct)) throw new Error(`unsupported PNG (depth ${depth}, type ${ct}, interlace ${il})`);
  const bpp = ct === 6 ? 4 : 3;
  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const s = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev ? prev[i] : 0, c = (prev && i >= bpp) ? prev[i - bpp] : 0;
      let v = s[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
  }
  return { w, h, bpp, px };
}

// ---- Sprite detection ---------------------------------------------------------------------------
function findSprites(img, { alphaMin = 24, minSize = 6, minArea = 40, cell = 96, bigBlob = 190, fragmentArea = 220, gap = 3 } = {}) {
  const { w, h, bpp, px } = img;
  const mask = new Uint8Array(w * h);
  if (bpp === 4) for (let i = 0; i < w * h; i++) mask[i] = px[i * 4 + 3] >= alphaMin ? 1 : 0;
  else mask.fill(1);

  // 1. Exact 8-connected components.
  const label = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || label[start]) continue;
    const id = comps.length + 1;
    let sp = 0; stack[sp++] = start; label[start] = id;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (mask[j] && !label[j]) { label[j] = id; stack[sp++] = j; }
      }
    }
    comps.push({ x0, y0, x1, y1, area, alive: true });
  }

  // 2. Small fragments (a detached wheel, a gun barrel, a stray pixel cluster) join the nearest
  //    component whose box they touch within `gap` px. Big sprites never merge with each other.
  const near = (a, b) => !(a.x0 > b.x1 + gap || b.x0 > a.x1 + gap || a.y0 > b.y1 + gap || b.y0 > a.y1 + gap);
  for (let round = 0; round < 3; round++) {
    let merged = 0;
    for (const f of comps) {
      if (!f.alive || f.area >= fragmentArea) continue;
      let best = null, bestScore = Infinity;
      for (const c of comps) {
        if (c === f || !c.alive || !near(f, c)) continue;
        const score = -c.area; // prefer the largest neighbour
        if (score < bestScore) { bestScore = score; best = c; }
      }
      if (best) {
        best.x0 = Math.min(best.x0, f.x0); best.y0 = Math.min(best.y0, f.y0);
        best.x1 = Math.max(best.x1, f.x1); best.y1 = Math.max(best.y1, f.y1);
        best.area += f.area; f.alive = false; merged++;
      }
    }
    if (!merged) break;
  }

  const sprites = [];
  for (const c of comps) {
    if (!c.alive) continue;
    const x0 = c.x0, y0 = c.y0, x1 = c.x1, y1 = c.y1, area = c.area;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw < minSize || bh < minSize || area < minArea) continue;
    sprites.push({ x: x0, y: y0, w: bw, h: bh, area });
    // Tile-based blobs (trench networks, terrain squares) also become grid cells.
    if (bw >= bigBlob && bh >= bigBlob) {
      const cx0 = Math.floor(x0 / cell) * cell, cy0 = Math.floor(y0 / cell) * cell;
      for (let cy = cy0; cy <= y1; cy += cell) for (let cx = cx0; cx <= x1; cx += cell) {
        let filled = 0;
        for (let yy = cy; yy < Math.min(cy + cell, h); yy++) for (let xx = cx; xx < Math.min(cx + cell, w); xx++) if (mask[yy * w + xx]) filled++;
        if (filled >= cell * cell * 0.08) sprites.push({ x: cx, y: cy, w: Math.min(cell, w - cx), h: Math.min(cell, h - cy), area: filled, tile: true });
      }
    }
  }
  sprites.sort((a, b) => (a.tile - b.tile) || (Math.floor(a.y / 48) - Math.floor(b.y / 48)) || (a.x - b.x));
  return sprites;
}

// ---- Walk the source folder --------------------------------------------------------------------
const CATS = [
  [/army/i, 'army', 'Army'],
  [/naval/i, 'naval', 'Naval'],
  [/map/i, 'map', 'Map & terrain'],
  [/./, 'misc', 'Equipment & misc'],
];
const files = [];
(function walk(dir) {
  for (const n of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.png$/i.test(n)) files.push(p);
  }
})(src);

const counters = {};
const sheets = [];
for (const file of files) {
  const rel = path.relative(src, file).replace(/\\/g, '/');
  const folder = rel.includes('/') ? rel.split('/')[0] : '';
  const [, cat, catLabel] = CATS.find(([re]) => re.test(folder || 'misc'));
  counters[cat] = (counters[cat] || 0) + 1;
  const id = `${cat}-${String(counters[cat]).padStart(2, '0')}`;
  const buf = fs.readFileSync(file);
  const img = decodePng(buf);
  const sprites = findSprites(img);
  fs.writeFileSync(path.join(out, `${id}.png`), buf);
  sheets.push({
    id, file: `/sprites/${id}.png`, category: cat, categoryLabel: catLabel,
    label: `${catLabel} ${counters[cat]}`, source: rel, w: img.w, h: img.h,
    sprites: sprites.map((s, i) => ({ n: i, x: s.x, y: s.y, w: s.w, h: s.h, ...(s.tile ? { tile: 1 } : {}) })),
  });
  console.log(`${id.padEnd(9)} ${rel.padEnd(36)} ${sprites.filter(s => !s.tile).length} sprites, ${sprites.filter(s => s.tile).length} tiles`);
}
fs.writeFileSync(path.join(out, 'atlas.json'), JSON.stringify({ generated: new Date().toISOString(), sheets }));
const total = sheets.reduce((a, s) => a + s.sprites.length, 0);
console.log(`Wrote ${sheets.length} sheets, ${total} sprites to ${out}`);
