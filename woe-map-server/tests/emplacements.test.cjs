'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const factions = [{ id: 1, name: 'Red', color: '#ff0000' }, { id: 2, name: 'Blue', color: '#0000ff' }];
const marker = (id, unitType, nation = 'Blue', x = 10) => ({ id, type: 'unit', name: unitType, x, y: 10, data: { unitType, nation, strength: 100 } });

// Run the real territory module with a small deterministic province map, without loading campaign data.
function campaign() {
  const cells = [{ id: 1, factionId: 2 }, { id: 2, factionId: 2 }];
  const pv = {
    has: () => true,
    at: (_, x) => x < 50 ? cells[0] : cells[1],
    ownerAt: (_, x) => (x < 50 ? cells[0] : cells[1]).factionId,
    within: (l, x, y, r, predicate) => cells.filter(predicate),
    give: (l, ids, factionId) => cells.filter(p => ids.includes(p.id)).map(p => { p.factionId = factionId; return { id: p.id, factionId }; }),
  };
  const module = { exports: {} };
  const fakeRequire = name => {
    if (name === './db') return { db: { prepare: () => ({}) }, now: () => 1 };
    if (name === './provinces') return pv;
    if (name === './geo') return { distance: (l, x, y, a, b) => Math.hypot(x - a, y - b) };
    if (['./config', './lobbyAccess'].includes(name)) return {};
    return require(name.startsWith('.') ? path.resolve(__dirname, '../server', name) : name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/territory.js'), 'utf8'), { require: fakeRequire, module, console, Buffer, __dirname: path.resolve(__dirname, '../server') });
  return { territory: module.exports, cells };
}
const lobby = { id: 1 };
const g = { enabled: true, turn: 3, settings: { captureRadiusKm: 30 } };
const attacker = marker(1, 'infantry', 'Red');
const war = () => 'war';

test('each capturable emplacement falls with the province and cannot take ground itself', () => {
  for (const type of ['coastal', 'mgbunker', 'aaemplacement', 'Coastal Battery', 'MG Bunker', 'AA Emplacement']) {
    const { territory } = campaign();
    const emplacement = marker(2, type);
    assert.equal(territory.isCapturableEmplacement(emplacement), true, type);
    assert.equal(territory.capture(lobby, g, { ...emplacement, data: { ...emplacement.data, nation: 'Red' } }, factions, [emplacement], war), null);
    const r = territory.capture(lobby, g, attacker, factions, [attacker, emplacement], war);
    assert.equal(r.held, false, type);
    assert.equal(r.flips.length, 1);
    assert.equal(r.flips[0].marker.id, 2);
    assert.equal(r.flips[0].nation, 'Red');
  }
});

test('forts and ordinary defenders hold provinces, including outside the immediate capture radius', () => {
  for (const type of ['fortress', 'Fortress guns', 'infantry']) {
    const { territory, cells } = campaign();
    const fort = marker(3, type, 'Blue', 45);
    const r = territory.capture(lobby, g, attacker, factions, [attacker, marker(2, 'coastal'), fort], war);
    assert.equal(r.held, true, type);
    assert.equal(cells[0].factionId, 2);
  }
});

test('defeated forts permit capture; emplacements in defended neighbouring provinces stay put', () => {
  const { territory, cells } = campaign();
  const deadFort = marker(3, 'fortress'); deadFort.data.strength = 0;
  const r = territory.capture(lobby, g, attacker, factions,
    [attacker, marker(2, 'coastal'), deadFort, marker(4, 'fortress', 'Blue', 80), marker(5, 'aaemplacement', 'Blue', 80)], war);
  assert.equal(r.held, false);
  assert.equal(cells[0].factionId, 1);
  assert.equal(cells[1].factionId, 2);
  assert.equal(r.flips.length, 1);
  assert.equal(r.flips[0].marker.id, 2);
});

test('territory ownership includes only the three emplacements, preserves forts and ignores offshore units', () => {
  const { territory } = campaign();
  const markers = ['coastal', 'mgbunker', 'aaemplacement', 'fortress', 'infantry'].map((t, i) => marker(i, t));
  const flips = territory.ownershipChanges(() => 1, factions, markers, lobby);
  assert.equal(flips.length, 3);
  assert.equal(territory.ownershipChanges(() => null, factions, markers, lobby).length, 0);
});

test('ownership transfer changes player control and colour while retaining strength and stores', () => {
  const { territory } = campaign();
  const source = fs.readFileSync(path.join(__dirname, '../server/routes/lobbies.js'), 'utf8');
  const fn = source.slice(source.indexOf('function setMarkerNation('), source.indexOf('\nfunction shapeById('));
  let saved, broadcasts = 0;
  const context = {
    require: () => territory, game: { get: () => g }, now: () => 10,
    access: { getMembers: () => [{ user_id: 11, nation: 'Red' }], serializeMarker: row => row },
    q: { factions: { all: () => factions }, updateMarker: { run: (...args) => { saved = { color: args[6], ownerId: args[9], data: JSON.parse(args[10]) }; } }, marker: { get: () => saved } },
    commitChange: () => { broadcasts++; },
  };
  vm.createContext(context); vm.runInContext(fn, context);
  const before = { ...marker(2, 'coastal'), ownerId: 22, color: '#0000ff' };
  before.data.strength = 42; before.data.shells = 6;
  const after = context.setMarkerNation({ lobby }, before, 'Red', true);
  assert.equal(after.ownerId, 11);
  assert.equal(after.color, '#ff0000');
  assert.equal(after.data.strength, 42);
  assert.equal(after.data.shells, 6);
  assert.equal(after.data.capturedFrom, 'Blue');
  assert.equal(broadcasts, 1);
  assert.equal(context.setMarkerNation({ lobby }, before, '', true).ownerId, null);
});
