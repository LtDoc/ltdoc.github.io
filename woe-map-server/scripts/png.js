'use strict';
// Minimal PNG tools for the sprite build scripts (8-bit RGBA, non-interlaced): decode, encode, find the opaque
// blobs on a sheet, and cut a box out of a sheet shrunk by an integer factor (premultiplied box filter).
const zlib = require('node:zlib');

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

/** Label the opaque blobs (8-connected, alpha ≥ 24). Returns { label, area, boxes } (index 0 unused). */
function blobs(img) {
  const { w: W, h: H, px } = img;
  const label = new Int32Array(W * H), area = [0], boxes = [null], stack = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (px[s * 4 + 3] < 24 || label[s]) continue;
    const id = area.length; area.push(0);
    let x0 = W, y0 = H, x1 = -1, y1 = -1, sp = 0;
    stack[sp++] = s; label[s] = id;
    while (sp) {
      const i = stack[--sp], x = i % W, y = (i - x) / W; area[id]++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
        const j = yy * W + xx; if (px[j * 4 + 3] >= 24 && !label[j]) { label[j] = id; stack[sp++] = j; }
      }
    }
    boxes.push([x0, y0, x1 - x0 + 1, y1 - y0 + 1]);
  }
  return { label, area, boxes };
}

/**
 * Cut the box [x, y, w, h] (padded by 4) out of a sheet, shrunk `scale` times. With `lab`, pixels of other big blobs
 * (≥ big px) are left out, so a neighbour's rifle or gun barrel poking into the box is not copied.
 * Returns { w, h, px, cx, cy } (cx, cy: the alpha-weighted centre, in output px).
 */
function cut(img, boxes, scale, lab = null, big = 3000) {
  const { w: W, h: H, px } = img;
  const x0 = Math.min(...boxes.map(b => b[0])) - 4, y0 = Math.min(...boxes.map(b => b[1])) - 4;
  const x1 = Math.max(...boxes.map(b => b[0] + b[2])) + 4, y1 = Math.max(...boxes.map(b => b[1] + b[3])) + 4;
  const own = new Set();
  if (lab) for (const [bx, by, bw, bh] of boxes) for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
    const l = lab.label[y * W + x]; if (l && lab.area[l] >= big) own.add(l);
  }
  const sw = Math.ceil((x1 - x0) / scale), sh = Math.ceil((y1 - y0) / scale), out = Buffer.alloc(sw * sh * 4);
  let cx = 0, cy = 0, ca = 0;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) {
      const X = x0 + x * scale + xx, Y = y0 + y * scale + yy;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const i = Y * W + X;
      if (lab) { const l = lab.label[i]; if (!l || (lab.area[l] >= big && !own.has(l))) continue; }
      const al = px[i * 4 + 3];
      r += px[i * 4] * al; g += px[i * 4 + 1] * al; b += px[i * 4 + 2] * al; a += al;
    }
    const o = (y * sw + x) * 4;
    if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); out[o + 3] = Math.round(a / (scale * scale)); }
    cx += x * out[o + 3]; cy += y * out[o + 3]; ca += out[o + 3];
  }
  return { w: sw, h: sh, px: out, cx: ca ? cx / ca : sw / 2, cy: ca ? cy / ca : sh / 2 };
}

/**
 * Cut the box [x, y, w, h] out of an image, shrunk by any factor `k` (> 1: output px = input px / k), averaging
 * the covered area (premultiplied), with a 2 px transparent margin. Returns { w, h, px, ox, oy } where (ox, oy) is
 * where the box's top-left corner lands in the output (to map points across: out = (in - box) / k + o).
 */
function shrink(img, box, k) {
  const { w: W, h: H, px } = img, [bx, by, bw, bh] = box, M = 2;
  const sw = Math.ceil(bw / k) + 2 * M, sh = Math.ceil(bh / k) + 2 * M, out = Buffer.alloc(sw * sh * 4);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const x0 = bx + (x - M) * k, y0 = by + (y - M) * k, x1 = x0 + k, y1 = y0 + k;
    let r = 0, g = 0, b = 0, a = 0;
    for (let Y = Math.max(0, Math.floor(y0)); Y < Math.min(H, Math.ceil(y1)); Y++) {
      const wy = Math.min(Y + 1, y1) - Math.max(Y, y0);
      for (let X = Math.max(0, Math.floor(x0)); X < Math.min(W, Math.ceil(x1)); X++) {
        const wgt = (Math.min(X + 1, x1) - Math.max(X, x0)) * wy, i = (Y * W + X) * 4, al = px[i + 3] * wgt;
        r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al;
      }
    }
    const o = (y * sw + x) * 4;
    if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); out[o + 3] = Math.min(255, Math.round(a / (k * k))); }
  }
  return { w: sw, h: sh, px: out, ox: M, oy: M };
}

/** Pack frames ({ w, h, px, ... }) into rows on one sheet; returns { w, h, px, place: [{ x, y }] }. */
function pack(rows, gap = 2) {
  const W = Math.max(...rows.map(r => r.reduce((s, f) => s + f.w + gap, gap)));
  const H = rows.reduce((s, r) => s + Math.max(...r.map(f => f.h)) + gap, gap);
  const px = Buffer.alloc(W * H * 4), place = [];
  let y = gap;
  for (const row of rows) {
    let x = gap;
    for (const f of row) {
      for (let yy = 0; yy < f.h; yy++) f.px.copy(px, ((y + yy) * W + x) * 4, yy * f.w * 4, (yy + 1) * f.w * 4);
      place.push({ f, x, y });
      x += f.w + gap;
    }
    y += Math.max(...row.map(f => f.h)) + gap;
  }
  return { w: W, h: H, px, place };
}

/** Pack frames into a sheet about `width` px wide, tallest first, in shelves. Same result shape as pack(). */
function packShelves(frames, width, gap = 2) {
  const order = [...frames].sort((a, b) => b.h - a.h), rows = [];
  let row = [], x = gap;
  for (const f of order) {
    if (row.length && x + f.w + gap > width) { rows.push(row); row = []; x = gap; }
    row.push(f); x += f.w + gap;
  }
  if (row.length) rows.push(row);
  return pack(rows, gap);
}

module.exports = { decodePng, encodePng, blobs, cut, shrink, pack, packShelves };
