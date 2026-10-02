'use strict';
/* global PIXI */
/**
 * Riflemen in a firefight (docs/UNITS.md). While an infantry unit is in a gunfire battle this turn, a squad of
 * eight small soldiers from the soldier sheet (public/assets/soldiers.png, built by scripts/build-soldiers.js)
 * holds its firing line, rifles levelled at the enemy. Every 12.5 % of strength lost leaves one of them dead on
 * the line (at 50 %: four firing, four fallen); now and then a living one runs along the line to a new spot.
 * Uniforms follow the nation, so all of a nation's troops look alike: grey, beige or green (chosen on the
 * faction, else guessed from its name), and assault regiments wear the armoured stormtrooper kit.
 * The renderer hands over each squad's firing line every frame (MapRenderer._tickBattles).
 */
(function () {
  const SQUAD = 8;
  const AIM_OFF = 0.66;            // the levelled rifle points ~38° above the figure's right: turn it onto the enemy
  // One scale for every pose, so the figures keep the sheet's proportions (a soldier seen from above is about half
  // as long as one lying full length): set by the fallen figure's length on screen, px (before the zoom boost).
  const DEAD_PX = 22;
  const RUN_PX_S = 34;             // running pace, screen px a second
  const UNIFORMS = ['grey', 'beige', 'green'];
  // Defaults by nation name, keeping the 1914 sides apart at a glance: the Central Powers in field grey, Britain,
  // France and Belgium in khaki, Russia, Italy and the Americas in olive. The GM can choose another on the faction.
  const AUTO = [
    [/german|prussia|bavaria|saxon|w[uü]rttemberg|austria|hungar|habsburg|swed|norw|denmark|danish|netherland|dutch|swiss|switzerland|finland|poland|polish|czech|luxem|iceland/i, 'grey'],
    [/united states|america|ital|sardinia|\busa?\b|russia|soviet|serbia|monteneg|romania|bulgaria|brazil|mexic|argentin|chile|peru|venez|colombia|cuba|california|texas|ukrain|lithuan|latvia|eston|navajo|\butes?\b/i,'green'],
    [/brit|france|french|belgi|england|scot|irish|ireland|wales|united kingdom|\buk\b|australia|new zealand|canad|india|south africa|newfoundland|acadia|quebec|ottoman|turk|japan|china|chinese|qing|greece|greek|portug|spain|spanish|siam|persia|egypt|afghan|ethiop|abyssin|arab|nejd|hejaz|morocc|tunis|tripol|zanzibar|liberia|korea|philipp|congo|boer|muslim/i, 'beige'],
  ];
  function uniformFor(name, chosen) {
    if (UNIFORMS.includes(chosen)) return chosen;
    const n = String(name || '');
    for (const [re, u] of AUTO) if (re.test(n)) return u;
    let h = 0; for (const c of n.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return UNIFORMS[h % UNIFORMS.length];
  }
  const hash = (a, b) => { const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); };
  const aliveFor = strength => Math.max(0, Math.min(SQUAD, Math.ceil(Number(strength) / (100 / SQUAD) - 1e-9)));
  const strengthOf = v => (!v || v.dying) ? 0 : Number(v.marker?.data?.strength ?? 100);

  class Skirmish {
    constructor(renderer) {
      this.r = renderer;
      this.layer = new PIXI.Container(); this.layer.eventMode = 'none';
      this.deadC = new PIXI.Container(); this.aliveC = new PIXI.Container();
      this.layer.addChild(this.deadC, this.aliveC);
      this.squads = new Map();       // unit id -> squad
      this.uniforms = new Map();     // nation (lower case) -> uniform
      this.tex = null;
      this._load();
    }
    async _load() {
      try {
        const meta = await fetch('/assets/soldiers.json?v=1').then(r => r.json());
        const base = await PIXI.Assets.load({ src: '/assets/soldiers.png?v=1', loadParser: 'loadTextures' });
        const tex = {};
        for (const [set, poses] of Object.entries(meta.frames)) {
          tex[set] = {};
          for (const [pose, f] of Object.entries(poses)) {
            tex[set][pose] = { t: new PIXI.Texture({ source: base.source, frame: new PIXI.Rectangle(f.x, f.y, f.w, f.h) }), ax: f.ax, ay: f.ay, len: Math.max(f.w, f.h) };
          }
        }
        this.tex = tex;
        this.r.invalidate();
      } catch (e) { console.warn('Soldier sprites not available', e); }
    }
    /** Faction list from the map page: [{ name, uniform }]. */
    setFactions(list) {
      this.uniforms = new Map((list || []).map(f => [String(f.name || '').trim().toLowerCase(), uniformFor(f.name, f.uniform)]));
      for (const q of this.squads.values()) q.kit = null;
    }
    static isInfantry(m) { return !!m && m.type === 'unit' && window.UnitTypes?.resolve(m.data?.unitType)?.cat === 'Infantry'; }
    kitFor(m) {
      if (window.UnitTypes?.resolve(m?.data?.unitType)?.id === 'stormtroopers') return 'assault';
      const n = String(m?.data?.nation || '').trim().toLowerCase();
      return this.uniforms.get(n) || uniformFor(n, '');
    }
    clear() { for (const q of this.squads.values()) this._drop(q); this.squads.clear(); }
    _drop(q) { for (const m of q.men) { m.sp.parent?.removeChild(m.sp); m.sp.destroy(); } }

    /**
     * One frame. `fronts`: unit id -> { view, cx, cy (centre of its firing line), ux, uy (towards the enemy),
     * front (line width, world units), backPx (from the line back to the token, screen px), createdAt }.
     * `keep`: every unit still in a battle this turn (squads off screen keep their state). Draws muzzle flashes
     * on `g`. Returns true while a squad is on screen.
     */
    frame(fronts, keep, nowMs, s, g) {
      for (const [id, q] of this.squads) if (!keep.has(id)) { this._drop(q); this.squads.delete(id); }
      for (const [id, q] of this.squads) if (!fronts.has(id)) for (const m of q.men) m.sp.visible = false;
      if (!this.tex || !fronts.size) return false;
      const t = nowMs / 1000, boost = Math.min(1.5, Math.max(1, s / 14));
      for (const [id, f] of fronts) {
        let q = this.squads.get(id);
        if (!q) { q = this._make(id, f, nowMs); this.squads.set(id, q); }
        if (!q.kit) { q.kit = this.kitFor(f.view?.marker); for (const m of q.men) m.pose = null; }
        this._tick(q, f, nowMs, t, s, boost, g);
      }
      return true;
    }

    _make(id, f, nowMs) {
      const v = f.view, seed = id * 7.31;
      // Just fought: start from the strength before the blow, so the losses fall on screen.
      const drop = v?.strengthDrop && nowMs - v.strengthDrop.at < 8000 ? v.strengthDrop.from : null;
      const alive = aliveFor(drop ?? strengthOf(v));
      const fresh = f.createdAt && Date.now() - f.createdAt < 10000;
      const men = [];
      for (let i = 0; i < SQUAD; i++) {
        const o = (i + 0.5) / SQUAD - 0.5 + (hash(seed, i) - 0.5) * 0.06, d = 2 + hash(seed, i + 20) * 6;
        const m = { i, o, d, sp: new PIXI.Sprite(), pose: null, dead: i >= alive, run: null,
          next: nowMs + 2500 + hash(seed, i + 40) * 9000, period: 0.7 + hash(seed, i + 60) * 1.4, phase: hash(seed, i + 80) * 3,
          rot: hash(seed, i + 100) * Math.PI * 2, flip: hash(seed, i + 120) < 0.5, fellAt: 0 };
        m.sp.eventMode = 'none';
        if (m.dead) { m.o += (hash(seed, i + 140) - 0.5) * 0.08; m.d += hash(seed, i + 160) * 10; }
        else if (fresh) m.run = { o0: 0, d0: f.backPx, o1: o, d1: d, t0: nowMs + i * 110, dur: 0 };   // out of the unit to the line
        (m.dead ? this.deadC : this.aliveC).addChild(m.sp);
        men.push(m);
      }
      return { id, men, kit: null, nextDeath: 0 };
    }

    _tick(q, f, nowMs, t, s, boost, g) {
      const kit = this.tex[q.kit] || this.tex.grey;
      const unit = DEAD_PX / kit.dead.len * boost / s;   // world units per atlas px, for every pose
      const nx = -f.uy, ny = f.ux, theta = Math.atan2(f.uy, f.ux);
      const at = (o, d) => [f.cx + nx * o * f.front - f.ux * d / s, f.cy + ny * o * f.front - f.uy * d / s];
      const living = q.men.filter(m => !m.dead);
      // Casualties follow strength: one man per 12.5 % lost, falling one after another; healing brings them back.
      const want = aliveFor(strengthOf(f.view));
      if (living.length > want && nowMs >= q.nextDeath) {
        const m = living[Math.floor(Math.random() * living.length)];
        if (m.run) { const p = this._runPos(m, nowMs); m.o = p.o; m.d = p.d; m.run = null; }
        m.dead = true; m.fellAt = nowMs; m.pose = null;
        this.aliveC.removeChild(m.sp); this.deadC.addChild(m.sp);
        q.nextDeath = nowMs + 260 + Math.random() * 650;
      } else if (living.length < want) {
        const m = q.men.find(x => x.dead);
        if (m) { m.dead = false; m.pose = null; this.deadC.removeChild(m.sp); this.aliveC.addChild(m.sp); }
      }
      const running = q.men.filter(m => m.run).length;
      for (const m of q.men) {
        const sp = m.sp;
        sp.visible = true;
        if (m.dead) {
          this._pose(m, kit, 'dead');
          const [x, y] = at(m.o, m.d), age = nowMs - m.fellAt;
          const k = m.fellAt && age < 320 ? age / 320 : 1;
          sp.position.set(x, y);
          sp.rotation = m.rot;
          const sc = unit * (1.25 - 0.25 * k);
          sp.scale.set(m.flip ? -sc : sc, sc);
          sp.alpha = 0.35 + 0.65 * k;
          continue;
        }
        sp.alpha = 1;
        // Now and then a rifleman gets up and runs along the line to a new spot (two at most at a time).
        if (!m.run && nowMs >= m.next) {
          if (running >= 2) m.next = nowMs + 1000 + Math.random() * 1500;
          else {
            const step = (0.12 + Math.random() * 0.25) * (Math.random() < 0.5 ? -1 : 1);
            let o1 = m.o + step; if (o1 > 0.5 || o1 < -0.5) o1 = m.o - step;
            m.run = { o0: m.o, d0: m.d, o1: Math.max(-0.5, Math.min(0.5, o1)), d1: 2 + Math.random() * 6, t0: nowMs, dur: 0 };
          }
        }
        if (m.run) {
          const r = m.run;
          if (!r.dur) r.dur = Math.max(400, Math.hypot((r.o1 - r.o0) * f.front * s, r.d1 - r.d0) / RUN_PX_S * 1000);
          if (nowMs >= r.t0 + r.dur) { m.o = r.o1; m.d = r.d1; m.run = null; m.next = nowMs + 3500 + Math.random() * 8000; }
          else if (nowMs >= r.t0) {
            const p = this._runPos(m, nowMs), [x, y] = at(p.o, p.d), [x0, y0] = at(r.o0, r.d0), [x1, y1] = at(r.o1, r.d1);
            this._pose(m, kit, 'up');
            sp.position.set(x, y);
            sp.rotation = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2;
            const sc = unit * (1 + 0.07 * Math.abs(Math.sin(t * 13 + m.i)));
            sp.scale.set(sc);
            continue;
          } else { sp.visible = false; continue; }   // still waiting to leave the unit
        }
        // Holding the line: rifle on the enemy, a little sway, a kick and a flash with each shot.
        this._pose(m, kit, 'aim');
        const shot = ((t + m.phase) % m.period) / m.period < 0.07;
        const [x, y] = at(m.o, m.d + (shot ? 0.8 : 0));
        const aim = theta + Math.sin(t * 0.7 + m.phase * 2) * 0.1;
        sp.position.set(x, y);
        sp.rotation = aim + AIM_OFF;
        sp.scale.set(unit);
        if (shot && g) {
          const reach = kit.aim.len * unit * 0.45, mx = x + Math.cos(aim) * reach, my = y + Math.sin(aim) * reach;
          g.circle(mx, my, 3.2 * boost / s).fill({ color: 0xffc94a, alpha: 0.35 });
          g.circle(mx, my, 1.5 * boost / s).fill({ color: 0xfff6c8, alpha: 0.95 });
        }
      }
    }
    _runPos(m, nowMs) {
      const r = m.run, k = r.dur ? Math.max(0, Math.min(1, (nowMs - r.t0) / r.dur)) : 0;
      return { o: r.o0 + (r.o1 - r.o0) * k, d: r.d0 + (r.d1 - r.d0) * k };
    }
    _pose(m, kit, pose) {
      if (m.pose === pose) return;
      const f = kit[pose] || kit.aim;
      m.sp.texture = f.t; m.sp.anchor.set(f.ax, f.ay); m.pose = pose;
    }
  }
  Skirmish.uniformFor = uniformFor;
  window.Skirmish = Skirmish;
})();
