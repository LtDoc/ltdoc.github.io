'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PIXI = require('pixi.js');
const ctx = { PIXI, window: {}, performance, EventTarget };
vm.createContext(ctx);
for (const file of ['province-layer', 'map-renderer']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js', `${file}.js`), 'utf8'), ctx);
function renderer(size = 1) {
  const r = Object.create(ctx.window.MapRenderer.prototype);
  r.territoryViews = new Map(); r.territoryLayer = new PIXI.Container(); r.factionInfo = new Map(); r.world = new PIXI.Container();
  r.invalidate = () => {}; r.earth = { hidePolitical: false, tintLayer: { visible: true }, redraw: () => {} };
  r.provinceLayer = { size, hasOwners: size > 0, setProvinces: list => { r.provinceLayer.size = list.length; }, setFactionInfo: () => {}, flushPending: () => {} };
  r._drawTerritory = v => { v.g.rect(0, 0, 10, 10).fill(0x0000ff); };
  return r;
}
const oldLand = [{ factionId: 2, geometry: [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]] }];

test('province maps remove existing legacy tint and ignore stale full and incremental territory messages', () => {
  for (const replace of [true, false]) {
    const r = renderer(0); r.setTerritories(oldLand, true);
    const old = r.territoryViews.get(2).g; assert.equal(r.territoryViews.size, 1);
    r.provinceLayer.size = 1; r.provinceLayer.hasOwners = true;
    r.setTerritories(oldLand, replace);
    assert.equal(r.territoryViews.size, 0); assert.equal(old.destroyed, true);
    assert.equal(r.territoryLayer.children.length, 0); assert.equal(r.earth.hidePolitical, true); assert.equal(r.earth.tintLayer.visible, false);
    r.setTerritories(oldLand, replace); assert.equal(r.territoryViews.size, 0);
  }
});

test('loading provinces after historical polygons clears old tint regardless of response arrival order', () => {
  const r = renderer(0); r.setTerritories(oldLand, true); const old = r.territoryViews.get(2).g;
  r.setProvinces([{ id: 1 }]);
  assert.equal(r.territoryViews.size, 0); assert.equal(old.destroyed, true);
  r.setTerritories(oldLand, true); assert.equal(r.territoryViews.size, 0);
});

test('free-form maps retain their territory rendering when no provinces exist', () => {
  const r = renderer(0); r.setTerritories(oldLand, true);
  assert.equal(r.territoryViews.size, 1); assert.equal(r.territoryViews.get(2).g.destroyed, false);
  r.setTerritories([], true); assert.equal(r.territoryViews.size, 0);
});

test('captured and ceded provinces repaint exactly like the recipients existing provinces, including a reload', () => {
  const r = renderer(), layer = new ctx.window.ProvinceLayer.Layer(r);
  layer.list = [{ id: 1, v0: 0, v1: 3 }, { id: 2, v0: 3, v1: 6 }, { id: 3, v0: 6, v1: 9 }];
  layer.index = new Map(layer.list.map((p, i) => [p.id, i])); layer.owner = new Int32Array([-1, -1, -1]); layer.fillCol = new Float32Array(36);
  layer.fill = { geometry: { getBuffer: () => ({ update: () => {} }) } }; layer._buildBorders = () => {}; layer._scheduleLabels = () => {};
  layer.setFactionInfo([{ id: 1, color: '#ff0000', name: 'Red' }, { id: 2, color: '#0000ff', name: 'Blue' }]);
  layer.setOwners([[1, 1], [2, 2], [3, 2]], true);
  assert.notDeepEqual([...layer.fillCol.slice(0, 4)], [...layer.fillCol.slice(12, 16)]);
  layer.setOwners([[2, 1]], false); // wartime capture
  layer.setOwners([[1, 1], [2, 1], [3, 1]], true); // peace plus explicit cession
  assert.deepEqual([...layer.fillCol.slice(0, 4)], [...layer.fillCol.slice(12, 16)]);
  assert.deepEqual([...layer.fillCol.slice(0, 4)], [...layer.fillCol.slice(24, 28)]);
  layer.setOwners([[1, 1], [2, 1], [3, 1]], true); // saved campaign reload; unchanged owners must still repaint
  assert.deepEqual([...layer.fillCol.slice(0, 12)], [...layer.fillCol.slice(24, 36)]);
});

test('treaty synchronization sends province ownership without resurrecting legacy territory polygons', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/routes/game.js'), 'utf8');
  const start = source.indexOf("  router.use('/treaties',"), end = source.indexOf('  // Unit orders:', start);
  for (const hasProvinces of [true, false]) {
    let sync; const messages = [];
    vm.runInNewContext(source.slice(start, end), {
      router: { use: () => {} }, treaties: { router: hooks => { sync = hooks.sync; }, load: () => ({ wars: [] }) },
      applyOwnership: () => {}, hub: { broadcast: (_, msg) => messages.push(msg) },
      provinces: { has: () => hasProvinces, ownership: () => [[1, 1]] }, territory: { all: () => oldLand },
      broadcastRelations: () => {}, game: { q: { factions: { all: () => [] } } },
    });
    sync({ lobby: { id: 1 } });
    const land = messages.find(m => m.type === 'territory'); assert.equal(land.replace, true);
    assert.equal(land.territories.length, hasProvinces ? 0 : 1);
    assert.deepEqual(messages.find(m => m.type === 'provinceOwners').owners, [[1, 1]]);
  }
});
