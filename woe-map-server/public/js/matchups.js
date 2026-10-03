'use strict';
/**
 * Unit matchups (docs/UNITS.md): strengths and weaknesses of one unit type attacking another, added to the
 * attacker's roll. Shared by the server (combat) and the browser (attack picker, unit popups).
 *
 *   Matchups.matchup(attackerType, defenderType, { entrenched }) → { mod, notes: [{ mod, text }] }
 *   Matchups.describe(type)  → { strong: [text], weak: [text] } for a unit's popup
 *
 * Types are catalogue entries from public/js/units.js ({ id, cat }). Rules match an attacker and a defender by
 * type id, category or "entrenched" (the defender has trench cover). Every matching rule applies; the total is
 * capped at ±MAX so no pairing becomes hopeless.
 */
(function (root) {
  const MAX = 5;
  const CAVALRY = ['cavalry', 'dragoons', 'lancers', 'hussars', 'camelry', 'reconnaissance'];
  const BATTLESHIPS = ['dreadnought', 'predreadnought', 'battlecruiser', 'armouredcruiser'];
  const SPOTTERS = ['reconair', 'balloon'];
  // a / d: { ids: [...] } or { cat } or { entrenched: true }; `not` excludes ids.
  const RULES = [
    // Cavalry: shock and pursuit, helpless against wire, trenches and machine guns.
    { a: { ids: CAVALRY }, d: { entrenched: true }, mod: -3, text: 'cavalry against entrenched troops' },
    { a: { ids: CAVALRY }, d: { ids: ['machinegun', 'mgbunker'] }, mod: -3, text: 'cavalry against machine guns' },
    { a: { ids: CAVALRY }, d: { cat: 'Artillery' }, mod: 3, text: 'cavalry overruns the guns' },
    { a: { ids: CAVALRY }, d: { cat: 'Support' }, mod: 2, text: 'cavalry raids the rear' },
    // Infantry.
    { a: { cat: 'Infantry', not: ['machinegun'] }, d: { ids: ['machinegun', 'mgbunker'] }, mod: -2, text: 'infantry into machine guns' },
    { a: { ids: ['stormtroopers'] }, d: { entrenched: true }, mod: 2, text: 'infiltration tactics' },
    { a: { ids: ['machinegun'] }, d: { ids: CAVALRY }, mod: 2, text: 'machine guns against horsemen' },
    // Armour.
    { a: { ids: ['tank'] }, d: { entrenched: true }, mod: 2, text: 'tanks cross the wire' },
    { a: { ids: ['tank'] }, d: { ids: ['machinegun', 'mgbunker'] }, mod: 2, text: 'tanks are proof against machine guns' },
    { a: { ids: ['tank'] }, d: { cat: 'Artillery', not: ['antiaircraft'] }, mod: -1, text: 'field guns firing over open sights' },
    { a: { ids: ['armouredcar'] }, d: { entrenched: true }, mod: -2, text: 'armoured cars are road-bound' },
    { a: { ids: ['armouredcar'] }, d: { ids: CAVALRY }, mod: 2, text: 'armoured cars against horsemen' },
    // Artillery and specialists against fieldworks.
    { a: { ids: ['fieldartillery', 'horseartillery'] }, d: { entrenched: true }, mod: 1, text: 'preparatory bombardment' },
    { a: { ids: ['heavyartillery', 'siegeartillery', 'railwaygun', 'mortar'] }, d: { entrenched: true }, mod: 2, text: 'heavy shells against fieldworks' },
    { a: { ids: ['gas'] }, d: { entrenched: true }, mod: 2, text: 'gas settles in the trenches' },
    { a: { ids: ['sappers'] }, d: { entrenched: true }, mod: 2, text: 'mines under the enemy line' },
    { a: { ids: ['coastal', 'fortress'] }, d: { cat: 'Naval' }, mod: 2, text: 'coastal guns against ships' },
    { a: { ids: ['heavyartillery', 'siegeartillery', 'railwaygun'] }, d: { cat: 'Emplacements' }, mod: 1, text: 'heavy shells against concrete' },
    // Air.
    { a: { ids: ['antiaircraft', 'aaemplacement'] }, d: { cat: 'Air' }, mod: 4, text: 'anti-aircraft fire' },
    { a: { cat: 'Air' }, d: { ids: ['antiaircraft', 'aaemplacement'] }, mod: -2, text: 'flying into flak' },
    { a: { ids: ['fighter'] }, d: { ids: ['bomber', 'airship', ...SPOTTERS] }, mod: 2, text: 'fighters hunt bombers and spotters' },
    { a: { cat: 'Infantry' }, d: { cat: 'Air' }, mod: -3, text: 'rifles against aircraft' },
    { a: { cat: 'Mounted & mobile' }, d: { cat: 'Air' }, mod: -3, text: 'ground troops against aircraft' },
    // Sea.
    { a: { ids: ['submarine'] }, d: { ids: ['transport', 'minelayer'] }, mod: 3, text: 'U-boats against merchantmen' },
    { a: { ids: ['submarine'] }, d: { ids: BATTLESHIPS }, mod: 2, text: 'torpedoes against capital ships' },
    { a: { ids: ['torpedoboat'] }, d: { ids: BATTLESHIPS }, mod: 2, text: 'torpedo attack' },
    { a: { ids: ['destroyer'] }, d: { ids: ['submarine', 'torpedoboat'] }, mod: 3, text: 'destroyers hunt submarines and torpedo boats' },
    { a: { ids: BATTLESHIPS }, d: { ids: ['destroyer', 'torpedoboat'] }, mod: -1, text: 'big guns against fast small ships' },
  ];

  function hits(side, type, entrenched) {
    if (!type) return false;
    if (side.not && side.not.includes(type.id)) return false;
    if (side.entrenched) return !!entrenched;
    if (side.ids) return side.ids.includes(type.id);
    if (side.cat) return type.cat === side.cat;
    return false;
  }

  /** Attack modifier for `att` attacking `def` ({ entrenched } = the defender has trench cover). */
  function matchup(att, def, { entrenched = false } = {}) {
    const notes = [];
    if (def?.cat === 'Emplacements') entrenched = true;   // fixed works count as dug in
    for (const r of RULES) if (hits(r.a, att, false) && hits(r.d, def, entrenched)) notes.push({ mod: r.mod, text: r.text });
    const raw = notes.reduce((s, n) => s + n.mod, 0);
    return { mod: Math.max(-MAX, Math.min(MAX, raw)), notes };
  }

  /** What a type is good and bad at, for its popup. */
  function describe(type) {
    const strong = [], weak = [];
    if (!type) return { strong, weak };
    for (const r of RULES) {
      if (hits(r.a, type, false)) (r.mod > 0 ? strong : weak).push(`${r.mod > 0 ? '+' : ''}${r.mod} attacking: ${r.text}`);
      else if (!r.d.entrenched && hits(r.d, type, false)) (r.mod > 0 ? weak : strong).push(`${r.mod > 0 ? '+' : ''}${r.mod} for attackers: ${r.text}`);
    }
    return { strong, weak };
  }

  const api = { RULES, MAX, matchup, describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Matchups = api;
})(typeof window !== 'undefined' ? window : globalThis);
