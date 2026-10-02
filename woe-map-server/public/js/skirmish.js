'use strict';
/* global PIXI */
/**
 * Units in a fight, drawn small on the map (docs/UNITS.md). While a unit is in a battle this turn its men and
 * machines hold a line a little ahead of its token, facing the enemy:
 *
 *   - infantry: eight riflemen from the soldier sheet (public/assets/soldiers.png, scripts/build-soldiers.js), rifles
 *     levelled; now and then one runs along the line to a new spot;
 *   - artillery and machine-gun companies: four guns spread along the line (public/assets/machines.png,
 *     scripts/build-machines.js), each worked by two soldiers; guns recoil, flash and smoke as they fire (an artillery
 *     shell leaves from one of them), and fall silent when both their crew are down;
 *   - tanks: two, rolling out to the line and firing; a knocked-out one goes dark and smokes.
 *
 * Losses follow strength: one man in eight per 12.5 % lost (at 50 %: four standing, four fallen), one tank in two per
 * 50 %. Uniforms follow the nation, so all of a nation's troops look alike: grey, beige or green (chosen on the faction,
 * else guessed from its name), and assault regiments wear the armoured stormtrooper kit; each nation also has its own
 * tank design. The renderer hands over each squad's line every frame (MapRenderer._tickBattles).
 */
(function () {
  const SQUAD = 8, GUNS = 4, TANKS = 2;
  const AIM_OFF = 0.66;            // the levelled rifle points ~38° above the figure's right: turn it onto the enemy
  // One scale for every soldier pose, so the figures keep the sheet's proportions (a soldier seen from above is about
  // half as long as one lying full length): set by the fallen figure's length on screen, px (before the zoom boost).
  const DEAD_PX = 22;
  // Machines, by their longest side on screen (px, before the zoom boost), sized against those soldiers.
  const GUN_PX = { field: 20, heavy: 24, siege: 24, mortar: 11, horse: 24, hmg: 13 };
  const TANK_PX = 32;
  const RUN_PX_S = 34, ROLL_PX_S = 26;   // running and rolling pace, screen px a second
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
    return UNIFORMS[strHash(n) % UNIFORMS.length];
  }
  function strHash(s) { let h = 0; for (const c of String(s || '').toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
  // Which gun each artillery type works; machine-gun companies get the Maxim.
  const GUN_FOR = { fieldartillery: 'field', antiaircraft: 'field', horseartillery: 'horse', heavyartillery: 'heavy', siegeartillery: 'siege',
    railwaygun: 'siege', coastal: 'heavy', mortar: 'mortar', machinegun: 'hmg' };
  const hash = (a, b) => { const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); };
  const aliveFor = (strength, n = SQUAD) => Math.max(0, Math.min(n, Math.ceil(Number(strength) / (100 / n) - 1e-9)));
  const strengthOf = v => (!v || v.dying) ? 0 : Number(v.marker?.data?.strength ?? 100);
  const typeOf = m => (m && m.type === 'unit' && window.UnitTypes) ? window.UnitTypes.resolve(m.data?.unitType) : null;

  class Skirmish {
    constructor(renderer) {
      this.r = renderer;
      this.layer = new PIXI.Container(); this.layer.eventMode = 'none';
      this.deadC = new PIXI.Container(); this.machC = new PIXI.Container(); this.aliveC = new PIXI.Container();
      this.layer.addChild(this.deadC, this.machC, this.aliveC);
      this.squads = new Map();       // unit id -> squad
      this.uniforms = new Map();     // nation (lower case) -> uniform
      this.tex = null; this.mach = null;
      this._load();
    }
    async _load() {
      const frame = (base, f) => new PIXI.Texture({ source: base.source, frame: new PIXI.Rectangle(f.x, f.y, f.w, f.h) });
      try {
        const meta = await fetch('/assets/soldiers.json?v=1').then(r => r.json());
        const base = await PIXI.Assets.load({ src: '/assets/soldiers.png?v=1', loadParser: 'loadTextures' });
        const tex = {};
        for (const [set, poses] of Object.entries(meta.frames)) {
          tex[set] = {};
          for (const [pose, f] of Object.entries(poses)) tex[set][pose] = { t: frame(base, f), ax: f.ax, ay: f.ay, len: Math.max(f.w, f.h) };
        }
        this.tex = tex;
        this.r.invalidate();
      } catch (e) { console.warn('Soldier sprites not available', e); }
      try {
        const meta = await fetch('/assets/machines.json?v=1').then(r => r.json());
        const base = await PIXI.Assets.load({ src: '/assets/machines.png?v=1', loadParser: 'loadTextures' });
        const one = f => ({ ...f, t: frame(base, f), len: Math.max(f.w, f.h) });
        this.mach = { tanks: meta.tanks.map(one), guns: Object.fromEntries(Object.entries(meta.guns).map(([k, f]) => [k, one(f)])) };
        this.r.invalidate();
      } catch (e) { console.warn('Gun and tank sprites not available', e); }
    }
    /** Faction list from the map page: [{ name, uniform }]. */
    setFactions(list) {
      this.uniforms = new Map((list || []).map(f => [String(f.name || '').trim().toLowerCase(), uniformFor(f.name, f.uniform)]));
      for (const q of this.squads.values()) q.kit = null;
    }
    /** What a unit shows in a fight: 'rifles' (infantry), 'guns' (artillery, machine guns), 'tanks', or null. */
    static kindOf(m) {
      const t = typeOf(m);
      if (!t) return null;
      if (t.id === 'tank') return 'tanks';
      if (t.cat === 'Artillery' || t.id === 'machinegun') return 'guns';
      if (t.cat === 'Infantry') return 'rifles';
      return null;
    }
    static isInfantry(m) { return Skirmish.kindOf(m) === 'rifles'; }
    kitFor(m) {
      if (typeOf(m)?.id === 'stormtroopers') return 'assault';
      const n = String(m?.data?.nation || '').trim().toLowerCase();
      return this.uniforms.get(n) || uniformFor(n, '');
    }
    clear() { for (const q of this.squads.values()) this._drop(q); this.squads.clear(); }
    _drop(q) { for (const sp of [...q.men.map(m => m.sp), ...q.machines.map(x => x.sp)]) { sp.parent?.removeChild(sp); sp.destroy(); } }

    /**
     * An artillery unit fires a shell (MapRenderer, shelling): one of its working guns recoils and flashes, and the
     * shell leaves from its muzzle. Returns that point (world units), or null when its guns are not on screen.
     */
    fireGun(unitId, nowMs) {
      const q = this.squads.get(unitId);
      if (!q || q.kind !== 'guns' || !q.shown) return null;
      const ready = q.machines.filter(gn => gn.manned && gn.muzzle);
      if (!ready.length) return null;
      const gn = ready[Math.floor(Math.random() * ready.length)];
      gn.firedAt = nowMs; gn.nextShot = nowMs + 2500 + Math.random() * 3000;
      q.puffs.push({ x: gn.muzzle[0], y: gn.muzzle[1], t0: nowMs, big: true });
      return { x: gn.muzzle[0], y: gn.muzzle[1] };
    }

    /**
     * One frame. `fronts`: unit id -> { view, cx, cy (centre of its line), ux, uy (towards the enemy), front (line
     * width, world units), backPx (from the line back to the token, screen px), createdAt, kind, shells }.
     * `keep`: every unit still in a battle this turn (squads off screen keep their state). Draws flashes and smoke on
     * `g`. Returns true while a squad is on screen.
     */
    frame(fronts, keep, nowMs, s, g) {
      for (const [id, q] of this.squads) if (!keep.has(id)) { this._drop(q); this.squads.delete(id); }
      for (const [id, q] of this.squads) if (!fronts.has(id)) { q.shown = false; for (const sp of [...q.men.map(m => m.sp), ...q.machines.map(x => x.sp)]) sp.visible = false; }
      if (!this.tex || !fronts.size) return false;
      const t = nowMs / 1000, boost = Math.min(1.5, Math.max(1, s / 14));
      for (const [id, f] of fronts) {
        if (f.kind !== 'rifles' && !this.mach) continue;
        let q = this.squads.get(id);
        if (q && q.kind !== f.kind) { this._drop(q); this.squads.delete(id); q = null; }
        if (!q) { q = this._make(id, f, nowMs); this.squads.set(id, q); }
        if (!q.kit) { q.kit = this.kitFor(f.view?.marker); for (const m of q.men) m.pose = null; }
        q.shown = true;
        this._tick(q, f, nowMs, t, s, boost, g);
      }
      return true;
    }

    _make(id, f, nowMs) {
      const v = f.view, seed = id * 7.31, kind = f.kind;
      // Just fought: start from the strength before the blow, so the losses fall on screen.
      const drop = v?.strengthDrop && nowMs - v.strengthDrop.at < 8000 ? v.strengthDrop.from : null;
      const before = drop ?? strengthOf(v);
      const fresh = f.createdAt && Date.now() - f.createdAt < 10000;
      const q = { id, kind, men: [], machines: [], kit: null, nextDeath: 0, puffs: [], shown: false };
      if (kind === 'tanks') {
        const design = this.mach.tanks[strHash(v?.marker?.data?.nation) % this.mach.tanks.length];
        const alive = aliveFor(before, TANKS);
        for (let i = 0; i < TANKS; i++) {
          const o = i ? 0.22 : -0.22, d = -4 + hash(seed, i) * 4;
          const tk = { i, o, d, frame: design, sp: new PIXI.Sprite(design.t), dead: i >= alive, nextShot: nowMs + 1200 + hash(seed, i + 9) * 3000, firedAt: 0, smokeAt: 0, roll: null };
          tk.sp.anchor.set(design.ax, design.ay); tk.sp.eventMode = 'none';
          if (fresh && !tk.dead) tk.roll = { o0: 0, d0: f.backPx, o1: o, d1: d, t0: nowMs + i * 500, dur: 0 };
          this.machC.addChild(tk.sp);
          q.machines.push(tk);
        }
        return q;
      }
      if (kind === 'guns') {
        const key = GUN_FOR[typeOf(v?.marker)?.id] || 'field', gf = this.mach.guns[key];
        for (let i = 0; i < GUNS; i++) {
          const gn = { i, o: (i + 0.5) / GUNS - 0.5, d: 6 + hash(seed, i + 3) * 4, frame: gf, key, sp: new PIXI.Sprite(gf.t), manned: true,
            nextShot: nowMs + 800 + hash(seed, i + 30) * 4000, firedAt: 0, burst: 0, muzzle: null };
          gn.sp.anchor.set(gf.ax, gf.ay); gn.sp.eventMode = 'none';
          this.machC.addChild(gn.sp);
          q.machines.push(gn);
        }
      }
      const alive = aliveFor(before);
      for (let i = 0; i < SQUAD; i++) {
        const crew = kind === 'guns';
        const o = crew ? 0 : (i + 0.5) / SQUAD - 0.5 + (hash(seed, i) - 0.5) * 0.06, d = crew ? 0 : 2 + hash(seed, i + 20) * 6;
        const m = { i, o, d, sp: new PIXI.Sprite(), pose: null, dead: i >= alive, run: null,
          gun: crew ? i % GUNS : -1, side: crew ? (i < GUNS ? -1 : 1) : 0,
          next: nowMs + 2500 + hash(seed, i + 40) * 9000, period: 0.7 + hash(seed, i + 60) * 1.4, phase: hash(seed, i + 80) * 3,
          rot: hash(seed, i + 100) * Math.PI * 2, flip: hash(seed, i + 120) < 0.5, fellAt: 0, jo: (hash(seed, i + 140) - 0.5), jd: hash(seed, i + 160) };
        m.sp.eventMode = 'none';
        if (!crew && m.dead) { m.o += m.jo * 0.08; m.d += m.jd * 10; }
        else if (!crew && fresh) m.run = { o0: 0, d0: f.backPx, o1: o, d1: d, t0: nowMs + i * 110, dur: 0 };   // out of the unit to the line
        (m.dead ? this.deadC : this.aliveC).addChild(m.sp);
        q.men.push(m);
      }
      return q;
    }

    _tick(q, f, nowMs, t, s, boost, g) {
      const kit = this.tex[q.kit] || this.tex.grey;
      const unit = DEAD_PX / kit.dead.len * boost / s;   // world units per soldier-atlas px, for every pose
      const nx = -f.uy, ny = f.ux, theta = Math.atan2(f.uy, f.ux);
      const at = (o, d) => [f.cx + nx * o * f.front - f.ux * d / s, f.cy + ny * o * f.front - f.uy * d / s];
      if (q.kind === 'tanks') this._tickTanks(q, f, nowMs, t, s, boost, g, at, theta);
      else {
        if (q.kind === 'guns') this._tickGuns(q, f, nowMs, t, s, boost, g, at, theta, unit);
        this._tickMen(q, f, nowMs, t, s, boost, g, at, theta, unit, kit);
      }
      // Smoke from shots and wrecks: grey puffs that swell, drift and fade.
      q.puffs = q.puffs.filter(p => nowMs - p.t0 < 1400);
      for (const p of q.puffs) {
        const age = (nowMs - p.t0) / 1400, r = (p.big ? 5 : 3.2) * boost / s * (1 + age * 2.2);
        g.circle(p.x - f.ux * age * 4 / s, p.y - f.uy * age * 4 / s - age * 6 / s, r).fill({ color: p.dark ? 0x3a3a3a : 0xd9d6cf, alpha: 0.45 * (1 - age) });
      }
    }

    // ---- Infantry and gun crews ----------------------------------------------------------------------------------
    _tickMen(q, f, nowMs, t, s, boost, g, at, theta, unit, kit) {
      const crew = q.kind === 'guns';
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
      if (crew) {
        // A crew stands either side of its gun, a little behind the breech; the fallen lie beside it.
        for (const m of q.men) {
          const gn = q.machines[m.gun], px = this._gunScale(gn, boost, s) * s;   // screen px per gun-atlas px
          const lat = (Math.min(gn.frame.w, gn.frame.h) * px * 0.5 + 3 * boost) * m.side;
          m.o = gn.o + lat / (f.front * s) + (m.dead ? m.jo * 0.02 : 0);
          m.d = gn.d + gn.frame.len * px * 0.22 + (m.dead ? m.jd * 6 : 0);
        }
        for (const gn of q.machines) gn.manned = q.men.some(m => m.gun === gn.i && !m.dead);
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
        if (crew) {
          // Working the gun: standing to it, facing the enemy, with a small bob as they load.
          this._pose(m, kit, 'up');
          const gn = q.machines[m.gun], busy = gn.firedAt && nowMs - gn.firedAt < 900;
          const [x, y] = at(m.o, m.d + (busy ? Math.sin((nowMs - gn.firedAt) / 90) * 0.8 : 0));
          sp.position.set(x, y);
          sp.rotation = theta + Math.PI / 2 + m.side * 0.35;
          sp.scale.set(unit);
          continue;
        }
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
            sp.scale.set(unit * (1 + 0.07 * Math.abs(Math.sin(t * 13 + m.i))));
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

    // ---- Guns ------------------------------------------------------------------------------------------------------
    _gunScale(gn, boost, s) { return (GUN_PX[gn.key] || 20) / gn.frame.len * boost / s; }
    /** Place a machine facing the enemy: drawn from above, it turns barrel-first; from the side, it faces left or right. */
    _orient(sp, fr, sc, theta, ux) {
      if (fr.view === 'side') { sp.rotation = 0; sp.scale.set(ux > 0 ? -sc : sc, sc); }
      else { sp.rotation = theta + Math.PI / 2; sp.scale.set(sc); }
    }
    /** The muzzle of a placed machine, in world units. */
    _muzzleOf(sp, fr) {
      const lx = (fr.muzzle[0] - fr.ax) * fr.w * sp.scale.x, ly = (fr.muzzle[1] - fr.ay) * fr.h * sp.scale.y;
      const c = Math.cos(sp.rotation), sn = Math.sin(sp.rotation);
      return [sp.x + lx * c - ly * sn, sp.y + lx * sn + ly * c];
    }
    _flash(g, x, y, r) {
      g.circle(x, y, r * 2.2).fill({ color: 0xffb030, alpha: 0.3 });
      g.circle(x, y, r).fill({ color: 0xfff3c0, alpha: 0.95 });
    }
    _tickGuns(q, f, nowMs, t, s, boost, g, at, theta) {
      const hmg = q.machines[0]?.key === 'hmg';
      for (const gn of q.machines) {
        const sc = this._gunScale(gn, boost, s);
        // Recoil: kicked back on firing, run forward again over half a second.
        const since = nowMs - gn.firedAt, kick = gn.firedAt && since < 500 ? (1 - since / 500) * (hmg ? 0.6 : 3) * boost : 0;
        const [x, y] = at(gn.o, gn.d + kick);
        gn.sp.visible = true;
        gn.sp.position.set(x, y);
        this._orient(gn.sp, gn.frame, sc, theta, f.ux);
        gn.sp.tint = gn.manned ? 0xffffff : 0x6f6f6f;
        gn.muzzle = this._muzzleOf(gn.sp, gn.frame);
        if (!gn.manned) continue;
        // Firing on its own: field guns now and then (shells come through fireGun), machine guns in bursts.
        if (hmg) {
          if (nowMs >= gn.nextShot) { gn.burst = 7 + Math.floor(Math.random() * 6); gn.nextShot = nowMs + 2200 + Math.random() * 2500; }
          if (gn.burst > 0 && (!gn.burstAt || nowMs - gn.burstAt > 110)) { gn.burst--; gn.burstAt = nowMs; gn.firedAt = nowMs; this._flash(g, gn.muzzle[0], gn.muzzle[1], 1.8 * boost / s); }
        } else if (!f.shells && nowMs >= gn.nextShot) {
          gn.firedAt = nowMs; gn.nextShot = nowMs + 3000 + Math.random() * 4000;
          q.puffs.push({ x: gn.muzzle[0], y: gn.muzzle[1], t0: nowMs, big: true });
        }
        if (!hmg && gn.firedAt && nowMs - gn.firedAt < 120) this._flash(g, gn.muzzle[0], gn.muzzle[1], 3 * boost / s);
      }
    }

    // ---- Tanks -----------------------------------------------------------------------------------------------------
    _tickTanks(q, f, nowMs, t, s, boost, g, at, theta) {
      const want = aliveFor(strengthOf(f.view), TANKS);
      const alive = q.machines.filter(tk => !tk.dead);
      if (alive.length > want) { const tk = alive[alive.length - 1]; tk.dead = true; tk.roll = null; tk.firedAt = 0; }
      else if (alive.length < want) { const tk = q.machines.find(x => x.dead); if (tk) tk.dead = false; }
      for (const tk of q.machines) {
        const sp = tk.sp, fr = tk.frame, sc = TANK_PX / fr.len * boost / s;
        let o = tk.o, d = tk.d, bob = 0;
        if (tk.roll) {
          const r = tk.roll;
          if (!r.dur) r.dur = Math.max(600, Math.hypot((r.o1 - r.o0) * f.front * s, r.d1 - r.d0) / ROLL_PX_S * 1000);
          const k = Math.max(0, Math.min(1, (nowMs - r.t0) / r.dur));
          if (k >= 1) tk.roll = null;
          o = r.o0 + (r.o1 - r.o0) * k; d = r.d0 + (r.d1 - r.d0) * k;
          bob = k > 0 && k < 1 ? Math.sin(nowMs / 70 + tk.i) * 0.5 : 0;
        } else if (!tk.dead) o += Math.sin(t * 0.4 + tk.i * 2) * 0.01;   // edging along the line
        const since = nowMs - tk.firedAt, kick = tk.firedAt && since < 400 ? (1 - since / 400) * 1.5 * boost : 0;
        const [x, y] = at(o, d + kick);
        sp.visible = !(tk.roll && nowMs < tk.roll.t0);
        sp.position.set(x, y + bob / s);
        this._orient(sp, fr, sc, theta, f.ux);
        sp.tint = tk.dead ? 0x4a4a4a : 0xffffff;
        if (tk.dead) {
          // Knocked out: dark, with smoke rising from it.
          if (nowMs - tk.smokeAt > 260) { tk.smokeAt = nowMs; q.puffs.push({ x: x + (Math.random() - 0.5) * 6 / s, y: y - 4 / s, t0: nowMs, dark: true }); }
          continue;
        }
        if (!tk.roll && nowMs >= tk.nextShot) { tk.firedAt = nowMs; tk.nextShot = nowMs + 2500 + Math.random() * 2500; const [mx, my] = this._muzzleOf(sp, fr); q.puffs.push({ x: mx, y: my, t0: nowMs }); }
        if (tk.firedAt && nowMs - tk.firedAt < 110) { const [mx, my] = this._muzzleOf(sp, fr); this._flash(g, mx, my, 2.6 * boost / s); }
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
