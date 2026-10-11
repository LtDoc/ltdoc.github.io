'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-hero-traits-'));
process.env.WOE_DATA_DIR = scratch;
const H = require('../public/js/heroes');
const Units = require('../public/js/units');
const RailNet = require('../public/js/railnet');
const { db } = require('../server/db');
const access = require('../server/lobbyAccess');
const rules = require('../server/heroes');
const supply = require('../server/supply');
const game = require('../server/game');
const goods = require('../server/goods');
const G = require('../public/js/game-data');
db.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(1,?,?,?,1)').run('tester', 'Tester', 'unused');
db.prepare('INSERT INTO lobbies(id,name,join_code,owner_id,created_at) VALUES(1,?,?,1,1)').run('Hero traits test', 'HERO01');
db.prepare('INSERT INTO factions(id,lobby_id,name,created_at) VALUES(1,1,?,1)').run('A');
const lobby = access.getLobby(1), settings = G.mergeSettings({ phases: false });
const dist = (x, y, a, b) => Math.hypot(x - a, y - b);
const hero = (traits, role = 'general', extra = {}) => ({ id: 90, type: 'hero', name: 'Commander', x: 0, y: 0, data: { role, nation: 'A', traits, stars: 3, perception: 6, intelligence: 6, ...extra } });
const unit = (id, type, x = 0) => ({ id, type: 'unit', name: type, x, y: 0, data: { nation: 'A', unitType: type, strength: 100, supplied: true, movement: 2 } });
const effect = (markers, target, ctx = {}) => H.effects(markers, target, settings, dist, { type: Units.resolve(target.data?.unitType), ...ctx });
const insert = db.prepare('INSERT INTO markers(id,lobby_id,type,name,x,y,data,created_at,updated_at) VALUES(?,1,?,?,?,?,?,1,1)');
function save(m) { insert.run(m.id, m.type, m.name, m.x, m.y, JSON.stringify(m.data)); }
after(() => {
  db.close();
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith('woe-hero-traits-'));
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('twenty traits are restricted to their roles, deduplicated and capped at two', () => {
  assert.equal(Object.keys(H.TRAITS).length, 20);
  assert.deepEqual(H.cleanTraits('general', ['cavalryman', 'industrialist', 'cavalryman', 'logistician', 'siegeSpecialist', 'unknown']), ['cavalryman', 'logistician']);
  assert.deepEqual(H.cleanTraits('diplomat', ['industrialist', 'masterOfDisguise']), []);
  assert.deepEqual(H.cleanTraits('spy', null), []);
});

test('every military specialty grants its specified effect only to eligible units', () => {
  for (const [key, type, expected, ctx] of [
    ['logistician', 'supply', { supply: 1.25 }],
    ['cavalryman', 'lancers', { attack: 1, walk: 1.25 }],
    ['infantryCommander', 'infantry', { attack: 1, defend: 1 }],
    ['artilleryCoordinator', 'fieldartillery', { attack: 1, spotting: 1.25 }],
    ['siegeSpecialist', 'siegeartillery', { attack: 2 }, { enemyType: Units.resolve('fortress') }],
    ['defensiveStrategist', 'infantry', { defend: 2 }, { entrenched: true }],
    ['assaultPlanner', 'sappers', { attack: 2 }, { enemyEntrenched: true }],
    ['marchingGeneral', 'infantry', { walk: 1.25 }],
    ['combatEngineer', 'railway', { build: 1.25 }],
    ['medicalOrganiser', 'medical', { heal: 5 }],
    ['inspiringCommander', 'infantry', { worn: 1 }],
    ['fleetTactician', 'battleship', { attack: 1, defend: 1 }],
  ]) {
    const u = unit(1, type), h = hero([key]), actual = effect([h], u, ctx);
    for (const [field, value] of Object.entries(expected)) assert.equal(actual[field], value, `${key}: ${field}`);
    assert.equal(effect([h], unit(2, 'airship'), ctx).notes.length, 0, `${key} must not buff aircraft`);
  }
  assert.equal(effect([hero(['cavalryman'])], unit(1, 'tank')).walk, 1);
  assert.equal(effect([hero(['fleetTactician'])], unit(1, 'transport')).attack, 0);
  const cutoff = unit(1, 'infantry'); cutoff.data.supplied = false;
  assert.equal(effect([hero(['marchingGeneral'])], cutoff).walk, 1);
});

test('auras exclude foreign nations, distant, captured, travelling and embarked Heroes and wrecks', () => {
  const u = unit(1, 'infantry');
  for (const h of [hero(['infantryCommander'], 'general', { nation: 'B' }), { ...hero(['infantryCommander']), x: 61 },
    hero(['infantryCommander'], 'general', { status: 'captured' }), hero(['infantryCommander'], 'general', { status: 'travelling' }),
    hero(['infantryCommander'], 'general', { aboard: 5 }), { ...hero(['infantryCommander']), adminOnly: true }]) {
    assert.equal(effect([h], u).attack, 0);
    assert.equal(rules.generalFor(lobby, settings, [h], u), null);
  }
  u.data.strength = 0;
  assert.equal(effect([hero(['infantryCommander'])], u).notes.length, 0);
});

test('duplicate auras count once, combat caps at two, and movement bonuses do not compound', () => {
  const u = unit(1, 'infantry');
  const a = hero(['infantryCommander', 'assaultPlanner']);
  const b = { ...hero(['infantryCommander', 'defensiveStrategist']), id: 91 };
  const t = effect([a, b], u, { enemyEntrenched: true, entrenched: true });
  assert.equal(t.attack, 2); assert.equal(t.defend, 2);
  assert.equal(t.notes.filter(n => n.key === 'infantryCommander').length, 1);
  const cavalry = unit(1, 'cavalry');
  assert.equal(effect([hero(['cavalryman']), { ...hero(['cavalryman']), id: 91 }], cavalry).walk, 1.25);
});

test('spy specialties affect recon, theft and capture without increasing hunt range', () => {
  const spy = hero(['reconnaissanceExpert', 'researchThief'], 'spy');
  assert.equal(H.reconRadius(spy), 125);
  assert.equal(H.missionRadiusKm(spy.data.stars), 100);
  assert.equal(H.theftMultiplier(spy), 1.25);
  const disguised = hero(['masterOfDisguise', 'counterintelligenceChief'], 'spy');
  assert.equal(H.spyIntelligence(disguised), 8); assert.equal(H.spyPerception(disguised), 8);
  const network = { ...hero(['networkCoordinator'], 'spy'), id: 91 };
  assert.equal(rules.intelligence(lobby, settings, [network], disguised), 9);
  assert.equal(rules.intelligence(lobby, settings, [network], network), 6);
  network.x = 61;
  assert.equal(rules.intelligence(lobby, settings, [network], disguised), 8);
  const basic = { ...hero([], 'spy', { perception: 7 }), id: 92 };
  assert.equal(rules.counterSpy(lobby, [basic, disguised], 'A', 0, 0, 150).id, disguised.id);
});

test('logistics extends delivery and linking but cannot create goods or supply across a missing link', () => {
  const town = { id: 1, type: 'town', name: 'Town', x: 0, y: 0, data: { nation: 'A', size: 'village' } };
  const column = unit(2, 'supply', 240), troop = unit(3, 'infantry', 360);
  const h = { ...hero(['logistician']), x: 240 };
  assert.equal(supply.compute(lobby, { ...settings, goodsEnabled: false }, [town, column, troop]).get(3).supplied, false);
  assert.equal(supply.compute(lobby, { ...settings, goodsEnabled: false }, [town, column, troop, h]).get(3).supplied, true);
  column.data.pool = 0; town.data.goods = { military: 0 };
  assert.equal(supply.compute(lobby, settings, [town, column, troop, h]).get(3).supplied, false);
});

test('hospital specialty heals once, caps at full strength and does not heal cut-off troops', () => {
  const u = unit(1, 'infantry'); u.data.strength = 80;
  const medical = unit(2, 'medical'), h = hero(['medicalOrganiser']);
  assert.equal(supply.healing(lobby, settings, [u, medical, h])[0].to, 95);
  u.data.strength = 99; assert.equal(supply.healing(lobby, settings, [u, medical, h])[0].to, 100);
  u.data.supplied = false; assert.equal(supply.healing(lobby, settings, [u, medical, h]).length, 0);
});

test('off-rail movement is cheaper while rail distance uses the independent national bonus', () => {
  const h = hero(['cavalryman']), cavalry = unit(1, 'cavalry');
  save(h);
  const g = { enabled: true, phase: 'move', settings: { ...settings, phases: false, kmPerMove: 50 } };
  const move = game.checkMove(lobby, g, false, cavalry, 125, 0);
  assert.equal(move.clamped, false); assert.equal(move.movedKm, 100);
  const clamped = game.checkMove(lobby, g, false, cavalry, 150, 0);
  assert.equal(clamped.x, 125);
  const net = RailNet.build([{ id: 1, points: [[0, 0], [400, 0]] }], { dist });
  assert.equal(RailNet.route(net, { x: 0, y: 0 }, { x: 400, y: 0 }, { speed: 4, walkSpeed: 1.25 }).cost, 100);
  assert.equal(RailNet.route(net, { x: 0, y: 0 }, { x: 400, y: 0 }, { speed: 5 }).cost, 80);
  assert.equal(RailNet.route(net, { x: 0, y: 10 }, { x: 400, y: 10 }, { speed: 4, walkSpeed: 1.25 }).cost, 116);
  db.prepare('DELETE FROM markers').run();
});

test('economic traits require stationary own-nation Heroes; Rail Magnate requires a real capital', () => {
  const cap = { id: 1, type: 'town', x: 0, y: 0, data: { nation: 'A', size: 'capital' } };
  const h = hero(['railMagnate', 'resourceBaron'], 'statesman'), u = unit(2, 'infantry', 500);
  assert.equal(effect([cap, h], u).rail, 1.25);
  assert.equal(effect([h], u).rail, 1);
  h.data.movedKm = 1; assert.equal(effect([cap, h], u).rail, 1);
  const resource = { id: 3, type: 'resource', x: 0, y: 0, data: { nation: 'A', kind: 'coal', yield: 10 } };
  assert.equal(effect([h], resource).yield, 1);
  h.data.movedKm = 0; assert.equal(effect([h], resource).yield, 1.15);
  resource.x = 101; assert.equal(effect([h], resource).yield, 1);
});

test('Industrialist boosts actual factory goods, including level five, without modifying industry or slots', () => {
  const town = { id: 1, type: 'town', name: 'Home', x: 0, y: 0, data: { nation: 'A', size: 'city', industry: 0, goods: { consumer: 0, military: 0 } } };
  const factory = { id: 2, type: 'factory', name: 'Works', x: 1, y: 0, data: { nation: 'A', industry: 5 } };
  const h = hero(['industrialist'], 'statesman');
  [town, factory, h].forEach(save);
  const state = { policy: { warEconomy: 50 } };
  const report = goods.endTurn(lobby, { settings, turn: 1 }, new Map([['a', state]])).byNation.get('a');
  assert.deepEqual(report.made, { consumer: 30.5, military: 30.5 });
  const markers = db.prepare('SELECT * FROM markers').all().map(access.serializeMarker);
  assert.deepEqual(goods.summary(lobby, settings, { name: 'A' }, state, markers).made, report.made);
  assert.equal(markers.find(m => m.id === factory.id).data.industry, 5);
  db.prepare('DELETE FROM markers').run();
});
