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
    waiveMovement: false,     // GM switch: nobody is limited
    captureRadiusKm: 60,      // phase 2: territory carved around an advancing land unit
    cityRadiusKm: 150,        // phase 2: district that changes hands with a major city
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
    startStock: { resources: 20, money: 100, manpower: 20, rp: 0 },   // stockpiles when game mode starts
    publicTreasury: false,    // players may see every faction's treasury
  };

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

  return { RESOURCES, RESOURCE_KEYS, byKey, iconUrl, POOLS, FACTORY_ICON, TURN_STEPS, DEFAULT_SETTINGS, OIL_CATEGORIES, OIL_TYPES, stepDate, fmtDate, mergeSettings };
})();

if (typeof window !== 'undefined') window.GameData = GameData;
if (typeof module !== 'undefined') module.exports = GameData;
