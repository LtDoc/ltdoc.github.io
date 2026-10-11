'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('GM assigns persistent role-specific traits; players cannot change them; combat names the source', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-hero-traits-api-'));
  const socket = net.createServer();
  await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise(r => socket.close(r));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve(__dirname, '..'), env: {
    ...process.env, WOE_DATA_DIR: dir, WOE_BACKUP_HOURS: '0', PORT: String(port), HOST: '127.0.0.1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  async function call(method, url, cookie, body) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { await fetch(`http://127.0.0.1:${port}/api/version`); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(ready, output);
    const register = async name => {
      const r = await call('POST', '/api/auth/register', null, { username: name, displayName: name, password: 'Testing-password-123!' });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      return { cookie: r.cookie, id: r.data.user.id };
    };
    const gm = await register('traitgm'), player = await register('traitplayer'), enemy = await register('traitenemy');
    const lobby = (await call('POST', '/api/lobbies', gm.cookie, { name: 'Hero traits' })).data.lobby;
    const root = `/api/lobbies/${lobby.id}`;
    for (const user of [player, enemy]) assert.equal((await call('POST', '/api/lobbies/join', user.cookie, { code: lobby.joinCode })).status, 200);
    for (const name of ['A', 'B']) assert.equal((await call('POST', `${root}/factions`, gm.cookie, { name })).status, 201);
    for (const [user, nation] of [[player, 'A'], [enemy, 'B']]) assert.equal((await call('PATCH', `${root}/members/${user.id}`, gm.cookie, { nation })).status, 200);
    const create = async body => {
      const r = await call('POST', `${root}/markers`, gm.cookie, body);
      assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.marker;
    };
    const hero = await create({ type: 'hero', name: 'Cavalry leader', x: 10, y: 10, data: { role: 'general', nation: 'A', stars: 3, traits: ['cavalryman', 'cavalryman', 'industrialist', 'inspiringCommander', 'logistician', 'unknown'] } });
    assert.deepEqual(hero.data.traits, ['cavalryman', 'inspiringCommander']);
    const edited = await call('PATCH', `${root}/markers/${hero.id}`, player.cookie, { data: { traits: ['logistician'] } });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.deepEqual(edited.data.marker.data.traits, hero.data.traits);
    assert.equal((await call('PATCH', `${root}/markers/${hero.id}`, enemy.cookie, { data: { traits: [] } })).status, 403);
    const a = await create({ type: 'unit', name: 'Cavalry', x: 10, y: 10, data: { nation: 'A', unitType: 'Cavalry', attack: 8, defend: 1, strength: 100 } });
    const b = await create({ type: 'unit', name: 'Enemy', x: 11, y: 10, data: { nation: 'B', unitType: 'Infantry', attack: 4, defend: 4, strength: 100 } });
    const combat = await call('POST', `${root}/combat`, gm.cookie, { attackerId: a.id, defenderId: b.id });
    assert.equal(combat.status, 201, JSON.stringify(combat.data));
    assert.equal(combat.data.event.data.aTotal - combat.data.event.data.aRoll, 11);
    assert.match(JSON.stringify(combat.data), /Expert Cavalryman/);
    assert.match(JSON.stringify(combat.data), /Cavalry leader/);
    const changedRole = await call('PATCH', `${root}/markers/${hero.id}`, gm.cookie, { data: { role: 'statesman', traits: ['industrialist', 'railMagnate', 'cavalryman'] } });
    assert.equal(changedRole.status, 200, JSON.stringify(changedRole.data));
    assert.deepEqual(changedRole.data.marker.data.traits, ['industrialist', 'railMagnate']);
    const engineerHero = await call('PATCH', `${root}/markers/${hero.id}`, gm.cookie, { data: { role: 'general', traits: ['combatEngineer'] } });
    assert.equal(engineerHero.status, 200);
    const engineer = await create({ type: 'unit', name: 'Builders', x: 10, y: 10, data: { nation: 'A', unitType: 'Engineers', strength: 100 } });
    assert.equal((await call('PATCH', `${root}/game`, gm.cookie, { enabled: true, settings: { phases: false, supplyEnabled: false } })).status, 200);
    assert.equal((await call('POST', `${root}/game/enable`, gm.cookie, { enabled: true })).status, 200);
    const plan = await call('POST', `${root}/shapes`, gm.cookie, { kind: 'rail', label: 'Extension', points: [[10, 10], [100, 10]], data: { state: 'plan', nation: 'A' } });
    assert.equal(plan.status, 201, JSON.stringify(plan.data));
    const order = await call('POST', `${root}/game/units/${engineer.id}/railbuild`, player.cookie, {});
    assert.equal(order.status, 200, JSON.stringify(order.data));
    assert.match(order.data.message, /18.75/);
    assert.match(order.data.message, /6.25 iron, 6.25 timber/);
    assert.equal((await call('POST', `${root}/game/end-turn`, gm.cookie, {})).status, 200);
    const lines = await call('GET', `${root}/shapes`, gm.cookie);
    const built = lines.data.shapes.find(s => s.kind === 'rail' && s.data?.state !== 'plan');
    assert.ok(built);
    assert.equal(built.points.reduce((sum, p, i, points) => i ? sum + Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) : sum, 0), 18.75);
    const spy = await create({ type: 'hero', name: 'Secret network', x: 10, y: 10, data: { role: 'spy', nation: 'A', traits: ['networkCoordinator'] } });
    const visible = await call('GET', `${root}/markers`, enemy.cookie);
    assert.equal(visible.data.markers.some(m => m.id === spy.id), false);
    const diplomat = await create({ type: 'hero', name: 'Envoy', x: 10, y: 10, data: { role: 'diplomat', nation: 'A', traits: ['industrialist', 'masterOfDisguise'] } });
    assert.deepEqual(diplomat.data.traits, []);
  } finally {
    if (child.exitCode === null) { const ended = new Promise(r => child.once('exit', r)); child.kill(); await ended; }
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('woe-hero-traits-api-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
