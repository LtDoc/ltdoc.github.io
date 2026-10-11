'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepare } = require('../server/azgaar');

const sample = () => ({
  info: { width: 100, height: 100, mapName: 'Sample' },
  pack: {
    vertices: [{ p: [0, 0] }, { p: [50, 0] }, { p: [50, 50] }, { p: [0, 50] }],
    cells: [
      { i: 0, v: [0, 1, 2, 3], p: [25, 25], h: 30, state: 1 },
      { i: 1, v: [0, 1, 2, 3], p: [75, 75], h: 10, state: 0 },
    ],
    states: [0, { i: 1, name: 'North', color: '#336699' }],
    burgs: [0, { i: 1, name: 'Northport', x: 20, y: 20, state: 1, capital: 1, population: 10 }],
  },
});

test('prepares Azgaar land, nations and settlements without sea provinces', () => {
  const map = prepare(sample());
  assert.deepEqual([map.width, map.height, map.states.length, map.land.length, map.burgs.length], [100, 100, 1, 1, 1]);
  assert.deepEqual(map.states[0], { id: 1, name: 'North', color: '#336699' });
  assert.deepEqual(map.land[0].geometry[0][0][0], [0, 0]);
  assert.deepEqual(map.land[0].geometry[0][0].at(-1), [0, 0]);
  assert.equal(map.burgs[0].size, 'capital');
});

test('rejects cells belonging to a missing nation', () => {
  const map = sample();
  map.pack.cells[0].state = 7;
  assert.throws(() => prepare(map), /unknown nation/);
});
