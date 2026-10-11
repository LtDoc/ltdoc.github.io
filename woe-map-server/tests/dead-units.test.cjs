'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-dead-unit-test-'));
process.env.WOE_DATA_DIR = scratch;
const { db } = require('../server/db');
const supply = require('../server/supply');
const vision = require('../server/vision');
const game = require('../server/game');
const access = require('../server/lobbyAccess');
db.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(1,?,?,?,1)').run('tester', 'Tester', 'unused');
db.prepare('INSERT INTO lobbies(id,name,join_code,owner_id,created_at) VALUES(1,?,?,1,1)').run('Disposable test', 'DEAD01');
const lobby = access.getLobby(1);
const dead = { id: 1, type: 'unit', name: 'Wreck', x: 10, y: 10, data: { strength: 0, unitType: 'infantry', nation: 'Test', supplied: false, supplies: 0 } };
after(() => {
  db.close();
  const target = path.resolve(scratch);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('woe-dead-unit-test-'));
  fs.rmSync(target, { recursive: true, force: true });
});

test('dead units skip supply resolution before accessing type or position', () => {
  const poison = { ...dead, data: { strength: 0, get unitType() { throw new Error('resolved a dead type'); } },
    get x() { throw new Error('measured a wreck'); } };
  assert.equal(supply.needsSupply(poison), false);
  assert.equal(supply.exhausted(dead), false);
  assert.equal(supply.compute(lobby, {}, [poison]).size, 0);
  const live = { ...dead, id: 2, data: { ...dead.data, strength: 100 } };
  const result = supply.compute(lobby, { goodsEnabled: false }, [poison, live]);
  assert.equal(result.has(1), false);
  assert.equal(result.get(2).supplied, false);
});

test('supply updates omit wrecks from counts and leave salvage stores intact', () => {
  const insert = db.prepare('INSERT INTO markers(id,lobby_id,type,name,x,y,data,created_at,updated_at) VALUES(?,1,?,?,?,?,?,1,1)');
  insert.run(1, 'unit', 'Wreck', 10, 10, JSON.stringify({ ...dead.data, unitType: 'supply', pool: 12 }));
  insert.run(2, 'unit', 'Living infantry', 10, 10, JSON.stringify({ ...dead.data, strength: 100 }));
  const result = game.applySupply(lobby, { goodsEnabled: false });
  assert.equal(result.unsupplied, 1);
  assert.equal(result.result.has(1), false);
  const row = db.prepare('SELECT data, updated_at FROM markers WHERE id=1').get();
  assert.equal(row.updated_at, 1);
  assert.equal(JSON.parse(row.data).pool, 12);
});

test('wrecks bypass vision state and sonar while explicit access restrictions remain', () => {
  const viewer = { role: 'player', userId: 2, nation: 'Other', get lobbyId() { throw new Error('loaded fog state'); } };
  assert.equal(vision.sees(viewer, { ...dead, data: { ...dead.data, submerged: true } }), true);
  assert.equal(vision.rangeFor(-999, dead), 0);
  assert.equal(access.canSee({ ...dead, adminOnly: true }, { role: 'player', userId: 2, lobbyId: 1 }), false);
  assert.equal(access.canSee({ ...dead, visibleTo: ['Test'] }, { role: 'player', userId: 2, nation: 'Other', lobbyId: 1 }), false);
});

test('destroyed units cannot move; GM placement skips all movement rules', () => {
  const poison = new Proxy({}, { get() { throw new Error('ran movement calculations'); } });
  assert.match(game.checkMove(poison, poison, false, dead, 20, 30).error, /destroyed/);
  assert.deepEqual(game.checkMove(poison, poison, true, dead, 20, 30), { x: 20, y: 30, clamped: false });
});

test('client skips wreck ranges, doctrine and supply links and removes stale badges', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/map.js'), 'utf8');
  const names = ['clickMoves', 'remainingFor', 'reachFor', 'visionKm', 'supportRole', 'unitDoctrineRows', 'syncSupplyLine'];
  const functions = names.map(name => {
    const match = source.match(new RegExp(`  function ${name}\\([^]*?\\n  }`));
    assert.ok(match, name); return match[0];
  }).join('\n');
  let hidden = false;
  const scope = { m: dead, renderer: { hideSupplyLine() { hidden = true; } } };
  vm.runInNewContext(`const deadUnit = m => m?.type === 'unit' && Number(m.data?.strength ?? 100) <= 0;\n${functions}\nresult = [clickMoves(m), remainingFor(m), reachFor(m, 100), visionKm(m), supportRole(m), unitDoctrineRows(m)]; syncSupplyLine(m);`, scope);
  assert.deepEqual(Array.from(scope.result), [false, 0, null, 0, null, '']);
  assert.equal(hidden, true);
  const renderer = fs.readFileSync(path.join(__dirname, '../public/js/map-renderer.js'), 'utf8');
  const method = renderer.match(/  _refreshSupply\(rules\) \{([^]*?)\n  }/)[1];
  const view = { marker: dead, supplyBadge: { visible: true }, body: { alpha: 0.72 } };
  vm.runInNewContext(`(function(rules) {${method}\n}).call(view, {});`, { view });
  assert.equal(view.supplyBadge.visible, false);
  assert.equal(view.body.alpha, 1);
});
