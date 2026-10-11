'use strict';
/* global UnitTypes, GameData, Matchups, esc */

/**
 * Unit guide (docs/UI.md, "Build and the unit guide"): what each unit type is for, in plain words, with the facts a
 * player needs to choose between them. Shared by the build picker, the Unit guide browser and the unit card.
 *
 *   UnitGuide.info(typeId)             → { role, blurb } written for every Great War type
 *   UnitGuide.counter(type, color)     → data URL of the unit's NATO counter (the map's own symbol drawers)
 *   UnitGuide.stats(type, overrides)   → { attack, defend, ap, range, movement, armourClass, penetration }
 *   UnitGuide.statBars(stats, opts)    → HTML rating bars (with deltas against a pinned type when given)
 *   UnitGuide.matchups(type)           → { strong: [{ label, mod, why }], weak: [...] }
 *   UnitGuide.abilities(type, opts)    → [{ icon, text }] from the campaign's rules
 *   UnitGuide.costChips(cost, state)   → HTML chips with resource icons, short ones marked
 *   UnitGuide.detailHtml(type, opts)   → the whole explainer card
 *
 * Text never quotes stats or distances that campaigns can change: those come from the rules at render time.
 */
const UnitGuide = (() => {
  const E = s => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));

  // ---- What each type is for ------------------------------------------------------------------
  const INFO = {
    infantry: ['Line infantry', 'The backbone of the army: cheap, quick to raise and steady in attack and defence. Takes and holds ground.'],
    stormtroopers: ['Assault troops', 'The hardest-hitting foot soldiers, trained to break into trench lines. Fragile when the enemy hits back.'],
    mountain: ['Picked infantry', 'Hardy troops a step above line infantry in both attack and defence, for a little more money.'],
    marines: ['Naval infantry', 'Stubborn defenders trained for landings. Carry them in a convoy to seize and hold a beachhead.'],
    conscripts: ['Mass levies', 'Half-trained men: cheap in money but heavy on manpower. Poor attackers; they fill the line while better troops strike.'],
    militia: ['Garrison troops', 'The cheapest troops there are. Garrison towns and quiet sectors; not fit for an offensive.'],
    colonial: ['Light infantry', 'Cheap troops that march further than the line. Good for wide fronts and distant theatres.'],
    bicycle: ['Fast infantry', 'Infantry on bicycles: far quicker than men on foot but weak in a fight. Screens, scouting and quick reinforcement.'],
    machinegun: ['Defensive firepower', 'A wall in defence and the bane of cavalry, but almost useless in attack. Infantry and horsemen attacking it suffer.'],
    cavalry: ['Shock and pursuit', 'Fast and hard-hitting in the open: overruns guns and raids the rear. Broken by wire, trenches and machine guns.'],
    dragoons: ['Mounted infantry', 'Ride to the fight and dismount: less shock than cavalry, but able to hold what they take.'],
    lancers: ['Heavy cavalry', 'The heaviest charge on the field, with all of cavalry\'s weakness against wire and machine guns.'],
    hussars: ['Light cavalry', 'The fastest horsemen: raiders, scouts and pursuers. Fragile when caught.'],
    camelry: ['Desert cavalry', 'Mounted troops for the desert that need no horses to raise.'],
    reconnaissance: ['Scouts', 'Weak in a fight, but quick, with the longest sight of any land unit. Finds the enemy under fog of war.'],
    armouredcar: ['Armoured raiders', 'Fast and armoured, so rifles cannot hurt them. Hunt horsemen; road-bound and poor against trenches.'],
    tank: ['Breakthrough armour', 'Slow, but heavily armoured: crosses the wire and shrugs off machine guns. Only heavy weapons can hurt it.'],
    armouredtrain: ['Armour on rails', 'Guns and armour on a train: strong, armoured and long-reaching. Burns coal.'],
    fieldartillery: ['Field guns', 'Shells the enemy from behind your own line and takes no reply when the attack fails. Weak if caught in the open.'],
    horseartillery: ['Mobile guns', 'Lighter guns that keep pace with cavalry and fast columns.'],
    heavyartillery: ['Heavy guns', 'Long reach and heavy shells that smash trenches and concrete.'],
    siegeartillery: ['Siege guns', 'The heaviest guns on the field, for breaking forts and trench systems. Slow to build and slow to move.'],
    railwaygun: ['Super-heavy gun', 'Enormous reach and the heaviest shells. Expensive, and defenceless if the enemy reaches it.'],
    mortar: ['Trench mortars', 'Cheap, short-ranged guns that lob bombs into trenches.'],
    antiaircraft: ['Air defence', 'Shoots down aircraft and balloons. Aircraft attacking it fly into flak.'],
    coastal: ['Shore guns', 'Heavy guns on the coast that punish ships and fire back at ships that shell them.'],
    fortress: ['Fortress', 'A fort with guns and a rifle garrison. Holds its ground while it stands and keeps the troops around it supplied.'],
    mgbunker: ['Concrete pillbox', 'A concrete machine-gun post: the hardest point on the map to take.'],
    aaemplacement: ['Fixed air defence', 'Flak guns dug in to guard a city, port or works against aircraft.'],
    hq: ['Command', 'Coordinates the troops around it: a bonus to their attack and defence.'],
    engineers: ['Builders', 'Dig and reinforce trenches, lay and repair railway, and stiffen the defence nearby.'],
    sappers: ['Demolition', 'Blow up enemy trench sections and wreck resource works. Strong against dug-in troops.'],
    pioneers: ['Builders', 'Cheaper engineers: dig trenches, lay and repair railway, and stiffen the defence nearby.'],
    signals: ['Artillery spotting', 'Telephones and wireless: the artillery around it shoots straighter.'],
    supply: ['Supply column', 'Carries supplies forward to the troops around it. Chain columns to keep an advance fed.'],
    medical: ['Field hospital', 'Heals damaged units around it a little each turn, for free.'],
    gas: ['Chemical attack', 'Release gas on the enemy\'s lines. Strong against dug-in troops.'],
    railway: ['Railway builders', 'Lay new track and repair cut lines.'],
    labour: ['Rear-area workers', 'Cheap working men. Weak in a fight and with no special orders under the current rules.'],
    fighter: ['Air superiority', 'Wins the sky: hunts bombers, airships and spotters. Fast, with a long sight.'],
    bomber: ['Strategic strikes', 'Strikes far behind the lines with heavy bombs that hurt even armour.'],
    reconair: ['Air reconnaissance', 'The best eyes in the war under fog of war. Barely armed.'],
    seaplane: ['Naval aviation', 'Aircraft that work over the sea: scouting and light strikes on ships.'],
    balloon: ['Tethered spotter', 'Cheap, slow observation post with a long view over the front.'],
    airship: ['Zeppelin', 'Very long-range bombing raids and a wide view. Fragile and expensive.'],
    dreadnought: ['Capital ship', 'The strongest ship afloat: big guns and the thickest armour. Enormously expensive and slow to build.'],
    predreadnought: ['Older battleship', 'A cheaper, slower capital ship. Still outguns anything smaller.'],
    battlecruiser: ['Fast capital ship', 'Battleship guns with cruiser speed, bought with thinner armour.'],
    armouredcruiser: ['Heavy cruiser', 'A well-protected ship for patrols, raids and blockades.'],
    lightcruiser: ['Cruiser', 'Fast and fairly cheap: patrols, raids and blockades.'],
    destroyer: ['Escort and sub-hunter', 'The only ships that find submerged submarines. Hunt U-boats and torpedo boats.'],
    torpedoboat: ['Torpedo attack', 'Cheap, fast and deadly to big ships, but fragile.'],
    submarine: ['U-boats', 'Dive out of sight: only destroyers can find them. Sink merchantmen and threaten capital ships.'],
    minelayer: ['Auxiliary', 'Light auxiliary warship: cheap and weak in a fight. Prey to U-boats.'],
    gunboat: ['Coastal warship', 'Cheap ship for coasts and rivers.'],
    transport: ['Troopships and supply', 'Carries land units across the sea and lands them on a beach. A floating supply base for invasions. Cannot fight.'],
    seaplanecarrier: ['Seaplane carrier', 'A converted merchantman carrying seaplanes: long reach, weak in a fight.'],
  };
  const info = id => { const r = INFO[id]; return r ? { role: r[0], blurb: r[1] } : { role: '', blurb: '' }; };

  // Short names for matchup targets and lists ("Stormtroopers / assault infantry" → "Stormtroopers").
  const shortName = t => String(t?.name || '').split(' / ')[0];
  const CAT_LABEL = { Infantry: 'infantry', 'Mounted & mobile': 'mounted troops', Artillery: 'artillery', Emplacements: 'fortifications', Support: 'support troops', Air: 'aircraft', Naval: 'ships' };
  const CAT_ICON = { Infantry: '🪖', 'Mounted & mobile': '🐎', Artillery: '💥', Emplacements: '🏰', Support: '🛠', Air: '✈', Naval: '⚓' };

  // ---- Counters: the map's own symbol drawers on a 2D canvas ----------------------------------------------------
  /** Minimal stand-in for the PixiJS Graphics calls the symbol drawers make. */
  function canvasGraphics(ctx) {
    const rgba = (c, a) => { const n = Number(c) || 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a ?? 1})`; };
    ctx.beginPath();
    const g = {
      moveTo(x, y) { ctx.moveTo(x, y); return g; },
      lineTo(x, y) { ctx.lineTo(x, y); return g; },
      circle(x, y, r) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); return g; },
      ellipse(x, y, rx, ry) { ctx.moveTo(x + rx, y); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); return g; },
      rect(x, y, w, h) { ctx.rect(x, y, w, h); return g; },
      roundRect(x, y, w, h, r) { if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2))); else ctx.rect(x, y, w, h); return g; },
      arc(x, y, r, a0, a1) { ctx.arc(x, y, r, a0, a1); return g; },
      poly(pts) { ctx.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]); ctx.closePath(); return g; },
      fill(s) { const o = typeof s === 'object' ? s : { color: s }; ctx.fillStyle = rgba(o.color, o.alpha); ctx.fill(); ctx.beginPath(); return g; },
      stroke(s) { const o = s || {}; ctx.lineWidth = o.width || 1; ctx.strokeStyle = rgba(o.color ?? 0xffffff, o.alpha); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(); ctx.beginPath(); return g; },
    };
    return g;
  }
  const counterCache = new Map();
  /** Data URL of a unit type's counter in a colour (44 × 30 like the map's, drawn at 3× for sharpness). */
  function counter(type, color = '#5b6b4f') {
    if (!type) return '';
    const key = `${type.id}|${type.symbol}|${type.mod || ''}|${color}`;
    if (counterCache.has(key)) return counterCache.get(key);
    let url = '';
    try {
      const S = 3, W = 44, H = 30, cv = document.createElement('canvas');
      cv.width = W * S; cv.height = H * S;
      const ctx = cv.getContext('2d');
      ctx.scale(S, S); ctx.translate(W / 2, H / 2);
      const g = canvasGraphics(ctx);
      const col = /^#?[0-9a-f]{6}$/i.test(String(color)) ? parseInt(String(color).replace('#', ''), 16) : 0x5b6b4f;
      g.roundRect(-W / 2 + 1, -H / 2 + 1, W - 2, H - 2, 4).fill(col).roundRect(-W / 2 + 1, -H / 2 + 1, W - 2, H - 2, 4).stroke({ width: 2, color: 0xffffff });
      const box = { x: -W / 2 + 6, y: -H / 2 + 5, w: W - 12, h: H - 12 };
      g.roundRect(box.x, box.y, box.w, box.h, 2).stroke({ width: 1.5, color: 0xffffff, alpha: 0.9 });
      const b = { ...box, cx: box.x + box.w / 2, cy: box.y + box.h / 2 };
      const draw = UnitTypes.symbols?.[type.symbol] || UnitTypes.symbols?.infantry;
      if (draw) draw(g, b);
      if (type.mod) {
        ctx.font = '800 6.5px "Segoe UI", Arial'; ctx.fillStyle = '#fff'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
        ctx.fillText(type.mod, box.x + box.w + 5, box.y - 6.5);
      }
      url = cv.toDataURL();
    } catch { url = ''; }
    counterCache.set(key, url);
    return url;
  }
  const counterImg = (type, color, cls = 'ug-counter') => {
    const u = counter(type, color);
    return u ? `<img class="${cls}" src="${u}" alt="" draggable="false">` : `<span class="${cls} ug-noicon">${E(CAT_ICON[type?.cat] || '?')}</span>`;
  };

  // ---- Stats ----------------------------------------------------------------------------------------------------
  const stats = (type, overrides) => UnitTypes.defaults(type, overrides) || null;
  /** What each stat means, in one line, for tooltips and the guide's key. */
  const STAT_HELP = {
    attack: 'Attack: added to its d20 roll when it attacks',
    defend: 'Defence: added to its d20 roll when it is attacked',
    ap: 'Action points: attacks it can make each turn',
    range: 'Range: how far away it can strike',
    movement: 'Movement: how far it can go each turn',
    armourClass: 'Armour: an attacker needs at least this much penetration to cause it losses',
    penetration: 'Penetration: it can hurt targets whose armour is no higher than this',
  };
  const BAR_ROWS = [['attack', 'Attack', 10], ['defend', 'Defence', 10], ['movement', 'Movement', 8], ['range', 'Range', 8], ['armourClass', 'Armour', 10], ['penetration', 'Penetration', 10]];
  /**
   * Rating bars for a stats object. opts: { settings, scale (km label), vs (stats to compare with), compact }.
   * Movement and range also give the distance in km under the campaign's rules.
   */
  function statBars(s, opts = {}) {
    if (!s) return '';
    const S = opts.settings || {}, unit = opts.scale || 'km';
    const dist = (k, v) => k === 'movement' ? `${fmtNum(v * Number(S.kmPerMove ?? 50))} ${unit}` : k === 'range' ? `${fmtNum(v * Number(S.kmPerRange ?? 50))} ${unit}` : '';
    const rows = (opts.compact ? BAR_ROWS.slice(0, 4) : BAR_ROWS).map(([k, label, max]) => {
      const v = Number(s[k]) || 0, pct = Math.max(0, Math.min(100, v / max * 100));
      const d = opts.vs ? v - (Number(opts.vs[k]) || 0) : 0;
      const delta = opts.vs && d ? `<em class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}</em>` : '';
      const extra = !opts.compact ? dist(k, v) : '';
      return `<div class="ug-bar ug-${k}" title="${E(STAT_HELP[k])}"><span class="ug-bl">${label}</span><span class="ug-track"><i style="width:${pct}%"></i></span><b>${v}</b>${delta}${extra ? `<small>${E(extra)}</small>` : '<small></small>'}</div>`;
    }).join('');
    const ap = !opts.compact ? `<div class="ug-ap" title="${E(STAT_HELP.ap)}">${'<i></i>'.repeat(Math.max(0, Math.min(6, Number(s.ap) || 0)))}<span>${Number(s.ap) || 0} attack${Number(s.ap) === 1 ? '' : 's'} a turn</span>${opts.vs && (Number(s.ap) || 0) !== (Number(opts.vs.ap) || 0) ? `<em class="${s.ap > opts.vs.ap ? 'up' : 'down'}">${s.ap > opts.vs.ap ? '+' : ''}${s.ap - opts.vs.ap}</em>` : ''}</div>` : '';
    return `<div class="ug-bars${opts.compact ? ' compact' : ''}">${rows}${ap}</div>`;
  }
  const fmtNum = n => (Math.round(Number(n) * 10) / 10).toLocaleString();

  // ---- Matchups -------------------------------------------------------------------------------------------------
  // Names for the id lists the matchup table uses (public/js/matchups.js).
  const GROUPS = [
    { label: 'Horsemen', ids: ['cavalry', 'dragoons', 'lancers', 'hussars', 'camelry', 'reconnaissance'] },
    { label: 'Machine guns', ids: ['machinegun', 'mgbunker'] },
    { label: 'Capital ships', ids: ['dreadnought', 'predreadnought', 'battlecruiser', 'armouredcruiser'] },
    { label: 'Heavy guns', ids: ['heavyartillery', 'siegeartillery', 'railwaygun'] },
    { label: 'Heavy guns and mortars', ids: ['heavyartillery', 'siegeartillery', 'railwaygun', 'mortar'] },
    { label: 'Field and horse guns', ids: ['fieldartillery', 'horseartillery'] },
    { label: 'Anti-aircraft', ids: ['antiaircraft', 'aaemplacement'] },
    { label: 'Shore and fort guns', ids: ['coastal', 'fortress'] },
    { label: 'Bombers and spotters', ids: ['bomber', 'airship', 'reconair', 'balloon'] },
    { label: 'Merchantmen', ids: ['transport', 'minelayer'] },
    { label: 'Submarines and torpedo boats', ids: ['submarine', 'torpedoboat'] },
    { label: 'Destroyers and torpedo boats', ids: ['destroyer', 'torpedoboat'] },
  ];
  function sideHits(side, type) {
    if (!type || side.entrenched) return false;
    if (side.not && side.not.includes(type.id)) return false;
    if (side.ids) return side.ids.includes(type.id);
    if (side.cat) return type.cat === side.cat;
    return false;
  }
  function sideLabel(side) {
    if (side.entrenched) return 'Dug-in troops';
    if (side.cat) return (CAT_LABEL[side.cat] || side.cat).replace(/^./, c => c.toUpperCase());
    const ids = side.ids || [], group = GROUPS.find(gr => gr.ids.length === ids.length && gr.ids.every(id => ids.includes(id)));
    if (group) return group.label;
    const names = ids.map(id => shortName(UnitTypes.LIST.find(t => t.id === id) || { name: id }));
    if (names.length > 3) return names.slice(0, 2).join(', ') + ` and ${names.length - 2} more`;
    return names.join(', ');
  }
  /**
   * What a type is good and bad at: attacking (its own roll) and being attacked (the enemy's roll against it).
   * strong: its edge; weak: where it suffers. Each { label, mod, why, as: 'attacking' | 'defending' }.
   */
  function matchups(type) {
    const strong = [], weak = [];
    if (!type || !window.Matchups) return { strong, weak };
    for (const r of Matchups.RULES) {
      if (sideHits(r.a, type)) {
        (r.mod > 0 ? strong : weak).push({ label: sideLabel(r.d), mod: r.mod, why: r.text, as: 'attacking' });
      } else if (sideHits(r.d, type)) {
        // The enemy's modifier attacking this type: a bonus for them is a weakness here.
        (r.mod > 0 ? weak : strong).push({ label: sideLabel(r.a), mod: -r.mod, why: r.text, as: 'defending' });
      }
    }
    if (type.cat === 'Emplacements') strong.push({ label: 'Counts as dug in', mod: 0, why: 'fixed works count as entrenched in every matchup', as: 'defending' });
    return { strong, weak };
  }
  function matchupHtml(type) {
    const { strong, weak } = matchups(type);
    if (!strong.length && !weak.length) return '<p class="hint ug-none">No special strengths or weaknesses: it fights on its stats alone.</p>';
    const chip = (x, good) => `<span class="ug-chip ${good ? 'good' : 'bad'}" title="${E(x.why)}">${x.as === 'defending' ? '<s>🛡</s>' : '<s>⚔</s>'}${E(x.label)}${x.mod ? `<b>${x.mod > 0 ? '+' : ''}${x.mod}</b>` : ''}</span>`;
    return `<div class="ug-match">${strong.length ? `<div><span class="ug-mh good">Strong</span>${strong.map(x => chip(x, true)).join('')}</div>` : ''}${weak.length ? `<div><span class="ug-mh bad">Weak</span>${weak.map(x => chip(x, false)).join('')}</div>` : ''}</div>`;
  }

  // ---- Abilities from the rules ---------------------------------------------------------------------------------
  const ENGINEERS = ['engineers', 'pioneers', 'sappers'];
  const LAND = ['Infantry', 'Mounted & mobile', 'Artillery', 'Support'];
  /** opts: { settings, scale, overrides (unit stats), game (enabled) }. Every distance comes from the campaign's rules. */
  function abilities(type, opts = {}) {
    if (!type) return [];
    const S = opts.settings || (window.GameData ? GameData.DEFAULT_SETTINGS : {}), u = opts.scale || 'km', out = [];
    const add = (icon, text) => out.push({ icon, text });
    const id = type.id;
    // Support auras.
    if (id === 'hq') add('⭐', `+${S.hqBonus ?? 1} attack and defence to friendly units within ${S.hqKm ?? 40} ${u}`);
    if (ENGINEERS.includes(id)) add('🧱', `+${S.engineerDefend ?? 1} defence to friendly units within ${S.engineerKm ?? 20} ${u}`);
    if (id === 'signals') add('📡', `+${S.signalsArtillery ?? 1} attack to friendly artillery within ${S.signalsKm ?? 60} ${u}`);
    if (id === 'medical') add('➕', `Heals friendly units within ${S.hospitalKm ?? 40} ${u} by ${S.hospitalHeal ?? 10}% each turn`);
    if (id === 'supply') {
      add('📦', `Supplies friendly land units within ${S.supplyRangeKm ?? 100} ${u}`);
      if (S.goodsEnabled !== false) add('🛒', `Carries ${S.columnPool ?? 50} supplies; refills at End turn while linked to a friendly town, railhead or another column`);
      else add('🔗', 'Linked to a friendly town, railhead or another column, it passes supply on');
    }
    if (id === 'transport') {
      add('⛴', `Carries up to ${S.convoyCapacity ?? 10} land units or heroes and lands them on a beach within ${S.convoyLandKm ?? 100} ${u}`);
      add('📦', `Floating supply base: supplies land units within ${S.convoyRangeKm ?? 100} ${u} and feeds columns within ${S.convoyLinkKm ?? 200} ${u}`);
      add('☠', 'Everyone aboard goes down with it if it is sunk');
    }
    // Orders.
    if (id === 'engineers' || id === 'pioneers') add('⛏', `Digs and reinforces trenches (${S.trenchSectionKm ?? 10} ${u} a turn, for timber)`);
    if (['engineers', 'pioneers', 'railway'].includes(id)) add('🛤', `Lays planned railway (${S.railBuildKm ?? 15} ${u} a turn) and repairs cut lines`);
    if (id === 'sappers') { add('💥', 'Blows up a section of enemy trench in the battle phase'); add('🔥', 'Wrecks the works of a resource node: denial or a raid'); }
    if (id === 'submarine') { add('🌊', 'Dives out of sight; only destroyers nearby can find or attack it'); add('⬆', 'Surfaces to attack and stays up for the rest of the turn'); }
    if (id === 'destroyer') add('🔎', `Finds submerged submarines within ${S.subDetectKm ?? 20} ${u}`);
    if (id === 'fortress') {
      add('🏰', 'Its ground cannot be captured while it and its defenders stand');
      add('🎯', `Its garrison adds a rifle volley against targets within ${fmtNum((S.fortRifleRange ?? 1) * (S.kmPerRange ?? 50))} ${u}`);
      if (S.goodsEnabled !== false) add('📦', `Stores ${S.fortPool ?? 200} supplies for units around it and feeds columns within ${S.fortLinkKm ?? 200} ${u}`);
    }
    if (['coastal', 'fortress'].includes(id)) add('⚓', 'Returns fire on ships that attack it');
    // Firing and movement.
    if (UnitTypes.firesFromRange(type)) add('🎯', 'Fires from range: takes no reply when its attack fails');
    if (type.cat === 'Emplacements') {
      add('📍', 'Fixed work: built here, then placed where you choose on your own ground. Never moves');
      if (id !== 'fortress') add('🏳', 'Changes hands with the province beneath it');
    }
    if (type.cat === 'Naval' && id !== 'transport' && !['submarine'].includes(id)) add('⚓', `Blockades enemy ports within ${S.blockadeKm ?? 50} ${u}`);
    // Supply and upkeep.
    if (opts.supply !== false && S.supplyEnabled !== false) {
      if (LAND.includes(type.cat)) add('🥫', `Needs supply; carries ${S.supplyStock ?? 3} turns' worth when cut off`);
      else add('✅', 'Needs no supply');
    }
    if (S.upkeep && window.GameData) {
      const fuel = GameData.fuelOf(type);
      if (fuel) add('🛢', `Burns ${fuel === 'oil' ? S.upkeepOil ?? 0.5 : S.upkeepCoal ?? 0.25} ${fuel} a turn`);
    }
    if (S.fogOfWar && S.vision) {
      const km = S.vision[id] ?? S.vision[type.cat];
      if (km) add('👁', `Sees ${km} ${u}`);
    }
    return out;
  }

  // ---- Armour and penetration -----------------------------------------------------------------------------------
  /** Which types can hurt this one, and which this one cannot hurt: armour against penetration. */
  function armourFacts(type, overrides) {
    const me = stats(type, overrides);
    if (!me) return [];
    const all = UnitTypes.LIST.map(t => ({ t, s: stats(t, overrides) })).filter(x => x.s);
    const out = [];
    // Whole categories by name ("all infantry"), the rest by type, at most five items.
    const list = (xs, pool) => {
      const items = [];
      for (const cat of UnitTypes.categories) {
        const inCat = xs.filter(x => x.t.cat === cat);
        if (!inCat.length) continue;
        const of = pool.filter(x => x.t.cat === cat);
        const missing = of.filter(x => !inCat.includes(x));
        if (!missing.length && of.length > 1) items.push(`all ${CAT_LABEL[cat] || cat}`);
        else if (of.length >= 4 && missing.length <= 2 && inCat.length > missing.length) items.push(`${CAT_LABEL[cat] || cat} except ${missing.map(x => shortName(x.t)).join(' and ')}`);
        else items.push(...inCat.map(x => shortName(x.t)));
      }
      return items.length > 5 ? `${items.slice(0, 5).join(', ')} and ${items.length - 5} more` : items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0];
    };
    if (me.armourClass > 1) {
      const armed = all.filter(x => (Number(x.s.attack) || 0) > 0);
      const proof = armed.filter(x => x.s.penetration < me.armourClass), hurt = armed.filter(x => x.s.penetration >= me.armourClass);
      // Whichever list is shorter: what cannot hurt it, or the few that can.
      if (proof.length && (hurt.length >= proof.length || !hurt.length)) out.push({ icon: '🛡', text: `Armour ${me.armourClass}: proof against ${list(proof, armed)}`, good: true });
      else if (proof.length) out.push({ icon: '🛡', text: `Armour ${me.armourClass}: only ${list(hurt, armed)} can hurt it`, good: true });
    }
    const blocked = all.filter(x => x.s.armourClass > me.penetration && (Number(me.attack) || 0) > 0);
    if (blocked.length) out.push({ icon: '🚫', text: `Penetration ${me.penetration}: cannot hurt ${list(blocked, all)}`, good: false });
    return out;
  }

  // ---- Costs ----------------------------------------------------------------------------------------------------
  /** Cost chips with icons; `have` (the treasury state) marks what is short. */
  function costChips(cost, have, opts = {}) {
    if (!cost) return '';
    const chips = [];
    const chip = (key, icon, label, need, haveN) => {
      const short = have && haveN < need;
      chips.push(`<span class="ug-cost${short ? ' short' : ''}" title="${E(label)}: ${need}${have ? ` (you have ${fmtNum(haveN)})` : ''}">${icon}${fmtNum(need)}</span>`);
    };
    const img = f => `<img src="/icons/${f}" alt="">`;
    if (cost.money) chip('money', img('cash.png'), 'Money', cost.money, have?.money ?? 0);
    if (cost.manpower) chip('manpower', '<span>👥</span>', 'Manpower', cost.manpower, have?.manpower ?? 0);
    for (const r of GameData.RESOURCES) if (cost[r.key]) chip(r.key, r.icon ? img(r.icon) : `<span class="reskey" style="background:${r.color}"></span>`, r.name, cost[r.key], have?.resources?.[r.key] ?? 0);
    if (!opts.noTurns) chips.push(`<span class="ug-cost time" title="Build time">⏱${cost.turns} turn${cost.turns === 1 ? '' : 's'}</span>`);
    return `<span class="ug-costs">${chips.join('')}</span>`;
  }
  /** Names of what a treasury is short of for a cost. */
  function shortOf(cost, have) {
    const short = [];
    if (!cost || !have) return short;
    for (const k of GameData.RESOURCE_KEYS) if ((have.resources?.[k] || 0) < cost[k]) short.push(GameData.byKey[k].name.toLowerCase());
    if ((have.money ?? 0) < cost.money) short.push('money');
    if ((have.manpower ?? 0) < cost.manpower) short.push('manpower');
    return short;
  }

  // ---- The explainer card ---------------------------------------------------------------------------------------
  /**
   * opts: { settings, scale, overrides, color, cost, have, vs (type to compare with), status ({ text, cls }),
   *         actions (HTML), tech (name of the tech that unlocks it, when locked) }
   */
  function detailHtml(type, opts = {}) {
    if (!type) return '<p class="hint">Pick a unit to see what it does.</p>';
    const i = info(type.id), s = stats(type, opts.overrides), vs = opts.vs && opts.vs.id !== type.id ? stats(opts.vs, opts.overrides) : null;
    const ab = abilities(type, opts), ar = armourFacts(type, opts.overrides);
    return `<div class="ug-detail">
      <div class="ug-head">${counterImg(type, opts.color, 'ug-counter big')}<div class="grow"><h3>${E(type.unit || type.name)}</h3><div class="ug-sub">${E(CAT_ICON[type.cat] || '')} ${E(type.cat)}${i.role ? ` · <b>${E(i.role)}</b>` : ''}</div></div></div>
      ${opts.status ? `<div class="ug-status ${opts.status.cls || ''}">${opts.status.text}</div>` : ''}
      ${i.blurb ? `<p class="ug-blurb">${E(i.blurb)}</p>` : ''}
      <div class="ug-sec"><h5>Stats${vs ? ` <span class="hint">compared with ${E(shortName(opts.vs))}</span>` : ''}</h5>${statBars(s, { settings: opts.settings, scale: opts.scale, vs })}</div>
      <div class="ug-sec"><h5>Matchups <span class="hint">added to the attacker's roll</span></h5>${matchupHtml(type)}</div>
      ${ab.length || ar.length ? `<div class="ug-sec"><h5>Abilities and traits</h5><ul class="ug-abil">${ab.concat(ar).map(a => `<li${a.good === false ? ' class="bad"' : ''}><span>${a.icon}</span>${E(a.text)}</li>`).join('')}</ul></div>` : ''}
      ${opts.cost ? `<div class="ug-sec"><h5>Cost</h5>${costChips(opts.cost, opts.have)}</div>` : ''}
      ${opts.actions ? `<div class="ug-actions">${opts.actions}</div>` : ''}
    </div>`;
  }

  /** The key to the stats, for the guide's footer. */
  const legendHtml = () => `<dl class="ug-legend">${Object.entries(STAT_HELP).map(([, v]) => { const [k, d] = v.split(': '); return `<dt>${E(k)}</dt><dd>${E(d)}</dd>`; }).join('')}<dt>Matchups</dt><dd>⚔ when it attacks, 🛡 when it is attacked. Green helps it, red hurts it.</dd></dl>`;

  return { INFO, info, counter, counterImg, stats, statBars, STAT_HELP, matchups, matchupHtml, abilities, armourFacts, costChips, shortOf, detailHtml, legendHtml, shortName, CAT_ICON, CAT_LABEL };
})();

if (typeof window !== 'undefined') window.UnitGuide = UnitGuide;
if (typeof module !== 'undefined') module.exports = UnitGuide;
