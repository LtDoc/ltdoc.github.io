'use strict';
/* global PIXI */

/**
 * Default unit catalogue (WW1 era) and the procedural NATO-style symbols drawn on unit counters.
 * Each symbol is drawn in white inside the counter's inner box; the counter background is the nation colour.
 * `mod` is a small tag drawn in the corner to tell similar units apart (e.g. heavy vs field artillery).
 */
const UnitTypes = (() => {
  const W = { width: 1.6, color: 0xffffff };
  const WF = 0xffffff;

  // ---- Symbol drawers: (graphics, box{x,y,w,h,cx,cy}) --------------------------------------
  const sym = {
    infantry: (g, b) => g.moveTo(b.x, b.y).lineTo(b.x + b.w, b.y + b.h).moveTo(b.x + b.w, b.y).lineTo(b.x, b.y + b.h).stroke(W),
    cavalry: (g, b) => g.moveTo(b.x, b.y + b.h).lineTo(b.x + b.w, b.y).stroke(W),
    armour: (g, b) => g.roundRect(b.x + 7, b.y + 4, b.w - 14, b.h - 8, (b.h - 8) / 2).stroke(W),
    armouredCar: (g, b) => {
      g.roundRect(b.x + 7, b.y + 3, b.w - 14, b.h - 9, (b.h - 9) / 2).stroke(W);
      g.circle(b.x + 10, b.y + b.h - 3, 1.8).fill(WF).circle(b.x + b.w - 10, b.y + b.h - 3, 1.8).fill(WF);
    },
    artillery: (g, b) => g.circle(b.cx, b.cy, 3).fill(WF),
    heavyArtillery: (g, b) => g.circle(b.cx, b.cy, 3).fill(WF).circle(b.cx, b.cy, 6).stroke(W),
    railwayGun: (g, b) => {
      g.circle(b.cx, b.cy - 2, 3).fill(WF);
      g.moveTo(b.x + 5, b.y + b.h - 3).lineTo(b.x + b.w - 5, b.y + b.h - 3)
       .moveTo(b.x + 5, b.y + b.h - 0.5).lineTo(b.x + b.w - 5, b.y + b.h - 0.5).stroke({ width: 1.2, color: WF });
    },
    mortar: (g, b) => {
      g.moveTo(b.cx, b.y + b.h - 3).lineTo(b.cx, b.y + 2).stroke(W);
      g.poly([b.cx, b.y, b.cx - 3.5, b.y + 4.5, b.cx + 3.5, b.y + 4.5]).fill(WF);
      g.circle(b.cx, b.y + b.h - 3, 2.2).fill(WF);
    },
    machineGun: (g, b) => {
      g.moveTo(b.cx, b.y + b.h - 1).lineTo(b.cx, b.y + 2).stroke(W);
      g.poly([b.cx, b.y, b.cx - 3.5, b.y + 4.5, b.cx + 3.5, b.y + 4.5]).fill(WF);
      g.moveTo(b.cx - 5, b.y + b.h - 5).lineTo(b.cx + 5, b.y + b.h - 5).stroke(W);
    },
    engineers: (g, b) => {
      const x = b.cx - 7, t = b.y + 3, m = b.cy, d = b.y + b.h - 3;
      g.moveTo(x, t).lineTo(x, d).moveTo(x, t).lineTo(x + 14, t).moveTo(x, m).lineTo(x + 11, m).moveTo(x, d).lineTo(x + 14, d).stroke(W);
    },
    signals: (g, b) => g.moveTo(b.x + 6, b.y + 3).lineTo(b.x + b.w - 8, b.y + 3).lineTo(b.x + 10, b.y + b.h - 3).lineTo(b.x + b.w - 6, b.y + b.h - 3).stroke(W),
    supply: (g, b) => g.rect(b.x + 3, b.y + b.h - 6.5, b.w - 6, 3).fill(WF),
    medical: (g, b) => g.rect(b.cx - 1.5, b.y + 2, 3, b.h - 4).fill(WF).rect(b.x + 8, b.cy - 1.5, b.w - 16, 3).fill(WF),
    hq: (g, b) => {
      g.moveTo(b.x + 8, b.y + 1).lineTo(b.x + 8, b.y + b.h - 1).stroke(W);
      g.poly([b.x + 8, b.y + 1, b.x + b.w - 6, b.y + 5, b.x + 8, b.y + 9]).fill(WF);
    },
    antiAir: (g, b) => g.arc(b.cx, b.y + b.h - 2, 8, Math.PI, 0).stroke(W).moveTo(b.cx - 8, b.y + b.h - 2).lineTo(b.cx + 8, b.y + b.h - 2).stroke(W),
    gas: (g, b) => g.circle(b.cx - 5, b.cy + 2, 3).fill(WF).circle(b.cx + 5, b.cy + 2, 3).fill(WF).circle(b.cx, b.cy - 3, 3.5).fill(WF),
    air: (g, b) => g.poly([b.cx - 12, b.cy - 6, b.cx, b.cy, b.cx - 12, b.cy + 6]).fill(WF).poly([b.cx + 12, b.cy - 6, b.cx, b.cy, b.cx + 12, b.cy + 6]).fill(WF),
    seaplane: (g, b) => {
      sym.air(g, { ...b, cy: b.cy - 2 });
      g.moveTo(b.x + 6, b.y + b.h - 1.5).lineTo(b.x + b.w - 6, b.y + b.h - 1.5).stroke({ width: 1.2, color: WF });
    },
    balloon: (g, b) => {
      g.circle(b.cx, b.cy - 2.5, 5).fill(WF);
      g.moveTo(b.cx, b.cy + 2.5).lineTo(b.cx, b.cy + 6).stroke(W);
      g.rect(b.cx - 2, b.cy + 6, 4, 2).fill(WF);
    },
    airship: (g, b) => {
      g.ellipse(b.cx, b.cy - 1.5, 13, 4.5).fill(WF);
      g.rect(b.cx - 3, b.cy + 3.5, 6, 2.5).fill(WF);
      g.moveTo(b.cx + 13, b.cy - 5).lineTo(b.cx + 10, b.cy - 1.5).lineTo(b.cx + 13, b.cy + 2).stroke({ width: 1.2, color: WF });
    },
    // ---- ships: a hull with optional turrets / funnels / cargo -----------------------------
    hull: (g, b, len = 26) => {
      const x0 = b.cx - len / 2, x1 = b.cx + len / 2, y = b.cy + 2;
      g.poly([x0, y, x1, y, x1 - 5, y + 5, x0 + 4, y + 5]).fill(WF);
    },
    battleship: (g, b) => {
      sym.hull(g, b, 28);
      g.rect(b.cx - 3, b.cy - 5, 6, 7).fill(WF);            // superstructure
      g.rect(b.cx - 11, b.cy - 1, 5, 3).fill(WF).rect(b.cx + 6, b.cy - 1, 5, 3).fill(WF); // turrets
      g.rect(b.cx - 1, b.cy - 8, 2, 3).fill(WF);            // funnel
    },
    cruiser: (g, b) => {
      sym.hull(g, b, 26);
      g.rect(b.cx - 2.5, b.cy - 4, 5, 6).fill(WF);
      g.rect(b.cx - 10, b.cy - 1, 4, 3).fill(WF);
      g.rect(b.cx - 0.5, b.cy - 7, 2, 3).fill(WF);
    },
    destroyer: (g, b) => {
      sym.hull(g, b, 22);
      g.rect(b.cx - 2, b.cy - 3, 4, 5).fill(WF);
      g.rect(b.cx + 1, b.cy - 6, 1.5, 3).fill(WF);
    },
    submarine: (g, b) => {
      g.roundRect(b.cx - 13, b.cy - 1, 26, 6, 3).fill(WF);
      g.rect(b.cx - 2, b.cy - 5, 4, 4).fill(WF);
      g.moveTo(b.cx + 1, b.cy - 5).lineTo(b.cx + 1, b.cy - 8).stroke({ width: 1.2, color: WF });
    },
    torpedoBoat: (g, b) => {
      sym.hull(g, b, 18);
      g.moveTo(b.cx - 4, b.cy - 3).lineTo(b.cx + 6, b.cy - 3).stroke(W);
      g.poly([b.cx + 9, b.cy - 3, b.cx + 5, b.cy - 6, b.cx + 5, b.cy]).fill(WF);
    },
    minelayer: (g, b) => {
      sym.hull(g, { ...b, cy: b.cy - 2 }, 24);
      g.rect(b.cx - 2, b.cy - 6, 4, 4).fill(WF);
      g.circle(b.cx - 8, b.cy + 7, 1.6).fill(WF).circle(b.cx, b.cy + 7, 1.6).fill(WF).circle(b.cx + 8, b.cy + 7, 1.6).fill(WF);
    },
    transport: (g, b) => {
      sym.hull(g, b, 26);
      g.rect(b.cx - 9, b.cy - 5, 8, 7).stroke(W);
      g.rect(b.cx + 3, b.cy - 5, 8, 7).stroke(W);
    },
    gunboat: (g, b) => {
      sym.hull(g, b, 20);
      g.rect(b.cx - 5, b.cy - 2, 5, 4).fill(WF);
      g.circle(b.cx + 5, b.cy - 1, 2).fill(WF);
    },
  };

  // ---- Catalogue -----------------------------------------------------------------------------
  const LIST = [
    // Infantry
    { id: 'infantry', name: 'Infantry', cat: 'Infantry', symbol: 'infantry' },
    { id: 'stormtroopers', name: 'Stormtroopers / assault infantry', cat: 'Infantry', symbol: 'infantry', mod: 'ST' },
    { id: 'mountain', name: 'Mountain infantry', cat: 'Infantry', symbol: 'infantry', mod: 'MTN' },
    { id: 'marines', name: 'Marines / naval infantry', cat: 'Infantry', symbol: 'infantry', mod: 'MAR' },
    { id: 'militia', name: 'Militia / territorials', cat: 'Infantry', symbol: 'infantry', mod: 'MIL' },
    { id: 'colonial', name: 'Colonial troops', cat: 'Infantry', symbol: 'infantry', mod: 'COL' },
    { id: 'bicycle', name: 'Bicycle infantry', cat: 'Infantry', symbol: 'infantry', mod: 'BI' },
    { id: 'machinegun', name: 'Machine-gun company', cat: 'Infantry', symbol: 'machineGun' },
    // Mounted & mobile
    { id: 'cavalry', name: 'Cavalry', cat: 'Mounted & mobile', symbol: 'cavalry' },
    { id: 'dragoons', name: 'Dragoons', cat: 'Mounted & mobile', symbol: 'cavalry', mod: 'DR' },
    { id: 'lancers', name: 'Lancers / uhlans', cat: 'Mounted & mobile', symbol: 'cavalry', mod: 'LN' },
    { id: 'hussars', name: 'Hussars', cat: 'Mounted & mobile', symbol: 'cavalry', mod: 'HU' },
    { id: 'camelry', name: 'Camel corps', cat: 'Mounted & mobile', symbol: 'cavalry', mod: 'CAM' },
    { id: 'reconnaissance', name: 'Reconnaissance', cat: 'Mounted & mobile', symbol: 'cavalry', mod: 'R' },
    { id: 'armouredcar', name: 'Armoured cars', cat: 'Mounted & mobile', symbol: 'armouredCar' },
    { id: 'tank', name: 'Tanks', cat: 'Mounted & mobile', symbol: 'armour' },
    { id: 'armouredtrain', name: 'Armoured train', cat: 'Mounted & mobile', symbol: 'armour', mod: 'RR' },
    // Artillery
    { id: 'fieldartillery', name: 'Field artillery', cat: 'Artillery', symbol: 'artillery' },
    { id: 'horseartillery', name: 'Horse artillery', cat: 'Artillery', symbol: 'artillery', mod: 'H' },
    { id: 'heavyartillery', name: 'Heavy artillery', cat: 'Artillery', symbol: 'heavyArtillery' },
    { id: 'siegeartillery', name: 'Siege artillery', cat: 'Artillery', symbol: 'heavyArtillery', mod: 'SG' },
    { id: 'railwaygun', name: 'Railway gun', cat: 'Artillery', symbol: 'railwayGun' },
    { id: 'mortar', name: 'Trench mortars', cat: 'Artillery', symbol: 'mortar' },
    { id: 'antiaircraft', name: 'Anti-aircraft', cat: 'Artillery', symbol: 'antiAir' },
    { id: 'coastal', name: 'Coastal battery', cat: 'Artillery', symbol: 'heavyArtillery', mod: 'CST' },
    // Support
    { id: 'hq', name: 'Headquarters', cat: 'Support', symbol: 'hq' },
    { id: 'engineers', name: 'Engineers', cat: 'Support', symbol: 'engineers' },
    { id: 'sappers', name: 'Sappers / tunnellers', cat: 'Support', symbol: 'engineers', mod: 'SP' },
    { id: 'pioneers', name: 'Pioneers', cat: 'Support', symbol: 'engineers', mod: 'PI' },
    { id: 'signals', name: 'Signals', cat: 'Support', symbol: 'signals' },
    { id: 'supply', name: 'Supply / logistics', cat: 'Support', symbol: 'supply' },
    { id: 'medical', name: 'Medical / field hospital', cat: 'Support', symbol: 'medical' },
    { id: 'gas', name: 'Gas / chemical troops', cat: 'Support', symbol: 'gas' },
    { id: 'railway', name: 'Railway troops', cat: 'Support', symbol: 'supply', mod: 'RR' },
    { id: 'labour', name: 'Labour battalion', cat: 'Support', symbol: 'supply', mod: 'LAB' },
    // Air
    { id: 'fighter', name: 'Fighter squadron', cat: 'Air', symbol: 'air' },
    { id: 'bomber', name: 'Bomber squadron', cat: 'Air', symbol: 'air', mod: 'B' },
    { id: 'reconair', name: 'Reconnaissance aircraft', cat: 'Air', symbol: 'air', mod: 'R' },
    { id: 'seaplane', name: 'Seaplanes', cat: 'Air', symbol: 'seaplane' },
    { id: 'balloon', name: 'Observation balloon', cat: 'Air', symbol: 'balloon' },
    { id: 'airship', name: 'Airship / Zeppelin', cat: 'Air', symbol: 'airship' },
    // Naval
    { id: 'dreadnought', name: 'Dreadnought / battleship', cat: 'Naval', symbol: 'battleship' },
    { id: 'predreadnought', name: 'Pre-dreadnought', cat: 'Naval', symbol: 'battleship', mod: 'PD' },
    { id: 'battlecruiser', name: 'Battlecruiser', cat: 'Naval', symbol: 'battleship', mod: 'BC' },
    { id: 'armouredcruiser', name: 'Armoured cruiser', cat: 'Naval', symbol: 'cruiser', mod: 'AC' },
    { id: 'lightcruiser', name: 'Light cruiser', cat: 'Naval', symbol: 'cruiser' },
    { id: 'destroyer', name: 'Destroyers', cat: 'Naval', symbol: 'destroyer' },
    { id: 'torpedoboat', name: 'Torpedo boats', cat: 'Naval', symbol: 'torpedoBoat' },
    { id: 'submarine', name: 'Submarine / U-boat', cat: 'Naval', symbol: 'submarine' },
    { id: 'minelayer', name: 'Minelayer / minesweeper', cat: 'Naval', symbol: 'minelayer' },
    { id: 'gunboat', name: 'Gunboat / river monitor', cat: 'Naval', symbol: 'gunboat' },
    { id: 'transport', name: 'Transports / convoy', cat: 'Naval', symbol: 'transport' },
    { id: 'seaplanecarrier', name: 'Seaplane carrier', cat: 'Naval', symbol: 'transport', mod: 'AV' },
  ];
  const byId = new Map(LIST.map(t => [t.id, t]));
  const byName = new Map(LIST.map(t => [t.name.toLowerCase(), t]));

  // Keyword fallback for free-text unit types (old data, imports, custom names).
  const KEYWORDS = [
    [/storm|assault|shock/, 'stormtroopers'], [/mountain|alpin|alpine/, 'mountain'], [/marine/, 'marines'],
    [/militia|territorial|landwehr|landsturm|reserve/, 'militia'], [/colonial|askari|sepoy|zouave|senegal/, 'colonial'],
    [/bicycle|cyclist/, 'bicycle'], [/machine|mg\b|maxim|vickers/, 'machinegun'],
    [/dragoon/, 'dragoons'], [/lancer|uhlan/, 'lancers'], [/hussar/, 'hussars'], [/camel/, 'camelry'],
    [/armou?red car/, 'armouredcar'], [/armou?red train/, 'armouredtrain'], [/tank|armou?r|panzer/, 'tank'],
    [/recon|scout/, 'reconnaissance'], [/cav|horse|mounted|cossack|sotnia|cuirassier|chasseur|spahi|bedouin/, 'cavalry'],
    [/railway gun|rail gun/, 'railwaygun'], [/siege|howitzer/, 'siegeartillery'], [/heavy art|heavy gun/, 'heavyartillery'],
    [/horse art/, 'horseartillery'], [/coast/, 'coastal'], [/mortar|minenwerfer/, 'mortar'],
    [/anti.?air|flak|aa\b/, 'antiaircraft'], [/art|gun|cannon|battery/, 'fieldartillery'],
    [/hq|headquarter|command|staff/, 'hq'], [/sapper|tunnel|mine(r|rs)\b/, 'sappers'], [/pioneer/, 'pioneers'],
    [/eng/, 'engineers'], [/signal|telegraph|wireless/, 'signals'], [/medic|hospital|ambulance|red cross/, 'medical'],
    [/gas|chemical/, 'gas'], [/railway|rail/, 'railway'], [/labou?r|work/, 'labour'], [/supply|logistic|train|transport col|wagon|depot/, 'supply'],
    [/zeppelin|airship|dirigible/, 'airship'], [/balloon/, 'balloon'], [/seaplane|floatplane/, 'seaplane'],
    [/bomb/, 'bomber'], [/fighter|scout squadron|pursuit/, 'fighter'], [/air|plane|squadron|aero|flying/, 'reconair'],
    [/dreadnought|battleship/, 'dreadnought'], [/battlecruiser/, 'battlecruiser'], [/armou?red cruiser/, 'armouredcruiser'],
    [/cruiser/, 'lightcruiser'], [/destroyer/, 'destroyer'], [/torpedo/, 'torpedoboat'], [/sub|u-?boat/, 'submarine'],
    [/mine/, 'minelayer'], [/gunboat|monitor/, 'gunboat'], [/carrier/, 'seaplanecarrier'], [/transport|convoy|troopship|merchant/, 'transport'],
    [/fleet|navy|naval|ship|squadron/, 'lightcruiser'],
    [/inf|foot|rifle|grenadier|fusilier|jäger|jaeger|guards?|regiment|division|brigade|corps|army|battalion/, 'infantry'],
  ];

  function resolve(unitType) {
    const s = String(unitType || '').trim().toLowerCase();
    if (!s) return null;
    if (byId.has(s)) return byId.get(s);
    if (byName.has(s)) return byName.get(s);
    for (const [re, id] of KEYWORDS) if (re.test(s)) return byId.get(id);
    return null;
  }

  /** Draw a type's symbol (and mod tag) into a counter. `box` is the inner rectangle; `c` receives text. */
  function draw(g, c, type, box) {
    const b = { ...box, cx: box.x + box.w / 2, cy: box.y + box.h / 2 };
    (sym[type.symbol] || sym.infantry)(g, b);
    if (type.mod) {
      const t = new PIXI.Text({ text: type.mod, style: { fontFamily: 'Segoe UI, Arial', fontSize: 6.5, fontWeight: '800', fill: 0xffffff }, resolution: 4 });
      t.anchor.set(1, 0);
      t.position.set(box.x + box.w + 5, box.y - 6.5);
      c.addChild(t);
    }
  }

  const categories = [...new Set(LIST.map(t => t.cat))];
  return { LIST, categories, resolve, draw, symbols: sym };
})();

window.UnitTypes = UnitTypes;
