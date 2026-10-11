'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-treaty-test-'));
process.env.WOE_DATA_DIR = temp;
process.env.WOE_BACKUP_HOURS = '0';
const { db } = require('../server/db');
const game = require('../server/game');
const treaties = require('../server/treaties');
const research = require('../server/research');
const production = require('../server/production');
const provinces = require('../server/provinces');
const access = require('../server/lobbyAccess');
db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (1, 'host', 'Host', 'unused', 1)").run();
let serial = 0;
async function fixture(t) {
  const id = ++serial;
  db.prepare("INSERT INTO lobbies (id, name, join_code, owner_id, map_width, map_height, created_at) VALUES (?, 'Test', ?, 1, 100, 100, 1)").run(id, `test-${id}`);
  const lobby = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(id), ids = [];
  for (const name of ['Germany', 'France', 'UK', 'Austria-Hungary', 'Observerland']) ids.push(Number(db.prepare('INSERT INTO factions (lobby_id, name, color, created_at) VALUES (?, ?, ?, 1)').run(id, name, '#123456').lastInsertRowid));
  const g = game.get(id); g.enabled = true; g.settings = { ...g.settings, startYear: 1900, supplyEnabled: false, upkeepEnabled: false, baseMoney: 0, baseRp: 0, baseManpower: 0 };
  game.save(g);
  for (const fid of ids) { const s = game.serializeState(game.ensureState(id, fid, g.settings)); s.money = 1000; s.rp = 1000; s.manpower = 1000; s.resources = Object.fromEntries(Object.keys(s.resources).map(k => [k, 1000])); game.writeState(s); }
  const app = express(); app.use(express.json()); app.use((req, res, next) => {
    req.lobby = lobby; req.user = { id: 1 }; req.lobbyRole = req.headers['x-role'] || 'player'; req.member = { nation: req.headers['x-nation'] || 'Germany' }; next();
  }); app.use('/treaties', treaties.router({ sync: () => {} }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (method, endpoint, body, nation = 'Germany', role = 'player') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/treaties${endpoint}`, { method, headers: { 'Content-Type': 'application/json', 'X-Nation': nation, 'X-Role': role }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, ...await r.json() };
  };
  const state = fid => game.serializeState(game.q.state.get(fid));
  const create = async (clauses = [], participants = ids.slice(0, 2), nation = 'Germany', warId) => {
    const r = await request('POST', '/', { participants, clauses, warId }, nation); assert.equal(r.status, 200, r.error); return r.treaty;
  };
  const approve = async (treaty, nation) => { const r = await request('POST', `/${treaty.id}/approve`, { revision: treaty.revision }, nation); assert.equal(r.status, 200, r.error); return r.treaty; };
  return { id, lobby, ids, request, state, create, approve };
}
after(async () => { await new Promise(resolve => setTimeout(resolve, 250)); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('four nations negotiate one peace; revision changes reset approvals and unanimous ratification ends every pair', async t => {
  const f = await fixture(t), [de, fr, uk, ah] = f.ids;
  game.setRelation(f.id, de, ah, 'alliance', 1); game.setRelation(f.id, fr, uk, 'alliance', 1);
  const war = treaties.declare(f.lobby, de, fr);
  assert.equal((await f.request('POST', `/wars/${war.id}/join`, { side: 'defenders' }, 'UK')).status, 200);
  assert.equal((await f.request('POST', `/wars/${war.id}/join`, { side: 'attackers' }, 'Austria-Hungary')).status, 200);
  let treaty = await f.create([], [], 'Germany', war.id);
  assert.deepEqual(new Set(treaty.participants), new Set([de, fr, uk, ah]));
  await f.approve(treaty, 'Germany');
  const edited = await f.request('PATCH', `/${treaty.id}`, { revision: 1, text: 'All four parties agree to peace.' }, 'UK');
  assert.equal(edited.status, 200); treaty = edited.treaty; assert.deepEqual(treaty.approvals, {});
  assert.equal((await f.request('POST', `/${treaty.id}/approve`, { revision: 1 }, 'Germany')).status, 409);
  assert.equal((await f.request('PATCH', `/${treaty.id}`, { revision: 1, text: 'Stale overwrite' }, 'France')).status, 409);
  for (const nation of ['Germany', 'France', 'UK']) await f.approve(treaty, nation);
  assert.equal(game.relationStatus(f.id, de, fr), 'war');
  treaty = await f.approve(treaty, 'Austria-Hungary'); assert.equal(treaty.status, 'active');
  for (const a of [de, ah]) for (const b of [fr, uk]) assert.equal(game.relationStatus(f.id, a, b), 'peace');
  assert.equal(treaties.load(f.id).wars[0].status, 'ended');
});

test('defensive pacts force defensive entry; coalition war entry is voluntary and invalidates a conference', async t => {
  const f = await fixture(t), [de, fr, uk, ah] = f.ids;
  let pact = await f.create([{ kind: 'defense', from: fr, to: uk }], [fr, uk], 'France');
  await f.approve(pact, 'France'); await f.approve(pact, 'UK');
  let coalition = await f.create([{ kind: 'coalition', name: 'Central powers', members: [de, ah] }], [de, ah]);
  await f.approve(coalition, 'Germany'); await f.approve(coalition, 'Austria-Hungary');
  const war = treaties.declare(f.lobby, de, fr);
  assert.deepEqual(war.defenders, [fr, uk]); assert.deepEqual(war.attackers, [de]);
  let peace = await f.create([], [], 'Germany', war.id); await f.approve(peace, 'Germany');
  const joined = await f.request('POST', `/wars/${war.id}/join`, { side: 'attackers' }, 'Austria-Hungary'); assert.equal(joined.status, 200);
  peace = treaties.load(f.id).treaties.find(x => x.id === peace.id); assert.equal(peace.revision, 2); assert.deepEqual(peace.approvals, {}); assert.ok(peace.participants.includes(ah));
});

test('research discount locks when a new project starts, is mutual, never stacks, and preserves existing projects', async t => {
  const f = await fixture(t), [de, fr, uk] = f.ids;
  research.upsert(f.id, { key: 'shared', name: 'Shared research', year: 1914, rp: 100, money: 0, prereqs: [], effects: [] });
  const tech = research.get(f.id, 'shared'), tree = research.list(f.id);
  for (const fid of [fr, uk]) { const s = f.state(fid); s.techs.push('shared'); game.writeState(s); }
  let old = f.state(de); research.start(old, tech, tree, game.get(f.id)); game.writeState(old);
  for (const partner of [fr, uk]) {
    const treaty = await f.create([{ kind: 'research', from: de, to: partner }], [de, partner]); await f.approve(treaty, 'Germany'); await f.approve(treaty, partner === fr ? 'France' : 'UK');
  }
  assert.equal(treaties.researchCost(f.id, de, tech, f.state(de)), 100);
  const fresh = f.state(de); fresh.research = {}; research.start(fresh, tech, tree, game.get(f.id)); assert.equal(fresh.research.costs.shared, 70);
  const a = f.state(de); a.techs.push('shared'); game.writeState(a);
  const b = f.state(fr); b.techs = b.techs.filter(k => k !== 'shared'); assert.equal(treaties.researchCost(f.id, fr, tech, b), 70);
  const treaty = treaties.load(f.id).treaties[0]; await f.request('POST', `/${treaty.id}/withdraw`, { revision: treaty.revision });
  assert.equal(fresh.research.costs.shared, 70);
});

test('licenses permit production without research and expiry cancels and refunds unfinished builds', async t => {
  const f = await fixture(t), [de, fr] = f.ids;
  research.upsert(f.id, { key: 'license_air', name: 'Licensed fighters', year: 1915, rp: 100, money: 0, effects: [{ type: 'unlockUnit', unit: 'fighter' }] });
  const s = f.state(de); s.techs.push('license_air'); game.writeState(s);
  const treaty = await f.create([{ kind: 'license', from: de, to: fr, unitType: 'fighter', duration: 1 }]); await f.approve(treaty, 'Germany'); await f.approve(treaty, 'France');
  const b = f.state(fr), before = b.money;
  const site = { id: 123, type: 'factory', name: 'Works', x: 0, y: 0, data: { nation: 'France', industry: 2 } };
  const fx = research.effectsFor(research.list(f.id), b.techs);
  const item = production.queue(f.lobby, game.get(f.id), { id: fr, name: 'France' }, b, [site], { typeId: 'fighter', siteId: 123 }, fx);
  assert.ok(item.license); assert.ok(!b.techs.includes('license_air')); assert.ok(b.money < before);
  const states = game.factionStates(f.id, game.get(f.id).settings).map(x => x.faction.id === fr ? { ...x, state: b } : x);
  game.transaction(() => treaties.tick(f.lobby, states, 2));
  assert.equal(b.production.length, 0); assert.equal(b.money, before); assert.equal(treaties.license(f.id, fr, 'fighter', 2), null);
});

test('province demands validate owners; settlement transfers selected provinces and annexation transfers the remainder', async t => {
  const f = await fixture(t), [de, fr] = f.ids;
  const addProvince = (name, x) => Number(db.prepare('INSERT INTO provinces (lobby_id, name, state, cx, cy, faction_id, geometry, updated_at) VALUES (?, ?, ?, ?, 5, ?, ?, 1)').run(f.id, name, 'France', x + 5, fr, JSON.stringify([[[[x, 0], [x + 10, 0], [x + 10, 10], [x, 10], [x, 0]]]])).lastInsertRowid);
  const a = addProvince('West', 0), b = addProvince('East', 10); provinces.invalidate(f.id);
  const treaty = await f.create([{ kind: 'transfer', from: fr, to: de, provinceIds: [a] }]); await f.approve(treaty, 'Germany'); await f.approve(treaty, 'France');
  assert.equal(provinces.list(f.id).find(p => p.id === a).factionId, de); assert.equal(provinces.list(f.id).find(p => p.id === b).factionId, fr);
  assert.equal((await f.request('POST', '/', { participants: [de, fr], clauses: [{ kind: 'transfer', from: fr, to: de, provinceIds: [a] }] })).status, 400);
  const annex = await f.create([{ kind: 'annex', from: fr, to: de }]); await f.approve(annex, 'Germany'); await f.approve(annex, 'France'); assert.ok(provinces.list(f.id).every(p => p.factionId === de));
});

test('access rights are directional and separate; withdrawal records a public breach', async t => {
  const f = await fixture(t), [de, fr] = f.ids;
  const treaty = await f.create([{ kind: 'access', from: fr, to: de, rights: ['land', 'ports'] }]); await f.approve(treaty, 'Germany'); await f.approve(treaty, 'France');
  assert.equal(treaties.permission(f.id, de, fr, 'land'), true); assert.equal(treaties.permission(f.id, fr, de, 'land'), false);
  assert.equal(treaties.permission(f.id, de, fr, 'supply'), false); assert.equal(treaties.permission(f.id, de, fr, 'airfields'), false);
  await f.request('POST', `/${treaty.id}/withdraw`, { revision: treaty.revision }, 'France'); assert.equal(treaties.permission(f.id, de, fr, 'land'), false);
  assert.ok(db.prepare('SELECT headline FROM news_posts WHERE lobby_id = ?').all(f.id).some(p => p.headline.includes('Treaty broken')));
});

test('reparations carry arrears, recover funds and make news without restarting war', async t => {
  const f = await fixture(t), [de, fr] = f.ids;
  const treaty = await f.create([{ kind: 'reparations', from: de, to: fr, amount: 100, turns: 2 }]); await f.approve(treaty, 'Germany'); await f.approve(treaty, 'France');
  const states = game.factionStates(f.id, game.get(f.id).settings), payer = states.find(x => x.faction.id === de).state, payee = states.find(x => x.faction.id === fr).state;
  payer.money = 20; payee.money = 0; game.transaction(() => treaties.tick(f.lobby, states, 2));
  let rt = Object.values(treaties.load(f.id).treaties[0].runtime)[0]; assert.equal(rt.due, 80); assert.equal(payee.money, 20);
  payer.money = 200; game.transaction(() => treaties.tick(f.lobby, states, 3)); rt = Object.values(treaties.load(f.id).treaties[0].runtime)[0];
  assert.equal(rt.due, 0); assert.equal(rt.paid, 200); assert.equal(payee.money, 200); assert.equal(game.relationStatus(f.id, de, fr), 'peace');
  assert.ok(db.prepare('SELECT headline FROM news_posts WHERE lobby_id = ?').all(f.id).some(p => p.headline.includes('Reparations missed')));
});

test('unauthorized editing, cross-campaign nations and observer mutations are rejected', async t => {
  const f = await fixture(t), treaty = await f.create();
  assert.equal((await f.request('PATCH', `/${treaty.id}`, { revision: 1, text: 'Intruder' }, 'Observerland')).status, 403);
  assert.equal((await f.request('POST', `/${treaty.id}/approve`, { revision: 1 }, 'Germany', 'observer')).status, 403);
  assert.equal((await f.request('POST', '/', { participants: [f.ids[0], 999999] })).status, 400);
  const outsiderView = await f.request('GET', '/', undefined, 'Observerland'); assert.equal(outsiderView.treaties.length, 0);
  const badLicense = await f.request('POST', '/', { participants: f.ids.slice(0, 2), clauses: [{ kind: 'license', from: f.ids[0], to: f.ids[1], unitType: 'nonexistent' }] }); assert.equal(badLicense.status, 400);
});

test('turn undo restores reparations, treaty ledger and generated news', async t => {
  const f = await fixture(t), [de, fr] = f.ids;
  const treaty = await f.create([{ kind: 'reparations', from: de, to: fr, amount: 100, turns: 1 }]); await f.approve(treaty, 'Germany'); await f.approve(treaty, 'France');
  const before = f.state(de).money, ledger = treaties.load(f.id);
  game.endTurn(f.lobby); assert.ok(f.state(de).money < before); assert.equal(game.get(f.id).turn, 2);
  game.undoTurn(f.lobby); assert.equal(f.state(de).money, before); assert.deepEqual(treaties.load(f.id), ledger); assert.equal(game.get(f.id).turn, 1);
});

test('future peace activates on its agreed turn, transfers ownership, and undo restores the scheduled settlement', async t => {
  const f = await fixture(t), [de, fr] = f.ids;
  const pid = Number(db.prepare("INSERT INTO provinces (lobby_id, name, state, cx, cy, faction_id, geometry, updated_at) VALUES (?, 'Border', 'France', 5, 5, ?, '[[[[0,0],[10,0],[10,10],[0,10],[0,0]]]]', 1)").run(f.id, fr).lastInsertRowid);
  db.prepare("INSERT INTO markers (lobby_id, type, name, x, y, data, created_at, updated_at) VALUES (?, 'town', 'Border town', 5, 5, ?, 1, 1)").run(f.id, JSON.stringify({ nation: 'France', size: 'village' }));
  const war = treaties.declare(f.lobby, de, fr);
  let treaty = await f.create([{ kind: 'transfer', from: fr, to: de, provinceIds: [pid] }], [], 'Germany', war.id);
  treaty = (await f.request('PATCH', `/${treaty.id}`, { revision: treaty.revision, effectiveTurn: 2 })).treaty;
  await f.approve(treaty, 'Germany'); treaty = await f.approve(treaty, 'France'); assert.equal(treaty.status, 'scheduled');
  assert.equal(game.relationStatus(f.id, de, fr), 'war'); game.endTurn(f.lobby);
  assert.equal(treaties.load(f.id).treaties[0].status, 'active'); assert.equal(game.relationStatus(f.id, de, fr), 'peace');
  assert.equal(provinces.list(f.id)[0].factionId, de); assert.equal(access.serializeMarker(game.q.markers.all(f.id)[0]).data.nation, 'Germany');
  game.undoTurn(f.lobby);
  assert.equal(treaties.load(f.id).treaties[0].status, 'scheduled'); assert.equal(game.relationStatus(f.id, de, fr), 'war');
  assert.equal(provinces.list(f.id)[0].factionId, fr); assert.equal(access.serializeMarker(game.q.markers.all(f.id)[0]).data.nation, 'France');
});

test('a scheduled settlement with invalid territory leaves the entire war unchanged and clears approvals', async t => {
  const f = await fixture(t), [de, fr, uk] = f.ids;
  const pid = Number(db.prepare("INSERT INTO provinces (lobby_id, name, state, cx, cy, faction_id, geometry, updated_at) VALUES (?, 'Border', 'France', 5, 5, ?, '[[[[0,0],[10,0],[10,10],[0,10],[0,0]]]]', 1)").run(f.id, fr).lastInsertRowid);
  const war = treaties.declare(f.lobby, de, fr);
  let treaty = await f.create([{ kind: 'transfer', from: fr, to: de, provinceIds: [pid] }], [], 'Germany', war.id);
  treaty = (await f.request('PATCH', `/${treaty.id}`, { revision: treaty.revision, effectiveTurn: 2 })).treaty;
  await f.approve(treaty, 'Germany'); await f.approve(treaty, 'France'); provinces.setOwner(f.id, [pid], uk);
  game.endTurn(f.lobby);
  const restored = treaties.load(f.id).treaties[0]; assert.equal(restored.status, 'draft'); assert.deepEqual(restored.approvals, {});
  assert.equal(game.relationStatus(f.id, de, fr), 'war'); assert.equal(provinces.list(f.id)[0].factionId, uk);
});

test('land passage is required across foreign provinces and does not grant supply access', async t => {
  const f = await fixture(t), [de, fr] = f.ids;
  db.prepare("INSERT INTO provinces (lobby_id, name, state, cx, cy, faction_id, geometry, updated_at) VALUES (?, 'France', 'France', 5, 5, ?, '[[[[0,0],[10,0],[10,10],[0,10],[0,0]]]]', 1)").run(f.id, fr); provinces.get(f.id);
  const g = { ...game.get(f.id), settings: { ...game.get(f.id).settings, waiveMovement: true } };
  const unit = { type: 'unit', name: 'Infantry', x: -2, y: 5, data: { nation: 'Germany', unitType: 'Infantry', movement: 10, strength: 100 } };
  assert.match(game.checkMove(f.lobby, g, false, unit, 12, 5).error, /land passage/);
  const treaty = await f.create([{ kind: 'access', from: fr, to: de, rights: ['land'] }]); await f.approve(treaty, 'Germany'); await f.approve(treaty, 'France');
  assert.equal(game.checkMove(f.lobby, g, false, unit, 12, 5).error, undefined); assert.equal(treaties.permission(f.id, de, fr, 'supply'), false);
});

test('coalitions persist beyond treaty expiry and can be dissolved only with all their members included', async t => {
  const f = await fixture(t), [de, fr, uk] = f.ids;
  let treaty = await f.create([{ kind: 'coalition', name: 'League', members: [de, fr, uk] }], [de, fr, uk]);
  treaty = (await f.request('PATCH', `/${treaty.id}`, { revision: treaty.revision, duration: 1 })).treaty;
  for (const nation of ['Germany', 'France', 'UK']) await f.approve(treaty, nation);
  game.endTurn(f.lobby); const co = treaties.load(f.id).coalitions[0]; assert.equal(co.status, 'active'); assert.equal(game.relationStatus(f.id, de, fr), 'alliance');
  assert.equal((await f.request('POST', '/', { participants: [de, fr], clauses: [{ kind: 'dissolve', coalitionId: co.id }] })).status, 400);
  const dissolve = await f.create([{ kind: 'dissolve', coalitionId: co.id }], [de, fr, uk]); for (const nation of ['Germany', 'France', 'UK']) await f.approve(dissolve, nation);
  assert.equal(treaties.load(f.id).coalitions[0].status, 'dissolved'); assert.equal(game.relationStatus(f.id, de, fr), 'peace');
});

test('peace retains captured provinces omitted from its demands while an explicit cession takes precedence', async t => {
  const f = await fixture(t), [de, fr] = f.ids;
  const territory = require('../server/territory');
  const insert = (name, owner, x) => Number(db.prepare('INSERT INTO provinces (lobby_id, name, state, cx, cy, faction_id, geometry, updated_at) VALUES (?, ?, ?, ?, 5, ?, ?, 1)').run(f.id, name, 'France', x + 5, owner, JSON.stringify([[[[x, 0], [x + 10, 0], [x + 10, 10], [x, 10], [x, 0]]]])).lastInsertRowid);
  const occupied = insert('Captured', fr, 0), ceded = insert('Ceded', fr, 40), untouched = insert('Retained by France', fr, 80);
  // Existing hosted campaigns can retain historical free-form polygons alongside their province data.
  territory.write(f.id, fr, [[[[0, 0], [100, 0], [100, 10], [0, 10], [0, 0]]]]);
  provinces.get(f.id);
  const war = treaties.declare(f.lobby, de, fr);
  const unit = { id: 999, type: 'unit', name: 'Germany infantry', x: 5, y: 5, data: { nation: 'Germany', unitType: 'infantry', strength: 100 } };
  const captured = territory.capture(f.lobby, { ...game.get(f.id), settings: { ...game.get(f.id).settings, captureRadiusKm: 1 } }, unit, game.q.factions.all(f.id), [], (a, b) => game.relationStatus(f.id, a, b));
  assert.ok(captured.owners.some(([id]) => id === occupied)); assert.equal(provinces.list(f.id).find(p => p.id === occupied).factionId, de);
  const treaty = await f.create([{ kind: 'transfer', from: fr, to: de, provinceIds: [ceded] }], [], 'Germany', war.id);
  await f.approve(treaty, 'Germany'); await f.approve(treaty, 'France');
  const owners = new Map(provinces.ownership(f.id)); assert.equal(owners.get(occupied), de); assert.equal(owners.get(ceded), de); assert.equal(owners.get(untouched), fr);
  provinces.invalidate(f.id); // simulate reopening an existing campaign with fresh server caches
  assert.equal(provinces.ownerAt(f.id, 5, 5), de); assert.equal(provinces.ownerAt(f.id, 45, 5), de);
  assert.equal(game.relationStatus(f.id, de, fr), 'peace');
});
