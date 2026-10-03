'use strict';
// Builds the bundled elevation grid (public/earth/terrain.bin.gz) for hills and mountains (public/js/terrain.js).
// Source: NASA Earth Observatory, Blue Marble Next Generation topography, gebco_08_rev_elev_5400x2700.tif
// (https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/topography-bathymetry-maps):
// "Imagery by Jesse Allen, NASA's Earth Observatory, using data from the General Bathymetric Chart of the
// Oceans (GEBCO) produced by the British Oceanographic Data Centre." Public domain.
// An uncompressed 8-bit equirectangular GeoTIFF, 5400 × 2700 (1/15°, about 7.4 km a cell at the equator), land
// elevation scaled 0..255 = 0..6400 m, the sea 0.
// Usage: node scripts/prepare-terrain.js path/to/gebco_08_rev_elev_5400x2700.tif
// Output: "WOET", u16 width, u16 height (little-endian), then width × height bytes, row by row from 90° N
// and 180° W, gzipped.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/prepare-terrain.js gebco_08_rev_elev_5400x2700.tif'); process.exit(1); }
const b = fs.readFileSync(file);
const le = b.toString('ascii', 0, 2) === 'II';
const u16 = o => (le ? b.readUInt16LE(o) : b.readUInt16BE(o)), u32 = o => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
const tags = {};
const ifd = u32(4);
for (let i = 0, n = u16(ifd); i < n; i++) {
  const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
  const size = type === 3 ? 2 : 4, at = count * size > 4 ? u32(e + 8) : e + 8;
  tags[tag] = Array.from({ length: count }, (_, k) => (type === 3 ? u16(at + k * 2) : u32(at + k * 4)));
}
const W = tags[256][0], H = tags[257][0];
if (tags[258][0] !== 8 || tags[259][0] !== 1 || (tags[277] || [1])[0] !== 1) throw new Error('Expected an uncompressed 8-bit single-band TIFF');
const offsets = tags[273], counts = tags[279];
const data = Buffer.alloc(W * H);
let pos = 0;
for (let s = 0; s < offsets.length; s++) { b.copy(data, pos, offsets[s], offsets[s] + counts[s]); pos += counts[s]; }
if (pos !== W * H) throw new Error(`Read ${pos} bytes, expected ${W * H}`);
const head = Buffer.alloc(8);
head.write('WOET', 0, 'ascii'); head.writeUInt16LE(W, 4); head.writeUInt16LE(H, 6);
const out = path.join(__dirname, '..', 'public', 'earth', 'terrain.bin.gz');
fs.writeFileSync(out, zlib.gzipSync(Buffer.concat([head, data]), { level: 9 }));
console.log(`${W} × ${H} → ${out} (${(fs.statSync(out).size / 1e6).toFixed(2)} MB)`);
