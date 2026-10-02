'use strict';
/* global PIXI */
/**
 * Units in a fight, drawn small on the map (docs/UNITS.md). While a unit is in a battle this turn its men and
 * machines hold a line a little ahead of its token, facing the enemy:
 *
 *   - infantry: a section of eight from its army's figures (public/assets/soldiers.png, scripts/build-soldiers.js):
 *     an officer, a sergeant, a light machine-gunner (from 1916, where the army has one), a medic and riflemen, each
 *     lying, kneeling or standing to aim at the enemy; now and then one runs along the line to a new spot, and the
 *     medic goes out to the fallen and kneels by them a while;
 *   - machine-gun companies and trench mortars: four teams along the line, each a gun with its crew drawn together
 *     (the Vickers, MG 08, Hotchkiss, Browning, Maxim; the Stokes and the Minenwerfer); a team whose two men are both
 *     down leaves its gun standing empty, its crew lying beside it;
 *   - other artillery: four guns spread along the line (public/assets/machines.png, scripts/build-machines.js), each
 *     worked by two men of its army; guns recoil, flash and smoke as
 *     they fire (an artillery shell leaves from one of them), and fall silent when both their crew are down;
 *   - tanks: two, rolling out to the line and firing; a knocked-out one goes dark and smokes;
 *   - cavalry: eight horsemen (public/assets/mounts.png, scripts/build-mounts.js) who form up, charge the enemy's line,
 *     fight there a moment, ride back and charge again; a fallen rider lies where he fell;
 *   - aircraft: four planes of one livery, flying over the map with their shadows below. Out of a fight they circle
 *     their unit; against ground or ships they make strafing runs over the target (bombers drop bombs on it);
 *     against other aircraft both squadrons mix it up over the fight, each plane chasing an enemy, firing when it
 *     has one in its sights and breaking hard when it is chased. A plane shot down spins away trailing smoke.
 *
 * Losses follow strength: one man in eight per 12.5 % lost (at 50 %: four standing, four fallen), one tank in two per
 * 50 %, one plane in four per 25 %. Each nation fights as one of the armies the art has: American, British, French,
 * German or Russian (chosen on the faction, else guessed from its name), so all of a nation's troops look alike;
 * the kit follows the game's date (1916 helmets and gear from 1916, greatcoats and winter dress from November to
 * February); assault regiments go in as stormtroopers or trench raiders, French colonial troops as zouaves. Each
 * nation also has its own tank design and its own livery of planes (the Central Powers' with crosses, the others'
 * with roundels). The renderer hands over each squad's line every frame (MapRenderer._tickBattles).
 */
(function () {
  const SQUAD = 8, GUNS = 4, TANKS = 2;
  // One scale for every figure, so they keep the art's proportions: a man's torso across on screen, px (before the zoom
  // boost; a man lying full length is then about 20 px).
  const TORSO_PX = 7;
  // Machines, by their longest side on screen (px, before the zoom boost), sized against those soldiers.
  const GUN_PX = { field: 20, heavy: 24, siege: 24, mortar: 11, horse: 24, hmg: 13 };
  const TANK_PX = 32;
  const RUN_PX_S = 34, ROLL_PX_S = 26;   // running and rolling pace, screen px a second
  // Horsemen (head to tail, lance and all) and planes (wingspan), screen px before the zoom boost.
  const RIDERS = 8, RIDER_PX = 34, GALLOP_PX_S = 70, TROT_PX_S = 28;
  const RIDER_FOR = { british: 'beige', german: 'grey', american: 'green', french: 'french', russian: 'russian' };   // mounts.json riders
  const PLANES = 4;
  const PLANE_PX = { fighter: 30, reconair: 30, seaplane: 32, bomber: 40 };
  const FLY_PX_S = { fighter: 76, reconair: 64, seaplane: 60, bomber: 48 };   // air speed, screen px a second
  const TURN = { fighter: 2.7, reconair: 2.2, seaplane: 2.0, bomber: 1.5 };     // turn rate, radians a second
  const HORSE = new Set(['cavalry', 'dragoons', 'lancers', 'hussars', 'reconnaissance']);
  const AIR = new Set(['fighter', 'bomber', 'reconair', 'seaplane']);
  // Liveries for the best-known air arms; other nations take the next free livery of their side, in faction order.
  const LIVERY_FOR = [
    [/german|prussia|bavaria|saxon/i, 'grey-cross'], [/austria|hungar|habsburg/i, 'olive-cross'], [/ottoman|turk/i, 'sand-cross'],
    [/bulgar/i, 'brown-cross'], [/united kingdom|brit|england|scot|canad|austral|new zealand|south africa|india|newfoundland/i, 'olive-roundel'],
    [/fran[cç]|french/i, 'khaki-tricolour'], [/belgi/i, 'linen-roundel'], [/united states|america|\busa?\b/i, 'silver-roundel'],
    [/russia/i, 'green-roundel'], [/ital/i, 'splinter'],
  ];
  const CENTRAL = /german|prussia|bavaria|saxon|austria|hungar|habsburg|ottoman|turk|bulgar/i;
  // The armies the figures come in. Factions saved before them chose a colour: grey, beige or green.
  const ARMIES = ['american', 'british', 'french', 'german', 'russian'];
  const LEGACY = { grey: 'german', beige: 'british', green: 'american' };
  // Defaults by nation name, keeping the 1914 sides apart at a glance: the Central Powers in German field grey, the
  // Empire in British khaki, France and Belgium in French blue, Russia, Italy and the Balkans in Russian olive, the
  // Americas as Americans. The GM can choose another on the faction.
  const AUTO = [
    [/german|prussia|bavaria|saxon|w[uü]rttemberg|austria|hungar|habsburg|ottoman|turk|bulgar|swed|norw|denmark|danish|netherland|dutch|swiss|switzerland|finland|poland|polish|czech|luxem|iceland/i, 'german'],
    [/united states|america|\busa?\b|brazil|mexic|argentin|chile|peru|venez|colombia|cuba|california|texas|navajo|\butes?\b|philipp|liberia|pacific/i, 'american'],
    [/fran[cç]|french|belgi|spain|spanish|morocc|tunis|tripol|congo|monaco|acadia|quebec/i, 'french'],
    [/russia|soviet|ital|sardinia|serbia|monteneg|romania|ukrain|lithuan|latvia|eston|greece|greek|china|chinese|qing|korea|persia/i, 'russian'],
    [/brit|england|scot|irish|ireland|wales|united kingdom|\buk\b|australia|new zealand|canad|india|south africa|newfoundland|japan|portug|siam|egypt|afghan|ethiop|abyssin|arab|nejd|hejaz|zanzibar|boer|muslim/i, 'british'],
  ];
  function uniformFor(name, chosen) {
    if (ARMIES.includes(chosen)) return chosen;
    if (LEGACY[chosen]) return LEGACY[chosen];
    const n = String(name || '');
    for (const [re, u] of AUTO) if (re.test(n)) return u;
    return ARMIES[strHash(n) % ARMIES.length];
  }
  // Where a kit has no figure for a role, the next in its list stands in.
  const STAND_IN = {
    'rifle.run': ['rifle.charge', 'rifle.idle', 'rifle.stand'], 'rifle.prone': ['rifle.kneel', 'rifle.stand'], 'rifle.kneel': ['rifle.stand', 'rifle.prone'],
    'rifle.stand': ['rifle.kneel', 'rifle.prone'], crew: ['rifle.idle', 'rifle.run', 'rifle.stand'], 'medic.kneel': ['crew'], 'medic.run': ['rifle.run'],
  };
  for (const who of ['officer', 'nco', 'lmg']) for (const p of ['prone', 'kneel', 'stand', 'run']) STAND_IN[who + '.' + p] = [...(who === 'officer' ? ['officer.stand'] : []), 'rifle.' + p];
  // A rifleman's stance on the line (by hash): lying, kneeling or standing to aim.
  const stanceOf = r => r < 0.45 ? 'prone' : r < 0.8 ? 'kneel' : 'stand';
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
      // Aircraft fly above the unit tokens (the renderer puts this layer over them): shadows, planes, then their fire.
      this.airLayer = new PIXI.Container(); this.airLayer.eventMode = 'none';
      this.shadowC = new PIXI.Container(); this.planeC = new PIXI.Container(); this.airG = new PIXI.Graphics();
      this.airLayer.addChild(this.shadowC, this.planeC, this.airG);
      this.squads = new Map();       // unit id -> squad
      this.uniforms = new Map();     // nation (lower case) -> uniform
      this.factions = [];
      this.tex = null; this.mach = null; this.mounts = null; this._liv = null;
      this._load();
    }
    async _load() {
      const frame = (base, f) => new PIXI.Texture({ source: base.source, frame: new PIXI.Rectangle(f.x, f.y, f.w, f.h) });
      try {
        const meta = await fetch('/assets/soldiers.json?v=2').then(r => r.json());
        const base = await PIXI.Assets.load({ src: '/assets/soldiers.png?v=2', loadParser: 'loadTextures' });
        const frames = meta.frames.map(([x, y, w, h, ax, ay, face], i) => ({ t: frame(base, { x, y, w, h }), w, h, ax, ay, face, len: Math.max(w, h), name: meta.names[i] }));
        this.tex = { torso: meta.torso, kits: Object.fromEntries(Object.entries(meta.kits).map(([k, roles]) =>
          [k, Object.fromEntries(Object.entries(roles).map(([r, ids]) => [r, ids.map(i => frames[i])]))])) };
        this.r.invalidate();
      } catch (e) { console.warn('Soldier sprites not available', e); }
      try {
        const meta = await fetch('/assets/machines.json?v=1').then(r => r.json());
        const base = await PIXI.Assets.load({ src: '/assets/machines.png?v=1', loadParser: 'loadTextures' });
        const one = f => ({ ...f, t: frame(base, f), len: Math.max(f.w, f.h) });
        this.mach = { tanks: meta.tanks.map(one), guns: Object.fromEntries(Object.entries(meta.guns).map(([k, f]) => [k, one(f)])) };
        this.r.invalidate();
      } catch (e) { console.warn('Gun and tank sprites not available', e); }
      try {
        const meta = await fetch('/assets/mounts.json?v=2').then(r => r.json());
        const base = await PIXI.Assets.load({ src: '/assets/mounts.png?v=2', loadParser: 'loadTextures' });
        const one = f => ({ ...f, t: frame(base, f), len: Math.max(f.w, f.h) });
        this.mounts = { planes: meta.planes.map(one), liveries: meta.liveries,
          riders: Object.fromEntries(Object.entries(meta.riders).map(([k, f]) => [k, one(f)])) };
        this._liv = null;
        this.r.invalidate();
      } catch (e) { console.warn('Cavalry and aircraft sprites not available', e); }
    }
    /** Faction list from the map page: [{ name, uniform }]. */
    setFactions(list) {
      this.factions = (list || []).map(f => ({ name: String(f.name || '').trim(), uniform: f.uniform }));
      this.uniforms = new Map(this.factions.map(f => [f.name.toLowerCase(), uniformFor(f.name, f.uniform)]));
      this._liv = null;
      for (const q of this.squads.values()) q.kit = null;
    }
    /**
     * Each nation's livery (mounts.json): the best-known air arms get their own, then every other nation takes the
     * next livery of its side not yet flown (crosses for the Central Powers and field-grey nations, roundels for the
     * rest, then unmarked ones), so two nations rarely fly look-alike planes.
     */
    _liveries() {
      if (this._liv || !this.mounts) return this._liv;
      const all = Object.entries(this.mounts.liveries), taken = new Set(), out = new Map();
      const pool = mark => [...all.filter(([, l]) => l.mark === mark), ...all.filter(([, l]) => l.mark === 'plain')].map(([k]) => k);
      for (const f of this.factions) {
        const p = LIVERY_FOR.find(([re]) => re.test(f.name)), key = f.name.toLowerCase();
        if (p && !taken.has(p[1]) && this.mounts.liveries[p[1]] && !out.has(key)) { out.set(key, p[1]); taken.add(p[1]); }
      }
      for (const f of this.factions) {
        const key = f.name.toLowerCase();
        if (out.has(key)) continue;
        const list = pool(CENTRAL.test(f.name) || uniformFor(f.name, f.uniform) === 'german' ? 'cross' : 'roundel');
        const l = list.find(k => !taken.has(k)) || list[strHash(key) % list.length];
        out.set(key, l); taken.add(l);
      }
      return (this._liv = out);
    }
    /** The plane frames a nation's squadrons fly: all of one livery. */
    planesFor(nation) {
      const n = String(nation || '').trim().toLowerCase(), m = this.mounts;
      let l = this._liveries()?.get(n);
      if (!l) { const list = Object.keys(m.liveries).filter(k => m.liveries[k].mark !== 'cross'); l = list[strHash(n) % list.length]; }
      return m.liveries[l].planes.map(i => m.planes[i]);
    }
    /**
     * What a unit shows in a fight: 'rifles' (infantry), 'guns' (artillery, machine guns), 'tanks', 'horse' (cavalry),
     * 'air' (aeroplanes), or null.
     */
    static kindOf(m) {
      const t = typeOf(m);
      if (!t) return null;
      if (t.id === 'tank') return 'tanks';
      if (t.cat === 'Artillery' || t.id === 'machinegun') return 'guns';
      if (t.cat === 'Infantry') return 'rifles';
      if (HORSE.has(t.id)) return 'horse';
      if (AIR.has(t.id)) return 'air';
      return null;
    }
    static isInfantry(m) { return Skirmish.kindOf(m) === 'rifles'; }
    /**
     * The kit a unit's men wear: its nation's army, in the kit for the game's year and season, plus the assault or
     * zouave figures for stormtroopers and French colonial troops. { army, line, special, key, cache }.
     */
    kitFor(m) {
      const n = String(m?.data?.nation || '').trim().toLowerCase();
      const army = this.uniforms.get(n) || uniformFor(n, '');
      const d = /^(\d{4})-(\d{2})/.exec(this.r.gameDate?.() || ''), y = d ? +d[1] : 1914, mo = d ? +d[2] : 7;
      const era = y >= 1916 ? '1916' : '1914', winter = mo >= 11 || mo <= 2;
      const kits = this.tex.kits, has = k => (kits[k] ? k : null);
      const line = has(`${army}-${era}${winter ? 'w' : ''}`) || has(`${army}-${era}`) || has(army) || has(`${army}-1914`) || Object.keys(kits)[0];
      const id = typeOf(m)?.id;
      const special = id === 'stormtroopers' ? has(`${army}-assault`) : id === 'colonial' && army === 'french' ? has('french-zouave') : null;
      return { army, line, special, key: `${line}|${special}`, cache: {} };
    }
    /** The figures a kit has for a role (its own, else its stand-ins'), assault or zouave figures first. */
    _frames(kit, role) {
      if (kit.cache[role]) return kit.cache[role];
      // The role, then its stand-ins, then theirs, nearest first.
      const K = this.tex.kits, chain = [role];
      for (let i = 0; i < chain.length; i++) for (const r of STAND_IN[chain[i]] || []) if (!chain.includes(r)) chain.push(r);
      let got = null;
      if (kit.special) for (const r of chain) if (K[kit.special][r]) { got = K[kit.special][r]; break; }
      if (!got) for (const r of chain) if (K[kit.line][r]) { got = K[kit.line][r]; break; }
      return (kit.cache[role] = got);
    }
    /** Whether the kit has any figure of its own for roles starting so ('lmg.': a light machine-gunner). */
    _has(kit, prefix) {
      const c = 'has ' + prefix, K = this.tex.kits;
      if (!(c in kit.cache)) kit.cache[c] = [kit.special, kit.line].some(k => k && Object.keys(K[k]).some(r => r.startsWith(prefix)));
      return kit.cache[c];
    }
    /** One man's figure for a role: always the same one of the kit's figures for him. */
    _pick(q, i, role) { const l = this._frames(q.kit, role); return l ? l[(i + q.id) % l.length] : null; }
    /** Machine-gun companies and trench mortars whose army has the art go in as teams (gun and crew in one figure). */
    _teamFor(q) { return q.kind !== 'guns' || !q.kit ? null : (q.type === 'machinegun' && this._frames(q.kit, 'mg')) ? 'mg' : (q.type === 'mortar' && this._frames(q.kit, 'mortar')) ? 'mortar' : null; }
    clear() { for (const q of this.squads.values()) this._drop(q); this.squads.clear(); this.airG.clear(); }
    _sprites(q) { return [...q.men.map(m => m.sp), ...q.machines.flatMap(x => x.sh ? [x.sp, x.sh] : [x.sp])]; }
    _drop(q) { for (const sp of this._sprites(q)) { sp.parent?.removeChild(sp); sp.destroy(); } }

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
     * width, world units), backPx (from the line back to the token, screen px), tx, ty (centre of the enemy's line),
     * createdAt, kind, shells }. Aircraft instead: { kind: 'air', view, mode ('orbit', 'strafe' or 'dogfight'), ax, ay
     * (what they fly over: their own token, the target, or the defender in a dogfight), hx, hy (their token), enemyId,
     * createdAt }.
     * `keep`: every unit still in a battle this turn (squads off screen keep their state). Draws flashes and smoke on
     * `g`. Returns true while a squad is on screen.
     */
    frame(fronts, keep, nowMs, s, g) {
      this.airG.clear();
      for (const [id, q] of this.squads) if (!keep.has(id)) { this._drop(q); this.squads.delete(id); }
      for (const [id, q] of this.squads) if (!fronts.has(id)) { q.shown = false; for (const sp of this._sprites(q)) sp.visible = false; }
      if (!this.tex || !fronts.size) return false;
      const stamp = String(this.r.gameDate?.() || '').slice(0, 7);
      if (stamp !== this._stamp) { this._stamp = stamp; for (const q of this.squads.values()) q.kit = null; }
      const t = nowMs / 1000, boost = Math.min(1.5, Math.max(1, s / 14));
      let drawn = false;
      for (const [id, f] of fronts) {
        if (f.kind !== 'rifles' && !this.mach) continue;
        if ((f.kind === 'horse' || f.kind === 'air') && !this.mounts) continue;
        let q = this.squads.get(id);
        if (q && q.kind !== f.kind) { this._drop(q); this.squads.delete(id); q = null; }
        if (!q) { q = this._make(id, f, nowMs, s); this.squads.set(id, q); }
        if (!q.kit) this._dress(q, f.view?.marker);
        if (q.kind === 'guns' && this._teamFor(q) !== q.team) { this._drop(q); q = this._make(id, f, nowMs, s); this.squads.set(id, q); }
        q.shown = true; drawn = true;
        this._tick(q, f, nowMs, t, s, boost, g);
      }
      return drawn;
    }
    /** Put the squad in its nation's uniform (and, for aircraft, its livery). */
    _dress(q, m) {
      q.kit = this.kitFor(m);
      for (const x of q.men) x.pose = null;
      if (q.kind === 'air') {
        const frames = this.planesFor(m?.data?.nation);
        q.machines.forEach((p, i) => {
          p.frame = frames[(i + q.id) % frames.length];
          for (const sp of [p.sp, p.sh]) { sp.texture = p.frame.t; sp.anchor.set(p.frame.ax, p.frame.ay); }
        });
      }
    }

    _make(id, f, nowMs, s) {
      const v = f.view, seed = id * 7.31, kind = f.kind;
      // Just fought: start from the strength before the blow, so the losses fall on screen.
      const drop = v?.strengthDrop && nowMs - v.strengthDrop.at < 8000 ? v.strengthDrop.from : null;
      const before = drop ?? strengthOf(v);
      const fresh = f.createdAt && Date.now() - f.createdAt < 10000;
      const q = { id, kind, men: [], machines: [], kit: null, nextDeath: 0, puffs: [], dust: [], tracers: [], shown: false, last: nowMs };
      if (kind === 'air') {
        q.type = typeOf(v?.marker)?.id || 'fighter';
        const alive = aliveFor(before, PLANES);
        for (let i = 0; i < PLANES; i++) {
          const p = { i, sp: new PIXI.Sprite(), sh: new PIXI.Sprite(), frame: null, dead: i >= alive, gone: i >= alive, fall: null,
            x: 0, y: 0, hd: 0, bank: 0, v: (FLY_PX_S[q.type] || 70) * (0.93 + hash(seed, i + 7) * 0.14), st: 'in', ex: null, ey: 0, until: 0,
            burst: 0, burstAt: 0, nextBurst: 0, flashAt: 0, tgt: null, retarget: 0, jink: 0, jinkUntil: 0, jinkDir: 1, smokeAt: 0 };
          p.sp.eventMode = p.sh.eventMode = 'none';
          p.sh.tint = 0x000000; p.sh.alpha = 0.22;
          this.shadowC.addChild(p.sh); this.planeC.addChild(p.sp);
          this._launch(p, f, s, fresh && f.mode !== 'orbit', hash(seed, i + 50));
          q.machines.push(p);
        }
        return q;
      }
      if (kind === 'horse') {
        const alive = aliveFor(before);
        // Just attacked: they ride straight out of the unit at the enemy. Otherwise they start formed up on the line.
        q.cycle = { st: fresh ? 'charge' : 'form', t0: nowMs, dur: fresh ? 0 : 1500 + hash(seed, 3) * 2000 };
        q.dustAt = 0;
        for (let i = 0; i < RIDERS; i++) {
          const o = (i + 0.5) / RIDERS - 0.5 + (hash(seed, i) - 0.5) * 0.05, d = 3 + hash(seed, i + 20) * 7;
          const m = { i, o, d, sp: new PIXI.Sprite(), pose: null, dead: i >= alive, fellAt: 0, rot: hash(seed, i + 100) * Math.PI * 2,
            flip: hash(seed, i + 120) < 0.5, jo: hash(seed, i + 140) - 0.5, jd: hash(seed, i + 160), pace: 0.88 + hash(seed, i + 180) * 0.24,
            co: o, cd: d, fo: o, fd: d, hd: null, phase: hash(seed, i + 80) * 6 };
          if (m.dead) { m.co = o + m.jo * 0.1; m.cd = d - m.jd * 30; }
          else if (fresh) { m.co = m.fo = 0; m.cd = m.fd = f.backPx; }
          m.sp.eventMode = 'none';
          (m.dead ? this.deadC : this.aliveC).addChild(m.sp);
          q.men.push(m);
        }
        return q;
      }
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
        q.type = typeOf(v?.marker)?.id;
        this._dress(q, v?.marker);
        q.team = this._teamFor(q);
        const key = GUN_FOR[q.type] || 'field', gf = q.team ? null : this.mach.guns[key];
        for (let i = 0; i < GUNS; i++) {
          const gn = { i, o: (i + 0.5) / GUNS - 0.5, d: 6 + hash(seed, i + 3) * 4, frame: gf, key: q.team || key, sp: new PIXI.Sprite(gf ? gf.t : undefined), manned: true,
            nextShot: nowMs + 800 + hash(seed, i + 30) * 4000, firedAt: 0, burst: 0, muzzle: null };
          if (gf) gn.sp.anchor.set(gf.ax, gf.ay);
          gn.sp.eventMode = 'none';
          this.machC.addChild(gn.sp);
          q.machines.push(gn);
        }
      }
      // The men: a gun's crew (two a gun), or an infantry section: officer, sergeant, light machine-gunner, medic and
      // riflemen, each to his own stance on the line.
      const alive = aliveFor(before), ROLES = ['officer', 'nco', 'lmg', 'medic'];
      for (let i = 0; i < SQUAD; i++) {
        const crew = kind === 'guns';
        // The first four are the officer, sergeant, gunner and medic (men already down when the section appears are
        // the last ones, so these four are there); their places along the line differ from unit to unit.
        const slot = (i * 3 + id) % SQUAD;
        const o = crew ? 0 : (slot + 0.5) / SQUAD - 0.5 + (hash(seed, i) - 0.5) * 0.06, d = crew ? 0 : 2 + hash(seed, i + 20) * 6;
        const role = crew ? 'crew' : i < 4 ? ROLES[(i + id) % 4] : 'rifle', r = hash(seed, i + 200);
        const stance = role === 'officer' ? (r < 0.5 ? 'kneel' : 'stand') : role === 'lmg' ? (r < 0.6 ? 'prone' : 'kneel') : stanceOf(r);
        const m = { i, o, d, home: [o, d], role, stance, sp: new PIXI.Sprite(), pose: null, dead: i >= alive, run: null, tend: null,
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
      const unit = TORSO_PX / this.tex.torso * boost / s;   // world units per soldier-atlas px, for every figure
      const ux = f.ux || 0, uy = f.uy || 0;
      if (q.kind === 'air') this._tickAir(q, f, nowMs, t, s, boost);
      else {
        const nx = -uy, ny = ux, theta = Math.atan2(uy, ux);
        const at = (o, d) => [f.cx + nx * o * f.front - ux * d / s, f.cy + ny * o * f.front - uy * d / s];
        if (q.kind === 'tanks') this._tickTanks(q, f, nowMs, t, s, boost, g, at, theta);
        else if (q.kind === 'horse') this._tickHorse(q, f, nowMs, t, s, boost, g, at, theta, unit);
        else {
          if (q.kind === 'guns') this._tickGuns(q, f, nowMs, t, s, boost, g, at, theta, unit);
          this._tickMen(q, f, nowMs, t, s, boost, g, at, theta, unit);
        }
      }
      // Dust thrown up on the ground (hooves, strafing rounds): small brown puffs.
      q.dust = q.dust.filter(p => nowMs - p.t0 < 700);
      for (const p of q.dust) {
        const age = (nowMs - p.t0) / 700;
        if (age < 0) continue;   // a round still on its way down
        g.circle(p.x, p.y, (1.6 + age * 3) * boost / s).fill({ color: 0xa08a68, alpha: 0.55 * (1 - age) });
      }
      // Smoke from shots and wrecks (and burning planes, drawn up with them): grey puffs that swell, drift and fade.
      const pg = q.kind === 'air' ? this.airG : g;
      q.puffs = q.puffs.filter(p => nowMs - p.t0 < 1400);
      for (const p of q.puffs) {
        const age = (nowMs - p.t0) / 1400, r = (p.big ? 5 : 3.2) * boost / s * (1 + age * 2.2);
        pg.circle(p.x - ux * age * 4 / s, p.y - uy * age * 4 / s - age * 6 / s, r).fill({ color: p.dark ? 0x3a3a3a : 0xd9d6cf, alpha: 0.45 * (1 - age) });
      }
    }

    // ---- Cavalry ---------------------------------------------------------------------------------------------------
    /**
     * The troop works in a cycle: form up on its line, charge the enemy's line at the gallop, fight there a moment
     * (the riders wheel among the enemy, blades flashing), ride back, and again. Positions are on the squad's front:
     * o across it (fraction of its width), d behind the line in screen px (negative: towards the enemy).
     */
    _tickHorse(q, f, nowMs, t, s, boost, g, at, theta, unit) {
      const rider = this.mounts.riders[RIDER_FOR[q.kit.army]] || this.mounts.riders.beige;
      const reach = Math.max(24, ((f.tx - f.cx) * f.ux + (f.ty - f.cy) * f.uy) * s);   // own line to theirs, px
      const living = q.men.filter(m => !m.dead);
      const want = aliveFor(strengthOf(f.view));
      if (living.length > want && nowMs >= q.nextDeath) {
        const m = living[Math.floor(Math.random() * living.length)];
        m.dead = true; m.fellAt = nowMs; m.pose = null;
        this.aliveC.removeChild(m.sp); this.deadC.addChild(m.sp);
        q.nextDeath = nowMs + 260 + Math.random() * 650;
      } else if (living.length < want) {
        const m = q.men.find(x => x.dead);
        if (m) { m.dead = false; m.pose = null; m.co = m.o; m.cd = m.d; this.deadC.removeChild(m.sp); this.aliveC.addChild(m.sp); }
      }
      // Where each rider is bound in this part of the cycle.
      const c = q.cycle;
      const goal = m => c.st === 'charge' || c.st === 'melee' ? [m.o * 0.85, -reach + 3 + m.jd * 6] : [m.o, m.d];
      const pace = c.st === 'charge' ? GALLOP_PX_S : c.st === 'back' ? GALLOP_PX_S * 0.85 : TROT_PX_S;
      if (!c.dur) {
        // The part lasts until the slowest rider gets there (or, formed up and fighting, a set while).
        c.dur = Math.max(800, ...living.map(m => { const [o, d] = goal(m); return Math.hypot((o - m.fo) * f.front * s, d - m.fd) / (pace * m.pace) * 1000; }));
      }
      if (nowMs >= c.t0 + c.dur) {
        const next = { form: 'charge', charge: 'melee', melee: 'back', back: 'form' }[c.st];
        for (const m of q.men) { m.fo = m.co; m.fd = m.cd; }
        q.cycle = { st: next, t0: nowMs, dur: next === 'melee' ? 2000 + Math.random() * 1500 : next === 'form' ? 2500 + Math.random() * 2500 : 0 };
        return this._tickHorse(q, f, nowMs, t, s, boost, g, at, theta, unit);
      }
      const galloping = c.st === 'charge' || c.st === 'back';
      for (const m of q.men) {
        const sp = m.sp;
        sp.visible = true;
        if (m.dead) {
          // Thrown where he fell; the horse is gone.
          this._pose(m, this._pick(q, m.i, 'dead'));
          const [x, y] = at(m.co, m.cd), age = nowMs - m.fellAt, k = m.fellAt && age < 320 ? age / 320 : 1;
          sp.position.set(x, y); sp.rotation = m.rot;
          const sc = unit * (1.25 - 0.25 * k);
          sp.scale.set(m.flip ? -sc : sc, sc);
          sp.alpha = 0.35 + 0.65 * k;
          continue;
        }
        if (m.pose !== 'ride') { sp.texture = rider.t; sp.anchor.set(rider.ax, rider.ay); m.pose = 'ride'; }
        sp.alpha = 1;
        const [go, gd] = goal(m);
        const own = Math.hypot((go - m.fo) * f.front * s, gd - m.fd) / (pace * m.pace) * 1000;
        const k = Math.min(1, (nowMs - c.t0) / Math.max(1, own));
        const e = c.st === 'charge' ? k * k * (1.4 - 0.4 * k) : k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // a charge gathers pace
        const po = m.co, pd = m.cd;
        m.co = m.fo + (go - m.fo) * e; m.cd = m.fd + (gd - m.fd) * e;
        let wo = 0, wd = 0;
        if (c.st === 'melee') {
          // Wheeling among the enemy: small loops, each rider his own.
          const a = t * 2.6 + m.phase;
          wo = Math.sin(a) * 9 / (f.front * s); wd = Math.cos(a) * 7;
        }
        const [x, y] = at(m.co + wo, m.cd + wd);
        // Heading: where he is going; standing, towards the enemy.
        const [x0, y0] = at(po, pd), moving = Math.hypot(x - x0, y - y0) * s > 0.05 || c.st === 'melee';
        let want = theta;
        if (c.st === 'melee') { const a = t * 2.6 + m.phase; want = Math.atan2(f.ux * Math.cos(a) * 9 + f.uy * Math.sin(a) * 7, -f.uy * Math.cos(a) * 9 + f.ux * Math.sin(a) * 7); }
        else if (moving && k < 1) want = Math.atan2(y - y0, x - x0);
        m.hd = m.hd == null ? want : m.hd + Math.atan2(Math.sin(want - m.hd), Math.cos(want - m.hd)) * Math.min(1, 0.25);
        sp.position.set(x, y);
        sp.rotation = m.hd + Math.PI / 2;
        const sc = RIDER_PX / rider.len * boost / s * (galloping && k < 1 ? 1 + 0.05 * Math.abs(Math.sin(t * 15 + m.i)) : 1);
        sp.scale.set(sc);
        if (c.st === 'melee' && Math.random() < 0.012) {
          // A blade or a lance point catching the light.
          const r = rider.len * sc * 0.35;
          g.circle(x + Math.cos(m.hd) * r, y + Math.sin(m.hd) * r, 1.6 * boost / s).fill({ color: 0xffffff, alpha: 0.9 });
        }
      }
      // Dust kicked up behind the galloping troop.
      if (galloping && nowMs - q.dustAt > 70) {
        const ms = q.men.filter(m => !m.dead);
        if (ms.length) {
          q.dustAt = nowMs;
          const m = ms[Math.floor(Math.random() * ms.length)], back = RIDER_PX * boost * 0.45;
          q.dust.push({ x: m.sp.x - Math.cos(m.hd) * back / s, y: m.sp.y - Math.sin(m.hd) * back / s, t0: nowMs });
        }
      }
    }

    // ---- Aircraft --------------------------------------------------------------------------------------------------
    // Planes live in world units but fly, turn and keep their distances in screen px, like everything else here.
    /** Put a plane in the air: coming from its unit's token towards the fight, or somewhere on its circle. */
    _launch(p, f, s, fromHome, r = Math.random()) {
      p.st = 'in'; p.ex = null; p.tgt = null;
      if (fromHome) {
        const dx = f.ax - f.hx, dy = f.ay - f.hy, L = Math.hypot(dx, dy), ux = L > 1e-9 ? dx / L : 1, uy = L > 1e-9 ? dy / L : 0;
        const back = Math.min(L, 260 / s) + p.i * 14 / s, side = (p.i - 1.5) * 16 / s;   // a loose echelon
        p.x = f.ax - ux * back - uy * side; p.y = f.ay - uy * back + ux * side; p.hd = Math.atan2(uy, ux);
      } else {
        const a = r * Math.PI * 2, R = (40 + (p.i % 2) * 9) / s;
        p.x = f.ax + Math.cos(a) * R; p.y = f.ay + Math.sin(a) * R; p.hd = a + Math.PI / 2;
      }
    }
    _tickAir(q, f, nowMs, t, s, boost) {
      const dt = Math.min(0.05, Math.max(0, (nowMs - q.last) / 1000));
      q.last = nowMs;
      const px = PLANE_PX[q.type] || 30, air = this.airG;
      const enemy = f.mode === 'dogfight' ? this.squads.get(f.enemyId) : null;
      const foes = enemy && enemy.kind === 'air' && enemy.shown ? enemy.machines.filter(p => !p.dead) : [];
      // Losses: a plane is shot down (one an enemy is chasing, if any: he fires on it) and spins away; healing
      // brings one back in from out of sight.
      const flying = q.machines.filter(p => !p.dead), want = aliveFor(strengthOf(f.view), PLANES);
      if (flying.length > want && nowMs >= q.nextDeath) {
        const hunted = flying.filter(p => foes.some(e => e.tgt === p));
        const p = (hunted.length ? hunted : flying)[Math.floor(Math.random() * (hunted.length || flying.length))];
        for (const e of foes) if (e.tgt === p) { e.burst = Math.max(e.burst, 6); e.nextBurst = nowMs + 1200; }
        p.dead = true; p.fall = { t0: nowMs, spin: (Math.random() < 0.5 ? -1 : 1) * (2.2 + Math.random() * 1.8) };
        q.nextDeath = nowMs + 500 + Math.random() * 900;
      } else if (flying.length < want) {
        const p = q.machines.find(x => x.gone);
        if (p) { p.dead = p.gone = false; p.fall = null; this._launch(p, f, s, false); const a = Math.random() * Math.PI * 2; p.x = f.ax + Math.cos(a) * 240 / s; p.y = f.ay + Math.sin(a) * 240 / s; p.hd = a + Math.PI; }
      }
      for (const p of q.machines) {
        if (p.gone) { p.sp.visible = p.sh.visible = false; continue; }
        if (p.fall) { this._fallPlane(q, p, nowMs, dt, s, boost, px); continue; }
        // Far off (after a zoom, or a new fight elsewhere): back into the picture, heading in.
        if (Math.hypot(p.x - f.ax, p.y - f.ay) * s > 700) { const a = Math.random() * Math.PI * 2; p.x = f.ax + Math.cos(a) * 300 / s; p.y = f.ay + Math.sin(a) * 300 / s; p.hd = a + Math.PI; p.st = 'in'; p.ex = null; }
        let goal;
        if (f.mode === 'strafe') goal = this._strafe(q, p, f, nowMs, s, boost);
        else if (f.mode === 'dogfight' && foes.length) goal = this._dogfight(q, p, f, foes, nowMs, s, boost);
        else goal = this._orbit(p, f, s);
        this._fly(p, goal[0], goal[1], dt, s, q.type);
        this._drawPlane(p, s, boost, px, 1);
        if (nowMs - p.flashAt < 50) { const [mx, my] = this._nose(p, s, boost, px); air.circle(mx, my, 2.4 * boost / s).fill({ color: 0xffe9a0, alpha: 0.9 }); }
      }
      // Tracer: short bright streaks flying on from the guns.
      q.tracers = q.tracers.filter(tr => nowMs - tr.t0 < 280);
      for (const tr of q.tracers) {
        const k = (nowMs - tr.t0) / 1000, x = tr.x + tr.vx * k, y = tr.y + tr.vy * k;
        air.moveTo(x, y).lineTo(x - tr.vx * 0.018, y - tr.vy * 0.018).stroke({ width: 1.3 * boost / s, color: 0xffd76a, alpha: 0.9 * (1 - k * 1000 / 280) });
      }
    }
    /** Turn towards (tx, ty) as fast as the plane can, then fly on; it banks into the turn. */
    _fly(p, tx, ty, dt, s, type) {
      const d = Math.atan2(Math.sin(Math.atan2(ty - p.y, tx - p.x) - p.hd), Math.cos(Math.atan2(ty - p.y, tx - p.x) - p.hd));
      const max = (TURN[type] || 2.4) * dt, turn = Math.max(-max, Math.min(max, d));
      p.hd += turn;
      p.bank += ((max ? turn / max : 0) - p.bank) * Math.min(1, dt * 5);
      const v = p.v / s * dt;
      p.x += Math.cos(p.hd) * v; p.y += Math.sin(p.hd) * v;
    }
    /** Draw a plane (nose up on the sheet) and its shadow; `alt` 1 in flight, falling to 0 as it goes down. */
    _drawPlane(p, s, boost, px, alt) {
      const sc = px / p.frame.len * boost / s * (0.55 + 0.45 * alt), roll = 1 - 0.3 * Math.abs(p.bank);
      p.sp.visible = p.sh.visible = true;
      p.sp.position.set(p.x, p.y); p.sp.rotation = p.hd + Math.PI / 2; p.sp.scale.set(sc * roll, sc);
      p.sh.position.set(p.x + 8 * alt * boost / s, p.y + 13 * alt * boost / s); p.sh.rotation = p.sp.rotation; p.sh.scale.set(sc * roll * 0.9, sc * 0.9);
    }
    _nose(p, s, boost, px) { const r = px * 0.42 * boost / s; return [p.x + Math.cos(p.hd) * r, p.y + Math.sin(p.hd) * r]; }
    /** Fire the guns: bursts of a few rounds (call while the target is in the sights). Strafing rounds kick up dust. */
    _guns(q, p, nowMs, s, boost, px, ground) {
      if (!p.burst && nowMs >= p.nextBurst) { p.burst = 5 + Math.floor(Math.random() * 6); p.nextBurst = nowMs + 1100 + Math.random() * 1200; }
      if (!p.burst || nowMs - p.burstAt < 75) return;
      p.burst--; p.burstAt = p.flashAt = nowMs;
      const [mx, my] = this._nose(p, s, boost, px), c = Math.cos(p.hd), sn = Math.sin(p.hd), j = (Math.random() - 0.5) * 0.05;
      q.tracers.push({ x: mx, y: my, vx: Math.cos(p.hd + j) * 430 / s, vy: Math.sin(p.hd + j) * 430 / s, t0: nowMs });
      if (ground) {
        const r = (38 + Math.random() * 30) / s, side = (Math.random() - 0.5) * 12 / s;
        q.dust.push({ x: p.x + c * r - sn * side, y: p.y + sn * r + c * side, t0: nowMs + 120 });
      }
    }
    /** Out of a fight (or with no enemy plane in the sky): circling over the unit, one behind the other. */
    _orbit(p, f, s) {
      const R = (40 + (p.i % 2) * 9) / s, a = Math.atan2(p.y - f.ay, p.x - f.ax) + 0.55;
      return [f.ax + Math.cos(a) * R, f.ay + Math.sin(a) * R];
    }
    /**
     * Strafing: each pass starts from a point about 120 px out, runs straight over the target with the guns going
     * (a bomber lets its bombs go over it instead), carries on a little, then turns back for the next pass from
     * another angle.
     */
    _strafe(q, p, f, nowMs, s, boost) {
      const px = PLANE_PX[q.type] || 30;
      if (p.ex == null) this._newRun(p, f, s, true);
      if (p.st === 'in') {
        if (Math.hypot(p.x - p.ex, p.y - p.ey) * s < 26) p.st = 'run';
        else return [p.ex, p.ey];
      }
      if (p.st === 'run') {
        const rx = f.ax - p.ex, ry = f.ay - p.ey, rl = Math.hypot(rx, ry) || 1;
        const past = ((p.x - f.ax) * rx + (p.y - f.ay) * ry) / rl * s;   // px beyond the target, along the pass
        if (past > 14) { p.st = 'out'; p.until = nowMs + 500 + Math.random() * 500; }
        else {
          const dist = Math.hypot(f.ax - p.x, f.ay - p.y) * s;
          const off = Math.atan2(Math.sin(Math.atan2(f.ay - p.y, f.ax - p.x) - p.hd), Math.cos(Math.atan2(f.ay - p.y, f.ax - p.x) - p.hd));
          if (q.type === 'bomber') { if (dist < 16 && !p.bombed) { p.bombed = true; this._bombs(p, s); } }
          else if (dist > 10 && dist < 100 && Math.abs(off) < 0.35) this._guns(q, p, nowMs, s, boost, px, true);
          return [f.ax + rx / rl * 80 / s, f.ay + ry / rl * 80 / s];
        }
      }
      if (nowMs >= p.until) { this._newRun(p, f, s, false); return [p.ex, p.ey]; }
      return [p.x + Math.cos(p.hd) * 50 / s, p.y + Math.sin(p.hd) * 50 / s];
    }
    _newRun(p, f, s, first) {
      // The heading of the next pass: straight in on the first, then back the way it came, from a new angle.
      const a = first ? Math.atan2(f.ay - p.y, f.ax - p.x) + (p.i - 1.5) * 0.15 : p.hd + Math.PI + (Math.random() - 0.5) * 1.8;
      const D = (105 + Math.random() * 40) / s;
      p.ex = f.ax - Math.cos(a) * D; p.ey = f.ay - Math.sin(a) * D; p.st = 'in'; p.bombed = false;
    }
    /** A stick of bombs bursting along the bomber's track. */
    _bombs(p, s) {
      const c = Math.cos(p.hd), sn = Math.sin(p.hd);
      for (let k = 0; k < 3; k++) {
        const along = (k * 14 + 6) / s, side = (Math.random() - 0.5) * 10 / s;
        this.r.explode(p.x + c * along - sn * side, p.y + sn * along + c * side, 46 + Math.random() * 18, 350 + k * 160, this.r.shellFrames);
      }
    }
    /**
     * A dogfight: each plane picks an enemy (the nearest, now and then another) and chases it, aiming a little ahead;
     * it fires when the enemy is close and in its sights, and when one is on its own tail it now and then breaks hard
     * to one side. Planes drifting too far from the fight turn back into it.
     */
    _dogfight(q, p, f, foes, nowMs, s, boost) {
      const px = PLANE_PX[q.type] || 30;
      if (!p.tgt || p.tgt.dead || !foes.includes(p.tgt) || nowMs >= p.retarget) {
        const near = [...foes].sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
        p.tgt = near[Math.random() < 0.7 ? 0 : Math.min(1, near.length - 1)];
        p.retarget = nowMs + 3000 + Math.random() * 4000;
      }
      if (nowMs >= p.jink) {
        const chased = foes.some(o => o.tgt === p && Math.hypot(o.x - p.x, o.y - p.y) * s < 70);
        if (chased && Math.random() < 0.025) { p.jinkUntil = nowMs + 600 + Math.random() * 700; p.jinkDir = Math.random() < 0.5 ? -1 : 1; p.jink = nowMs + 2500; }
      }
      if (nowMs < p.jinkUntil) { const a = p.hd + p.jinkDir * 1.4; return [p.x + Math.cos(a) * 40 / s, p.y + Math.sin(a) * 40 / s]; }
      if (Math.hypot(p.x - f.ax, p.y - f.ay) * s > 140) return [f.ax, f.ay];
      const e = p.tgt, dist = Math.hypot(e.x - p.x, e.y - p.y) * s, lead = Math.min(0.6, dist / 300);
      const off = Math.atan2(Math.sin(Math.atan2(e.y - p.y, e.x - p.x) - p.hd), Math.cos(Math.atan2(e.y - p.y, e.x - p.x) - p.hd));
      if (dist < 85 && Math.abs(off) < 0.22) this._guns(q, p, nowMs, s, boost, px, false);
      return [e.x + Math.cos(e.hd) * e.v / s * lead, e.y + Math.sin(e.hd) * e.v / s * lead];
    }
    /** Shot down: spinning, slowing, trailing black smoke and dropping towards its shadow, then a burst on the ground. */
    _fallPlane(q, p, nowMs, dt, s, boost, px) {
      const k = (nowMs - p.fall.t0) / 2400;
      if (k >= 1) { p.gone = true; p.sp.visible = p.sh.visible = false; p.sp.tint = 0xffffff; this.r.explode(p.x, p.y, 40); return; }
      p.hd += p.fall.spin * dt;
      const v = p.v * (1 - 0.6 * k) / s * dt;
      p.x += Math.cos(p.hd) * v; p.y += Math.sin(p.hd) * v;
      p.bank = 0.6;
      this._drawPlane(p, s, boost, px, 1 - k);
      p.sp.tint = 0x8c8c8c;
      if (nowMs - p.smokeAt > 70) { p.smokeAt = nowMs; q.puffs.push({ x: p.x, y: p.y, t0: nowMs, dark: true }); }
    }

    // ---- Infantry and gun crews ----------------------------------------------------------------------------------
    _tickMen(q, f, nowMs, t, s, boost, g, at, theta, unit) {
      const crew = q.kind === 'guns';
      const living = q.men.filter(m => !m.dead);
      // Casualties follow strength: one man per 12.5 % lost, falling one after another; healing brings them back.
      const want = aliveFor(strengthOf(f.view));
      if (living.length > want && nowMs >= q.nextDeath) {
        // The medic is hit last but two, so he is about to tend the fallen.
        const pool = living.length > 2 ? living.filter(x => x.role !== 'medic') : living;
        const m = pool[Math.floor(Math.random() * pool.length)];
        if (m.run) { const p = this._runPos(m, nowMs); m.o = p.o; m.d = p.d; m.run = null; }
        m.dead = true; m.fellAt = nowMs; m.pose = null; m.tend = null;
        this.aliveC.removeChild(m.sp); this.deadC.addChild(m.sp);
        q.nextDeath = nowMs + 260 + Math.random() * 650;
      } else if (living.length < want) {
        const m = q.men.find(x => x.dead);
        if (m) { m.dead = false; m.pose = null; if (!crew) [m.o, m.d] = m.home; this.deadC.removeChild(m.sp); this.aliveC.addChild(m.sp); }
      }
      if (crew) {
        // A crew stands either side of its gun, a little behind the breech; the fallen lie beside it. A team's men
        // are drawn with their gun, so only its fallen show, one each side of it.
        for (const m of q.men) {
          const gn = q.machines[m.gun];
          if (q.team) {
            const half = (gn.frame ? Math.min(gn.frame.w, gn.frame.h) * unit * s * 0.5 : 8) + 4 * boost;
            m.o = gn.o + half * m.side / (f.front * s) + m.jo * 0.02;
            m.d = gn.d + 3 + m.jd * 6;
            continue;
          }
          const px = this._gunScale(gn, boost, s) * s;   // screen px per gun-atlas px
          const lat = (Math.min(gn.frame.w, gn.frame.h) * px * 0.5 + 3 * boost) * m.side;
          m.o = gn.o + lat / (f.front * s) + (m.dead ? m.jo * 0.02 : 0);
          m.d = gn.d + gn.frame.len * px * 0.22 + (m.dead ? m.jd * 6 : 0);
        }
        for (const gn of q.machines) gn.manned = q.men.some(m => m.gun === gn.i && !m.dead);
      }
      const running = q.men.filter(m => m.run).length;
      const fallen = q.men.filter(m => m.dead);
      for (const m of q.men) {
        const sp = m.sp;
        sp.visible = true;
        if (m.dead) {
          this._pose(m, this._pick(q, m.i, 'dead'));
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
          if (q.team) { sp.visible = false; continue; }   // drawn with the gun
          // Working the gun: standing to it, facing the enemy, with a small bob as they load.
          const fr = this._pick(q, m.i, 'crew');
          this._pose(m, fr);
          const gn = q.machines[m.gun], busy = gn.firedAt && nowMs - gn.firedAt < 900;
          const [x, y] = at(m.o, m.d + (busy ? Math.sin((nowMs - gn.firedAt) / 90) * 0.8 : 0));
          sp.position.set(x, y);
          sp.rotation = theta + m.side * 0.35 - fr.face;
          sp.scale.set(unit);
          continue;
        }
        // The medic goes out to one of the fallen now and then, kneels by him a while, and comes back.
        if (m.role === 'medic' && !m.run && !m.tend && nowMs >= m.next) {
          const v = fallen[Math.floor(Math.random() * fallen.length)];
          if (v) {
            const side = Math.random() < 0.5 ? -1 : 1;
            m.run = { o0: m.o, d0: m.d, o1: v.o + side * 7 / (f.front * s), d1: v.d - 2, t0: nowMs, dur: 0, to: v };
          }
          m.next = nowMs + 4000 + Math.random() * 6000;
        } else if (m.role !== 'medic' && !m.run && nowMs >= m.next) {
          // Now and then a rifleman gets up and runs along the line to a new spot (two at most at a time).
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
          if (nowMs >= r.t0 + r.dur) {
            m.o = r.o1; m.d = r.d1; m.run = null; m.next = nowMs + 3500 + Math.random() * 8000;
            if (r.to) m.tend = { to: r.to, until: nowMs + 4000 + Math.random() * 3000 };
            if (r.home) m.next = nowMs + 5000 + Math.random() * 6000;
          } else if (nowMs >= r.t0) {
            const p = this._runPos(m, nowMs), [x, y] = at(p.o, p.d), [x0, y0] = at(r.o0, r.d0), [x1, y1] = at(r.o1, r.d1);
            const fr = this._pick(q, m.i, m.role === 'rifle' ? 'rifle.run' : m.role + '.run');
            this._pose(m, fr);
            sp.position.set(x, y);
            sp.rotation = Math.atan2(y1 - y0, x1 - x0) - fr.face;
            sp.scale.set(unit * (1 + 0.07 * Math.abs(Math.sin(t * 13 + m.i))));
            continue;
          } else { sp.visible = false; continue; }   // still waiting to leave the unit
        }
        if (m.tend) {
          // Kneeling by the wounded man, facing him; then back to his place on the line.
          const fr = this._pick(q, m.i, 'medic.kneel');
          this._pose(m, fr);
          const [x, y] = at(m.o, m.d), [vx, vy] = at(m.tend.to.o, m.tend.to.d);
          sp.position.set(x, y);
          sp.rotation = Math.atan2(vy - y, vx - x) - fr.face;
          sp.scale.set(unit);
          if (nowMs >= m.tend.until || !m.tend.to.dead) { m.tend = null; m.run = { o0: m.o, d0: m.d, o1: m.home[0], d1: m.home[1], t0: nowMs, dur: 0, home: true }; }
          continue;
        }
        // Holding the line: weapon on the enemy, a little sway, a kick and a flash with each shot (the light
        // machine-gunner in bursts). The medic waits, kneeling.
        const fr = this._pick(q, m.i, m.role === 'medic' ? 'medic.kneel' : `${m.role}.${m.stance}`);
        this._pose(m, fr);
        const shot = m.role === 'medic' ? false : m.role === 'lmg' && this._has(q.kit, 'lmg.')
          ? ((t + m.phase) % 3) < 0.9 && (t * 9) % 1 < 0.35
          : ((t + m.phase) % m.period) / m.period < 0.07;
        const aim = theta + Math.sin(t * 0.7 + m.phase * 2) * 0.1;
        const [x, y] = at(m.o, m.d + (shot ? 0.8 : 0));
        sp.position.set(x, y);
        sp.rotation = aim - fr.face;
        sp.scale.set(unit);
        if (shot && g) {
          const reach = fr.len * unit * 0.5, mx = x + Math.cos(aim) * reach, my = y + Math.sin(aim) * reach;
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
    _tickGuns(q, f, nowMs, t, s, boost, g, at, theta, unit) {
      const hmg = q.machines[0]?.key === 'hmg' || q.team === 'mg';
      for (const gn of q.machines) {
        if (q.team) { this._tickTeam(q, gn, f, nowMs, s, boost, g, at, theta, unit, hmg); continue; }
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

    /** A weapon team: gun and crew in one figure, facing the enemy; left empty (or greyed) when its crew are down. */
    _tickTeam(q, gn, f, nowMs, s, boost, g, at, theta, unit, hmg) {
      const fr = (!gn.manned && this._pick(q, gn.i, q.team + '.empty')) || this._pick(q, gn.i, q.team);
      if (gn.frame !== fr) { gn.frame = fr; gn.sp.texture = fr.t; gn.sp.anchor.set(fr.ax, fr.ay); }
      const since = nowMs - gn.firedAt, kick = gn.firedAt && since < 400 ? (1 - since / 400) * (hmg ? 0.5 : 1.5) * boost : 0;
      const [x, y] = at(gn.o, gn.d + kick);
      gn.sp.visible = true;
      gn.sp.position.set(x, y);
      gn.sp.rotation = theta - fr.face;
      gn.sp.scale.set(unit);
      gn.sp.tint = gn.manned || this._frames(q.kit, q.team + '.empty') ? 0xffffff : 0x6f6f6f;
      const reach = fr.len * unit * 0.45;
      gn.muzzle = [x + Math.cos(theta) * reach, y + Math.sin(theta) * reach];
      if (!gn.manned) return;
      if (hmg) {
        if (nowMs >= gn.nextShot) { gn.burst = 7 + Math.floor(Math.random() * 6); gn.nextShot = nowMs + 2200 + Math.random() * 2500; }
        if (gn.burst > 0 && (!gn.burstAt || nowMs - gn.burstAt > 110)) { gn.burst--; gn.burstAt = nowMs; gn.firedAt = nowMs; this._flash(g, gn.muzzle[0], gn.muzzle[1], 1.8 * boost / s); }
      } else {
        // A mortar: a thump and a puff from the tube now and then (its bombs come through fireGun when it shells).
        if (!f.shells && nowMs >= gn.nextShot) { gn.firedAt = nowMs; gn.nextShot = nowMs + 3000 + Math.random() * 4000; }
        if (gn.firedAt === nowMs) q.puffs.push({ x: gn.muzzle[0], y: gn.muzzle[1], t0: nowMs, big: true });
        if (gn.firedAt && nowMs - gn.firedAt < 100) this._flash(g, gn.muzzle[0], gn.muzzle[1], 2.2 * boost / s);
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
    _pose(m, fr) {
      if (!fr || m.pose === fr) return;
      m.sp.texture = fr.t; m.sp.anchor.set(fr.ax, fr.ay); m.pose = fr;
    }
  }
  Skirmish.uniformFor = uniformFor;
  window.Skirmish = Skirmish;
})();
