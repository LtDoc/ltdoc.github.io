'use strict';
// Builds the bundled Earth map data (public/earth/*.json.gz) from Natural Earth GeoJSON.
// Natural Earth is public domain: https://www.naturalearthdata.com/
// Usage: node scripts/prepare-earth.js [sourceDir]
//   sourceDir may contain ne_50m_land.geojson, ne_50m_lakes.geojson,
//   ne_50m_rivers_lake_centerlines.geojson and ne_50m_admin_0_boundary_lines_land.geojson
//   (from https://github.com/nvkelso/natural-earth-vector/tree/master/geojson), plus any number of
//   world_<year>.geojson files with historical political borders
//   (from https://github.com/aourednik/historical-basemaps/tree/master/geojson, e.g. world_1914.geojson).
// Properties are stripped and coordinates rounded to 0.01° (about 1 km) to keep files small.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const src = process.argv[2] || '.';
const out = path.join(__dirname, '..', 'public', 'earth');
fs.mkdirSync(out, { recursive: true });

const LAYERS = {
  land: 'ne_50m_land.geojson',
  lakes: 'ne_50m_lakes.geojson',
  rivers: 'ne_50m_rivers_lake_centerlines.geojson',
  borders: 'ne_50m_admin_0_boundary_lines_land.geojson',
};

const r2 = n => Math.round(n * 100) / 100;

function ring(coords) {
  const pts = [];
  let last = null;
  for (const c of coords) {
    const p = [r2(c[0]), r2(c[1])];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    pts.push(p); last = p;
  }
  return pts;
}

// ---- Historical political borders: world_<year>.geojson from aourednik/historical-basemaps -----------
// (https://github.com/aourednik/historical-basemaps). Each feature is a state with NAME and SUBJECTO
// (the power it belonged to, e.g. a colony's empire). We keep name, overlord and rings.
const years = [];
for (const file of fs.readdirSync(src).filter(n => /^world_(\d{3,4})\.geojson$/i.test(n)).sort()) {
  const year = file.match(/(\d{3,4})/)[1];
  const fc = JSON.parse(fs.readFileSync(path.join(src, file), 'utf8'));
  const countries = [];
  for (const f of fc.features) {
    const g = f.geometry; if (!g) continue;
    const p = f.properties || {};
    const name = String(p.NAME || p.name || '').trim();
    const subject = String(p.SUBJECTO || '').trim();
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [])
      .map(poly => poly.map(ring).filter(r => r.length >= 4)).filter(p => p.length);
    if (!polys.length) continue;
    countries.push({ n: name, s: subject && subject !== name ? subject : '', p: polys });
  }
  const json = JSON.stringify({ year, countries });
  const gz = zlib.gzipSync(json, { level: 9 });
  fs.writeFileSync(path.join(out, `world_${year}.json.gz`), gz);
  years.push(Number(year));
  console.log(`world_${year}: ${countries.length} states, ${Math.round(json.length / 1024)} KB raw, ${Math.round(gz.length / 1024)} KB gzipped`);
}
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ years: years.sort((a, b) => a - b) }));

for (const [name, file] of Object.entries(LAYERS)) {
  if (!fs.existsSync(path.join(src, file))) { console.log(`${name}: ${file} not found, keeping existing bundle`); continue; }
  const fc = JSON.parse(fs.readFileSync(path.join(src, file), 'utf8'));
  const polys = [];   // [ [outerRing, hole, hole...], ... ]
  const lines = [];   // [ [pt, pt, ...], ... ]
  let named = 0;
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    const label = f.properties && (f.properties.name || f.properties.NAME) || '';
    if (g.type === 'Polygon') polys.push(g.coordinates.map(ring).filter(r => r.length >= 4));
    else if (g.type === 'MultiPolygon') for (const p of g.coordinates) polys.push(p.map(ring).filter(r => r.length >= 4));
    else if (g.type === 'LineString') { const l = ring(g.coordinates); if (l.length >= 2) lines.push(label ? { n: label, p: l } : l); }
    else if (g.type === 'MultiLineString') for (const l of g.coordinates) { const rl = ring(l); if (rl.length >= 2) lines.push(label ? { n: label, p: rl } : rl); }
    if (label) named++;
  }
  const data = polys.length ? { polygons: polys.filter(p => p.length) } : { lines };
  const json = JSON.stringify(data);
  const gz = zlib.gzipSync(json, { level: 9 });
  fs.writeFileSync(path.join(out, `${name}.json.gz`), gz);
  console.log(`${name}: ${polys.length || lines.length} features, ${Math.round(json.length / 1024)} KB raw, ${Math.round(gz.length / 1024)} KB gzipped${named ? `, ${named} named` : ''}`);
}
