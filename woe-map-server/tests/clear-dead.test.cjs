'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server/routes/lobbies.js'), 'utf8');
function fixture() {
  const rows = [
    { id: 1, type: 'unit', data: { strength: 0 }, adminOnly: true, locked: true },
    { id: 2, type: 'unit', data: { strength: -1 } },
    { id: 3, type: 'unit', data: { strength: 50 } },
    { id: 4, type: 'unit', data: {} },
    { id: 5, type: 'hero', data: { strength: 0 } },
    { id: 6, type: 'unit', data: { strength: 0 } }, // newly dead, not confirmed
  ];
  let handlers;
  const deleted = [], history = [], battles = [];
  const ctx = {
    router: { post: (url, ...h) => { handlers = h; } },
    q: { markers: { all: id => { assert.equal(id, 7); return rows.filter(m => !deleted.includes(m.id)); } }, deleteMarker: { run: id => deleted.push(id) } },
    qb: { dropFor: { run: (...args) => battles.push(args) } },
    access: { serializeMarker: m => m }, game: { get: () => ({ turn: 3 }) },
    commitChange: (req, entity, action, before, after) => history.push({ entity, action, before, after }),
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function requireGm('), source.indexOf('\n}', source.indexOf('function requireGm(')) + 2), ctx);
  vm.runInContext(source.slice(source.indexOf("router.post('/:id/markers/clear-dead'"), source.indexOf("router.delete('/:id/markers/:mid'")), ctx);
  const call = (role = 'gm', markerIds = [1, 2, 3, 4, 5, 99]) => {
    const req = { lobbyRole: role, lobby: { id: 7 }, body: { markerIds } };
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    handlers[0](req, res, () => handlers[1](req, res));
    return res;
  };
  return { call, deleted, history, battles, rows };
}
test('GM cleanup deletes only confirmed dead units, retaining living units and other marker types', () => {
  const f = fixture(), r = f.call();
  assert.equal(r.body.count, 2);
  assert.deepEqual(f.deleted, [1, 2]);
  assert.equal(f.history.length, 2);
  assert.equal(f.history[0].action, 'delete');
  assert.equal(f.history[0].before.locked, true);
  assert.equal(f.battles.length, 2);
  assert.equal(f.call().body.count, 0);
});
test('players cannot clear dead units; malformed requests and restored units are safe', () => {
  const f = fixture();
  assert.equal(f.call('player').code, 403);
  assert.equal(f.call('gm', null).code, 400);
  assert.equal(f.call('gm', ['1']).code, 400);
  assert.equal(f.deleted.length, 0);
  f.rows[0].data.strength = 100;
  assert.equal(f.call().body.count, 1);
  assert.deepEqual(f.deleted, [2]);
});
