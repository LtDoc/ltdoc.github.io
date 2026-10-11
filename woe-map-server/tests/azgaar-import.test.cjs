'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('a Full JSON upload creates the map, factions, towns and land mask', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-azgaar-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, WOE_DATA_DIR: dir, WOE_BACKUP_HOURS: '0', PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  async function json(url, options = {}) {
    const response = await fetch(base + url, options);
    const body = await response.json();
    assert.ok(response.ok, `${url}: ${response.status} ${JSON.stringify(body)}`);
    return { response, body };
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { await fetch(base + '/api/version'); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(ready, `Server did not start: ${output}`);
    const reg = await json('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'maptester', password: 'test-password', displayName: 'Map Tester' }) });
    const cookie = reg.response.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie };
    const created = await json('/api/lobbies', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Imported map' }) });
    const id = created.body.lobby.id;
    const source = { info: { width: 100, height: 100, mapName: 'Testland' }, pack: {
      vertices: [{ p: [0, 0] }, { p: [50, 0] }, { p: [50, 50] }, { p: [0, 50] }],
      cells: [{ i: 0, v: [0, 1, 2, 3], p: [25, 25], h: 30, state: 1, biome: 1 }],
      states: [0, { i: 1, name: 'North', color: '#336699' }],
      burgs: [0, { i: 1, name: 'Northport', x: 20, y: 20, state: 1, capital: 1 }],
      biomes: [{ i: 1, color: '#aabb88' }],
    } };
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(source)], { type: 'application/json' }), 'Full.json');
    const imported = await json(`/api/lobbies/${id}/map/azgaar`, { method: 'POST', headers, body: form });
    assert.equal(imported.body.lobby.mapKind, 'azgaar');
    const factions = await json(`/api/lobbies/${id}/factions`, { headers });
    assert.equal(factions.body.factions[0].name, 'North');
    const markers = await json(`/api/lobbies/${id}/markers`, { headers });
    assert.equal(markers.body.markers[0].name, 'Northport');
    const provinces = await json(`/api/lobbies/${id}/game/provinces`, { headers });
    assert.equal(provinces.body.provinces[0].b, '#aabb88');
    const mask = await fetch(base + `/api/lobbies/${id}/landmask`, { headers });
    assert.equal(mask.status, 200);
    assert.ok((await mask.arrayBuffer()).byteLength > 12);
  } finally {
    child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); setTimeout(resolve, 3000); });
    const parent = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(path.resolve(dir).startsWith(parent) && path.basename(dir).startsWith('woe-azgaar-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
