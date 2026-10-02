'use strict';
// Builds the infantry atlas for the battle scenes (docs/UNITS.md, "Men and machines in a fight") from the user's
// figure folders, one per army: American, ANZAC, Arab, Commonwealth (British), French, German, Ottoman and Russian
// infantry, each a folder
// of top-down figures, one per file, named for who and what they are ("German rifleman prone aiming 1916 .png").
// Usage: node scripts/build-soldiers.js "rob assets"
// Output: public/assets/soldiers.png and public/assets/soldiers.json
//
// Every file is sorted by its name into a kit and a role:
//   - kits: per army and, where the art has them, per year (the 1914 kit; 1916, or the Ottomans' 1918) and season
//     (winter dress or greatcoats): "german-1916w"; plus assault troops ("german-assault": stormtroopers, trench raiders, Russian
//     shock troops) and the French zouaves ("french-zouave");
//   - roles: rifle.prone / rifle.kneel / rifle.stand (aiming lying, kneeling, standing), rifle.run (advancing),
//     the same for officer.*, nco.* (sergeants, corporals) and lmg.* (Lewis, Chauchat, BAR, MG 08/15 gunners),
//     medic.*, dead (casualties), crew (men working a gun: observers, loaders, crouching men), and the crewed weapons
//     with their abandoned counterparts: mg / mg.empty, mortar / mortar.empty.
// A kit takes for each role the files of its own year and season, else the undated ones, else the other season,
// else the other year (light machine guns never move back to 1914).
//
// Scale: the art is drawn to roughly one scale per army, but not quite the same between armies, so each army is
// brought to one size by its riflemen's torsos (the widest solid part of a figure, its largest inscribed circle);
// within an army every figure keeps its size against the others. Each frame records its pivot (the torso's
// centre; a team weapon's middle) and which way it faces. The art draws everyone facing up the page, so that is the
// facing, except for men aiming a rifle (they face along it: towards the figure's farthest point, the muzzle), the
// Vickers and MG 08 (barrel up and to the right), and the corrections in FACING.
const fs = require('node:fs');
const path = require('node:path');
const P = require('./png');

const root = process.argv[2];
if (!root) { console.error('Usage: node scripts/build-soldiers.js <folder holding "German Infantry" etc.>'); process.exit(1); }
const OUT = path.join(__dirname, '..', 'public', 'assets');
const TORSO = 16;   // a rifleman's torso across, atlas px (the map shows about half that, so retina screens stay sharp)

const ARMIES = {
  american: { dir: 'American Infantry', kits: [[null, false]] },
  anzac: { dir: 'Anzac Infantry', kits: [['1914', false], ['1916', false]] },
  arab: { dir: 'Arab Infantry', kits: [[null, false]] },
  british: { dir: 'Commonwealth Infantry', kits: [['1914', false], ['1916', false], ['1914', true], ['1916', true]] },
  french: { dir: 'French Infantry', kits: [['1914', false], ['1916', false]] },
  german: { dir: 'German Infantry', kits: [['1914', false], ['1916', false], ['1914', true], ['1916', true]] },
  ottoman: { dir: 'Ottoman Infantry', kits: [['1914', false], ['1918', false]] },
  russian: { dir: 'Russian Infantry', kits: [[null, false]] },
};

// Which way a frame faces (radians, 0 = right, image y down) where the rules above get it wrong; by file name
// (without its number).
const UP = -Math.PI / 2;
const FACING = {
  'British officer prone aiming winter 1916': -1.0, 'British trench raider sawn-off rifle': UP,
  'German stormtrooper carbine crouched aiming': -0.8, 'German stormtrooper mp-18 crouched aiming': -0.8,
  'Riflemen prone': -1.95, 'Riflemen grenadier': -1.2,
  'ANZAC aussie officer aiming prone': UP,
};
const AIMED = /^(rifle|nco|lmg)\.(prone|kneel|stand)$|^officer\.prone$/;
const nameOf = file => file.replace(/^\d+-/, '').replace(/\s*\.png$/i, '').replace(/\s+/g, ' ').trim();

/** Who and what a file is: { set, role, era, winter } or null when it is not used. */
function classify(file) {
  const n = file.toLowerCase().replace(/^\d+-/, '').replace(/\.png$/, '').replace(/\s+/g, ' ').trim();
  const era = /1914|early war|anzac (aussie|kiwi) (?!casualty)/.test(n) ? '1914' : /1918/.test(n) ? '1918'
    : /1916|^anzac (rifleman|officer|melee)/.test(n) || /mg 08-15|chauchat|lewis/.test(n) && !/us marine/.test(n) ? '1916' : null;
  const winter = /winter|greatcoat/.test(n);
  const at = (set, role) => ({ set, role, era, winter });
  // Crewed weapons and abandoned ones.
  if (/maxim base \d/.test(n)) return null;   // the carriage alone
  if (/decrewed|maxim gun/.test(n)) return at('line', /mortar/.test(n) ? 'mortar.empty' : 'mg.empty');
  if (/^field gun/.test(n)) return null;   // drawn to scale, far bigger than the map's guns: those stay
  if (/mortar/.test(n)) return at('line', 'mortar');
  if (/vickers gunner|mg 08 crew|hotchkiss crew|browning m1917 crewed|hotchkiss crewed|maxim crew|maxim baseless crew|maxim prone baseless crew/.test(n)) return at('line', 'mg');
  if (/machine gun crew|machine gunner|fighter machine gun/.test(n)) return at('line', 'mg');
  if (/maxi[mn] (prone )?baseless 1-man/.test(n)) return at('line', 'mg');
  if (/cavalry|mounted|bagpiper|t-gewehr|wex|highlander|sniper|mg 08 (19|greatcoat)|french hotchkiss 19/.test(n)) return null;
  // Loaders and lookouts work the guns.
  if (/observer|second number|hotchkiss #2|lewis gun #2/.test(n)) return at('line', 'crew');
  const pose = /prone/.test(n) ? (/advanc/.test(n) ? null : 'prone') : /crouch/.test(n) ? (/aim/.test(n) ? 'kneel' : 'crouch')
    : /aim|grenadier|sawn-off/.test(n) ? 'stand' : /advanc/.test(n) ? 'run' : /bayonet|melee/.test(n) ? 'charge' : /idle/.test(n) ? 'idle' : null;
  if (/casualty|wounded/.test(n)) return at('line', 'dead');
  if (/medic|stretcher/.test(n)) return pose === 'crouch' ? at('line', 'medic.kneel') : !pose || pose === 'run' || pose === 'idle' ? at('line', 'medic.run') : null;
  if (/trench raider|stormtrooper|shocktrooper/.test(n)) {
    if (/trench raider prone$/.test(n)) return at('assault', 'rifle.prone');
    if (/prone advanc/.test(n)) return null;
    const p = pose || 'stand';   // the Russian shock trooper standing
    return at('assault', 'rifle.' + (p === 'crouch' ? 'kneel' : p === 'idle' ? 'stand' : p));
  }
  if (!pose) return null;
  const set = /zouave/.test(n) ? 'zouave' : 'line';
  const who = /officer|revolver/.test(n) ? 'officer' : /sergeant|corporal/.test(n) ? 'nco' : /bar gunner|chauchat|lewis gunner|mg 08-15/.test(n) ? 'lmg' : 'rifle';
  if (pose === 'crouch') return who === 'rifle' ? at(set, 'crew') : null;
  if (pose === 'idle') return at(set, who === 'officer' ? 'officer.stand' : 'rifle.idle');
  return at(set, `${who}.${pose}`);
}

// ---- Measure: torso (largest inscribed circle, exact distance transform), pivot, facing ----
function edt1(f, n) {
  const d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; }
  return d;
}
function measure(img) {
  const { w, h, px } = img, g = new Float64Array(w * h), col = new Float64Array(h), row = new Float64Array(w);
  for (let i = 0; i < w * h; i++) g[i] = px[i * 4 + 3] > 128 ? 1e12 : 0;
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) col[y] = g[y * w + x]; const d = edt1(col, h); for (let y = 0; y < h; y++) g[y * w + x] = d[y]; }
  let best = 0, cx = 0, cy = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = g[y * w + x];
    const d = edt1(row, w);
    for (let x = 0; x < w; x++) if (d[x] > best) { best = d[x]; cx = x; cy = y; }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { r: Math.sqrt(best), cx, cy, box: [x0, y0, x1 - x0 + 1, y1 - y0 + 1] };
}
function farthest(img, px0, py0) {
  let best = -1, fx = px0, fy = py0 - 1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.px[(y * img.w + x) * 4 + 3] > 128) {
    const d = (x - px0) ** 2 + (y - py0) ** 2; if (d > best) { best = d; fx = x; fy = y; }
  }
  return Math.atan2(fy - py0, fx - px0);
}

// ---- Sort every file ----
const files = [];   // { army, file, src, set, role, era, winter }
for (const [army, a] of Object.entries(ARMIES)) {
  for (const file of fs.readdirSync(path.join(root, a.dir)).filter(f => /\.png$/i.test(f))) {
    const c = classify(file);
    if (c) files.push({ army, file, src: path.join(root, a.dir, file), ...c });
  }
}
const TEAM = /^(mg|mortar)/;
// Which files each kit uses for each role.
const kits = {};
const pick = (army, set, era, winter, role) => {
  const all = files.filter(f => f.army === army && f.set === set && f.role === role);
  const tiers = era ? [
    f => f.era === era && f.winter === winter, f => !f.era && f.winter === winter,
    f => f.era === era, f => !f.era,
    ...(role.startsWith('lmg') && era === '1914' ? [] : [f => f.winter === winter, () => true]),
  ] : [f => f.winter === winter, () => true];
  for (const t of tiers) { const got = all.filter(t); if (got.length) return got; }
  return [];
};
const ROLES = [...new Set(files.map(f => f.role))];
for (const [army, a] of Object.entries(ARMIES)) {
  for (const [era, winter] of a.kits) {
    const key = army + (era ? '-' + era : '') + (winter ? 'w' : '');
    kits[key] = {};
    for (const role of ROLES) { const got = pick(army, 'line', era, winter, role); if (got.length) kits[key][role] = got; }
  }
  for (const set of ['assault', 'zouave']) {
    const roles = {};
    for (const role of ROLES) { const got = pick(army, set, '1916', false, role); if (got.length) roles[role] = got; }
    if (Object.keys(roles).length) kits[`${army}-${set}`] = roles;
  }
}

// ---- Cut the frames used ----
const used = [...new Set(Object.values(kits).flatMap(k => Object.values(k).flat()))];
const meas = new Map();
for (const f of used) { const img = P.decodePng(fs.readFileSync(f.src)); meas.set(f, { img, ...measure(img) }); }
// Each army's scale: by the median torso of its riflemen (out of winter dress).
const median = a => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
const shrinkBy = {};
for (const army of Object.keys(ARMIES)) {
  const rs = used.filter(f => f.army === army && /^rifle\.(prone|kneel|stand)$/.test(f.role) && !f.winter).map(f => meas.get(f).r);
  shrinkBy[army] = 2 * median(rs) / TORSO;
}
const frames = used.map(f => {
  const m = meas.get(f), k = shrinkBy[f.army], team = TEAM.test(f.role);
  const pvx = team ? m.box[0] + m.box[2] / 2 : m.cx, pvy = team ? m.box[1] + m.box[3] / 2 : m.cy;
  const s = P.shrink(m.img, m.box, k);
  const name = nameOf(f.file);
  const face = FACING[name] ?? (f.role === 'dead' ? 0 : /vickers|mg 08 (crew|decrewed)/i.test(name) ? -Math.PI / 4
    : AIMED.test(f.role) && f.army !== 'russian' ? farthest(m.img, pvx, pvy) : UP);
  return { ...s, f, ax: ((pvx - m.box[0]) / k + s.ox) / s.w, ay: ((pvy - m.box[1]) / k + s.oy) / s.h, face };
});
const packed = P.packShelves(frames, 1600);
const index = new Map(frames.map((fr, i) => [fr.f, i]));
fs.writeFileSync(path.join(OUT, 'soldiers.png'), P.encodePng(packed.w, packed.h, packed.px));
fs.writeFileSync(path.join(OUT, 'soldiers.json'), JSON.stringify({
  torso: TORSO,
  // [x, y, w, h, pivot x, pivot y (fractions of the frame), facing (radians)]
  frames: frames.map(fr => { const p = packed.place.find(q => q.f === fr); return [p.x, p.y, fr.w, fr.h, +fr.ax.toFixed(3), +fr.ay.toFixed(3), +fr.face.toFixed(3)]; }),
  names: frames.map(fr => nameOf(fr.f.file)),
  kits: Object.fromEntries(Object.entries(kits).map(([k, roles]) => [k, Object.fromEntries(Object.entries(roles).map(([r, fs_]) => [r, fs_.map(f => index.get(f))]))])),
}));
console.log(`soldiers.png ${packed.w}×${packed.h}: ${frames.length} figures in ${Object.keys(kits).length} kits`);
for (const [k, roles] of Object.entries(kits)) console.log(' ', k.padEnd(16), Object.entries(roles).map(([r, l]) => `${r} ${l.length}`).join(', '));
