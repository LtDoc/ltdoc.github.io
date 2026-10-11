'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const vm = require('node:vm');

test('audio preferences persist per account, validate input, and survive reopening the database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-audio-test-'));
  process.env.WOE_DATA_DIR = dir;
  const { db } = require('../server/db');
  const auth = require('../server/auth');
  const app = express();
  app.use(express.json(), auth.attachUser);
  app.use('/api/auth', require('../server/routes/auth'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/auth/me/audio`;
  const insert = db.prepare("INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, '', 0)");
  const first = insert.run('first', 'First').lastInsertRowid;
  const second = insert.run('second', 'Second').lastInsertRowid;
  const cookie = id => `${require('../server/config').cookieName}=${auth.createSession(id, 'test')}`;
  const a = cookie(first), b = cookie(second);
  async function request(method, session, body) {
    const res = await fetch(base, { method, headers: { Cookie: session || '', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, ...(await res.json()) };
  }
  try {
    assert.equal((await request('GET')).status, 401);
    assert.equal((await request('PATCH', null, { musicVolume: 10 })).status, 401);
    assert.deepEqual((await request('GET', a)).settings, { musicVolume: null, musicEnabled: null });
    assert.equal((await request('PATCH', a, { musicVolume: 0, musicEnabled: false })).status, 200);
    assert.deepEqual((await request('GET', a)).settings, { musicVolume: 0, musicEnabled: false });
    assert.deepEqual((await request('GET', b)).settings, { musicVolume: null, musicEnabled: null });
    for (const body of [{}, { musicVolume: -1 }, { musicVolume: 21 }, { musicVolume: '8' }, { musicVolume: null }, { musicEnabled: 1 }]) {
      assert.equal((await request('PATCH', a, body)).status, 400);
    }
    assert.equal((await request('PATCH', a, { musicVolume: 20, userId: second })).status, 200);
    assert.deepEqual((await request('GET', a)).settings, { musicVolume: 20, musicEnabled: false });
    assert.equal((await request('GET', b)).settings.musicVolume, null);
    await new Promise(resolve => server.close(resolve));
    db.close();
    const { DatabaseSync } = require('node:sqlite');
    const reopened = new DatabaseSync(require('../server/config').dbFile);
    assert.deepEqual({ ...reopened.prepare('SELECT music_volume, music_enabled FROM users WHERE id = ?').get(first) },
      { music_volume: 20, music_enabled: 0 });
    reopened.close();
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(dir).startsWith('woe-audio-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function browser(settings, saved = {}) {
  const storage = new Map(Object.entries(saved));
  const writes = [];
  const audio = { paused: true, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } };
  const context = vm.createContext({ Audio: function () { return audio; }, localStorage: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { addEventListener() {} }, document: { hidden: false, addEventListener() {} },
    api: { get: async () => ({ settings }), request: async (_, url, value, options) => {
      assert.equal(options.keepalive, true);
      writes.push(value); Object.assign(settings, value);
    } }, toast() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/music.js'), 'utf8'), context);
  return { music: context.window.CampaignMusic, audio, writes };
}
test('music restores server settings before playback and retains zero across refresh', async () => {
  const settings = { musicVolume: 0, musicEnabled: false };
  const page = browser(settings, { 'woe.campaignMusicVolume': '18' });
  assert.equal(page.audio.paused, true);
  await page.music.initialize(1);
  assert.equal(page.music.volume, 0);
  assert.equal(page.audio.volume, 0);
  assert.equal(page.music.enabled, false);
  assert.equal(page.writes.length, 0);
  page.music.volume = 12;
  await new Promise(resolve => setImmediate(resolve));
  const refreshed = browser(settings);
  await refreshed.music.initialize(1);
  assert.equal(refreshed.audio.volume, 0.12);
});
test('accounts without server preferences inherit existing browser music settings', async () => {
  const page = browser({ musicVolume: null, musicEnabled: null }, { 'woe.campaignMusicVolume': '3', 'woe.campaignMusic': '0' });
  await page.music.initialize(1);
  assert.equal(page.writes[0].musicVolume, 3);
  assert.equal(page.writes[0].musicEnabled, false);
});
