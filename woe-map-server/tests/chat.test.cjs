'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-chat-test-'));
process.env.WOE_DATA_DIR = scratch;
const { db } = require('../server/db');
const auth = require('../server/auth');
const hub = require('../server/ws');
const broadcasts = [];
hub.broadcast = (lobbyId, message, filter) => broadcasts.push({ lobbyId, message, filter });
const express = require('express');
const app = express();
app.use(express.json()); app.use(auth.attachUser);
app.use('/api/lobbies', require('../server/routes/lobbies'));
let server, base, cookies = {};
before(async () => {
  for (const [id, username, name] of [[1, 'gm_user', 'GM'], [2, 'alice', 'Alice'], [3, 'bob', 'Bob'], [4, 'outsider', 'Outsider']]) {
    db.prepare('INSERT INTO users(id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(id, username, name, 'test-only', Date.now());
    cookies[id] = `woe_session=${auth.createSession(id, 'regression test')}`;
  }
  db.prepare('INSERT INTO lobbies(id,name,join_code,owner_id,created_at) VALUES(1,?,?,1,?)').run('Test campaign', 'TEST01', Date.now());
  for (const id of [1, 2, 3, 4]) db.prepare('INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES(1,?,?,?)').run(id, id === 1 ? 'gm' : 'player', Date.now());
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/lobbies/1`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  db.close();
  // Only remove the uniquely created test directory under the OS temp directory.
  const target = path.resolve(scratch), parent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(target), parent); assert.ok(path.basename(target).startsWith('woe-chat-test-'));
  fs.rmSync(target, { recursive: true, force: true });
});
async function api(user, method, route, body) {
  const r = await fetch(base + route, { method, headers: { Cookie: cookies[user], 'Content-Type': 'application/json' }, ...(body == null ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, data: await r.json() };
}
const post = (user, route, body) => api(user, 'POST', route, body);
async function privateChat() { return (await post(2, '/chats', { members: [3], name: `Test ${crypto.randomUUID()}` })).data.channel.key; }

test('GM permission applies to both text and GIF announcements; room chat never broadcasts a Log event', async () => {
  const gif = { url: 'https://static.klipy.com/test.gif', title: 'Test' };
  for (const body of [{ message: 'forbidden' }, { gif }]) assert.equal((await post(2, '/chats/gm/messages', body)).status, 403);
  const start = broadcasts.length;
  assert.equal((await post(1, '/chats/gm/messages', { gif })).status, 201);
  assert.equal((await post(2, '/chats/ooc/messages', { message: 'Conversation only' })).status, 201);
  assert.ok(broadcasts.slice(start).every(x => x.message.type !== 'event'));
  assert.equal((await post(2, '/chats/ooc/messages', { message: '/roll d20' })).status, 201);
  const log = (await api(2, 'GET', '/events')).data.events;
  assert.ok(log.some(e => e.kind === 'roll'));
  assert.ok(log.every(e => !['chat', 'announce'].includes(e.kind)));
});
test('mentions resolve to permitted stable IDs; replies, search and pins cannot cross chat boundaries', async () => {
  const key = await privateChat();
  const original = (await post(2, `/chats/${key}/messages`, { message: '@bob hold the railway. @outsider cannot be tagged here.' })).data.message;
  assert.deepEqual(original.data.mentions.map(x => x.userId), [3]);
  assert.equal((await api(4, 'GET', `/chats/${key}/messages?q=railway`)).status, 404);
  const other = await privateChat();
  assert.equal((await post(2, `/chats/${other}/messages`, { message: 'Wrong chat reply', replyTo: original.id })).status, 400);
  const reply = (await post(3, `/chats/${key}/messages`, { message: 'Agreed', replyTo: original.id })).data.message;
  assert.equal(reply.reply.text, original.message);
  assert.equal((await post(2, `/chats/${key}/messages/${original.id}/pin`, {})).status, 200);
  assert.equal((await api(3, 'GET', `/chats/${key}/messages?pins=1`)).data.messages.length, 1);
  assert.equal((await api(3, 'GET', `/chats/${key}/messages?mentions=1`)).data.messages[0].id, original.id);
  assert.equal((await api(3, 'GET', `/chats/${key}/messages?q=railway`)).data.messages.length, 1);
  assert.equal((await api(4, 'GET', `/chats/${key}/messages?around=${original.id}`)).status, 404);
  const channel = (await api(3, 'GET', '/chats')).data.channels.find(c => c.key === key);
  assert.equal(channel.mentions, 1);
  await api(2, 'DELETE', `/chats/${key}/messages/${original.id}`);
  const updated = (await api(3, 'GET', `/chats/${key}/messages`)).data.messages;
  assert.equal(updated.find(m => m.id === reply.id).reply.text, '(message deleted)');
  assert.equal((await api(3, 'GET', `/chats/${key}/messages?pins=1`)).data.messages.length, 0);
});
test('retry tokens make sends and named group creation idempotent', async () => {
  const clientId = crypto.randomUUID(), body = { members: [3], name: 'Retry group', clientId };
  const first = await post(2, '/chats', body), second = await post(2, '/chats', body);
  assert.equal(first.data.channel.key, second.data.channel.key);
  const key = first.data.channel.key, message = { message: 'Only once', clientId: crypto.randomUUID() };
  const a = await post(2, `/chats/${key}/messages`, message), b = await post(2, `/chats/${key}/messages`, message);
  assert.equal(a.data.message.id, b.data.message.id);
  assert.equal((await api(3, 'GET', `/chats/${key}/messages`)).data.messages.length, 1);
  assert.equal((await post(2, '/chats/ooc/messages', message)).status, 409);
});
test('history supports complete forward paging, bounded read marks and explicit unread', async () => {
  const key = await privateChat(), channelId = Number(key.slice(1));
  const insert = db.prepare('INSERT INTO chat_messages(lobby_id,channel_id,user_id,message,created_at) VALUES(1,?,2,?,?)');
  let first, last;
  for (let i = 0; i < 250; i++) { last = Number(insert.run(channelId, `message ${i}`, Date.now()).lastInsertRowid); if (i === 0) first = last; }
  const a = (await api(3, 'GET', `/chats/${key}/messages?after=0&limit=200`)).data;
  assert.equal(a.messages.length, 200); assert.equal(a.more, true);
  const b = (await api(3, 'GET', `/chats/${key}/messages?after=${a.messages.at(-1).id}&limit=200`)).data;
  assert.equal(b.messages.length, 50); assert.equal(b.more, false);
  const read = (await post(3, `/chats/${key}/read`, { lastId: Number.MAX_SAFE_INTEGER })).data;
  assert.equal(read.lastId, last); assert.equal(read.channel.unread, 0);
  const unread = (await post(3, `/chats/${key}/unread`, { beforeId: first })).data;
  assert.equal(unread.channel.unread, 250);
  await api(3, 'PATCH', `/chats/${key}/preferences`, { notifications: 'mentions' });
  assert.equal((await api(3, 'GET', '/chats')).data.channels.find(c => c.key === key).notifications, 'mentions');
});

const Model = require('../public/js/chat-model');
test('mentions handle punctuation and exact usernames without guessing ambiguous case', () => {
  const { metadata } = require('../server/chat');
  const members = [{ username: 'bob', user_id: 3 }, { username: 'Bob', user_id: 4 }, { username: 'bob.smith', user_id: 5 }];
  const message = '@bob. @Bob! @BOB @bob.smith. @bob_unknown';
  const mentions = metadata(message, members).mentions;
  assert.deepEqual(mentions.map(m => m.userId), [3, 4, 5]);
  assert.deepEqual(mentions.map(m => message.slice(m.start, m.end)), ['@bob', '@Bob', '@bob.smith']);
});
test('link formatting trims punctuation, balances parentheses and escapes markup', () => {
  assert.match(Model.linkify('See (https://example.org/plan).'), /href="https:\/\/example.org\/plan"/);
  assert.match(Model.linkify('https://example.org/wiki/Foo_(bar).'), /href="https:\/\/example.org\/wiki\/Foo_\(bar\)"/);
  assert.doesNotMatch(Model.linkify('<script>alert(1)</script>'), /<script>/);
  assert.match(Model.linkify('https://example.org/?a=1&b=2'), /a=1&amp;b=2/);
});

function clientHarness() {
  const nodes = new Map(), timers = new Map(), sent = []; let timer = 0;
  function node(key) {
    if (!nodes.has(key)) nodes.set(key, { value: '', hidden: true, style: {}, dataset: {}, scrollTop: 0, scrollHeight: 300, clientHeight: 300,
      classList: { toggle() {}, add() {} }, querySelectorAll: () => [], querySelector: () => null, setAttribute() {}, removeAttribute() {}, replaceChildren() {},
      getBoundingClientRect: () => ({ top: 0, bottom: 300 }), focus() {} });
    return nodes.get(key);
  }
  const env = { window: { matchMedia: () => ({ matches: false }) }, document: { querySelector: node, visibilityState: 'visible', hasFocus: () => true },
    localStorage: { setItem() {} }, ChatModel: Model, crypto, console, Date, Map, Set, esc: s => String(s), toast() {},
    setTimeout: f => { timers.set(++timer, f); return timer; }, clearTimeout: id => timers.delete(id),
    api: { get: async () => ({ channels: [] }), post: async (u, b) => { sent.push({ u, b }); return { lastId: b.lastId }; } } };
  let src = fs.readFileSync(path.join(__dirname, '../public/js/comms.js'), 'utf8');
  src = src.replace('return { init, onChatChannel,', `return { test: { channels, messages, drafts, outgoing, readPending, ingest, loadPage, resync, markRead, flushRead, send, transmit, openTab,
    setup(k='ooc', target=null) { ctx={me:{id:1},base:'/test',state:{lobby:{id:1},members:[]}}; open=true; tab=k; draft=target; renderChat=renderBadge=renderSide=renderHead=renderOutgoing=renderReply=hideMentions=autosize=()=>{}; }, }, init, onChatChannel,`);
  vm.runInNewContext(src, env);
  return { t: env.window.Comms.test, env, sent, node, timers };
}
test('live history arrivals merge rather than disappear, and updates do not inflate unread counts', async () => {
  const h = clientHarness(); h.t.setup();
  h.t.channels.set('ooc', { key: 'ooc', lastId: 100, unread: 0, myRead: 100 });
  let resolve; h.env.api.get = () => new Promise(r => { resolve = r; });
  const loading = h.t.loadPage('ooc');
  h.t.ingest({ id: 101, channel: 'ooc', userId: 2, createdAt: 1 });
  resolve({ messages: [{ id: 100 }], more: false }); await loading;
  assert.deepEqual(Array.from(h.t.messages.get('ooc').list, m => m.id), [100, 101]);
  h.t.messages.delete('ooc');
  h.t.ingest({ id: 101, channel: 'ooc', userId: 2, createdAt: 1 }, true);
  assert.equal(h.t.channels.get('ooc').unread, 1);
});
test('reconnect recovers all 250 missed messages and refreshes old deleted text', async () => {
  const h = clientHarness(); h.t.setup();
  h.t.channels.set('ooc', { key: 'ooc', lastId: 1, myRead: 1, unread: 0 });
  h.t.messages.set('ooc', { list: [{ id: 1, message: 'old' }], loaded: true });
  const all = Array.from({ length: 251 }, (_, i) => ({ id: i + 1, message: i === 0 ? '(message deleted)' : 'new' }));
  h.env.api.get = async u => {
    if (u.endsWith('/chats')) return { channels: [{ key: 'ooc', lastId: 251, myRead: 1, unread: 250 }] };
    const after = Number(new URL(u, 'http://test').searchParams.get('after'));
    const remaining = all.filter(m => m.id > after); return { messages: remaining.slice(0, 200), more: remaining.length > 200 };
  };
  await h.t.resync();
  assert.equal(h.t.messages.get('ooc').list.length, 251);
  assert.equal(h.t.messages.get('ooc').list[0].message, '(message deleted)');
  assert.equal(h.sent.length, 0, 'Nothing has actually been seen in this DOM');
});
test('read acknowledgements are per-channel, viewport bounded, and survive failure', async () => {
  const h = clientHarness(); h.t.setup();
  const visible = { dataset: { message: '5' }, getBoundingClientRect: () => ({ top: 10, bottom: 40 }) };
  h.node('#chatBody').querySelectorAll = () => [visible];
  for (const k of ['ooc', 'gm']) { h.t.channels.set(k, { key: k, lastId: 10, myRead: 0 }); h.t.messages.set(k, { list: [{ id: 5 }], loaded: true }); }
  h.t.markRead(); h.t.setup('gm'); h.t.markRead();
  assert.equal(h.t.readPending.size, 2);
  await h.t.flushRead('ooc'); await h.t.flushRead('gm');
  assert.deepEqual(h.sent.map(x => x.b.lastId), [5, 5]);
  h.t.readPending.set('ooc', 8); h.env.api.post = async () => { throw new Error('offline'); };
  await h.t.flushRead('ooc'); assert.equal(h.t.readPending.get('ooc'), 8);
});

test('a live arrival beyond a reconnect snapshot keeps forward paging available', async () => {
  const h = clientHarness(); h.t.setup();
  h.t.channels.set('ooc', { key: 'ooc', lastId: 3, myRead: 0 });
  h.t.messages.set('ooc', { list: [{ id: 1 }], loaded: true, newer: true });
  h.env.api.get = async u => {
    if (u.endsWith('/chats')) return { channels: [{ key: 'ooc', lastId: 3, myRead: 0 }] };
    h.t.ingest({ id: 4, channel: 'ooc', userId: 2, createdAt: 1 });
    return { messages: [{ id: 1 }, { id: 2 }, { id: 3 }], more: false };
  };
  await h.t.resync();
  assert.equal(h.t.messages.get('ooc').newer, true);
  assert.equal(h.t.channels.get('ooc').lastId, 4);
});

test('sending works on plain HTTP LAN hosts without crypto.randomUUID', async () => {
  const h = clientHarness(); h.t.setup();
  h.env.crypto = { getRandomValues: crypto.getRandomValues.bind(crypto) };
  h.t.channels.set('ooc', { key: 'ooc' });
  h.node('#chatMsg').value = 'LAN message'; h.node('#chatMsg').dataset.draftKey = 'ooc';
  h.env.api.post = async () => { throw new Error('test offline'); };
  await h.t.send();
  await new Promise(resolve => setImmediate(resolve));
  assert.match([...h.t.outgoing.values()][0].id, /^[a-f0-9]{32}$/);
});
test('failed sends preserve newer drafts and keep retry tokens tied to the original chat', async () => {
  const h = clientHarness(); h.t.setup(); h.t.channels.set('ooc', { key: 'ooc' });
  h.node('#chatMsg').value = 'First message'; h.node('#chatMsg').dataset.draftKey = 'ooc';
  let reject; h.env.api.post = () => new Promise((_, r) => { reject = r; });
  await h.t.send(); await Promise.resolve();
  h.node('#chatMsg').value = 'New draft'; reject(new Error('offline'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.node('#chatMsg').value, 'New draft');
  const item = [...h.t.outgoing.values()][0]; assert.equal(item.status, 'failed'); assert.equal(item.channel, 'ooc');
  const token = item.id; h.t.setup('gm');
  h.env.api.post = async (u, b) => { assert.match(u, /\/ooc\/messages$/); assert.equal(b.clientId, token); return { message: { id: 1, channel: 'ooc', userId: 1, createdAt: 1 } }; };
  await h.t.transmit(item); assert.equal(h.t.outgoing.size, 0);
});
test('conversation switches restore separate unsent drafts', async () => {
  const h = clientHarness(); h.t.setup();
  for (const k of ['ooc', 'c1']) { h.t.channels.set(k, { key: k }); h.t.messages.set(k, { list: [], loaded: true }); }
  h.node('#chatMsg').dataset.draftKey = 'ooc'; h.node('#chatMsg').value = 'Public draft';
  await h.t.openTab('c1'); assert.equal(h.node('#chatMsg').value, '');
  h.node('#chatMsg').value = 'Secret draft'; await h.t.openTab('ooc');
  assert.equal(h.node('#chatMsg').value, 'Public draft');
  await h.t.openTab('c1'); assert.equal(h.node('#chatMsg').value, 'Secret draft');
});
