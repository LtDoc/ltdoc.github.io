'use strict';
const UnitTypes = require('../public/js/units');
const planned = [
  { id: 'medieval', name: 'Medieval Roleplay Pack' },
  { id: 'world-war-2', name: 'World War 2 Roleplay Pack' },
  { id: 'fantasy', name: 'Fantasy Roleplay Pack' },
];
const all = () => [
  ...UnitTypes.PACKS.map(p => ({ ...p, available: true, included: p.id === UnitTypes.DEFAULT_PACK })),
  ...planned.filter(p => !UnitTypes.forPack(p.id)).map(p => ({ ...p, available: false, included: false })),
];
module.exports = { all };
