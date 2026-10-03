'use strict';
// Cuts the hill and mountain sprites (docs/TERRAIN.md, "How it looks") out of the user's two sheets into one atlas.
// Usage: node scripts/build-terrain.js "rob assets"
//   reads Mountains.png and Hills.png (transparent background, sprites laid out loosely in rows)
// Output: public/assets/terrain.png and public/assets/terrain.json:
//   { mountains: [frame], hills: [frame] }, frame = { x, y, w, h, ax, ay, snow, green, rock, warm }
//   ax / ay: the anchor (the middle of the sprite's foot) as fractions of the frame; snow / green / rock: the share of
//   its pixels that are snow, vegetation and bare rock or earth, so the map can put the snowy ones on the high tops;
//   warm: how brown its rock is (mean (red − blue) / 255), so neighbouring peaks can share a colour.
// The sprites touch here and there on the sheets (snowy feet, slivers), so they are found on the solid pixels shrunk
// by 4 px, and every pixel then goes back to the sprite it is nearest to (grown outward from the shrunk shapes).
const fs = require('node:fs');
const path = require('node:path');
const P = require('./png');

const dir = process.argv[2];
if (!dir) { console.error('Usage: node scripts/build-terrain.js <folder with Mountains.png and Hills.png>'); process.exit(1); }
const OUT = path.join(__dirname, '..', 'public', 'assets');
const SCALE = 2;   // drawn at about twice the size they are ever shown
// Sprites left out, by their centre on the sheet: the blue glacier and the snow-patched hill (out of keeping), and the
// two with little figures standing on them.
const SKIP = {
  'Mountains.png': [[230, 190], [150, 1015]],
  'Hills.png': [[230, 210], [160, 987]],
};

function sprites(file) {
  const img = P.decodePng(fs.readFileSync(path.join(dir, file)));
  const { w: W, h: H, px } = img, N = W * H;
  let m = new Uint8Array(N);
  for (let i = 0; i < N; i++) m[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
  for (let k = 0; k < 4; k++) {
    const n = new Uint8Array(N);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; n[i] = m[i] && m[i - 1] && m[i + 1] && m[i - W] && m[i + W] ? 1 : 0; }
    m = n;
  }
  // Label the cores.
  const lab = new Int32Array(N), stack = new Int32Array(N), cores = [0];
  for (let s = 0; s < N; s++) {
    if (!m[s] || lab[s]) continue;
    const id = cores.length; cores.push(0);
    let sp = 0; stack[sp++] = s; lab[s] = id;
    while (sp) { const i = stack[--sp]; cores[id]++; for (const j of [i - 1, i + 1, i - W, i + W]) if (m[j] && !lab[j]) { lab[j] = id; stack[sp++] = j; } }
  }
  // Grow the big cores back over every visible pixel (breadth first, so each pixel joins the nearest core).
  const keep = new Set(cores.map((a, id) => (a > 3000 ? id : 0)).filter(Boolean));
  let front = [];
  for (let i = 0; i < N; i++) { if (lab[i] && !keep.has(lab[i])) lab[i] = 0; if (lab[i]) front.push(i); }
  while (front.length) {
    const next = [];
    for (const i of front) {
      const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j < 0 || j >= N || lab[j] || px[j * 4 + 3] < 8) continue;
        lab[j] = lab[i]; next.push(j);
      }
    }
    front = next;
  }
  const out = [];
  for (const id of keep) {
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < N; i++) if (lab[i] === id) { const x = i % W, y = (i - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    if ((SKIP[file] || []).some(([sx, sy]) => Math.hypot(sx - cx, sy - cy) < 60)) continue;
    // The sprite on its own (other sprites' pixels left out), then shrunk.
    const w = x1 - x0 + 1, h = y1 - y0 + 1, own = Buffer.alloc(w * h * 4);
    let snow = 0, green = 0, rock = 0, n = 0, warm = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y0 + y) * W + x0 + x;
      if (lab[i] !== id) continue;
      px.copy(own, (y * w + x) * 4, i * 4, i * 4 + 4);
      if (px[i * 4 + 3] < 128) continue;
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2], lo = Math.min(r, g, b), hi = Math.max(r, g, b);
      n++;
      if (lo > 185 && hi - lo < 45) snow++;
      else if (g > r + 10 && g > b + 10) green++;
      else { rock++; warm += (r - b) / 255; }
    }
    // The sheets outline every sprite with a thin light rim (a sticker edge): peel near-white pixels off the outer edge,
    // up to three px deep, so overlapping peaks in a range do not show white seams.
    for (let pass = 0; pass < 3; pass++) {
      const drop = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (!own[o + 3]) continue;
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || !own[o - 4 + 3] || !own[o + 4 + 3] || !own[o - w * 4 + 3] || !own[o + w * 4 + 3];
        if (!edge) continue;
        const r = own[o], g = own[o + 1], b = own[o + 2], lo = Math.min(r, g, b), hi = Math.max(r, g, b);
        if (lo > 170 && hi - lo < 50) drop.push(o);
        else if (own[o + 3] < 200) own[o + 3] = Math.round(own[o + 3] * 0.6);   // and soften the half-transparent fringe
      }
      for (const o of drop) own[o + 3] = 0;
    }
    const f = P.shrink({ w, h, px: own }, [0, 0, w, h], SCALE);
    // Anchor: the alpha-weighted middle of the lowest tenth of the sprite, at its bottom edge.
    let sx = 0, sa = 0, bottom = 0;
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) if (f.px[(y * f.w + x) * 4 + 3] > 64) bottom = y;
    for (let y = Math.floor(bottom - (bottom * 0.1)); y <= bottom; y++) for (let x = 0; x < f.w; x++) { const a = f.px[(y * f.w + x) * 4 + 3]; sx += x * a; sa += a; }
    out.push({ ...f, sheet: [Math.round(cx), Math.round(cy)], ax: +((sa ? sx / sa : f.w / 2) / f.w).toFixed(3), ay: +((bottom + 1) / f.h).toFixed(3),
      snow: +(snow / n).toFixed(3), green: +(green / n).toFixed(3), rock: +(rock / n).toFixed(3), warm: +(rock ? warm / rock : 0).toFixed(3) });
  }
  return out.sort((a, b) => (Math.floor(a.sheet[1] / 260) - Math.floor(b.sheet[1] / 260)) || (a.sheet[0] - b.sheet[0]));
}

const mountains = sprites('Mountains.png'), hills = sprites('Hills.png');
const packed = P.packShelves([...mountains, ...hills], 1100);
const frame = f => { const p = packed.place.find(q => q.f === f); return { x: p.x, y: p.y, w: f.w, h: f.h, ax: f.ax, ay: f.ay, snow: f.snow, green: f.green, rock: f.rock, warm: f.warm }; };
fs.writeFileSync(path.join(OUT, 'terrain.png'), P.encodePng(packed.w, packed.h, packed.px));
fs.writeFileSync(path.join(OUT, 'terrain.json'), JSON.stringify({ scale: 1 / SCALE, w: packed.w, h: packed.h, mountains: mountains.map(frame), hills: hills.map(frame) }, null, 1));
console.log(`terrain.png ${packed.w}×${packed.h}: ${mountains.length} mountains, ${hills.length} hills`);
for (const [k, list] of [['mountains', mountains], ['hills', hills]]) console.log(k, list.map(f => `${f.sheet} ${f.w}×${f.h} snow ${f.snow} green ${f.green} warm ${f.warm}`).join('\n  '));
