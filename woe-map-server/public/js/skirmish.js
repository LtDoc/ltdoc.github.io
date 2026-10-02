'use strict';
/* global PIXI */
/**
 * Units in a fight, drawn small on the map (docs/UNITS.md). While a unit is in a battle this turn its men and
 * machines hold a line a little ahead of its token, facing the enemy:
 *
 *   - infantry: a section of eight from its army's figures (public/assets/soldiers.png, scripts/build-soldiers.js):
 *     an officer, a sergeant, a light machine-gunner (from 1916, where the army has one), a medic and riflemen,
 *     spread out ahead of and behind the line, each lying, kneeling or standing to aim at the enemy; now and then
 *     one rushes forward or back to a new spot, and the medic goes out to the fallen and kneels by them a while;
 *   - machine-gun companies and trench mortars: four teams along the line, each a gun with its crew drawn together
 *     (the Vickers, MG 08, Hotchkiss, Browning, Maxim; the Stokes and the Minenwerfer); a team whose two men are both
 *     down leaves its gun standing empty, its crew lying beside it;
 *   - other artillery: four guns spread along the line (public/assets/machines.png, scripts/build-machines.js), each
 *     worked by two men of its army; guns recoil, flash and smoke as
 *     they fire (an artillery shell leaves from one of them), and fall silent when both their crew are down;
 *   - tanks: two, rolling out to the line and firing; a knocked-out one goes dark and smokes;
 *   - cavalry: eight horsemen (public/assets/mounts.png, scripts/build-mounts.js) who form up in echelon, charge
 *     through the enemy and on past him, loop wide round a flank back to their places and charge again; a fallen rider
 *     lies where he fell, beside his dead horse;
 *   - aircraft: four planes of one livery, flying over the map with their shadows below. Out of a fight they circle
 *     their unit; against ground or ships they make strafing runs over the target (bombers drop bombs on it);
 *     against other aircraft both squadrons mix it up over the fight, each plane chasing an enemy, firing when it
 *     has one in its sights and breaking hard when it is chased. A plane shot down spins away trailing smoke;
 *   - ships: each naval unit is a squadron or flotilla of its class (public/assets/ships.png, scripts/build-ships.js):
 *     two battleships, three armoured cruisers, six or seven destroyers, four to six submarines, a convoy of
 *     freighters… They lie in loose formation on the water, wakes streaming astern, also out of a fight. In a fight
 *     they turn their bows on the enemy and fire salvoes that raise splashes around him (or burst on land); destroyers,
 *     torpedo boats and submarines (running submerged) loose torpedoes. A ship lost lists, burns and goes down.
 *
 * Every round fired leaves the man or gun that fired it as a tracer and flies at one of the enemy's men (or
 * machines), at the weapon's rate: bolt-action rifles 10–15 rounds a minute, machine guns in bursts at their cyclic
 * rates (RIFLE_RPM, HMG_RPM, LMG_RPM); guns and tanks firing over open sights send a shell the same way.
 *
 * Losses follow strength: one man in eight per 12.5 % lost (at 50 %: four standing, four fallen), one tank in two per
 * 50 %, one plane in four per 25 %, one ship by its share of the squadron. Each nation fights as one of the armies the
 * art has: American, ANZAC, Arab, British, French, German, Ottoman or Russian (chosen on the faction, else guessed from
 * its name), so all of a nation's troops look alike; the kit follows the game's date (1916 helmets and gear from 1916,
 * the Ottomans' from 1918, greatcoats and winter dress from November to February); assault regiments go in as stormtroopers or trench raiders, French colonial troops as zouaves. Each
 * nation also has its own tank design and its own livery of planes (the Central Powers' with crosses, the others'
 * with roundels). The renderer hands over each squad's line every frame (MapRenderer._tickBattles).
 */
(function () {
  const SQUAD = 8, GUNS = 4, TANKS = 2;
  const DEPTH = [-16, 30];   // an infantry section's spread in depth, screen px behind its line (negative: ahead of it)
  const WIRE_D = -32;        // a dug-in unit's barbed-wire belt, screen px behind its line (ahead of its foremost men)
  // One scale for every figure, so they keep the art's proportions: a man's torso across on screen, px (before the zoom
  // boost; a man lying full length is then about 20 px).
  const TORSO_PX = 7;
  // Machines, by their longest side on screen (px, before the zoom boost), sized against those soldiers.
  const GUN_PX = { field: 20, heavy: 24, siege: 24, mortar: 11, horse: 24, hmg: 13 };
  const TANK_PX = 32;
  const RUN_PX_S = 34, ROLL_PX_S = 26;   // running and rolling pace, screen px a second
  // Horsemen (head to tail, lance and all) and planes (wingspan), screen px before the zoom boost.
  const RIDERS = 8, RIDER_PX = 34, GALLOP_PX_S = 49, CANTER_PX_S = 40, TROT_PX_S = 20;
  // Rates of fire, rounds a minute. Bolt-action rifles: aimed fire, 10 to 15 (the trained man's "mad minute" was 15).
  // Machine guns fire bursts at their cyclic rates: Vickers, MG 08 and Hotchkiss about 450, the Browning M1917 500, the
  // Russian Maxim 550; light machine guns: Lewis and BAR 550, MG 08/15 500, the Chauchat 240.
  const RIFLE_RPM = [10, 15];
  const HMG_RPM = { british: 450, anzac: 450, german: 450, ottoman: 450, french: 450, american: 500, russian: 550, arab: 550 };
  const LMG_RPM = { british: 550, anzac: 550, german: 500, french: 240, american: 550 };
  const ROUND_PX_S = 460;   // a round's flight, screen px a second (as the plain firing line's)
  const DEAD_HORSE_PX = 32;   // a dead horse lying on its side, nose to tail (screen px before the zoom boost)
  const CAMELS = new Set(['arab']);   // armies riding camels: no dead horse under their fallen
  // mounts.json riders (with "-2"…: others of the army, taken in turn)
  const RIDER_FOR = { british: 'beige', anzac: 'beige', german: 'grey', american: 'green', french: 'french', russian: 'russian', ottoman: 'ottoman', arab: 'arab' };
  const PLANES = 4;
  // Naval units: [ship class in ships.json, fewest and most ships in the unit, a ship's length on screen in px before
  // the zoom boost (big ships kept short against true scale, as the guns and tanks are), guns firing in a salvo,
  // time between salvoes (ms), torpedoes].
  const FLEET = {
    dreadnought: ['battleship', 2, 2, 84, 4, 4500, false], predreadnought: ['predreadnought', 2, 2, 76, 4, 5000, false],
    battlecruiser: ['battlecruiser', 2, 2, 90, 4, 4500, false], armouredcruiser: ['armouredcruiser', 3, 3, 70, 3, 4000, false],
    lightcruiser: ['lightcruiser', 3, 4, 62, 3, 3000, false], destroyer: ['destroyer', 6, 7, 40, 2, 2200, true],
    torpedoboat: ['smallcraft', 6, 8, 30, 1, 2600, true], submarine: ['submarine', 4, 6, 34, 0, 0, true],
    minelayer: ['smallcraft', 2, 3, 38, 1, 3500, false], gunboat: ['smallcraft', 3, 4, 30, 2, 2600, false],
    transport: ['merchant', 5, 6, 48, 0, 0, false], seaplanecarrier: ['merchant', 1, 1, 60, 1, 4000, false],
  };
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
  const ARMIES = ['american', 'anzac', 'arab', 'british', 'french', 'german', 'ottoman', 'russian'];
  const LEGACY = { grey: 'german', beige: 'british', green: 'american' };
  // Defaults by nation name, keeping the 1914 sides apart at a glance: the Central Powers in German field grey (the
  // Ottomans as themselves), the Empire in British khaki (Australia and New Zealand as the ANZACs), France and Belgium
  // in French blue, Russia, Italy and the Balkans in Russian olive, the Americas as Americans, Arabia as Arab
  // irregulars. The GM can choose another on the faction.
  const AUTO = [
    [/ottoman|turk/i, 'ottoman'],
    [/austral|new zealand|anzac/i, 'anzac'],
    [/arab|nejd|hejaz|hijaz|yemen|\boman\b|kuwait|qatar|trucial|senussi|bedouin|shammar|rashid/i, 'arab'],
    [/german|prussia|bavaria|saxon|w[uü]rttemberg|austria|hungar|habsburg|bulgar|swed|norw|denmark|danish|netherland|dutch|swiss|switzerland|finland|poland|polish|czech|luxem|iceland/i, 'german'],
    [/united states|america|\busa?\b|brazil|mexic|argentin|chile|peru|venez|colombia|cuba|california|texas|navajo|\butes?\b|philipp|liberia|pacific/i, 'american'],
    [/fran[cç]|french|belgi|spain|spanish|morocc|tunis|tripol|congo|monaco|acadia|quebec/i, 'french'],
    [/russia|soviet|ital|sardinia|serbia|monteneg|romania|ukrain|lithuan|latvia|eston|greece|greek|china|chinese|qing|korea|persia/i, 'russian'],
    [/brit|england|scot|irish|ireland|wales|united kingdom|\buk\b|canad|india|south africa|newfoundland|japan|portug|siam|egypt|afghan|ethiop|abyssin|zanzibar|boer|muslim/i, 'british'],
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
  // A point on two cubic curves end to end (pts: 7 points, the middle one shared), u from 0 to 1 over both.
  const bez2 = (pts, u) => {
    const j = u < 0.5 ? 0 : 3, k = u < 0.5 ? u * 2 : (u - 0.5) * 2, a = 1 - k;
    const w = [a * a * a, 3 * a * a * k, 3 * a * k * k, k * k * k];
    return [0, 1].map(c => w[0] * pts[j][c] + w[1] * pts[j + 1][c] + w[2] * pts[j + 2][c] + w[3] * pts[j + 3][c]);
  };
  // The curve parameter at fraction k of the way along it, by its table of distances (lut: 41 entries).
  const arcU = (lut, k) => {
    const want = k * lut[lut.length - 1];
    let i = 1;
    while (i < lut.length - 1 && lut[i] < want) i++;
    const span = lut[i] - lut[i - 1];
    return (i - 1 + (span > 0 ? (want - lut[i - 1]) / span : 0)) / (lut.length - 1);
  };
  const hash = (a, b) => { const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); };
  const aliveFor = (strength, n = SQUAD) => Math.max(0, Math.min(n, Math.ceil(Number(strength) / (100 / n) - 1e-9)));
  const strengthOf = v => (!v || v.dying) ? 0 : Number(v.marker?.data?.strength ?? 100);
  const typeOf = m => (m && m.type === 'unit' && window.UnitTypes) ? window.UnitTypes.resolve(m.data?.unitType) : null;

  class Skirmish {
    constructor(renderer) {
      this.r = renderer;
      this.layer = new PIXI.Container(); this.layer.eventMode = 'none';
      this.deadC = new PIXI.Container(); this.machC = new PIXI.Container(); this.aliveC = new PIXI.Container();
      this.groundG = new PIXI.Graphics();   // dug in: rifle pits, sandbags, gun pits and wire, under the men
      this.layer.addChild(this.groundG, this.deadC, this.machC, this.aliveC);
      // Aircraft fly above the unit tokens (the renderer puts this layer over them): shadows, planes, then their fire.
      this.airLayer = new PIXI.Container(); this.airLayer.eventMode = 'none';
      this.shadowC = new PIXI.Container(); this.planeC = new PIXI.Container(); this.airG = new PIXI.Graphics();
      this.airLayer.addChild(this.shadowC, this.planeC, this.airG);
      this.squads = new Map();       // unit id -> squad
      this.uniforms = new Map();     // nation (lower case) -> uniform
      this.factions = [];
      this.tex = null; this.mach = null; this.mounts = null; this.ships = null; this._liv = null;
      this._load();
    }
    async _load() {
      const frame = (base, f) => new PIXI.Texture({ source: base.source, frame: new PIXI.Rectangle(f.x, f.y, f.w, f.h) });
      try {
        const meta = await fetch('/assets/soldiers.json?v=3').then(r => r.json());
        const base = await PIXI.Assets.load({ src: '/assets/soldiers.png?v=3', loadParser: 'loadTextures' });
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
        const meta = await fetch('/assets/mounts.json?v=4').then(r => r.json());
        const base = await PIXI.Assets.load({ src: '/assets/mounts.png?v=4', loadParser: 'loadTextures' });
        const one = f => ({ ...f, t: frame(base, f), len: Math.max(f.w, f.h) });
        this.mounts = { planes: meta.planes.map(one), liveries: meta.liveries,
          riders: Object.fromEntries(Object.entries(meta.riders).map(([k, f]) => [k, one(f)])), dead: (meta.dead || []).map(one) };
        this._liv = null;
        this.r.invalidate();
      } catch (e) { console.warn('Cavalry and aircraft sprites not available', e); }
      try {
        const meta = await fetch('/assets/ships.json?v=1').then(r => r.json());
        const base = await PIXI.Assets.load({ src: '/assets/ships.png?v=1', loadParser: 'loadTextures' });
        this.ships = Object.fromEntries(Object.entries(meta.classes).map(([k, l]) =>
          [k, l.map(([x, y, w, h, ax, ay]) => ({ t: frame(base, { x, y, w, h }), w, h, ax, ay }))]));
        this.r.invalidate();
      } catch (e) { console.warn('Ship sprites not available', e); }
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
     * 'air' (aeroplanes), 'ships' (naval units), or null.
     */
    static kindOf(m) {
      const t = typeOf(m);
      if (!t) return null;
      if (t.id === 'tank') return 'tanks';
      if (t.cat === 'Artillery' || t.id === 'machinegun') return 'guns';
      if (t.cat === 'Infantry') return 'rifles';
      if (HORSE.has(t.id)) return 'horse';
      if (AIR.has(t.id)) return 'air';
      if (FLEET[t.id]) return 'ships';
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
      const winter = mo >= 11 || mo <= 2;
      const kits = this.tex.kits, has = k => (kits[k] ? k : null);
      // The army's latest kit of the year or before (1914, 1916, 1918), in winter dress if it has one.
      let line = null;
      for (const era of ['1918', '1916', '1914']) if (+era <= y && (line = (winter && has(`${army}-${era}w`)) || has(`${army}-${era}`))) break;
      line = line || has(army) || has(`${army}-1914`) || Object.keys(kits)[0];
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
    _sprites(q) { return [...q.men.flatMap(m => m.carcass ? [m.sp, m.carcass] : [m.sp]), ...q.machines.flatMap(x => x.sh ? [x.sp, x.sh] : [x.sp])]; }
    /** A dead horse's sprite, under every fallen man. */
    _carcass() { const h = new PIXI.Sprite(); h.eventMode = 'none'; this.deadC.addChildAt(h, 0); return h; }
    _drop(q) { for (const sp of this._sprites(q)) { sp.parent?.removeChild(sp); sp.destroy(); } }

    /**
     * An artillery unit fires a shell (MapRenderer, shelling): one of its working guns recoils and flashes, and the
     * shell leaves from its muzzle. Returns that point (world units), or null when its guns are not on screen.
     */
    fireGun(unitId, nowMs) {
      const q = this.squads.get(unitId);
      if (q && q.kind === 'ships' && q.shown) return this._shipShot(q, nowMs);
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
     * createdAt }. Ships out of a fight: { kind: 'ships', view, idle: true, cx, cy (their token), ux (1: bows to the
     * right, -1: to the left), uy: 0 }.
     * `keep`: every unit still in a battle this turn (squads off screen keep their state). Draws flashes and smoke on
     * `g`. Returns true while a squad is on screen.
     */
    frame(fronts, keep, nowMs, s, g) {
      this.airG.clear();
      this.groundG.clear();
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
        if (f.kind === 'ships' && !this.ships) continue;
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
      if (kind === 'ships') {
        const type = typeOf(v?.marker)?.id, [cls, lo, hi] = FLEET[type] || FLEET.destroyer;
        const frames = this.ships[cls], n = lo + Math.floor(hash(seed, 1) * (hi - lo + 1)), alive = aliveFor(before, n);
        // Warships of a class come in one design per nation; a convoy is a mix of freighters.
        const design = strHash(v?.marker?.data?.nation) % frames.length;
        q.type = type; q.torps = []; q.foam = [];
        for (let k = 0; k < n; k++) {
          const fr = frames[cls === 'merchant' ? (design + k * 5) % frames.length : design];
          const sh = { k, fr, sp: new PIXI.Sprite(fr.t), dead: k >= alive, gone: k >= alive, sink: null, phase: hash(seed, k + 30) * 6,
            jx: hash(seed, k + 50) - 0.5, nextShot: nowMs + 600 + hash(seed, k + 70) * 3000, firedAt: 0, foamAt: 0, torpAt: nowMs + 3000 + hash(seed, k + 90) * 14000, guns: [] };
          sh.sp.anchor.set(fr.ax, fr.ay); sh.sp.eventMode = 'none';
          this.machC.addChild(sh.sp);
          q.machines.push(sh);
        }
        return q;
      }
      if (kind === 'horse') {
        const alive = aliveFor(before);
        // Formed in echelon: each rider beside the next and a little behind him, the line slanting back to one side;
        // after each charge the troop wheels away round one flank (q.loop). Just attacked, they ride straight out of
        // the unit at the enemy; otherwise they stand formed up a moment first.
        q.ech = hash(seed, 5) < 0.5 ? -1 : 1; q.loop = hash(seed, 6) < 0.5 ? -1 : 1;
        q.cycle = { st: 'form', until: fresh ? nowMs : nowMs + 1500 + hash(seed, 3) * 2000 };
        q.dustAt = 0;
        for (let i = 0; i < RIDERS; i++) {
          const rank = q.ech > 0 ? i : RIDERS - 1 - i;
          const o = ((i + 0.5) / RIDERS - 0.5) * 0.95 + (hash(seed, i) - 0.5) * 0.03, d = 4 + rank * 10 + hash(seed, i + 20) * 3;
          const m = { i, o, d, sp: new PIXI.Sprite(), pose: null, dead: i >= alive, fellAt: 0, rot: hash(seed, i + 100) * Math.PI * 2,
            flip: hash(seed, i + 120) < 0.5, jo: hash(seed, i + 140) - 0.5, jd: hash(seed, i + 160), pace: 0.92 + hash(seed, i + 180) * 0.16,
            co: o, cd: d, hd: null, leg: null };
          if (m.dead) { m.co = o + m.jo * 0.1; m.cd = d - m.jd * 30; }
          else if (fresh) { m.co = 0; m.cd = f.backPx; }
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
        // Spread out rather than in a line: across the front, and in depth from a little ahead of the line to well
        // behind it.
        const o = crew ? 0 : (slot + 0.5) / SQUAD - 0.5 + (hash(seed, i) - 0.5) * 0.09, d = crew ? 0 : DEPTH[0] + hash(seed, i + 20) * (DEPTH[1] - DEPTH[0]);
        let role = crew ? 'crew' : i < 4 ? ROLES[(i + id) % 4] : 'rifle';
        if (role === 'medic' && !this._has(this.kitFor(v?.marker), 'medic.')) role = 'rifle';   // an army drawn without medics
        const r = hash(seed, i + 200);
        const stance = role === 'officer' ? (r < 0.5 ? 'kneel' : 'stand') : role === 'lmg' ? (r < 0.6 ? 'prone' : 'kneel') : stanceOf(r);
        // Each man's own rate of fire (seconds a round), the officer's slower.
        const period = 60 / (RIFLE_RPM[0] + hash(seed, i + 60) * (RIFLE_RPM[1] - RIFLE_RPM[0])) * (role === 'officer' ? 1.6 : 1);
        const m = { i, o, d, home: [o, d], role, stance, sp: new PIXI.Sprite(), pose: null, dead: i >= alive, run: null, tend: null,
          gun: crew ? i % GUNS : -1, side: crew ? (i < GUNS ? -1 : 1) : 0,
          next: nowMs + 2500 + hash(seed, i + 40) * 9000, period, nextShot: nowMs + 600 + hash(seed, i + 80) * period * 1000, firedAt: 0, burst: 0,
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
      else if (q.kind === 'ships') this._tickShips(q, f, nowMs, t, s, boost, g);
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
      if (g) this._drawRounds(q, nowMs, s, g);
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
     * The troop works in a cycle: formed up in echelon on its line, it charges at the gallop straight through the
     * enemy's line and on past it, swings round in a wide loop out on one flank, canters back to its place and forms
     * up again. Positions are on the squad's front: o across it (fraction of its width), d behind the line in screen
     * px (negative: towards the enemy). Each rider rides his own leg of the cycle (m.leg), laid out in those terms
     * (across in px) when he sets off.
     */
    _tickHorse(q, f, nowMs, t, s, boost, g, at, theta, unit) {
      if (q.riders?.army !== q.kit.army) {
        const R = this.mounts.riders, key = RIDER_FOR[q.kit.army] || 'beige';
        const pool = Object.keys(R).filter(k => k === key || k.startsWith(key + '-')).map(k => R[k]);
        q.riders = { army: q.kit.army, pool: pool.length ? pool : [R.beige] };
      }
      const pool = q.riders.pool;
      const F = f.front * s, reach = Math.max(24, ((f.tx - f.cx) * f.ux + (f.ty - f.cy) * f.uy) * s);   // own line to theirs, px
      const dt = Math.min(0.1, (nowMs - (q.hLast || nowMs)) / 1000); q.hLast = nowMs;
      let living = q.men.filter(m => !m.dead);
      const want = aliveFor(strengthOf(f.view));
      if (living.length > want && nowMs >= q.nextDeath) {
        const m = living[Math.floor(Math.random() * living.length)];
        m.dead = true; m.fellAt = nowMs; m.pose = null; m.leg = null;
        m.co += m.jo * 0.12; m.cd += (m.jd - 0.5) * 24;   // the horse goes down a little off his line
        this.aliveC.removeChild(m.sp); this.deadC.addChild(m.sp);
        q.nextDeath = nowMs + 260 + Math.random() * 650;
      } else if (living.length < want) {
        const m = q.men.find(x => x.dead);
        if (m) { m.dead = false; m.pose = null; m.co = m.o; m.cd = m.d; m.leg = null; this.deadC.removeChild(m.sp); this.aliveC.addChild(m.sp); }
      }
      living = q.men.filter(m => !m.dead);
      const carcasses = !CAMELS.has(q.kit.army) && this.mounts.dead?.length ? this.mounts.dead : null;
      const foe = f.enemyId != null ? this.squads.get(f.enemyId) : null;
      // All back in their places: stand a while, then charge again, every rider straight ahead through the enemy's
      // line to a point well past it (the echelon held, a little closed up).
      const c = q.cycle;
      if (c.st === 'go' && living.every(m => !m.leg)) { c.st = 'form'; c.until = nowMs + 2500 + Math.random() * 2500; }
      if (c.st === 'form' && nowMs >= c.until && living.length) {
        c.st = 'go';
        for (const m of living) {
          const from = [m.co * F, m.cd], to = [m.o * F, -(reach + 115 + m.jd * 15) + (m.d - 4) * 0.5];
          m.leg = { st: 'charge', t0: nowMs, from, to, dur: Math.max(600, Math.hypot(to[0] - from[0], to[1] - from[1]) / (GALLOP_PX_S * m.pace) * 1000) };
        }
      }
      for (const m of q.men) {
        const sp = m.sp, rider = pool[m.i % pool.length];
        sp.visible = true;
        if (m.dead) {
          // His horse dead where he fell, and he thrown off it, lying just off its back (the top edge of the art).
          this._pose(m, this._pick(q, m.i, 'dead'));
          const [x, y] = at(m.co, m.cd), age = nowMs - m.fellAt, k = m.fellAt && age < 320 ? age / 320 : 1;
          let mx = x, my = y;
          const hf = carcasses && carcasses[(m.i + q.id) % carcasses.length];
          if (hf) {
            const h = m.carcass || (m.carcass = this._carcass());
            if (h.texture !== hf.t) { h.texture = hf.t; h.anchor.set(hf.ax, hf.ay); }
            const hs = DEAD_HORSE_PX / hf.w * boost / s;
            h.visible = true; h.position.set(x, y); h.rotation = m.rot; h.scale.set(m.flip ? -hs : hs, hs); h.alpha = k;
            const lx = m.jo * 0.6 * hf.w * hs, ly = -(hf.ay * hf.h * hs + (3 + m.jd * 4) * boost / s);
            mx = x + lx * Math.cos(m.rot) - ly * Math.sin(m.rot); my = y + lx * Math.sin(m.rot) + ly * Math.cos(m.rot);
          } else if (m.carcass) m.carcass.visible = false;
          sp.position.set(mx, my); sp.rotation = m.rot + (hf ? (m.jd - 0.5) * 2.4 : 0);
          const sc = unit * (1.25 - 0.25 * k);
          sp.scale.set(m.flip ? -sc : sc, sc);
          sp.alpha = 0.35 + 0.65 * k;
          continue;
        }
        if (m.carcass) m.carcass.visible = false;
        if (m.pose !== 'ride') { sp.texture = rider.t; sp.anchor.set(rider.ax, rider.ay); m.pose = 'ride'; }
        sp.alpha = 1;
        let lat = m.co * F, dep = m.cd;
        const L = m.leg;
        if (L?.st === 'charge') {
          // Gathering pace from a canter to a full gallop; slowed to a struggle through the enemy's wire, if he has any
          // (his belt lies WIRE_D ahead of his line, so that far short of it on this side).
          const wire = foe?.wireAt && Math.abs(dep - (-reach - WIRE_D)) < 9;
          L.k = Math.min(1, (L.k || 0) + dt * 1000 / L.dur * (wire ? 0.22 : 1));
          const k = L.k, e = k * (0.5 + 0.5 * k);
          lat = L.from[0] + (L.to[0] - L.from[0]) * e; dep = L.from[1] + (L.to[1] - L.from[1]) * e;
          if (wire) lat += Math.sin(t * 17 + m.i * 3) * 0.6;   // horses balking, riders hacking at the wire
          if (k >= 1) m.leg = this._wheel(q, m, L.to, F, reach, nowMs);
        } else if (L?.st === 'wheel') {
          const k = Math.min(1, (nowMs - L.t0) / L.dur);
          [lat, dep] = bez2(L.pts, arcU(L.lut, k));
          if (k >= 1) { m.leg = null; lat = m.o * F; dep = m.d; }
        } else {
          // In his place, or walking his horse there (back on his feet, or the troop's line moved).
          const hx = m.o * F, dx = hx - lat, dd = m.d - dep, dist = Math.hypot(dx, dd), step = TROT_PX_S * dt;
          if (dist > step) { lat += dx / dist * step; dep += dd / dist * step; } else { lat = hx; dep = m.d; }
        }
        m.co = lat / F; m.cd = dep;
        const [x, y] = at(m.co, m.cd);
        // Heading: where he is going; standing, towards the enemy.
        let want = theta;
        if (m.wx != null && Math.hypot(x - m.wx, y - m.wy) * s > 0.05) want = Math.atan2(y - m.wy, x - m.wx);
        m.wx = x; m.wy = y;
        m.hd = m.hd == null ? want : m.hd + Math.atan2(Math.sin(want - m.hd), Math.cos(want - m.hd)) * 0.2;
        sp.position.set(x, y);
        sp.rotation = m.hd + Math.PI / 2;
        const sc = RIDER_PX / rider.len * boost / s * (m.leg ? 1 + 0.05 * Math.abs(Math.sin(t * 11 + m.i)) : 1);
        sp.scale.set(sc);
        if (m.leg?.st === 'charge' && Math.abs(dep + reach) < 18 && Math.random() < 0.06) {
          // Riding through the enemy's line: a blade or a lance point catching the light.
          const r = rider.len * sc * 0.35;
          g.circle(x + Math.cos(m.hd) * r, y + Math.sin(m.hd) * r, 1.6 * boost / s).fill({ color: 0xffffff, alpha: 0.9 });
        }
      }
      // Dust kicked up behind the riding troop.
      const riding = q.men.filter(m => !m.dead && m.leg);
      if (riding.length && nowMs - q.dustAt > 70) {
        q.dustAt = nowMs;
        const m = riding[Math.floor(Math.random() * riding.length)], back = RIDER_PX * boost * 0.45;
        q.dust.push({ x: m.sp.x - Math.cos(m.hd) * back / s, y: m.sp.y - Math.sin(m.hd) * back / s, t0: nowMs });
      }
    }
    /**
     * The way back after a charge: on past the enemy's line, round in a wide loop out beyond the troop's flank (each
     * rider keeping his place across the troop, roughly), and in to his place from behind, ending facing the enemy.
     * Two cubic curves, with a table of distance along them so he rides it at an even canter.
     */
    _wheel(q, m, from, F, reach, nowMs) {
      const H = [m.o * F, m.d], sg = q.loop, A = [sg * (F / 2 + 70) + H[0] * 0.35, -reach * 0.45];
      const pts = [from, [from[0], from[1] - 55], [A[0], A[1] - 75], A, [A[0], A[1] + 75], [H[0] + sg * 25, H[1] + 55], H];
      const lut = [0];
      let prev = from, len = 0;
      for (let i = 1; i <= 40; i++) { const p = bez2(pts, i / 40); len += Math.hypot(p[0] - prev[0], p[1] - prev[1]); lut.push(len); prev = p; }
      return { st: 'wheel', t0: nowMs, pts, lut, dur: Math.max(800, len / (CANTER_PX_S * m.pace) * 1000) };
    }

    // ---- Ships -----------------------------------------------------------------------------------------------------
    /**
     * A squadron lies in loose formation around its point (its token, or its line in a fight), ships one behind the
     * other down the screen, bows on the enemy (the art is in profile, so they face left or right). Each rolls a
     * little and leaves foam streaming astern. In a fight they fire salvoes: flashes along the deck, smoke, and
     * after the flight time splashes around the enemy's line (shell bursts if he is ashore); torpedo craft loose
     * torpedoes that run to the enemy and end in a column of water.
     */
    _tickShips(q, f, nowMs, t, s, boost, g) {
      const [, , , lenPx, guns, every, torpedoes] = FLEET[q.type] || FLEET.destroyer;
      const L = lenPx * boost, sub = q.type === 'submarine', face = (f.ux || 1) >= 0 ? 1 : -1, n = q.machines.length;
      const fight = !f.idle && f.tx != null;
      // Losses: a ship goes down per share of strength lost; repairs bring one back.
      const afloat = q.machines.filter(sh => !sh.dead), want = aliveFor(strengthOf(f.view), n);
      if (afloat.length > want && nowMs >= q.nextDeath) {
        const sh = afloat[Math.floor(Math.random() * afloat.length)];
        sh.dead = true; sh.sink = { t0: nowMs, dir: Math.random() < 0.5 ? -1 : 1 };
        this.r.explode(sh.sp.x, sh.sp.y - 3 / s, Math.max(36, L * 0.6));
        q.nextDeath = nowMs + 900 + Math.random() * 900;
      } else if (afloat.length < want) {
        const sh = q.machines.find(x => x.gone);
        if (sh) { sh.dead = sh.gone = false; sh.sink = null; sh.sp.alpha = 0; sh.risen = nowMs; }
      }
      for (const sh of q.machines) {
        const sp = sh.sp, fr = sh.fr, sc = L / fr.w / s;
        if (sh.gone) { sp.visible = false; continue; }
        // Station in the formation, screen px from the point: each ship a little lower (nearer) than the one before.
        const dy = (sh.k - (n - 1) / 2) * L * (sub ? 0.36 : 0.3), dx = (sh.k % 2 ? 1 : -1) * L * 0.2 + sh.jx * L * 0.25 + Math.sin(t * 0.25 + sh.phase) * 3 * boost;
        let x = f.cx + dx / s, y = f.cy + (dy + Math.sin(t * 1.3 + sh.phase) * 0.6) / s, roll = Math.sin(t * 0.9 + sh.phase) * 0.015, alpha = sub ? 0.5 : 1;
        if (sh.sink) {
          // Hit and going down: listing, settling and fading, smoke and fire pouring from her.
          const k = Math.min(1, (nowMs - sh.sink.t0) / 4500);
          roll += sh.sink.dir * 0.35 * k; y += 5 * k / s; alpha *= 1 - k * k;
          if (nowMs - (sh.smokeAt || 0) > 140 && k < 0.9) { sh.smokeAt = nowMs; q.puffs.push({ x: x + (Math.random() - 0.5) * L * 0.5 / s, y: y - L * 0.08 / s, t0: nowMs, dark: true, big: true }); }
          if (Math.random() < 0.08 && k < 0.7) this._flash(g, x + (Math.random() - 0.5) * L * 0.6 / s, y - 2 / s, 2.2 * boost / s);
          if (k >= 1) { sh.gone = true; sp.visible = false; q.foam.push({ x, y, t0: nowMs, ring: true, r: L * 0.4 }); continue; }
        }
        if (sh.risen) { const k = Math.min(1, (nowMs - sh.risen) / 1200); alpha *= k; if (k >= 1) sh.risen = 0; }
        sp.visible = true;
        sp.position.set(x, y);
        sp.rotation = roll * face;
        sp.scale.set(face * sc, sc);
        sp.alpha = alpha;
        sp.tint = sub ? 0xa8bcc8 : 0xffffff;
        // Foam: a bow wave and a wake streaming astern (it is the water that moves: the ships keep station).
        const halfLen = fr.w * sc / 2;
        if (!sh.dead && nowMs - sh.foamAt > 90) {
          sh.foamAt = nowMs;
          q.foam.push({ x: x - face * halfLen * 0.95, y: y + (Math.random() - 0.5) * 1.2 / s, t0: nowMs, vx: -face * 16 * boost / s });
        }
        if (!sh.dead) g.ellipse(x + face * halfLen * 0.97, y, 2.2 * boost / s, 1.1 * boost / s).fill({ color: 0xffffff, alpha: 0.55 });
        // Gun positions along the deck (world units, filled in for _shipShot).
        sh.guns = []; for (let i = 0; i < guns; i++) sh.guns.push([x + face * (guns > 1 ? (i / (guns - 1) - 0.5) * 0.6 : 0.1) * fr.w * sc, y - fr.h * sc * 0.35]);
        if (!fight || sh.dead) continue;
        // Salvo: on the ship's own clock (a bombardment's shells come through fireGun instead).
        if (guns && !f.shells && nowMs >= sh.nextShot) { sh.nextShot = nowMs + every * (0.75 + Math.random() * 0.6); this._salvo(q, sh, f, nowMs, s, boost, L); }
        if (guns && nowMs - sh.firedAt < 140) for (const [gx, gy] of sh.guns) this._flash(g, gx + face * 2 / s, gy, (L > 60 ? 3 : 2) * boost / s);
        if (torpedoes && nowMs >= sh.torpAt) {
          sh.torpAt = nowMs + (sub ? 8000 : 16000) + Math.random() * 10000;
          const tx = f.tx + (Math.random() - 0.5) * 50 / s, ty = f.ty + (Math.random() - 0.5) * 40 / s, d = Math.hypot(tx - x, ty - y) * s;
          q.torps.push({ x0: x + face * halfLen * 0.6, y0: y + 1 / s, x1: tx, y1: ty, t0: nowMs, dur: Math.max(1500, d / 55 * 1000) });
        }
      }
      // Torpedo tracks: a pale line running out to the enemy, then a column of water (now and then a hit).
      q.torps = q.torps.filter(tp => {
        const k = (nowMs - tp.t0) / tp.dur;
        if (k >= 1) { this.r.splash(tp.x1, tp.y1, 70); if (Math.random() < 0.35) this.r.explode(tp.x1, tp.y1, 46, 120); return false; }
        // The track: a short pale streak behind the running torpedo, fading towards the tail.
        const hx = tp.x0 + (tp.x1 - tp.x0) * k, hy = tp.y0 + (tp.y1 - tp.y0) * k, d = Math.hypot(tp.x1 - tp.x0, tp.y1 - tp.y0) || 1;
        const tail = Math.min(k * d, 28 * boost / s), bx = (tp.x1 - tp.x0) / d, by = (tp.y1 - tp.y0) / d;
        g.moveTo(hx - bx * tail, hy - by * tail).lineTo(hx - bx * tail * 0.4, hy - by * tail * 0.4).stroke({ width: 1.2 * boost / s, color: 0xf2f6f8, alpha: 0.18 });
        g.moveTo(hx - bx * tail * 0.4, hy - by * tail * 0.4).lineTo(hx, hy).stroke({ width: 1.4 * boost / s, color: 0xf2f6f8, alpha: 0.4 });
        return true;
      });
      // Foam fading on the water.
      q.foam = q.foam.filter(p => nowMs - p.t0 < (p.ring ? 3000 : 1500));
      for (const p of q.foam) {
        const age = (nowMs - p.t0) / (p.ring ? 3000 : 1500);
        if (p.ring) { g.ellipse(p.x, p.y, (p.r * (0.5 + age)) * boost / s, (p.r * 0.3 * (0.5 + age)) * boost / s).stroke({ width: 1.5 / s, color: 0xffffff, alpha: 0.5 * (1 - age) }); continue; }
        g.ellipse(p.x + p.vx * age * 1.5, p.y, (1.6 + age * 3) * boost / s, (0.8 + age * 1.2) * boost / s).fill({ color: 0xffffff, alpha: 0.45 * (1 - age) });
      }
    }
    /** A salvo from one ship: flashes and smoke at its guns, then the shells land around the enemy's line. */
    _salvo(q, sh, f, nowMs, s, boost, L) {
      sh.firedAt = nowMs;
      for (const [gx, gy] of sh.guns) q.puffs.push({ x: gx, y: gy, t0: nowMs, big: L > 60 });
      const size = Math.max(30, Math.min(90, L * 0.8));
      for (let i = 0; i < sh.guns.length; i++) {
        const x = f.tx + (Math.random() - 0.5) * 70 / s, y = f.ty + (Math.random() - 0.5) * 45 / s, delay = 900 + Math.random() * 700 + i * 90;
        if (this.r._isWater(x, y, null)) this.r.splash(x, y, size, delay);
        else this.r.explode(x, y, size, delay, this.r.shellFrames);
      }
    }
    /** A shell fired for a bombardment (MapRenderer, shelling): from one of the ships' guns. */
    _shipShot(q, nowMs) {
      const ready = q.machines.filter(sh => !sh.dead && sh.guns.length);
      if (!ready.length) return null;
      const sh = ready[Math.floor(Math.random() * ready.length)], [x, y] = sh.guns[Math.floor(Math.random() * sh.guns.length)];
      sh.firedAt = nowMs; sh.nextShot = nowMs + 3000 + Math.random() * 3000;
      q.puffs.push({ x, y, t0: nowMs, big: true });
      return { x, y };
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
      const dug = this._dug(q, f);
      if (dug && !crew) {
        // Dug in: each man in his own rifle pit (the fallen in theirs), the spoil thrown up in front of it and
        // topped with sandbags; after a second turn, a belt of wire out in front.
        for (const m of q.men) { if (m.run && !m.dead) continue; const [x, y] = at(m.o, m.d); this._pit(x, y, f, s, boost, 1); }
        if (dug > 1) this._wire(q, f, at, s, boost);
      }
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
        } else if (m.role !== 'medic' && !m.run && !dug && nowMs >= m.next) {
          // Now and then a man gets up and rushes to a new spot, forward or back and across (three at most at a time);
          // never closer to the enemy than a quarter of the way over.
          if (running >= 3) m.next = nowMs + 1000 + Math.random() * 1500;
          else {
            const step = (0.05 + Math.random() * 0.2) * (Math.random() < 0.5 ? -1 : 1);
            let o1 = m.o + step; if (o1 > 0.5 || o1 < -0.5) o1 = m.o - step;
            const reach = ((f.tx - f.cx) * f.ux + (f.ty - f.cy) * f.uy) * s, d0 = Math.max(DEPTH[0], -reach * 0.25);
            m.run = { o0: m.o, d0: m.d, o1: Math.max(-0.5, Math.min(0.5, o1)), d1: d0 + Math.random() * (DEPTH[1] - d0), t0: nowMs, dur: 0 };
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
        // In position: weapon on the enemy, a little sway, a kick and a flash with each round, which flies at one of
        // the enemy's men. Riflemen fire aimed rounds at a bolt-action rate; the light machine-gunner fires bursts at
        // his gun's rate. The medic waits, kneeling.
        const fr = this._pick(q, m.i, m.role === 'medic' ? 'medic.kneel' : `${m.role}.${m.stance}`);
        this._pose(m, fr);
        // In a gas cloud: masks on, a sickly cast to them, and no aimed fire until it clears.
        sp.tint = f.gas > 0.3 ? 0xd3dc9a : 0xffffff;
        if (f.gas > 0.5) m.nextShot = Math.max(m.nextShot, nowMs + 600);
        if (m.role !== 'medic' && nowMs >= m.nextShot) {
          const lmg = m.role === 'lmg' && this._has(q.kit, 'lmg.') && LMG_RPM[q.kit.army];
          if (lmg) {
            if (!m.burst) m.burst = q.kit.army === 'french' ? 3 + Math.floor(Math.random() * 3) : 4 + Math.floor(Math.random() * 6);
            m.burst--;
            m.nextShot = nowMs + (m.burst ? 60000 / lmg : 1500 + Math.random() * 2500);
          } else m.nextShot = nowMs + m.period * (0.8 + Math.random() * 0.4) * 1000;
          m.firedAt = nowMs; m.shot = true;
        }
        const shot = m.firedAt && nowMs - m.firedAt < 70;
        const aim = theta + Math.sin(t * 0.7 + m.i * 2) * 0.1;
        const [x, y] = at(m.o, m.d + (shot ? 0.8 : 0));
        sp.position.set(x, y);
        sp.rotation = aim - fr.face;
        sp.scale.set(unit);
        if (shot && g) {
          const reach = fr.len * unit * 0.5, mx = x + Math.cos(aim) * reach, my = y + Math.sin(aim) * reach;
          g.circle(mx, my, 3.2 * boost / s).fill({ color: 0xffc94a, alpha: 0.35 });
          g.circle(mx, my, 1.5 * boost / s).fill({ color: 0xfff6c8, alpha: 0.95 });
          if (m.shot) { m.shot = false; this._round(q, f, mx, my, nowMs, s); }
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
      const dug = this._dug(q, f);
      if (dug) {
        // Dug in: each gun in a pit walled with sandbags (open at the back); wire out in front after a second turn.
        for (const gn of q.machines) { const [x, y] = at(gn.o, gn.d); this._pit(x, y, f, s, boost, q.team || hmg ? 1.6 : 1.8, true); }
        if (dug > 1) this._wire(q, f, at, s, boost);
      }
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
          this._mgBurst(q, gn, f, nowMs, s, boost, g);
        } else if (!f.shells && nowMs >= gn.nextShot) {
          gn.firedAt = nowMs; gn.nextShot = nowMs + 3000 + Math.random() * 4000;
          q.puffs.push({ x: gn.muzzle[0], y: gn.muzzle[1], t0: nowMs, big: true });
          this._round(q, f, gn.muzzle[0], gn.muzzle[1], nowMs, s, true);   // over open sights, at the enemy's line
        }
        if (!hmg && gn.firedAt && nowMs - gn.firedAt < 120) this._flash(g, gn.muzzle[0], gn.muzzle[1], 3 * boost / s);
      }
    }

    /**
     * How far a squad has dug in: 0 not at all; 1 rifle and gun pits with sandbags (it has held its ground a turn);
     * 2 wire as well (two turns or more, or fighting from a trench line). Infantry and guns only.
     */
    _dug(q, f) {
      if (q.kind !== 'rifles' && q.kind !== 'guns') return 0;
      const held = Number(f.view?.marker?.data?.heldTurns) || 0, level = Math.max(Math.min(2, held), f.cover ? 2 : 0);
      q.wireAt = level > 1 ? WIRE_D : 0;   // where cavalry charging it are held up
      return level;
    }
    /**
     * A pit at (x, y) (world units), `size` times a rifle pit: dark earth, the spoil heaped on the enemy side and
     * sandbags along its top; a gun pit (`ring`) walled with sandbags all round but the back.
     */
    _pit(x, y, f, s, boost, size, ring = false) {
      const g = this.groundG, k = boost / s * size * 1.3, ux = f.ux || 0, uy = f.uy || 0, rot = Math.atan2(uy, ux);
      const oval = (cx, cy, rx, ry, a, n = 12) => { const pts = []; for (let i = 0; i < n; i++) { const t = i / n * Math.PI * 2; pts.push(cx + Math.cos(t) * rx * Math.cos(a) - Math.sin(t) * ry * Math.sin(a), cy + Math.cos(t) * rx * Math.sin(a) + Math.sin(t) * ry * Math.cos(a)); } return pts; };
      // Spoil heaped up on the enemy side (the pit is long across the front).
      g.poly(oval(x + ux * 3 * k, y + uy * 3 * k, 4.2 * k, 7.5 * k, rot)).fill({ color: 0x86704f, alpha: 0.85 });
      g.poly(oval(x, y, 4 * k, 7 * k, rot)).fill({ color: 0x3f3122, alpha: 0.9 });
      // Sandbags: a row along the forward lip, or round a gun pit.
      const bags = ring ? 9 : 4, span = ring ? Math.PI * 1.5 : Math.PI * 0.75;
      for (let i = 0; i < bags; i++) {
        const a = rot - span / 2 + span * (i + 0.5) / bags, r = ring ? 7.6 * k : 6 * k;
        const bx = x + Math.cos(a) * r * (ring ? 1 : 0.75), by = y + Math.sin(a) * r * (ring ? 1 : 0.75) * (ring ? 1 : 1.3);
        g.poly(oval(bx, by, 1.5 * k / (ring ? size / 1.6 : 1), 2.6 * k / (ring ? size / 1.6 : 1), a, 8)).fill({ color: 0xb6a57a }).stroke({ width: 0.4 * boost / s, color: 0x6f6448, alpha: 0.8 });
      }
    }
    /** A belt of concertina wire across the squad's front, WIRE_D ahead of its line, on pickets. */
    _wire(q, f, at, s, boost) {
      const g = this.groundG, step = 4.5 / (f.front * s), r = 2.6 * boost / s;
      for (const row of [0, 1]) {
        for (let o = -0.6 + row * step / 2; o <= 0.6; o += step) {
          const [x, y] = at(o, WIRE_D - row * 4 + Math.sin(o * 37 + q.id) * 1.5);
          g.circle(x, y, r);
        }
      }
      g.stroke({ width: 0.55 * boost / s, color: 0x37332e, alpha: 0.85 });
      for (let o = -0.6; o <= 0.6; o += step * 3) {
        const [x0, y0] = at(o, WIRE_D - 6), [x1, y1] = at(o, WIRE_D + 2);
        g.moveTo(x0, y0).lineTo(x1, y1);
      }
      g.stroke({ width: 1 * boost / s, color: 0x5a4632, alpha: 0.9 });
    }
    /** A machine gun firing bursts of 10 to 20 rounds at its cyclic rate, a pause of 2 to 4 s between them. */
    _mgBurst(q, gn, f, nowMs, s, boost, g) {
      if (!gn.burst && nowMs >= gn.nextShot) { gn.burst = 10 + Math.floor(Math.random() * 11); gn.nextShot = 0; }
      if (gn.burst > 0 && nowMs - (gn.burstAt || 0) >= 60000 / (HMG_RPM[q.kit?.army] || 450)) {
        gn.burst--; gn.burstAt = nowMs; gn.firedAt = nowMs;
        if (!gn.burst) gn.nextShot = nowMs + 2000 + Math.random() * 2000;
        this._round(q, f, gn.muzzle[0], gn.muzzle[1], nowMs, s);
      }
      if (gn.firedAt && nowMs - gn.firedAt < 60) this._flash(g, gn.muzzle[0], gn.muzzle[1], 1.8 * boost / s);
    }
    /**
     * A round fired from (x, y) at the enemy: at one of his men or machines when his squad is drawn (else somewhere
     * on his line), a little off. None at aircraft (they are over the fight, not at its line). A shell (`big`) flies
     * faster and kicks up more dirt.
     */
    _round(q, f, x, y, nowMs, s, big = false) {
      if (f.enemyKind === 'air') return;
      const foe = f.enemyId != null ? this.squads.get(f.enemyId) : null;
      let tx = null, ty = null;
      if (foe?.shown) {
        const alive = [...foe.men.filter(m => !m.dead && m.sp.visible).map(m => m.sp), ...foe.machines.filter(x => x.sp?.visible && !x.dead).map(x => x.sp)];
        if (alive.length) { const sp = alive[Math.floor(Math.random() * alive.length)]; tx = sp.x; ty = sp.y; }
      }
      if (tx == null) {
        if (f.tx == null) return;
        const o = (Math.random() - 0.5) * f.front * 0.7;
        tx = f.tx - f.uy * o; ty = f.ty + f.ux * o;
      }
      const spread = (big ? 6 : 9) / s;
      tx += (Math.random() - 0.5) * spread * 2; ty += (Math.random() - 0.5) * spread * 2;
      const T = Math.hypot(tx - x, ty - y) * s / (ROUND_PX_S * (big ? 1.6 : 0.85 + Math.random() * 0.3)) * 1000;
      (q.rounds ||= []).push({ x0: x, y0: y, x1: tx, y1: ty, t0: nowMs, T, big, hs: Math.random() });
    }
    /** Rounds in flight (a tracer streak) and where they landed (a puff of dust). */
    _drawRounds(q, nowMs, s, g) {
      if (!q.rounds?.length) return;
      q.rounds = q.rounds.filter(r => nowMs - r.t0 < r.T + 600);
      const w = 1.8 / s;
      for (const r of q.rounds) {
        const age = nowMs - r.t0, dx = r.x1 - r.x0, dy = r.y1 - r.y0, l = Math.max(1e-6, Math.hypot(dx, dy)), vx = dx / l, vy = dy / l;
        if (age <= r.T) {
          const p = age / r.T, seg = (r.big ? 14 : 8 + r.hs * 9) / s, px = r.x0 + dx * p, py = r.y0 + dy * p;
          const core = r.big ? 0xffe0a0 : r.hs < 0.15 ? 0xffd2a0 : r.hs > 0.9 ? 0xffffff : 0xfff0a0;   // a few redder or whiter rounds
          g.moveTo(px, py).lineTo(px + vx * seg, py + vy * seg).stroke({ width: w * (r.big ? 4 : 2.6), color: 0xffb347, alpha: 0.2 });   // glow
          g.moveTo(px, py).lineTo(px + vx * seg, py + vy * seg).stroke({ width: w * (r.big ? 1.6 : 0.8 + r.hs * 0.4), color: core, alpha: 0.95 });
        } else {
          const k = (age - r.T) / 600;
          g.circle(r.x1 + vx * k * 3 / s, r.y1 + vy * k * 3 / s, ((r.big ? 2.5 : 1.2) + k * (r.big ? 9 : 5) * (0.6 + r.hs * 0.8)) / s)
            .fill({ color: r.big ? 0xb8ab90 : 0xd8d2c4, alpha: (r.big ? 0.6 : 0.45) * (1 - k) });
        }
      }
    }
    /** Whether units of this kind are drawn here with their own fire (the renderer then draws no firing line for them). */
    firesOwn(kind) {
      if (!this.tex) return false;
      return kind === 'rifles' || ((kind === 'guns' || kind === 'tanks') && !!this.mach) || ((kind === 'air' || kind === 'horse') && !!this.mounts) || (kind === 'ships' && !!this.ships);
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
        this._mgBurst(q, gn, f, nowMs, s, boost, g);
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
        if (!tk.roll && nowMs >= tk.nextShot) {
          tk.firedAt = nowMs; tk.nextShot = nowMs + 2500 + Math.random() * 2500;
          const [mx, my] = this._muzzleOf(sp, fr); q.puffs.push({ x: mx, y: my, t0: nowMs }); this._round(q, f, mx, my, nowMs, s, true);
        }
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
