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

  const TURN_STEPS = { week: 'Week', fortnight: 'Fortnight', month: 'Month', season: 'Season' };

  const DEFAULT_SETTINGS = {
    kmPerMove: 50,            // km (or map units on image maps) per movement point per turn
    noMansLandCost: 3,        // walking across No Man's Land (areas with that tag) costs this many times the distance
    terrain: true,            // hills and mountains (docs/TERRAIN.md): movement, combat, supply and sight
    hillsMoveCost: 1.5,       // walking across hills costs this many times the distance (mountain troops: 1)
    mountainMoveCost: 4,      // walking across mountains costs this many times the distance; tanks and artillery cannot enter
    mountainTroopsCost: 1,    // mountain troops in the mountains
    hillsDefend: 1,           // defend bonus on hills attacked from flat ground (higher ground: the difference counts)
    mountainsDefend: 2,       // defend bonus in mountains attacked from flat ground (from hills: 2 − 1 = +1)
    supplyMountainKm: 10,     // a supply line may cross this many km of mountains (railways carry supply through regardless)
    mountainTroopsSupplyKm: 50,   // … or this many when it ends at mountain troops
    waiveMovement: false,     // GM switch: nobody is limited
    captureRadiusKm: 30,      // phase 2: ground taken around an advancing land unit (halved 27 Sep 2026: one unit should not take a country)
    cityRadiusKm: 75,         // phase 2: district that changes hands with a major city
    occupyNeutrals: true,
    upkeep: false,            // built in, off by default
    upkeepGrain: 1,           // per unit per turn when upkeep is on
    upkeepOil: 1,             // per vehicle, aircraft or ship per turn when upkeep is on
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
    startStock: { resources: 20, money: 100, manpower: 20, rp: 0 },   // stockpiles when game mode starts
    publicTreasury: false,    // players may see every faction's treasury
    factoryRangeKm: 50,       // players may build a factory this close to one of their cities or towns
    coastalKm: 30,            // a city this close to the sea can build ships (Earth map)
    cityCapacity: { capital: 3, city: 2, village: 0 },   // parallel builds per town size (factories use their level)
    trenchRangeKm: 20,        // units this close to a friendly dug trench get cover
    trenchBonusDug: 2,        // added to defend when attacked
    trenchBonusReinforced: 4,
    capturedIdle: true,       // phase 5: a place that changed hands this turn yields nothing at End turn
    kmPerRange: 50,           // attack reach per range point: infantry (1) 50 km, cavalry (2) 100 km, field artillery (3) 150 km
    heroAuraKm: 60,           // heroes: a general's bonus reaches friendly units this close
    diplomatsRequired: true,  // heroes: peace offers and alliance proposals need a diplomat posted to the other nation
    spySecurity: 0,           // heroes: added to the defender's roll when no spy of theirs is near a mission
    spyCounterKm: 150,        // heroes: a nation's spies within this distance contest a foreign mission
    spyStealPerStar: 5,       // heroes: research points a successful theft takes per star
    supplyEnabled: true,      // supply (docs/UNITS.md): land units are supplied or cut off, decided at End turn
    supplyTownKm: 30,         // supply: land units this close to a friendly town are supplied directly (garrison)
    supplyLinkBySize: { capital: 600, city: 400, village: 200 },   // supply: a place feeds a Supply Column this close, by size
    supplyLinkKm: 150,        // supply: a Supply Column this close to a railhead or another linked column is linked too
    supplyRangeKm: 100,       // supply: a linked Supply Column supplies land units this close (its stretch of front)
    attritionRate: 25,        // supply: a unit cut off for a second End turn (and each after) loses this % of its remaining strength…
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
  };
  /** The project a marker can take (by type), or null. */
  function projectFor(marker) { return marker?.type === 'factory' ? 'upgradeFactory' : marker?.type === 'town' ? 'developTown' : null; }
  /** Current level, steps taken and maximum for a factory or town marker. */
  function projectLevel(marker) {
    const id = projectFor(marker);
    if (!id) return null;
    if (id === 'upgradeFactory') { const level = Math.max(1, Math.round(Number(marker.data?.industry) || 1)); return { id, level, step: level - 1, max: 5 }; }
    const level = Math.max(0, Math.round(Number(marker.data?.developed) || 0));
    return { id, level, step: level, max: PROJECTS.developTown.max(marker.data?.size) };
  }
  /** Full cost row of the next step (before research discounts). */
  function projectCost(id, step) {
    const p = PROJECTS[id];
    const out = {};
    for (const k of COST_KEYS) out[k] = (p.base[k] || 0) + (p.step[k] || 0) * Math.max(0, step);
    out.turns = Math.max(1, Math.round(out.turns || 1));
    return out;
  }
  /** Extra build slots a town's development gives (one per two levels). */
  const devSlots = developed => Math.floor((Number(developed) || 0) / 2);

  /** Unit categories that burn oil under upkeep, plus specific land vehicle types. */
  const OIL_CATEGORIES = new Set(['Air', 'Naval']);
  const OIL_TYPES = new Set(['tank', 'armouredcar', 'armouredtrain']);

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

  return { RESOURCES, RESOURCE_KEYS, byKey, iconUrl, POOLS, FACTORY_ICON, TURN_STEPS, DEFAULT_SETTINGS, OIL_CATEGORIES, OIL_TYPES, stepDate, fmtDate, mergeSettings, deadlineInfo,
    COST_KEYS, DEFAULT_COSTS, costFor, costLabel, PROJECTS, projectFor, projectLevel, projectCost, devSlots };
})();

if (typeof window !== 'undefined') window.GameData = GameData;
if (typeof module !== 'undefined') module.exports = GameData;
