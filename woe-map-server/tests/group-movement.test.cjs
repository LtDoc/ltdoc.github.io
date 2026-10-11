'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/map.js'), 'utf8').replace(/\r\n/g, '\n');

function fixture({ rules = true, mode = 'select', count = 4 } = {}) {
  const list = Array.from({ length: count }, (_, i) => ({ id: i + 1, type: 'unit', x: 20, y: 20, data: {} }));
  const ms = { lead: list[0], list, remaining: 100 };
  const f = { moves: [], requests: [], messages: [], ms };
  const ctx = {
    state: { lobby: { mapWidth: 1000, mapHeight: 800 }, placing: null },
    renderer: { mode, scale: 1, tokenScale: 1, addEventListener: (_, fn) => { f.handler = fn; } },
    round1: n => Math.round(n * 10) / 10,
    rulesOn: () => rules, movers: () => ms, cutOff: () => false, holdsPosition: () => false,
    insideReach: () => true, commitMove: move => f.moves.push(move),
    api: { post: async (url, body) => { f.requests.push({ url, body }); return { moved: [], errors: [] }; } },
    base: '/api/lobbies/1', upsertMarker() {}, toast: msg => f.messages.push(msg),
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function groupDestinations('), source.indexOf('\n  /**\n   * A march as the server')), ctx);
  vm.runInContext(source.slice(source.indexOf("  renderer.addEventListener('mapcontext'"), source.indexOf('  // ---- GM pings')), ctx);
  f.ctx = ctx;
  f.click = (x = 500, y = 400) => f.handler({ detail: { x, y } });
  return f;
}

test('stacked units receive separate destinations centered near the click', () => {
  for (const count of [2, 4, 7, 200]) {
    const f = fixture({ count });
    const moves = f.ctx.groupDestinations(f.ms, 500, 400);
    assert.equal(moves.length, count);
    assert.equal(new Set(moves.map(m => `${m.x},${m.y}`)).size, count);
    for (let i = 0; i < moves.length; i++) for (let j = i + 1; j < moves.length; j++) {
      assert.ok(Math.hypot(moves[i].x - moves[j].x, moves[i].y - moves[j].y) >= 39.9);
    }
  }
});

test('edge and corner clicks keep all destinations on the map without stacking', () => {
  const f = fixture({ count: 9 });
  for (const [x, y] of [[0, 0], [1000, 0], [0, 800], [1000, 800]]) {
    const moves = f.ctx.groupDestinations(f.ms, x, y);
    assert.equal(new Set(moves.map(m => `${m.x},${m.y}`)).size, 9);
    assert.ok(moves.every(m => m.x >= 0 && m.y >= 0 && m.x <= 1000 && m.y <= 800));
  }
  f.ctx.state.lobby = { mapWidth: 20, mapHeight: 20 };
  assert.equal(new Set(f.ctx.groupDestinations(f.ms, 0, 0).map(m => `${m.x},${m.y}`)).size, 9);
});

test('right-click in box-selection mode sends distinct marching goals under movement rules', async () => {
  const f = fixture();
  f.click();
  await Promise.resolve();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/api/lobbies/1/game/units/goal');
  assert.equal(new Set(f.requests[0].body.moves.map(m => `${m.x},${m.y}`)).size, 4);
  assert.equal(f.moves.length, 0);
});

test('game mode off or waived movement uses the ordinary bulk move endpoint', () => {
  const f = fixture({ rules: false });
  f.click();
  assert.equal(f.moves.length, 1);
  assert.equal(f.moves[0].moves.length, 4);
  assert.equal(new Set(f.moves[0].moves.map(m => `${m.x},${m.y}`)).size, 4);
  assert.equal(f.requests.length, 0);
});

test('single-unit movement keeps the clicked destination', () => {
  for (const rules of [true, false]) {
    const f = fixture({ count: 1, rules });
    f.click(123, 456);
    assert.equal(f.moves[0].id, 1);
    assert.equal(f.moves[0].x, 123);
    assert.equal(f.moves[0].y, 456);
  }
});

test('drawing and placement block map orders; unit movement filters exclude unavailable tokens', () => {
  const f = fixture({ mode: 'draw' });
  f.click();
  f.ctx.renderer.mode = 'select';
  f.ctx.state.placing = {};
  f.click();
  assert.equal(f.requests.length + f.moves.length, 0);
  Object.assign(f.ctx, { MOVERS: ['unit', 'hero'], deadUnit: m => m.data?.strength === 0, canEdit: m => m.ownerId === 1 });
  vm.runInContext(source.slice(source.indexOf('  function clickMoves('), source.indexOf('  renderer.dragAllowed')), f.ctx);
  const unit = { type: 'unit', ownerId: 1, data: {} };
  assert.equal(f.ctx.clickMoves(unit), true);
  for (const patch of [{ ownerId: 2 }, { locked: true }, { type: 'town' }, { data: { strength: 0 } }, { data: { aboard: 7 } }, { data: { surrendered: true } }, { type: 'hero', data: { status: 'captured' } }]) {
    assert.equal(f.ctx.clickMoves({ ...unit, ...patch }), false);
  }
});

test('renderer emits right-click map orders in selection mode but ignores right-button panning', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '../public/js/map-renderer.js'), 'utf8');
  const start = rendererSource.indexOf('      if (this._pan) {', rendererSource.indexOf('    const up = e =>'));
  const code = rendererSource.slice(start, rendererSource.indexOf('      if (this._drag)', start));
  for (const [mode, moved, expected] of [['select', false, 1], [null, false, 1], ['draw', false, 0], ['select', true, 0]]) {
    const emitted = [];
    const renderer = { mode, _pan: { moved, button: 2 }, screenToWorld: (x, y) => ({ x, y }), dispatchEvent: e => emitted.push(e) };
    vm.runInNewContext(`(function () { ${code} }).call(renderer)`, { renderer, e: { global: { x: 500, y: 400 } }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
    assert.equal(emitted.length, expected);
    if (expected) assert.equal(emitted[0].type, 'mapcontext');
  }
});
