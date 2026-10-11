'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const routeFile = path.join(__dirname, '../server/routes/orders.js');
const routeRequire = createRequire(routeFile);
const source = fs.readFileSync(routeFile, 'utf8');
const route = source.slice(source.indexOf("  router.post('/units/:mid/replenish'"), source.indexOf('  // ---- Submarines'));

function fixture({ owner = 1, permitted = true, cat = 'Infantry' } = {}) {
  const unit = { id: 1206, type: 'unit', name: 'Infantry', x: 0, y: 0,
    data: { nation: 'Red', strength: 40, movement: 2, ap: 2 } };
  const faction = { id: 1, name: 'Red' };
  const treasury = { manpower: 100, money: 100 };
  const f = { unit, treasury, writes: 0, permissions: [] };
  let handler;
  const context = {
    router: { post: (url, fn) => { handler = fn; } }, loadUnit: () => unit,
    game: { get: () => ({ enabled: true, turn: 3, settings: {} }),
      q: { faction: { get: id => ({ id, name: id === 1 ? 'Red' : 'Blue' }) }, state: { get: () => treasury } },
      factionEffects: () => ({}), serializeState: s => ({ ...s }),
      writeState: s => { Object.assign(treasury, s); f.writes++; } },
    units: () => 'km', num: (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback,
    markersOf: () => [unit], supply: { friendsResolver: () => () => new Set(['red']) },
    typeOf: () => ({ id: 'infantry', cat }), norm: s => String(s || '').toLowerCase(),
    territory: { ownerLookup: () => () => owner }, factionNamed: () => faction,
    require: name => {
      // Resolve relative to the actual route, so a misplaced import fails this regression test.
      assert.equal(routeRequire.resolve(name), routeRequire.resolve('../treaties'));
      return { permission: (...args) => { f.permissions.push(args); return permitted; } };
    },
    research: { applyCost: (fx, id, category, cost) => cost, statBonus: () => ({ movement: 0 }) },
    GameData: { costFor: () => ({ manpower: 20, money: 10 }) },
    writeMarker: (req, m, patch) => { Object.assign(m.data, patch.data); f.writes++; return m; },
    pushFaction() {}, sideLog() {},
  };
  vm.runInNewContext(route, context);
  f.call = () => {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
    handler({ lobby: { id: 6 }, user: { id: 1 }, lobbyRole: 'player' }, res);
    return res;
  };
  return f;
}

test('replenishing in owned territory resolves treaty rules and pays for replacements once', () => {
  const f = fixture();
  assert.equal(f.call().statusCode, 200);
  assert.equal(f.unit.data.strength, 90);
  assert.equal(f.treasury.manpower, 90);
  assert.equal(f.treasury.money, 95);
  assert.equal(f.unit.data.movedKm, 100);
  assert.equal(f.unit.data.apUsed, 2);
  assert.deepEqual(f.permissions[0], [6, 1, 1, 'supply']);
  assert.equal(f.call().statusCode, 409);
  assert.equal(f.writes, 2);
});

test('foreign refitting requires supply or airfield permission and rejection spends nothing', () => {
  for (const cat of ['Infantry', 'Air']) {
    for (const permitted of [true, false]) {
      const f = fixture({ owner: 2, permitted, cat });
      assert.equal(f.call().statusCode, permitted ? 200 : 409);
      assert.deepEqual(f.permissions[0], [6, 1, 2, cat === 'Air' ? 'airfields' : 'supply']);
      assert.equal(f.unit.data.strength, permitted ? 90 : 40);
      assert.equal(f.treasury.money, permitted ? 95 : 100);
      assert.equal(f.writes, permitted ? 2 : 0);
    }
  }
});
