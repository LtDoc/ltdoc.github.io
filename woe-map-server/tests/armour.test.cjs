'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const UnitTypes = require('../public/js/units');
const armour = require('../server/armour');

const unit = (unitType, data = {}) => ({ data: { unitType, ...data } });

test('infantry cannot damage a battleship, but capital guns can', () => {
  const infantry = unit('infantry');
  const battleship = unit('dreadnought');
  const coastal = unit('coastal');
  assert.equal(armour.canPenetrate(infantry, battleship), false);
  assert.equal(armour.canPenetrate(coastal, battleship), true);
  assert.equal(armour.canPenetrate(battleship, coastal), true);
  assert.equal(armour.canPenetrate(battleship, infantry), true);
});

test('penetration meets armour at equality and respects individual stats', () => {
  assert.equal(armour.canPenetrate(unit('Custom', { penetration: 4 }), unit('Custom', { armourClass: 4 })), true);
  assert.equal(armour.canPenetrate(unit('Custom', { penetration: 3 }), unit('Custom', { armourClass: 4 })), false);
  assert.equal(armour.canPenetrate(unit('infantry', { penetration: 11 }), unit('dreadnought')), true);
});

test('legacy units use campaign defaults and five-column overrides retain catalogue armour', () => {
  const oldOverride = { infantry: [4, 4, 1, 1, 2] };
  assert.equal(UnitTypes.defaults('infantry', oldOverride).penetration, 1);
  assert.equal(UnitTypes.defaults('dreadnought').armourClass, 10);
  assert.equal(armour.canPenetrate(unit('infantry'), unit('dreadnought'), oldOverride), false);
  const edited = { infantry: [4, 4, 1, 1, 2, 0, 10] };
  assert.equal(armour.canPenetrate(unit('infantry'), unit('dreadnought'), edited), true);
});
