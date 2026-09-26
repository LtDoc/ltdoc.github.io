'use strict';
/* global PIXI */

/**
 * Sprite atlas: irregular pixel-art sheets cut into sprites by scripts/extract-sprites.js.
 * A sprite reference is the string "sprite:<sheetId>:<n>"; it can be used anywhere an icon URL can.
 */
const SpriteAtlas = {
  data: null, _loading: null, _sheetTex: new Map(), _frames: new Map(),
  RE: /^sprite:([a-z0-9-]+):(\d+)$/,

  load() {
    if (!this._loading) {
      this._loading = fetch('/sprites/atlas.json').then(r => r.ok ? r.json() : { sheets: [] })
        .then(d => { this.data = d; this.bySheet = new Map(d.sheets.map(s => [s.id, s])); return d; })
        .catch(() => { this.data = { sheets: [] }; this.bySheet = new Map(); return this.data; });
    }
    return this._loading;
  },

  isRef(s) { return this.RE.test(String(s || '')); },

  parse(ref) {
    const m = this.RE.exec(String(ref || ''));
    if (!m || !this.bySheet) return null;
    const sheet = this.bySheet.get(m[1]);
    const sprite = sheet && sheet.sprites[Number(m[2])];
    return sprite ? { sheet, sprite, ref } : null;
  },

  /** PixiJS texture for a sprite reference (nearest-neighbour so pixel art stays crisp). */
  async texture(ref) {
    await this.load();
    const p = this.parse(ref);
    if (!p) throw new Error('Unknown sprite ' + ref);
    if (this._frames.has(ref)) return this._frames.get(ref);
    let base = this._sheetTex.get(p.sheet.id);
    if (!base) {
      base = await PIXI.Assets.load({ src: p.sheet.file, loadParser: 'loadTextures' });
      base.source.scaleMode = 'nearest';
      this._sheetTex.set(p.sheet.id, base);
    }
    const tex = new PIXI.Texture({ source: base.source, frame: new PIXI.Rectangle(p.sprite.x, p.sprite.y, p.sprite.w, p.sprite.h) });
    this._frames.set(ref, tex);
    return tex;
  },

  /** Inline style for a DOM element showing the sprite scaled to fit `box` px. */
  cssStyle(ref, box = 64) {
    const p = this.parse(ref);
    if (!p) return '';
    const { sheet, sprite } = p;
    const k = Math.min(box / sprite.w, box / sprite.h, 3);
    return `width:${Math.round(sprite.w * k)}px;height:${Math.round(sprite.h * k)}px;` +
      `background-image:url('${sheet.file}');background-repeat:no-repeat;` +
      `background-size:${Math.round(sheet.w * k)}px ${Math.round(sheet.h * k)}px;` +
      `background-position:-${Math.round(sprite.x * k)}px -${Math.round(sprite.y * k)}px;image-rendering:pixelated;`;
  },

  html(ref, box = 64, extraClass = '') {
    const st = this.cssStyle(ref, box);
    return st ? `<span class="sprite ${extraClass}" style="${st}"></span>` : '';
  },
};

window.SpriteAtlas = SpriteAtlas;
