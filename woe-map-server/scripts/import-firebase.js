'use strict';
// Import a Firebase Realtime Database JSON export of the old WoE pages into a campaign.
//
// Usage: node scripts/import-firebase.js <export.json> <lobbyId> [sections] [options]
//
// Sections (default: every section present in the file):
//   --markers        markers from the old WoE-Player-Map ("markers" node)
//   --tree           the research tree from the old techtree page ("research_tree" node, trees → branches → techs)
//   --nations        nations from the techtree page ("nations" node): factions, banked RP, RP per week, unlocked techs
// Options:
//   --replace-tree   wipe the campaign's current tech tree before importing (otherwise techs are added or updated by key)
//   --height N       old map height in pixels (markers only; the lobby's map height is used otherwise)
//   --owner USERID   owner for imported markers
//
// The export can be the whole database or a single node ({ "markers": {...} } or just the markers object).
// Old map coordinates use Leaflet CRS.Simple where "lat" counts up from the BOTTOM of the image, so y = height - lat.
const fs = require('node:fs');
const { db, now } = require('../server/db');

const args = process.argv.slice(2);
const file = args[0];
const lobbyId = Number(args[1]);
const flag = name => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (!file || !lobbyId) {
  console.error('Usage: node scripts/import-firebase.js <export.json> <lobbyId> [--markers] [--tree] [--nations] [--replace-tree] [--height N] [--owner USERID]');
  process.exit(1);
}
const lobby = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(lobbyId);
if (!lobby) { console.error(`No lobby with id ${lobbyId}`); process.exit(1); }

let json = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!json || typeof json !== 'object') { console.error('The export is not a JSON object'); process.exit(1); }
// A bare markers export (keys → marker objects) is wrapped so the section logic below applies.
const looksLikeMarkers = !json.markers && !json.research_tree && !json.nations && Object.values(json).some(v => v && typeof v === 'object' && 'lat' in v && 'lng' in v);
if (looksLikeMarkers) json = { markers: json };

const explicit = flag('--markers') || flag('--tree') || flag('--nations');
const want = s => explicit ? flag(`--${s}`) : true;
const tx = db.prepare('BEGIN'), commit = db.prepare('COMMIT'), rollback = db.prepare('ROLLBACK');
const slug = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

tx.run();
try {
  let did = 0;
  if (want('tree') && json.research_tree && typeof json.research_tree === 'object') { importTree(json.research_tree); did++; }
  if (want('nations') && json.nations && typeof json.nations === 'object') { importNations(json.nations); did++; }
  if (want('markers') && json.markers && typeof json.markers === 'object') { importMarkers(json.markers); did++; }
  if (!did) console.log('Nothing to import: the file has no markers, research_tree or nations node' + (explicit ? ' matching the sections you asked for' : ''));
  commit.run();
} catch (e) {
  rollback.run();
  console.error(`Import failed, nothing was changed: ${e.message}`);
  process.exit(1);
}
console.log('Done. Reload the map page to see the changes.');

// ---- Tech tree: research_tree/{tree}/{branch}/{name} = { year, cost, moneyCost, image, description, stats, prerequisites } ----
function importTree(tree) {
  const research = require('../server/research');
  const rows = [];
  for (const [treeName, branches] of Object.entries(tree)) {
    if (!branches || typeof branches !== 'object') continue;
    for (const [branchName, techs] of Object.entries(branches)) {
      if (!techs || typeof techs !== 'object') continue;
      for (const [name, t] of Object.entries(techs)) {
        if (!t || typeof t !== 'object') continue;
        const desc = [String(t.description || '').trim(), t.stats ? `Stats: ${String(t.stats).trim()}` : ''].filter(Boolean).join('\n');
        rows.push({
          key: slug(name), name: String(name).slice(0, 80), branch: `${treeName}: ${branchName}`.slice(0, 40),
          year: Number(t.year) || 1914, rp: Number(t.cost) || 10, money: Number(t.moneyCost) || 0,
          prereqs: (Array.isArray(t.prerequisites) ? t.prerequisites : []).map(slug), desc: desc.slice(0, 400), effects: [],
        });
      }
    }
  }
  if (!rows.length) { console.log('research_tree: no techs found'); return; }
  const keys = new Set(rows.map(r => r.key));
  let dropped = 0;
  for (const r of rows) { const before = r.prereqs.length; r.prereqs = r.prereqs.filter(p => keys.has(p)); dropped += before - r.prereqs.length; }
  rows.sort((a, b) => a.year - b.year || a.branch.localeCompare(b.branch) || a.name.localeCompare(b.name));
  if (flag('--replace-tree')) { db.prepare('DELETE FROM techs WHERE lobby_id = ?').run(lobbyId); console.log('research_tree: cleared the current tree'); }
  let n = 0;
  rows.forEach((r, i) => { research.upsert(lobbyId, r, i); n++; });
  console.log(`research_tree: imported ${n} techs in ${new Set(rows.map(r => r.branch)).size} branches${dropped ? ` (${dropped} prerequisite links pointed at techs not in the export and were dropped)` : ''}.`);
  console.log('  Imported techs carry no effects yet: open the tech tree as GM and add "unlockUnit", "stat" or "cost" effects where a tech should do something.');
}

// ---- Nations: nations/{name} = { rp_per_week, banked_rp, unlocked: { techName: true }, password, last_update } ----
function importNations(nations) {
  const game = require('../server/game');
  const research = require('../server/research');
  const PALETTE = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#e84393', '#95a5a6', '#d35400'];
  const factions = db.prepare('SELECT * FROM factions WHERE lobby_id = ?');
  const insertFaction = db.prepare('INSERT INTO factions (lobby_id, name, color, flag_file, flag_asset, created_at) VALUES (?, ?, ?, NULL, NULL, ?)');
  const g = game.get(lobbyId);
  const techs = research.list(lobbyId);
  const byKey = new Set(techs.map(t => t.key));
  let created = 0, updated = 0, unknownTechs = 0;
  for (const [name, n] of Object.entries(nations)) {
    if (!n || typeof n !== 'object') continue;
    const clean = String(name).trim().slice(0, 60);
    if (!clean) continue;
    let f = factions.all(lobbyId).find(x => x.name.toLowerCase() === clean.toLowerCase());
    if (!f) {
      const id = insertFaction.run(lobbyId, clean, PALETTE[factions.all(lobbyId).length % PALETTE.length], now()).lastInsertRowid;
      f = db.prepare('SELECT * FROM factions WHERE id = ?').get(id);
      created++;
    } else updated++;
    game.ensureState(lobbyId, f.id, g.settings);
    const st = game.serializeState(game.q.state.get(f.id));
    if (n.banked_rp !== undefined) st.rp = Number(n.banked_rp) || 0;
    if (n.rp_per_week !== undefined) st.mods = { ...(st.mods || {}), rp: Number(n.rp_per_week) || 0 };
    const unlocked = Object.entries(n.unlocked || {}).filter(([, v]) => v).map(([k]) => slug(k));
    if (unlocked.length) {
      const known = unlocked.filter(k => byKey.has(k));
      unknownTechs += unlocked.length - known.length;
      st.techs = [...new Set([...(st.techs || []), ...known])];
    }
    game.writeState(st);
  }
  console.log(`nations: ${created} factions created, ${updated} existing factions updated (banked RP, RP per week as a per-turn modifier, unlocked techs).`);
  if (unknownTechs) console.log(`  ${unknownTechs} unlocked tech names were not in this campaign's tree (import the tree first, or with --tree in the same run).`);
  console.log('  "RP per week" was stored as the faction\'s per-turn RP modifier; base RP and city income are added on top. Adjust it in Game → Edit treasuries → Per-turn modifiers.');
  if (created) console.log('  New factions have no flag: set one on the Members tab. Assign players to their faction there too.');
}

// ---- Markers: the old WoE-Player-Map ----
function importMarkers(markers) {
  const height = Number(opt('--height') || lobby.map_height);
  if (!(height > 0)) throw new Error('Map height unknown: upload a map to the lobby first or pass --height');
  const ownerId = opt('--owner') ? Number(opt('--owner')) : null;
  const entries = Object.entries(markers || {});
  const TYPE = { player: 'player', town: 'town', poi: 'poi', army: 'unit' };
  const SIZE_COLOR = { capital: '#f1c40f', city: '#e67e22', village: '#3498db' };
  const insert = db.prepare(`
    INSERT INTO markers (lobby_id, type, name, x, y, icon_file, icon_url, color, admin_only, owner_id, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`);
  let count = 0, skipped = 0;
  const t = now();
  for (const [key, m] of entries) {
    if (!m || typeof m !== 'object') { skipped++; continue; }
    const type = TYPE[String(m.type || '').trim().toLowerCase()];
    const lat = Number(m.lat), lng = Number(m.lng);
    if (!type || !Number.isFinite(lat) || !Number.isFinite(lng)) { skipped++; continue; }
    const name = String(m.name || key).slice(0, 60);
    const data = { notes: '' };
    const tooltip = m.tooltipType === 'text' ? String(m.tooltipContent || '') : '';
    let iconUrl = null;
    if (type === 'unit') {
      Object.assign(data, {
        nation: String(m.nation || ''), unitType: String(m.unitType || ''),
        attack: Number(m.attack) || 0, defend: Number(m.defend) || 0, ap: Number(m.actionPoints) || 0,
        range: Number(m.range) || 0, movement: Number(m.movement) || 0,
        abilities: [m.ap1, m.ap2, m.ap3].map(s => String(s || '').trim()).filter(Boolean),
        strength: 100, notes: String(m.abilityDesc || tooltip || ''),
      });
      iconUrl = m.iconUrl && /^https?:/.test(m.iconUrl) ? m.iconUrl : null;
    } else if (type === 'town') {
      data.size = ['capital', 'city', 'village'].includes(m.size) ? m.size : 'village';
      data.nation = ''; data.notes = tooltip;
    } else if (type === 'poi') {
      data.category = ''; data.notes = tooltip;
    } else {
      data.notes = tooltip || (m.tooltipType === 'image' && m.tooltipContent ? `Image: ${m.tooltipContent}` : '');
      iconUrl = m.iconUrl && /^https?:/.test(m.iconUrl) ? m.iconUrl : null;
    }
    const color = type === 'town' ? SIZE_COLOR[data.size] : (type === 'unit' ? '#c0392b' : (type === 'poi' ? '#f39c12' : '#2ecc71'));
    insert.run(lobbyId, type, name, lng, height - lat, iconUrl, color, m.adminOnly ? 1 : 0, ownerId, JSON.stringify(data), t, t);
    count++;
  }
  console.log(`markers: imported ${count} (${skipped} skipped).`);
}
