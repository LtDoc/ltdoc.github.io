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
class MapRenderer extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.views = new Map();          // marker id -> MarkerView
    this.gameRules = null;           // { enabled, kmPerMove } when the campaign runs in game mode
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
    this.maxScale = 8;
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
    this.factionInfo = new Map();                // factionId -> { color, name }
    this.sceneryLayer = new PIXI.Container();   // buildings, trenches, craters: scale with the map
    this.sceneryLayer.sortableChildren = true;
    this.trenchLayer = new PIXI.Container();    // dug earthworks (ribbon meshes), under drawings and tokens
    this.shapesLayer = new PIXI.Container();
    this.fxLayer = new PIXI.Container();
    this.markerLayer = new PIXI.Container();
    this.markerLayer.sortableChildren = true;
    this.boomLayer = new PIXI.Container();     // explosions, above the markers
    this.overlayLayer = new PIXI.Container();
    this.handleLayer = new PIXI.Container();
    this.world.addChild(this.mapLayer, this.territoryLayer, this.gridLayer, this.sceneryLayer, this.trenchLayer, this.shapesLayer, this.fxLayer, this.markerLayer, this.boomLayer, this.overlayLayer, this.handleLayer);
    app.stage.addChild(this.world);

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
      this.invalidate();
    } catch (e) {
      console.warn('Burning sprite sheet not available', e);
    }
  }

  /** Slice the 4×4 explosion sprite sheet into animation frames (loaded in the background). */
  async _loadExplosion() {
    try {
      const tex = await PIXI.Assets.load({ src: '/assets/explosion.png', loadParser: 'loadTextures' });
      const cols = 4, rows = 4, fw = tex.width / cols, fh = tex.height / rows;
      const frames = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          frames.push(new PIXI.Texture({ source: tex.source, frame: new PIXI.Rectangle(c * fw, r * fh, fw, fh) }));
        }
      }
      this.explosionFrames = frames;
      this.explosionFrameSize = fw;
    } catch (e) {
      console.warn('Explosion sprite sheet not available; using the drawn burst instead', e);
    }
  }

  /** Play an explosion at a world position with a given on-screen size in px. */
  explode(x, y, screenSize = 72, delayMs = 0) {
    this.invalidate();
    if (!this.explosionFrames) return false;
    const sp = new PIXI.AnimatedSprite(this.explosionFrames);
    sp.anchor.set(0.5);
    sp.loop = false;
    sp.animationSpeed = 0.42;                 // ~16 frames in about 0.65 s at 60 fps
    sp.position.set(x, y + 2);
    sp.rotation = Math.random() * Math.PI * 2;
    sp.screenSize = screenSize;
    sp.life = 4000;                           // safety net; onComplete ends it
    sp.onComplete = () => { sp.life = 0; };
    sp.visible = delayMs === 0;
    sp.scale.set(screenSize / this.explosionFrameSize / this.scale);
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
    const s = Math.min(sw / w, sh / h) * 0.95;
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
    this.gameRules = rules && rules.enabled ? rules : null;
    for (const v of this.views.values()) v._refreshMovedDot();
    this.invalidate();
  }
  setTokenMode(m) { this.tokenMode = m === 'screen' ? 'screen' : 'map'; this.invalidate(); }

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
    let v = this.views.get(marker.id);
    if (v && v.dying) { v.root.parent?.removeChild(v.root); v.root.destroy({ children: true }); v = null; }
    if (!v) {
      v = new MarkerView(this, marker);
      this.views.set(marker.id, v);
      this._layerFor(marker).addChild(v.root);
    } else {
      v.update(marker);
      const layer = this._layerFor(marker);
      if (v.root.parent !== layer) { v.root.parent?.removeChild(v.root); layer.addChild(v.root); }
    }
    return v;
  }

  remove(id) {
    this.invalidate();
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
      const hw = Math.max(2, Number(v.shape.width) || 10) / 2;
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
      v.trench.update(s, sc);
      const tw = Math.max(2, Number(s.width) || 10);
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
      this.draw.points.push({ x: p.x, y: p.y });
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
    const color = this.mode === 'draw' ? (this.draw.kind === 'trench' ? 0xc9b37f : 0xf1c40f) : 0xabe67e;
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
    for (const v of this.territoryViews.values()) this._drawTerritory(v);
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
    // The Earth's own political tint would fight with territories: hide it while any exist.
    if (this.earth && this.earth.tintLayer) this.earth.tintLayer.visible = this.territoryViews.size === 0;
    this.invalidate();
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
      g.poly(poly[0].flat()).stroke({ width: 1.6 / s, color, alpha: 0.95 });
      for (let i = 1; i < poly.length; i++) g.poly(poly[i].flat()).stroke({ width: 1.6 / s, color, alpha: 0.95 });
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
  showRange(x, y, radius, exhausted) {
    if (!this._rangeG) { this._rangeG = new PIXI.Graphics(); this._rangeG.eventMode = 'none'; this.overlayLayer.addChild(this._rangeG); }
    const g = this._rangeG, s = this.scale;
    g.clear();
    const color = exhausted ? 0xe74c3c : 0x2ecc71;
    if (radius > 0) g.circle(x, y, radius).fill({ color, alpha: 0.08 }).stroke({ width: 2 / s, color, alpha: 0.9 });
    else g.circle(x, y, 10 / s).stroke({ width: 2 / s, color, alpha: 0.9 });
    g.visible = true;
    this.invalidate();
  }
  hideRange() { if (this._rangeG) { this._rangeG.visible = false; this.invalidate(); } }

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
        if (this.mode === 'draw' && this.draw.kind === 'trench') this.draw.freehand = true;
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
          this.select(null);
          this.dispatchEvent(new CustomEvent('mapclick', { detail: { x: p.x, y: p.y } }));
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
    if (e.button !== 0) return;
    if (this.mode && this.mode !== 'select') { this._modeClick(e); e.stopPropagation(); return; }
    e.stopPropagation();
    if (e.shiftKey) { if (this.canDrag(view.marker)) this.toggleSelect(view.id); return; }
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
        rs = inv * v.curS * this.tokenScale;
        v.label.visible = true;
        v.label.scale.set(1);
      } else {
        // Tokens are about 36 map px wide at normal size (0.6 × the 60 px art), clamped to 12–78 screen px.
        const f = Math.max(0.2, Math.min(1.3, this.tokenScale * s * 0.6));   // screen px per token px
        rs = f * inv * v.curS;
        // Labels keep a constant on-screen size and only show once tokens are big enough to read.
        v.label.visible = sel || v.hover || f >= 0.4;
        v.label.scale.set(1 / (f * v.curS));
      }
      v.root.scale.set(rs);
      v.root.alpha = Math.min(1, v.spawn * 2.5);

      v.ring.visible = sel || v.hover;
      if (v.ring.visible) v.ring.alpha = sel ? 0.65 + 0.35 * Math.sin(t * 5) : 0.45;
      if (sel) anim = true;
    }

    for (const layer of [this.fxLayer, this.boomLayer]) {
      for (const fx of [...layer.children]) {
        fx.life -= dt;
        if (fx.screenSize) { fx.scale.set(fx.screenSize / this.explosionFrameSize * inv); }
        else if (fx.pulse) { const p = 1 - fx.life / 700; fx.scale.set((1 + p * 3) * inv); fx.alpha = 1 - p; }
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
    this.label.text = marker.name;
    this.unitCat = (marker.type === 'unit' && window.UnitTypes) ? (window.UnitTypes.resolve(marker.data?.unitType)?.cat || '') : '';
    this.root.eventMode = marker.locked ? 'none' : 'static';   // locked tokens let clicks and drags pass through
    const visualKey = [marker.type, marker.color, marker.iconUrl, marker.data?.unitType, marker.data?.size,
      marker.data?.strength, marker.adminOnly, JSON.stringify(marker.visibleTo), marker.name[0], marker.flagUrl].join('|');
    if (visualKey !== this._visualKey) { this._visualKey = visualKey; this._buildBody(); }
    this._refreshMovedDot();
    if (prev && (prev.x !== marker.x || prev.y !== marker.y) && !this.dragging) {
      const d = Math.hypot(marker.x - this.x, marker.y - this.y);
      if (d > 6) this.r.trail(this.x, this.y, marker.x, marker.y, this.colorNum);
    }
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
    let built;
    if (m.type === 'scenery') built = this._sceneryBody(tex, m);
    else if ((m.type === 'resource' || m.type === 'factory') && tex) built = this._nodeBody(tex, m);
    else if (tex && isSprite) built = this._spriteBody(tex, m);
    else built = tex ? this._iconBody(tex, m) : this._procBody(m);
    this.body.addChild(built);
    this._layout();
    this.refreshFire();
    this._buildFlag(gen);
    this.r.invalidate();
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
    const moved = rules && rules.enabled && m.type === 'unit' ? Number(m.data?.movedKm) || 0 : 0;
    if (!moved) { if (this.movedDot) { this.movedDot.visible = false; } return; }
    if (!this.movedDot) { this.movedDot = new PIXI.Graphics(); this.movedDot.eventMode = 'none'; this.root.addChild(this.movedDot); }
    const allowance = (Number(m.data?.movement) || 0) * (rules.kmPerMove || 1);
    const spent = moved >= allowance - 0.01;
    this.movedDot.clear().circle(this.w / 2 - 1, -this.h / 2 + 3, 4).fill(spent ? 0xe74c3c : 0xf1c40f).stroke({ width: 1.2, color: 0x1e2b1a });
    this.movedDot.visible = true;
  }

  /** A unit at zero strength burns (looping sprite) until it is removed or its strength is restored. */
  refreshFire() {
    this.r.invalidate();
    const m = this.marker;
    const wrecked = m.type === 'unit' && Number(m.data?.strength ?? 100) <= 0;
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
