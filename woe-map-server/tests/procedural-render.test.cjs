'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PIXI = require('pixi.js');
const ctx = { PIXI, window: {}, performance, EventTarget };
vm.createContext(ctx);
for (const name of ['towns', 'resource-art', 'map-renderer']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js', name + '.js'), 'utf8'), ctx);

test('procedural images have local bounded frames and release both geometry and owned textures', () => {
  const renderer = Object.create(ctx.window.MapRenderer.prototype);
  for (const detail of [false, true]) {
    let options;
    const texture = new PIXI.Texture({ source: new PIXI.TextureSource({ width: 64, height: 64 }) });
    const source = texture.source;
    renderer.app = { renderer: { generateTexture: o => { options = o; return texture; } } };
    const graphics = new PIXI.Graphics().rect(-2, -2, 4, 4).fill(0xffffff);
    const sprite = renderer._proceduralSprite(graphics, { reach: 100 }, detail);
    assert.equal(graphics.destroyed, true);
    assert.equal(options.frame.x, -101);
    assert.equal(options.frame.width, 202);
    assert.ok(options.resolution * options.frame.width <= 2048);
    assert.equal(sprite.anchor.x, 0.5);
    sprite.destroy();
    assert.equal(texture.destroyed, true);
    assert.equal(source.destroyed, true);
  }
});

test('town and resource plans rebuild after offscreen images are released', () => {
  const r = Object.create(ctx.window.MapRenderer.prototype);
  const plan = { x: 100, y: 100, reach: 10 }, site = { m: { x: 100, y: 100 }, plan, detail: false, R: 8 };
  const makeImage = () => new PIXI.Container();
  Object.defineProperty(r, 'scale', { value: 2 }); r.townLayer = new PIXI.Container(); r.fieldLayer = new PIXI.Container();
  r.towns = new Map([[1, site]]); r.fieldSites = new Map();
  r._fieldTex = null; r.invalidate = () => {}; r._inLake = () => false;
  r._drawTown = t => { t.g = makeImage(); t.dirty = false; };
  r._tickTowns(80, 80, 120, 120);
  const first = site.g;
  r._tickTowns(500, 500, 600, 600);
  assert.equal(first.destroyed, true);
  assert.equal(site.g, null);
  assert.equal(site.plan, plan);
  r._tickTowns(80, 80, 120, 120);
  assert.ok(site.g && site.g !== first);
  // Exercise the equivalent resource culling/rebuild path without changing its retained plan.
  r.towns.clear(); r.fieldSites.set(1, site);
  const draw = ctx.window.ResourceArt.draw;
  ctx.window.ResourceArt.draw = () => new PIXI.Graphics();
  r._proceduralSprite = g => { g.destroy(); return makeImage(); };
  try {
    const previous = site.g;
    r._tickFields(500, 500, 600, 600);
    assert.equal(previous.destroyed, true);
    r._tickFields(80, 80, 120, 120);
    assert.ok(site.g);
    assert.equal(site.plan, plan);
    site.dirty = true;
    const stale = site.g;
    r._tickFields(80, 80, 120, 120);
    assert.equal(stale.destroyed, true);
    assert.equal(site.dirty, false);
  } finally { ctx.window.ResourceArt.draw = draw; }
});
