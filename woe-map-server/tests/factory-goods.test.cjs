'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-factory-goods-test-'));
process.env.WOE_DATA_DIR = scratch;
const { db } = require('../server/db');
const access = require('../server/lobbyAccess');
const goods = require('../server/goods');
const GameData = require('../public/js/game-data');

db.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(1,?,?,?,1)').run('tester', 'Tester', 'unused');
db.prepare('INSERT INTO lobbies(id,name,join_code,owner_id,created_at) VALUES(1,?,?,1,1)').run('Factory test', 'FACT01');
db.prepare('INSERT INTO factions(id,lobby_id,name,created_at) VALUES(1,1,?,1)').run('Test');
const insert = db.prepare('INSERT INTO markers(id,lobby_id,type,name,x,y,data,created_at,updated_at) VALUES(?,1,?,?,?,?,?,1,1)');
insert.run(1, 'town', 'Home', 0, 0, JSON.stringify({ nation: 'Test', size: 'city', industry: 0, goods: { consumer: 0, military: 0 } }));
insert.run(2, 'factory', 'Works', 1, 0, JSON.stringify({ nation: 'Test', industry: 2 }));
const lobby = access.getLobby(1);
const settings = { ...GameData.DEFAULT_SETTINGS, goodsBase: { capital: 6, city: 2, village: 1 } };
const state = { policy: { warEconomy: 50 } };

after(() => {
  db.close();
  const target = path.resolve(scratch);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('woe-factory-goods-test-'));
  fs.rmSync(target, { recursive: true, force: true });
});

test('factory makes both goods, delivers them to its town, and consumer output covers town needs', () => {
  const report = goods.endTurn(lobby, { settings, turn: 1 }, new Map([['test', state]])).byNation.get('test');
  assert.deepEqual(report.made, { consumer: 11, military: 11 });
  assert.equal(report.need, 1);
  assert.equal(report.short.length, 0);
  const town = access.serializeMarker(db.prepare('SELECT * FROM markers WHERE id=1').get());
  assert.deepEqual(town.data.goods, { consumer: 10, military: 11 });
  const summary = goods.summary(lobby, settings, { name: 'Test' }, state, [town, access.serializeMarker(db.prepare('SELECT * FROM markers WHERE id=2').get())]);
  assert.deepEqual(summary.made, { consumer: 11, military: 11 });
});

test('30% war economy splits each factory level into 7 consumer and 3 military goods', () => {
  const policy = { policy: { warEconomy: 30 } };
  const report = goods.endTurn(lobby, { settings, turn: 2 }, new Map([['test', policy]])).byNation.get('test');
  assert.deepEqual(report.made, { consumer: 15.4, military: 6.6 });
  const custom = { ...settings, factoryOutput: 5 };
  const summary = goods.summary(lobby, custom, { name: 'Test' }, policy, [
    access.serializeMarker(db.prepare('SELECT * FROM markers WHERE id=1').get()),
    access.serializeMarker(db.prepare('SELECT * FROM markers WHERE id=2').get()),
  ]);
  assert.deepEqual(summary.made, { consumer: 8.4, military: 3.6 });
});
