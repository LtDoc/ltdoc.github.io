'use strict';

/** Keep only the map, states and settlements from an Azgaar Full JSON export. */
function prepare(source) {
  const info = source?.info, pack = source?.pack;
  const width = Number(info?.width), height = Number(info?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || height < 100 || width > 32768 || height > 32768 ||
      !Array.isArray(pack?.cells) || !Array.isArray(pack?.vertices) || !Array.isArray(pack?.states) || !Array.isArray(pack?.burgs)) {
    throw new Error('Upload an Azgaar Full JSON export with cells, vertices, states and burgs');
  }
  if (pack.cells.length > 100000 || pack.vertices.length > 300000 || pack.burgs.length > 20000 || pack.states.length > 1000) {
    throw new Error('This map exceeds the import size limit');
  }
  const round = n => Math.round(n * 100) / 100;
  const vertices = pack.vertices.map(v => v?.p);
  const polygon = cell => {
    if (!Array.isArray(cell?.v) || cell.v.length < 3 || cell.v.length > 1000) throw new Error('A map cell has invalid vertices');
    const ring = cell.v.map(index => {
      const p = vertices[index];
      // Azgaar's edge cells can extend a few pixels beyond its nominal canvas.
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < -64 || p[1] < -64 || p[0] > width + 64 || p[1] > height + 64) {
        throw new Error('A map cell refers to an invalid vertex');
      }
      return [round(p[0]), round(p[1])];
    });
    if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push([...ring[0]]);
    return ring;
  };
  const states = new Map();
  const names = new Set();
  for (const state of pack.states) {
    if (!state || state.removed || !Number.isInteger(state.i) || state.i <= 0 || states.has(state.i)) continue;
    let name = String(state.name || `Nation ${state.i}`).trim().slice(0, 60) || `Nation ${state.i}`;
    if (names.has(name.toLowerCase())) name = `${name.slice(0, 48)} (${state.i})`;
    names.add(name.toLowerCase());
    const color = /^#[0-9a-f]{6}$/i.test(state.color || '') ? state.color : `#${((state.i * 0x9e3779) & 0xffffff).toString(16).padStart(6, '0')}`;
    states.set(state.i, { id: state.i, name, color });
  }
  if (!states.size) throw new Error('The map has no nations');
  const biomes = new Map((Array.isArray(pack.biomes) ? pack.biomes : [])
    .filter(b => Number.isInteger(b?.i) && /^#[0-9a-f]{6}$/i.test(b.color || ''))
    .map(b => [b.i, b.color]));
  const land = [], seen = new Set();
  for (const cell of pack.cells) {
    if (!Number.isInteger(cell?.i) || seen.has(cell.i)) throw new Error('Map cells need unique IDs');
    seen.add(cell.i);
    if (Number(cell.h) >= 20) {
      const ring = polygon(cell);
      const state = Number(cell.state) || 0;
      if (state && !states.has(state)) throw new Error(`Map cell ${cell.i} refers to an unknown nation`);
      const x = Number(cell.p?.[0]), y = Number(cell.p?.[1]);
      land.push({ id: cell.i, state, x: Number.isFinite(x) ? x : ring[0][0], y: Number.isFinite(y) ? y : ring[0][1],
        biomeColor: biomes.get(cell.biome) || '#a6be8d', geometry: [[ring]] });
    }
  }
  if (!land.length) throw new Error('The map has no land cells');
  const burgs = [];
  for (const burg of pack.burgs) {
    if (!burg || burg.removed || !Number.isInteger(burg.i) || burg.i <= 0) continue;
    if (!Number.isFinite(burg.x) || !Number.isFinite(burg.y) || burg.x < 0 || burg.y < 0 || burg.x > width || burg.y > height) continue;
    const name = String(burg.name || '').trim().slice(0, 60);
    if (!name) continue;
    const state = Number(burg.state) || 0;
    burgs.push({ id: burg.i, name, x: round(burg.x), y: round(burg.y), state,
      size: burg.capital ? 'capital' : (burg.group === 'city' ? 'city' : 'village') });
  }
  return { width, height, name: String(info.mapName || '').trim().slice(0, 60), states: [...states.values()], land, burgs };
}

module.exports = { prepare };
