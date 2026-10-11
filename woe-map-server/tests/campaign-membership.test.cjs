'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('campaign roles, read-only observers, owner deletion and leaving shut campaigns', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-membership-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, WOE_DATA_DIR: dir, WOE_BACKUP_HOURS: '0', PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const base = `http://127.0.0.1:${port}`;
  async function request(method, url, cookie, body) {
    const response = await fetch(base + url, { method, headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { await fetch(base + '/api/version'); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(ready, `Server did not start: ${output}`);
    const register = async username => {
      const r = await request('POST', '/api/auth/register', null, { username, password: 'test-password', displayName: username });
      assert.equal(r.status, 201);
      return { id: r.body.user.id, cookie: r.cookie };
    };
    const owner = await register('owner');
    const member = await register('member');
    const suspendedOwner = await register('otherowner');
    assert.equal((await request('PATCH', '/api/auth/me/profile', member.cookie, { displayName: 'New Member' })).body.user.displayName, 'New Member');
    const avatar = new FormData();
    avatar.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'avatar.png');
    const avatarResponse = await fetch(base + '/api/auth/me/avatar', { method: 'POST', headers: { Cookie: member.cookie }, body: avatar });
    assert.equal(avatarResponse.status, 200);
    const avatarUrl = (await avatarResponse.json()).user.avatarUrl;
    assert.equal((await fetch(base + avatarUrl)).status, 200);
    assert.equal((await request('PATCH', `/api/auth/users/${member.id}`, owner.cookie, { siteVip: true })).status, 200);
    assert.equal((await request('GET', '/api/auth/me', member.cookie)).body.user.siteVip, true);
    assert.equal((await request('PUT', `/api/auth/users/${member.id}/packs/fantasy`, member.cookie, {})).status, 403);
    assert.equal((await request('PUT', `/api/auth/users/${member.id}/packs/fantasy`, owner.cookie, {})).status, 200);
    assert.equal((await request('GET', '/api/auth/me/packs', member.cookie)).body.packs.find(p => p.id === 'fantasy').owned, true);
    assert.equal((await request('POST', '/api/lobbies', member.cookie, { name: 'Unreleased', unitPack: 'fantasy' })).status, 400);
    const create = async (user, name) => {
      const r = await request('POST', '/api/lobbies', user.cookie, { name });
      assert.equal(r.status, 201);
      return r.body.lobby;
    };
    const campaign = await create(owner, 'Owner campaign');
    assert.equal(campaign.unitPack, 'great-war');
    // A 100 x 100 GIF canvas with a single pixel gives marching orders real map bounds.
    const mapImage = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    mapImage.writeUInt16LE(100, 6); mapImage.writeUInt16LE(100, 8);
    const mapUpload = new FormData();
    mapUpload.append('file', new Blob([mapImage], { type: 'image/gif' }), 'map.gif');
    const mapResponse = await fetch(`${base}/api/lobbies/${campaign.id}/map`,
      { method: 'POST', headers: { Cookie: owner.cookie }, body: mapUpload });
    assert.equal(mapResponse.status, 200);
    const badPack = await request('POST', '/api/lobbies', owner.cookie, { name: 'Bad pack', unitPack: 'ww2' });
    assert.equal(badPack.status, 400);
    const placed = await request('POST', `/api/lobbies/${campaign.id}/markers`, owner.cookie,
      { type: 'unit', x: 10, y: 10, name: 'Infantry', data: { unitType: 'Infantry' } });
    assert.equal(placed.status, 201);
    const foreignUnit = await request('POST', `/api/lobbies/${campaign.id}/markers`, owner.cookie,
      { type: 'unit', x: 10, y: 10, name: 'Sherman', data: { unitType: 'Sherman tank' } });
    assert.equal(foreignUnit.status, 400);
    const changedType = await request('PATCH', `/api/lobbies/${campaign.id}/markers/${placed.body.marker.id}`, owner.cookie,
      { data: { unitType: 'Sherman tank' } });
    assert.equal(changedType.status, 400);
    assert.equal((await request('POST', '/api/lobbies/join', member.cookie, { code: campaign.joinCode })).status, 200);
    const root = `/api/lobbies/${campaign.id}`;
    assert.equal((await request('PATCH', `${root}/members/${owner.id}`, owner.cookie, { role: 'observer' })).status, 400);
    const owned = await request('POST', `${root}/markers`, owner.cookie,
      { type: 'player', x: 20, y: 20, name: 'Assigned marker', ownerId: member.id });
    assert.equal(owned.status, 201);
    const hidden = await request('POST', `${root}/markers`, owner.cookie,
      { type: 'poi', x: 40, y: 40, name: 'GM secret', adminOnly: true });
    assert.equal(hidden.status, 201);
    const faction = await request('POST', `${root}/factions`, owner.cookie, { name: 'Test nation', color: '#123456' });
    assert.equal(faction.status, 201);
    // Joining before nation assignment must not require transferring each GM-placed unit's owner.
    const national = await request('POST', `${root}/markers`, owner.cookie,
      { type: 'unit', x: 20, y: 20, name: 'National infantry', ownerId: owner.id, data: { unitType: 'Infantry', nation: 'Test nation', movement: 3 } });
    assert.equal(national.status, 201);
    const nationalId = national.body.marker.id;
    assert.equal(national.body.marker.ownerId, owner.id);
    assert.equal((await request('PATCH', `${root}/markers/${nationalId}`, member.cookie, { x: 21 })).status, 403);
    assert.equal((await request('PATCH', `${root}/members/${member.id}`, owner.cookie, { nation: 'Test nation' })).status, 200);
    const nationalMove = await request('PATCH', `${root}/markers/${nationalId}`, member.cookie, { x: 21 });
    assert.equal(nationalMove.status, 200);
    assert.equal(nationalMove.body.marker.x, 21);
    assert.equal(nationalMove.body.marker.ownerId, owner.id);
    const groupMove = await request('POST', `${root}/markers/move`, member.cookie,
      { moves: [{ id: nationalId, x: 22, y: 20 }, { id: placed.body.marker.id, x: 22, y: 20 }] });
    assert.equal(groupMove.status, 200);
    assert.deepEqual(groupMove.body.markers.map(m => m.id), [nationalId]);
    assert.equal(groupMove.body.errors.length, 1);
    await request('PATCH', `${root}/members/${member.id}`, owner.cookie, { nation: 'Other nation' });
    assert.equal((await request('PATCH', `${root}/markers/${nationalId}`, member.cookie, { x: 23 })).status, 403);
    await request('PATCH', `${root}/members/${member.id}`, owner.cookie, { nation: 'Test nation' });
    assert.equal((await request('POST', `${root}/game/enable`, owner.cookie, { enabled: true })).status, 200);
    const march = await request('POST', `${root}/game/units/goal`, member.cookie,
      { moves: [{ id: nationalId, x: 23, y: 20 }, { id: placed.body.marker.id, x: 23, y: 20 }] });
    assert.equal(march.status, 200);
    assert.deepEqual(march.body.moved.map(m => m.id), [nationalId], JSON.stringify(march.body));
    assert.equal(march.body.errors.length, 1);
    assert.equal((await request('PATCH', `${root}/game`, owner.cookie, { settings: { fogOfWar: true } })).status, 200);
    assert.ok(!(await request('GET', `${root}/markers`, member.cookie)).body.markers.some(m => m.id === hidden.body.marker.id));
    assert.equal((await request('PATCH', `${root}/members/${member.id}`, member.cookie, { role: 'observer' })).status, 403);
    assert.equal((await request('PATCH', `${root}/members/${member.id}`, owner.cookie, { role: 'observer' })).status, 200);
    const observer = (await request('GET', root, member.cookie)).body;
    assert.equal(observer.you.role, 'observer');
    assert.equal(observer.you.realRole, 'observer');
    assert.equal(observer.lobby.yourRole, 'observer');
    assert.equal(observer.lobby.joinCode, campaign.joinCode);
    assert.equal((await request('GET', '/api/lobbies', member.cookie)).body.lobbies[0].yourRole, 'observer');
    for (const suffix of ['/markers', '/shapes', '/history', '/events', '/game/vision', '/battles',
      `/game/journal?factionId=${faction.body.faction.id}`, `/game/government/${faction.body.faction.id}`, '/game/news']) {
      const gmView = await request('GET', root + suffix, owner.cookie);
      const observerView = await request('GET', root + suffix, member.cookie);
      assert.equal(observerView.status, 200, suffix);
      if (suffix === '/game/news') {
        // Personal faction metadata differs; the observer still receives the same posts as the GM.
        assert.equal(observerView.body.myFactionId, faction.body.faction.id);
        observerView.body.myFactionId = gmView.body.myFactionId;
      }
      assert.deepEqual(observerView.body, gmView.body, suffix);
    }
    const gmGame = (await request('GET', `${root}/game`, owner.cookie)).body;
    const observerGame = (await request('GET', `${root}/game`, member.cookie)).body;
    assert.deepEqual(observerGame.factions, gmGame.factions);
    for (const [method, suffix, body] of [
      ['POST', '/markers', { type: 'poi', x: 1, y: 1 }],
      ['PATCH', `/markers/${owned.body.marker.id}`, { x: 99 }],
      ['PATCH', `/markers/${nationalId}`, { x: 99 }],
      ['DELETE', `/markers/${owned.body.marker.id}`],
      ['POST', '/shapes', { kind: 'line', points: [[0, 0], [1, 1]] }],
      ['PATCH', '', { name: 'Changed' }],
      ['POST', '/code', {}], ['POST', '/game/end-turn', {}], ['POST', '/game/ready', { ready: true }],
      ['POST', '/chat', { message: 'Observer post' }],
      ['PATCH', `/members/${member.id}`, { role: 'gm' }],
      ['DELETE', `/members/${owner.id}`],
      ['POST', '/game/journal', {}], ['POST', '/game/news', {}], ['PUT', `/game/government/${faction.body.faction.id}`, {}],
    ]) assert.equal((await request(method, root + suffix, member.cookie, body)).status, 403, method + suffix);
    // Real-time visibility and drag protection use the same role, even for a marker the observer owns.
    const { WebSocket } = require('ws');
    const sockets = [];
    try {
      async function connect(user) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: user.cookie } });
        sockets.push(ws);
        const messages = [];
        ws.on('message', data => messages.push(JSON.parse(data)));
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        ws.send(JSON.stringify({ type: 'join', lobbyId: campaign.id }));
        return { ws, messages };
      }
      async function waitFor(messages, predicate) {
        for (let i = 0; i < 100; i++) {
          const found = messages.find(predicate);
          if (found) return found;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail('Expected websocket message');
      }
      const spectator = await connect(member), gm = await connect(owner);
      assert.equal((await waitFor(spectator.messages, m => m.type === 'joined')).role, 'observer');
      assert.ok((await waitFor(gm.messages, m => m.type === 'joined')).users.some(u => u.id === member.id && u.role === 'observer'));
      await request('PATCH', `${root}/markers/${hidden.body.marker.id}`, owner.cookie, { name: 'Updated secret' });
      assert.equal((await waitFor(spectator.messages, m => m.type === 'marker' && m.marker?.id === hidden.body.marker.id)).marker.name, 'Updated secret');
      spectator.ws.send(JSON.stringify({ type: 'drag', id: owned.body.marker.id, x: 99, y: 99 }));
      spectator.ws.send(JSON.stringify({ type: 'ping', t: 'barrier' }));
      await waitFor(spectator.messages, m => m.type === 'pong' && m.t === 'barrier');
      assert.ok(!gm.messages.some(m => m.type === 'drag'));
      assert.equal((await request('GET', `${root}/markers`, member.cookie)).body.markers.find(m => m.id === owned.body.marker.id).x, 20);
      await request('PATCH', `${root}/members/${member.id}`, owner.cookie, { role: 'gm' });
      await waitFor(spectator.messages, m => m.type === 'role' && m.role === 'gm');
      assert.equal((await request('PATCH', `${root}/markers/${hidden.body.marker.id}`, member.cookie, { name: 'Co-GM edit' })).status, 200);
      await request('PATCH', `${root}/members/${member.id}`, owner.cookie, { role: 'observer' });
      await waitFor(spectator.messages, m => m.type === 'role' && m.role === 'observer');
      assert.equal((await request('PATCH', `${root}/markers/${hidden.body.marker.id}`, member.cookie, { name: 'Blocked' })).status, 403);
    } finally { for (const ws of sockets) ws.terminate(); }
    assert.equal((await request('DELETE', `/api/lobbies/${campaign.id}`, member.cookie)).status, 403);
    assert.equal((await request('DELETE', `/api/lobbies/${campaign.id}/members/${owner.id}`, owner.cookie)).status, 400);
    assert.equal((await request('DELETE', `/api/lobbies/${campaign.id}/members/${member.id}`, member.cookie)).status, 200);
    assert.equal((await request('GET', '/api/lobbies', member.cookie)).body.lobbies.length, 0);
    assert.equal((await request('POST', '/api/lobbies/join', member.cookie, { code: campaign.joinCode })).status, 200);
    assert.equal((await request('DELETE', `/api/lobbies/${campaign.id}`, owner.cookie)).status, 200);
    assert.equal((await request('GET', '/api/lobbies', member.cookie)).body.lobbies.length, 0);

    const shut = await create(suspendedOwner, 'Shut campaign');
    assert.equal((await request('POST', '/api/lobbies/join', member.cookie, { code: shut.joinCode })).status, 200);
    assert.equal((await request('PATCH', `/api/auth/users/${suspendedOwner.id}`, owner.cookie, { suspended: true })).status, 200);
    assert.equal((await request('DELETE', `/api/lobbies/${shut.id}/members/${member.id}`, member.cookie)).status, 200);
    assert.equal((await request('GET', '/api/lobbies', member.cookie)).body.lobbies.length, 0);
  } finally {
    child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); setTimeout(resolve, 3000); });
    const parent = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(path.resolve(dir).startsWith(parent) && path.basename(dir).startsWith('woe-membership-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
