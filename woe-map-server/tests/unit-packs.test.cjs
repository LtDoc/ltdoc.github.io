'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const UnitTypes = require('../public/js/units');

test('the Great War pack retains the existing catalogue and rejects foreign types', () => {
  const pack = UnitTypes.forPack('great-war');
  assert.equal(pack.name, 'Great War Pack');
  assert.equal(pack.exact('Infantry').id, 'infantry');
  assert.equal(pack.exact('infantry').id, 'infantry');
  assert.equal(pack.exact('Sherman tank'), null);
  assert.equal(UnitTypes.forPack('ww2'), null);
  assert.equal(pack.LIST.length, UnitTypes.LIST.length);
});

test('simultaneous campaign requests keep separate unit tables', async () => {
  UnitTypes.registerPack('test-fantasy', 'Test Fantasy', [
    { id: 'dragon', name: 'Dragon', cat: 'Creatures', symbol: 'air', stats: [10, 10, 2, 5, 8, 5, 8] },
  ]);
  const [fantasy, greatWar] = await Promise.all([
    UnitTypes.runWithPack('test-fantasy', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { ids: UnitTypes.LIST.map(t => t.id), dragon: UnitTypes.resolve('Dragon'), infantry: UnitTypes.resolve('Infantry') };
    }),
    UnitTypes.runWithPack('great-war', async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return { dragon: UnitTypes.resolve('Dragon'), infantry: UnitTypes.resolve('Infantry') };
    }),
  ]);
  assert.deepEqual(fantasy.ids, ['dragon']);
  assert.equal(fantasy.dragon.id, 'dragon');
  assert.equal(fantasy.infantry, null);
  assert.equal(greatWar.dragon, null);
  assert.equal(greatWar.infantry.id, 'infantry');
});

test('an old campaign migrates to Great War without changing its data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-unit-pack-test-'));
  try {
    const old = new DatabaseSync(path.join(dir, 'woe.db'));
    old.exec(`CREATE TABLE lobbies (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, join_code TEXT NOT NULL UNIQUE,
      owner_id INTEGER NOT NULL, map_file TEXT, map_width INTEGER NOT NULL DEFAULT 0,
      map_height INTEGER NOT NULL DEFAULT 0, scale_label TEXT NOT NULL DEFAULT 'km',
      units_per_px REAL NOT NULL DEFAULT 1, settings TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    INSERT INTO lobbies (id, name, join_code, owner_id, settings, created_at)
    VALUES (7, 'Old campaign', 'OLD123', 1, '{"unitStats":{"infantry":[6,5,1,1,2]}}', 123);`);
    old.close();
    const script = `const {db}=require('./server/db'); const row=db.prepare('SELECT * FROM lobbies WHERE id=7').get(); process.stdout.write(JSON.stringify(row));`;
    const row = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, WOE_DATA_DIR: dir }, encoding: 'utf8',
    }));
    assert.equal(row.unit_pack, 'great-war');
    assert.equal(row.name, 'Old campaign');
    assert.deepEqual(JSON.parse(row.settings).unitStats.infantry, [6, 5, 1, 1, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
