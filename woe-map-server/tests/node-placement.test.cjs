 'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n/g, '\n');
const source = read('../server/routes/lobbies.js');

function fixture(owner = 5) {
  let stored;
  const ctx = {
    require: () => ({ ownerLookup: () => owner === undefined ? null : () => owner }),
    q: {
      factions: { all: () => [{ id: 5, name: 'France' }, { id: 6, name: 'Britain' }] },
      insertMarker: { run: (...args) => {
        stored = { type: args[2], name: args[3], x: args[4], y: args[5], color: args[8], ownerId: args[11], data: JSON.parse(args[12]), locked: !!args[15] };
        return { lastInsertRowid: 1 };
      } },
      marker: { get: () => stored },
    },
    access: { getMembers: () => [{ user_id: 9, role: 'player', nation: 'France' }], serializeMarker: row => row },
    UnitTypes: { forPack: () => null }, MARKER_TYPES: ['resource', 'factory', 'player'],
    clean: (v, max) => String(v ?? '').trim().slice(0, max), num: (v, fallback = 0) => Number(v ?? fallback),
    inBounds: () => true, COLOR_RE: /^#[0-9a-f]{6}$/i, parseVisibleTo: () => null,
    sanitizeData: (_, data) => data, now: () => 1, commitChange() {}, logEvent() {},
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function nodeOwnership('), source.indexOf("router.post('/:id/markers'")), ctx);
  const req = { lobbyRole: 'gm', lobby: { id: 1 }, user: { id: 1 }, member: { color: '#ff0000' } };
  return { ctx, create: body => ctx.createMarker(req, body) };
}

test('economic placement overrides name, colour and ownership and starts unlocked', () => {
  for (const type of ['resource', 'factory']) {
    const f = fixture();
    const marker = f.create({ type, x: 10, y: 20, name: 'Custom', color: '#ff0000', ownerId: 42, data: { kind: 'grain', nation: 'Britain', industry: 1 } });
    assert.equal(marker.name, type === 'factory' ? 'Factory' : 'grain');
    assert.equal(marker.color, '#95a5a6');
    assert.equal(marker.data.nation, 'France');
    assert.equal(marker.ownerId, 9);
    assert.equal(marker.locked, false);
  }
});

test('neutral and unclaimed land clear selected ownership; a faction needs no player', () => {
  for (const owner of [0, null, 6]) {
    const marker = fixture(owner).create({ type: 'resource', x: 10, y: 20, data: { kind: 'coal', nation: 'France' } });
    assert.equal(marker.data.nation, owner === 6 ? 'Britain' : '');
    assert.equal(marker.ownerId, null);
  }
  const f = fixture();
  f.ctx.require = () => ({ ownerLookup: () => null });
  assert.equal(f.create({ type: 'factory', x: 10, y: 20 }).data.nation, '');
});

test('unlocked economic markers remain GM controlled even when owned by a player', () => {
  const accessSource = read('../server/lobbyAccess.js');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(accessSource.slice(accessSource.indexOf('const sameNation ='), accessSource.indexOf('/**\n * Can this viewer see')), ctx);
  for (const type of ['resource', 'factory']) {
    const marker = { type, ownerId: 9, data: { nation: 'France' }, locked: false };
    assert.equal(ctx.canControl(marker, { role: 'player', userId: 9, nation: 'France' }), false);
    assert.equal(ctx.canControl(marker, { role: 'gm', userId: 1 }), true);
    assert.equal(ctx.canControl(marker, { role: 'gm', realRole: 'observer' }), false);
    assert.equal(ctx.canControl(marker, { role: 'player', realRole: 'gm', viewAs: 5, userId: 9, nation: 'France' }), false);
  }
});

test('quick node and factory placement supports repeated clicks without faction or name input', async () => {
  const browser = read('../public/js/map.js');
  const start = browser.indexOf('    if (state.placing.resource || state.placing.gmFactory)');
  const block = browser.slice(start, browser.indexOf('    if (state.placing.hero)', start));
  for (const placing of [{ resource: 'grain' }, { gmFactory: true }]) {
    const requests = [];
    const ctx = {
      state: { placing }, e: { detail: { x: 10.25, y: 20.25 } }, base: '/api/lobbies/1',
      round1: n => Math.round(n * 10) / 10, gameOn: () => false,
      api: { post: async (_, body) => { requests.push(body); return { marker: { name: 'Factory', data: {} } }; } },
      upsertMarker() {}, toast() {},
    };
    vm.createContext(ctx);
    vm.runInContext(`async function click() { ${block} }`, ctx);
    await ctx.click(); await ctx.click();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].type, placing.gmFactory ? 'factory' : 'resource');
    assert.equal(requests[0].x, 10.3);
    assert.equal(requests[0].ownerId, undefined);
    assert.equal(requests[0].data.nation, undefined);
  }
});


test('editing a level or moving a node preserves automatic colour and province ownership', () => {
  const f = fixture();
  let before = f.create({ type: 'factory', x: 10, y: 20, data: { industry: 1 } });
  let saved;
  Object.assign(f.ctx, {
    router: { patch: (_, fn) => { f.patch = fn; } }, loadMarker: () => before,
    canEditMarker: () => true, game: { get: () => ({ enabled: false }), checkMove: (_, __, ___, ____, x, y) => ({ x, y }) },
    rideOf: () => null, isConvoy: () => false, afterMove: () => null,
  });
  f.ctx.q.updateMarker = { run: (...args) => {
    saved = { type: args[0], name: args[1], x: args[2], y: args[3], color: args[6], ownerId: args[9], data: JSON.parse(args[10]), locked: !!args[12] };
  } };
  f.ctx.q.marker.get = () => saved;
  const start = source.indexOf("router.patch('/:id/markers/:mid'");
  const end = source.indexOf("\n});", start) + 4;
  vm.runInContext(source.slice(start, end), f.ctx);
  const req = { lobbyRole: 'gm', lobby: { id: 1 }, user: { id: 1 }, body: { name: 'Custom', color: '#ff0000', ownerId: 42, data: { industry: 4, nation: 'Britain' } } };
  const res = { json: result => result };
  f.patch(req, res);
  assert.equal(saved.data.industry, 4);
  assert.equal(saved.name, 'Factory');
  assert.equal(saved.color, '#95a5a6');
  assert.equal(saved.data.nation, 'France');
  before = saved;
  f.ctx.require = () => ({ ownerLookup: () => () => 0 });
  req.body = { x: 30, y: 40 };
  f.patch(req, res);
  assert.equal(saved.data.industry, 4);
  assert.equal(saved.data.nation, '');
  assert.equal(saved.ownerId, null);
});
