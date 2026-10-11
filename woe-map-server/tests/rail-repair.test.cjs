'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const UnitTypes = require('../public/js/units');
const source = fs.readFileSync(path.join(__dirname, '../server/routes/game.js'), 'utf8').replace(/\r\n/g, '\n');
const route = source.slice(source.indexOf("  router.post('/rail/repair'"), source.indexOf('\n\n\n  return router;', source.indexOf("  router.post('/rail/repair'")));
function fixture() {
  let handler;
  const unit = { id: 1, type: 'unit', name: 'Engineers', x: 0, y: 0, data: { unitType: 'engineers', strength: 100, nation: 'Red', ap: 2, apUsed: 0 } };
  const rail = { id: 4, kind: 'rail', data: { cuts: [{ id: 'a', x: 10, y: 0 }, { id: 'b', x: 20, y: 0 }] } };
  const f = { unit, rail, holder: { id: 1, name: 'Red' }, canEdit: true, writes: 0, visible: true };
  const context = {
    router: { post: (url, fn) => { handler = fn; } }, UnitTypes,
    game: { get: () => ({ enabled: true, settings: { railRepairKm: 30 } }), q: { markers: { all: () => [unit] } } },
    railTarget: () => rail, placeName: () => 'near town', railName: () => 'test railway', unitsLabel: () => 'km',
    access: { serializeMarker: m => m, canSee: () => f.visible }, canEditMarker: () => f.canEdit,
    geo: { distance: (l, x, y, a, b) => Math.hypot(x - a, y - b) }, holderAt: () => f.holder,
    friendsOf: () => name => ['Red', 'Ally'].includes(name), num: (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback,
    writeMarker: (req, m, patch) => { Object.assign(m.data, patch.data); f.writes++; return m; },
    writeShape: (req, s, data) => { s.data = data; f.writes++; return s; },
    logEvent: () => ({ id: 1, message: 'repaired' }),
  };
  vm.runInNewContext(route, context);
  f.call = (body = {}, role = 'player') => {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(data) { this.body = data; return this; } };
    handler({ lobby: { id: 1 }, user: { id: 5 }, member: { nation: 'Red' }, lobbyRole: role, body: { shapeId: 4, cutId: 'a', unitId: 1, ...body } }, res);
    return res;
  };
  return f;
}

test('engineering crews repair exactly one cut and spend one action point', () => {
  for (const type of ['engineers', 'pioneers', 'railway']) {
    const f = fixture(); f.unit.data.unitType = type;
    const res = f.call();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.marker.data.apUsed, 1);
    assert.equal(f.rail.data.cuts.length, 1);
    assert.equal(f.rail.data.cuts[0].id, 'b');
    assert.equal(f.call().statusCode, 404); // retries cannot spend twice
    assert.equal(f.unit.data.apUsed, 1);
  }
});

test('invalid crews and inaccessible breaks cannot mutate a railway or consume actions', () => {
  for (const [change, status] of [
    [f => { f.unit.data.unitType = 'infantry'; }, 400],
    [f => { f.unit.type = 'hero'; }, 400],
    [f => { f.unit.data.strength = 0; }, 409],
    [f => { f.unit.data.surrendered = true; }, 409],
    [f => { f.unit.data.aboard = 7; }, 409],
    [f => { f.unit.data.apUsed = 2; }, 409],
    [f => { f.unit.x = 100; }, 409],
    [f => { f.holder = { id: 2, name: 'Enemy' }; }, 409],
    [f => { f.canEdit = false; }, 403],
    [f => { f.visible = false; }, 404],
  ]) {
    const f = fixture(); change(f);
    assert.equal(f.call().statusCode, status);
    assert.equal(f.writes, 0);
    assert.equal(f.rail.data.cuts.length, 2);
  }
});

test('allied and neutral repairs work; direct GM repair needs no crew or action', () => {
  for (const holder of [null, { id: 0, name: '' }, { id: 3, name: 'Ally' }]) {
    const f = fixture(); f.holder = holder;
    assert.equal(f.call().statusCode, 200);
  }
  const f = fixture(); f.unit.data.strength = 0;
  assert.equal(f.call({ unitId: undefined }, 'gm').statusCode, 200);
  assert.equal(f.unit.data.apUsed, 0);
});

test('railway popup chooses an available engineering crew, skipping closer ineligible units', () => {
  const client = fs.readFileSync(path.join(__dirname, '../public/js/map.js'), 'utf8');
  const f = fixture();
  const exhausted = { ...f.unit, id: 2, x: 9, data: { ...f.unit.data, apUsed: 2 } };
  const infantry = { ...f.unit, id: 3, x: 10, data: { ...f.unit.data, unitType: 'infantry' } };
  const state = { role: 'player', game: { settings: { railRepairKm: 30 } }, markers: new Map([[1, f.unit], [2, exhausted], [3, infantry]]) };
  const ctx = { state, window: { UnitTypes }, canEdit: () => true, gameOn: () => true,
    renderer: { territoryOwnerAt: () => 1 }, friendIds: () => ({ ids: new Set([1]) }), distanceUnits: (x, y, a, b) => Math.hypot(x - a, y - b) };
  vm.createContext(ctx);
  vm.runInContext(client.slice(client.indexOf('  function canRepairRail('), client.indexOf('  async function repairRail(')), ctx);
  assert.equal(ctx.repairCrew({ x: 10, y: 0 }).id, 1);
  f.unit.data.strength = 0;
  assert.equal(ctx.repairCrew({ x: 10, y: 0 }), null);
});

test('repair picker submits the chosen break and crew, then refreshes crew and railway', async () => {
  const client = fs.readFileSync(path.join(__dirname, '../public/js/map.js'), 'utf8');
  const f = fixture();
  const state = { role: 'player', lobby: { scaleLabel: 'km' }, game: { settings: { railRepairKm: 30 } },
    markers: new Map([[1, f.unit]]), shapes: new Map([[4, f.rail]]), events: [] };
  const els = new Map();
  const $ = id => { if (!els.has(id)) els.set(id, { value: '1', classList: { add() {} } }); return els.get(id); };
  let request, closed = false, refreshed = 0;
  const ctx = { state, $, window: { UnitTypes }, canEdit: () => true, gameOn: () => true,
    renderer: { territoryOwnerAt: () => 1 }, friendIds: () => ({ ids: new Set([1]) }), distanceUnits: (x, y, a, b) => Math.hypot(x - a, y - b),
    shapeName: () => 'Railway', nearPlace: () => '', esc: String, fmtNum: String, toast() {}, renderLog() {}, renderPopup() {},
    base: '/test', closeModals: () => { closed = true; }, upsertShape: () => { refreshed++; }, upsertMarker: () => { refreshed++; },
    api: { post: async (url, body) => { request = { url, body }; const r = f.call(body); assert.equal(r.statusCode, 200); return r.body; } },
  };
  vm.createContext(ctx);
  vm.runInContext(client.slice(client.indexOf('  function canRepairRail('), client.indexOf('  /** Players cannot lay track')), ctx);
  ctx.openRailRepair(f.unit);
  assert.match($('#railRepairTarget').innerHTML, /option value="1"/);
  await $('#railRepairForm').onsubmit({ preventDefault() {} });
  assert.equal(request.body.unitId, 1);
  assert.equal(request.body.cutId, 'b');
  assert.equal(request.url, '/test/game/rail/repair');
  assert.equal(f.rail.data.cuts[0].id, 'a');
  assert.equal(refreshed, 2);
  assert.equal(closed, true);
  assert.equal($('#railRepairForm button[type="submit"]').disabled, false);
});
