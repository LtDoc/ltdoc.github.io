'use strict';

/**
 * Game-layer constants shared by the browser and the server: the ten map resources, default rules,
 * calendar stepping and the derived pools. Keep this file free of DOM and PixiJS.
 */
const GameData = (() => {
  // The ten map resources (see docs/GAME-DESIGN.md §6.1). `glyph` is a short label for drawn icons.
  // `icon` is a file in public/icons/ (128 px painted icons supplied with the project).
  const RESOURCES = [
    { key: 'grain',    name: 'Grain',    glyph: 'Gr', color: '#d4a63a', icon: 'wheat.png' },
    { key: 'coal',     name: 'Coal',     glyph: 'C',  color: '#3b3b3b', icon: 'coal.png' },
    { key: 'iron',     name: 'Iron',     glyph: 'Fe', color: '#8d6e63', icon: 'iron_ore.png' },
    { key: 'oil',      name: 'Oil',      glyph: 'Oi', color: '#1f2d3a', icon: 'oil_raw.png' },
    { key: 'copper',   name: 'Copper',   glyph: 'Cu', color: '#b87333', icon: 'copper_ore.png' },
    { key: 'rubber',   name: 'Rubber',   glyph: 'Ru', color: '#556b2f', icon: 'tree.png' },
    { key: 'nitrates', name: 'Nitrates', glyph: 'N',  color: '#7f8c8d', icon: 'nitre.png' },
    { key: 'timber',   name: 'Timber',   glyph: 'Ti', color: '#2e7d32', icon: 'logs.png' },
    { key: 'cotton',   name: 'Cotton',   glyph: 'Co', color: '#ecf0f1', icon: 'cotton.png' },
    { key: 'horses',   name: 'Horses',   glyph: 'Ho', color: '#a1887f', icon: 'horse.png' },
  ];
  const RESOURCE_KEYS = RESOURCES.map(r => r.key);
  const byKey = Object.fromEntries(RESOURCES.map(r => [r.key, r]));
  const iconUrl = key => (byKey[key] && byKey[key].icon) ? '/icons/' + byKey[key].icon : null;

  // Pools that are not on the map.
  const POOLS = [
    { key: 'money', name: 'Money', glyph: '$', icon: 'cash.png' },
    { key: 'manpower', name: 'Manpower', glyph: 'Mp', icon: null },
    { key: 'rp', name: 'Research', glyph: 'RP', icon: 'paper_roll.png' },
  ];
  const FACTORY_ICON = 'machine_parts.png';

  // Goods made and stored in towns (docs/ECONOMY.md, Goods and unrest): consumer goods keep the towns content, military goods
  // keep the armies supplied. Not map resources: they live in the towns' stores, not in the national stockpile.
  const GOODS = [
    { key: 'consumer', name: 'Consumer goods', short: 'consumer goods', glyph: 'CG', color: '#c0904d', icon: 'soft_furnishings.png' },
    { key: 'military', name: 'Military goods', short: 'military goods', glyph: 'MG', color: '#6b7a3a', icon: 'ammo_boxes.png' },
  ];
  const GOODS_KEYS = GOODS.map(g => g.key);
  /**
   * What a town turns out each turn, consumer and military goods together: goodsBase by size, plus goodsPerIndustry for
   * each point of its industry (the 1914 cities carry 1 to 6) and goodsPerDev for each development level.
   */
  function townOutput(town, settings) {
    const s = settings || DEFAULT_SETTINGS, d = town?.data || {};
    const base = Number((s.goodsBase || {})[d.size] ?? (s.goodsBase || {}).village ?? 1) || 0;
    return Math.round((base + (Number(s.goodsPerIndustry) || 0) * (Number(d.industry) || 0) + (Number(s.goodsPerDev) || 0) * (Number(d.developed) || 0)) * 10) / 10;
  }
  /** A factory's total goods per turn, before the nation's war economy splits them. */
  function factoryOutput(factory, settings) {
    const s = settings || DEFAULT_SETTINGS;
    return Math.max(1, Number(factory?.data?.industry) || 1) * Number(s.factoryOutput ?? 10);
  }
  /** The war economy share (0–100 %) of a nation's town and factory output that goes to military goods. */
  const warEconomyOf = (state, settings) => Math.max(0, Math.min(100, Number(state?.policy?.warEconomy ?? (settings || DEFAULT_SETTINGS).warEconomy ?? 30)));
  /** A Supply Column's, convoy's or fort's pool of supplies when full (null for other units). */
  function poolMax(typeId, settings) {
    const s = settings || DEFAULT_SETTINGS;
    return typeId === 'supply' ? Number(s.columnPool ?? 50) : typeId === 'transport' ? Number(s.convoyPool ?? 100) : typeId === 'fortress' ? Number(s.fortPool ?? 200) : null;
  }

  const TURN_STEPS = { week: 'Week', fortnight: 'Fortnight', month: 'Month', season: 'Season' };

  const DEFAULT_SETTINGS = {
    kmPerMove: 50,            // km (or map units on image maps) per movement point per turn
    noMansLandCost: 3,        // walking across No Man's Land (areas with that tag) costs this many times the distance
    waiveMovement: false,     // GM switch: nobody is limited
    captureRadiusKm: 30,      // phase 2: ground taken around an advancing land unit (halved 27 Sep 2026: one unit should not take a country)
    cityRadiusKm: 75,         // phase 2: district that changes hands with a major city
    occupyNeutrals: true,
    upkeep: false,            // built in, off by default
    // Upkeep (balanced against the 1914 powers' resource regions and armies, docs/ECONOMY.md): each town feeds a home
    // army for free; every unit beyond that eats grain. Ships burn coal, aircraft and motor vehicles oil.
    upkeepFree: { capital: 8, city: 3, village: 1 },   // units each town of a nation supports without grain
    upkeepGrain: 0.2,         // grain per unit per turn beyond the home allowance
    upkeepCoal: 0.25,         // coal per ship (and armoured train) per turn
    upkeepOil: 0.5,           // oil per aircraft, airship, tank, armoured car and submarine per turn
    researchLead: 1,          // phase 4: years ahead of the game date a tech may be researched
    baseMoney: 10,            // per faction per turn, before cities
    baseRp: 5,
    baseManpower: 0,
    cityIncome: {             // per town, by size
      capital: { money: 8, rp: 3, manpower: 3 },
      city:    { money: 4, rp: 1, manpower: 2 },
      village: { money: 1, rp: 0, manpower: 1 },
    },
    factoryIncome: { money: 2, rp: 0, manpower: 0 },   // per factory, times its industry level
    townDevIncome: { money: 3, rp: 1, manpower: 0 },   // per development level of a town (long-term projects)
    resourceImproveRate: 0.25, // each improvement level of a resource node adds this share of its base yield (docs/ECONOMY.md)
    startStock: { resources: 20, money: 100, manpower: 20, rp: 0 },   // stockpiles when game mode starts
    publicTreasury: false,    // players may see every faction's treasury
    factoryRangeKm: 50,       // players may build a factory this close to one of their cities or towns
    coastalKm: 30,            // a city this close to the sea can build ships (Earth map)
    cityCapacity: { capital: 3, city: 2, village: 0 },   // parallel builds per town size (factories use their level)
    trenchRangeKm: 20,        // units this close to a friendly dug trench get cover (and man it: see trenchBlocks)
    trenchBlocks: true,       // enemy land units cannot cross a dug trench where a defender stands within trenchRangeKm
    trenchBonusDug: 2,        // added to defend when attacked
    trenchBonusReinforced: 4,
    capturedIdle: true,       // phase 5: a place that changed hands this turn yields nothing at End turn
    kmPerRange: 50,           // attack reach per range point: infantry (1) 50 km, cavalry (2) 100 km, field artillery (3) 150 km
    wornStep: 20,             // combat: a unit fights at −1 attack and defend for every this much % strength it has lost (0 = off)
    phases: true,             // turns run in two phases: movement (moves, no attacks), then battle (attacks, no moves)
    replenishMax: 50,         // replenishing: strength points a unit can take on in one turn
    replenishEnemyKm: 50,     // replenishing: no enemy (at war) land unit may be this close
    trenchSectionKm: 10,      // trenches: an engineer digs (or reinforces) this much of a trench per turn
    trenchDigKm: 20,          // trenches: engineers dig and sappers blow up trench within this distance of themselves
    trenchDigTimber: 4,       // trenches: timber per section dug…
    trenchReinforceTimber: 6, // …and per section reinforced
    trenchDemolishDefence: 2, // trenches: added to the defender's roll against sappers (plus the trench's cover and its best guard)
    blockadeKm: 50,           // naval: enemy warships this close to a coastal town, with none of its side's, blockade it (no supply from it)
    subDetectKm: 20,          // naval: a submerged submarine is seen only by destroyers this close
    corpsDepthKm: 15,         // corps lines: artillery forms up this far behind the front line, support twice as far
    heroAuraKm: 60,           // heroes: a general's bonus reaches friendly units this close
    diplomatsRequired: true,  // heroes: peace offers and alliance proposals need a diplomat posted to the other nation
    spySecurity: 0,           // heroes: added to the defender's roll when no spy of theirs is near a mission
    spyCounterKm: 150,        // heroes: a nation's spies within this distance contest a foreign mission
    spyStealPerStar: 5,       // heroes: research points a successful theft takes per star
    supplyEnabled: true,      // supply (docs/UNITS.md): land units are linked or cut off (kept live) and carry a few turns of supplies
    supplyTownKm: 30,         // supply: land units this close to a friendly town are supplied directly (garrison)
    supplyLinkBySize: { capital: 600, city: 400, village: 200 },   // supply: a place feeds a Supply Column this close, by size
    supplyLinkKm: 150,        // supply: a Supply Column this close to a railhead or another linked column is linked too
    supplyRangeKm: 100,       // supply: a linked Supply Column supplies land units this close (its stretch of front)
    supplyStock: 3,           // supply: turns of supplies a land unit carries; it uses one at each End turn cut off, topped up when linked again
    attritionRate: 25,        // supply: a unit cut off with no supplies left loses this % of its remaining strength at each End turn…
    attritionDisbandBelow: 10, // …and surrenders below this %
    convoyLinkKm: 200,        // supply: a convoy (transport ships) feeds Supply Columns this close, anywhere (invasions)
    convoyRangeKm: 100,       // supply: a convoy supplies land units this close (a beachhead)
    hospitalKm: 40,           // support: field hospitals heal friendly units this close at End turn…
    hospitalHeal: 10,         // …by this much strength (%)
    hqKm: 40, hqBonus: 1,     // support: headquarters add attack and defend to friendly units this close
    engineerKm: 20, engineerDefend: 1,   // support: engineers, pioneers and sappers add defend to units this close
    signalsKm: 60, signalsArtillery: 1,  // support: signals add attack to friendly artillery this close (spotting)
    railSpeed: 4,             // railways: land units and heroes move this many times faster along open track
    railCutKm: 10,            // railways: a successful attack closes this much track either side of the hit
    railDefence: 4,           // railways: added to the line's d20 when attacked (plus its best guard's defend)
    railGuardKm: 30,          // railways: the holder's land units this close to a section guard it
    railRepairKm: 30,         // railways: a unit this close to a break can repair it (uses its action)
    railJoinKm: 20,           // railways: a line's end this close to other track joins it (inner points: 5 km; crossings always join)
    convoyCapacity: 10,       // convoys: units a transport carries
    convoyBoardKm: 30,        // convoys: units this close to a transport can embark
    convoyLandKm: 100,        // convoys: troops land on the nearest beach this close, or not at all
    fogOfWar: false,          // fog of war (docs/FOG-OF-WAR.md): other sides' units are seen only within sight
    subSpotKm: 20,            // fog of war: submarines are spotted only this close to a vision source
    // Fog of war: how far each unit sees (km), by type where listed, else by category; places by size; heroes.
    // Goods and unrest (docs/ECONOMY.md). Balanced against the 1914 powers' bundled cities (industry 1–6): Germany's 21
    // cities turn out about 290 goods a turn, France's 12 about 145; at a 50 % war economy that is 143 and 72 military
    // goods against field armies of 98 and 88 divisions drawing one supply each.
    goodsEnabled: true,       // goods: towns make and store consumer and military goods; supply draws on them
    goodsBase: { capital: 6, city: 2, village: 1 },   // goods: output a turn by size…
    goodsPerIndustry: 4,      // …plus this per point of the town's industry…
    goodsPerDev: 2,           // …and this per development level
    factoryOutput: 10,        // goods: total goods a factory makes a turn per industry level, split by war economy
    warEconomy: 30,           // goods: share (%) of town and factory output that is military goods, until a nation sets its own
    consumerNeed: 0.5,        // goods: consumer goods a town consumes a turn, as a share of its output
    goodsStoreTurns: 12,      // goods: a town stores at most this many turns of its output of each good
    goodsStartTurns: 4,       // goods: a town's stores when first counted: this many turns of half its output, of each good
    goodsLinkKm: 500,         // goods: a nation's towns this close share their stores (not across enemy ground); further, by railway
    unitDraw: 1,              // goods: supplies a supplied land unit draws a turn (from its town, column or convoy)
    columnPool: 50,           // goods: supplies a Supply Column carries for itself and the units it supplies
    convoyPool: 100,          // goods: supplies a convoy carries
    convoyLoadKm: 50,         // goods: a convoy this close to a town of its nation refills from it at End turn
    salvageKm: 30,            // goods: a Supply Column this close to a destroyed one can take what it carried
    rebellions: true,         // unrest: towns in critical unrest for too long rise in revolt
    unrestRise: 25,           // unrest: points a turn when a town gets none of its consumer goods (less when partly covered)
    unrestFall: 10,           // unrest: points a turn it falls when its needs are met
    unrestCritical: 75,       // unrest: critical from here…
    unrestGrace: 3,           // …and the town revolts after this many more End turns still critical
    rebelProvinces: { capital: 6, city: 3, village: 1 },   // rebellion: provinces that go over with the town
    rebelMilitia: { capital: 4, city: 2, village: 1 },     // rebellion: militia raised round the town
    rebelRadiusKm: 200,       // rebellion: provinces this close (the nearest first)
    fortPool: 200,            // forts: supplies a fort stores, for the units round it and the columns it feeds (refilled from its nation's towns)
    fortLinkKm: 200,          // forts: a fort feeds Supply Columns this close, as a village does
    fortRifleRange: 1,        // forts: the garrison's rifles reach this many range points (kmPerRange each); the guns reach the fort's range
    railBuildKm: 15,          // railways: track engineers (and railway troops) lay a turn on a planned line
    railBuildIron: 5,         // railways: iron a section costs…
    railBuildTimber: 5,       // …and timber
    vision: { Infantry: 50, Support: 50, Artillery: 30, Emplacements: 40, 'Mounted & mobile': 80, Naval: 80, Air: 150,
      reconnaissance: 120, tank: 40, armouredtrain: 40, submarine: 30, reconair: 250, airship: 250, balloon: 100,
      hero: 50, capital: 100, city: 60, village: 30 },
  };

  // ---- Deadlines ---------------------------------------------------------------------------
  /**
   * The turn deadline is stored as text. When it parses as a date it is shown as a countdown; anything else
   * ("ends Sunday 8pm") is shown as written. Returns { text, title, at (ms) | null, overdue }.
   */
  function deadlineInfo(deadline, nowMs) {
    const s = String(deadline || '').trim();
    if (!s) return null;
    const at = /^\d{4}-\d{2}-\d{2}T/.test(s) ? Date.parse(s) : NaN;
    if (!Number.isFinite(at)) return { text: s, title: s, at: null, overdue: false };
    const now = nowMs || Date.now();
    const d = new Date(at);
    const title = d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const left = at - now;
    let text;
    if (left <= 0) text = 'deadline passed';
    else if (left < 3600e3) text = `ends in ${Math.max(1, Math.round(left / 60e3))} min`;
    else if (left < 48 * 3600e3) { const h = Math.floor(left / 3600e3), m = Math.floor((left % 3600e3) / 60e3); text = `ends in ${h}h${m ? ` ${m}m` : ''}`; }
    else text = `ends in ${Math.round(left / 86400e3)} days`;
    return { text, title: `Turn deadline: ${title}`, at, overdue: left <= 0 };
  }

  // ---- Production costs ----------------------------------------------------------------------
  // Per unit type: resources, money, manpower and build time in turns. Campaigns override per type via
  // settings.unitCosts = { typeId: { grain: n, ..., money: n, manpower: n, turns: n } } (only the keys given).
  const COST_KEYS = [...RESOURCE_KEYS, 'money', 'manpower', 'turns'];
  const c = (o) => o;
  const DEFAULT_COSTS = {
    infantry: c({ grain: 10, cotton: 5, money: 20, manpower: 3, turns: 1 }),
    stormtroopers: c({ grain: 10, cotton: 6, nitrates: 3, money: 35, manpower: 3, turns: 2 }),
    mountain: c({ grain: 10, cotton: 6, money: 25, manpower: 3, turns: 1 }),
    marines: c({ grain: 10, cotton: 6, money: 30, manpower: 3, turns: 2 }),
    conscripts: c({ grain: 6, cotton: 3, money: 10, manpower: 4, turns: 1 }),
    militia: c({ grain: 6, cotton: 3, money: 8, manpower: 2, turns: 1 }),
    colonial: c({ grain: 8, cotton: 4, money: 15, manpower: 2, turns: 1 }),
    bicycle: c({ grain: 8, cotton: 4, iron: 3, money: 25, manpower: 2, turns: 1 }),
    machinegun: c({ iron: 5, copper: 3, nitrates: 2, money: 30, manpower: 1, turns: 1 }),
    cavalry: c({ grain: 10, horses: 8, cotton: 4, money: 30, manpower: 2, turns: 1 }),
    dragoons: c({ grain: 10, horses: 8, cotton: 4, money: 30, manpower: 2, turns: 1 }),
    lancers: c({ grain: 10, horses: 8, cotton: 4, iron: 2, money: 32, manpower: 2, turns: 1 }),
    hussars: c({ grain: 10, horses: 9, cotton: 5, money: 32, manpower: 2, turns: 1 }),
    camelry: c({ grain: 8, cotton: 4, money: 25, manpower: 2, turns: 1 }),
    reconnaissance: c({ grain: 5, horses: 4, money: 20, manpower: 1, turns: 1 }),
    armouredcar: c({ iron: 8, oil: 3, rubber: 3, money: 50, manpower: 1, turns: 2 }),
    tank: c({ iron: 15, coal: 10, oil: 5, rubber: 5, money: 80, manpower: 2, turns: 2 }),
    armouredtrain: c({ iron: 20, coal: 10, money: 90, manpower: 2, turns: 3 }),
    fieldartillery: c({ iron: 8, copper: 4, nitrates: 4, horses: 4, money: 40, manpower: 1, turns: 1 }),
    horseartillery: c({ iron: 8, copper: 4, nitrates: 4, horses: 8, money: 45, manpower: 1, turns: 1 }),
    heavyartillery: c({ iron: 15, copper: 6, nitrates: 6, horses: 4, money: 60, manpower: 1, turns: 2 }),
    siegeartillery: c({ iron: 25, copper: 8, nitrates: 8, money: 90, manpower: 1, turns: 3 }),
    railwaygun: c({ iron: 40, coal: 10, nitrates: 10, money: 150, manpower: 1, turns: 4 }),
    mortar: c({ iron: 5, nitrates: 4, money: 25, manpower: 1, turns: 1 }),
    antiaircraft: c({ iron: 8, copper: 5, nitrates: 3, money: 45, manpower: 1, turns: 2 }),
    coastal: c({ iron: 25, copper: 5, nitrates: 5, money: 80, manpower: 1, turns: 3 }),
    fortress: c({ iron: 30, coal: 10, nitrates: 6, timber: 10, money: 110, manpower: 1, turns: 4 }),
    mgbunker: c({ iron: 10, timber: 6, copper: 2, money: 40, manpower: 1, turns: 2 }),
    aaemplacement: c({ iron: 12, copper: 6, nitrates: 3, money: 55, manpower: 1, turns: 2 }),
    hq: c({ money: 40, manpower: 1, turns: 1 }),
    engineers: c({ timber: 8, iron: 4, money: 30, manpower: 2, turns: 1 }),
    sappers: c({ timber: 6, iron: 4, nitrates: 2, money: 30, manpower: 2, turns: 1 }),
    pioneers: c({ timber: 8, iron: 3, money: 25, manpower: 2, turns: 1 }),
    signals: c({ copper: 6, money: 30, manpower: 1, turns: 1 }),
    supply: c({ horses: 6, timber: 4, grain: 5, money: 20, manpower: 1, turns: 1 }),
    medical: c({ cotton: 6, money: 30, manpower: 1, turns: 1 }),
    gas: c({ nitrates: 8, copper: 2, money: 45, manpower: 1, turns: 2 }),
    railway: c({ iron: 8, timber: 6, money: 35, manpower: 2, turns: 1 }),
    labour: c({ grain: 6, money: 10, manpower: 3, turns: 1 }),
    fighter: c({ timber: 6, cotton: 4, rubber: 2, oil: 3, money: 60, manpower: 1, turns: 2 }),
    bomber: c({ timber: 10, cotton: 6, rubber: 3, oil: 5, money: 90, manpower: 1, turns: 3 }),
    reconair: c({ timber: 6, cotton: 4, rubber: 2, oil: 3, money: 50, manpower: 1, turns: 2 }),
    seaplane: c({ timber: 6, cotton: 4, rubber: 2, oil: 3, money: 60, manpower: 1, turns: 2 }),
    balloon: c({ cotton: 8, money: 25, manpower: 1, turns: 1 }),
    airship: c({ cotton: 15, rubber: 4, oil: 4, money: 120, manpower: 1, turns: 4 }),
    dreadnought: c({ iron: 40, coal: 30, copper: 10, money: 200, manpower: 3, turns: 6 }),
    predreadnought: c({ iron: 30, coal: 20, copper: 6, money: 120, manpower: 3, turns: 4 }),
    battlecruiser: c({ iron: 35, coal: 30, copper: 8, money: 180, manpower: 3, turns: 5 }),
    armouredcruiser: c({ iron: 25, coal: 15, copper: 5, money: 110, manpower: 2, turns: 4 }),
    lightcruiser: c({ iron: 15, coal: 10, copper: 4, money: 70, manpower: 2, turns: 3 }),
    destroyer: c({ iron: 10, coal: 8, copper: 2, money: 50, manpower: 1, turns: 2 }),
    torpedoboat: c({ iron: 6, coal: 4, money: 30, manpower: 1, turns: 1 }),
    submarine: c({ iron: 12, copper: 4, oil: 4, money: 70, manpower: 1, turns: 3 }),
    minelayer: c({ iron: 8, coal: 6, nitrates: 4, money: 45, manpower: 1, turns: 2 }),
    gunboat: c({ iron: 8, coal: 5, money: 40, manpower: 1, turns: 2 }),
    transport: c({ timber: 15, coal: 8, money: 50, manpower: 1, turns: 2 }),
    seaplanecarrier: c({ iron: 20, coal: 12, money: 120, manpower: 2, turns: 4 }),
    factory: c({ iron: 15, timber: 10, money: 80, manpower: 2, turns: 2 }),   // a new production site
  };
  /** Full cost row for a type (every key present) after applying campaign overrides. */
  function costFor(typeId, overrides) {
    const base = DEFAULT_COSTS[typeId] || { money: 30, manpower: 1, turns: 1 };
    const o = (overrides && overrides[typeId]) || {};
    const out = {};
    for (const k of COST_KEYS) out[k] = Number.isFinite(Number(o[k])) ? Number(o[k]) : (base[k] || 0);
    out.turns = Math.max(1, Math.round(out.turns || 1));
    return out;
  }
  /** Short "10 grain, 5 cotton, 20 money, 3 manpower · 1 turn" text. */
  function costLabel(cost) {
    const parts = [];
    for (const k of RESOURCE_KEYS) if (cost[k]) parts.push(`${cost[k]} ${byKey[k].name.toLowerCase()}`);
    if (cost.money) parts.push(`${cost.money} money`);
    if (cost.manpower) parts.push(`${cost.manpower} manpower`);
    return `${parts.join(', ') || 'free'} · ${cost.turns} turn${cost.turns === 1 ? '' : 's'}`;
  }

  // ---- Long-term projects (docs/ECONOMY.md) -----------------------------------------------------
  /**
   * Development projects queued like builds at a site the faction owns. Each step costs more and takes longer
   * than the one before, so they pay back over many turns rather than fixing this month's shortfall.
   *   upgradeFactory: industry level 1 → 5; each level adds factory income and one build slot.
   *   developTown:    development 0 → max by size; each level adds townDevIncome, every second one a build slot.
   *   improveResource: improvements 0 → 3 at a resource node; each adds resourceImproveRate of its base yield. The
   *                    cost grows with the node's yield (perYield), so a rich field costs more to improve than a small
   *                    deposit and pays back about as fast.
   * `step` is how many steps the site has already taken (factory: level − 1; town: its development level).
   */
  const PROJECTS = {
    upgradeFactory: {
      label: 'Upgrade factory', verb: 'Upgrade', max: () => 5,
      base: { iron: 12, coal: 6, timber: 6, money: 50, manpower: 1, turns: 3 },
      step: { iron: 6, coal: 4, money: 30, turns: 1 },
    },
    developTown: {
      label: 'Develop town', verb: 'Develop', max: size => ({ capital: 5, city: 4, village: 2 }[size] ?? 2),
      base: { timber: 10, iron: 5, grain: 8, money: 60, manpower: 2, turns: 4 },
      step: { timber: 5, iron: 3, money: 40, manpower: 1, turns: 2 },
    },
    improveResource: {
      label: 'Improve works', verb: 'Improve', max: () => 3,
      base: { iron: 6, timber: 6, money: 30, manpower: 1, turns: 3 },
      step: { iron: 4, timber: 2, money: 20, turns: 1 },
      perYield: { money: 6, iron: 1 },
    },
  };
  /** What each improvement level of a resource node is called, by resource (levels 1–3). */
  const RESOURCE_WORKS = {
    grain: ['Mechanised farms', 'Granaries', 'Rail siding'],
    coal: ['Deeper shafts', 'Coking ovens', 'Colliery railway'],
    iron: ['Steam shovels', 'Ore railway', 'Blast furnaces'],
    oil: ['More derricks', 'Pipeline', 'Refinery'],
    copper: ['Steam shovels', 'Concentrator', 'Smelter'],
    rubber: ['New plantings', 'Tapping gangs', 'Processing sheds'],
    nitrates: ['Oficina', 'Leaching vats', 'Nitrate railway'],
    timber: ['Sawmill', 'Logging railway', 'Pulp mill'],
    cotton: ['Gin house', 'Irrigation', 'Baling press'],
    horses: ['Stud farm', 'Paddocks', 'Remount depot'],
  };
  const worksName = (kind, level) => (RESOURCE_WORKS[kind] || RESOURCE_WORKS.grain)[Math.max(1, Math.min(3, level)) - 1];
  /** A resource node's yield a turn with its improvements (to a tenth). */
  function resourceYield(marker, settings) {
    const base = Number(marker?.data?.yield) || 0, lvl = Math.max(0, Math.min(3, Math.round(Number(marker?.data?.improved) || 0)));
    const rate = Number(settings?.resourceImproveRate ?? 0.25);
    return Math.round(base * (1 + rate * lvl) * 10) / 10;
  }
  /** The project a marker can take (by type), or null. */
  function projectFor(marker) { return marker?.type === 'factory' ? 'upgradeFactory' : marker?.type === 'town' ? 'developTown' : marker?.type === 'resource' ? 'improveResource' : null; }
  /** Current level, steps taken and maximum for a factory, town or resource marker. */
  function projectLevel(marker) {
    const id = projectFor(marker);
    if (!id) return null;
    if (id === 'upgradeFactory') { const level = Math.max(1, Math.round(Number(marker.data?.industry) || 1)); return { id, level, step: level - 1, max: 5 }; }
    if (id === 'improveResource') { const level = Math.max(0, Math.min(3, Math.round(Number(marker.data?.improved) || 0))); return { id, level, step: level, max: 3 }; }
    const level = Math.max(0, Math.round(Number(marker.data?.developed) || 0));
    return { id, level, step: level, max: PROJECTS.developTown.max(marker.data?.size) };
  }
  /** Full cost row of the next step (before research discounts); `site` (the marker) for costs that grow with its yield. */
  function projectCost(id, step, site) {
    const p = PROJECTS[id];
    const out = {}, y = Number(site?.data?.yield) || 0;
    for (const k of COST_KEYS) out[k] = Math.round((p.base[k] || 0) + (p.step[k] || 0) * Math.max(0, step) + (p.perYield?.[k] || 0) * y);
    out.turns = Math.max(1, Math.round(out.turns || 1));
    return out;
  }
  /** Extra build slots a town's development gives (one per two levels). */
  const devSlots = developed => Math.floor((Number(developed) || 0) / 2);

  /**
   * Fuel under upkeep: 'oil' for aircraft, tanks, armoured cars and submarines; 'coal' for every other ship and the
   * armoured train (1914 navies burned coal); null for units that march or ride.
   */
  const OIL_CATEGORIES = new Set(['Air']);
  const OIL_TYPES = new Set(['tank', 'armouredcar', 'submarine']);
  const COAL_TYPES = new Set(['armouredtrain']);
  function fuelOf(type) {
    if (!type) return null;
    if (OIL_CATEGORIES.has(type.cat) || OIL_TYPES.has(type.id)) return 'oil';
    if (type.cat === 'Naval' || COAL_TYPES.has(type.id)) return 'coal';
    return null;
  }

  /** Advance an ISO date (YYYY-MM-DD) by one turn step. */
  function stepDate(iso, step) {
    const d = new Date(iso + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return iso;
    if (step === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
    else if (step === 'season') d.setUTCMonth(d.getUTCMonth() + 3);
    else d.setUTCDate(d.getUTCDate() + (step === 'fortnight' ? 14 : 7));
    return d.toISOString().slice(0, 10);
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return String(iso || '');
    return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  }

  /** Deep-ish merge of settings: objects one level down (cityIncome, factoryIncome, startStock) merge too. */
  function mergeSettings(base, patch) {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
        out[k] = { ...base[k] };
        for (const [k2, v2] of Object.entries(v)) {
          out[k][k2] = (v2 && typeof v2 === 'object' && base[k][k2] && typeof base[k][k2] === 'object') ? { ...base[k][k2], ...v2 } : v2;
        }
      } else out[k] = v;
    }
    return out;
  }

  return { RESOURCES, RESOURCE_KEYS, byKey, iconUrl, POOLS, FACTORY_ICON, GOODS, GOODS_KEYS, townOutput, factoryOutput, warEconomyOf, poolMax, TURN_STEPS, DEFAULT_SETTINGS, OIL_CATEGORIES, OIL_TYPES, fuelOf, stepDate, fmtDate, mergeSettings, deadlineInfo,
    COST_KEYS, DEFAULT_COSTS, costFor, costLabel, PROJECTS, projectFor, projectLevel, projectCost, devSlots, RESOURCE_WORKS, worksName, resourceYield };
})();

if (typeof window !== 'undefined') window.GameData = GameData;
if (typeof module !== 'undefined') module.exports = GameData;
