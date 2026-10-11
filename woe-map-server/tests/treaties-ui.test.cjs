'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let playwright;
try { playwright = require(process.env.WOE_PLAYWRIGHT_MODULE || 'playwright'); } catch { /* optional browser dependency */ }

test('treaty editor preserves shared writing, handles revision conflicts, picks provinces and fits mobile', { skip: !playwright, timeout: 30000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'woe-treaty-ui-'));
  process.env.WOE_DATA_DIR = temp;
  const express = require('express'), { db } = require('../server/db'), game = require('../server/game'), treaties = require('../server/treaties');
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (1, 'host', 'Host', 'unused', 1)").run();
  db.prepare("INSERT INTO lobbies (id, name, join_code, owner_id, map_width, map_height, created_at) VALUES (1, 'UI test', 'ui', 1, 100, 100, 1)").run();
  db.prepare("INSERT INTO factions (id, lobby_id, name, color, created_at) VALUES (1, 1, 'Germany', '#123456', 1), (2, 1, 'France', '#abcdef', 1)").run();
  const lobby = db.prepare('SELECT * FROM lobbies WHERE id = 1').get();
  db.prepare("INSERT INTO provinces (id, lobby_id, name, state, cx, cy, faction_id, geometry, updated_at) VALUES (1, 1, 'Lorraine', 'France', 5, 5, 2, '[[[[0,0],[10,0],[10,10],[0,10],[0,0]]]]', 1)").run();
  const app = express(); app.use(express.json());
  app.use('/api/lobbies/1/game/treaties', (req, res, next) => { req.lobby = lobby; req.user = { id: 1 }; req.member = { nation: 'Germany' }; req.lobbyRole = 'gm'; next(); }, treaties.router({ sync: () => {} }));
  app.use(express.static(path.resolve(__dirname, '../public')));
  app.get('/vendor/pixi/pixi.min.js', (req, res) => res.sendFile(path.resolve(__dirname, '../node_modules/pixi.js/dist/pixi.min.js')));
  app.get('/harness', (req, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/app.css"><link rel="stylesheet" href="/css/treaties.css"><link rel="stylesheet" href="/css/campaign-theme.css"></head><body class="campaign-map">
    <button id="mapPick" style="position:absolute;top:120px;left:20px">Lorraine province</button><button id="pickerDone" hidden>Done picking</button>
    <script src="/vendor/pixi/pixi.min.js"></script><script src="/js/api.js"></script><script src="/js/units.js"></script><script src="/js/treaties-ui.js"></script><script>
    const province = {id:1,n:'Lorraine',g:[[[[0,0],[10,0],[10,10],[0,10],[0,0]]]]};
    window.testCtx = {state:{factions:[{id:1,name:'Germany'},{id:2,name:'France'}],game:{turn:1},role:'gm',myFactionId:1},base:'/api/lobbies/1',isGm:()=>true,
      renderer:{provinces:[province],scale:1,overlayLayer:new PIXI.Container(),provinceAt:()=>province,territoryOwnerAt:()=>2},
      armTreatyPicker:p=>{window.picker=p;document.querySelector('#pickerDone').hidden=false;}};
    document.querySelector('#mapPick').onclick=()=>window.picker?.pick(5,5);
    document.querySelector('#pickerDone').onclick=()=>{window.picker.finish(false);window.picker=null;document.querySelector('#pickerDone').hidden=true;};
    TreatiesUI.init(window.testCtx);TreatiesUI.open(1);
    </script></body></html>`));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  let browser;
  t.after(async () => { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => setTimeout(resolve, 250)); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.WOE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.WOE_CHROMIUM_EXECUTABLE } : {}), timeout: 10000 });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/harness`);
  await page.getByRole('dialog', { name: 'Treaties & coalitions' }).waitFor();
  if (process.env.WOE_TREATY_SCREENSHOT) await page.screenshot({ path: process.env.WOE_TREATY_SCREENSHOT.replace(/\.png$/, '-library.png'), fullPage: true });
  await page.getByRole('button', { name: 'New diplomatic treaty', exact: true }).click();
  await page.locator('#newSignatories input[value="2"]').check();
  await page.getByRole('button', { name: 'Create shared draft', exact: true }).click();
  await page.locator('#treatyText').fill('Our jointly written treaty.');
  assert.equal(await page.locator('[data-treaty="approve"]').isDisabled(), true, 'Unsaved writing cannot be approved');
  await page.getByRole('button', { name: 'Save shared revision', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#treatySaveStatus')?.textContent === 'All changes saved');
  assert.equal(await page.locator('[data-treaty="approve"]').isEnabled(), true);
  await page.getByRole('button', { name: '＋ Add demand / agreement', exact: true }).click();
  await page.locator('[data-clause-kind]').selectOption('transfer');
  await page.locator('[data-field="from"]').selectOption('2'); await page.locator('[data-field="to"]').selectOption('1');
  await page.getByRole('button', { name: 'Select provinces on map (0)', exact: true }).click();
  assert.equal(await page.locator('#treatyModal').evaluate(el => el.classList.contains('open')), false);
  await page.locator('#mapPick').click(); await page.locator('#pickerDone').click();
  await page.getByRole('button', { name: 'Select provinces on map (1)', exact: true }).waitFor();
  assert.equal(await page.locator('#treatyText').inputValue(), 'Our jointly written treaty.');
  await page.getByRole('button', { name: 'Save shared revision', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#treatySaveStatus')?.textContent === 'All changes saved');
  await page.locator('#treatyText').fill('Our local additions survive a conflict.');
  const current = treaties.load(1).treaties[0], url = `http://127.0.0.1:${server.address().port}/api/lobbies/1/game/treaties/${current.id}`;
  const remote = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ factionId: 2, revision: current.revision, title: 'Treaty of Lorraine', text: 'France proposes its own text.' }) }); assert.equal(remote.status, 200);
  await page.evaluate(() => TreatiesUI.changed());
  await page.locator('#treatyConflict').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#treatyText').inputValue(), 'Our local additions survive a conflict.');
  await page.getByRole('button', { name: 'Merge my changes after review', exact: true }).click();
  assert.equal(await page.locator('#treatyTitle').inputValue(), 'Treaty of Lorraine');
  await page.getByRole('button', { name: 'Save shared revision', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#treatySaveStatus')?.textContent === 'All changes saved');
  assert.equal(treaties.load(1).treaties[0].text, 'Our local additions survive a conflict.');
  if (process.env.WOE_TREATY_SCREENSHOT) await page.screenshot({ path: process.env.WOE_TREATY_SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator('.treaty-card').evaluate(el => el.scrollWidth <= el.clientWidth + 2), 'Treaty editor must not overflow horizontally on mobile');
  await page.locator('[data-treaty="close"]').focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('[data-treaty="approve"]').evaluate(el => el === document.activeElement), true, 'Keyboard focus stays inside the modal');
  if (process.env.WOE_TREATY_SCREENSHOT) await page.screenshot({ path: process.env.WOE_TREATY_SCREENSHOT.replace(/\.png$/, '-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
});
