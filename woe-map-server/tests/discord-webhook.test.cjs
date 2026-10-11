'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-discord-test-'));
process.env.WOE_DATA_DIR = dir;
const { db } = require('../server/db');
const webhook = require('../server/discordWebhook');
db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (1, 'gm', 'GM', 'test', 1)").run();
db.prepare("INSERT INTO lobbies (id, name, join_code, owner_id, created_at) VALUES (1, 'Test', 'TEST', 1, 1)").run();

test('Discord webhook URL is restricted to its official HTTPS endpoint', () => {
  const valid = 'https://discord.com/api/webhooks/123456789/token_ABC-123';
  assert.equal(webhook.validateUrl(valid), valid);
  for (const url of [
    'http://discord.com/api/webhooks/123/token',
    'https://discord.com.evil.example/api/webhooks/123/token',
    'https://discord.com@evil.example/api/webhooks/123/token',
    'https://discord.com/api/webhooks/123/token?redirect=evil',
    'https://discord.com/api/webhooks/123/token/extra',
  ]) assert.equal(webhook.validateUrl(url), null);
});

test('saving, delivering, reporting failure and removing a webhook', async () => {
  const url = 'https://discord.com/api/webhooks/123456789/token_ABC-123';
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (target, options) => {
    calls.push({ target, options });
    return { ok: true };
  };
  try {
    assert.equal(webhook.status(1).configured, false);
    assert.equal(webhook.save(1, url).configured, true);
    assert.deepEqual(await webhook.deliver(1, 'Test campaign', {
      kind: 'announcement', title: 'GM announcement', description: '@everyone Turn ended',
      fields: [{ name: 'From', value: 'GM', inline: true }],
    }), { ok: true });
    assert.equal(calls[0].target, `${url}?wait=true`);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.content, undefined);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.equal(body.embeds[0].title, 'GM announcement');
    assert.equal(body.embeds[0].description, '@everyone Turn ended');
    assert.equal(body.embeds[0].footer.text, 'Test campaign');
    assert.equal(body.embeds[0].color, 0xc9a96a);
    assert.deepEqual(body.embeds[0].fields, [{ name: 'From', value: 'GM', inline: true }]);
    assert.ok(!Number.isNaN(Date.parse(body.embeds[0].timestamp)));
    assert.ok(webhook.status(1).lastSentAt);
    global.fetch = async () => ({ ok: false, status: 404 });
    assert.deepEqual(await webhook.deliver(1, 'Test campaign', { kind: 'test', title: 'Test', description: 'Test' }), { ok: false, error: 'Discord returned HTTP 404' });
    assert.equal(webhook.status(1).lastError, 'Discord returned HTTP 404');
    assert.equal(webhook.clear(1).configured, false);
    assert.deepEqual(await webhook.deliver(1, 'Test campaign', { kind: 'test', title: 'Test', description: 'Test' }), { ok: false, error: 'No Discord webhook is configured' });
  } finally { global.fetch = originalFetch; }
});

test('GM-only settings keep the URL private and send each campaign event', { timeout: 30000 }, async () => {
  const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-discord-routes-'));
  const capture = path.join(serverDir, 'sent.jsonl');
  const preload = path.join(serverDir, 'mock-discord.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const original = global.fetch;
global.fetch = (url, options) => {
  if (String(url).startsWith('https://discord.com/api/webhooks/')) {
    fs.appendFileSync(process.env.WOE_DISCORD_CAPTURE, JSON.stringify({ url, body: JSON.parse(options.body) }) + '\\n');
    return Promise.resolve({ ok: true });
  }
  return original(url, options);
};`);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--require', preload, 'server/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, WOE_DATA_DIR: serverDir, WOE_DISCORD_CAPTURE: capture, WOE_BACKUP_HOURS: '0', PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const request = async (method, url, cookie, body) => {
    const response = await fetch(base + url, { method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { await fetch(base + '/api/version'); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(ready, output);
    const owner = await request('POST', '/api/auth/register', null, { username: 'owner', password: 'test-password', displayName: 'Owner' });
    const player = await request('POST', '/api/auth/register', null, { username: 'player', password: 'test-password', displayName: 'Player' });
    const campaign = (await request('POST', '/api/lobbies', owner.cookie, { name: 'Discord test' })).body.lobby;
    await request('POST', '/api/lobbies/join', player.cookie, { code: campaign.joinCode });
    const endpoint = `/api/lobbies/${campaign.id}/discord-webhook`;
    const url = 'https://discord.com/api/webhooks/123456789/secret_token';
    assert.equal((await request('GET', endpoint, player.cookie)).status, 403);
    assert.equal((await request('PUT', endpoint, player.cookie, { url })).status, 403);
    assert.equal((await request('PUT', endpoint, owner.cookie, { url: 'https://evil.example/' })).status, 400);
    const saved = await request('PUT', endpoint, owner.cookie, { url });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.configured, true);
    assert.ok(!JSON.stringify(saved.body).includes('secret_token'));
    assert.ok(!JSON.stringify((await request('GET', `/api/lobbies/${campaign.id}`, player.cookie)).body).includes('secret_token'));
    assert.ok(!JSON.stringify((await request('GET', endpoint, owner.cookie)).body).includes('secret_token'));
    assert.equal((await request('POST', `${endpoint}/test`, owner.cookie, {})).status, 200);
    const a = (await request('POST', `/api/lobbies/${campaign.id}/factions`, owner.cookie, { name: 'A' })).body.faction.id;
    const b = (await request('POST', `/api/lobbies/${campaign.id}/factions`, owner.cookie, { name: 'B' })).body.faction.id;
    assert.equal((await request('POST', `/api/lobbies/${campaign.id}/chats/gm/messages`, owner.cookie, { message: 'Mobilize all forces' })).status, 201);
    assert.equal((await request('POST', `/api/lobbies/${campaign.id}/game/enable`, owner.cookie, { enabled: true, setup: false })).status, 200);
    assert.equal((await request('POST', `/api/lobbies/${campaign.id}/game/phase`, owner.cookie, { phase: 'battle' })).status, 200);
    assert.equal((await request('POST', `/api/lobbies/${campaign.id}/game/end-turn`, owner.cookie, {})).status, 200);
    assert.equal((await request('PATCH', `/api/lobbies/${campaign.id}/game/relations`, owner.cookie, { a, b, status: 'war' })).status, 200);
    assert.equal((await request('PATCH', `/api/lobbies/${campaign.id}/game/relations`, owner.cookie, { a, b, status: 'peace' })).status, 400);
    const treatyEndpoint = `/api/lobbies/${campaign.id}/game/treaties`;
    const war = (await request('GET', treatyEndpoint, owner.cookie)).body.wars.find(w => w.status === 'active');
    const treaty = (await request('POST', treatyEndpoint, owner.cookie, { factionId: a, warId: war.id })).body.treaty;
    assert.equal((await request('POST', `${treatyEndpoint}/${treaty.id}/approve`, owner.cookie, { factionId: a, revision: treaty.revision })).status, 200);
    assert.equal((await request('POST', `${treatyEndpoint}/${treaty.id}/approve`, owner.cookie, { factionId: b, revision: treaty.revision })).status, 200);
    let sent = [];
    for (let i = 0; i < 100; i++) {
      sent = fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse) : [];
      if (sent.length >= 8) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(sent.length, 8, `Expected eight embed messages; got ${JSON.stringify(sent)}`);
    const embeds = sent.map(m => m.body.embeds[0]);
    assert.ok(embeds.some(e => e.title === 'Webhook test'));
    assert.ok(embeds.some(e => e.title.includes('GM announcement') && e.description.includes('Mobilize all forces')));
    assert.ok(embeds.some(e => e.title.includes('Battle phase begins')));
    assert.equal(embeds.filter(e => e.title.includes('Movement phase begins')).length, 2);
    assert.ok(embeds.some(e => e.title.includes('Turn 1 ended')));
    assert.ok(embeds.some(e => e.title.includes('War declared') && e.description.includes('declares war')));
    assert.ok(embeds.some(e => e.title.includes('Peace declared') && e.description.includes('end the war together')));
    assert.ok(embeds.every(e => e.footer.text === 'Discord test' && Number.isInteger(e.color)));
    assert.ok(sent.every(m => m.body.allowed_mentions.parse.length === 0));
    assert.equal((await request('DELETE', endpoint, owner.cookie)).body.configured, false);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(serverDir, { recursive: true, force: true });
  }
});

test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
