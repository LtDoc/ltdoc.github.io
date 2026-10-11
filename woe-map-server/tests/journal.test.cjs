'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

test('campaign journal, government and news access', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-journal-test-'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, WOE_DATA_DIR: dir, WOE_BACKUP_HOURS: '0', PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const base = `http://127.0.0.1:${port}`;
  async function call(method, url, cookie, body) {
    const res = await fetch(base + url, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { await fetch(base + '/api/version'); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(ready, output);
    const register = async name => {
      const r = await call('POST', '/api/auth/register', null, { username: name, password: 'test-password', displayName: name });
      assert.equal(r.status, 201); return { id: r.data.user.id, cookie: r.cookie };
    };
    const gm = await register('journalgm'), a = await register('journala'), b = await register('journalb'), teammate = await register('journalteam'), c = await register('journalc');
    const lobby = (await call('POST', '/api/lobbies', gm.cookie, { name: 'Journal test' })).data.lobby;
    const root = `/api/lobbies/${lobby.id}`;
    for (const user of [a, b, teammate, c]) assert.equal((await call('POST', '/api/lobbies/join', user.cookie, { code: lobby.joinCode })).status, 200);
    const fa = (await call('POST', `${root}/factions`, gm.cookie, { name: 'A' })).data.faction;
    const fb = (await call('POST', `${root}/factions`, gm.cookie, { name: 'B' })).data.faction;
    const fc = (await call('POST', `${root}/factions`, gm.cookie, { name: 'C' })).data.faction;
    assert.equal((await call('PATCH', `${root}/members/${a.id}`, gm.cookie, { nation: 'A' })).status, 200);
    assert.equal((await call('PATCH', `${root}/members/${b.id}`, gm.cookie, { nation: 'B' })).status, 200);
    assert.equal((await call('PATCH', `${root}/members/${teammate.id}`, gm.cookie, { nation: 'A' })).status, 200);
    assert.equal((await call('PATCH', `${root}/members/${c.id}`, gm.cookie, { nation: 'C' })).status, 200);
    const government = `${root}/game/government/${fa.id}`;
    const original = (await call('GET', government, a.cookie)).data;
    assert.equal(original.profile.revision, 0);
    assert.equal(original.canEdit, true);
    assert.equal((await call('GET', government, b.cookie)).data.canEdit, false);
    const statesman = await call('POST', `${root}/markers`, gm.cookie, { type: 'hero', x: 10, y: 10, name: 'Premier', data: { role: 'statesman', nation: 'A', stars: 2 } });
    assert.equal(statesman.status, 201, JSON.stringify(statesman.data));
    assert.equal((await call('GET', `${root}/markers`, teammate.cookie)).data.markers.some(m => m.id === statesman.data.marker.id), true);
    assert.equal((await call('PATCH', `${root}/markers/${statesman.data.marker.id}`, teammate.cookie, { name: 'Premier' })).status, 200);
    assert.equal((await call('PATCH', `${root}/markers/${statesman.data.marker.id}`, b.cookie, { name: 'Usurper' })).status, 403);
    const spy = await call('POST', `${root}/markers`, gm.cookie, { type: 'hero', x: 11, y: 11, name: 'Agent', data: { role: 'spy', nation: 'A', stars: 2 } });
    assert.equal(spy.status, 201);
    const profile = { revision: 0, governmentForm: 'Constitutional monarchy', character: 'A maritime power', priorities: ['Secure the ports'], politicalFactions: [{ name: 'Reformers', description: 'Seek a wider franchise' }], figures: [{ name: 'The Premier', title: 'Head of government', description: 'A cautious negotiator', heroId: statesman.data.marker.id }] };
    assert.equal((await call('PUT', government, b.cookie, profile)).status, 403);
    assert.equal((await call('PUT', government, a.cookie, { ...profile, figures: [{ name: 'Agent', heroId: spy.data.marker.id }] })).status, 400);
    const firstSave = await call('PUT', government, a.cookie, profile);
    assert.equal(firstSave.status, 200, JSON.stringify(firstSave.data));
    assert.equal(firstSave.data.profile.revision, 1);
    assert.equal(firstSave.data.profile.figures[0].hero.role, 'statesman');
    assert.equal((await call('PUT', government, teammate.cookie, { ...profile, character: 'New draft' })).status, 409);
    const secondSave = await call('PUT', government, teammate.cookie, { ...profile, revision: 1, character: 'A maritime republic' });
    assert.equal(secondSave.status, 200);
    assert.equal(secondSave.data.profile.updatedBy, teammate.id);
    assert.equal((await call('GET', government, b.cookie)).data.profile.character, 'A maritime republic');
    const news = `${root}/game/news`;
    const publish = { kind: 'statement', headline: 'The cabinet speaks', publicBody: 'We seek peace.', privateBody: 'Prepare the fleet.', audience: 'leadership' };
    assert.equal((await call('POST', news, a.cookie, { ...publish, kind: 'world-event' })).status, 403);
    assert.equal((await call('POST', news, a.cookie, { ...publish, kind: 'announcement' })).status, 403);
    const firstNews = await call('POST', news, a.cookie, publish);
    assert.equal(firstNews.status, 201, JSON.stringify(firstNews.data));
    assert.equal(firstNews.data.post.sourceName, 'A');
    const cannotImpersonate = await call('POST', news, b.cookie, { ...publish, factionId: fa.id, headline: 'False attribution', privateBody: '' });
    assert.equal(cannotImpersonate.status, 201);
    assert.equal(cannotImpersonate.data.post.sourceName, 'B');
    const nid = firstNews.data.post.id;
    const posts = async user => (await call('GET', news, user.cookie)).data.posts;
    assert.equal((await posts(b)).find(p => p.id === nid).publicBody, 'We seek peace.');
    assert.equal((await posts(b)).find(p => p.id === nid).privateBody, undefined);
    assert.equal((await posts(b)).find(p => p.id === nid).privateTo, undefined);
    assert.equal((await posts(teammate)).find(p => p.id === nid).privateBody, 'Prepare the fleet.');
    assert.equal((await posts(gm)).find(p => p.id === nid).privateBody, 'Prepare the fleet.');
    assert.equal((await call('PATCH', `${root}/game/relations`, gm.cookie, { a: fa.id, b: fb.id, status: 'alliance' })).status, 200);
    const allied = await call('POST', news, a.cookie, { kind: 'report', headline: 'Joint plans', privateBody: 'Move at dawn.', audience: 'allies' });
    assert.equal(allied.status, 201);
    assert.equal((await posts(b)).find(p => p.id === allied.data.post.id).privateBody, 'Move at dawn.');
    assert.equal((await posts(c)).some(p => p.id === allied.data.post.id), false);
    assert.equal((await call('PATCH', `${root}/game/relations`, gm.cookie, { a: fa.id, b: fb.id, status: 'peace' })).status, 200);
    assert.equal((await posts(b)).find(p => p.id === allied.data.post.id).privateBody, 'Move at dawn.');
    const later = await call('POST', news, a.cookie, { kind: 'report', headline: 'New plans', privateBody: 'Move at dusk.', audience: 'allies' });
    assert.equal(later.status, 201);
    assert.equal((await posts(b)).some(p => p.id === later.data.post.id), false);
    const briefing = await call('POST', news, gm.cookie, { kind: 'briefing', headline: 'For C', privateBody: 'A secret world event.', audience: 'selected', targets: [fc.id] });
    assert.equal(briefing.status, 201);
    assert.equal((await posts(b)).some(p => p.id === briefing.data.post.id), false);
    assert.equal((await posts(c)).find(p => p.id === briefing.data.post.id).privateBody, 'A secret world event.');
    const world = await call('POST', news, gm.cookie, { kind: 'world-event', headline: 'The summit', publicBody: 'Leaders meet.' });
    assert.equal(world.status, 201);
    assert.equal((await posts(c)).find(p => p.id === world.data.post.id).publicBody, 'Leaders meet.');
    assert.equal((await call('POST', news, a.cookie, { ...publish, audience: 'selected', targets: [999999] })).status, 400);
    const journal = `${root}/game/journal`;
    const entry = { factionId: fa.id, date: '1914-08-01', kind: 'crisis', title: 'Secret cabinet', body: 'The plan', private: true, link: `/map/${lobby.id}` };
    assert.equal((await call('POST', journal, b.cookie, entry)).status, 403);
    assert.equal((await call('POST', journal, a.cookie, { ...entry, link: 'javascript:alert(1)' })).status, 400);
    const created = await call('POST', journal, a.cookie, entry);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.entry.id;
    const foreign = await call('GET', `${journal}?factionId=${fa.id}`, b.cookie);
    assert.equal(foreign.data.entries.length, 0);
    assert.equal(foreign.data.stolen.length, 0);
    assert.equal((await call('PATCH', `${journal}/${id}`, b.cookie, entry)).status, 403);
    assert.equal((await call('GET', `${journal}?factionId=${fa.id}`, a.cookie)).data.entries[0].title, 'Secret cabinet');
    assert.equal((await call('GET', `${journal}?factionId=${fa.id}`, gm.cookie)).data.entries[0].title, 'Secret cabinet');
    const copyScript = `const j = require('./server/journal'); const req = { lobby: { id: Number(process.argv[1]) } }; const a = { id: Number(process.argv[2]), name: 'A' }, b = { id: Number(process.argv[3]), name: 'B' }; if (!j.hasStealable(req, b, a)) process.exit(2); const copy = j.steal(req, b, a); if (!copy || j.hasStealable(req, b, a)) process.exit(3);`;
    execFileSync(process.execPath, ['-e', copyScript, String(lobby.id), String(fa.id), String(fb.id)], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, WOE_DATA_DIR: dir }, timeout: 5000 });
    const stolen = (await call('GET', `${journal}?factionId=${fb.id}`, b.cookie)).data.stolen;
    assert.equal(stolen.length, 1);
    assert.equal(stolen[0].body, 'The plan');
    assert.equal((await call('GET', `${journal}?factionId=${fb.id}`, a.cookie)).data.stolen.length, 0);
    const publicEntry = await call('POST', journal, a.cookie, { ...entry, factionId: fa.id, private: false, title: 'The speech' });
    assert.equal(publicEntry.status, 201);
    assert.deepEqual((await call('GET', `${journal}?factionId=${fa.id}`, b.cookie)).data.entries.map(e => e.title), ['The speech']);
    assert.equal((await call('POST', journal, a.cookie, { ...entry, factionId: fb.id })).status, 403);
    assert.equal((await call('DELETE', `${journal}/${id}`, b.cookie)).status, 403);
    assert.equal((await call('DELETE', `${journal}/${id}`, a.cookie)).status, 200);
    assert.equal((await call('GET', `${journal}?factionId=${fb.id}`, b.cookie)).data.stolen[0].body, 'The plan');
  } finally {
    child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); setTimeout(resolve, 3000); });
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
