'use strict';

const UnitTypes = require('../public/js/units');

function stat(unit, key, overrides) {
  const value = unit?.data?.[key];
  if (value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value))) return Math.max(0, Number(value));
  const defaultValue = UnitTypes.defaults(unit?.data?.unitType, overrides)?.[key];
  return defaultValue ?? (key === 'penetration' ? 1 : 0);
}

function canPenetrate(attacker, defender, overrides) {
  return stat(attacker, 'penetration', overrides) >= stat(defender, 'armourClass', overrides);
}

module.exports = { stat, canPenetrate };
