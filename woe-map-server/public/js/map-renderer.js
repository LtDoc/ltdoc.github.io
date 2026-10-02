'use strict';
/* global PIXI */

/**
 * WebGL map renderer built on PixiJS 8.
 *
 * World space = map image pixels (origin top-left, y down).
 * Markers keep a constant on-screen size regardless of zoom, like the old Leaflet map,
 * and animate: spawn pop, smooth movement tween, idle bob for units, hover scale,
 * selection pulse ring, movement trails, hit shake and fade-out on removal.
 * Shapes (lines and areas) live in their own layer under the markers with constant screen-pixel
 * stroke widths.
 *
 * Events (CustomEvent on the renderer): select {id, shapeId}, mapclick {x,y}, drag {id,x,y},
 * dragend {id,x,y}, zoom {scale}, measure {px,points}|null, drawprogress {kind,points}|null,
 * drawend {kind,points}, frame.
 */
/** Stable pseudo-random number in [0, 1) from two numbers. */
function hash01(a, b) { const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); }
/** Smooth wandering value in about [0, 1] (sum of incommensurate sines), for bursts and lulls. */
function smooth(x) { return 0.5 + 0.25 * Math.sin(x) + 0.15 * Math.sin(x * 2.31 + 1.7) + 0.1 * Math.sin(x * 5.13 + 0.4); }

/** Slice a sprite sheet laid out as one row of square frames. */
function rowFrames(tex) {
  const fw = tex.height, n = Math.max(1, Math.round(tex.width / fw)), out = [];
  for (let i = 0; i < n; i++) out.push(new PIXI.Texture({ source: tex.source, frame: new PIXI.Rectangle(i * fw, 0, fw, tex.height) }));
  return out;
}

class MapRenderer extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.views = new Map();          // marker id -> MarkerView
    this.gameRules = null;           // { enabled, kmPerMove } when the campaign runs in game mode
    this.unitsToPx = (x, y, units) => units;   // campaign units → map px at a point; map.js supplies the Earth version
    this.shapeViews = new Map();     // shape id -> { shape, g, label }
    this.selectedId = null;          // primary selected marker (popup)
    this.selected = new Set();       // all selected marker ids (group moves)
    this.selectedShapeId = null;
    this._marquee = null;            // rubber-band selection in progress
    this._marqueeG = null;
    this.canDrag = () => false;      // (marker) => boolean, set by the app
    this.canEditShape = () => false; // (shape) => boolean, set by the app
    this.mode = null;                // null | 'measure' | 'draw'
    this.measure = { points: [], hover: null, g: null };
    this.draw = { kind: 'line', points: [], hover: null, g: null, lastClick: null, shapeId: null };
    this.earth = null;               // { container, redraw, destroy } when showing the vector Earth
    this._vdrag = null;              // vertex / whole-shape drag in progress
    this._handles = { shapeId: null, items: [] };
    this.grid = { visible: false, size: 100 };
    this.mapSize = { w: 2000, h: 1200 };
    this.minScale = 0.05;
    this.maxScale = 32;              // 32×: dense fronts need room to spread out (tokens stop growing long before this)
    this.tokenScale = 1;             // campaign-wide size multiplier for unit/town/player tokens
    this.tokenMode = 'map';          // 'map': tokens shrink/grow with the zoom (clamped); 'screen': fixed pixel size
    this._pan = null;
    this._drag = null;
    this._textures = new Map();
    this._dirty = true;              // something changed since the last draw
    this._animating = false;         // the last tick left an animation running
    this._lastRender = 0;
    this.idleFps = 24;               // frame cap for idle animations (bobbing aircraft, selection pulse, fires)
  }

  async init() {
    const app = new PIXI.Application();
    await app.init({
      resizeTo: this.container,
      background: 0x1e170f,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      preference: 'webgl',
    });
    this.app = app;
    this.container.appendChild(app.canvas);

    this.world = new PIXI.Container();
    this.mapLayer = new PIXI.Container();
    this.gridLayer = new PIXI.Graphics();
    this.territoryLayer = new PIXI.Container();  // game mode: faction territories (fill + outline + name)
    this.territoryViews = new Map();             // factionId -> { geometry, g, label, color, name }
    this.provinceLayer = window.ProvinceLayer ? new window.ProvinceLayer.Layer(this) : null;   // provinces coloured by owner (Earth, game mode)
    if (this.provinceLayer) this.territoryLayer.addChild(this.provinceLayer.container);
    this.factionInfo = new Map();                // factionId -> { color, name }
    this.sceneryLayer = new PIXI.Container();   // buildings, trenches, craters: scale with the map
    this.sceneryLayer.sortableChildren = true;
    this.townLayer = new PIXI.Container();      // towns drawn from above (towns.js), at map scale, under craters and counters
    this.townLayer.eventMode = 'none';
    this.towns = new Map();                      // town marker id -> { key, m, plan, g, fires, dirty }
    this.scarLayer = new PIXI.Container();      // churned, darkened ground around shell craters, under everything built
    this.scarLayer.eventMode = 'none';
    this.craterLayer = new PIXI.Container();    // shell craters (static sprites, ten turns), under trenches and tokens
    this.craterLayer.eventMode = 'none';
    this.craters = new Map();                    // id -> sprite (its ground scar: sprite.scar)
    this.craterSmokeG = new PIXI.Graphics();     // smoke still rising from this turn's craters
    this.craterSmokeG.eventMode = 'none';
    this.trenchLayer = new PIXI.Container();    // dug earthworks (ribbon meshes), under drawings and tokens
    this.railLayer = new PIXI.Container();      // railway track, trains and smoke over cut sections
    this.railLayer.eventMode = 'none';
    this.railCutKm = 10;                        // half-length of a cut section (campaign rule, set by map.js)
    this.trailG = new PIXI.Graphics();          // game mode: where units and heroes went this turn
    this.trailG.eventMode = 'none';
    this.persistTrails = false;                 // set by map.js while game mode is on (no fading move arrows then)
    this.pingLayer = new PIXI.Container(); this.pingLayer.eventMode = 'none';
    this.pingArrows = new PIXI.Graphics(); this.pingArrows.eventMode = 'none';
    this.pings = new Map();                     // id -> { ping, c }
    this.dragAllowed = () => true;              // (marker) => may it be dragged? map.js: units move by click in game mode
    this.onMapClick = null;                     // (x, y) => true when map.js handled a click on empty map
    this.shapesLayer = new PIXI.Container();
    this.fxLayer = new PIXI.Container();
    this.markerLayer = new PIXI.Container();
    this.markerLayer.sortableChildren = true;
    this.boomLayer = new PIXI.Container();     // explosions, above the markers
    this.gunG = new PIXI.Graphics();             // this turn's gunfire (tracers, muzzle flashes, impacts), under the tokens
    this.gunG.eventMode = 'none';
    this.battles = new Map();                    // id -> { battle, nextShell }
    this.arcG = new PIXI.Graphics();             // shells in flight (above the tokens so they are never hidden)
    this.arcG.eventMode = 'none';
    this.shellsInFlight = [];                    // { x0, y0, x1, y1, t0, dur, h }
    this.overlayLayer = new PIXI.Container();
    this.handleLayer = new PIXI.Container();
    this.unitDots = new PIXI.Graphics();          // zoomed out on the Earth map: one dot per unit instead of its icon
    this.unitDots.eventMode = 'none';
    this.skirmish = window.Skirmish ? new window.Skirmish(this) : null;   // riflemen on infantry firing lines (skirmish.js)
    this.fogLayer = new PIXI.Container(); this.fogLayer.eventMode = 'none';     // fog of war on image maps (Earth: the province layer)
    this.ghostLayer = new PIXI.Container(); this.ghostLayer.eventMode = 'none'; // fog of war: last known enemy positions
    this.rideLayer = new PIXI.Container(); this.rideLayer.eventMode = 'none';   // trains carrying units on a rail trip
    this.rides = new Map();                                                      // unit id -> rail trip being played
    this.world.addChild(...[this.mapLayer, this.territoryLayer, this.gridLayer, this.townLayer, this.scarLayer, this.sceneryLayer, this.craterLayer, this.craterSmokeG, this.trenchLayer, this.railLayer, this.shapesLayer, this.trailG, this.fxLayer, this.fogLayer, this.skirmish?.layer, this.gunG, this.unitDots, this.ghostLayer, this.rideLayer].filter(Boolean), this.markerLayer, this.boomLayer, ...(this.skirmish ? [this.skirmish.airLayer] : []), this.arcG, this.overlayLayer, this.pingLayer, this.handleLayer);
    app.stage.addChild(this.world, this.pingArrows);

    app.stage.eventMode = 'static';
    app.stage.hitArea = app.screen;
    this._bindInput();
    // Render on demand. PixiJS would otherwise redraw every display refresh (145 fps on a 144 Hz monitor),
    // keeping a CPU core and the GPU busy for a map nobody is touching. We stop its ticker and run our own
    // loop that only draws after invalidate() or while an animation is running, throttled to idleFps when
    // the user is not interacting.
    app.ticker.stop();
    this._startLoop();
    app.renderer.on('resize', () => {
      app.stage.hitArea = app.screen;
      this.invalidate();
      // If the last fit happened while the pane was collapsed (e.g. hidden tab), redo it now.
      if (this._fitWasDegenerate && app.screen.width > 100 && app.screen.height > 100) this.fit();
    });

    const type = app.renderer.type;
    this.rendererType = type === PIXI.RendererType.WEBGPU ? 'webgpu' : (type === PIXI.RendererType.WEBGL ? 'webgl' : 'canvas');
    this._loadExplosion();
    this._loadShellBurst();
    this._loadBurning();
  }

  /** Slice the 8×8 burning-wreck sheet; then attach it to any destroyed unit already on screen. */
  async _loadBurning() {
    try {
      const tex = await PIXI.Assets.load({ src: '/assets/burning.webp', loadParser: 'loadTextures' });
      const cols = 8, rows = 8, fw = tex.width / cols, fh = tex.height / rows;
      const frames = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          frames.push(new PIXI.Texture({ source: tex.source, frame: new PIXI.Rectangle(c * fw, r * fh, fw, fh) }));
        }
      }
      this.burningFrames = frames;
      this.burningFrameSize = fw;
      for (const v of this.views.values()) v.refreshFire();
      for (const v of this.shapeViews.values()) if (v.rail) { v.rail.key = null; this._drawShapeView(v); }
      this.invalidate();
    } catch (e) {
      console.warn('Burning sprite sheet not available', e);
    }
  }

  /** Slice the 4×4 explosion sprite sheet into animation frames (loaded in the background). */
  async _loadExplosion() {
    try {
      const tex = await PIXI.Assets.load({ src: '/assets/explosion.png?v=2', loadParser: 'loadTextures' });
      this.explosionFrames = rowFrames(tex);   // 8 frames of 128 px in one row
      this.explosionFrameSize = tex.height;
    } catch (e) {
      console.warn('Explosion sprite sheet not available; using the drawn burst instead', e);
    }
  }

  /** Shell bursts for artillery fire (one row of square frames). */
  async _loadShellBurst() {
    try {
      const tex = await PIXI.Assets.load({ src: '/assets/shellburst.png?v=1', loadParser: 'loadTextures' });
      this.shellFrames = rowFrames(tex);
    } catch (e) { console.warn('Shell burst sprite sheet not available', e); }
  }

  /** Play an explosion at a world position with a given on-screen size in px. `frames` defaults to the explosion sheet. */
  explode(x, y, screenSize = 72, delayMs = 0, frames = null) {
    this.invalidate();
    frames = frames || this.explosionFrames;
    if (!frames) return false;
    const sp = new PIXI.AnimatedSprite(frames);
    sp.anchor.set(0.5);
    sp.loop = false;
    sp.animationSpeed = frames.length <= 8 ? 0.2 : 0.42;   // about 0.6 s whatever the sheet
    sp.position.set(x, y + 2);
    sp.rotation = frames === this.explosionFrames ? Math.random() * Math.PI * 2 : 0;   // shell bursts stay upright
    sp.screenSize = screenSize;
    sp.life = 4000;                           // safety net; onComplete ends it
    sp.onComplete = () => { sp.life = 0; };
    sp.visible = delayMs === 0;
    sp.frameSize = frames[0].frame.height;
    sp.scale.set(screenSize / sp.frameSize / this.scale);
    this.boomLayer.addChild(sp);
    if (delayMs > 0) setTimeout(() => { if (!sp.destroyed) { sp.visible = true; sp.play(); this.invalidate(); } }, delayMs);
    else sp.play();
    return true;
  }

  // ---- Map image / Earth -----------------------------------------------------------
  _clearMap() {
    if (this.earth) { this.mapLayer.removeChild(this.earth.container); this.earth.destroy(); this.earth = null; }
    for (const c of this.mapLayer.removeChildren()) c.destroy();
  }

  /** Show the bundled vector Earth (see earth.js). opts = lobby.settings.earth */
  async setEarth(opts) {
    const gen = this._mapGen = (this._mapGen || 0) + 1;
    const earth = await window.EarthMap.build(opts);
    if (gen !== this._mapGen) { earth.destroy(); return false; }
    this._clearMap();
    this.mapSize = { w: opts.width, h: opts.height };
    this.earth = earth;
    this.mapLayer.addChild(earth.container);
    earth.hidePolitical = this.territoryViews.size > 0;   // territories may have arrived before the Earth did
    earth.redraw(this.scale);
    this._drawGrid();
    this.fit();
    return true;
  }

  async setMap(url, w, h) {
    this._mapGen = (this._mapGen || 0) + 1;
    this._clearMap();
    this.mapSize = { w: w || 2000, h: h || 1200 };
    let ok = false;
    if (url) {
      try {
        const tex = await PIXI.Assets.load({ src: url, loadParser: 'loadTextures' });
        const sp = new PIXI.Sprite(tex);
        sp.width = this.mapSize.w; sp.height = this.mapSize.h;
        this.mapLayer.addChild(sp);
        ok = true;
      } catch (e) {
        console.warn('Map image failed to load', e);
      }
    }
    if (!ok) {
      const g = new PIXI.Graphics().rect(0, 0, this.mapSize.w, this.mapSize.h)
        .fill(0x2b3a2f).stroke({ width: 6, color: 0x15201a });
      this.mapLayer.addChild(g);
    }
    this._drawGrid();
    this.fit();
    return ok;
  }

  // ---- Camera --------------------------------------------------------------------
  get scale() { return this.world.scale.x; }

  setScale(s, sx, sy) {
    s = Math.max(this.minScale, Math.min(this.maxScale, s));
    if (sx === undefined) { sx = this.app.screen.width / 2; sy = this.app.screen.height / 2; }
    const before = this.world.toLocal(new PIXI.Point(sx, sy));
    this.world.scale.set(s);
    const after = this.world.toLocal(new PIXI.Point(sx, sy));
    this.world.x += (after.x - before.x) * s;
    this.world.y += (after.y - before.y) * s;
    this._onZoom();
  }

  zoomBy(f) { this.setScale(this.scale * f); }

  fit() {
    const { w, h } = this.mapSize;
    const sw = this.app.screen.width, sh = this.app.screen.height;
    this._fitWasDegenerate = sw < 100 || sh < 100;
    // A hidden or collapsed pane reports a 0×0 screen; never let the scale hit zero (1/scale stroke widths would explode).
    const s = Math.max(0.01, Math.min(sw / w, sh / h) * 0.95);
    this.minScale = Math.min(s * 0.35, 0.05);
    this.world.scale.set(s);
    this.world.x = (sw - w * s) / 2;
    this.world.y = (sh - h * s) / 2;
    this._onZoom();
  }

  centerOn(x, y, scale) {
    if (scale) this.world.scale.set(Math.max(this.minScale, Math.min(this.maxScale, scale)));
    const s = this.scale;
    this.world.x = this.app.screen.width / 2 - x * s;
    this.world.y = this.app.screen.height / 2 - y * s;
    this._onZoom();
  }

  screenToWorld(sx, sy) { return this.world.toLocal(new PIXI.Point(sx, sy)); }
  worldToScreen(x, y) { return this.world.toGlobal(new PIXI.Point(x, y)); }
  getCenterWorld() { return this.screenToWorld(this.app.screen.width / 2, this.app.screen.height / 2); }

  markerScreenPos(id) {
    const v = this.views.get(id);
    return v ? this.worldToScreen(v.x, v.y) : null;
  }

  setTokenScale(s) { this.tokenScale = Math.max(0.5, Math.min(3, Number(s) || 1)); this.invalidate(); }
  setGameRules(rules) {
    this.gameRules = rules && rules.enabled ? { turn: Number(rules.turn) || 0, ...rules } : null;
    for (const v of this.views.values()) v._refreshMovedDot();
    this.invalidate();
  }
  setTokenMode(m) { this.tokenMode = m === 'screen' ? 'screen' : 'map'; this.invalidate(); }
  /** Unit icons are hidden on the Earth map at 100 % zoom and below: too small to read, and costly in numbers. */
  unitsHidden() { return !!this.earth && this.scale <= UNIT_ICON_MIN_SCALE; }
  /** One small dot per unit in its faction colour while the icons are hidden; redrawn when units or the zoom change. */
  _drawUnitDots(hide) {
    const g = this.unitDots;
    if (!hide) { if (g.visible) { g.visible = false; g.clear(); this._dotsScale = 0; } return; }
    if (g.visible && !this._dotsDirty && this._dotsScale === this.scale) return;
    this._dotsDirty = false; this._dotsScale = this.scale;
    g.clear();
    const r = 2.2 / this.scale;   // no outline: on a dense front outlines merge into one dark band
    const byColor = new Map();
    for (const v of this.views.values()) {
      if (v.dying || v.marker.type !== 'unit') continue;
      if (!byColor.has(v.colorNum)) byColor.set(v.colorNum, []);
      byColor.get(v.colorNum).push(v);
    }
    for (const [color, list] of byColor) {
      for (const v of list) g.circle(v.tx, v.ty, r);
      g.fill({ color, alpha: 0.95 });
    }
    g.visible = true;
  }
  /** Placing mode: tokens, scenery and drawings stop taking clicks so every click reaches the map. */
  setPassThrough(on) {
    on = !!on;
    if (this._passThrough === on) return;
    this._passThrough = on;
    for (const layer of [this.markerLayer, this.sceneryLayer, this.shapesLayer, this.handleLayer]) layer.interactiveChildren = !on;
    if (on) for (const v of this.views.values()) v.hover = false;
    this.invalidate();
  }

  /**
   * Hide token labels that would overlap one already placed. Selected, hovered and dragged tokens always keep
   * their label; labels that were showing last frame win ties so names do not flicker while panning; units
   * come before towns and other markers. Screen-space boxes go into a coarse grid so the pass stays cheap.
   */
  _declutterLabels() {
    const s = this.scale, wx = this.world.x, wy = this.world.y;
    const sw = this.app.screen.width, sh = this.app.screen.height;
    const cand = [], obstacles = [];
    for (const v of this.views.values()) {
      if (v.dying || v.marker.type === 'scenery' || !v.root.visible) continue;
      // Every token's body is an obstacle: a name half hidden under the next counter is as unreadable as two
      // names on top of each other. Bodies are shrunk a little so a grazing corner does not cost a label.
      const k = v.root.scale.x * s, cx = wx + v.x * s, cy = wy + v.y * s;
      const hw = (v.w || 0) * k * 0.42, hh = (v.h || 0) * k * 0.42;
      if (hw > 0 && cx + hw > 0 && cx - hw < sw && cy + hh > 0 && cy - hh < sh) obstacles.push({ owner: v.id, x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh });
    }
    for (const v of this.views.values()) {
      const l = v.label;
      if (v.dying || v.marker.type === 'scenery' || !v.root.visible || !l.visible || !l.text) { v._labelShown = false; continue; }
      const k = v.root.scale.x * s;                       // screen px per token px
      const cx = wx + v.x * s, top = wy + v.y * s + l.y * k;
      const w = l.width * k, h = l.height * k;
      if (cx + w / 2 < 0 || cx - w / 2 > sw || top > sh || top + h < 0) continue;   // off screen: nothing to collide with
      const forced = this.selected.has(v.id) || v.hover || v.dragging;
      cand.push({ v, x0: cx - w / 2 - 2, y0: top - 1, x1: cx + w / 2 + 2, y1: top + h + 1,
        rank: forced ? 0 : (v._labelShown ? 1 : 2), unit: v.marker.type === 'unit' ? 0 : 1, forced });
    }
    cand.sort((a, b) => a.rank - b.rank || a.unit - b.unit || a.v.id - b.v.id);
    const CELL = 96, grid = new Map();
    const cells = b => {
      const out = [];
      for (let gx = Math.floor(b.x0 / CELL); gx <= Math.floor(b.x1 / CELL); gx++)
        for (let gy = Math.floor(b.y0 / CELL); gy <= Math.floor(b.y1 / CELL); gy++) out.push(gx + ',' + gy);
      return out;
    };
    for (const o of obstacles) for (const key of cells(o)) { if (!grid.has(key)) grid.set(key, []); grid.get(key).push(o); }
    for (const c of cand) {
      const keys = cells(c);
      let hit = false;
      if (!c.forced) {
        outer: for (const key of keys) for (const o of grid.get(key) || []) {
          if (o.owner === c.v.id) continue;                 // a token's own body never hides its label
          if (c.x0 < o.x1 && c.x1 > o.x0 && c.y0 < o.y1 && c.y1 > o.y0) { hit = true; break outer; }
        }
      }
      if (hit) { c.v.label.visible = false; c.v._labelShown = false; continue; }
      c.v._labelShown = true;
      for (const key of keys) { if (!grid.has(key)) grid.set(key, []); grid.get(key).push(c); }
    }
  }

  shapeScreenPos(id) {
    const v = this.shapeViews.get(id);
    if (!v) return null;
    const c = shapeAnchor(v.shape);
    return this.worldToScreen(c[0], c[1]);
  }

  _onZoom() {
    this.invalidate();
    this._drawGrid();
    this._redrawMode();
    this._redrawShapes();
    this._positionHandles();
    if (this.territoryViews.size) {
      clearTimeout(this._territoryTimer);
      this._territoryTimer = setTimeout(() => this._redrawTerritories(), 120);
    }
    if (this.provinceLayer) this.provinceLayer.setZoom(this.scale);
    if (this._aura) this._drawAura();
    if (this._supplyPts) this._drawSupplyLine();
    if (this.persistTrails) this.queueTrails();
    this._syncCraterZoom();
    if (this._range) { const r = this._range; this.showRange(r.x, r.y, r.radius, r.exhausted, r.ry); }
    if (this.earth) {
      clearTimeout(this._earthTimer);
      this._earthTimer = setTimeout(() => { if (this.earth) { this.earth.redraw(this.scale); this.invalidate(); } }, 120);
    }
    this.dispatchEvent(new CustomEvent('zoom', { detail: { scale: this.scale } }));
  }

  // ---- Grid -----------------------------------------------------------------------
  setGrid(on) { this.grid.visible = on; this._drawGrid(); }

  _drawGrid() {
    this.invalidate();
    const g = this.gridLayer;
    g.clear();
    if (!this.grid.visible) return;
    const { w, h } = this.mapSize;
    const step = this.grid.size;
    for (let x = 0; x <= w; x += step) g.moveTo(x, 0).lineTo(x, h);
    for (let y = 0; y <= h; y += step) g.moveTo(0, y).lineTo(w, y);
    g.stroke({ width: 1 / this.scale, color: 0xffffff, alpha: 0.22 });
  }

  // ---- Markers ---------------------------------------------------------------------
  _layerFor(marker) { return marker.type === 'scenery' ? this.sceneryLayer : this.markerLayer; }

  upsert(marker) {
    this.invalidate();
    if (marker.type === 'unit') this._dotsDirty = true;
    this._townUpsert(marker);
    let v = this.views.get(marker.id);
    if (v && v.dying) { v.root.parent?.removeChild(v.root); v.root.destroy({ children: true }); v = null; }
    if (!v) {
      v = new MarkerView(this, marker);
      this.views.set(marker.id, v);
      this._layerFor(marker).addChild(v.root);
    } else {
      // A unit that just lost strength: its riflemen fall on screen rather than appearing already dead.
      const was = Number(v.marker?.data?.strength ?? 100), now = Number(marker.data?.strength ?? 100);
      if (marker.type === 'unit' && now < was) v.strengthDrop = { from: was, at: performance.now() };
      v.update(marker);
      const layer = this._layerFor(marker);
      if (v.root.parent !== layer) { v.root.parent?.removeChild(v.root); layer.addChild(v.root); }
    }
    return v;
  }

  remove(id) {
    this.invalidate();
    this._dotsDirty = true;
    for (const [bid, e] of this.battles) if (e.battle.attackerId === id || e.battle.defenderId === id) this.battles.delete(bid);   // its fights end with it
    if (this.persistTrails) this.queueTrails();
    this._syncCraterZoom();
    this._townRemove(id);
    const v = this.views.get(id);
    if (v) {
      v.dying = true;
      if (this.selected.has(id)) { const s = new Set(this.selected); s.delete(id); this.selectMany([...s], this.selectedId === id ? null : this.selectedId); }
    }
  }

  clearMarkers() {
    this.invalidate();
    for (const v of this.views.values()) { v.root.parent?.removeChild(v.root); v.root.destroy({ children: true }); }
    this.views.clear();
    for (const id of [...this.towns.keys()]) this._townRemove(id);
  }

  // ---- Towns ------------------------------------------------------------------------------------------------
  // Every town marker is drawn as a town from above (towns.js), grown from its name: built the first time it comes
  // into view (a few a frame), and redrawn when shells fall on it, its houses burnt out or reduced to rubble.
  _townUpsert(m) {
    if (m.type !== 'town' || !window.TownArt) { if (this.towns.has(m.id)) this._townRemove(m.id); return; }
    const key = `${m.data?.size || 'village'}|${m.name}|${m.x}|${m.y}`, t = this.towns.get(m.id);
    if (t && t.key === key) return;
    if (t) this._townRemove(m.id);
    this.towns.set(m.id, { key, m: { id: m.id, name: m.name, x: m.x, y: m.y, data: { size: m.data?.size } }, plan: null, g: null, fires: [], dirty: false });
  }
  _townRemove(id) {
    const t = this.towns.get(id);
    if (!t) return;
    t.g?.destroy();
    this.towns.delete(id);
  }
  /** Towns hit by a crater redraw with their damage. */
  _townsHit(craters) {
    for (const t of this.towns.values()) if (t.plan && craters.some(c => Math.hypot(c.x - t.plan.x, c.y - t.plan.y) < t.plan.R * 1.4 + 3)) t.dirty = true;
  }
  /** Draw a town with what the shells have done to it; houses hit this turn are burning. */
  _drawTown(t, detail) {
    const p = t.plan, near = [...this.craters.values()].filter(c => Math.hypot(c.x - p.x, c.y - p.y) < p.R * 1.4 + 3)
      .map(c => ({ x: c.x - p.x, y: c.y - p.y, S: c.craterSize, fresh: c.fresh }));
    const hash = b => { const v = Math.sin(b.x * 127.1 + b.y * 311.7) * 43758.5453; return v - Math.floor(v); };
    const damageOf = b => {
      let d = 0;
      for (const c of near) {
        const r = Math.hypot(b.x - c.x, b.y - c.y);
        if (r < c.S * 0.5) return 2;
        if (r < c.S * 1.3 && hash(b) < 0.8) d = 1;
      }
      return d;
    };
    t.g?.destroy();
    t.g = window.TownArt.draw(p, damageOf, detail);
    t.detail = detail;
    t.g.position.set(p.x, p.y);
    this.townLayer.addChild(t.g);
    // Fires: up to six burnt-out houses round each of this turn's craters.
    t.fires = [];
    for (const c of near.filter(c => c.fresh)) {
      let n = 0;
      for (const b of p.buildings) {
        if (n >= 6 || Math.hypot(b.x - c.x, b.y - c.y) > c.S * 1.4 || damageOf(b) !== 1) continue;
        t.fires.push({ x: p.x + b.x, y: p.y + b.y, s: Math.max(b.w, b.h), seed: hash(b) }); n++;
      }
    }
    t.dirty = false;
  }
  /** Each frame: towns shown from 150 % zoom, those in view built (a little at a time) or redrawn as needed. */
  _tickTowns(vx0, vy0, vx1, vy1) {
    const on = this.scale >= 1.5 && this.towns.size > 0;
    this.townLayer.visible = on;
    if (!on) return false;
    // Full detail (shadows, pitched roofs, furrows, hedges) from 500 %; a lighter drawing further out. Building
    // stops after about 10 ms a frame (a capital takes several), and carries on in the next.
    const t0 = performance.now();
    let built = 0, pending = false;
    const detail = this.scale >= 5;
    const isLand = (x, y) => !(this.provinceLayer && this.provinceLayer.size) || !!this.provinceAt(x, y);
    for (const t of this.towns.values()) {
      const m = t.m, reach = t.plan ? t.plan.reach : 22;
      const inView = m.x + reach > vx0 && m.x - reach < vx1 && m.y + reach > vy0 && m.y - reach < vy1;
      if (!inView) { if (t.g) t.g.visible = false; continue; }
      if (!t.plan || t.dirty || t.detail !== detail) {
        if (built && performance.now() - t0 > 10) { pending = true; continue; }
        built++;
        if (!t.plan) t.plan = window.TownArt.plan(m, isLand);
        this._drawTown(t, detail);
      }
      t.g.visible = true;
    }
    if (pending) this.invalidate();
    return pending;
  }

  /** Remote live-drag preview: tween towards the position without persisting. */
  ghostMove(id, x, y) {
    this.invalidate();
    const v = this.views.get(id);
    if (v && !v.dragging) { v.tx = x; v.ty = y; }
  }

  select(id) {
    this.invalidate();
    if (this.selectedId === id && this.selectedShapeId === null && this.selected.size <= 1) return;
    this.selectedId = id;
    this.selected = id != null ? new Set([id]) : new Set();
    if (this.selectedShapeId !== null) { this.selectedShapeId = null; this._redrawShapes(); }
    this._drawHandles();
    this._emitSelect();
  }

  /** Select several markers at once; `primary` (or the first) gets the popup. */
  selectMany(ids, primary) {
    this.invalidate();
    this.selected = new Set(ids);
    this.selectedId = this.selected.size ? (primary != null && this.selected.has(primary) ? primary : ids[0]) : null;
    if (this.selectedShapeId !== null) { this.selectedShapeId = null; this._redrawShapes(); }
    this._drawHandles();
    this._emitSelect();
  }

  toggleSelect(id) {
    this.invalidate();
    const s = new Set(this.selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    this.selectMany([...s], s.has(id) ? id : this.selectedId);
  }

  selectShape(id) {
    this.invalidate();
    if (this.selectedShapeId === id && this.selectedId === null) return;
    this.selectedId = null;
    this.selected = new Set();
    this.selectedShapeId = id;
    this._redrawShapes();
    this._drawHandles();
    this._emitSelect();
  }

  _emitSelect() {
    this.dispatchEvent(new CustomEvent('select', { detail: { id: this.selectedId, ids: [...this.selected], shapeId: this.selectedShapeId } }));
  }

  /** Movement trail: fading arrow from (x1,y1) to (x2,y2). */
  trail(x1, y1, x2, y2, color) {
    if (this.persistTrails) return;
    this.invalidate();
    if (Math.hypot(x2 - x1, y2 - y1) < 2) return;
    const w = 3 / this.scale;
    const g = new PIXI.Graphics();
    g.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: w, color, alpha: 0.85 });
    const a = Math.atan2(y2 - y1, x2 - x1), L = 12 / this.scale;
    g.poly([
      x2, y2,
      x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45),
      x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45),
    ]).fill({ color, alpha: 0.85 });
    g.circle(x1, y1, w * 1.2).fill({ color, alpha: 0.85 });
    g.life = 1800;
    this.fxLayer.addChild(g);
  }

  /** Brief expanding ring, e.g. when a marker is placed remotely. */
  pulse(x, y, color) {
    this.invalidate();
    const g = new PIXI.Graphics();
    g.circle(0, 0, 10).stroke({ width: 3, color, alpha: 0.9 });
    g.position.set(x, y);
    g.life = 700; g.pulse = true;
    this.fxLayer.addChild(g);
  }

  /**
   * Combat hit: explosion sprite plus a shake on the marker. `strong` for the loser,
   * `destroyed` when the unit's strength hit zero (bigger, and a second blast).
   */
  hit(id, strong = true, destroyed = false) {
    this.invalidate();
    const v = this.views.get(id);
    if (!v) return;
    v.shakeUntil = performance.now() + (destroyed ? 900 : strong ? 650 : 350);
    v.shakeAmp = destroyed ? 6 : strong ? 4 : 2;
    if (this.explosionFrames) {
      const size = destroyed ? 120 : strong ? 84 : 56;
      this.explode(v.x + (Math.random() - 0.5) * 6 / this.scale, v.y + (Math.random() - 0.5) * 6 / this.scale, size);
      if (destroyed) {
        this.explode(v.x + 14 / this.scale, v.y - 10 / this.scale, 90, 180);
        this.explode(v.x - 12 / this.scale, v.y + 8 / this.scale, 70, 330);
      } else if (strong) {
        this.explode(v.x - 10 / this.scale, v.y + 6 / this.scale, 48, 160);
      }
      return;
    }
    const g = new PIXI.Graphics();
    g.circle(0, 0, 12).stroke({ width: strong ? 5 : 3, color: 0xff3b30, alpha: 0.95 });
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      g.moveTo(Math.cos(a) * 14, Math.sin(a) * 14).lineTo(Math.cos(a) * (strong ? 26 : 20), Math.sin(a) * (strong ? 26 : 20))
        .stroke({ width: 2, color: 0xffb199, alpha: 0.9 });
    }
    g.position.set(v.x, v.y);
    g.life = 700; g.pulse = true;
    this.fxLayer.addChild(g);
  }

  /**
   * A number that pops up over a unit, rises and fades: losses in red, healing in green, a word ("No loss").
   * Sized in screen pixels so it reads at any zoom; several on one unit stack instead of overlapping.
   * `sub` is a smaller line under it (strength left, "Destroyed"); `delay` lets an explosion land first.
   */
  floatText(id, text, { color = 0xff4d3d, size = 24, sub = '', subColor = 0xffffff, delay = 0 } = {}) {
    const v = this.views.get(id);
    if (!v) return;
    const c = new PIXI.Container(); c.eventMode = 'none'; c.visible = false;
    const main = new PIXI.Text({ text, resolution: 2, style: {
      fontFamily: 'Georgia, "Times New Roman", serif', fontSize: size, fontWeight: '900', fill: color,
      stroke: { color: 0x000000, width: Math.max(4, size / 5), join: 'round' },
      dropShadow: { color: 0x000000, alpha: 0.6, blur: 3, distance: 2, angle: Math.PI / 2 } } });
    main.anchor.set(0.5, 1);
    c.addChild(main);
    if (sub) {
      const t = new PIXI.Text({ text: sub, resolution: 2, style: {
        fontFamily: 'system-ui, sans-serif', fontSize: 13, fontWeight: '800', fill: subColor, letterSpacing: 0.5,
        stroke: { color: 0x000000, width: 3, join: 'round' } } });
      t.anchor.set(0.5, 0); t.position.set(0, 1);
      c.addChild(t);
    }
    const stack = this.boomLayer.children.filter(f => f.floater && f.floater.id === id && f.life > 900).length;
    c.floater = { id, x: v.x, y: v.y, off: stack * (sub ? 40 : 26), jitter: (Math.random() - 0.5) * 16, delay, span: 2000 };
    c.life = 2000 + delay;
    this.boomLayer.addChild(c);
    this.invalidate();
  }
  /** One frame of a floating number: a quick pop, then an eased rise with a fade over the last third. */
  _tickFloater(fx, inv) {
    const f = fx.floater, t = f.span - fx.life;   // ms since it appeared (negative while delayed)
    if (t < 0) { fx.visible = false; return; }
    fx.visible = true;
    const p = Math.min(1, t / f.span);
    const pop = t < 140 ? 0.5 + 0.8 * (t / 140) : t < 280 ? 1.3 - 0.3 * ((t - 140) / 140) : 1;
    const v = this.views.get(f.id);
    if (v && !v.dying) { f.x = v.x; f.y = v.y; }
    const rise = 1 - Math.pow(1 - p, 3);
    fx.scale.set(pop * inv);
    fx.position.set(f.x + f.jitter * inv, f.y - (30 + f.off + 46 * rise) * inv);
    fx.alpha = p > 0.62 ? Math.max(0, 1 - (p - 0.62) / 0.38) : 1;
  }

  // ---- Shapes ----------------------------------------------------------------------
  upsertShape(shape) {
    this.invalidate();
    let v = this.shapeViews.get(shape.id);
    if (!v) {
      const g = new PIXI.Graphics();
      g.eventMode = 'static'; g.cursor = 'pointer';
      g.on('pointerdown', e => this._shapePointer(shape.id, e));
      const label = new PIXI.Text({ text: '', style: { ...LABEL_STYLE, fontSize: 12, fontStyle: 'italic' }, resolution: 2 });
      label.anchor.set(0.5, 0.5);
      label.eventMode = 'none';
      v = { shape, g, label };
      this.shapesLayer.addChild(g, label);
      this.shapeViews.set(shape.id, v);
    }
    if (shape.kind === 'trench' && !v.trench && window.Trench) v.trench = new Trench.View(this.trenchLayer);
    if (shape.kind === 'rail' && !v.rail && window.Rail) {
      v.rail = new Rail.View(this.railLayer, this);
      // The track tile and cars come from the train sheet; draw again once it has loaded.
      Rail.load().then(() => { if (this.shapeViews.get(shape.id) === v && v.rail) { v.rail.key = null; this._drawShapeView(v); } });
    }
    v.shape = shape;
    this._drawShapeView(v);
    if (shape.kind === 'trench') this._refreshTrenchNodes();
    if (this.selectedShapeId === shape.id && !this._vdrag) this._drawHandles();
  }

  /** Where a trench's end meets another trench, drop a sandbag node so the ribbons read as joined. */
  _refreshTrenchNodes() {
    const trenches = [...this.shapeViews.values()].filter(v => v.trench && v.shape.points.length >= 2);
    for (const v of trenches) v.trench.clearNodes();
    for (const v of trenches) {
      const hw = v.trench.halfWidth(this.scale);
      for (const end of [v.shape.points[0], v.shape.points[v.shape.points.length - 1]]) {
        const near = trenches.some(o => o !== v && Trench.distToPath(end[0], end[1], o.shape.points) <= hw * 2.2);
        if (near) v.trench.addNode(end[0], end[1]);
      }
    }
  }

  removeShape(id) {
    this.invalidate();
    const v = this.shapeViews.get(id);
    if (v && v.trench) { v.trench.destroy(); v.trench = null; setTimeout(() => this._refreshTrenchNodes(), 0); }
    if (v && v.rail) { v.rail.destroy(); v.rail = null; }
    if (!v) return;
    this.shapesLayer.removeChild(v.g, v.label);
    v.g.destroy(); v.label.destroy();
    this.shapeViews.delete(id);
    if (this.selectedShapeId === id) this.selectShape(null);
  }

  _redrawShapes() { for (const v of this.shapeViews.values()) this._drawShapeView(v); }

  _drawShapeView(v) {
    this.invalidate();
    const s = v.shape, g = v.g, sc = this.scale;
    const color = parseInt(String(s.color || '#f1c40f').slice(1), 16) || 0xf1c40f;
    const selected = this.selectedShapeId === s.id;
    const w = (s.width || 3) / sc;
    g.eventMode = s.locked ? 'none' : 'static';   // locked drawings let clicks and drags pass through
    g.clear();
    const pts = s.points || [];
    if (pts.length < 2) return;
    const path = () => { g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); };
    if (s.kind === 'trench' && v.trench) {
      // The earthwork is a mesh in the trench layer; the graphics only carry the hit path and the selection ring.
      // Width is stored in campaign units (km on the Earth map); convert at the trench's own latitude.
      const a0 = shapeAnchor(s);
      v.trench.update(s, sc, this.unitsToPx(a0[0], a0[1], Number(s.width) || 1));
      const tw = v.trench.halfWidth(sc) * 2;
      if (selected) { path(); g.stroke({ width: tw + 6 / sc, color: 0xffffff, alpha: 0.45 }); }
      if (s.adminOnly || (s.visibleTo && s.visibleTo.length)) { path(); g.stroke({ width: 1.5 / sc, color: s.adminOnly ? 0xe67e22 : 0x5dade2, alpha: 0.9 }); }
      path(); g.stroke({ width: Math.max(tw, 14 / sc), color: 0xffffff, alpha: 0.001 });
      v.label.text = s.label || '';
      v.label.visible = !!s.label;
      const a = shapeAnchor(s);
      v.label.position.set(a[0], a[1]);
      v.label.scale.set(1 / sc);
      return;
    }
    if (s.kind === 'rail' && v.rail) {
      // Track, trains and smoke live in the rail layer; the graphics carry the hit path and the selection ring.
      v.rail.update(s, sc, (x, y) => this.unitsToPx(x, y, this.railCutKm));
      const tw = v.rail.halfWidth(sc) * 2;
      if (selected) { path(); g.stroke({ width: tw + 6 / sc, color: 0xffffff, alpha: 0.5 }); }
      if (s.adminOnly || (s.visibleTo && s.visibleTo.length)) { path(); g.stroke({ width: 1.5 / sc, color: s.adminOnly ? 0xe67e22 : 0x5dade2, alpha: 0.9 }); }
      path(); g.stroke({ width: Math.max(tw, 14 / sc), color: 0xffffff, alpha: 0.001 });
      v.label.text = s.label || '';
      v.label.visible = !!s.label;
      // The name sits beside the middle of the line, not at the centre of its box.
      const cum = Rail.cumulative(pts), mid = Rail.at(pts, cum, cum[cum.length - 1] / 2);
      v.label.position.set(mid.x, mid.y - tw / 2 - 9 / sc);
      v.label.scale.set(1 / sc);
      return;
    }
    if (s.kind === 'area') {
      g.poly(pts.flat()).fill({ color, alpha: selected ? 0.32 : 0.18 });
      if (selected) g.poly(pts.flat()).stroke({ width: w + 6 / sc, color: 0xffffff, alpha: 0.5 });
      g.poly(pts.flat()).stroke({ width: w, color, alpha: 0.95 });
    } else {
      if (selected) { path(); g.stroke({ width: w + 6 / sc, color: 0xffffff, alpha: 0.5 }); }
      path(); g.stroke({ width: w, color, alpha: 0.95 });
      // Wider invisible hit path so thin lines are clickable.
      path(); g.stroke({ width: Math.max(w, 14 / sc), color, alpha: 0.001 });
    }
    if (s.adminOnly || (s.visibleTo && s.visibleTo.length)) {
      path(); g.stroke({ width: Math.max(1, w * 0.4), color: s.adminOnly ? 0xe67e22 : 0x5dade2, alpha: 0.9 });
    }
    v.label.text = s.label || '';
    v.label.visible = !!s.label;
    const a = shapeAnchor(s);
    v.label.position.set(a[0], a[1]);
    v.label.scale.set(1 / sc);
  }

  _shapePointer(id, e) {
    if (e.button === 2 && !this.mode) {
      e.stopPropagation();
      const p = this.screenToWorld(e.global.x, e.global.y);
      this.dispatchEvent(new CustomEvent('mapcontext', { detail: { x: p.x, y: p.y } }));
      return;
    }
    if (e.button !== 0) return;
    if (this.mode) { this._modeClick(e); e.stopPropagation(); return; }
    e.stopPropagation();
    const v = this.shapeViews.get(id);
    if (this.selectedShapeId !== id || !v || !this.canEditShape(v.shape)) { this.selectShape(id); return; }
    const p = this.screenToWorld(e.global.x, e.global.y);
    if (e.shiftKey || this._moveArmed === id) {
      // Shift-drag (or the popup's Move button) moves the whole shape.
      this._moveArmed = null;
      this._vdrag = { view: v, whole: true, start: { x: p.x, y: p.y }, orig: v.shape.points.map(q => [q[0], q[1]]), moved: false };
      return;
    }
    // Grabbing the outline pulls a new vertex out of the nearest segment.
    const hit = nearestSegment(v.shape, p.x, p.y);
    if (hit && hit.dist <= 12 / this.scale) {
      const pts = v.shape.points.slice();
      pts.splice(hit.index + 1, 0, [hit.x, hit.y]);
      v.shape = { ...v.shape, points: pts };
      this._drawShapeView(v); this._drawHandles();
      this._vdrag = { view: v, whole: false, index: hit.index + 1, ox: 0, oy: 0, moved: false, inserted: true };
    }
  }

  // ---- Vertex handles for the selected, editable shape --------------------------------
  _drawHandles() {
    this.invalidate();
    for (const h of this._handles.items) h.destroy();
    this._handles.items = [];
    this._handles.shapeId = null;
    const v = this.selectedShapeId != null ? this.shapeViews.get(this.selectedShapeId) : null;
    if (!v || this.mode || v.shape.locked || !this.canEditShape(v.shape)) return;
    this._handles.shapeId = v.shape.id;
    const color = parseInt(String(v.shape.color || '#f1c40f').slice(1), 16) || 0xf1c40f;
    v.shape.points.forEach((p, i) => {
      const g = new PIXI.Graphics().circle(0, 0, 6).fill(0xffffff).stroke({ width: 2.5, color });
      g.eventMode = 'static'; g.cursor = 'move';
      g.on('pointerdown', e => this._handlePointer(v, i, e));
      g.on('rightdown', e => { e.stopPropagation(); this._removeVertex(v, i); });
      this.handleLayer.addChild(g);
      this._handles.items.push(g);
    });
    this._positionHandles();
  }

  _positionHandles() {
    this.invalidate();
    const v = this._handles.shapeId != null ? this.shapeViews.get(this._handles.shapeId) : null;
    if (!v) return;
    const inv = 1 / this.scale;
    this._handles.items.forEach((g, i) => {
      const p = v.shape.points[i];
      if (p) { g.position.set(p[0], p[1]); g.scale.set(inv); g.visible = true; } else g.visible = false;
    });
  }

  _handlePointer(v, index, e) {
    if (e.button !== 0 || this.mode) return;
    e.stopPropagation();
    if (e.altKey || e.ctrlKey) { this._removeVertex(v, index); return; }
    const p = this.screenToWorld(e.global.x, e.global.y);
    this._vdrag = { view: v, whole: false, index, ox: p.x - v.shape.points[index][0], oy: p.y - v.shape.points[index][1], moved: false };
  }

  /** Remove a vertex (right-click or Alt-click on its handle), keeping the minimum a shape needs. */
  _removeVertex(v, index) {
    if (this.mode) return;
    const min = v.shape.kind === 'area' ? 3 : 2;
    if (v.shape.points.length <= min) return;
    this._commitShapePoints(v, v.shape.points.filter((_, i) => i !== index));
  }

  /** Arm a one-shot whole-shape move: the next drag on that shape moves every vertex. */
  armMove(id) { this._moveArmed = id; }

  _commitShapePoints(v, pts) {
    v.shape = { ...v.shape, points: pts };
    this._drawShapeView(v);
    this._drawHandles();
    this.dispatchEvent(new CustomEvent('shapeedit', {
      detail: { id: v.shape.id, points: pts.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]) },
    }));
  }

  // ---- Measure / draw / select modes ---------------------------------------------------
  setMeasure(on) { this._setMode(on ? 'measure' : null); }

  /** Select mode: drag a box on empty map to select tokens; tokens themselves still drag normally. */
  setSelectMode(on) { this._setMode(on ? 'select' : null); }

  _marqueeStart(e) {
    this.invalidate();
    const p = this.screenToWorld(e.global.x, e.global.y);
    this._marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: e.shiftKey };
    if (!this._marqueeG) { this._marqueeG = new PIXI.Graphics(); this.overlayLayer.addChild(this._marqueeG); }
  }

  _marqueeMove(e) {
    this.invalidate();
    const p = this.screenToWorld(e.global.x, e.global.y);
    const m = this._marquee;
    m.x1 = p.x; m.y1 = p.y;
    const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1), w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
    this._marqueeG.clear().rect(x, y, w, h).fill({ color: 0x5dade2, alpha: 0.12 }).stroke({ width: 1.5 / this.scale, color: 0x5dade2, alpha: 0.9 });
  }

  _marqueeEnd() {
    this.invalidate();
    const m = this._marquee; this._marquee = null;
    if (this._marqueeG) this._marqueeG.clear();
    if (!m) return false;
    const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1), y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
    if (x1 - x0 < 3 / this.scale && y1 - y0 < 3 / this.scale) return false;   // a click, not a box
    const hit = [];
    for (const v of this.views.values()) {
      if (v.dying || v.marker.locked || !this.canDrag(v.marker)) continue;
      if (v.x >= x0 && v.x <= x1 && v.y >= y0 && v.y <= y1) hit.push(v.id);
    }
    const ids = m.additive ? [...new Set([...this.selected, ...hit])] : hit;
    this.selectMany(ids, hit[0]);
    return true;
  }

  /** Start drawing. Pass existing points and a shape id to continue an existing line. */
  startDraw(kind, points = [], shapeId = null) {
    this.draw.kind = kind;
    this._setMode('draw');
    this.draw.points = points.map(p => ({ x: p[0], y: p[1] }));
    this.draw.shapeId = shapeId;
    this._redrawMode();
    this._emitMode();
  }

  _setMode(mode) {
    this.invalidate();
    this.mode = mode;
    this.measure.points = []; this.measure.hover = null;
    this.draw.points = []; this.draw.hover = null; this.draw.lastClick = null; this.draw.shapeId = null;
    this._marquee = null; if (this._marqueeG) this._marqueeG.clear();
    this._redrawMode();
    this._drawHandles();
    this.app.canvas.style.cursor = mode ? 'crosshair' : '';
    this._emitMode();
    this.dispatchEvent(new CustomEvent('mode', { detail: { mode } }));
  }

  modeUndo() { (this.mode === 'draw' ? this.draw : this.measure).points.pop(); this._redrawMode(); this._emitMode(); }
  modeClear() { (this.mode === 'draw' ? this.draw : this.measure).points = []; this._redrawMode(); this._emitMode(); }
  cancelMode() { this._setMode(null); }

  finishDraw() {
    if (this.mode !== 'draw') return false;
    const { kind, points, shapeId } = this.draw;
    if (points.length < (kind === 'area' ? 3 : 2)) return false;
    const out = points.map(p => [p.x, p.y]);
    this._setMode(null);
    this.dispatchEvent(new CustomEvent('drawend', { detail: { kind, points: out, shapeId } }));
    return true;
  }

  _modeClick(e) {
    this.invalidate();
    const p = this.screenToWorld(e.global.x, e.global.y);
    if (this.mode === 'measure') {
      this.measure.points.push({ x: p.x, y: p.y });
    } else if (this.mode === 'draw') {
      const last = this.draw.lastClick;
      const t = performance.now();
      if (last && t - last.t < 350 && Math.hypot(e.global.x - last.x, e.global.y - last.y) < 6) {
        this.draw.lastClick = null;
        if (this.finishDraw()) return;
      }
      this.draw.lastClick = { t, x: e.global.x, y: e.global.y };
      const q = this.draw.kind === 'rail' ? this.snapToRail(p.x, p.y) : p;
      this.draw.points.push({ x: q.x, y: q.y });
    }
    this._redrawMode();
    this._emitMode();
  }

  _modeHover(x, y) {
    this.invalidate();
    const m = this.mode === 'draw' ? this.draw : this.measure;
    if (!m.points.length) return;
    m.hover = { x, y };
    this._redrawMode();
    this._emitMode();
  }

  _emitMode() {
    if (this.mode === 'measure') {
      const pts = [...this.measure.points];
      if (this.measure.hover && pts.length) pts.push(this.measure.hover);
      let px = 0;
      for (let i = 1; i < pts.length; i++) px += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      this.dispatchEvent(new CustomEvent('measure', { detail: { px, points: this.measure.points.length, pts: pts.map(p => [p.x, p.y]) } }));
      this.dispatchEvent(new CustomEvent('drawprogress', { detail: null }));
    } else if (this.mode === 'draw') {
      this.dispatchEvent(new CustomEvent('drawprogress', { detail: { kind: this.draw.kind, points: this.draw.points.length } }));
      this.dispatchEvent(new CustomEvent('measure', { detail: null }));
    } else {
      this.dispatchEvent(new CustomEvent('measure', { detail: null }));
      this.dispatchEvent(new CustomEvent('drawprogress', { detail: null }));
    }
  }

  _redrawMode() {
    this.invalidate();
    let g = this.measure.g;
    if (!g) { g = this.measure.g = new PIXI.Graphics(); this.overlayLayer.addChild(g); }
    g.clear();
    if (!this.mode) return;
    const s = this.scale;
    const m = this.mode === 'draw' ? this.draw : this.measure;
    const color = this.mode === 'draw' ? (this.draw.kind === 'trench' ? 0xc9b37f : this.draw.kind === 'rail' ? 0xd0d3d4 : 0xf1c40f) : 0xabe67e;
    const pts = [...m.points];
    if (m.hover && pts.length) pts.push(m.hover);
    if (pts.length >= 2) {
      if (this.mode === 'draw' && this.draw.kind === 'area' && pts.length >= 3) {
        g.poly(pts.flatMap(p => [p.x, p.y])).fill({ color, alpha: 0.15 });
      }
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      g.stroke({ width: 3 / s, color, alpha: 0.95 });
    }
    for (const p of m.points) {
      g.circle(p.x, p.y, 5 / s).fill(color).stroke({ width: 1.5 / s, color: 0x1e2b1a });
    }
  }

  // ---- Territories (game mode) --------------------------------------------------------
  /** Faction colours and names for territory fills; call before setTerritories and whenever factions change. */
  setFactionInfo(list) {
    this.factionInfo = new Map(list.map(f => [f.id, { color: parseInt(String(f.color || '#888888').slice(1), 16) || 0x888888, name: f.name }]));
    this.skirmish?.setFactions(list);
    for (const v of this.territoryViews.values()) this._drawTerritory(v);
    if (this.provinceLayer) this.provinceLayer.setFactionInfo(list);
  }
  /** Replace (replace=true) or merge the territory set. Each item: { factionId, geometry }. */
  setTerritories(list, replace) {
    if (replace) { for (const v of this.territoryViews.values()) this._dropTerritory(v); this.territoryViews.clear(); }
    for (const t of list || []) {
      let v = this.territoryViews.get(t.factionId);
      if (!t.geometry || !t.geometry.length) { if (v) { this._dropTerritory(v); this.territoryViews.delete(t.factionId); } continue; }
      if (!v) {
        v = { factionId: t.factionId, g: new PIXI.Graphics(), labels: [] };
        v.g.eventMode = 'none';
        this.territoryLayer.addChild(v.g);
        this.territoryViews.set(t.factionId, v);
      }
      v.geometry = t.geometry;
      this._drawTerritory(v);
    }
    // The Earth's own political borders and tint would fight with territories: hide them while any exist.
    this._syncEarthPolitical();
    this.invalidate();
  }
  _syncEarthPolitical() {
    if (!this.earth) return;
    const hide = this.territoryViews.size > 0 || !!(this.provinceLayer && this.provinceLayer.hasOwners);
    if (this.earth.hidePolitical !== hide) { this.earth.hidePolitical = hide; this.earth.redraw(this.scale); }
    else if (this.earth.tintLayer) this.earth.tintLayer.visible = !hide;
  }

  // ---- Rail trips (data.ride from the server, docs/RAILWAYS.md) -------------------------------------------
  /**
   * Play a unit's rail trip: it walks to the track, boards the train waiting there, the train runs along the
   * line, and the unit gets off and walks on to where it was sent. Paced on screen, so a long trip still takes
   * only a few seconds. `ride` = { path: [[x, y]...], on, off }: path[on..off] is the track ridden.
   */
  playRide(id, ride) {
    const v = this.views.get(id);
    if (!v || !window.Rail || !Array.isArray(ride?.path)) return;
    const pts = ride.path, on = ride.on ?? 1, off = ride.off ?? pts.length - 2;
    const track = pts.slice(on, off + 1);
    if (track.length < 2) return;
    const final = { x: v.tx, y: v.ty };
    v.riding = 'walk'; v.x = v.tx = pts[0][0]; v.y = v.ty = pts[0][1];   // back to where it set out from
    Rail.load().then(() => {
      const f = Rail.frames();
      const old = this.rides.get(id);
      if (old) { old.c.destroy({ children: true }); this.rides.delete(id); }
      if (!f || this.views.get(id) !== v) { v.riding = false; v.x = v.tx = final.x; v.y = v.ty = final.y; return; }
      const c = new PIXI.Container(); c.eventMode = 'none';
      // In the unit's colours (half tinted) and named, so it stands out from the trains that run the line anyway.
      const col = parseInt(String(v.marker.color || '#888888').slice(1), 16) || 0x888888;
      const tint = (((col >> 16 & 255) + 255) >> 1 << 16) | (((col >> 8 & 255) + 255) >> 1 << 8) | (((col & 255) + 255) >> 1);
      const cars = [f.loco, f.tender, f.wagons[0], f.wagons[2]].map(t => { const s = new PIXI.Sprite(t); s.anchor.set(0.5); s.tint = tint; c.addChild(s); return s; });
      const label = new PIXI.Text({ text: `🚂 ${v.marker.name}`, resolution: 2, style: { fontFamily: 'system-ui, sans-serif', fontSize: 11, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x000000, width: 3 } } });
      label.anchor.set(0.5, 1); c.addChild(label);
      this.rideLayer.addChild(c);
      const cum = Rail.cumulative(track), L = cum[cum.length - 1];
      const rideMs = Math.max(1600, Math.min(6000, L * this.scale / 0.32));   // about 320 screen px a second
      const D = { walk: 650, board: 400, ride: rideMs, alight: 400, walkOff: 650 };
      this.rides.set(id, { v, pts, on, off, track, cum, L, c, cars, label, t0: performance.now(), D, final });
      this.invalidate();
    });
  }
  _tickRides(nowMs) {
    if (!this.rides.size) return false;
    const s = this.scale, k = 10 / 24 / s;                        // cars 10 screen px wide (the art is 24 px)
    const lerp = (a, b, t) => a + (b - a) * t, ease = t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    for (const [id, r] of this.rides) {
      const { v, pts, on, off, D } = r;
      let t = nowMs - r.t0;
      const start = pts[0], board = pts[on], alight = pts[off];
      // The train: whole consist on the track behind its head.
      const gap = 1 / s, lens = r.cars.map(c => c.texture.height * k);
      const consist = lens.reduce((a, b) => a + b + gap, 0);
      const head0 = Math.min(r.L, consist), tRide = Math.max(0, Math.min(1, (t - D.walk - D.board) / D.ride));
      const head = lerp(head0, r.L, ease(tRide));
      let back = head;
      r.cars.forEach((car, i) => {
        const p = Rail.at(r.track, r.cum, back - lens[i] / 2);
        car.position.set(p.x, p.y); car.rotation = p.a + Math.PI / 2; car.scale.set(k);
        back -= lens[i] + gap;
      });
      r.label.position.set(r.cars[0].x, r.cars[0].y - 16 / s); r.label.scale.set(1 / s);
      const fadeIn = Math.min(1, t / 300), end = D.walk + D.board + D.ride + D.alight + D.walkOff;
      r.c.alpha = Math.min(fadeIn, t > end - D.walkOff ? Math.max(0, (end - t) / D.walkOff) : 1);
      // The unit: walk to the train, ride inside it (hidden), step off and walk on.
      let x, y, phase;
      if (t < D.walk) { const u = ease(t / D.walk); x = lerp(start[0], board[0], u); y = lerp(start[1], board[1], u); phase = 'walk'; }
      else if (t < D.walk + D.board + D.ride) { x = board[0]; y = board[1]; phase = 'aboard'; }
      else if (t < D.walk + D.board + D.ride + D.alight) { x = alight[0]; y = alight[1]; phase = 'alight'; }
      else if (t < end) { const u = ease((t - (end - D.walkOff)) / D.walkOff); x = lerp(alight[0], r.final.x, u); y = lerp(alight[1], r.final.y, u); phase = 'walk'; }
      else {
        r.c.destroy({ children: true }); this.rides.delete(id);
        v.riding = false; v.x = v.tx = r.final.x; v.y = v.ty = r.final.y;
        continue;
      }
      v.riding = phase === 'aboard' ? 'aboard' : 'walk';
      v.x = v.tx = x; v.y = v.ty = y;
    }
    return true;
  }

  // ---- Fog of war (docs/FOG-OF-WAR.md) ------------------------------------------------------------
  /**
   * The viewer's sight from the server (server/vision.js): { on, provinces?: [ids], circles?: [[x, y, rx, ry]],
   * own?: [faction ids], ghosts: [...] }. The Earth map darkens the provinces out of sight; image maps get a dark
   * layer with the circles and the side's own territory cut out. Ghosts mark where enemy units were last seen.
   */
  setFog(v) {
    this.fog = v && v.on ? v : null;
    if (this.provinceLayer) this.provinceLayer.setFog(this.fog && this.fog.provinces ? this.fog.provinces : null);
    this._drawImageFog();
    this._drawGhosts();
    this.invalidate();
  }
  _drawImageFog() {
    for (const c of this.fogLayer.removeChildren()) c.destroy({ children: true });
    const f = this.fog;
    if (!f || !f.circles) return;
    const dark = new PIXI.Graphics().rect(0, 0, this.mapSize.w, this.mapSize.h).fill({ color: 0x121820, alpha: 0.5 });
    const sight = new PIXI.Graphics();
    for (const [x, y, rx, ry] of f.circles) sight.ellipse(x, y, rx, ry).fill(0xffffff);
    for (const id of f.own || []) {
      const t = this.territoryViews.get(id);
      for (const poly of t?.geometry || []) if (poly.length) sight.poly(poly[0].flat()).fill(0xffffff);
    }
    this.fogLayer.addChild(dark, sight);
    dark.setMask({ mask: sight, inverse: true });
  }
  _drawGhosts() {
    for (const c of this.ghostLayer.removeChildren()) c.destroy({ children: true });
    for (const gh of this.fog?.ghosts || []) {
      const c = new PIXI.Container(); c.eventMode = 'none';
      const col = parseInt(String(gh.color || '#888888').slice(1), 16) || 0x888888;
      const g = new PIXI.Graphics();
      g.roundRect(-15, -10, 30, 20, 3).fill({ color: 0x1b232c, alpha: 0.55 }).stroke({ width: 1.5, color: col, alpha: 0.85 });
      c.addChild(g);
      const type = gh.type === 'unit' && window.UnitTypes ? window.UnitTypes.resolve(gh.unitType) : null;
      if (type) { const sg = new PIXI.Graphics(); window.UnitTypes.draw(sg, c, type, { x: -11, y: -7, w: 22, h: 14 }); sg.alpha = 0.7; c.addChild(sg); }
      else c.addChild(Object.assign(new PIXI.Text({ text: gh.type === 'hero' ? '★' : '?', resolution: 3, style: { fontSize: 12, fill: 0xd5dde3, fontWeight: '700' } }), { anchor: { x: 0.5, y: 0.5 } }));
      const label = new PIXI.Text({ text: `${gh.name} · seen turn ${gh.turn}`, resolution: 2,
        style: { fontFamily: 'system-ui, sans-serif', fontSize: 10, fontStyle: 'italic', fill: 0xd5dde3, stroke: { color: 0x000000, width: 3 } } });
      label.anchor.set(0.5, 0); label.position.set(0, 12); label.alpha = 0.85;
      c.addChild(label);
      c.alpha = 0.75;
      c.position.set(gh.x, gh.y);
      this.ghostLayer.addChild(c);
    }
  }

  // ---- Provinces (game mode, Earth map) --------------------------------------------------
  /** The province set: [{ id, n, s, x, y, g }], drawn and recoloured by the province layer (public/js/province-layer.js). */
  setProvinces(list) {
    if (!this.provinceLayer) return;
    this.provinceLayer.setProvinces(list);
    this.provinceLayer.setFactionInfo([...this.factionInfo.entries()].map(([id, f]) => ({ id, name: f.name, color: '#' + f.color.toString(16).padStart(6, '0') })));
    this.provinceLayer.flushPending();
    this._syncEarthPolitical();
  }
  get provinces() { return this.provinceLayer ? this.provinceLayer.list : []; }
  /** Province owners: [[provinceId, factionId], ...]; replace = the full set. */
  setProvinceOwners(pairs, replace) {
    if (!this.provinceLayer) return;
    this.provinceLayer.setOwners(pairs, replace);
    this._syncEarthPolitical();
  }
  /** Province under a world point, or null. */
  provinceAt(x, y) { return this.provinceLayer && this.provinceLayer.size ? this.provinceLayer.provinceAt(x, y) : null; }
  /** Faction id owning a world point (0 neutral, null nobody): provinces first, else the territory polygons. */
  territoryOwnerAt(x, y) {
    if (this.provinceLayer && this.provinceLayer.size) return this.provinceLayer.ownerAt(x, y);
    for (const v of this.territoryViews.values()) if (v.factionId !== 0 && pointInMulti(x, y, v.geometry)) return v.factionId;
    for (const v of this.territoryViews.values()) if (v.factionId === 0 && pointInMulti(x, y, v.geometry)) return 0;
    return null;
  }
  _dropTerritory(v) { this.territoryLayer.removeChild(v.g, ...v.labels); v.g.destroy(); for (const l of v.labels) l.destroy(); v.labels = []; }
  _redrawTerritories() { for (const v of this.territoryViews.values()) this._drawTerritory(v); this.invalidate(); }
  _drawTerritory(v) {
    const info = this.factionInfo.get(v.factionId);
    const neutral = v.factionId === 0;
    const color = neutral ? 0x9aa5a1 : (info ? info.color : 0x888888);
    const s = this.scale, g = v.g;
    g.clear();
    // Every sizeable piece gets its own name (a colonial empire is many pieces), like the Earth layer's state labels.
    const pieces = [];
    for (const poly of v.geometry) {
      if (!poly.length) continue;
      g.poly(poly[0].flat()).fill({ color, alpha: neutral ? 0.1 : 0.3 });
      for (let i = 1; i < poly.length; i++) g.poly(poly[i].flat()).cut();
      // Border: a dark line with the owner's colour inside it, drawn along every ring (holes are other people's land).
      for (let i = 0; i < poly.length; i++) g.poly(poly[i].flat()).stroke({ width: 2.6 / s, color: 0x101c15, alpha: neutral ? 0.35 : 0.7 });
      for (let i = 0; i < poly.length; i++) g.poly(poly[i].flat()).stroke({ width: 1.2 / s, color, alpha: neutral ? 0.5 : 0.95 });
      if (!neutral && info) {
        const size = Math.sqrt(ringArea(poly[0]));
        if (size * s > 90) pieces.push({ c: ringCentroid(poly[0]), size });
      }
    }
    pieces.sort((a, b) => b.size - a.size);
    while (v.labels.length < pieces.length) {
      const t = new PIXI.Text({ text: '', style: { ...LABEL_STYLE, fontSize: 14, fontWeight: '700', fontStyle: 'italic' }, resolution: 2 });
      t.eventMode = 'none'; t.anchor.set(0.5); t.alpha = 0.85;
      this.territoryLayer.addChild(t); v.labels.push(t);
    }
    v.labels.forEach((t, i) => {
      const p = pieces[i];
      t.visible = !!p;
      if (!p) return;
      t.text = info.name; t.position.set(p.c[0], p.c[1]); t.scale.set(1 / s);
    });
  }

  // ---- Movement range ring (game mode) ----------------------------------------------
  /** Draw the remaining-movement circle (world units) around a unit being dragged. */
  showRange(x, y, radius, exhausted, ry) {
    if (!this._rangeG) { this._rangeG = new PIXI.Graphics(); this._rangeG.eventMode = 'none'; this.overlayLayer.addChild(this._rangeG); }
    this._range = { x, y, radius, exhausted, ry };
    const g = this._rangeG, s = this.scale;
    g.clear();
    const color = exhausted ? 0xe74c3c : 0x2ecc71;
    if (radius > 0) g.ellipse(x, y, radius, ry || radius).fill({ color, alpha: 0.1 }).stroke({ width: 2.5 / s, color, alpha: 0.95 });
    else g.circle(x, y, 10 / s).stroke({ width: 2 / s, color, alpha: 0.9 });
    g.visible = true;
    this.invalidate();
  }
  hideRange() {
    this._range = null;
    if (this._rangeG) { this._rangeG.visible = false; this.invalidate(); }
    this.hideRailReach();
  }
  /** Highlight the track a dragged unit can still reach by rail: [[x1, y1, x2, y2], …] in world units. */
  showRailReach(segments) {
    if (!this._railReachG) { this._railReachG = new PIXI.Graphics(); this._railReachG.eventMode = 'none'; this.overlayLayer.addChild(this._railReachG); }
    const g = this._railReachG, s = this.scale;
    g.clear();
    if (!segments.length) { g.visible = false; return; }
    const w = (window.Rail ? Rail.screenWidth(s) : 6) + 6;
    for (const [x1, y1, x2, y2] of segments) g.moveTo(x1, y1).lineTo(x2, y2);
    g.stroke({ width: w / s, color: 0x2ecc71, alpha: 0.35, cap: 'round', join: 'round' });
    g.visible = true;
    this.invalidate();
  }
  hideRailReach() { if (this._railReachG && this._railReachG.visible) { this._railReachG.visible = false; this.invalidate(); } }
  /** Snap a point to the nearest railway (vertex first, then track) within 14 screen px, so new lines join up. */
  snapToRail(x, y) {
    const tol = 14 / this.scale;
    let best = null;
    for (const v of this.shapeViews.values()) {
      if (v.shape.kind !== 'rail' || v.shape.id === this.draw.shapeId) continue;
      for (const [px, py] of v.shape.points) {
        const d = Math.hypot(px - x, py - y);
        if (d <= tol && (!best || best.vertex === false || d < best.d)) best = { x: px, y: py, d, vertex: true };
      }
      if (best && best.vertex) continue;
      const p = window.RailNet ? RailNet.project(v.shape.points, x, y) : null;
      if (p && Math.sqrt(p.d2) <= tol && (!best || Math.sqrt(p.d2) < best.d)) best = { x: p.x, y: p.y, d: Math.sqrt(p.d2), vertex: false };
    }
    return best ? { x: Math.round(best.x * 10) / 10, y: Math.round(best.y * 10) / 10 } : { x, y };
  }
  /** A general's aura: an ellipse (rx, ry in world units, so it follows the Earth's projection) around the hero. */
  showAura(x, y, rx, ry) {
    if (!this._auraG) { this._auraG = new PIXI.Graphics(); this._auraG.eventMode = 'none'; this.overlayLayer.addChild(this._auraG); }
    this._aura = { x, y, rx, ry };
    this._drawAura();
  }
  _drawAura() {
    const a = this._aura, g = this._auraG;
    if (!a || !g) return;
    g.clear().ellipse(a.x, a.y, a.rx, a.ry).fill({ color: 0xf5d76e, alpha: 0.07 }).stroke({ width: 1.6 / this.scale, color: 0xd4af37, alpha: 0.85 });
    g.visible = true;
    this.invalidate();
  }
  /** A selected unit's supply chain: a dashed amber line through its columns back to the source. */
  showSupplyLine(points) {
    if (!this._supplyG) { this._supplyG = new PIXI.Graphics(); this._supplyG.eventMode = 'none'; this.overlayLayer.addChildAt(this._supplyG, 0); }
    this._supplyPts = points;
    this._drawSupplyLine();
  }
  _drawSupplyLine() {
    const g = this._supplyG, pts = this._supplyPts, s = this.scale;
    if (!g || !pts) return;
    g.clear();
    if (pts.length < 2) { g.visible = false; return; }
    const dash = 9 / s, gap = 6 / s;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
      for (let d = 0; d < L; d += dash + gap) { const e = Math.min(L, d + dash); g.moveTo(ax + ux * d, ay + uy * d).lineTo(ax + ux * e, ay + uy * e); }
    }
    g.stroke({ width: 2.4 / s, color: 0xf5b041, alpha: 0.9 });
    for (const [x, y] of pts.slice(1)) g.circle(x, y, 4 / s).fill({ color: 0xf5b041, alpha: 0.9 });
    g.visible = true;
    this.invalidate();
  }
  hideSupplyLine() { this._supplyPts = null; if (this._supplyG && this._supplyG.visible) { this._supplyG.visible = false; this.invalidate(); } }
  hideAura() { this._aura = null; if (this._auraG && this._auraG.visible) { this._auraG.visible = false; this.invalidate(); } }

  // ---- Movement trails (game mode) --------------------------------------------------
  /** Redraw every unit's and hero's trail this turn (marker.data.trail), in its colour, with an arrow at the end. */
  redrawTrails() {
    clearTimeout(this._trailTimer);
    this._trailTimer = null;
    const g = this.trailG, s = this.scale;
    g.clear();
    if (!this.persistTrails) { this.invalidate(); return; }
    const w = 3.4 / s;
    for (const v of this.views.values()) {
      const t = v.marker.data?.trail;
      if (v.dying || !Array.isArray(t) || t.length < 1 || !['unit', 'hero'].includes(v.marker.type)) continue;
      const pts = [...t, [v.marker.x, v.marker.y]];
      if (pts.length < 2) continue;
      const path = () => { g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); };
      path(); g.stroke({ width: w * 2, color: 0x111111, alpha: 0.6, join: 'round', cap: 'round' });
      path(); g.stroke({ width: w, color: v.colorNum, alpha: 0.95, join: 'round', cap: 'round' });
      g.circle(pts[0][0], pts[0][1], w * 1.6).fill({ color: v.colorNum, alpha: 0.95 }).stroke({ width: w * 0.6, color: 0x111111, alpha: 0.5 });
      // The arrowhead sits short of the token so it is not hidden under it.
      const [bx, by] = pts[pts.length - 1];
      let k = pts.length - 2;
      while (k > 0 && Math.hypot(bx - pts[k][0], by - pts[k][1]) < 4 / s) k--;
      const [ax, ay] = pts[k], L = Math.hypot(bx - ax, by - ay);
      if (L > 1e-6) {
        const back = Math.min(L * 0.5, 16 / s), tx = bx - (bx - ax) / L * back, ty = by - (by - ay) / L * back;
        const a = Math.atan2(by - ay, bx - ax), H = 12 / s;
        g.poly([tx, ty, tx - H * Math.cos(a - 0.5), ty - H * Math.sin(a - 0.5), tx - H * Math.cos(a + 0.5), ty - H * Math.sin(a + 0.5)])
          .fill({ color: v.colorNum, alpha: 0.95 }).stroke({ width: w * 0.5, color: 0x111111, alpha: 0.5 });
      }
    }
    this.invalidate();
  }
  /** Coalesce trail redraws (many marker updates arrive together after End turn or a group move). */
  queueTrails() { if (!this._trailTimer) this._trailTimer = setTimeout(() => this.redrawTrails(), 30); }

  // ---- Battles (this turn's gunfire and shelling) ---------------------------------------------
  // ---- Shell craters -----------------------------------------------------------------------------
  /** Replace all craters (from GET /battles). */
  setCraters(list) {
    for (const t of this.towns.values()) t.dirty = !!t.plan;
    for (const sp of this.craters.values()) { sp.scar?.destroy(); sp.destroy(); }
    this.craters.clear();
    this.craterLayer.removeChildren();
    this.scarLayer.removeChildren();
    this.addCraters(list);
  }
  /**
   * Add craters: single static sprites in map units, drawn under trenches, drawings and tokens. Each lies in a scar
   * of churned, darkened mud about three times its size, with earth thrown out around it; where shells fell close
   * together the scars run into one another and the ground goes dark. Craters weather over their ten turns (the
   * mud dries and the grass comes back, so scar and hole fade), and this turn's craters still smoke.
   */
  addCraters(list) {
    const turn = this.gameTurn?.();
    for (const c of list || []) {
      if (this.craters.has(c.id) || (c.until && c.until <= Date.now())) continue;
      // Age in turns (in a game); outside one, a crater is fresh for its first hour.
      const age = turn != null && c.turn != null ? Math.max(0, turn - c.turn) : (c.until && c.until - Date.now() > 23 * 3600000 ? 0 : 3);
      const wear = Math.min(1, age / 10);
      const sp = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sp.anchor.set(0.5); sp.position.set(c.x, c.y); sp.rotation = (Number(c.rotation) || 0) * Math.PI / 180;
      sp.eventMode = 'none'; sp.alpha = 0.95 * (1 - 0.35 * wear); sp.craterSize = Number(c.size) || 1.5;
      sp.fresh = age === 0; sp.seed = (Number(c.id) * 0.6180339887) % 1;
      const scars = this._scarTextures(), scar = new PIXI.Sprite(scars[Number(c.id) % scars.length]);
      scar.anchor.set(0.5); scar.position.set(c.x, c.y); scar.rotation = sp.seed * Math.PI * 2; scar.eventMode = 'none';
      scar.scale.set(sp.craterSize * 3.3 / scar.texture.width);
      scar.alpha = 0.9 * (1 - 0.7 * wear);
      sp.scar = scar;
      this.scarLayer.addChild(scar);
      this.craters.set(c.id, sp);
      this.craterLayer.addChild(sp);
      if (window.SpriteAtlas) window.SpriteAtlas.texture(c.sprite).then(tex => {
        if (sp.destroyed || !tex) return;
        sp.texture = tex;
        sp.scale.set(sp.craterSize / Math.max(tex.width, tex.height));
        this.invalidate();
      }).catch(() => {});
    }
    this._townsHit(list || []);
    this._syncCraterZoom();
    this.invalidate();
  }
  /** Craters are a few map px across: hide them while they would be specks (their dark ground shows a little sooner). */
  _syncCraterZoom() { this.craterLayer.visible = this.scale >= 4; this.scarLayer.visible = this.scale >= 2.5; this.craterSmokeG.visible = this.scale >= 1.5; }
  /**
   * Ground scars, generated once: four variants of a ragged blotch of churned mud (value noise for its edge and
   * texture: wet dark earth, drier lighter clods, a few standing puddles), scorched dark close round the hole, and
   * clods and pale subsoil thrown out across it.
   */
  _scarTextures() {
    if (this._scarTex) return this._scarTex;
    const N = 256, out = [];
    const lattice = (n, seed) => { const a = new Float32Array(n * n); let s = seed; for (let i = 0; i < a.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = (s >>> 8) / 16777216; } return a; };
    const sample = (a, n, x, y) => {
      const fx = x * n, fy = y * n, x0 = Math.floor(fx) % n, y0 = Math.floor(fy) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
      const sm = t => t * t * (3 - 2 * t), ux = sm(fx - Math.floor(fx)), uy = sm(fy - Math.floor(fy));
      return (a[y0 * n + x0] * (1 - ux) + a[y0 * n + x1] * ux) * (1 - uy) + (a[y1 * n + x0] * (1 - ux) + a[y1 * n + x1] * ux) * uy;
    };
    const step = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    const mix = (a, b, t) => a + (b - a) * t;
    for (let v = 0; v < 4; v++) {
      const cv = document.createElement('canvas'); cv.width = cv.height = N;
      const ctx = cv.getContext('2d'), img = ctx.createImageData(N, N);
      const warp = lattice(5, 11 + v * 101), churn = lattice(14, 57 + v * 37), grit = lattice(48, 301 + v * 13), wet = lattice(9, 777 + v * 7);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const fx = x / N, fy = y / N, dx = fx - 0.5, dy = fy - 0.5, d = Math.hypot(dx, dy) * 2;
        // Ragged edge: the radius wobbles with low-frequency noise.
        const m = step(1.0, 0.45, d + (sample(warp, 5, fx, fy) - 0.5) * 0.7);
        if (m <= 0) continue;
        const c = 0.6 * sample(churn, 14, fx, fy) + 0.4 * sample(grit, 48, fx, fy);
        // Wet dark mud where churned, drier lighter earth between; scorched black-brown close to the hole.
        let r = mix(116, 62, c), g = mix(94, 45, c), b = mix(62, 29, c);
        const burn = step(0.4, 0.1, d);
        r = mix(r, 38, burn * 0.75); g = mix(g, 29, burn * 0.75); b = mix(b, 21, burn * 0.75);
        // Standing water in the hollows: dull grey-green, a little brighter.
        const pool = step(0.68, 0.76, sample(wet, 9, fx, fy)) * step(0.85, 0.5, d);
        r = mix(r, 70, pool * 0.8); g = mix(g, 76, pool * 0.8); b = mix(b, 68, pool * 0.8);
        const i = (y * N + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
        img.data[i + 3] = Math.round(255 * m * Math.min(0.92, 0.5 + 0.45 * c + 0.3 * burn + 0.25 * pool));
      }
      ctx.putImageData(img, 0, 0);
      // Thrown earth: dark clods, and pale chalky subsoil from deep down, thicker near the lip.
      let s = 4242 + v * 999;
      const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for (let k = 0; k < 220; k++) {
        const a = rnd() * Math.PI * 2, rr = N * (0.13 + Math.pow(rnd(), 1.8) * 0.3), size = (0.7 + rnd() * 2.4) * (1.25 - rr / (N * 0.45));
        const pale = rnd() < 0.22;
        ctx.fillStyle = pale ? `rgba(158,138,104,${0.45 + rnd() * 0.3})` : `rgba(48,35,24,${0.45 + rnd() * 0.35})`;
        ctx.beginPath(); ctx.ellipse(N / 2 + Math.cos(a) * rr, N / 2 + Math.sin(a) * rr, size, size * (0.5 + rnd() * 0.5), a, 0, Math.PI * 2); ctx.fill();
      }
      const tex = PIXI.Texture.from(cv);
      tex.source.scaleMode = 'linear';
      out.push(tex);
    }
    return (this._scarTex = out);
  }
  /**
   * Smoke still rising from this turn's craters: a few grey wisps each, swelling and drifting downwind as they
   * climb and fade, and now and then the glow of something smouldering in the hole. Returns true while drawn.
   */
  _tickCraterSmoke(nowMs, vx0, vy0, vx1, vy1) {
    const g = this.craterSmokeG;
    g.clear();
    if (!this.craterSmokeG.visible) return false;
    const t = nowMs / 1000;
    let any = false;
    // Burning houses in shelled towns: flames licking up, and a tall column of dark smoke leaning downwind.
    for (const tw of this.towns.values()) {
      if (!tw.fires.length || !tw.g?.visible) continue;
      for (const f of tw.fires) {
        if (f.x < vx0 - 6 || f.x > vx1 + 6 || f.y < vy0 - 2 || f.y > vy1 + 12) continue;
        any = true;
        for (let w = 0; w < 5; w++) {
          const p = ((t * 0.09 + f.seed + w * 0.2) % 1), rise = p * 3.6, drift = p * p * 1.6 + Math.sin(t * 0.5 + w + f.seed * 6) * 0.1 * p;
          const r = 0.12 + p * 0.75, a = 0.42 * Math.sin(Math.PI * Math.min(1, p * 1.3)) * (1 - p * 0.5);
          for (const k of [1, 0.7, 0.42]) g.circle(f.x + drift, f.y - rise, r * k).fill({ color: p < 0.25 ? 0x2d2925 : 0x4b4741, alpha: a * 0.4 });
        }
        const fl = 0.6 + 0.4 * Math.sin(t * 9 + f.seed * 40) * Math.sin(t * 13.7 + f.seed * 17);
        g.circle(f.x, f.y, f.s * 0.9 * fl).fill({ color: 0xff6a1a, alpha: 0.35 });
        g.circle(f.x, f.y - f.s * 0.15, f.s * 0.5 * fl).fill({ color: 0xffb03a, alpha: 0.75 });
        g.circle(f.x, f.y - f.s * 0.2, f.s * 0.22 * fl).fill({ color: 0xfff0b0, alpha: 0.85 });
      }
    }
    if (this.scale < 4) return any;
    for (const sp of this.craters.values()) {
      if (!sp.fresh) continue;
      const S = sp.craterSize, x = sp.x, y = sp.y;
      if (x < vx0 - S * 4 || x > vx1 + S * 4 || y < vy0 - S * 6 || y > vy1 + S * 2) continue;
      any = true;
      for (let w = 0; w < 4; w++) {
        const p = ((t * 0.16 + sp.seed + w * 0.25) % 1);
        const rise = p * S * 3.2, drift = p * p * S * 1.4 + Math.sin(t * 0.7 + w * 2 + sp.seed * 6) * S * 0.12 * p;
        const r = S * (0.18 + p * 0.55), a = 0.32 * Math.sin(Math.PI * p) * (1 - p * 0.4);
        // Soft-edged: three discs, the inner ones adding up towards the middle.
        const col = p < 0.3 ? 0x4a4642 : 0x77736c;
        for (const k of [1, 0.72, 0.45]) g.circle(x + drift, y - rise, r * k).fill({ color: col, alpha: a * 0.4 });
      }
      const glow = Math.max(0, Math.sin(t * 1.3 + sp.seed * 20)) * Math.max(0, Math.sin(t * 3.1 + sp.seed * 7));
      if (glow > 0.15) g.circle(x, y, S * 0.1).fill({ color: 0xff7a2a, alpha: 0.5 * glow });
    }
    return any;
  }

  /** Replace the battles shown (from GET /battles). */
  setBattles(list) { this.battles.clear(); for (const b of list || []) this.addBattle(b); this.invalidate(); }
  addBattle(b) {
    if (b.until && b.until <= Date.now()) return;
    this.battles.set(b.id, { battle: b, nextShell: performance.now() + Math.random() * 400, seed: (b.id * 9301 + 49297) % 233280 });
    this.invalidate();
  }
  /** Where each side is now (live token if still on the map, else where it stood). */
  _battleEnds(b) {
    const A = this.views.get(b.attackerId), D = this.views.get(b.defenderId);
    return { ax: A && !A.dying ? A.x : b.ax, ay: A && !A.dying ? A.y : b.ay, dx: D && !D.dying ? D.x : b.dx, dy: D && !D.dying ? D.y : b.dy };
  }
  /**
   * Animate battles. Gunfire (from 800 % zoom): tracers stream from the attacker to the target, with muzzle
   * flashes at the firing line and dust where rounds land. Shelling: bursts from the shell sheet land at random
   * around the target, each after a flash at the guns. Returns true while anything on screen animates.
   */
  _tickBattles(nowMs, vx0, vy0, vx1, vy1) {
    const g = this.gunG, s = this.scale;
    g.clear();
    this._drawShells(nowMs);
    const sk = this.skirmish, fronts = new Map(), keep = new Set();
    const gunZoom = s >= 8;
    if (!this.battles.size && !(gunZoom && (sk?.mounts || sk?.ships))) { if (sk && sk.squads.size) sk.clear(); return false; }
    let anim = false;
    const t = nowMs / 1000;
    const onScreen = (x, y, m) => x > vx0 - m && x < vx1 + m && y > vy0 - m && y < vy1 + m;
    for (const [id, e] of this.battles) {
      const b = e.battle;
      if (b.until && b.until <= Date.now()) { this.battles.delete(id); continue; }
      const { ax, ay, dx, dy } = this._battleEnds(b);
      const L = Math.hypot(dx - ax, dy - ay);
      if (L < 1e-6) continue;
      const ux = (dx - ax) / L, uy = (dy - ay) / L, nx = -uy, ny = ux;
      const margin = 60 / s;
      keep.add(b.attackerId); keep.add(b.defenderId);
      // Men and machines in the fight (skirmish.js): riflemen, gun crews, tanks or horsemen on a line a little ahead
      // of each side's token, from 800 % zoom. Aircraft fly over their target instead (strafing it), or, two air units
      // fighting, both squadrons over the defender.
      const Av = this.views.get(b.attackerId), Dv = this.views.get(b.defenderId);
      const kA = sk ? window.Skirmish.kindOf(Av?.marker) : null, kD = sk ? window.Skirmish.kindOf(Dv?.marker) : null;
      const LINE = 60, pA = kA ? LINE : 14, pD = kD ? LINE : 14;
      const squadsOn = gunZoom && (onScreen(ax, ay, margin * 3) || onScreen(dx, dy, margin * 3) || onScreen((ax + dx) / 2, (ay + dy) / 2, L / 2 + margin));
      const addFront = (id, view, kind, x0, y0, x1, y1, px, otherPx) => {
        if ((fronts.get(id)?.battleId ?? -1) > b.id) return;   // the unit's latest fight sets its line
        const l = Math.hypot(x1 - x0, y1 - y0), r0 = Math.min(l * 0.3, px / s), r1 = Math.min(l * 0.3, otherPx / s);
        const fux = (x1 - x0) / l, fuy = (y1 - y0) / l;
        if (kind === 'balloon') {
          // A balloon stays over its own winch; an airship attacking goes over its target.
          fronts.set(id, { battleId: b.id, view, kind, mode: id === b.attackerId ? 'attack' : 'hold', ax: x1, ay: y1, hx: x0, hy: y0,
            enemyId: id === b.attackerId ? b.defenderId : b.attackerId, enemyKind: id === b.attackerId ? kD : kA, createdAt: b.createdAt });
          return;
        }
        if (kind === 'air') {
          const dog = (id === b.attackerId ? kD : kA) === 'air';
          fronts.set(id, { battleId: b.id, view, kind, mode: dog ? 'dogfight' : 'strafe', ax: dog ? dx : x1, ay: dog ? dy : y1, hx: x0, hy: y0,
            enemyId: id === b.attackerId ? b.defenderId : b.attackerId, createdAt: b.createdAt });
          return;
        }
        const enemyId = id === b.attackerId ? b.defenderId : b.attackerId, enemyKind = id === b.attackerId ? kD : kA;
        fronts.set(id, { battleId: b.id, view, kind, enemyId, enemyKind, cover: id === b.defenderId && !!b.cover, shells: b.kind === 'shells' && id === b.attackerId, cx: x0 + fux * r0, cy: y0 + fuy * r0, ux: fux, uy: fuy,
          front: Math.max(80, Math.min(190, (l - r0 - r1) * s * 0.9)) / s, backPx: r0 * s, tx: x1 - fux * r1, ty: y1 - fuy * r1, createdAt: b.createdAt });
      };
      if (squadsOn) {
        // Heavy guns shelling get a spotter balloon up behind the battery, its observers directing the fire.
        if (b.kind === 'shells' && kA === 'guns' && /heavyartillery|siegeartillery|railwaygun/.test(window.UnitTypes?.resolve(Av?.marker?.data?.unitType)?.id || '')) {
          const key = 'spot' + b.attackerId;
          fronts.set(key, { view: Av, kind: 'balloon', spotter: true, mode: 'hold', hx: ax - ux * 34 / s + nx * 22 / s, hy: ay - uy * 34 / s + ny * 22 / s });
          keep.add(key);
        }
        if (kA) addFront(b.attackerId, Av, kA, ax, ay, dx, dy, pA, kD ? LINE : 10);
        if (kD) addFront(b.defenderId, Dv, kD, dx, dy, ax, ay, pD, kA ? LINE : 10);
      }
      if (b.kind === 'gunfire') {
        if (!squadsOn) continue;
        anim = true;
        // The attacker's line opens fire; the defender's line answers, a little lighter, while it still stands.
        const live = id => { const v = this.views.get(id); return !v || (!v.dying && Number(v.marker.data?.strength ?? 100) > 0); };
        const aStands = !!Av && live(b.attackerId), dStands = !!Dv && live(b.defenderId);
        // Units drawn as men, machines, horsemen, planes or ships (skirmish.js) fire from where those are: no firing
        // line from their tokens. Nor is one aimed at a plane's token (its planes are over the fight).
        const own = k => !!sk?.firesOwn(k), air = !!sk?.mounts && (kA === 'air' || kD === 'air');
        // Gas troops release a cloud instead of firing (its men are drawn masked, and stop firing, while it covers them).
        const gas = window.UnitTypes?.resolve(Av?.marker?.data?.unitType)?.id === 'gas';
        if (gas && aStands) {
          const cover = this._drawGas(g, e, ax, ay, dx, dy, t, s, pA, kD ? LINE : 10);
          const fd = fronts.get(b.defenderId);
          if (fd) fd.gas = cover;
        } else if (aStands && !own(kA) && !air) this._drawLineFire(g, ax, ay, dx, dy, e.seed, 1, t, s, pA, kD ? LINE : 10);
        if (dStands && !own(kD) && !air) this._drawLineFire(g, dx, dy, ax, ay, e.seed + 7.77, 0.65, t, s, pD, kA ? LINE : 10);
      } else {
        // Shelling: visible when the guns or the target are on screen (above 150 %). Each shell leaves the guns
        // with a flash, climbs a slow arc toward where it will land (so players can see where fire comes from),
        // and bursts on arrival.
        if (s < 1.5 || !(onScreen(dx, dy, margin) || onScreen(ax, ay, margin))) continue;
        anim = true;
        if (nowMs >= e.nextShell && this.shellFrames) {
          const a = Math.random() * Math.PI * 2, r = (14 + Math.random() * 40) / s;
          const bx = dx + Math.cos(a) * r, by = dy + Math.sin(a) * r * 0.75;
          // From one of the battery's guns when they are drawn (it recoils and flashes), else the token's edge.
          const gun = sk ? sk.fireGun(b.attackerId, nowMs) : null;
          const mx = gun ? gun.x : ax + ux * 16 / s, my = gun ? gun.y : ay + uy * 16 / s - 8 / s;
          const distPx = Math.hypot(bx - mx, by - my) * s;
          const dur = Math.max(1000, Math.min(2400, 700 + distPx * 4));          // slow enough to follow
          const h = Math.max(30, Math.min(160, distPx * 0.35)) / s;                // arc height (up the screen)
          this.shellsInFlight.push({ x0: mx, y0: my, x1: bx, y1: by, t0: nowMs, dur, h });
          this._gunFlash(mx, my, ux, uy);
          if (this._isWater(bx, by, b)) this.splash(bx, by, 80 + Math.random() * 50, dur);
          else this.explode(bx, by, 80 + Math.random() * 60, dur, this.shellFrames);
          e.nextShell = nowMs + 900 + Math.random() * 1600;
        }
      }
    }
    // Air and naval units out of a fight, on screen: their planes circle over them, their ships lie around them.
    if (gunZoom && (sk?.mounts || sk?.ships)) {
      const m = 120 / s;
      for (const [id, v] of this.views) {
        if (fronts.has(id) || v.dying || v.riding || !onScreen(v.x, v.y, m)) continue;
        if (v._skType !== v.marker.data?.unitType || v._skKind === undefined) { v._skType = v.marker.data?.unitType; v._skKind = window.Skirmish.kindOf(v.marker); }
        if (v._skKind === 'ships' && sk.ships) {
          // Bows the way it last moved (else either way, steady for the unit).
          const tr = v.marker.data?.trail, a = Array.isArray(tr) && tr.length > 1 ? tr[tr.length - 1][0] - tr[tr.length - 2][0] : 0;
          fronts.set(id, { view: v, kind: 'ships', idle: true, cx: v.x, cy: v.y, ux: a ? Math.sign(a) : (id % 2 ? 1 : -1), uy: 0 });
          keep.add(id);
          continue;
        }
        if (v._skKind === 'balloon') {
          fronts.set(id, { view: v, kind: 'balloon', mode: 'hold', hx: v.x, hy: v.y });
          keep.add(id);
          continue;
        }
        if (v._skKind !== 'air' || !sk.mounts) continue;
        fronts.set(id, { view: v, kind: 'air', mode: 'orbit', ax: v.x, ay: v.y, hx: v.x, hy: v.y });
        keep.add(id);
      }
    }
    if (sk && sk.frame(fronts, keep, nowMs, s, g)) anim = true;
    return anim;
  }
  /**
   * A gas attack: a row of cylinders on the gas troops' line hisses out a yellow-green cloud, which rolls downwind
   * across to the enemy and over him, swelling and thinning, and lingers before it clears; then they open the
   * cylinders again (a 26 s cycle). Each puff is a blob with its own release time, drift and spread, drawn soft.
   * Returns how thickly it lies on the enemy's line now (0..1).
   */
  _drawGas(g, e, ax, ay, dx, dy, t, s, ownPx, targetPx) {
    const L = Math.hypot(dx - ax, dy - ay);
    if (L < 1e-6) return 0;
    const ux = (dx - ax) / L, uy = (dy - ay) / L, nx = -uy, ny = ux, seed = e.seed;
    const r0 = Math.min(L * 0.3, ownPx / s), r1 = Math.min(L * 0.3, targetPx / s);
    const sx = ax + ux * r0, sy = ay + uy * r0, span = Math.max(1e-6, L - r0 - r1) * s;   // px from their line to the enemy's
    const front = Math.max(80, Math.min(190, span * 0.9)) / s, P = 26, cyc = ((t + seed * 7) % P + P) % P;
    // The cylinders: a row of little grey bottles along the line, hissing while the cloud is let out.
    for (let i = 0; i < 9; i++) {
      const o = ((i + 0.5) / 9 - 0.5) * front, x = sx + nx * o, y = sy + ny * o;
      g.rect(x - 1.2 / s, y - 2.5 / s, 2.4 / s, 5 / s).fill({ color: 0x55595c });
      if (cyc < 7) g.circle(x + ux * 4 / s, y + uy * 4 / s, (2 + Math.random() * 2) / s).fill({ color: 0xd6d48a, alpha: 0.5 });
    }
    // The cloud: puffs let out over the first 7 s, drifting at 14–22 px/s, spreading and thinning for 19 s.
    let onLine = 0;
    for (let i = 0; i < 64; i++) {
      const k1 = hash01(seed, i * 5 + 1), k2 = hash01(seed, i * 5 + 2), k3 = hash01(seed, i * 5 + 3);
      const age = cyc - k1 * 7;
      if (age < 0 || age > 19) continue;
      const v = 14 + k2 * 8, d = Math.min(span + 40, age * v), o = ((k3 - 0.5) * 1.15 + Math.sin(age * 0.3 + i) * 0.08) * front;
      const x = sx + ux * d / s + nx * o, y = sy + uy * d / s + ny * o;
      const r = (7 + age * 1.9) / s, a = 0.42 * Math.min(1, age / 1.5) * Math.min(1, (19 - age) / 6);
      g.circle(x, y, r).fill({ color: 0xbfc35a, alpha: a * 0.45 }).circle(x, y, r * 0.65).fill({ color: 0xc9cc68, alpha: a * 0.5 }).circle(x, y, r * 0.35).fill({ color: 0xa9b04c, alpha: a * 0.5 });
      if (Math.abs(d - span) < 30 && a > 0.12) onLine++;
    }
    return Math.min(1, onLine / 10);
  }
  /**
   * One side's fire in a firefight, from (ax, ay) at (dx, dy). `intensity` (0..1) thins the line (return fire
   * is lighter than the attack); `seed` keeps each side's pattern its own.
   */
  _drawLineFire(g, ax, ay, dx, dy, seed, intensity, t, s, ownPx = 14, targetPx = 10) {
    const L = Math.hypot(dx - ax, dy - ay);
    if (L < 1e-6) return;
    const ux = (dx - ax) / L, uy = (dy - ay) / L, nx = -uy, ny = ux;
    // A regiment engaging along a line: riflemen spread across a front perpendicular to the line of fire.
    // Every round is a shot fired at a moment in the past, so it keeps the heading it was fired on while the
    // sections of the line sweep their aim along the enemy's front, fire in bursts and lulls, and now and
    // then loose a volley together. Sizes are on screen so it reads at any zoom.
    const r0 = Math.min(L * 0.3, ownPx / s), r1 = Math.min(L * 0.3, targetPx / s);   // own firing line, where rounds land
    const sx = ax + ux * r0, sy = ay + uy * r0, ex = dx - ux * r1, ey = dy - uy * r1;
    const span = Math.max(1e-6, Math.hypot(ex - sx, ey - sy));
    const front = Math.max(ownPx > 14 ? 80 : 70, Math.min(190, span * s * 0.9)) / s;      // own firing line (world units)
    const enemyFront = front * 0.75;
    const rifles = Math.max(6, Math.round(Math.max(10, Math.min(28, Math.round(front * s / 7))) * intensity));
    const sections = Math.max(2, Math.round(rifles / 7));
    const baseSpeed = 460 / s;                                          // world units per second (screen-constant)
    const w = 1.8 / s;
    // The firing line itself: a haze of powder smoke along the front that thickens and thins.
    const haze = 0.08 + 0.08 * smooth(t * 0.3 + seed);
    g.moveTo(sx - nx * front / 2, sy - ny * front / 2).lineTo(sx + nx * front / 2, sy + ny * front / 2).stroke({ width: 8 / s, color: 0xe8e4da, alpha: haze, cap: 'round' });
    // Volleys: every 7–11 s the whole line fires together for a moment.
    const volleyPeriod = 7 + hash01(seed, 1) * 4;
    const volleyAt = tf => ((tf / volleyPeriod) % 1 + 1) % 1 < 0.06 ? 1 : 0;
    for (let i = 0; i < rifles; i++) {
      const k = hash01(seed, i * 3 + 11), k2 = hash01(seed, i * 3 + 12), k3 = hash01(seed, i * 3 + 13);   // stable per rifle
      const sec = Math.min(sections - 1, Math.floor(i * sections / rifles));
      const o = ((i + 0.5) / rifles - 0.5) * front + (k - 0.5) * front / rifles;   // place on our front
      const fx = sx + nx * o - ux * k2 * 4 / s, fy = sy + ny * o - uy * k2 * 4 / s; // ragged line
      const period = 0.32 + k3 * 0.55;                                              // this rifle's cadence
      const phase = k * period;
      // Where on the enemy's front this rifle aims at time tf: its share of the front, swept by its section.
      const sweepW = 0.25 + 0.45 * hash01(seed, 200 + sec), sweepF = 0.25 + 0.5 * hash01(seed, 300 + sec), sweepP = hash01(seed, 400 + sec) * 6.28;
      const aim = tf => (o / front) * enemyFront * 0.7 + Math.sin(tf * sweepF + sweepP) * enemyFront * sweepW * 0.5 + (k2 - 0.5) * enemyFront * 0.2;
      // Section activity: bursts and lulls (0..1), full during a volley.
      const active = tf => Math.max(volleyAt(tf), Math.min(1, Math.max(0, smooth(tf * 0.45 + sec * 3.7 + seed) * 1.5 - 0.35)));
      const flight = span / baseSpeed;
      const last = Math.floor((t - phase) / period);
      let flashed = false;
      for (let j = last; j >= last - 6; j--) {
        const tf = j * period + phase;                                              // when this shot was fired
        const age = t - tf;
        if (age < 0) continue;
        if (age > flight * 1.3 + 0.6) break;
        if (hash01(seed + j * 0.37, i) > active(tf)) continue;                       // this shot was not fired
        const hs = hash01(j, i + seed);                                             // per-shot variation
        const sp = baseSpeed * (0.82 + hs * 0.36);
        const oT = aim(tf) + (hs - 0.5) * enemyFront * 0.08;
        const tx = ex + nx * oT, ty = ey + ny * oT;
        const dxl = tx - fx, dyl = ty - fy, ll = Math.max(1e-6, Math.hypot(dxl, dyl)), vx = dxl / ll, vy = dyl / ll;
        const T = ll / sp;
        if (age <= T) {
          const p = age / T, seg = (8 + hs * 9) / s;
          const px = fx + dxl * p, py = fy + dyl * p;
          const core = hs < 0.15 ? 0xffd2a0 : hs > 0.9 ? 0xffffff : 0xfff0a0;     // a few redder or whiter rounds
          g.moveTo(px, py).lineTo(px + vx * seg, py + vy * seg).stroke({ width: w * 2.6, color: 0xffb347, alpha: 0.2 });   // glow
          g.moveTo(px, py).lineTo(px + vx * seg, py + vy * seg).stroke({ width: w * (0.8 + hs * 0.4), color: core, alpha: 0.95 });
          if (age < 0.06 && !flashed) {                                            // muzzle flash on the shot
            flashed = true;
            const fl = (3 + hs * 2) / s;
            g.poly([fx + vx * fl * 2, fy + vy * fl * 2, fx + nx * fl * 0.6, fy + ny * fl * 0.6, fx - nx * fl * 0.6, fy - ny * fl * 0.6]).fill({ color: 0xfff3b0, alpha: 0.95 });
          }
        } else {
          const q = (age - T) / 0.6;                                               // dust where it landed
          if (q < 1) g.circle(tx + vx * q * 3 / s, ty + vy * q * 3 / s, (1.2 + q * 5 * (0.6 + hs * 0.8)) / s).fill({ color: 0xd8d2c4, alpha: 0.45 * (1 - q) });
        }
      }
    }
  }

  /**
   * Shells in flight: a bright shell with a fading trail along a parabola from the guns to the landing point,
   * over a faint dotted line of the whole trajectory. Returns true while any is in the air.
   */
  _drawShells(nowMs) {
    const g = this.arcG, s = this.scale;
    g.clear();
    if (!this.shellsInFlight.length) return false;
    const at = (sh, p) => [sh.x0 + (sh.x1 - sh.x0) * p, sh.y0 + (sh.y1 - sh.y0) * p - sh.h * 4 * p * (1 - p)];
    this.shellsInFlight = this.shellsInFlight.filter(sh => nowMs - sh.t0 < sh.dur);
    for (const sh of this.shellsInFlight) {
      const p = Math.max(0, Math.min(1, (nowMs - sh.t0) / sh.dur));
      // The whole trajectory, faint and dotted, so the line of fire reads at a glance.
      for (let q = 0.04; q < 1; q += 0.06) { const [x, y] = at(sh, q); g.circle(x, y, 1.3 / s).fill({ color: 0xfff2c0, alpha: 0.35 }); }
      // Trail: the last stretch behind the shell, fading out.
      const tail = 0.22, steps = 10;
      for (let k = 0; k < steps; k++) {
        const q0 = p - tail * (k + 1) / steps, q1 = p - tail * k / steps;
        if (q1 <= 0) break;
        const [x0, y0] = at(sh, Math.max(0, q0)), [x1, y1] = at(sh, q1);
        g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: (3.6 - k * 0.25) / s, color: 0xe6e1d6, alpha: 0.7 * (1 - k / steps) });
      }
      const [x, y] = at(sh, p);
      g.circle(x, y, 4.5 / s).fill({ color: 0xffb347, alpha: 0.4 });
      g.circle(x, y, 2.3 / s).fill({ color: 0xfff5d6, alpha: 1 });
    }
    this.invalidate();
    return this.shellsInFlight.length > 0;
  }
  /** Is a point at sea? Provinces cover all land on the Earth map in game mode; otherwise the server's hint. */
  _isWater(x, y, b) {
    if (this.provinceLayer && this.provinceLayer.size) return !this.provinceAt(x, y);
    return !!(b && b.sea);
  }
  /**
   * A shell landing in water, drawn (no sprite sheet): a white column that leaps up and collapses, spray thrown
   * outwards, a darker patch where the water churned and two foam rings spreading on the surface. ~1.2 s.
   */
  splash(x, y, screenSize = 80, delayMs = 0) {
    this.invalidate();
    const g = new PIXI.Graphics();
    g.eventMode = 'none';
    g.position.set(x, y);
    g.splashInfo = { size: screenSize, start: performance.now() + delayMs, dur: 1200, seed: Math.random() * 1000 };
    g.life = delayMs + 1300;
    g.visible = false;
    this.boomLayer.addChild(g);
    return true;
  }
  _drawSplash(g, nowMs) {
    const sp = g.splashInfo, p = (nowMs - sp.start) / sp.dur;
    g.clear();
    if (p < 0 || p > 1) { g.visible = false; return; }
    g.visible = true;
    g.scale.set(1 / this.scale);
    const u = sp.size / 100;                                  // drawn in screen px, scaled to the map
    // Churned water and foam rings on the surface (flattened: seen from above at an angle).
    g.ellipse(0, 0, (14 + 30 * p) * u, (6 + 12 * p) * u).fill({ color: 0x9bd0e6, alpha: 0.35 * (1 - p) });
    for (const [lag, amp] of [[0, 1], [0.22, 0.7]]) {
      const q = (p - lag) / (1 - lag);
      if (q <= 0) continue;
      const rx = (10 + 52 * q) * u * amp, ry = rx * 0.38;
      g.ellipse(0, 0, rx, ry).stroke({ width: Math.max(0.5, 3.2 * u * (1 - q)), color: 0xffffff, alpha: 0.85 * (1 - q) });
    }
    // The column: up fast, down slower, widening as it falls.
    if (p < 0.7) {
      const c = p / 0.7, hgt = 62 * u * Math.sin(Math.PI * Math.pow(c, 0.7)), wid = (7 + 6 * c) * u;
      g.ellipse(0, -hgt / 2, wid, hgt / 2 + 2 * u).fill({ color: 0xd6eef8, alpha: 0.9 * (1 - c * 0.6) });
      g.ellipse(0, -hgt * 0.55, wid * 0.55, hgt * 0.4).fill({ color: 0xffffff, alpha: 0.95 * (1 - c * 0.6) });
      g.circle(0, -hgt, wid * 0.9).fill({ color: 0xffffff, alpha: 0.85 * (1 - c) });   // crown of spray
    }
    // Spray: droplets on ballistic paths, stable per splash.
    for (let i = 0; i < 14; i++) {
      const k = hash01(sp.seed, i), k2 = hash01(sp.seed + 3, i);
      const ang = (i / 14) * Math.PI * 2 + k;
      const vx = Math.cos(ang) * (18 + 26 * k2), vy = 40 + 45 * k;
      const px = vx * p * u, py = (-(vy * p) + 85 * p * p) * u + Math.sin(ang) * 6 * p * u;
      if (py > 4 * u) continue;                                // back in the water
      g.circle(px, py, (1.2 + 1.3 * k2) * u).fill({ color: 0xf2fbff, alpha: 0.9 * (1 - p) });
    }
  }
  /** A short flash at the guns, pointing at the target. */
  _gunFlash(x, y, ux, uy) {
    const g = new PIXI.Graphics(), nx = -uy, ny = ux, f = 10;
    g.poly([ux * f * 2.2, uy * f * 2.2, nx * f * 0.7, ny * f * 0.7, -ux * f * 0.3, -uy * f * 0.3, -nx * f * 0.7, -ny * f * 0.7]).fill({ color: 0xfff1a8, alpha: 0.95 });
    g.circle(ux * f * 0.6, uy * f * 0.6, f * 0.55).fill({ color: 0xffffff, alpha: 0.9 });
    g.position.set(x, y); g.scale.set(1 / this.scale);
    g.life = 220; g.flash = true;
    this.boomLayer.addChild(g);
  }

  // ---- GM pings -----------------------------------------------------------------------
  /** Show a ping until ping.until: a pin with pulsing rings, plus an arrow at the screen edge when it is off screen. */
  addPing(ping) {
    if (this.pings.has(ping.id) || ping.until <= Date.now()) return;
    const c = new PIXI.Container(); c.eventMode = 'none';
    const rings = new PIXI.Graphics();
    const pin = new PIXI.Graphics();
    pin.circle(0, -22, 9).fill(0xe74c3c).stroke({ width: 2.5, color: 0xffffff });
    pin.poly([-7, -17, 7, -17, 0, -2]).fill(0xe74c3c);
    pin.circle(0, -22, 3.2).fill(0xffffff);
    pin.ellipse(0, 0, 6, 2.5).fill({ color: 0x000000, alpha: 0.35 });
    const label = new PIXI.Text({ text: ping.label || `📍 ${ping.by || 'GM'}`, style: { fontFamily: 'system-ui, sans-serif', fontSize: 13, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x000000, width: 3 } }, resolution: 2 });
    label.anchor.set(0.5, 1); label.position.set(0, -34);
    c.addChild(rings, pin, label);
    c.position.set(ping.x, ping.y);
    this.pingLayer.addChild(c);
    this.pings.set(ping.id, { ping, c, rings });
    this.invalidate();
  }
  _tickPings(nowMs) {
    const g = this.pingArrows;
    g.clear();
    if (!this.pings.size) return false;
    const s = this.scale, sw = this.app.screen.width, sh = this.app.screen.height, M = 26;
    for (const [id, p] of this.pings) {
      const left = p.ping.until - Date.now();
      if (left <= 0) { this.pingLayer.removeChild(p.c); p.c.destroy({ children: true }); this.pings.delete(id); continue; }
      const alpha = Math.min(1, left / 5000);
      p.c.scale.set(1 / s);
      p.c.alpha = alpha;
      const t = ((nowMs - p.ping.at) % 1600) / 1600;
      p.rings.clear();
      for (const k of [0, 0.5]) {
        const u = (t + k) % 1;
        p.rings.circle(0, 0, 8 + u * 46).stroke({ width: 3, color: 0xe74c3c, alpha: (1 - u) * 0.9 });
      }
      // Off screen: an arrow on the edge pointing at it.
      const sp = this.worldToScreen(p.ping.x, p.ping.y);
      if (sp.x < 0 || sp.y < 0 || sp.x > sw || sp.y > sh) {
        const cx = sw / 2, cy = sh / 2, dx = sp.x - cx, dy = sp.y - cy;
        const k = Math.min((sw / 2 - M) / Math.abs(dx || 1e-6), (sh / 2 - M) / Math.abs(dy || 1e-6));
        const ex = cx + dx * k, ey = cy + dy * k, a = Math.atan2(dy, dx);
        g.circle(ex, ey, 15).fill({ color: 0xe74c3c, alpha: 0.9 * alpha }).stroke({ width: 2, color: 0xffffff, alpha });
        g.poly([ex + 13 * Math.cos(a), ey + 13 * Math.sin(a), ex + 5 * Math.cos(a + 2.2), ey + 5 * Math.sin(a + 2.2), ex + 5 * Math.cos(a - 2.2), ey + 5 * Math.sin(a - 2.2)])
          .fill({ color: 0xffffff, alpha });
      }
    }
    return this.pings.size > 0;
  }
  /** Centre on the newest live ping; returns false when there is none. */
  goToPing(id) {
    const p = id ? this.pings.get(id) : [...this.pings.values()].pop();
    if (!p) return false;
    this.centerOn(p.ping.x, p.ping.y);
    return true;
  }

  // ---- Input ------------------------------------------------------------------------
  _bindInput() {
    const st = this.app.stage;
    const canvas = this.app.canvas;

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const f = Math.exp(-e.deltaY * 0.0016);
      this.setScale(this.scale * f, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    st.on('pointerdown', e => {
      if (e.target !== st) return;
      if (e.button === 0 && (this.mode === 'select' || (!this.mode && e.shiftKey))) { this._marqueeStart(e); return; }
      if (this.mode && e.button === 0) {
        this._modeClick(e);
        // Trenches can be drawn freehand: keep sampling while the button is held.
        if (this.mode === 'draw' && (this.draw.kind === 'trench' || this.draw.kind === 'rail')) this.draw.freehand = true;
        return;
      }
      this._pan = { sx: e.global.x, sy: e.global.y, wx: this.world.x, wy: this.world.y, moved: false, button: e.button };
    });

    st.on('globalpointermove', e => {
      if (this._marquee) { this._marqueeMove(e); return; }
      if (this._vdrag) {
        const d = this._vdrag, v = d.view;
        const p = this.screenToWorld(e.global.x, e.global.y);
        if (d.whole) {
          const dx = p.x - d.start.x, dy = p.y - d.start.y;
          if (Math.hypot(dx, dy) > 1 / this.scale) d.moved = true;
          v.shape = { ...v.shape, points: d.orig.map(q => [q[0] + dx, q[1] + dy]) };
        } else {
          d.moved = true;
          const pts = v.shape.points.slice();
          pts[d.index] = [p.x - d.ox, p.y - d.oy];
          v.shape = { ...v.shape, points: pts };
        }
        this._drawShapeView(v);
        this._positionHandles();
        return;
      }
      if (this._pan) {
        const dx = e.global.x - this._pan.sx, dy = e.global.y - this._pan.sy;
        if (Math.hypot(dx, dy) > 3) this._pan.moved = true;
        this.world.x = this._pan.wx + dx;
        this.world.y = this._pan.wy + dy;
        this.invalidate();
        return;
      }
      if (this._drag) {
        const d = this._drag;
        const p = this.screenToWorld(e.global.x, e.global.y);
        const nx = p.x - d.ox, ny = p.y - d.oy;
        if (!d.moved && Math.hypot(nx - d.startX, ny - d.startY) < 2 / this.scale) return;
        d.moved = true;
        const t = performance.now();
        const emit = t - d.last > 45;
        if (emit) d.last = t;
        if (d.group) {
          // Move every selected token by the same offset so the formation keeps its shape.
          const dx = nx - d.startX, dy = ny - d.startY;
          for (const g of d.group) {
            g.view.setImmediate(g.x + dx, g.y + dy);
            if (emit) this.dispatchEvent(new CustomEvent('drag', { detail: { id: g.view.id, x: g.x + dx, y: g.y + dy } }));
          }
        } else {
          d.view.setImmediate(nx, ny);
          if (emit) this.dispatchEvent(new CustomEvent('drag', { detail: { id: d.view.id, x: nx, y: ny } }));
        }
        return;
      }
      if (this.mode) {
        const p = this.screenToWorld(e.global.x, e.global.y);
        if (this.mode === 'draw' && this.draw.freehand) {
          const last = this.draw.points[this.draw.points.length - 1];
          if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 6 / this.scale) {
            this.draw.points.push({ x: p.x, y: p.y });
            this.draw.lastClick = null;               // a long drag is not a double-click
            this._redrawMode(); this._emitMode();
          }
          return;
        }
        this._modeHover(p.x, p.y);
      }
    });

    const up = e => {
      if (this.draw.freehand) this.draw.freehand = false;
      if (this._marquee) {
        if (!this._marqueeEnd() && this.mode !== 'select' && !e.shiftKey) this.select(null);
        return;
      }
      if (this._vdrag) {
        const d = this._vdrag; this._vdrag = null;
        if (d.moved || d.inserted) this._commitShapePoints(d.view, d.view.shape.points);
        else this._drawHandles();
      }
      if (this._pan) {
        const pan = this._pan; this._pan = null;
        if (!pan.moved && pan.button === 0 && !this.mode) {
          const p = this.screenToWorld(e.global.x, e.global.y);
          if (this.onMapClick && this.onMapClick(p.x, p.y)) return;
          this.select(null);
          this.dispatchEvent(new CustomEvent('mapclick', { detail: { x: p.x, y: p.y } }));
        } else if (!pan.moved && pan.button === 2 && !this.mode) {
          const p = this.screenToWorld(e.global.x, e.global.y);
          this.dispatchEvent(new CustomEvent('mapcontext', { detail: { x: p.x, y: p.y } }));
        }
      }
      if (this._drag) {
        const d = this._drag; this._drag = null;
        this.hideRange();
        d.view.dragging = false;
        if (d.group) for (const g of d.group) g.view.dragging = false;
        if (d.moved) {
          if (d.group) {
            const moves = d.group.map(g => { this.trail(g.x, g.y, g.view.x, g.view.y, g.view.colorNum); return { id: g.view.id, x: g.view.x, y: g.view.y }; });
            this.dispatchEvent(new CustomEvent('dragend', { detail: { id: d.view.id, x: d.view.x, y: d.view.y, moves } }));
          } else {
            this.trail(d.startX, d.startY, d.view.x, d.view.y, d.view.colorNum);
            this.dispatchEvent(new CustomEvent('dragend', { detail: { id: d.view.id, x: d.view.x, y: d.view.y } }));
          }
        } else if (!d.group) {
          this.select(d.view.id);
        } else {
          this.selectMany([...this.selected], d.view.id);   // click within a group: make it the primary
        }
      }
    };
    st.on('pointerup', up);
    st.on('pointerupoutside', up);
  }

  _startMarkerPointer(view, e) {
    // Right-click: the app opens the token's panel (units and heroes only show it this way).
    if (e.button === 2 && (!this.mode || this.mode === 'select')) {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('markercontext', { detail: { id: view.id } }));
      return;
    }
    if (e.button !== 0) return;
    if (this.mode && this.mode !== 'select') { this._modeClick(e); e.stopPropagation(); return; }
    e.stopPropagation();
    if (e.shiftKey) { if (this.canDrag(view.marker)) this.toggleSelect(view.id); return; }
    if (this.canDrag(view.marker) && !this.dragAllowed(view.marker)) {
      if (this.selected.has(view.id) && this.selected.size > 1) this.selectMany([...this.selected], view.id);
      else this.select(view.id);
      return;
    }
    if (this.canDrag(view.marker)) {
      const p = this.screenToWorld(e.global.x, e.global.y);
      this._drag = { view, ox: p.x - view.x, oy: p.y - view.y, moved: false, last: 0, startX: view.x, startY: view.y };
      if (this.selected.has(view.id) && this.selected.size > 1) {
        this._drag.group = [...this.selected].map(id => this.views.get(id)).filter(v => v && !v.dying && this.canDrag(v.marker))
          .map(v => ({ view: v, x: v.x, y: v.y }));
        for (const g of this._drag.group) g.view.dragging = true;
      }
      view.dragging = true;
      this.dispatchEvent(new CustomEvent('dragstart', { detail: { id: view.id, ids: this._drag.group ? this._drag.group.map(g => g.view.id) : [view.id] } }));
    } else {
      this.select(view.id);
    }
  }

  // ---- Frame loop -------------------------------------------------------------------
  /** Mark the scene as changed so the next animation frame draws it. Cheap; call freely. */
  invalidate() { this._dirty = true; }

  _startLoop() {
    const loop = now => {
      this._raf = requestAnimationFrame(loop);
      if (!this._dirty && !this._animating) return;                     // idle: draw nothing at all
      const interacting = !!(this._pan || this._drag || this._vdrag || this._marquee);
      if (!this._dirty && !interacting && now - this._lastRender < 1000 / this.idleFps - 1) return;
      const dt = this._lastRender ? Math.min(100, now - this._lastRender) : 16;
      this._dirty = false;
      this._lastRender = now;
      this._tick(dt);
      this.app.render();
    };
    this._raf = requestAnimationFrame(loop);
  }

  // ---- Per-frame animation --------------------------------------------------------
  /** Advance animations by dt ms. Sets this._animating when another frame is needed. */
  _tick(dt) {
    const s = this.scale, inv = 1 / s;
    const nowMs = performance.now();
    const t = nowMs / 1000;
    const k = 1 - Math.pow(0.001, dt / 700); // movement easing
    let anim = this.fxLayer.children.length > 0 || this.boomLayer.children.length > 0;
    if (this._tickPings(nowMs)) anim = true;
    // From 800 % the planes of air units are up, circling, and naval units' ships lie on the water, whether or not
    // they fight (skirmish.js).
    if (this.battles.size || this.shellsInFlight.length || this.skirmish?.squads.size || (s >= 8 && (this.skirmish?.mounts || this.skirmish?.ships))) {
      const tl = this.screenToWorld(0, 0), br = this.screenToWorld(this.app.screen.width, this.app.screen.height);
      if (this._tickBattles(nowMs, tl.x, tl.y, br.x, br.y)) anim = true;
      if (this.shellsInFlight.length) anim = true;
    }
    if ((this.craters.size || this.towns.size) && this.scale >= 1.5) {
      const tl = this.screenToWorld(0, 0), br = this.screenToWorld(this.app.screen.width, this.app.screen.height);
      if (this._tickTowns(tl.x, tl.y, br.x, br.y)) anim = true;
    } else this.townLayer.visible = false;
    if (this.craters.size && this.scale >= 1.5) {
      const tl = this.screenToWorld(0, 0), br = this.screenToWorld(this.app.screen.width, this.app.screen.height);
      if (this._tickCraterSmoke(nowMs, tl.x, tl.y, br.x, br.y)) anim = true;
    } else this.craterSmokeG.clear();
    if (this.railLayer.children.length) {
      const tl = this.screenToWorld(0, 0), br = this.screenToWorld(this.app.screen.width, this.app.screen.height);
      const vx0 = tl.x, vy0 = tl.y, vx1 = br.x, vy1 = br.y;
      for (const v of this.shapeViews.values()) {
        if (!v.rail) continue;
        const b = v.rail.bbox;
        const on = !!b && b.x1 >= vx0 && b.x0 <= vx1 && b.y1 >= vy0 && b.y0 <= vy1;
        if (v.rail.tick(dt, on)) anim = true;
      }
    }
    // Unit icons hide on the Earth map at 100 % zoom and below (dots stand in); tokens off screen are not drawn.
    if (this._tickRides(nowMs)) anim = true;
    const hideUnits = this.unitsHidden();
    if (this.ghostLayer.children.length) { this.ghostLayer.visible = !hideUnits; for (const c of this.ghostLayer.children) c.scale.set(inv * 1.5 * this.tokenScale); }
    const wx = this.world.x, wy = this.world.y, sw = this.app.screen.width, sh = this.app.screen.height, M = 140;

    for (const v of this.views.values()) {
      if (v.dying) {
        anim = true;
        v.root.alpha = Math.max(0, v.root.alpha - dt / 220);
        v.root.scale.set(v.root.scale.x * (1 + dt / 400));
        if (v.root.alpha <= 0) {
          v.root.parent?.removeChild(v.root); v.root.destroy({ children: true }); this.views.delete(v.id);
        }
        continue;
      }
      if (!v.dragging && (v.x !== v.tx || v.y !== v.ty)) {
        v.x += (v.tx - v.x) * k; v.y += (v.ty - v.y) * k;
        if (Math.abs(v.tx - v.x) < 0.02) v.x = v.tx;
        if (Math.abs(v.ty - v.y) < 0.02) v.y = v.ty;
        anim = true;
      }
      v.root.position.set(v.x, v.y);
      const sel = this.selected.has(v.id);
      if (v.marker.type !== 'scenery') {
        const sx = wx + v.x * s, sy = wy + v.y * s;
        const onScreen = sx > -M && sy > -M && sx < sw + M && sy < sh + M;
        const show = v.dragging || (onScreen && v.riding !== 'aboard' && !(hideUnits && v.marker.type === 'unit' && !sel));
        if (v.root.visible !== show) v.root.visible = show;
        if (!show) continue;                                 // no animation, no label work for what is not drawn
        if (v._bodyPending) { v._bodyPending = false; v._buildBody(); }
      }
      v.root.zIndex = v.y + (v.dragging ? 1e6 : 0) + (sel ? 5e5 : 0);

      // spawn pop
      if (v.spawn < 1) { v.spawn = Math.min(1, v.spawn + dt / 380); anim = true; }
      const pop = v.spawn < 1 ? 1 + 0.9 * (1 - easeOutCubic(v.spawn)) : 1;
      if (v.fire) anim = true;

      if (v.marker.type === 'scenery') {
        // Scenery lives in map space: it scales with zoom, can rotate, and does not bob.
        const d = v.marker.data || {};
        const ws = Number(d.scale) || 1;
        const hoverS = (v.hover || v.dragging) ? 1.04 : 1;
        if (ease(v, pop * hoverS, dt)) anim = true;
        v.root.scale.set(ws * v.curS * (d.flip ? -1 : 1), ws * v.curS);
        v.root.rotation = (Number(d.rotation) || 0) * Math.PI / 180;
        v.root.alpha = Math.min(1, v.spawn * 2.5);
        v.body.position.set(0, 0);
        v.label.visible = (sel || v.hover) && !!v.marker.name;
        v.label.scale.set(1 / (ws * this.scale * v.curS) * (d.flip ? -1 : 1), 1 / (ws * this.scale * v.curS));
        v.ring.visible = sel || v.hover;
        if (v.ring.visible) v.ring.alpha = sel ? 0.65 + 0.35 * Math.sin(t * 5) : 0.45;
        if (sel) anim = true;
        continue;
      }

      // Aircraft float, ships ride a swell; ground units and everything else sit still. Shake when hit.
      let bob = 0, sx = 0, rot = 0;
      if (v.unitCat === 'Air') { bob = Math.sin(t * 1.6 + v.phase) * 2.6; anim = true; }
      else if (v.unitCat === 'Naval') { bob = Math.sin(t * 1.3 + v.phase) * 1.2; rot = Math.sin(t * 1.1 + v.phase) * 0.035; anim = true; }
      if (v.shakeUntil && nowMs < v.shakeUntil) { sx = Math.sin(nowMs / 18) * v.shakeAmp; anim = true; }
      v.body.position.set(sx, bob);
      v.body.rotation = rot;

      const hoverS = (v.hover || v.dragging) ? 1.18 : 1;
      if (ease(v, pop * hoverS, dt)) anim = true;
      // Token scale (world units per token pixel). 'map' mode: tokens are map objects about 60 map px wide,
      // so they shrink as you zoom out, clamped so they never vanish or become giants.
      let rs;
      if (this.tokenMode === 'screen') {
        rs = inv * v.curS * this.tokenScale * TOKEN_BASE;
        v.label.visible = true;
        v.label.scale.set(1);
      } else {
        // Tokens are about 27 map px wide at normal size (0.45 × the 60 px art), clamped to 9–59 screen px.
        const f = Math.max(0.2 * TOKEN_BASE, Math.min(1.3 * TOKEN_BASE, this.tokenScale * s * 0.6 * TOKEN_BASE));   // screen px per token px
        rs = f * inv * v.curS;
        // Labels keep a constant on-screen size and only show once tokens are big enough to read.
        v.label.visible = sel || v.hover || f >= 0.4;
        v.label.scale.set(1 / (f * v.curS));
      }
      v.root.scale.set(rs);
      v.root.alpha = Math.min(1, v.spawn * 2.5) * (v.dim ?? 1);
      // Heroes: a band of light runs round the golden ring and the glow breathes.
      if (v.sheen && !v.sheen.destroyed) {
        const [ex, ey] = v.sheenR, a0 = t * 1.7 + v.phase, g = v.sheen;
        g.clear();
        for (let i = 0; i <= 12; i++) { const a = a0 + 1.15 * i / 12, px = Math.cos(a) * ex, py = Math.sin(a) * ey; if (i) g.lineTo(px, py); else g.moveTo(px, py); }
        g.stroke({ width: 2.2, color: 0xfff6c8, alpha: 0.95, cap: 'round' });
        if (v.heroGlow) v.heroGlow.alpha = 0.65 + 0.35 * Math.sin(t * 2.2 + v.phase);
        anim = true;
      }

      v.ring.visible = sel || v.hover;
      if (v.ring.visible) v.ring.alpha = sel ? 0.65 + 0.35 * Math.sin(t * 5) : 0.45;
      if (sel) anim = true;
      if (v.capRing && v.capRing.visible) { v.capRing.alpha = 0.55 + 0.45 * Math.sin(t * 3 + v.phase); v.capRing.scale.set(1 + 0.06 * Math.sin(t * 3 + v.phase)); anim = true; }
    }
    this._declutterLabels();
    this._drawUnitDots(hideUnits);

    for (const layer of [this.fxLayer, this.boomLayer]) {
      for (const fx of [...layer.children]) {
        fx.life -= dt;
        if (fx.splashInfo) { this._drawSplash(fx, nowMs); if (fx.life <= 0) { layer.removeChild(fx); fx.destroy(); } continue; }
        if (fx.floater) { this._tickFloater(fx, inv); if (fx.life <= 0) { layer.removeChild(fx); fx.destroy({ children: true }); } continue; }
        if (fx.screenSize) { fx.scale.set(fx.screenSize / (fx.frameSize || this.explosionFrameSize) * inv); }
        else if (fx.pulse) { const p = 1 - fx.life / 700; fx.scale.set((1 + p * 3) * inv); fx.alpha = 1 - p; }
        else if (fx.flash) { fx.scale.set(inv); fx.alpha = Math.max(0, fx.life / 220); }
        else fx.alpha = Math.min(1, fx.life / 900);
        if (fx.life <= 0) { layer.removeChild(fx); fx.destroy(); }
      }
    }

    this._animating = anim;
    this.dispatchEvent(new CustomEvent('frame'));
  }

  /** Render a unit counter for a type name and colour to a data URL (for the symbol key). */
  async counterImage(unitType, color = '#3498db', strength = 100) {
    const fake = { id: -1, type: 'unit', name: 'x', color, data: { unitType, strength }, x: 0, y: 0 };
    const view = Object.create(MarkerView.prototype);
    view.r = this; view.marker = fake; view.colorNum = parseInt(color.slice(1), 16) || 0x3498db;
    const sprite = view._procBody(fake);
    const url = await this.app.renderer.extract.base64({ target: sprite, resolution: 3 });
    sprite.destroy();
    return url;
  }

  // ---- Procedural textures ----------------------------------------------------------
  _texture(key, build) {
    let tex = this._textures.get(key);
    if (!tex) {
      const c = build();
      tex = this.app.renderer.generateTexture({ target: c, resolution: 3, antialias: true });
      c.destroy({ children: true });
      this._textures.set(key, tex);
    }
    return tex;
  }
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}
function multiBbox(multi) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of multi || []) for (const ring of poly) for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInMulti(x, y, multi) {
  for (const poly of multi || []) {
    if (!poly.length || !pointInRing(x, y, poly[0])) continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++) if (pointInRing(x, y, poly[i])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}
function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (!a) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Ease a view's scale towards target; returns true while still moving (snaps when close). */
function ease(v, target, dt) {
  if (Math.abs(target - v.curS) < 0.003) { v.curS = target; return false; }
  v.curS += (target - v.curS) * Math.min(1, dt / 70);
  return true;
}

function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
/** Append a five-pointed star (outer radius r, inner ri) centred on (cx, cy) to a Graphics path. */
function starPath(g, cx, cy, r, ri) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? ri : r;
    pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  g.poly(pts);
}

/** Closest point on a shape's outline to (x,y): { index of segment start, x, y, dist }. */
function nearestSegment(shape, x, y) {
  const pts = shape.points || [];
  const n = pts.length;
  if (n < 2) return null;
  const segs = shape.kind === 'area' ? n : n - 1;
  let best = null;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + t * dx, py = a[1] + t * dy;
    const dist = Math.hypot(x - px, y - py);
    if (!best || dist < best.dist) best = { index: i, x: px, y: py, dist };
  }
  return best;
}

/** Label anchor for a shape: middle vertex of a line, centroid of an area. */
function shapeAnchor(s) {
  const pts = s.points || [];
  if (!pts.length) return [0, 0];
  if (s.kind === 'area') {
    let x = 0, y = 0;
    for (const p of pts) { x += p[0]; y += p[1]; }
    return [x / pts.length, y / pts.length];
  }
  const mid = pts[Math.floor((pts.length - 1) / 2)];
  const next = pts[Math.min(pts.length - 1, Math.floor((pts.length - 1) / 2) + 1)];
  return [(mid[0] + next[0]) / 2, (mid[1] + next[1]) / 2 - 10];
}

/** Unit icons show above this zoom on the Earth map (1 = 100 %); below it each unit is a dot. */
const UNIT_ICON_MIN_SCALE = 1;
/** Base size of unit, town and player tokens relative to the original art scale (reduced 25 % on 29 Sep 2026). */
const TOKEN_BASE = 0.75;

const LABEL_STYLE = {
  fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 13, fontWeight: '600', fill: 0xffffff,
  stroke: { color: 0x000000, width: 3 }, align: 'center',
};

/** Text fallback for unit types the catalogue cannot resolve: a short abbreviation. */
function unitGlyph(unitType) {
  const parts = String(unitType || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return parts.length === 1 ? parts[0].slice(0, 3).toUpperCase() : parts.map(p => p[0]).join('').slice(0, 3).toUpperCase();
}

/** One marker's display object tree. */
class MarkerView {
  constructor(renderer, marker) {
    this.r = renderer;
    this.id = marker.id;
    this.marker = marker;
    this.root = new PIXI.Container();
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
    this.shadow = new PIXI.Graphics();
    this.ring = new PIXI.Graphics();
    this.ring.visible = false;
    this.body = new PIXI.Container();
    this.label = new PIXI.Text({ text: '', style: LABEL_STYLE, resolution: 2 });
    this.label.anchor.set(0.5, 0);
    this.root.addChild(this.shadow, this.ring, this.body, this.label);
    this.x = marker.x; this.y = marker.y; this.tx = marker.x; this.ty = marker.y;
    this.root.position.set(marker.x, marker.y);
    this.hover = false; this.dragging = false; this.dying = false;
    this.spawn = 0; this.curS = 1.9; this.phase = Math.random() * Math.PI * 2;
    this.shakeUntil = 0; this.shakeAmp = 0;
    this.flag = null; this.unitCat = '';
    this.w = 30; this.h = 30; this._gen = 0;

    this.root.on('pointerdown', e => this.r._startMarkerPointer(this, e));
    this.root.on('pointerover', () => { this.hover = true; this.r.invalidate(); });
    this.root.on('pointerout', () => { this.hover = false; this.r.invalidate(); });
    this.update(marker);
  }

  setImmediate(x, y) { this.x = x; this.y = y; this.tx = x; this.ty = y; this.r.invalidate(); }

  update(marker) {
    const prev = this.marker;
    this.marker = marker;
    this.r.invalidate();
    this.colorNum = parseInt(String(marker.color || '#3498db').slice(1), 16) || 0x3498db;
    if (!this.dragging) { this.tx = marker.x; this.ty = marker.y; }
    this.label.text = marker.type === 'hero' && marker.data?.status === 'travelling' ? `${marker.name} (en route)` : marker.name;
    this.unitCat = (marker.type === 'unit' && window.UnitTypes) ? (window.UnitTypes.resolve(marker.data?.unitType)?.cat || '') : '';
    this.root.eventMode = marker.locked ? 'none' : 'static';   // locked tokens let clicks and drags pass through
    const visualKey = [marker.type, marker.color, marker.iconUrl, marker.data?.unitType, marker.data?.size,
      marker.data?.strength, marker.adminOnly, JSON.stringify(marker.visibleTo), marker.name[0], marker.flagUrl, marker.data?.industry,
      marker.data?.role, marker.data?.stars, marker.name].join('|');
    this.dim = marker.type === 'hero' ? ({ travelling: 0.55, captured: 0.4 }[marker.data?.status] || 1) : 1;
    if (visualKey !== this._visualKey) {
      this._visualKey = visualKey;
      if (marker.type === 'unit' && this.r.unitsHidden()) this._bodyPending = true; else this._buildBody();
    }
    this._refreshMovedDot();
    if (prev && (prev.x !== marker.x || prev.y !== marker.y) && !this.dragging) {
      const d = Math.hypot(marker.x - this.x, marker.y - this.y);
      if (d > 6) this.r.trail(this.x, this.y, marker.x, marker.y, this.colorNum);
    }
    if (this.r.persistTrails && (marker.data?.trail || prev?.data?.trail)) this.r.queueTrails();
  }

  async _buildBody() {
    const m = this.marker;
    const gen = ++this._gen;
    let tex = null;
    let isSprite = false;
    if (m.iconUrl) {
      try {
        if (window.SpriteAtlas && window.SpriteAtlas.isRef(m.iconUrl)) { tex = await window.SpriteAtlas.texture(m.iconUrl); isSprite = true; }
        else tex = await PIXI.Assets.load({ src: m.iconUrl, loadParser: 'loadTextures' });
      } catch { tex = null; }
    }
    // Resource nodes and factories use the bundled painted icons unless the GM picked something else.
    if (!tex && (m.type === 'resource' || m.type === 'factory') && window.GameData) {
      const url = m.type === 'resource' ? window.GameData.iconUrl(m.data?.kind) : '/icons/' + window.GameData.FACTORY_ICON;
      if (url) { try { tex = await PIXI.Assets.load({ src: url, loadParser: 'loadTextures' }); } catch { tex = null; } }
      isSprite = false;
    }
    if (gen !== this._gen || this.root.destroyed) return;
    for (const c of this.body.removeChildren()) c.destroy({ children: true });
    this.sheen = null; this.heroGlow = null;
    let built;
    if (m.type === 'hero') built = this._heroBody(tex, m);
    else if (m.type === 'scenery') built = this._sceneryBody(tex, m);
    else if ((m.type === 'resource' || m.type === 'factory') && tex) built = this._nodeBody(tex, m);
    else if (tex && isSprite) built = this._spriteBody(tex, m);
    else built = tex ? this._iconBody(tex, m) : this._procBody(m);
    this.body.addChild(built);
    this._layout();
    this.refreshFire();
    this._buildFlag(gen);
    this.r.invalidate();
  }

  /**
   * Hero: a 2:3 portrait (the marker's icon, or initials and the role's emblem) in an oval golden ring, the star
   * rating beneath and a role badge. The tick animates a band of light round the ring.
   */
  _heroBody(tex, m) {
    const c = new PIXI.Container();
    const d = m.data || {};
    const role = (window.Heroes && window.Heroes.ROLES[d.role]) || { glyph: '★', label: 'Hero' };
    const W = 34, H = 51, R = 3.6, rx = W / 2, ry = H / 2;
    const glow = new PIXI.Graphics().ellipse(0, 0, rx + R + 3.5, ry + R + 3.5).fill({ color: 0xf5d76e, alpha: 0.22 });
    const ring = new PIXI.Graphics()
      .ellipse(0, 0, rx + R, ry + R).fill(0x6e4f0e)
      .ellipse(0, 0, rx + R - 1.1, ry + R - 1.1).fill(0xd4af37)
      .ellipse(0, 0, rx + 0.7, ry + 0.7).fill(0x5c4310)
      .ellipse(0, 0, rx, ry).fill(0x18212b);
    c.addChild(glow, ring);
    if (tex) {
      const sp = new PIXI.Sprite(tex);
      sp.anchor.set(0.5);
      sp.scale.set(Math.max(W / tex.width, H / tex.height));     // cover the oval, cropping the longer side
      const mask = new PIXI.Graphics().ellipse(0, 0, rx, ry).fill(0xffffff);
      c.addChild(mask, sp);
      sp.mask = mask;
    } else {
      const initials = String(m.name || '?').split(/\s+/).filter(Boolean).map(s => s[0]).slice(0, 2).join('').toUpperCase();
      const t = new PIXI.Text({ text: initials, style: { fontFamily: 'Georgia, serif', fontSize: 15, fontWeight: '700', fill: 0xf5e6b8 }, resolution: 3 });
      t.anchor.set(0.5); t.y = -4;
      const e = new PIXI.Text({ text: role.glyph, style: { fontFamily: 'Segoe UI Symbol, Segoe UI Emoji, sans-serif', fontSize: 12, fill: 0xd4af37 }, resolution: 3 });
      e.anchor.set(0.5); e.y = 13;
      c.addChild(t, e);
    }
    const sheen = new PIXI.Graphics();
    c.addChild(sheen);
    this.sheen = sheen; this.heroGlow = glow; this.sheenR = [rx + R / 2 + 0.2, ry + R / 2 + 0.2];
    const n = window.Heroes ? window.Heroes.stars(d.stars) : 1;
    const st = new PIXI.Graphics(), sy = ry + R + 6.5, gap = 7.6;
    for (let i = 0; i < n; i++) starPath(st, (i - (n - 1) / 2) * gap, sy, 3.6, 1.55);
    st.fill(0xf5d76e).stroke({ width: 0.8, color: 0x5c4310 });
    const bx = rx + 1.5, by = -ry + 4;
    const badge = new PIXI.Graphics().circle(bx, by, 6.8).fill(0x18212b).stroke({ width: 1.4, color: 0xd4af37 });
    const bt = new PIXI.Text({ text: role.glyph, style: { fontFamily: 'Segoe UI Symbol, Segoe UI Emoji, sans-serif', fontSize: 8, fill: 0xf5d76e }, resolution: 3 });
    bt.anchor.set(0.5); bt.position.set(bx, by + 0.3);
    c.addChild(st, badge, bt);
    this.w = W + 2 * R + 2; this.h = H + 2 * R + 12;
    return c;
  }

  /** Scenery: the raw sprite (or a placeholder box) at native pixel size; the tick scales it with the map. */
  _sceneryBody(tex, m) {
    const c = new PIXI.Container();
    if (tex) {
      const sp = new PIXI.Sprite(tex); sp.anchor.set(0.5);
      c.addChild(sp);
      this.w = tex.width; this.h = tex.height;
    } else {
      const g = new PIXI.Graphics().rect(-24, -24, 48, 48).fill({ color: this.colorNum, alpha: 0.5 }).stroke({ width: 2, color: 0xffffff });
      c.addChild(g);
      this.w = this.h = 48;
    }
    return c;
  }

  /** Resource node or factory: the painted icon on a dark disc with a ring in the owner's colour; factories show their level. */
  _nodeBody(tex, m) {
    const c = new PIXI.Container();
    const R = 15, inner = 22;
    const g = new PIXI.Graphics();
    g.circle(0, 0, R).fill({ color: 0x14202b, alpha: 0.88 }).stroke({ width: 2.5, color: this.colorNum });
    c.addChild(g);
    const sp = new PIXI.Sprite(tex); sp.anchor.set(0.5);
    const k = inner / Math.max(tex.width, tex.height);
    sp.scale.set(k);
    c.addChild(sp);
    if (m.type === 'factory') {
      const lvl = Math.max(1, Math.min(5, Number(m.data?.industry) || 1));
      const badge = new PIXI.Graphics().circle(R - 3, R - 4, 6).fill(this.colorNum).stroke({ width: 1.2, color: 0xffffff });
      const t = new PIXI.Text({ text: String(lvl), style: { fontFamily: 'Segoe UI, Arial', fontSize: 8, fontWeight: '800', fill: 0xffffff }, resolution: 3 });
      t.anchor.set(0.5); t.position.set(R - 3, R - 4);
      c.addChild(badge, t);
    }
    this.w = this.h = R * 2 + 2;
    return c;
  }

  /** Pixel-art sprite from the atlas, shown as-is (no plate); units get a thin strength bar beneath. */
  _spriteBody(tex, m) {
    const c = new PIXI.Container();
    const box = m.type === 'unit' ? [60, 44] : (m.type === 'player' ? [44, 44] : [52, 44]);
    const sc = Math.min(box[0] / tex.width, box[1] / tex.height, 2.5);
    const sw = tex.width * sc, sh = tex.height * sc;
    const sp = new PIXI.Sprite(tex); sp.anchor.set(0.5); sp.scale.set(sc);
    c.addChild(sp);
    this.w = sw; this.h = sh;
    if (m.type === 'unit') {
      const st = Math.max(0, Math.min(100, Number(m.data?.strength ?? 100)));
      const bw = Math.max(26, Math.min(sw, 60));
      const bar = new PIXI.Graphics().rect(-bw / 2, sh / 2 + 2, bw, 3).fill({ color: 0, alpha: 0.55 });
      if (st > 0) bar.rect(-bw / 2, sh / 2 + 2, bw * st / 100, 3).fill(st > 60 ? 0x2ecc71 : st > 30 ? 0xf1c40f : 0xe74c3c);
      c.addChild(bar);
      this.h = sh + 6;
      if (st <= 0) { sp.alpha = 0.6; sp.tint = 0x777777; }
    }
    return c;
  }

  /** Small faction flag above the token (any type except scenery). */
  async _buildFlag(gen) {
    if (this.flag) { this.root.removeChild(this.flag); this.flag.destroy({ children: true }); this.flag = null; }
    const url = this.marker.flagUrl;
    if (!url || this.marker.type === 'scenery') return;
    let tex;
    try { tex = await PIXI.Assets.load({ src: url, loadParser: 'loadTextures' }); } catch { return; }
    if (gen !== this._gen || this.root.destroyed) return;
    const fh = 13, fw = Math.max(10, Math.min(26, fh * tex.width / tex.height));
    const top = -this.h / 2 - 4;
    const cont = new PIXI.Container();
    cont.addChild(new PIXI.Graphics().rect(-fw / 2 - 1, top - fh - 1, fw + 2, fh + 2).fill({ color: 0x000000, alpha: 0.55 }));
    const sp = new PIXI.Sprite(tex); sp.anchor.set(0.5, 1); sp.width = fw; sp.height = fh; sp.position.set(0, top);
    cont.addChild(sp);
    cont.eventMode = 'none';
    this.flag = cont;
    this.root.addChild(cont);
    this.r.invalidate();
  }

  /** Game mode: a small dot on units that have moved this turn (amber) or used all their movement (red). */
  _refreshMovedDot() {
    const rules = this.r.gameRules, m = this.marker;
    this._refreshCaptured(rules);
    this._refreshSupply(rules);
    const moved = rules && rules.enabled && m.type === 'unit' ? Number(m.data?.movedKm) || 0 : 0;
    if (!moved) { if (this.movedDot) { this.movedDot.visible = false; } return; }
    if (!this.movedDot) { this.movedDot = new PIXI.Graphics(); this.movedDot.eventMode = 'none'; this.root.addChild(this.movedDot); }
    const allowance = (Number(m.data?.movement) || 0) * (rules.kmPerMove || 1);
    const spent = moved >= allowance - 0.01;
    this.movedDot.clear().circle(this.w / 2 - 1, -this.h / 2 + 3, 4).fill(spent ? 0xe74c3c : 0xf1c40f).stroke({ width: 1.2, color: 0x1e2b1a });
    this.movedDot.visible = true;
  }

  /** Game mode: a land unit cut off from supply carries a red no-entry badge and is dimmed a little. */
  _refreshSupply(rules) {
    const m = this.marker;
    const cut = !!(rules && rules.enabled && rules.supply && m.type === 'unit' && m.data?.supplied === false);
    if (this.body) this.body.alpha = cut ? 0.72 : 1;
    if (!cut) { if (this.supplyBadge) this.supplyBadge.visible = false; return; }
    if (!this.supplyBadge) { this.supplyBadge = new PIXI.Graphics(); this.supplyBadge.eventMode = 'none'; this.root.addChild(this.supplyBadge); }
    const x = -this.w / 2 + 2, y = -this.h / 2 + 3;
    this.supplyBadge.clear().circle(x, y, 5.5).fill(0xc0392b).stroke({ width: 1.3, color: 0x1e1e1e })
      .rect(x - 3.2, y - 1, 6.4, 2).fill(0xffffff);
    this.supplyBadge.visible = true;
    this.r.invalidate();
  }

  /** Game mode: a place that changed hands this turn pulses a ring in its new owner's colour until the turn ends. */
  _refreshCaptured(rules) {
    const m = this.marker;
    const flash = rules && rules.enabled && ['town', 'resource', 'factory'].includes(m.type) && Number(m.data?.capturedTurn) === rules.turn;
    if (!flash) { if (this.capRing) { this.capRing.visible = false; } return; }
    if (!this.capRing) { this.capRing = new PIXI.Graphics(); this.capRing.eventMode = 'none'; this.root.addChildAt(this.capRing, 0); }
    const rr = Math.max(this.w, this.h) / 2 + 5;
    this.capRing.clear().circle(0, 0, rr).stroke({ width: 3, color: this.colorNum, alpha: 0.9 }).circle(0, 0, rr + 5).stroke({ width: 1.5, color: 0xffffff, alpha: 0.5 });
    this.capRing.visible = true;
    this.r.invalidate();
  }

  /** A unit at zero strength burns (looping sprite) until it is removed or its strength is restored. */
  refreshFire() {
    this.r.invalidate();
    const m = this.marker;
    const wrecked = m.type === 'unit' && Number(m.data?.strength ?? 100) <= 0;
    // A unit that surrendered for want of supply flies a white flag instead of burning.
    const surrendered = wrecked && m.data?.surrendered === true;
    if (surrendered) {
      if (this.fire) { this.root.removeChild(this.fire); this.fire.destroy(); this.fire = null; }
      if (!this.whiteFlag) {
        const g = new PIXI.Graphics();
        g.eventMode = 'none';
        // Pole, then a white flag with a ragged, wind-caught fly.
        g.moveTo(0, 0).lineTo(0, -34).stroke({ width: 2.4, color: 0x6e4b2a });
        g.circle(0, -35, 1.8).fill(0x8a6a44);
        g.poly([1, -33, 9, -35, 17, -32, 24, -34, 22, -27, 25, -21, 17, -23, 9, -20, 1, -22]).fill({ color: 0xffffff, alpha: 0.97 }).stroke({ width: 1, color: 0x9a9a9a, alpha: 0.9 });
        g.moveTo(8, -31).lineTo(14, -24).stroke({ width: 0.8, color: 0xd0d0d0, alpha: 0.9 });
        g.position.set(this.w / 2 - 6, -this.h / 2 + 4);
        this.whiteFlag = g;
        this.root.addChild(g);
      }
      return;
    }
    if (this.whiteFlag) { this.root.removeChild(this.whiteFlag); this.whiteFlag.destroy(); this.whiteFlag = null; }
    if (!wrecked || !this.r.burningFrames) {
      if (this.fire) { this.root.removeChild(this.fire); this.fire.destroy(); this.fire = null; }
      return;
    }
    if (this.fire) return;
    const sp = new PIXI.AnimatedSprite(this.r.burningFrames);
    sp.anchor.set(0.5, 0.88);                 // flames rise from the counter
    sp.position.set(0, -this.h / 2 + 10);
    sp.scale.set(84 / this.r.burningFrameSize);
    sp.animationSpeed = 0.35;
    sp.loop = true;
    sp.alpha = 0.95;
    sp.eventMode = 'none';
    sp.gotoAndPlay(Math.floor(Math.random() * this.r.burningFrames.length));
    this.fire = sp;
    this.root.addChild(sp);
  }

  _layout() {
    const { w, h } = this;
    this.label.y = h / 2 + 3;
    this._refreshMovedDot();
    if (this.marker.type === 'scenery') {
      this.shadow.clear();
      this.ring.clear().rect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6).stroke({ width: 2, color: 0xf1c40f });
      this.root.hitArea = new PIXI.Rectangle(-w / 2, -h / 2, w, h);
      return;
    }
    this.shadow.clear().ellipse(0, h / 2 + 1, w * 0.45, 4).fill({ color: 0x000000, alpha: 0.35 });
    const rr = Math.max(w, h) / 2 + 7;
    this.ring.clear().circle(0, 0, rr).stroke({ width: 3, color: 0xf1c40f });
    if (this.marker.adminOnly) {
      this.ring.circle(0, 0, rr + 4).stroke({ width: 1, color: 0xe67e22, alpha: 0.8 });
    } else if (this.marker.visibleTo && this.marker.visibleTo.length) {
      this.ring.circle(0, 0, rr + 4).stroke({ width: 1, color: 0x5dade2, alpha: 0.8 });
    }
    this.root.hitArea = new PIXI.Rectangle(-w / 2 - 4, -h / 2 - 4, w + 8, h + 8 + 16);
  }

  _iconBody(tex, m) {
    const c = new PIXI.Container();
    const box = m.type === 'unit' ? 40 : (m.type === 'player' ? 38 : 32);
    const sp = new PIXI.Sprite(tex);
    sp.anchor.set(0.5);
    const sc = Math.min(box / tex.width, box / tex.height);
    sp.scale.set(sc);
    if (m.type === 'player' || m.type === 'town') {
      const r = box / 2;
      const mask = new PIXI.Graphics().circle(0, 0, r).fill(0xffffff);
      sp.mask = mask;
      const frame = new PIXI.Graphics().circle(0, 0, r).stroke({ width: 3, color: this.colorNum });
      c.addChild(mask, sp, frame);
      this.w = this.h = box + 4;
    } else {
      c.addChild(sp);
      this.w = tex.width * sc; this.h = tex.height * sc;
    }
    return c;
  }

  _procBody(m) {
    const d = m.data || {};
    const color = this.colorNum;
    if (m.type === 'unit') {
      // NATO-style counter: nation-colored box with a symbol and a strength bar.
      const W = 44, H = 30;
      this.w = W; this.h = H + 4;
      const utype = window.UnitTypes ? window.UnitTypes.resolve(d.unitType) : null;
      const key = `unit|${color}|${utype ? utype.id : 'txt:' + unitGlyph(d.unitType)}|${Math.round((d.strength ?? 100) / 10)}`;
      const tex = this.r._texture(key, () => {
        const c = new PIXI.Container();
        const g = new PIXI.Graphics();
        g.roundRect(-W / 2, -H / 2, W, H, 4).fill(color).stroke({ width: 2, color: 0xffffff });
        const box = { x: -W / 2 + 6, y: -H / 2 + 5, w: W - 12, h: H - 12 };
        g.roundRect(box.x, box.y, box.w, box.h, 2).stroke({ width: 1.5, color: 0xffffff, alpha: 0.9 });
        if (utype) {
          window.UnitTypes.draw(g, c, utype, box);
        } else {
          const glyph = unitGlyph(d.unitType);
          if (glyph) {
            const t = new PIXI.Text({ text: glyph, style: { fontFamily: 'Segoe UI, Arial', fontSize: 11, fontWeight: '700', fill: 0xffffff }, resolution: 3 });
            t.anchor.set(0.5); t.position.set(0, -1);
            c.addChild(t);
          }
        }
        const st = Math.max(0, Math.min(100, Number(d.strength ?? 100)));
        g.rect(-W / 2 + 4, H / 2 - 5, W - 8, 3).fill({ color: 0x000000, alpha: 0.45 });
        const barColor = st > 60 ? 0x2ecc71 : (st > 30 ? 0xf1c40f : 0xe74c3c);
        if (st > 0) g.rect(-W / 2 + 4, H / 2 - 5, (W - 8) * st / 100, 3).fill(barColor);
        c.addChildAt(g, 0);
        return c;
      });
      const sp = new PIXI.Sprite(tex); sp.anchor.set(0.5);
      if ((d.strength ?? 100) <= 0) { sp.alpha = 0.6; sp.tint = 0x777777; }
      return sp;
    }
    if (m.type === 'town') {
      const size = d.size || 'village';
      const R = size === 'capital' ? 15 : (size === 'city' ? 13 : 11);
      this.w = this.h = R * 2 + 2;
      const tex = this.r._texture(`town|${color}|${size}`, () => {
        const g = new PIXI.Graphics();
        g.circle(0, 0, R).fill(color).stroke({ width: 2.5, color: 0xffffff });
        if (size === 'capital') {
          const pts = [];
          for (let i = 0; i < 10; i++) {
            const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? R * 0.35 : R * 0.72;
            pts.push(Math.cos(a) * rr, Math.sin(a) * rr);
          }
          g.poly(pts).fill(0xffffff);
        } else if (size === 'city') {
          g.circle(0, 0, R * 0.5).fill(0xffffff);
          g.circle(0, 0, R * 0.22).fill(color);
        } else {
          g.circle(0, 0, R * 0.32).fill(0xffffff);
        }
        return g;
      });
      const sp = new PIXI.Sprite(tex); sp.anchor.set(0.5);
      return sp;
    }
    if (m.type === 'poi') {
      const R = 13;
      this.w = this.h = R * 2 + 2;
      const tex = this.r._texture(`poi|${color}`, () => {
        const c = new PIXI.Container();
        const g = new PIXI.Graphics();
        g.poly([0, -R, R, 0, 0, R, -R, 0]).fill(color).stroke({ width: 2.5, color: 0xffffff });
        const t = new PIXI.Text({ text: '?', style: { fontFamily: 'Segoe UI, Arial', fontSize: 13, fontWeight: '800', fill: 0xffffff }, resolution: 3 });
        t.anchor.set(0.5); t.position.set(0, 0);
        c.addChild(g, t);
        return c;
      });
      const sp = new PIXI.Sprite(tex); sp.anchor.set(0.5);
      return sp;
    }
    if (m.type === 'resource') {
      // Hexagon in the resource's colour, outlined in the owner's colour, with the resource glyph.
      const R = 13;
      this.w = this.h = R * 2 + 2;
      const res = window.GameData ? window.GameData.byKey[d.kind] : null;
      const fill = res ? parseInt(res.color.slice(1), 16) : 0x888888;
      const lum = ((fill >> 16) & 255) * 0.299 + ((fill >> 8) & 255) * 0.587 + (fill & 255) * 0.114;
      const tex = this.r._texture(`res|${d.kind}|${color}`, () => {
        const c = new PIXI.Container();
        const g = new PIXI.Graphics();
        const pts = [];
        for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; pts.push(Math.cos(a) * R, Math.sin(a) * R); }
        g.poly(pts).fill(fill).stroke({ width: 2.5, color });
        const t = new PIXI.Text({ text: res ? res.glyph : '?', style: { fontFamily: 'Segoe UI, Arial', fontSize: 10, fontWeight: '800', fill: lum > 150 ? 0x1e2b1a : 0xffffff }, resolution: 3 });
        t.anchor.set(0.5); t.position.set(0, 0);
        c.addChild(g, t);
        return c;
      });
      const sp = new PIXI.Sprite(tex); sp.anchor.set(0.5);
      return sp;
    }
    if (m.type === 'factory') {
      // Sawtooth-roofed works with a chimney; the number is the industry level.
      const W = 28, H = 20;
      this.w = W + 2; this.h = H + 8;
      const lvl = Math.max(1, Math.min(5, Number(d.industry) || 1));
      const tex = this.r._texture(`factory|${color}|${lvl}`, () => {
        const c = new PIXI.Container();
        const g = new PIXI.Graphics();
        g.poly([-W / 2, H / 2, -W / 2, -2, -W / 2 + 7, -8, -W / 2 + 7, -2, -W / 2 + 14, -8, -W / 2 + 14, -2, W / 2 - 7, -8, W / 2 - 7, -2, W / 2, -2, W / 2, H / 2])
          .fill(color).stroke({ width: 2, color: 0xffffff });
        g.rect(W / 2 - 9, -H / 2 - 4, 4, 10).fill(0xffffff);   // chimney
        const t = new PIXI.Text({ text: String(lvl), style: { fontFamily: 'Segoe UI, Arial', fontSize: 9, fontWeight: '800', fill: 0xffffff }, resolution: 3 });
        t.anchor.set(0.5); t.position.set(-2, 3);
        c.addChild(g, t);
        return c;
      });
      const sp = new PIXI.Sprite(tex); sp.anchor.set(0.5);
      return sp;
    }
    // player
    const R = 18;
    this.w = this.h = R * 2 + 2;
    const initial = (m.name || '?').trim().charAt(0).toUpperCase() || '?';
    const tex = this.r._texture(`player|${color}|${initial}`, () => {
      const c = new PIXI.Container();
      const g = new PIXI.Graphics();
      g.circle(0, 0, R).fill(color).stroke({ width: 3, color: 0xffffff });
      const t = new PIXI.Text({ text: initial, style: { fontFamily: 'Segoe UI, Arial', fontSize: 17, fontWeight: '800', fill: 0xffffff }, resolution: 3 });
      t.anchor.set(0.5); t.position.set(0, 0);
      c.addChild(g, t);
      return c;
    });
    const sp = new PIXI.Sprite(tex); sp.anchor.set(0.5);
    return sp;
  }
}

window.MapRenderer = MapRenderer;
