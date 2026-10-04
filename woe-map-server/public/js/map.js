'use strict';
/* global MapRenderer, api, requireUser, esc, toast, fmtTime, fmtNum */

(async function main() {
  const lobbyId = Number(location.pathname.match(/\/map\/(\d+)/)?.[1] || new URLSearchParams(location.search).get('lobby'));
  if (!lobbyId) { location.replace('/lobbies.html'); return; }
  const me = await requireUser();
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const base = `/api/lobbies/${lobbyId}`;
  // "View as player" (docs/UI.md): a GM can use this tab as one nation's player (?as=<faction id>). The server
  // then answers every request as that player, so the map, panels and rules are exactly theirs; other tabs stay GM.
  const viewAsParam = Number(new URLSearchParams(location.search).get('as')) || null;
  if (viewAsParam) api.headers['X-View-As'] = String(viewAsParam);
  function setViewAs(fid) {
    const u = new URL(location.href);
    if (fid) u.searchParams.set('as', fid); else u.searchParams.delete('as');
    location.replace(u.href);
  }

  const TYPE_LABEL = { unit: 'Unit', town: 'Town', poi: 'POI', player: 'Player', scenery: 'Scenery', resource: 'Resource', factory: 'Factory', hero: 'Hero' };
  const Atlas = window.SpriteAtlas;
  await Atlas.load();
  const state = {
    lobby: null, members: [], role: 'player', member: null, factions: [], bundledFlags: null,
    markers: new Map(), shapes: new Map(), events: [], history: [], presence: [],
    selectedId: null, selectedShapeId: null,
    ws: null, wsBackoff: 1000, mapKey: null, pendingShape: null, editingShapeId: null,
    game: null, gameFactions: [], myFactionId: null, canUndo: false, placing: null,
  };
  const gameOn = () => !!state.game?.enabled;
  let panelHinted = false;   // the "right-click for the panel" tip shows once per visit

  // ---- Renderer -------------------------------------------------------------------
  const renderer = new MapRenderer($('#stage'));
  window.__woe = { renderer, state };   // for debugging from the console
  await renderer.init();
  window.woe = { renderer, state }; // handy for debugging from the console
  $('#rendererLabel').textContent = renderer.rendererType.toUpperCase();
  renderer.canDrag = m => canEdit(m) && !m.locked;
  renderer.gameDate = () => (gameOn() ? state.game.date : null);   // the battle figures dress for the year and season
  renderer.gameTurn = () => (gameOn() ? state.game.turn : null);   // craters weather and stop smoking as turns pass
  renderer.skirmish?.setStore(`woe.remains.${lobbyId}`);   // the dead left on the field, kept in this browser per campaign
  renderer.canEditShape = s => canEditShape(s) && !s.locked && !earthworks(s);
  /** A dug trench while the game runs: a player cannot redraw it (engineers dig and sappers blow up, a section at a time). */
  function earthworks(s) { return s.kind === 'trench' && state.role !== 'gm' && !!state.game?.enabled && (s.data?.state || 'dug') !== 'plan'; }
  renderer.unitsToPx = (x, y, units) => units / (distanceUnits(x, y, x + 1, y) || 1);   // km (or map units) → px, locally
  Object.defineProperty(renderer, 'railCutKm', { get: () => Number(state.game?.settings?.railCutKm) || 10 });

  /** Mirrors the server's access.canControl: viewing as a nation, a GM commands that nation's units and heroes. */
  function canEdit(m) {
    if (state.role === 'gm') return true;
    if (m.adminOnly) return false;
    if (state.viewAs && (m.type === 'unit' || m.type === 'hero')) return String(m.data?.nation || '').trim().toLowerCase() === state.viewAs.name.trim().toLowerCase();
    return m.ownerId === me.id;
  }
  function canEditShape(s) { return state.role === 'gm' || (s.createdBy === me.id && !s.adminOnly); }
  function round1(n) { return Math.round(n * 10) / 10; }
  function colorNum(hex) { return parseInt(String(hex || '#3498db').slice(1), 16) || 0x3498db; }
  function isEarth() { return state.lobby?.settings?.projection === 'equirect' && state.lobby?.mapKind === 'earth'; }

  /** Distance between two map points in the campaign's units (great-circle km on the Earth map). */
  function distanceUnits(x1, y1, x2, y2) {
    if (isEarth()) return window.EarthMap.distanceKm(x1, y1, x2, y2, state.lobby.mapWidth, state.lobby.mapHeight);
    return Math.hypot(x2 - x1, y2 - y1) * (state.lobby?.unitsPerPx || 1);
  }
  function pathUnits(pts) {
    let u = 0;
    for (let i = 1; i < pts.length; i++) u += distanceUnits(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    return u;
  }

  /** The best trench cover a unit gets: a dug or reinforced trench of its own nation (or unowned) within the trench range. */
  function trenchCoverFor(m) {
    if (m.type !== 'unit' || !window.Trench) return null;
    const g = state.game?.settings || {};
    const range = g.trenchRangeKm ?? 20, dug = g.trenchBonusDug ?? 2, reinforced = g.trenchBonusReinforced ?? 4;
    const perPx = distanceUnits(m.x, m.y, m.x + 1, m.y) || 1;
    let best = null;
    for (const s of state.shapes.values()) {
      if (s.kind !== 'trench' || !s.data || s.data.state === 'plan') continue;
      const owner = String(s.data.nation || '').toLowerCase();
      if (owner && owner !== String(m.data?.nation || '').toLowerCase()) continue;
      if (Trench.distToPath(m.x, m.y, s.points) * perPx > range) continue;
      const bonus = s.data.state === 'reinforced' ? reinforced : dug;
      if (!best || bonus > best.bonus) best = { bonus, trench: s };
    }
    return best;
  }

  // ---- Railways (docs/RAILWAYS.md) ----------------------------------------------------------------
  // The browser mirrors the server's network (public/js/railnet.js) for the drag preview and attack targets;
  // the server decides every move and every cut.
  const RAIL_LAND = new Set(['Infantry', 'Mounted & mobile', 'Artillery', 'Support']);
  /** Land units and heroes ride trains; ships and aircraft do not. */
  function canRide(m) {
    if (m.type === 'hero') return true;
    if (m.type !== 'unit') return false;
    const t = window.UnitTypes?.resolve(m.data?.unitType);
    return t ? RAIL_LAND.has(t.cat) : true;
  }
  // ---- Long-term projects in the popup (docs/ECONOMY.md) ------------------------------------------
  const GameData = window.GameData;
  /** May this viewer run projects at a place? The GM anywhere, a player at their own nation's towns and factories. */
  function mySite(m) {
    if (!gameOn() || !GameData.projectFor(m) || !m.data?.nation) return false;
    return state.role === 'gm' || String(state.member?.nation || '').toLowerCase() === String(m.data.nation).toLowerCase();
  }
  function developmentStat(m) {
    const lv = GameData.projectLevel(m);
    const info = window.GameUI?.projectInfo(m.id);
    let text = m.type === 'town' || m.type === 'resource' ? `level ${lv.level} / ${lv.max}` : '';
    if (m.type === 'resource' && lv.level) text += ` (${GameData.RESOURCE_WORKS[m.data?.kind]?.slice(0, lv.level).join(', ').toLowerCase() || ''})`;
    if (m.type === 'town' && lv.level) {
      const d = state.game?.settings?.townDevIncome || {};
      text += ` (+${lv.level * (d.money || 0)} money, +${lv.level * (d.rp || 0)} RP a turn)`;
    }
    if (info?.active) text += `${text ? ' · ' : ''}${{ factory: 'upgrading', resource: 'improving' }[m.type] || 'developing'} to ${info.active.toLevel}: ${info.active.queuedTurn !== undefined && info.active.queuedTurn >= state.game?.turn ? 'starts at End turn · ' : ''}${info.active.turnsLeft} turn${info.active.turnsLeft === 1 ? '' : 's'}${info.active.queuedTurn !== undefined && info.active.queuedTurn >= state.game?.turn ? '' : ' left'}`;
    return text ? stat({ factory: 'Project', resource: 'Works' }[m.type] || 'Development', text) : '';
  }
  function developButton(m) {
    if (!mySite(m)) return '';
    const lv = GameData.projectLevel(m);
    if (lv.level >= lv.max) return '';
    const info = window.GameUI?.projectInfo(m.id);
    if (info?.active) return '';
    const cost = info?.cost || GameData.projectCost(lv.id, lv.step, m);
    const what = lv.id === 'improveResource' ? `${GameData.worksName(m.data?.kind, lv.level + 1)}, +${Math.round(Number(m.data?.yield || 0) * Number(state.game?.settings?.resourceImproveRate ?? 0.25) * 10) / 10} a turn: ` : '';
    return `<button class="small" data-act="develop" title="Level ${lv.level + 1}: ${esc(what)}${esc(GameData.costLabel(cost))}">${{ upgradeFactory: '⬆ Upgrade', improveResource: '⛏ Improve' }[lv.id] || '🏗 Develop'}</button>`;
  }
  function shapeName(s) {
    return s.label || { area: 'Unnamed area', trench: 'Unnamed trench', rail: 'Unnamed railway' }[s.kind] || 'Unnamed line';
  }
  function railOpts() {
    const g = state.game?.settings || {};
    const H = state.lobby?.mapHeight || 1;
    return {
      dist: distanceUnits,
      kx: isEarth() ? (y => Math.max(0.05, Math.cos((90 - y / H * 180) * Math.PI / 180))) : (() => 1),
      joinKm: Number(g.railJoinKm ?? 5), cutKm: Number(g.railCutKm ?? 10), speed: Number(g.railSpeed ?? 4),
    };
  }
  let railCache = null;
  function railNet() {
    const rails = [...state.shapes.values()].filter(s => s.kind === 'rail' && !s.adminOnly);
    const o = railOpts();
    const key = `${rails.map(r => `${r.id}:${r.updatedAt}`).join(',')}|${o.joinKm}|${o.cutKm}`;
    if (railCache && railCache.key === key) return railCache.net;
    const net = RailNet.build(rails.map(r => ({ id: r.id, label: r.label, points: r.points, cuts: r.data?.cuts || [] })), o);
    railCache = { key, net };
    return net;
  }
  /** Sides that count as friends of a nation: itself and its allies (faction ids). */
  function friendIds(nation) {
    const n = String(nation || '').toLowerCase();
    const mine = (state.factions || []).find(f => f.name.toLowerCase() === n);
    const ids = new Set(mine ? [mine.id] : []);
    if (mine) for (const r of state.relations || []) if (r.status === 'alliance' && (r.a === mine.id || r.b === mine.id)) ids.add(r.a === mine.id ? r.b : r.a);
    return { mine, ids };
  }
  /** Track a nation may ride: its own and allies' ground, neutral ground and the sea (as on the server). */
  function railUsable(nation) {
    if (!gameOn()) return null;
    const { ids } = friendIds(nation);
    return e => { const o = renderer.territoryOwnerAt(e.mx, e.my); return o === null || o === undefined || o === 0 || ids.has(o); };
  }
  /** Drag preview: light up the track the unit could still reach this turn. */
  function showRailReach(lead, remaining) {
    if (!window.RailNet || remaining <= 0) return;
    const net = railNet();
    if (!net.edges.length) return;
    const segs = RailNet.reach(net, { x: lead.x, y: lead.y }, remaining, { usable: railUsable(lead.data?.nation), speed: railOpts().speed });
    const out = segs.map(r => {
      const e = net.edges[r.edge], A = net.nodes[e.a], B = net.nodes[e.b];
      return [A.x + (B.x - A.x) * r.from, A.y + (B.y - A.y) * r.from, A.x + (B.x - A.x) * r.to, A.y + (B.y - A.y) * r.to];
    });
    renderer.showRailReach(out);
    return out;
  }
  /** Drawn points → railway centreline: simplified and lightly rounded, ends snapped onto existing track. */
  function railPath(raw) {
    const pts = window.Trench ? Trench.processPath(raw, { tol: 2 / renderer.scale, zig: false }) : raw.map(p => [p[0], p[1]]);
    for (const i of [0, pts.length - 1]) { const q = renderer.snapToRail(pts[i][0], pts[i][1]); pts[i] = [q.x, q.y]; }
    return pts;
  }
  /** The nearest town, for "near Nancy" in popups and target lists. */
  function nearPlace(x, y) {
    let best = null, bd = Infinity;
    for (const m of state.markers.values()) {
      if (m.type !== 'town') continue;
      const d = distanceUnits(x, y, m.x, m.y);
      if (d < bd) { bd = d; best = m; }
    }
    if (!best) return '';
    return bd < 15 ? `at ${best.name}` : `${Math.round(bd)} ${state.lobby?.scaleLabel || 'km'} from ${best.name}`;
  }
  /**
   * Railway sections an attacker can hit: per rail, the nearest open section within reach on enemy ground
   * (at war), plus the nearest of its own side's track to blow up. Outside game mode, the nearest section.
   */
  function railTargetsFor(attacker, reach) {
    if (!window.RailNet) return [];
    const net = railNet();
    if (!net.edges.length) return [];
    const { mine, ids } = friendIds(attacker.data?.nation);
    const atWar = id => mine && (state.relations || []).some(r => ((r.a === mine.id && r.b === id) || (r.b === mine.id && r.a === id)) && r.status === 'war');
    const factionName = id => (state.factions || []).find(f => f.id === id)?.name || '';
    const best = new Map();   // `${railId}:${own}` -> target
    for (const e of net.edges) {
      if (e.cut || e.link) continue;
      const A = net.nodes[e.a], B = net.nodes[e.b];
      const p = RailNet.project([[A.x, A.y], [B.x, B.y]], attacker.x, attacker.y, railOpts().kx);
      const d = distanceUnits(attacker.x, attacker.y, p.x, p.y);
      if (d > reach + 1e-6) continue;
      let own = false, holder = '';
      if (gameOn()) {
        const o = renderer.territoryOwnerAt(p.x, p.y);
        if (o && ids.has(o)) own = true;
        else if (o && atWar(o)) holder = factionName(o);
        else if (state.role !== 'gm') continue;            // neutral ground, or a power you are not at war with
        else holder = o ? factionName(o) : '';
      }
      const key = `${e.rail}:${own}`;
      if (!best.has(key) || best.get(key).d > d) best.set(key, { railId: e.rail, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, d, own, holder });
    }
    return [...best.values()].map(t => ({ ...t, rail: state.shapes.get(t.railId), place: nearPlace(t.x, t.y) }))
      .filter(t => t.rail).sort((a, b) => (a.own - b.own) || (a.d - b.d));
  }
  /** Popup rows for a railway: speed, and each cut with Show / Repair. */
  function railPopupRows(s) {
    const g = state.game?.settings || {};
    const cuts = s.data?.cuts || [];
    let rows = stat('Traffic', `land units and heroes move ${g.railSpeed ?? 4}× faster on open track${gameOn() ? ' held by their side, an ally or no one' : ''}`);
    if (s.adminOnly) rows += stat('Status', 'GM only: a plan, no trains run on it for movement');
    if (!cuts.length) return rows + stat('Track', 'open');
    rows += `<div class="railcuts">${cuts.map(c => {
      const who = repairCrew(c);
      return `<div class="railcut"><span>💥 Cut ${esc(nearPlace(c.x, c.y))}${c.turn ? ` · turn ${esc(c.turn)}` : ''}${c.by ? ` · by ${esc(c.by)}` : ''}</span>
        <button class="small secondary" data-act="gocut" data-cut="${esc(c.id)}">Show</button>${who ? `<button class="small" data-act="repair" data-cut="${esc(c.id)}" title="${esc(who === true ? 'Repair as GM' : `Send ${who.name} to repair it (uses its action)`)}">🛠 Repair</button>` : ''}</div>`;
    }).join('')}</div>`;
    return rows;
  }
  /** Who can mend a cut: true for the GM, else the player's nearest unit or hero within the repair range. */
  function repairCrew(c) {
    if (state.role === 'gm') return true;
    const range = Number(state.game?.settings?.railRepairKm ?? 30);
    let best = null, bd = Infinity;
    for (const m of state.markers.values()) {
      if (!['unit', 'hero'].includes(m.type) || !canEdit(m)) continue;
      const d = distanceUnits(m.x, m.y, c.x, c.y);
      if (d <= range && d < bd) { bd = d; best = m; }
    }
    return best;
  }
  async function repairRail(s, cutId) {
    const c = (s.data?.cuts || []).find(x => x.id === cutId);
    if (!c) return;
    const who = repairCrew(c);
    if (!who) { toast(`No unit of yours within ${state.game?.settings?.railRepairKm ?? 30} ${state.lobby?.scaleLabel || 'km'} of the break`); return; }
    const d = await api.post(`${base}/game/rail/repair`, { shapeId: s.id, cutId, unitId: who === true ? undefined : who.id });
    if (d.shape) upsertShape(d.shape);
    toast(d.event.message);
    if (!state.events.some(x => x.id === d.event.id)) { state.events.push(d.event); renderLog(true); }
  }
  /** Players cannot lay track while the game is running. */
  function syncRailButton() {
    const btn = $('#btnDrawRail');
    if (btn) btn.hidden = gameOn() && state.role !== 'gm';
    $('#btnPing').hidden = state.role !== 'gm';
  }

  // ---- Supply, support units and matchups (docs/UNITS.md) ----------------------------------------------
  const supplyOn = () => gameOn() && state.game?.settings?.supplyEnabled !== false;
  /** Turns of supplies a land unit carries at most (rules: supplyStock). */
  const stockMax = () => Math.max(0, Math.round(Number(state.game?.settings?.supplyStock ?? 3)));
  /** What a unit has left of the supplies it carries (full when not yet worked out). */
  const stockOf = m => { const v = Number(m.data?.supplies); return Number.isFinite(v) ? v : stockMax(); };
  /** Out of supply: cut off with nothing left of what it carries. Cannot move or attack, double losses when beaten. */
  function cutOff(m) { return !!m && m.type === 'unit' && supplyOn() && m.data?.supplied === false && stockOf(m) <= 0; }
  const ENGINEER_IDS = ['engineers', 'pioneers', 'sappers'];
  /** What a support unit does for those around it, with its reach in km (null for other units). */
  function supportRole(m) {
    const s = state.game?.settings || {}, id = window.UnitTypes?.resolve(m.data?.unitType)?.id, u = state.lobby?.scaleLabel || 'km';
    if (id === 'supply') {
      const lb = s.supplyLinkBySize || {};
      return { km: Number(s.supplyRangeKm ?? 100), text: `supplies friendly land units within ${s.supplyRangeKm ?? 100} ${u} when linked: within ${lb.capital ?? 600} ${u} of a friendly capital, ${lb.city ?? 400} ${u} of a city, ${lb.village ?? 200} ${u} of a village, or ${s.supplyLinkKm ?? 150} ${u} of a railhead or another linked column` };
    }
    if (id === 'transport') return { km: Number(s.convoyRangeKm ?? 100), text: `a floating supply base: supplies friendly land units within ${s.convoyRangeKm ?? 100} ${u} and feeds Supply Columns within ${s.convoyLinkKm ?? 200} ${u}, anywhere (invasions)` };
    if (id === 'medical') return { km: Number(s.hospitalKm ?? 40), text: `heals friendly units within ${s.hospitalKm ?? 40} ${u} by ${s.hospitalHeal ?? 10}% each turn` };
    if (id === 'hq') return { km: Number(s.hqKm ?? 40), text: `+${s.hqBonus ?? 1} attack and defend to friendly units within ${s.hqKm ?? 40} ${u}` };
    if (ENGINEER_IDS.includes(id)) return { km: Number(s.engineerKm ?? 20), text: `+${s.engineerDefend ?? 1} defend to friendly units within ${s.engineerKm ?? 20} ${u}` };
    if (id === 'signals') return { km: Number(s.signalsKm ?? 60), text: `+${s.signalsArtillery ?? 1} attack to friendly artillery within ${s.signalsKm ?? 60} ${u}` };
    return null;
  }
  /** Popup rows: supply status, support role, and what the type is strong and weak against. */
  function unitDoctrineRows(m) {
    let rows = '';
    const t = window.UnitTypes?.resolve(m.data?.unitType);
    const land = !t || ['Infantry', 'Mounted & mobile', 'Artillery', 'Emplacements', 'Support'].includes(t.cat);
    if (supplyOn() && t?.cat === 'Emplacements') rows += stat('Supply', 'none needed (a fixed work with its own stores)');
    else if (supplyOn() && land) {
      const st = state.game?.settings || {}, cutTurns = Number(m.data?.unsuppliedTurns) || 0, left = stockOf(m), of = stockMax();
      const since = cutTurns ? ` for ${cutTurns} turn${cutTurns === 1 ? '' : 's'}` : '';
      rows += stat('Supply', m.data?.surrendered && Number(m.data?.strength ?? 100) <= 0 ? '⚑ SURRENDERED for want of supply'
        : m.data?.supplied === false && left <= 0
          ? `${left}/${of} · OUT OF SUPPLY${since}: cannot move or attack; double losses when beaten; loses ${st.attritionRate ?? 25}% strength at each End turn still cut off, surrenders below ${st.attritionDisbandBelow ?? 10}%`
          : m.data?.supplied === false
            ? `${left}/${of} · CUT OFF${since}: living on what it carries, one used at each End turn cut off (no replacements or hospital care meanwhile); at 0/${of} it is out of supply`
            : m.data?.supplied === true ? `${of}/${of} · supplied${supplySourceText(m.data.supplyFrom)}` : 'not yet worked out');
    }
    const role = supportRole(m);
    if (role && gameOn()) rows += stat('Support', role.text + (cutOff(m) ? ' (not while out of supply)' : ''));
    if (gameOn() && state.game?.settings?.fogOfWar) rows += stat('Vision', `${visionKm(m)} km${t?.id === 'submarine' ? ` · spotted only within ${state.game.settings.subSpotKm ?? 20} km` : ''} (plus research)`);
    if (window.Matchups && t) {
      const d = Matchups.describe(t);
      if (d.strong.length || d.weak.length) {
        rows += `<details class="sub matchups"><summary>Strengths and weaknesses</summary>${d.strong.map(x => `<div class="hint good">${esc(x)}</div>`).join('')}${d.weak.map(x => `<div class="hint bad">${esc(x)}</div>`).join('')}</details>`;
      }
    }
    return rows;
  }

  // ---- Click to move (game mode) ------------------------------------------------------------------
  // Select a unit or hero to see how far it can still go; click inside the ring (or on track it can reach)
  // to send it there. A selected group moves together, keeping its shape. The GM can still drag tokens.
  const MOVERS = ['unit', 'hero'];
  const rulesOn = () => gameOn() && !state.game?.settings?.waiveMovement;
  /** Phased turns: 'move', 'battle', or 'open' (no phases, or game mode off). */
  const phaseOf = () => (gameOn() ? state.game.phase || 'open' : 'open');
  /** In the battle phase a player's units hold their positions. */
  const holdsPosition = () => state.role !== 'gm' && phaseOf() === 'battle';
  const attacksClosed = () => state.role !== 'gm' && phaseOf() === 'move';
  function clickMoves(m) {
    return !!m && rulesOn() && MOVERS.includes(m.type) && canEdit(m) && !m.locked && !(m.type === 'hero' && ['travelling', 'captured'].includes(m.data?.status));
  }
  renderer.dragAllowed = m => !(rulesOn() && MOVERS.includes(m.type)) || state.role === 'gm';
  /** A turn's movement for a unit or hero, with its nation's research (as game.checkMove counts it). */
  function moveAllowance(m) {
    const t = m.type === 'unit' ? window.UnitTypes?.resolve(m.data?.unitType) : null, b = reachBonus[String(m.data?.nation || '').toLowerCase()];
    const bonus = b && t ? (Number(b.moveCat?.[t.cat]) || 0) + (Number(b.moveUnit?.[t.id]) || 0) : 0;
    return Math.max(0, (Number(m.data?.movement) || 0) + bonus) * (Number(state.game?.settings?.kmPerMove) || 50);
  }
  function remainingFor(m) {
    if (cutOff(m) || m.data?.attacked || holdsPosition()) return 0;   // attacked this turn (or the battle phase): stays put until the next
    return Math.max(0, moveAllowance(m) - (Number(m.data?.movedKm) || 0));
  }
  /** The selected tokens that move by click: { lead, list, remaining } (remaining = the slowest one's), or null. */
  function movers() {
    const ids = (state.selectedIds || []).length > 1 ? state.selectedIds : (state.selectedId != null ? [state.selectedId] : []);
    const list = ids.map(id => state.markers.get(id)).filter(clickMoves);
    if (!list.length) return null;
    const lead = list.find(m => m.id === state.selectedId) || list[0];
    return { lead, list, remaining: Math.min(...list.map(remainingFor)) };
  }
  let reachSegs = [], reachArea = null;
  function updateMoveRange() {
    syncFireRange();
    const ms = movers();
    reachSegs = []; reachArea = null;
    if (!ms) { renderer.hideRange(); return; }
    const { lead, list, remaining } = ms;
    const rx = remaining / (distanceUnits(lead.x, lead.y, lead.x + 1, lead.y) || 1);
    const ry = remaining / (distanceUnits(lead.x, lead.y, lead.x, lead.y + 1) || 1);
    reachArea = remaining > 0.01 ? reachFor(lead, remaining) : null;
    renderer.showRange(lead.x, lead.y, rx, remaining <= 0.01, ry, reachArea);
    if (remaining > 0.01 && list.every(canRide)) reachSegs = showRailReach(lead, remaining) || [];
    else renderer.hideRailReach();
  }
  // ---- Movement reach: the green area (public/js/reach.js) ------------------------------------------------
  // Worked out when the selection, its unit or the ground around it changes (a shape, a unit that may man a trench,
  // the rules), never per frame; cached by what it depends on, and changes in a burst (End turn) are run once.
  let reachMemo = { key: null, area: null }, reachVersion = 0, reachTimer = null;
  function reachChanged() {
    reachVersion++;
    if (reachTimer) return;
    reachTimer = setTimeout(() => { reachTimer = null; if (movers()) updateMoveRange(); }, 150);
  }
  const LAND_CATS = ['Infantry', 'Mounted & mobile', 'Artillery', 'Emplacements', 'Support'];
  /** How the server checks a token's course: 'land' (keeps off open water), 'ship' (keeps off land), or 'free'. */
  function courseKind(m) {
    if (m.type !== 'unit') return 'free';                       // heroes walk anywhere (server: isLandUnit)
    const cat = window.UnitTypes?.resolve(m.data?.unitType)?.cat;
    if (cat === 'Naval') return 'ship';
    return !cat || LAND_CATS.includes(cat) ? 'land' : 'free';
  }
  /** Segments of the dug enemy trenches a land unit would be halted at, each with a test for a visible defender near a point. */
  function reachWalls(m) {
    const S = state.game?.settings || {};
    if (!gameOn() || S.trenchBlocks === false) return [];
    const norm = s => String(s || '').trim().toLowerCase(), facs = state.factions || [], rels = state.relations || [];
    const me = facs.find(f => norm(f.name) === norm(m.data?.nation));
    if (!me) return [];
    const rel = (a, b) => { const [x, y] = a < b ? [a, b] : [b, a]; return rels.find(r => r.a === x && r.b === y)?.status || 'peace'; };
    const range = Number(S.trenchRangeKm ?? 20), out = [];
    for (const s of state.shapes.values()) {
      if (s.kind !== 'trench' || !s.data?.nation || s.data.state === 'plan' || (s.points || []).length < 2) continue;
      const holder = facs.find(f => norm(f.name) === norm(s.data.nation));
      if (!holder || holder.id === me.id || rel(me.id, holder.id) !== 'war') continue;
      const side = new Set([norm(holder.name), ...facs.filter(f => f.id !== holder.id && rel(f.id, holder.id) === 'alliance').map(f => norm(f.name))]);
      const guards = [...state.markers.values()].filter(u => u.type === 'unit' && u.id !== m.id && !u.data?.aboard && Number(u.data?.strength ?? 100) > 0
        && side.has(norm(u.data?.nation)) && courseKind(u) === 'land');
      if (!guards.length) continue;
      const manned = (x, y) => guards.some(u => distanceUnits(u.x, u.y, x, y) <= range);
      for (let i = 1; i < s.points.length; i++) out.push({ a: s.points[i - 1], b: s.points[i], manned });
    }
    return out;
  }
  /** The selected unit's reach as the server will judge it, or null where the plain circle is exact (the GM, open ground). */
  function reachFor(m, remaining) {
    if (!window.Reach || state.role === 'gm') return null;
    const S = state.game?.settings || {}, kind = courseKind(m);
    const key = [m.id, m.x, m.y, remaining, kind, reachVersion, Reach.ready(), S.noMansLandCost, S.trenchBlocks, S.trenchRangeKm,
      (state.relations || []).map(r => r.status[0]).join('')].join('|');
    if (reachMemo.key === key) return reachMemo.area;
    const areas = [...state.shapes.values()].filter(s => s.kind === 'area' && s.data?.noMansLand && (s.points || []).length >= 3).map(s => s.points);
    const walls = kind === 'land' ? reachWalls(m) : [];
    const plain = kind === 'free' || !isEarth();
    const area = plain && !areas.length && !walls.length ? null : Reach.compute({
      x: m.x, y: m.y, remaining, kind: isEarth() ? kind : 'free', dist: distanceUnits, perKm: kmToWorld(m.x, m.y, 1),
      nml: { mult: Number(S.noMansLandCost ?? 3), areas }, walls,
    });
    reachMemo = { key, area };
    return area;
  }
  /** Send the selection marching on (x, y): each keeps its place in the group; it goes as far as it can now, the rest at End turn. */
  async function orderMarch(ms, x, y) {
    const moves = ms.list.map(m => ({ id: m.id, x: round1(m.x + (x - ms.lead.x)), y: round1(m.y + (y - ms.lead.y)) }));
    try {
      const d = await api.post(`${base}/game/units/goal`, { moves });
      for (const m of d.moved || []) upsertMarker(m);
      const text = [d.message, ...(d.errors || [])].filter(Boolean).join(' · ');
      if (text) toast(`🚩 ${text}`, 8000);
    } catch (err) { toast(err.message); }
  }
  /**
   * A march as the server will carry it out, leg by leg: the route it would take from where it stands (by rail when
   * game.checkMove would board a train, else straight, paying No Man's Land), cut where each turn's movement runs out.
   * This turn's remaining movement first, then a full turn's at each End turn. Returns { legs: [[[x, y], …], …], turns:
   * [the turn each leg ends in], arrives }. The server plans each leg afresh, so a changing front can change the rest.
   */
  function marchLegs(m) {
    const g = m.data.goal, per = moveAllowance(m), turn0 = state.game?.turn || 1;
    let path = null;
    if (canRide(m) && window.RailNet) {
      const net = railNet();
      if (net.edges.length) path = RailNet.route(net, { x: m.x, y: m.y }, { x: g.x, y: g.y }, { usable: railUsable(m.data?.nation), speed: railOpts().speed })?.path || null;
    }
    const walking = !path;
    if (walking) path = [[m.x, m.y, 1], [g.x, g.y, 1]];
    if (per <= 0) return { legs: [path.map(p => [p[0], p[1]])], turns: [null], arrives: null };
    const mult = Math.max(1, Number(state.game?.settings?.noMansLandCost ?? 3));
    const areas = walking && mult > 1 ? [...state.shapes.values()].filter(s => s.kind === 'area' && s.data?.noMansLand && (s.points || []).length >= 3).map(s => {
      const xs = s.points.map(p => p[0]), ys = s.points.map(p => p[1]);
      return { p: s.points, b: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
    }) : [];
    const inRing = (pts, x, y) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
    const mud = (x, y) => areas.some(a => x >= a.b[0] && x <= a.b[2] && y >= a.b[1] && y <= a.b[3] && inRing(a.p, x, y));
    let budget = remainingFor(m), turn = turn0;
    if (budget <= 0.01) { budget = per; turn++; }   // nothing left this turn: it goes on at the next End turn
    const legs = [], turns = [];
    let leg = [[path[0][0], path[0][1]]];
    const ds = per / 60;   // small enough to find No Man's Land and the turn's end within a km or two
    outer: for (let i = 1; i < path.length; i++) {
      const [ax, ay] = path[i - 1], [bx, by, f = 1] = path[i], L = distanceUnits(ax, ay, bx, by), n = Math.max(1, Math.ceil(L / ds));
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n, px = ax + (bx - ax) * t0, py = ay + (by - ay) * t0, qx = ax + (bx - ax) * t1, qy = ay + (by - ay) * t1;
        const c = L / n * f * (areas.length && mud((px + qx) / 2, (py + qy) / 2) ? mult : 1);
        let frac = 0;
        while (c * (1 - frac) > budget + 1e-9) {
          frac += budget / c;
          const sx = px + (qx - px) * frac, sy = py + (qy - py) * frac;
          leg.push([sx, sy]); legs.push(leg); turns.push(turn);
          if (legs.length >= 40) break outer;   // a march of more than 40 turns: the rest is drawn as one leg
          leg = [[sx, sy]]; turn++; budget = per;
        }
        budget -= c * (1 - frac);
      }
      leg.push([bx, by]);
    }
    if (legs.length >= 40) leg = [leg[0], [g.x, g.y]];
    legs.push(leg); turns.push(legs.length > 40 ? null : turn);
    return { legs, turns, arrives: legs.length > 40 ? null : turn };
  }
  /** The march lines, legs and flags of every order this viewer may see (their own side's; the GM all), batched and cached. */
  const marchMemo = new Map();
  let marchTimer = null;
  function syncMarches() {
    if (marchTimer) return;
    marchTimer = setTimeout(() => {
      marchTimer = null;
      const sel = new Set(state.selectedIds?.length ? state.selectedIds : state.selectedId != null ? [state.selectedId] : []);
      const S = state.game?.settings || {}, ver = [state.game?.turn, phaseOf(), S.kmPerMove, S.noMansLandCost, S.railSpeed, railNet().edges.length, reachVersion].join('|');
      const list = [];
      for (const m of state.markers.values()) {
        if (!m.data?.goal || !['unit', 'hero'].includes(m.type)) continue;
        const key = [m.x, m.y, m.data.goal.x, m.data.goal.y, m.data.movedKm, m.data.movement, m.data.supplied, m.data.supplies, m.data.attacked, ver].join('|');
        let plan = marchMemo.get(m.id);
        if (!plan || plan.key !== key) { plan = { key, ...marchLegs(m) }; marchMemo.set(m.id, plan); }
        list.push({ legs: plan.legs, turns: plan.turns, color: colorNum(m.color), selected: sel.has(m.id) });
      }
      renderer.setMarches(list);
    }, 30);
  }
  /** A unit's or hero's marching order in its panel: where to, how far, and a button to call it off. */
  function marchRow(m) {
    const g = m.data?.goal;
    if (!g || !gameOn()) return '';
    const u = state.lobby?.scaleLabel || 'km', left = distanceUnits(m.x, m.y, g.x, g.y);
    const plan = marchLegs(m), when = plan.arrives == null ? '' : plan.arrives === state.game.turn ? ', arrives this turn' : `, arrives in turn ${plan.arrives} (${plan.arrives - state.game.turn} more End turn${plan.arrives - state.game.turn === 1 ? '' : 's'})`;
    return rawStat('Marching', `🚩 ${esc(nearPlace(g.x, g.y) || 'to its objective')} · ${fmtNum(left)} ${u} to go${when}`
      + (canEdit(m) ? ' <button type="button" class="small secondary" data-act="unmarch" title="Call off the march; it stays where it is">✕ Cancel</button>' : ''));
  }
  function insideReach(ms, x, y) {
    if (ms.remaining <= 0.01) return false;
    if (reachArea ? Reach.contains(reachArea, x, y) : distanceUnits(ms.lead.x, ms.lead.y, x, y) <= ms.remaining + 1e-6) return true;
    const tol = 16 / renderer.scale;
    return reachSegs.some(([x1, y1, x2, y2]) => RailNet.project([[x1, y1], [x2, y2]], x, y).d2 <= tol * tol);
  }
  // Left-click selects; right-click on the map sends the selection there. Right-click on a unit opens its panel.
  renderer.addEventListener('mapcontext', e => {
    const { x, y } = e.detail;
    if (state.placing || renderer.mode) return;
    const ms = movers();
    if (!ms) return;
    const c = ms.list.find(cutOff);
    if (c) { toast(`${c.name} is out of supply and cannot move until a Supply Column reaches it`); return; }
    // Beyond this turn's reach (or none left, or the battle phase): a marching order, carried on at each End turn.
    if (holdsPosition() || ms.remaining <= 0.01 || !insideReach(ms, x, y)) { orderMarch(ms, x, y); return; }
    if (ms.list.length === 1) commitMove({ id: ms.lead.id, x, y });
    else commitMove({ id: ms.lead.id, moves: ms.list.map(m => ({ id: m.id, x: m.x + (x - ms.lead.x), y: m.y + (y - ms.lead.y) })) });
  });

  // ---- GM pings ---------------------------------------------------------------------------------------
  const pingGo = document.createElement('button');
  pingGo.type = 'button'; pingGo.className = 'small'; pingGo.id = 'pingGo'; pingGo.hidden = true;
  pingGo.textContent = '📍 Go to ping'; pingGo.title = 'Centre the map on the GM\'s latest ping';
  pingGo.onclick = () => { if (!renderer.goToPing()) pingGo.hidden = true; };
  $('#notifWrap').appendChild(pingGo);
  let pingTimer = null;
  function showPing(p, quiet) {
    renderer.addPing(p);
    pingGo.hidden = false;
    clearTimeout(pingTimer);
    pingTimer = setTimeout(() => { pingGo.hidden = true; }, Math.max(0, p.until - Date.now()));
    if (!quiet && p.by !== me.displayName) { toast(`📍 ${p.by} pinged the map${p.label ? `: ${p.label}` : ''}`, 4000); notify('Map ping', `${p.by} pinged the map`); }
  }
  function armPing() {
    if (state.placing?.ping) { disarmPlacing(); return; }
    disarmPlacing();
    state.placing = { ping: true };
    renderer.setPassThrough(true);
    renderer.app.canvas.style.cursor = 'crosshair';
    $('#modeHud').classList.add('show');
    $('#btnModeUndo').hidden = true; $('#btnModeClear').hidden = true; $('#btnModeDone').hidden = true;
    $('#modeText').textContent = 'Ping: click a spot on the map; everyone sees it for a minute. Esc to cancel.';
    $('#btnPing').classList.add('active');
  }
  /** This turn's gunfire and shelling, and craters from the last ten turns (End turn clears old ones on the server). */
  async function loadBattles() {
    try { const d = await api.get(`${base}/battles`); renderer.setBattles(d.battles, d.past); renderer.setCraters(d.craters || []); } catch { /* none */ }
  }
  async function loadPings() {
    try { for (const p of (await api.get(`${base}/pings`)).pings) showPing(p, true); } catch { /* none */ }
  }

  /** Game mode keeps movement trails until End turn instead of fading arrows. */
  function syncTrails() {
    const on = gameOn();
    if (renderer.persistTrails !== on) { renderer.persistTrails = on; renderer.redrawTrails(); }
  }

  renderer.addEventListener('select', e => {
    if (e.detail.id !== state.panelFor) state.panelFor = null;   // the panel belongs to the token it was opened on
    state.selectedId = e.detail.id; state.selectedIds = e.detail.ids || []; state.selectedShapeId = e.detail.shapeId;
    const sel = e.detail.id != null ? state.markers.get(e.detail.id) : null;
    if (sel && PANEL_ON_RIGHT.includes(sel.type) && state.panelFor !== sel.id && !panelHinted) {
      panelHinted = true;
      toast(rulesOn() ? 'Right-click the map to move it there · right-click an enemy to attack it · right-click your own unit for its panel' : 'Right-click an enemy to attack it · right-click your own unit for its panel', 4000);
    }
    renderPopup(); highlightList();
    renderer.clearTarget();
    if (renderer._marches) syncMarches();   // the selected march stands out
    updateMoveRange();
    renderSelBar();
    if (state.selectedIds.length > 1) toast(`${state.selectedIds.length} tokens selected: ${rulesOn() ? 'right-click inside the ring to move them together' : 'drag any of them to move the group'}`, 1800);
  });
  renderer.addEventListener('mode', e => {
    $('#btnSelect').classList.toggle('active', e.detail.mode === 'select');
    if (e.detail.mode === 'select') {
      showModeHud(true);
      $('#modeText').textContent = 'Select: drag a box around tokens (Shift adds to the selection); drag any selected token to move them all';
    } else if (!e.detail.mode) hideModeHud();
  });
  renderer.addEventListener('drag', e => wsSend({ type: 'drag', ...e.detail }));
  // Game mode: show how far the dragged unit (or the slowest of a group) may still move this turn.
  renderer.addEventListener('dragstart', e => {
    if (!gameOn() || state.role === 'gm' || state.game.settings.waiveMovement) return;
    const units = e.detail.ids.map(id => state.markers.get(id)).filter(m => m && m.type === 'unit');
    if (!units.length) return;
    const km = state.game.settings.kmPerMove;
    const remaining = Math.min(...units.map(m => m.data?.attacked ? 0 : Math.max(0, (Number(m.data?.movement) || 0) * km - (Number(m.data?.movedKm) || 0))));
    const lead = state.markers.get(e.detail.id);
    const perPx = distanceUnits(lead.x, lead.y, lead.x + 1, lead.y) || 1;   // local map units per pixel
    renderer.showRange(lead.x, lead.y, remaining / perPx, remaining <= 0.01);
    if (units.every(canRide)) showRailReach(lead, remaining);
  });
  renderer.addEventListener('dragend', e => commitMove(e.detail));
  /** Send a move (one token, or a group's moves) to the server and apply what it decided. */
  async function commitMove({ id, x, y, moves }) {
    try {
      if (moves) {
        const d = await api.post(`${base}/markers/move`, { moves: moves.map(m => ({ id: m.id, x: round1(m.x), y: round1(m.y) })) });
        for (const m of d.markers) upsertMarker(m);
        if (d.errors.length) { toast(d.errors.join('; ')); await loadMarkers(); }
        if (d.note) toast(d.note);
      } else {
        const d = await api.patch(`${base}/markers/${id}`, { x: round1(x), y: round1(y) });
        upsertMarker(d.marker);
        if (d.note) toast(d.note);
      }
      if (gameOn()) GameUI.renderNation();
    } catch (err) {
      toast(err.message);
      const m = state.markers.get(id);
      if (m) renderer.upsert(m);
      if (moves) await loadMarkers();
    }
    updateMoveRange();
  }
  renderer.addEventListener('zoom', e => { $('#zoomLabel').textContent = Math.round(e.detail.scale * 100) + '%'; });
  renderer.addEventListener('measure', e => {
    const d = e.detail;
    $('#btnMeasure').classList.toggle('active', !!d);
    if (!d) { if (renderer.mode !== 'draw') hideModeHud(); return; }
    showModeHud(true);
    if (d.points === 0) { $('#modeText').textContent = 'Measure: click points on the map'; return; }
    const units = d.pts ? pathUnits(d.pts) : d.px * (state.lobby?.unitsPerPx || 1);
    $('#modeText').textContent = `${fmtNum(units)} ${state.lobby?.scaleLabel || ''} · ${Math.round(d.px)} px · ${d.points} point${d.points === 1 ? '' : 's'}`;
  });
  renderer.addEventListener('shapeedit', async e => {
    const { id, points } = e.detail;
    try {
      const d = await api.patch(`${base}/shapes/${id}`, { points });
      upsertShape(d.shape);
    } catch (err) {
      toast(err.message);
      await loadShapes();
    }
  });
  renderer.addEventListener('drawprogress', e => {
    const d = e.detail;
    $('#btnDrawLine').classList.toggle('active', !!d && d.kind === 'line');
    $('#btnDrawArea').classList.toggle('active', !!d && d.kind === 'area');
    $('#btnDrawTrench').classList.toggle('active', !!d && d.kind === 'trench');
    $('#btnDrawRail').classList.toggle('active', !!d && d.kind === 'rail');
    if (!d) { if (renderer.mode !== 'measure') hideModeHud(); return; }
    showModeHud(false);
    const need = d.kind === 'area' ? 3 : 2;
    if (d.kind === 'corps') { $('#modeText').textContent = d.points < 2 ? 'Corps line: click points along the front' : `${d.points} points · double-click, Enter or Done, then click the enemy's side`; return; }
    const what = d.kind === 'area' ? 'an area' : d.kind === 'trench' ? 'a trench' : d.kind === 'rail' ? 'a railway' : 'a line';
    $('#modeText').textContent = d.points < need
      ? `Drawing ${what}: ${d.kind === 'trench' || d.kind === 'rail' ? `click points or drag freehand${d.kind === 'rail' ? '; clicks near other track join it' : ''}` : `click ${need - d.points} more point${need - d.points === 1 ? '' : 's'}`}`
      : `${d.points} points · double-click, Enter or Done to finish${d.kind === 'trench' ? ' (the line is smoothed and traversed when you do)' : ''}`;
  });
  renderer.addEventListener('drawend', async e => {
    if (e.detail.shapeId) {
      // Continuing an existing line: just save the new points.
      try {
        const prev = state.shapes.get(e.detail.shapeId);
        let points = e.detail.points;
        if (prev && prev.kind === 'trench') {
          // Only the newly drawn tail is processed; the existing centreline stays as it was.
          const n = prev.points.length;
          const p0 = prev.points[n - 1];
          const wPx = Math.max(renderer.unitsToPx(p0[0], p0[1], prev.width || 0.5), 10 / renderer.scale);
          const tail = Trench.processPath([p0, ...points.slice(n)], { tol: 2 / renderer.scale, width: wPx, zig: prev.data?.zigzag !== false });
          points = [...prev.points, ...tail.slice(1)];
        } else if (prev && prev.kind === 'rail') {
          const n = prev.points.length;
          points = [...prev.points, ...railPath([prev.points[n - 1], ...points.slice(n)]).slice(1)];
        }
        const d = await api.patch(`${base}/shapes/${e.detail.shapeId}`, { points });
        upsertShape(d.shape); renderer.selectShape(d.shape.id);
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.detail.kind === 'corps') { armCorpsFront(e.detail.points); return; }
    if (e.detail.kind === 'rail') { openShapeModal(null, { kind: 'rail', points: railPath(e.detail.points) }); return; }
    if (e.detail.kind === 'trench') {
      // Keep the raw samples so the modal can re-process them with or without traverses.
      openShapeModal(null, { kind: 'trench', raw: e.detail.points, points: Trench.processPath(e.detail.points, { tol: 2 / renderer.scale, width: 10 / renderer.scale, zig: true }) });
      return;
    }
    openShapeModal(null, e.detail);
  });

  function showModeHud(measure) {
    $('#modeHud').classList.add('show');
    $('#btnModeDone').hidden = measure;
    const selecting = renderer.mode === 'select';
    $('#btnModeUndo').hidden = selecting;
    $('#btnModeClear').hidden = selecting;
  }
  function hideModeHud() {
    if (state.placing) { updatePlaceHud(); return; }   // quick-add placement keeps its own HUD text
    $('#modeHud').classList.remove('show');
  }

  // ---- Quick add: click a unit type, then click the map to drop numbered units ------------
  const counterCache = new Map();
  async function counterImg(typeName, color) {
    const key = `${typeName}|${color}`;
    if (!counterCache.has(key)) counterCache.set(key, renderer.counterImage(typeName, color));
    return counterCache.get(key);
  }
  function quickNation() { return $('#qaNation')?.value ?? ''; }
  function quickColor() { return factionByName(quickNation())?.color || state.member?.color || '#3498db'; }
  /** The name the server will most likely give the next unit of this type for the chosen faction. */
  function nextQuickName(t) {
    const nation = quickNation();
    const names = [...state.markers.values()].filter(m => m.type === 'unit' && String(m.data?.nation || '').toLowerCase() === nation.toLowerCase()).map(m => m.name);
    return window.Naming ? Naming.nextName(names, t.unit, nation) : t.unit;
  }
  function armPlacing(typeId) {
    if (state.placing?.typeId === typeId) { disarmPlacing(); return; }
    const t = window.UnitTypes.LIST.find(x => x.id === typeId);
    if (!t) return;
    state.placing = { typeId, type: t };
    $$('#qaList .qa').forEach(b => b.classList.toggle('active', b.dataset.qa === typeId));
    renderer.app.canvas.style.cursor = 'copy';
    updatePlaceHud();
  }
  function disarmPlacing() {
    if (!state.placing) return;
    if (state.placing.corpsFront) renderer.hideCorpsLine();
    state.placing = null;
    renderer.setPassThrough(false);
    $$('#qaList .qa').forEach(b => b.classList.remove('active'));
    $('#qaResPlace')?.classList.remove('active');
    $('#qaHeroPlace')?.classList.remove('active');
    $('#btnPing')?.classList.remove('active');
    renderer.app.canvas.style.cursor = renderer.mode ? 'crosshair' : '';
    if (!renderer.mode) $('#modeHud').classList.remove('show');
  }
  function updatePlaceHud() {
    // While placing, existing tokens and drawings let clicks through so every click lands on the map.
    renderer.setPassThrough(!!state.placing);
    if (!state.placing || renderer.mode) return;
    $('#modeHud').classList.add('show');
    $('#btnModeUndo').hidden = true; $('#btnModeClear').hidden = true; $('#btnModeDone').hidden = true;
    if (state.placing.resource) {
      const r = window.GameData?.byKey[state.placing.resource];
      $('#modeText').textContent = `Placing ${r ? r.name.toLowerCase() : 'resource'} nodes (+${state.placing.yield}/turn) for ${quickNation() || 'no one'}: click the map. Esc to stop.`;
      return;
    }
    if (state.placing.brush) {
      const b = state.placing.brush;
      const what = b.km > 0 ? (renderer.provinces?.length ? `every province within ${b.km} km` : `a ${b.km} km circle`) : 'the clicked province';
      $('#modeText').textContent = `Territory brush: each click ${b.factionId ? 'gives ' + b.name : 'makes neutral'} ${what}. Esc to stop.`;
      return;
    }
    if (state.placing.factory) {
      $('#modeText').textContent = `New factory: click the map within ${state.game?.settings?.factoryRangeKm ?? 50} ${state.lobby?.scaleLabel || 'km'} of one of your cities or towns. Esc to cancel.`;
      return;
    }
    if (state.placing.corpsFront) {
      $('#modeText').textContent = `${state.placing.corpsFront.name}: click on the enemy's side of the line. Esc to cancel.`;
      return;
    }
    if (state.placing.hero) {
      const h = state.placing.hero;
      $('#modeText').textContent = `Placing a ${H.starText(h.stars)} ${(H.ROLES[h.role] || H.ROLES.general).label.toLowerCase()} for ${quickNation() || 'no one'}: click the map. Esc to cancel.`;
      return;
    }
    const t = state.placing.type;
    $('#modeText').textContent = `Placing ${quickNation() || 'unaligned'} ${t.unit}: click the map (next: ${nextQuickName(t)}). Esc to stop.`;
  }
  renderer.addEventListener('mapclick', async e => {
    if (!state.placing) return;
    if (state.placing.corpsFront) { await formCorpsLine(e.detail.x, e.detail.y); return; }
    if (state.placing.ping) {
      try { const d = await api.post(`${base}/pings`, { x: round1(e.detail.x), y: round1(e.detail.y) }); showPing(d.ping, true); }
      catch (err) { toast(err.message); }
      disarmPlacing();
      return;
    }
    if (state.placing.factory) {
      if (await GameUI.buildFactoryAt(round1(e.detail.x), round1(e.detail.y))) disarmPlacing();
      return;
    }
    if (state.role !== 'gm') return;
    if (state.placing.brush) {
      const b = state.placing.brush;
      try {
        const r = await api.post(`${base}/game/territory/brush`, { factionId: b.factionId, x: round1(e.detail.x), y: round1(e.detail.y), radiusKm: b.km });
        if (r.flipped) toast(`${r.flipped} place${r.flipped === 1 ? '' : 's'} changed hands`, 1500);
      } catch (err) { toast(err.message); }
      return;
    }
    if (state.placing.resource) {
      const r = window.GameData?.byKey[state.placing.resource];
      const nation = quickNation();
      try {
        const res = await api.post(`${base}/markers`, {
          type: 'resource', name: r ? r.name : state.placing.resource, color: quickColor(), x: round1(e.detail.x), y: round1(e.detail.y),
          data: { kind: state.placing.resource, yield: state.placing.yield, nation },
        });
        upsertMarker(res.marker); toast(`Placed ${res.marker.name} (+${state.placing.yield}/turn${nation ? ' for ' + nation : ''})`);
        if (gameOn()) GameUI.load().catch(() => {});
      } catch (err) { toast(err.message); }
      return;
    }
    if (state.placing.hero) {
      const h = state.placing.hero, nation = quickNation(), role = H.ROLES[h.role] || H.ROLES.general;
      try {
        const r = await api.post(`${base}/markers`, {
          type: 'hero', name: h.name || `${nation ? nation + ' ' : ''}${role.label.toLowerCase()}`, color: quickColor(), x: round1(e.detail.x), y: round1(e.detail.y),
          data: { ...H.defaults(h.role, h.stars), nation },
        });
        upsertMarker(r.marker);
        disarmPlacing();
        openPanel(r.marker.id);
        toast(`Placed ${r.marker.name}: upload a portrait from Edit`);
      } catch (err) { toast(err.message); }
      return;
    }
    const t = state.placing.type, nation = quickNation();
    const d = window.UnitTypes.defaults(t, state.lobby?.settings?.unitStats) || {};
    try {
      const r = await api.post(`${base}/markers`, {
        type: 'unit', autoName: true, color: quickColor(), x: round1(e.detail.x), y: round1(e.detail.y),
        data: { nation, unitType: t.name, ...d, strength: 100 },
      });
      upsertMarker(r.marker);
      toast(`Placed ${r.marker.name}`);
      updatePlaceHud();
    } catch (err) { toast(err.message); }
  });

  // ---- Loading ------------------------------------------------------------------------
  async function loadLobby() {
    const d = await api.get(base);
    state.lobby = d.lobby; state.members = d.members; state.role = d.you.role; state.member = d.you.member;
    state.realRole = d.you.realRole || d.you.role; state.viewAs = d.you.viewAs || null;
    if (viewAsParam && !state.viewAs) {   // not a GM, or that nation is gone: back to the normal view
      delete api.headers['X-View-As'];
      const u = new URL(location.href); u.searchParams.delete('as'); history.replaceState(null, '', u.href);
    }
    applyLobby();
    renderMembers();
    await applyMap();
  }

  function applyLobby() {
    const l = state.lobby;
    document.title = `${l.name} · WoE Strategy Map`;
    $('#lobbyName').textContent = l.name;
    const gm = state.role === 'gm';
    $('#btnSettings').hidden = !gm;
    $('#btnEmptyUpload').hidden = !gm;
    $('#emptyMapText').textContent = gm ? 'Upload a map image in the campaign settings to get started.' : 'The game master has not uploaded a map for this campaign yet.';
    $('#joinCodeBlock').hidden = !gm;
    if (gm) {
      $('#joinCodeBlock').innerHTML = `<h4>Join code</h4><p><span class="code">${esc(l.joinCode)}</span> <button class="small secondary" id="btnCopyCode">Copy</button></p><p class="hint">Players enter this on the campaigns page.</p>`;
      $('#btnCopyCode').onclick = () => navigator.clipboard.writeText(l.joinCode).then(() => toast('Join code copied'));
    }
    $('#shapeGmFields').hidden = !gm;
    renderer.setTokenScale(l.settings?.tokenScale || 1);
    renderer.setTokenMode(l.settings?.tokenMode || 'map');
    renderViewAs();
    renderAddForm();
    renderNationList();
  }

  async function applyMap() {
    const l = state.lobby;
    const key = `${l.mapKind}|${l.mapUrl}|${l.mapWidth}x${l.mapHeight}|${JSON.stringify(l.settings?.earth || null)}`;
    if (key === state.mapKey) return;
    state.mapKey = key;
    $('#emptyMap').classList.toggle('show', l.mapKind === 'none');
    if (l.mapKind === 'earth') {
      toast('Building the Earth…', 1500);
      try { await renderer.setEarth(l.settings.earth); }
      catch (err) { toast(`Earth map failed: ${err.message}`); await renderer.setMap(null, l.mapWidth, l.mapHeight); }
    } else {
      await renderer.setMap(l.mapUrl, l.mapWidth, l.mapHeight);
    }
    if (renderer.territoryViews.size && renderer.earth?.tintLayer) renderer.earth.tintLayer.visible = false;
  }

  /** Game mode: draw the faction territories (fetched once, then kept up to date over the socket). */
  async function loadTerritories() {
    if (!gameOn()) { renderer.setTerritories([], true); return; }
    try {
      const d = await api.get(`${base}/game/territories`);
      renderer.setFactionInfo(state.factions);
      renderer.setTerritories(d.territories, true);
    } catch (err) { console.warn('territories', err); }
  }

  /** Player factory: click the map near one of your cities or towns to start building. */
  function armFactory() {
    disarmPlacing();
    state.placing = { factory: true };
    renderer.app.canvas.style.cursor = 'copy';
    updatePlaceHud();
  }

  /** Game mode on the Earth map: the province set (edges and names), fetched once and after regeneration. */
  /** Fog of war (docs/FOG-OF-WAR.md): what this viewer sees, drawn as a dark overlay, plus last known enemy positions. */
  async function loadVision() {
    try { const v = await api.get(`${base}/game/vision`); state.fog = v; renderer.setFog(v); } catch (err) { console.warn('vision', err); }
  }
  /** A unit's sight under fog of war (km), from the campaign's table; research can add to it. */
  function visionKm(m) {
    const v = state.game?.settings?.vision || {}, t = window.UnitTypes?.resolve(m.data?.unitType);
    return Number(v[t?.id] ?? v[t?.cat] ?? 50);
  }
  async function loadProvinces() {
    if (!gameOn() || !isEarth()) { renderer.setProvinces([]); return; }
    try {
      const [d, o] = await Promise.all([api.get(`${base}/game/provinces`), api.get(`${base}/game/provinces/owners`)]);
      renderer.setProvinces(d.provinces || []);
      renderer.setProvinceOwners(o.owners || [], true);
      GameUI.onTerritories();
    } catch (err) { console.warn('provinces', err); }
  }
  /**
   * Border drawings imported from a historical year ("Norway", "Norway (2)"…, locked areas) are redundant once
   * provinces exist and clutter the map: remove the ones whose label is a state the provinces were cut from.
   */
  async function removeBorderDrawings() {
    if (state.role !== 'gm') return 0;
    const names = new Set((renderer.provinces || []).map(p => p.s).filter(Boolean).map(s => s.toLowerCase()));
    if (!names.size) return 0;
    const doomed = [...state.shapes.values()].filter(s => s.kind === 'area' && s.locked && names.has(String(s.label || '').replace(/ \(\d+\)$/, '').toLowerCase()));
    let n = 0;
    for (const s of doomed) { try { await api.del(`${base}/shapes/${s.id}`); removeShape(s.id); n++; } catch (err) { toast(err.message); break; } }
    return n;
  }
  // Hover: name the province (and its owner) under the pointer on the HUD.
  let hoverRaf = 0;
  renderer.app.canvas.addEventListener('pointermove', e => {
    if (hoverRaf || !renderer.provinces || !renderer.provinces.length) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const rect = renderer.app.canvas.getBoundingClientRect();
      const p = renderer.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const prov = renderer.provinceAt(p.x, p.y);
      const el = $('#provinceLabel');
      if (!prov) { el.hidden = true; return; }
      const owner = renderer.territoryOwnerAt(p.x, p.y);
      const f = owner ? state.factions.find(x => x.id === owner) : null;
      el.textContent = `${prov.n} · ${f ? f.name : owner === 0 ? 'neutral' : 'unclaimed'}`;
      el.hidden = false;
    });
  });
  renderer.app.canvas.addEventListener('pointerleave', () => { $('#provinceLabel').hidden = true; });

  /** GM territory brush: click the map to paint (or erase, factionId 0) a circle of the given radius (0: one province). */
  function armBrush(factionId, km, name) {
    disarmPlacing();
    state.placing = { brush: { factionId, km, name } };
    renderer.app.canvas.style.cursor = 'crosshair';
    updatePlaceHud();
  }

  async function loadMarkers() {
    const d = await api.get(`${base}/markers`);
    const seen = new Set();
    for (const m of d.markers) { seen.add(m.id); upsertMarker(m, true); }
    for (const id of [...state.markers.keys()]) if (!seen.has(id)) removeMarker(id);
    for (const m of state.markers.values()) if (isConvoyM(m)) refreshConvoy(m.id);   // cargo counts once everyone is loaded
  }

  async function loadShapes() {
    const d = await api.get(`${base}/shapes`);
    const seen = new Set();
    for (const s of d.shapes) { seen.add(s.id); upsertShape(s); }
    for (const id of [...state.shapes.keys()]) if (!seen.has(id)) removeShape(id);
  }

  async function loadEvents() {
    const d = await api.get(`${base}/events?limit=100`);
    state.events = d.events;
    renderLog();
  }

  async function loadHistory() {
    const d = await api.get(`${base}/history?limit=150`);
    state.history = d.entries;
    renderHistory();
  }

  async function loadMembers() {
    const d = await api.get(base);
    state.members = d.members; state.member = d.you.member;
    if (d.you.role !== state.role) { state.role = d.you.role; state.lobby = d.lobby; applyLobby(); await loadMarkers(); await loadShapes(); }
    renderMembers();
    renderFactions();
    refreshFormLists();
    renderNationList();
    reapplyFlags();
    renderReady();
  }

  async function loadFactions() {
    const d = await api.get(`${base}/factions`);
    state.factions = d.factions;
    renderFactions();
    renderReady();
    refreshFormLists();
    renderNationList();
    reapplyFlags();
  }

  /** Update the faction and owner dropdowns in the Add/Edit forms in place, keeping the current choice. */
  function refreshFormLists() {
    const qa = document.getElementById('qaNation');
    if (qa) {
      // Quick-add faction picker: factions arrive after the form is first drawn; keep the choice if it still exists.
      const cur = qa.value;
      qa.innerHTML = nationOptions().replace('<option value="__custom">Custom…</option>', '');
      qa.querySelector('option[value=""]').textContent = '— unaligned —';
      const names = [...qa.options].map(o => o.value);
      qa.value = names.includes(cur) && cur ? cur : (names.includes(state.member?.nation || '') && state.member?.nation ? state.member.nation : (state.factions[0]?.name || ''));
      if (qa.value !== cur) qa.dispatchEvent(new Event('change'));
    }
    for (const p of ['add', 'edit']) {
      for (const id of ['Nation', 'TownNation', 'ResNation', 'FacNation']) {
        const sel = document.getElementById(p + id + 'Sel');
        if (!sel) continue;
        const cur = sel.value;
        const custom = document.getElementById(p + id)?.value || '';
        sel.innerHTML = nationOptions();
        // A nation typed as "custom" before the factions arrived may now be a real faction: re-resolve it.
        if (cur === '__custom' && custom) setNation(p, id, custom);
        else sel.value = [...sel.options].some(o => o.value === cur) ? cur : '';
      }
      const owner = document.getElementById(p + 'Owner');
      if (owner) {
        const cur = owner.value;
        owner.innerHTML = '<option value="">— none —</option>' + state.members.map(m => `<option value="${m.userId}">${esc(m.displayName)}</option>`).join('');
        owner.value = [...owner.options].some(o => o.value === cur) ? cur : '';
      }
    }
  }

  function factionByName(name) {
    const n = String(name || '').trim().toLowerCase();
    return n ? state.factions.find(f => f.name.toLowerCase() === n) : null;
  }

  /** Which flag a marker shows: its own nation, or for player tokens the owner's faction. */
  function flagFor(m) {
    let nation = m.data?.nation;
    if (m.type === 'player' && !nation && m.ownerId) nation = state.members.find(x => x.userId === m.ownerId)?.nation;
    const f = factionByName(nation);
    return f && f.flagUrl ? f.flagUrl : null;
  }

  function reapplyFlags() {
    renderer.setFactionInfo(state.factions);
    for (const m of state.markers.values()) {
      const url = flagFor(m);
      if (url !== m.flagUrl) { m.flagUrl = url; renderer.upsert(m); }
    }
    renderMarkerLists();
  }

  function upsertMarker(m, quiet) {
    const prev = state.markers.get(m.id), isNew = !prev;
    m.flagUrl = flagFor(m);
    state.markers.set(m.id, m);
    showMarker(m, prev);
    strengthChanged(prev, m);
    if ((prev?.data?.aboard || 0) !== (m.data?.aboard || 0)) { refreshConvoy(prev?.data?.aboard); refreshConvoy(m.data?.aboard); }
    if (isNew && !quiet) renderer.pulse(m.x, m.y, colorNum(m.color));
    renderMarkerLists();
    if (state.selectedId === m.id) renderPopup();
    if (m.data?.goal || prev?.data?.goal) syncMarches();
    if (state.selectedId === m.id || (state.selectedIds || []).includes(m.id)) updateMoveRange();
    else if (m.type === 'unit') reachChanged();   // it may man (or leave) a trench in the way
    gameMarkerChanged(m.type);
  }

  /**
   * Floating numbers over a unit whose strength changed, however it happened (a battle, attrition at End turn,
   * a hospital, the GM): losses in red with the strength left, healing in green.
   */
  function strengthChanged(prev, m) {
    if (!prev || m.type !== 'unit') return;
    const a = Math.round(Number(prev.data?.strength ?? 100)), b = Math.round(Number(m.data?.strength ?? 100));
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return;
    if (b < a) {
      const gone = b <= 0, d = a - b;
      renderer.floatText(m.id, `−${d}`, { color: gone ? 0xff2d20 : 0xff5a45, size: gone || d >= 25 ? 32 : d >= 12 ? 27 : 23,
        sub: gone ? (m.data?.surrendered ? '⚑ SURRENDERED' : 'DESTROYED') : `${b}% strength`, subColor: gone ? 0xffc2b5 : 0xffffff, delay: 160 });
    } else renderer.floatText(m.id, `+${b - a}`, { color: 0x5ee07a, size: 23, sub: `${b}% strength` });
  }

  // ---- Convoys (docs/UNITS.md): troops embark on transports and land together ---------------------------------
  const isConvoyM = m => !!m && m.type === 'unit' && window.UnitTypes?.resolve(m.data?.unitType)?.id === 'transport';
  const isLandType = m => { const t = window.UnitTypes?.resolve(m.data?.unitType); return !t || ['Infantry', 'Mounted & mobile', 'Artillery', 'Emplacements', 'Support'].includes(t.cat); };
  function convoyRules() {
    const s = state.game?.settings || {};
    return { cap: Number(s.convoyCapacity ?? 10), board: Number(s.convoyBoardKm ?? 30), land: Number(s.convoyLandKm ?? 100) };
  }
  function cargoOf(id) { return [...state.markers.values()].filter(x => Number(x.data?.aboard) === Number(id)); }
  /** A convoy on the map says how many it carries. */
  function displayed(m) {
    if (!isConvoyM(m)) return m;
    const n = cargoOf(m.id).length;
    return n ? { ...m, name: `${m.name} · ${n} aboard` } : m;
  }
  function refreshConvoy(id) {
    const c = id && state.markers.get(Number(id));
    if (!c) return;
    renderer.upsert(displayed(c));
    if (state.selectedId === c.id) renderPopup();   // its card lists the cargo
  }
  /** Draw a marker: troops aboard a convoy are not on the map (they sail inside it). */
  function showMarker(m, prev) {
    if (m.data?.aboard) {
      if (prev && !prev.data?.aboard && renderer.views.has(m.id)) {
        renderer.upsert(m);                                          // walks up to the ship…
        setTimeout(() => { if (state.markers.get(m.id)?.data?.aboard) renderer.remove(m.id); }, 700);   // …and is gone
      } else renderer.remove(m.id);
      return;
    }
    if (prev?.data?.aboard && !renderer.views.has(m.id)) renderer.upsert({ ...prev, data: { ...prev.data, aboard: 0 } });   // steps off the ship…
    renderer.upsert(displayed(m));                                   // …and onto the beach
    if (prev && m.data?.ride && m.data.ride.at !== prev.data?.ride?.at && Date.now() - m.data.ride.at < 20000) renderer.playRide(m.id, m.data.ride);
  }
  /** Are two nations allies? */
  function allied(a, b) {
    if (!a || !b || String(a).toLowerCase() === String(b).toLowerCase()) return false;
    const fb = factionByName(b);
    return !!fb && friendIds(a).ids.has(fb.id);
  }
  /**
   * Units and heroes that could board a convoy now: ashore, close enough, and yours of its nation (they board at
   * once) or, on your own convoy, an ally's (its nation is asked first).
   */
  function boarders(c) {
    const { board } = convoyRules(), C = c.data?.nation, gm = state.role === 'gm', mineShip = canEdit(c);
    return [...state.markers.values()].filter(m => m.id !== c.id && !m.data?.aboard
      && (m.type === 'hero' ? !['captured', 'travelling'].includes(m.data?.status) : m.type === 'unit' && !isConvoyM(m) && isLandType(m) && Number(m.data?.strength ?? 100) > 0)
      && (gm || (canEdit(m) && String(m.data?.nation || '').toLowerCase() === String(C || '').toLowerCase()) || (mineShip && allied(m.data?.nation, C)))
      && distanceUnits(m.x, m.y, c.x, c.y) <= board);
  }
  /** Convoys a unit could board now: its own nation's (at once) or an ally's (asked first). */
  function convoysNear(m) {
    const { board, cap } = convoyRules(), n = String(m.data?.nation || '').toLowerCase(), gm = state.role === 'gm';
    return [...state.markers.values()].filter(c => isConvoyM(c) && Number(c.data?.strength ?? 100) > 0
      && (gm || (canEdit(c) && String(c.data?.nation || '').toLowerCase() === n) || allied(m.data?.nation, c.data?.nation))
      && distanceUnits(m.x, m.y, c.x, c.y) <= board && cargoOf(c.id).length < cap)
      .sort((a, b) => distanceUnits(m.x, m.y, a.x, a.y) - distanceUnits(m.x, m.y, b.x, b.y));
  }
  function convoyRows(m) {
    if (m.data?.aboard) { const c = state.markers.get(Number(m.data.aboard)); return stat('Aboard', c ? `${c.name} (lands when it does)` : 'a convoy'); }
    if (!isConvoyM(m)) return '';
    const cargo = cargoOf(m.id), { cap } = convoyRules();
    return stat('Carrying', `${cargo.length}/${cap}${cargo.length ? ': ' + cargo.map(x => esc(x.name)).join(', ') : ' (troops within ' + convoyRules().board + ' km can embark)'}`);
  }
  function convoyActions(m) {
    if (m.data?.aboard) {
      const c = state.markers.get(Number(m.data.aboard));
      // Your troops on an ally's convoy: ask its nation to land them.
      const ask = c && !canEdit(c) && canEdit(m) ? `<button class="small" data-act="askland" title="${esc(c.data?.nation || 'Its nation')} is asked to land everyone aboard">⚓ Ask to land</button>` : '';
      return `<button class="small secondary" data-act="showship">⛴ Show convoy</button>${ask}`;
    }
    const { cap, land } = convoyRules();
    let h = '';
    if (isConvoyM(m)) {
      if (!canEdit(m) || Number(m.data?.strength ?? 100) <= 0) return '';
      const n = cargoOf(m.id).length, room = cap - n, cand = boarders(m).slice(0, Math.max(0, room));
      const allies = cand.filter(x => !canEdit(x)).length;
      if (cand.length) h += `<button class="small" data-act="embarkall" title="${esc(cand.map(x => x.name).join(', '))}${allies ? ` (${allies} of an ally's: its nation is asked first)` : ''}">⛴ Embark nearby (${cand.length})</button>`;
      const allyAboard = cargoOf(m.id).some(x => String(x.data?.nation || '').toLowerCase() !== String(m.data?.nation || '').toLowerCase());
      if (n) h += `<button class="small" data-act="disembark" title="Everyone aboard lands at once on the nearest beach within ${land} km${allyAboard && state.role !== 'gm' ? '; the allies aboard are asked first' : ''}">⚓ Land troops (${n})</button>`;
    } else if (canEdit(m) && (m.type === 'hero' || (m.type === 'unit' && isLandType(m)))) {
      for (const c of convoysNear(m).slice(0, 2)) h += canEdit(c) || state.role === 'gm'
        ? `<button class="small" data-act="board" data-convoy="${c.id}">⛴ Board ${esc(c.name)}</button>`
        : `<button class="small" data-act="board" data-convoy="${c.id}" title="${esc(c.data?.nation || 'Its nation')} is asked first">⛴ Ask to board ${esc(c.name)}</button>`;
    }
    return h;
  }
  async function convoyAction(act, m, btn) {
    if (act === 'showship') { const c = state.markers.get(Number(m.data?.aboard)); if (c) { renderer.centerOn(c.x, c.y); renderer.select(c.id); } return; }
    if (act === 'board' || act === 'embarkall') {
      const c = act === 'board' ? state.markers.get(Number(btn?.dataset.convoy)) : m;
      const ids = act === 'board' ? [m.id] : boarders(c).slice(0, convoyRules().cap - cargoOf(c.id).length).map(x => x.id);
      const d = await api.post(`${base}/convoys/${c.id}/embark`, { unitIds: ids });
      for (const x of d.embarked) upsertMarker(x);
      const asked = (d.requested || []).map(r => `asked ${r.to.join(', ')} about ${r.unitNames.length}`);
      toast([d.embarked.length ? `${d.embarked.length} embarked on ${c.name} (${d.aboard}/${d.capacity})` : '', ...asked, ...d.errors].filter(Boolean).join(' · '), 6000);
      Comms.loadConvoyRequests();
      renderer.select(c.id);
      return;
    }
    if (act === 'disembark' || act === 'askland') {
      const c = act === 'askland' ? state.markers.get(Number(m.data?.aboard)) : m;
      const d = await api.post(`${base}/convoys/${c.id}/disembark`, {});
      for (const x of d.landed || []) upsertMarker(x);
      if (d.requested?.length) toast(`Asked ${d.requested[0].to.join(', ')} to agree to the landing`, 5000);
      else toast(`${d.landed.length} landed${d.note ? ' · ' + d.note : ''}`, 5000);
      Comms.loadConvoyRequests();
    }
  }

  function removeMarker(id) {
    const type = state.markers.get(id)?.type, marching = !!state.markers.get(id)?.data?.goal;
    if (type === 'unit') reachChanged();
    state.markers.delete(id);
    renderer.remove(id);
    if (marching) syncMarches();
    renderMarkerLists();
    if (state.selectedId === id) { state.selectedId = null; renderPopup(); }
    gameMarkerChanged(type);
  }

  /** Game mode: income depends on nodes, towns and factories; the Forces list on units. Refresh after a short pause. */
  let gameRefreshTimer = null;
  function gameMarkerChanged(type) {
    if (!gameOn() || !type) return;
    if (['resource', 'factory', 'town'].includes(type)) {
      clearTimeout(gameRefreshTimer);
      gameRefreshTimer = setTimeout(() => GameUI.load().catch(() => {}), 400);
    } else if (type === 'unit') {
      // Coalesced: a group move or a reload changes many units at once.
      clearTimeout(nationTimer);
      nationTimer = setTimeout(() => GameUI.renderNation(), 150);
    }
  }
  let nationTimer = 0;

  function upsertShape(s) {
    if (s.kind === 'trench' || s.kind === 'area') reachChanged();
    if (s.kind === 'rail' || s.kind === 'area') syncMarches();
    state.shapes.set(s.id, s);
    renderer.upsertShape(s);
    renderMarkerLists();
    if (state.selectedShapeId === s.id) renderPopup();
  }

  function removeShape(id) {
    if (['trench', 'area'].includes(state.shapes.get(id)?.kind)) reachChanged();
    if (['rail', 'area'].includes(state.shapes.get(id)?.kind)) syncMarches();
    state.shapes.delete(id);
    renderer.removeShape(id);
    renderMarkerLists();
    if (state.selectedShapeId === id) { state.selectedShapeId = null; renderPopup(); }
  }

  function nations() {
    const set = new Set();
    for (const f of state.factions) set.add(f.name);
    for (const m of state.members) if (m.nation) set.add(m.nation);
    for (const m of state.markers.values()) if (m.data?.nation) set.add(m.data.nation);
    return [...set].sort();
  }
  function renderNationList() {
    $('#nationList').innerHTML = nations().map(n => `<option value="${esc(n)}">`).join('');
  }

  // ---- WebSocket ----------------------------------------------------------------------
  function wsSend(msg) { if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg)); }

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    state.ws = ws;
    let hadJoined = false;
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'join', lobbyId, viewAs: state.viewAs?.id || undefined })); };
    ws.onmessage = async ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'joined':
          state.wsBackoff = 1000;
          state.presence = msg.users; renderPresence();
          if (hadJoined || state.reconnected) { await loadMarkers(); await loadShapes(); await loadEvents(); await loadHistory(); }
          hadJoined = true;
          break;
        case 'presence': state.presence = msg.users; renderPresence(); renderMembers(); break;
        case 'marker':
          if (msg.action === 'upsert') {
            const prev = state.markers.get(msg.marker.id);
            upsertMarker(msg.marker);
            if (msg.actorId && msg.actorId !== me.id && prev && (prev.x !== msg.marker.x || prev.y !== msg.marker.y)) {
              notify('Marker moved', `${msg.marker.name} was moved`);
            }
          } else if (msg.action === 'delete') removeMarker(msg.id);
          break;
        case 'shape':
          if (msg.action === 'upsert') upsertShape(msg.shape);
          else if (msg.action === 'delete') removeShape(msg.id);
          break;
        case 'history':
          state.history.unshift(msg.entry);
          if (msg.entry.reverts) { const t = state.history.find(h => h.id === msg.entry.reverts); if (t) t.revertedBy = msg.entry.id; }
          if (state.history.length > 200) state.history.pop();
          renderHistory();
          break;
        case 'drag': renderer.ghostMove(msg.id, msg.x, msg.y); break;
        case 'event': {
          const e = msg.event;
          if (!state.events.some(x => x.id === e.id)) state.events.push(e);
          if (state.events.length > 200) state.events.shift();
          renderLog(true);
          Comms.onEvent(e);
          if (e.kind === 'combat' && e.data) {
            const { attackerId, defenderId, outcome, losses, returnFire } = e.data;
            const gone = id => !!(losses && losses[id] && losses[id].to === 0 && losses[id].from > 0);
            renderer.hit(defenderId, outcome !== 'defender', gone(defenderId));
            if (!returnFire) renderer.hit(attackerId, outcome === 'defender', gone(attackerId));   // a battery firing back is not hit by it
            // Losses float up from the strength change itself (strengthChanged); a side that lost nothing says so.
            for (const id of [attackerId, defenderId]) if (losses?.[id] && losses[id].loss === 0) renderer.floatText(id, 'No loss', { color: 0xd5dde3, size: 17, delay: 160 });
          }
          if (e.userId !== me.id) {
            if (e.kind === 'chat' && !$('#chatWin').hidden) { /* reading the chat already */ }
            else if (e.kind === 'chat') notify(e.displayName, e.message);
            else if (e.kind === 'roll') notify(`${e.displayName} rolled`, e.message);
            else if (e.kind === 'combat') notify('Combat', e.message);
            else if (e.data && e.data.deadline) { notify('Turn deadline', e.message); toast(e.message, 5000); }
          }
          break;
        }
        case 'members': await loadMembers(); break;
        case 'factions': await loadFactions(); await loadMembers(); await loadMarkers(); if (gameOn()) GameUI.load().catch(() => {}); break;
        case 'game': { const was = !!state.game?.enabled; GameUI.onGame(msg.game); syncRailButton(); syncTrails(); updateMoveRange(); if (was !== !!msg.game?.enabled) { Comms.loadTrades(); loadCorps(); } else Comms.refresh(); renderPopup(); break; }
        case 'turn': GameUI.onTurn(msg); loadBattles(); loadCorps(); loadReachBonus(); break;
        case 'phase': showPhaseBanner(msg.phase); updateMoveRange(); renderPopup(); renderSelBar(); syncMarches(); break;
        case 'corps': loadCorps(); break;
        case 'faction': GameUI.onFaction(msg); loadReachBonus(); break;
        case 'ready': if (msg.turn === state.game?.turn) { state.ready = msg.ready || []; renderReady(); } break;
        case 'territory': renderer.setTerritories(msg.territories, !!msg.replace); GameUI.onTerritories(); break;
        case 'provinces': await loadProvinces(); break;
        case 'provinceOwners': renderer.setProvinceOwners(msg.owners || [], !!msg.replace); GameUI.onTerritories(); break;
        case 'progress': GameUI.onProgress(msg); break;
        case 'relations': GameUI.onRelations(msg); Comms.onRelations(); break;
        case 'tradesChanged': Comms.onTradesChanged(msg); break;
        case 'convoyRequests': Comms.loadConvoyRequests(); break;
        case 'chatChannel': Comms.onChatChannel(msg.channel); break;
        case 'chatMessage': Comms.onChatMessage(msg.message); break;
        case 'ping': showPing(msg.ping); break;
        case 'battle': renderer.addBattle(msg.battle); break;
        case 'craters': renderer.addCraters(msg.craters); break;
        case 'reload': if (msg.what === 'markers') { await loadMarkers(); loadVision(); } break;
        case 'vision': renderer.setFog(msg.vision); state.fog = msg.vision; break;
        case 'lobby': {
          state.lobby = { ...msg.lobby, joinCode: msg.lobby.joinCode ?? state.lobby?.joinCode, yourRole: state.role };
          applyLobby(); await applyMap();
          if ($('#settingsModal').classList.contains('open')) openSettings();
          break;
        }
        case 'role': if (state.viewAs && !msg.viewAs) { setViewAs(null); break; }   // demoted, or the nation was deleted
          // Everything the server filters by role or nation is fetched again: a player promoted to GM now sees every
          // fight, hidden unit and log line, and a GM made a player stops seeing them.
          state.role = msg.role; await loadLobby(); await loadMarkers(); await loadShapes(); await loadHistory(); GameUI.load().catch(() => {});
          loadBattles(); loadVision(); loadEvents().catch(() => {}); Comms.loadConvoyRequests(); toast(`You are now a ${msg.role === 'gm' ? 'game master' : 'player'}${msg.nation ? ` of ${msg.nation}` : ''}`); break;
        case 'kicked': alert('You are no longer part of this campaign.'); location.replace('/lobbies.html'); break;
        case 'error': toast(msg.error); break;
        default: break;
      }
    };
    ws.onclose = () => {
      state.reconnected = true;
      setTimeout(connectWs, state.wsBackoff);
      state.wsBackoff = Math.min(15000, state.wsBackoff * 2);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  // ---- Notifications ---------------------------------------------------------------------
  const notifyPref = { enabled: false };
  try { notifyPref.enabled = localStorage.getItem('woe.notify') === '1'; } catch { /* ignore */ }
  let lastNotify = 0;
  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.26);
    } catch { /* no audio */ }
  }
  function notify(title, body) {
    if (!notifyPref.enabled || !document.hidden) return;
    const t = Date.now();
    if (t - lastNotify < 3000) return;
    lastNotify = t;
    beep();
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(`${state.lobby?.name || 'WoE'}: ${title}`, { body: String(body).slice(0, 140), silent: true }); } catch { /* ignore */ }
    }
  }
  // Battle sounds (sound.js): off until switched on, remembered per browser.
  function renderBattleSoundButton() {
    const on = !!window.BattleSound?.enabled;
    $('#btnBattleSound').classList.toggle('active', on);
    $('#btnBattleSound').style.opacity = on ? '' : '0.55';
    $('#btnBattleSound').title = `Battle sounds are ${on ? 'on' : 'off'}: gunfire, shells and hooves where you are looking (click to turn ${on ? 'off' : 'on'})`;
  }
  $('#btnBattleSound').onclick = () => { if (window.BattleSound) window.BattleSound.enabled = !window.BattleSound.enabled; renderBattleSoundButton(); };
  renderBattleSoundButton();
  function renderNotifyButton() {
    $('#btnNotify').textContent = notifyPref.enabled ? '🔊' : '🔇';
    $('#btnNotify').classList.toggle('active', notifyPref.enabled);
  }
  $('#btnNotify').onclick = async () => {
    notifyPref.enabled = !notifyPref.enabled;
    if (notifyPref.enabled && 'Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
    try { localStorage.setItem('woe.notify', notifyPref.enabled ? '1' : '0'); } catch { /* ignore */ }
    renderNotifyButton();
    if (notifyPref.enabled) { beep(); toast('You will hear a chime (and see a desktop notification if allowed) when things happen while this tab is in the background.'); }
  };
  renderNotifyButton();

  // ---- View as player (GM) -----------------------------------------------------------------
  /** The 👁 switch in the top bar: plain for the GM, gold with the nation's flag and name while viewing as it. */
  function renderViewAs() {
    const v = state.viewAs, btn = $('#btnViewAs');
    $('#viewAsWrap').hidden = state.realRole !== 'gm';
    $('#app').classList.toggle('viewas', !!v);
    btn.classList.toggle('viewing', !!v);
    btn.innerHTML = v ? `👁 ${v.flagUrl ? `<img class="flag" src="${esc(v.flagUrl)}" alt="">` : ''}<span class="vname">${esc(v.name)}</span>` : '👁';
    btn.title = v ? `Viewing as ${v.name}'s player: you see what they see and have only their powers. Click to go back to the GM view or pick another nation.`
      : 'View as a player: use the map as one nation\'s player, to check what it can see or to play it without GM powers';
    $('#stagewrap').dataset.viewas = v ? `👁 Viewing as ${v.name} · player powers only` : '';
  }
  function renderViewAsMenu() {
    const cur = state.viewAs?.id || null;
    const players = f => state.members.filter(m => m.role !== 'gm' && String(m.nation || '').trim().toLowerCase() === f.name.trim().toLowerCase()).map(m => m.displayName);
    const item = (fid, icon, name, hint) => `<button type="button" class="vitem ${fid === cur ? 'on' : ''}" data-fid="${fid || ''}">${icon}<span class="grow">${esc(name)}</span>${hint ? `<span class="hint" title="${esc(hint)}">${esc(hint)}</span>` : ''}</button>`;
    $('#viewAsMenu').innerHTML = `<div class="vhead"><strong>View as a player</strong>See the map, panels and log as that nation's player and play with only its powers: moves, attacks and orders follow the rules. This tab only.</div>`
      + item(null, '👑', 'Game master view', '')
      + (state.factions.length ? state.factions.map(f => {
        const p = players(f);
        return item(f.id, f.flagUrl ? `<img class="flag" src="${esc(f.flagUrl)}" alt="">` : `<span class="vdot" style="background:${esc(f.color)}"></span>`, f.name, p.length ? p.join(', ') : 'no player');
      }).join('') : '<p class="hint" style="padding:6px 12px;margin:0">No factions yet: create them on the 👥 People panel.</p>');
  }
  $('#btnViewAs').onclick = e => {
    e.stopPropagation();
    const menu = $('#viewAsMenu');
    if (menu.hidden) renderViewAsMenu();
    menu.hidden = !menu.hidden;
  };
  $('#viewAsMenu').addEventListener('click', e => {
    e.stopPropagation();
    const b = e.target.closest('.vitem');
    if (!b) return;
    const fid = Number(b.dataset.fid) || null;
    if (fid === (state.viewAs?.id || null)) { $('#viewAsMenu').hidden = true; return; }
    setViewAs(fid);
  });
  document.addEventListener('click', () => { $('#viewAsMenu').hidden = true; });

  // ---- Ready-up bar ----------------------------------------------------------------------
  /** Nations that have a player: each shows its flag, with a green check once its player is done for the turn. */
  let allReadyWas = null;
  function renderReady() {
    const bar = $('#readyBar');
    const players = new Set((state.members || []).filter(m => m.role !== 'gm' && m.nation).map(m => m.nation.trim().toLowerCase()));
    const list = gameOn() ? (state.factions || []).filter(f => players.has(f.name.toLowerCase())) : [];
    bar.hidden = !list.length;
    const gm = state.role === 'gm';
    const mine = gm ? null : factionByName(state.member?.nation);
    const ready = new Map((state.ready || []).map(r => [r.factionId, r]));
    const done = list.filter(f => ready.has(f.id)).length, all = !!list.length && done === list.length;
    // The turn widget (bottom right) repeats it: a Ready button for players, the count under End turn.
    const sub = $('#twSub'), rb = $('#btnReadyTurn'), meReady = !!mine && ready.has(mine.id);
    sub.textContent = list.length ? (all ? 'Everyone is ready' : `${done}/${list.length} nations ready`) : '';
    sub.classList.toggle('all', all);
    $('#turnWidget').classList.toggle('allready', all);
    rb.textContent = meReady ? '✓ Ready' : 'Ready up';
    rb.classList.toggle('done', meReady);
    rb.title = meReady ? 'You are marked ready. Click to take it back' : 'Tell the GM you have finished this turn';
    rb.dataset.fid = mine ? mine.id : '';
    if (!list.length) { bar.innerHTML = ''; allReadyWas = null; return; }
    const clock = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const who = id => state.members.find(m => m.userId === id)?.displayName;
    // Your own nation comes first.
    const ordered = mine ? [...list.filter(f => f.id === mine.id), ...list.filter(f => f.id !== mine.id)] : list;
    bar.innerHTML = `<span class="rcount" title="Nations whose players are ready for the turn to end">${done}/${list.length} ready</span>` + ordered.map(f => {
      const r = ready.get(f.id), own = !!mine && f.id === mine.id, can = gm || own;
      const by = r && who(r.userId);
      const tip = `${f.name}: ${r ? `ready since ${clock(r.at)}${by ? ` (${by})` : ''}` : 'still playing'}${own ? (r ? '. Click to take it back' : '. Click when you have finished your turn') : gm ? (r ? '. Click to clear' : '. Click to mark ready for them') : ''}`;
      const icon = f.flagUrl ? `<img class="flag" src="${esc(f.flagUrl)}" alt="">` : `<span class="rdot" style="background:${esc(f.color)}"></span>`;
      return `<button type="button" class="rchip ${r ? 'ready' : ''} ${own ? 'mine' : ''} ${can ? 'can' : ''}" data-fid="${f.id}" title="${esc(tip)}" aria-label="${esc(tip)}" aria-pressed="${r ? 'true' : 'false'}" ${can ? '' : 'tabindex="-1"'}><span class="ricon">${icon}<span class="chk">✓</span></span>${own ? `<span class="rlabel">${r ? 'Ready' : 'Ready up'}</span>` : ''}</button>`;
    }).join('');
    bar.classList.toggle('all', all);
    if (gm && all && allReadyWas === false) {
      toast(`All ${list.length} nations are ready: you can end turn ${state.game.turn}`, 6000);
      notify('Everyone is ready', `All nations are ready to end turn ${state.game.turn}`);
    }
    allReadyWas = all;
  }
  async function setReady(fid, on) {
    try {
      const d = await api.post(`${base}/game/ready`, { ready: on, factionId: state.role === 'gm' ? fid : undefined });
      if (d.turn === state.game?.turn) { state.ready = d.ready; renderReady(); }
    } catch (err) { toast(err.message); }
  }
  $('#readyBar').addEventListener('click', e => {
    const chip = e.target.closest('.rchip.can');
    if (chip) setReady(Number(chip.dataset.fid), !chip.classList.contains('ready'));
  });
  $('#btnReadyTurn').onclick = e => setReady(Number(e.currentTarget.dataset.fid), !e.currentTarget.classList.contains('done'));

  // ---- Presence / members ---------------------------------------------------------------
  function initials(name) { return String(name || '?').trim().split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase(); }

  function renderPresence() {
    $('#presence').innerHTML = state.presence.map(u =>
      `<div class="avatar ${u.role === 'gm' ? 'gm' : ''}" title="${esc(u.displayName)}${u.role === 'gm' ? ' (GM)' : ''}">${esc(initials(u.displayName))}</div>`).join('');
  }

  function flagImg(nation, big) {
    const f = factionByName(nation);
    return f && f.flagUrl ? `<img class="flag ${big ? 'big' : ''}" src="${esc(f.flagUrl)}" alt="" title="${esc(f.name)}">` : '';
  }

  function renderMembers() {
    const online = new Set(state.presence.map(u => u.id));
    const gm = state.role === 'gm';
    $('#membersList').innerHTML = state.members.map(m => `
      <li data-id="${m.userId}">
        <span class="dot" style="background:${esc(m.color)}"></span>
        <span class="grow"><strong>${esc(m.displayName)}</strong>${m.nation ? ` <span class="hint">· ${flagImg(m.nation)} ${esc(m.nation)}</span>` : ''}</span>
        ${online.has(m.userId) ? '<span class="badge online">online</span>' : ''}
        <span class="badge ${m.role === 'gm' ? 'gm' : ''}">${m.role === 'gm' ? 'GM' : 'Player'}</span>
        ${gm ? `<button class="small secondary" data-act="edit" title="Edit member">✎</button>` : ''}
        ${gm && m.userId !== state.lobby.ownerId ? `<button class="small danger" data-act="kick" title="Remove">✕</button>` : ''}
      </li>`).join('');
    $('#membersList').querySelectorAll('button').forEach(b => b.onclick = () => memberAction(b.dataset.act, Number(b.closest('li').dataset.id)));
    $('#btnLeave').hidden = state.lobby && state.lobby.ownerId === me.id;
  }

  async function memberAction(act, userId) {
    const m = state.members.find(x => x.userId === userId);
    if (!m) return;
    try {
      if (act === 'kick') {
        if (!confirm(`Remove ${m.displayName} from the campaign?`)) return;
        await api.del(`${base}/members/${userId}`);
        await loadMembers();
      } else if (act === 'edit') {
        openMemberModal(m);
      }
    } catch (err) { toast(err.message); }
  }

  function nationOptions(current) {
    const known = state.factions.some(f => f.name.toLowerCase() === String(current || '').toLowerCase());
    return `<option value="">— none —</option>` +
      state.factions.map(f => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('') +
      `<option value="__custom">Custom…</option>`;
  }

  function openMemberModal(m) {
    $('#memberModalTitle').textContent = `Edit ${m.displayName}`;
    $('#memId').value = m.userId;
    const sel = $('#memNation');
    sel.innerHTML = nationOptions(m.nation);
    const known = state.factions.find(f => f.name.toLowerCase() === String(m.nation || '').toLowerCase());
    sel.value = known ? known.name : (m.nation ? '__custom' : '');
    $('#memNationCustomWrap').hidden = sel.value !== '__custom';
    $('#memNationCustom').value = known ? '' : (m.nation || '');
    $('#memColor').value = m.color;
    $('#memRole').value = m.role;
    $('#memRole').disabled = m.userId === state.lobby.ownerId;
    sel.onchange = () => {
      $('#memNationCustomWrap').hidden = sel.value !== '__custom';
      const f = factionByName(sel.value);
      if (f) $('#memColor').value = f.color;
    };
    $('#memberModal').classList.add('open');
  }
  $('#memberForm').onsubmit = async e => {
    e.preventDefault();
    const sel = $('#memNation');
    const nation = sel.value === '__custom' ? $('#memNationCustom').value : sel.value;
    try {
      await api.patch(`${base}/members/${$('#memId').value}`, { nation, color: $('#memColor').value, role: $('#memRole').value });
      closeModals(); await loadMembers();
    } catch (err) { toast(err.message); }
  };

  // ---- Factions --------------------------------------------------------------------------------
  function renderFactions() {
    const gm = state.role === 'gm';
    $('#btnAddFaction').hidden = !gm;
    $('#btnSeedFactions').hidden = !gm;
    $('#factionsList').innerHTML = state.factions.map(f => `
      <li data-id="${f.id}">
        ${f.flagUrl ? `<img class="flag big" src="${esc(f.flagUrl)}" alt="">` : `<span class="dot" style="background:${esc(f.color)}"></span>`}
        <span class="grow"><strong>${esc(f.name)}</strong> <span class="hint">· ${state.members.filter(m => m.nation.toLowerCase() === f.name.toLowerCase()).length} member(s)</span></span>
        <span class="dot" style="background:${esc(f.color)}" title="Colour"></span>
        ${gm ? `<button class="small secondary" data-act="edit" title="Edit faction">✎</button>` : ''}
      </li>`).join('') || '<li class="muted">No factions yet.</li>';
    $('#factionsList').querySelectorAll('button').forEach(b => b.onclick = () => openFactionModal(state.factions.find(f => f.id === Number(b.closest('li').dataset.id))));
  }
  $('#btnAddFaction').onclick = () => openFactionModal(null);

  // ---- Seed factions from a historical year --------------------------------------------------
  let seedPowers = [];
  async function openSeedModal() {
    const years = (await api.get('/api/lobbies/earth/years')).years;
    if (!years.length) { toast('No historical borders are bundled on this server'); return; }
    const sel = $('#seedYear');
    sel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    const cur = state.lobby?.settings?.earth?.borders;
    sel.value = years.includes(Number(cur)) ? String(cur) : (years.includes(1914) ? '1914' : String(years[0]));
    sel.onchange = loadSeedPreview;
    $('#seedModal').classList.add('open');
    await loadSeedPreview();
  }
  async function loadSeedPreview() {
    const list = $('#seedList');
    list.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const d = await api.get(`${base}/factions/seed-preview?year=${$('#seedYear').value}`);
      seedPowers = d.powers;
      list.innerHTML = d.powers.map(p => `
        <label class="ev" style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" data-name="${esc(p.name)}" ${p.exists ? 'disabled' : 'checked'}>
          ${p.flagAsset ? `<img class="flag big" src="/flags/${encodeURIComponent(p.flagAsset)}" alt="">` : '<span class="flag big" style="display:inline-block;width:44px;background:#1f2d3a;text-align:center;font-size:10px;line-height:22px;color:#95a5a6">no flag</span>'}
          <span class="dot" style="background:${esc(p.color)}"></span>
          <span class="grow">${esc(p.name)} <span class="hint">· ${p.territories} territor${p.territories === 1 ? 'y' : 'ies'}${p.exists ? ' · already exists' : ''}</span></span>
        </label>`).join('');
      list.querySelectorAll('input').forEach(i => i.onchange = updateSeedCount);
      updateSeedCount();
    } catch (err) { list.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  }
  function updateSeedCount() {
    const n = $$('#seedList input:checked:not(:disabled)').length;
    $('#seedCount').textContent = `${n} selected`;
    $('#seedCreate').disabled = n === 0;
  }
  $('#seedAll').onclick = () => { $$('#seedList input:not(:disabled)').forEach(i => { i.checked = true; }); updateSeedCount(); };
  $('#seedNone').onclick = () => { $$('#seedList input:not(:disabled)').forEach(i => { i.checked = false; }); updateSeedCount(); };
  $('#seedCreate').onclick = async () => {
    const names = $$('#seedList input:checked:not(:disabled)').map(i => i.dataset.name);
    if (!names.length) return;
    $('#seedCreate').disabled = true;
    try {
      const d = await api.post(`${base}/factions/seed`, { year: Number($('#seedYear').value), names });
      closeModals();
      await loadFactions(); await loadMembers(); await loadMarkers();
      toast(`Created ${d.created.length} faction${d.created.length === 1 ? '' : 's'}`);
    } catch (err) { toast(err.message); $('#seedCreate').disabled = false; }
  };
  $('#btnSeedFactions').onclick = openSeedModal;

  // ---- Borders → editable drawings ---------------------------------------------------------------
  async function importBorders(useView) {
    const e = state.lobby?.settings?.earth;
    const year = e && /^\d{3,4}$/.test(String(e.borders)) ? Number(e.borders) : null;
    const y = year || Number(prompt('Which year\'s borders? (bundled: ' + ((await api.get('/api/lobbies/earth/years')).years.join(', ')) + ')', '1914'));
    if (!y) return;
    let bbox = null;
    if (useView) {
      const r = renderer;
      const a = r.screenToWorld(0, 0), b = r.screenToWorld(r.app.screen.width, r.app.screen.height);
      const [minLon, maxLat] = window.EarthMap.unproject(a.x, a.y, state.lobby.mapWidth, state.lobby.mapHeight);
      const [maxLon, minLat] = window.EarthMap.unproject(b.x, b.y, state.lobby.mapWidth, state.lobby.mapHeight);
      bbox = [minLon, minLat, maxLon, maxLat];
    }
    if (!confirm(`Import the ${y} borders ${useView ? 'in the current view' : 'of the whole world'} as locked area drawings?`)) return;
    try {
      const d = await api.post(`${base}/shapes/import-borders`, { year: y, bbox, hideLayer: $('#importHideLayer').checked });
      await loadShapes(); await loadHistory();
      toast(`Imported ${d.created} border drawings`);
      closeModals();
    } catch (err) { toast(err.message); }
  }
  $('#btnImportBordersView').onclick = () => importBorders(true);
  $('#btnImportBordersAll').onclick = () => importBorders(false);

  async function bundledFlags() {
    if (!state.bundledFlags) state.bundledFlags = (await api.get('/api/lobbies/flags/bundled')).flags;
    return state.bundledFlags;
  }

  async function openFactionModal(f) {
    $('#factionModalTitle').textContent = f ? `Edit ${f.name}` : 'New faction';
    $('#facId').value = f ? f.id : '';
    $('#facName').value = f ? f.name : '';
    $('#facColor').value = f ? f.color : PALETTE[state.factions.length % PALETTE.length];
    // Factions saved with the old colours (grey, beige, green) show the army they now stand for.
    $('#facUniform').value = f?.uniform && window.Skirmish ? window.Skirmish.uniformFor('', f.uniform) : (f?.uniform || '');
    const auto = window.Skirmish ? window.Skirmish.uniformFor(f ? f.name : '', '') : '';
    $('#facUniform').options[0].textContent = `Automatic (${[...$('#facUniform').options].find(o => o.value === auto)?.textContent || 'from the name'})`;
    $('#facFlagAsset').value = f ? (f.flagAsset || '') : '';
    $('#facFlagFile').value = '';
    $('#facDelete').hidden = !f;
    setFlagPreview(f ? f.flagUrl : null);
    const flags = await bundledFlags();
    const grid = $('#facFlagGrid');
    grid.innerHTML = flags.map(fl => `<div class="cell ${f && f.flagAsset === fl.file ? 'selected' : ''}" data-file="${esc(fl.file)}" data-url="${esc(fl.url)}"><img src="${esc(fl.url)}" alt="">${esc(fl.name)}</div>`).join('') || '<p class="muted">No bundled flags in public/flags.</p>';
    grid.querySelectorAll('.cell').forEach(c => c.onclick = () => {
      grid.querySelectorAll('.cell').forEach(x => x.classList.toggle('selected', x === c));
      $('#facFlagAsset').value = c.dataset.file; $('#facFlagFile').value = '';
      setFlagPreview(c.dataset.url);
    });
    $('#factionModal').classList.add('open');
  }
  const PALETTE = ['#3498db', '#e74c3c', '#2ecc71', '#9b59b6', '#f1c40f', '#1abc9c', '#e67e22', '#95a5a6', '#d35400', '#34495e'];
  function setFlagPreview(url) {
    $('#facFlagPreview').innerHTML = url ? `<img src="${esc(url)}" alt="">` : '<span class="hint">no flag</span>';
  }
  $('#facFlagFile').onchange = () => {
    const file = $('#facFlagFile').files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Flag files must be 5 MB or smaller'); $('#facFlagFile').value = ''; return; }
    $('#facFlagAsset').value = '';
    $('#facFlagGrid').querySelectorAll('.cell').forEach(x => x.classList.remove('selected'));
    setFlagPreview(URL.createObjectURL(file));
  };
  $('#facFlagNone').onclick = () => { $('#facFlagAsset').value = ''; $('#facFlagFile').value = ''; $('#facFlagGrid').querySelectorAll('.cell').forEach(x => x.classList.remove('selected')); setFlagPreview(null); $('#facFlagNone').dataset.cleared = '1'; };
  $('#factionForm').onsubmit = async e => {
    e.preventDefault();
    const id = $('#facId').value;
    const file = $('#facFlagFile').files[0];
    const body = { name: $('#facName').value, color: $('#facColor').value, uniform: $('#facUniform').value };
    const asset = $('#facFlagAsset').value;
    if (asset) body.flagAsset = asset;
    else if (!file && ($('#facFlagNone').dataset.cleared === '1' || !id)) body.flagAsset = null;
    try {
      let f = id ? (await api.patch(`${base}/factions/${id}`, body)).faction : (await api.post(`${base}/factions`, body)).faction;
      if (file) { const fd = new FormData(); fd.append('file', file); f = (await api.post(`${base}/factions/${f.id}/flag`, fd)).faction; }
      $('#facFlagNone').dataset.cleared = '';
      closeModals();
      await loadFactions(); await loadMembers(); await loadMarkers();
      toast(`Saved ${f.name}`);
    } catch (err) { toast(err.message); }
  };
  $('#facDelete').onclick = async () => {
    const id = $('#facId').value;
    const f = state.factions.find(x => x.id === Number(id));
    if (!f || !confirm(`Delete faction "${f.name}"? Members and units keep the name as plain text.`)) return;
    try { await api.del(`${base}/factions/${id}`); closeModals(); await loadFactions(); } catch (err) { toast(err.message); }
  };

  // ---- Marker + drawing lists --------------------------------------------------------------------
  function visBadge(o) {
    let s = o.locked ? '<span class="badge" title="Locked: clicks pass through; unlock from its popup">🔒</span>' : '';
    if (o.adminOnly) s += '<span class="badge gm" title="Hidden from players">GM</span>';
    else if (o.visibleTo && o.visibleTo.length) s += `<span class="vis" title="Visible to ${esc(o.visibleTo.join(', '))}">${esc(o.visibleTo.join(', '))}</span>`;
    return s;
  }

  function lockLinks(kind, items) {
    if (state.role !== 'gm' || !items.length) return '';
    const ids = items.map(i => i.id);
    return ` <a href="#" class="hint" data-lockall="${kind}" data-ids="${ids.join(',')}" data-locked="1">lock all</a> · <a href="#" class="hint" data-lockall="${kind}" data-ids="${ids.join(',')}" data-locked="0">unlock all</a>`;
  }

  async function bulkLock(kind, ids, locked) {
    try {
      const body = { locked };
      body[kind === 'shape' ? 'shapeIds' : 'markerIds'] = ids;
      const d = await api.post(`${base}/lock`, body);
      toast(`${locked ? 'Locked' : 'Unlocked'} ${d.changed}`);
    } catch (err) { toast(err.message); }
  }

  // The lists are only built while the Map panel is open (thousands of units change all the time); opening it catches up.
  let listFrame = 0, listsStale = true;
  function renderMarkerLists() {
    if (state.panel !== 'markers') { listsStale = true; return; }
    if (listFrame) return;
    listFrame = requestAnimationFrame(() => { listFrame = 0; renderMarkerListsNow(); });
  }
  function renderMarkerListsNow() {
    listsStale = false;
    const q = $('#searchInput').value.trim().toLowerCase();
    const match = s => !q || String(s || '').toLowerCase().includes(q);
    const all = [...state.markers.values()].filter(m => match(m.name) || match(m.data?.nation));
    const groups = [];
    const byNation = new Map();
    for (const u of all.filter(m => m.type === 'unit')) {
      const n = u.data?.nation || 'Unaligned';
      if (!byNation.has(n)) byNation.set(n, []);
      byNation.get(n).push(u);
    }
    for (const [n, list] of [...byNation.entries()].sort((a, b) => a[0].localeCompare(b[0]))) groups.push([`Units · ${n}`, list, flagImg(n)]);
    const heroes = all.filter(m => m.type === 'hero');
    if (heroes.length) groups.push(['Heroes', heroes]);
    const towns = all.filter(m => m.type === 'town' || m.type === 'poi'), scenery = all.filter(m => m.type === 'scenery');
    groups.push(['Towns & points of interest', towns, lockLinks('marker', towns)]);
    const nodes = all.filter(m => m.type === 'resource' || m.type === 'factory');
    if (nodes.length) groups.push(['Resources & factories', nodes, lockLinks('marker', nodes)]);
    groups.push(['Players', all.filter(m => m.type === 'player')]);
    groups.push(['Scenery', scenery, lockLinks('marker', scenery)]);
    let html = groups.filter(([, list]) => list.length).map(([title, list, extra]) => `
      <div class="section">${extra && extra.startsWith('<img') ? extra : ''} ${esc(title)} <span class="hint">(${list.length})</span>${extra && !extra.startsWith('<img') ? extra : ''}</div>
      <ul class="list">${list.sort((a, b) => a.name.localeCompare(b.name)).map(m => `
        <li class="clickable ${m.id === state.selectedId ? 'selected' : ''}" data-marker="${m.id}">
          <span class="dot" style="background:${esc(m.color)}"></span>
          <span class="grow">${esc(m.name)}${m.type === 'unit' && m.data?.unitType ? ` <span class="hint">${esc(m.data.unitType)}</span>` : ''}${m.type === 'hero' ? ` <span class="hint">${esc(H.ROLES[m.data?.role]?.label || 'Hero')} ${H.starText(m.data?.stars)}${m.data?.nation ? ' · ' + esc(m.data.nation) : ''}${m.data?.status && m.data.status !== 'active' ? ' · ' + esc(H.STATUS[m.data.status] || '') : ''}</span>` : ''}${m.type === 'town' ? ` <span class="hint">${esc(m.data?.size || '')}</span>` : ''}${m.type === 'resource' ? ` <span class="hint">${esc(window.GameData?.byKey[m.data?.kind]?.name || m.data?.kind || '')} +${esc(m.data?.yield ?? '')}${m.data?.nation ? ' · ' + esc(m.data.nation) : ''}</span>` : ''}${m.type === 'factory' ? ` <span class="hint">level ${esc(m.data?.industry ?? 1)}${m.data?.nation ? ' · ' + esc(m.data.nation) : ''}</span>` : ''}</span>
          ${visBadge(m)}
        </li>`).join('')}</ul>`).join('');
    const shapes = [...state.shapes.values()].filter(s => match(s.label) || (!q));
    if (shapes.length) {
      html += `<div class="section">Drawings <span class="hint">(${shapes.length})</span>${lockLinks('shape', shapes)}${state.role === 'gm' && shapes.length > 1 ? ` · <a href="#" data-delall="1" title="Delete every drawing you can see (e.g. imported borders you no longer need)">delete all</a>` : ''}</div><ul class="list">${shapes.map(s => `
        <li class="clickable ${s.id === state.selectedShapeId ? 'selected' : ''}" data-shape="${s.id}">
          <span class="dot" style="background:${esc(s.color)}"></span>
          <span class="grow">${esc(shapeName(s))} <span class="hint">${s.kind === 'trench' ? (s.data?.state || 'dug') + (s.data?.nation ? ' · ' + esc(s.data.nation) : '') : s.kind === 'rail' ? `railway · ${fmtNum(pathUnits(s.points))} ${esc(state.lobby?.scaleLabel || '')}${(s.data?.cuts || []).length ? ` · ${s.data.cuts.length} cut` : ''}` : s.kind + ' · ' + s.points.length + ' pts'}</span></span>
          ${visBadge(s)}
        </li>`).join('')}</ul>`;
    }
    $('#markerLists').innerHTML = html || '<p class="muted">No markers yet.</p>';
    $('#markerLists').querySelectorAll('[data-lockall]').forEach(a => a.onclick = e => {
      e.preventDefault();
      bulkLock(a.dataset.lockall, a.dataset.ids.split(',').map(Number), a.dataset.locked === '1');
    });
    const delAll = $('#markerLists').querySelector('[data-delall]');
    if (delAll) delAll.onclick = async e => {
      e.preventDefault();
      const list = [...state.shapes.values()];
      if (!confirm(`Delete all ${list.length} drawings? Each deletion is recorded in the history and can be reverted one by one.`)) return;
      let n = 0;
      for (const s of list) { try { await api.del(`${base}/shapes/${s.id}`); removeShape(s.id); n++; } catch (err) { toast(err.message); break; } }
      toast(`Deleted ${n} drawings`);
    };
    $('#markerLists').querySelectorAll('li[data-marker]').forEach(li => li.onclick = () => {
      const m = state.markers.get(Number(li.dataset.marker));
      if (!m) return;
      renderer.centerOn(m.x, m.y, Math.max(renderer.scale, 1));
      openPanel(m.id);
    });
    $('#markerLists').querySelectorAll('li[data-shape]').forEach(li => li.onclick = () => {
      const s = state.shapes.get(Number(li.dataset.shape));
      if (!s) return;
      const c = s.points.reduce((a, p) => [a[0] + p[0] / s.points.length, a[1] + p[1] / s.points.length], [0, 0]);
      renderer.centerOn(c[0], c[1]);
      renderer.selectShape(s.id);
    });
  }

  function highlightList() {
    const ids = new Set(state.selectedIds || []);
    $$('#markerLists li').forEach(li => li.classList.toggle('selected',
      (li.dataset.marker && ids.has(Number(li.dataset.marker))) || (li.dataset.shape && Number(li.dataset.shape) === state.selectedShapeId)));
  }

  // ---- Popup ---------------------------------------------------------------------------
  /**
   * Units and heroes open their panel only on right-click (or from the sidebar lists): a left-click selects
   * them to move without the panel getting in the way. Everything else opens on a left-click as before.
   */
  const PANEL_ON_RIGHT = ['unit', 'hero'];
  function openPanel(id) {
    state.panelFor = id;
    if (state.selectedId !== id || (state.selectedIds || []).length > 1) renderer.select(id);
    else renderPopup();
  }
  // Right-click on an enemy unit with your units selected attacks it; on anything else it opens the panel.
  renderer.addEventListener('markercontext', e => {
    const target = state.markers.get(e.detail.id), plan = target && !state.placing ? attackPlan(target) : null;
    if (plan) launchAttack(target, plan);
    else openPanel(e.detail.id);
  });
  // Hovering an enemy with your units selected rings it as the target.
  renderer.addEventListener('markerhover', e => {
    const { id, over } = e.detail;
    if (!over) { if (renderer._target?.id === id) renderer.clearTarget(); return; }
    const target = state.markers.get(id), plan = target && !state.placing && !renderer.mode ? attackPlan(target) : null;
    if (!plan) { renderer.clearTarget(); return; }
    renderer.setTarget(id, plan.ready.length > 0 && !attacksClosed(), plan.ready.map(m => m.id));
  });
  function renderPopup() {
    const el = $('#popup');
    const m = state.selectedId != null ? state.markers.get(state.selectedId) : null;
    const s = state.selectedShapeId != null ? state.shapes.get(state.selectedShapeId) : null;
    syncAura(m);
    if (!m && !s) { el.style.display = 'none'; return; }
    if (m && PANEL_ON_RIGHT.includes(m.type) && state.panelFor !== m.id) { el.style.display = 'none'; return; }
    el.innerHTML = `<button type="button" class="cardclose" title="Close (Esc)">×</button>${m ? popupHtml(m) : shapePopupHtml(s)}`;
    el.querySelector('.cardclose').onclick = () => renderer.select(null);
    el.style.display = 'block';
    el.querySelectorAll('[data-act]').forEach(b => b.onclick = () => (m ? popupAction(b.dataset.act, m, b) : shapeAction(b.dataset.act, s, b)));
  }

  const stat = (k, v) => (v !== undefined && v !== null && v !== '') ? `<div class="stat"><span class="muted">${k}</span><span>${esc(v)}</span></div>` : '';
  const nationStat = n => n ? `<div class="stat"><span class="muted">Faction</span><span>${flagImg(n)} ${esc(n)}</span></div>` : '';


  // ---- Heroes (public/js/heroes.js) ----------------------------------------------------------------------
  const H = window.Heroes;
  const heroSettings = () => state.game?.settings || window.GameData?.DEFAULT_SETTINGS || {};
  /** World-space radii of a circle of `km` around (x, y): an ellipse on the Earth map, a circle elsewhere. */
  function kmToWorld(x, y, km) {
    const l = state.lobby || {};
    if (isEarth()) {
      const W = l.mapWidth, Ht = l.mapHeight, lat = 90 - (y / Ht) * 180;
      return [km / (111.32 * Math.max(0.05, Math.cos(lat * Math.PI / 180))) * W / 360, km / 111.32 * Ht / 180];
    }
    const r = km / (l.unitsPerPx || 1);
    return [r, r];
  }
  const heroReady = h => h && h.type === 'hero' && !h.adminOnly && !['captured', 'travelling'].includes(h.data?.status);
  /** The best general of a unit's own nation within the aura, as the server computes it for combat. */
  function generalFor(u) {
    const n = String(u.data?.nation || '').toLowerCase(), km = Number(heroSettings().heroAuraKm ?? 60);
    if (!n) return null;
    let best = null;
    for (const h of state.markers.values()) {
      if (!heroReady(h) || h.data.role !== 'general' || String(h.data.nation || '').toLowerCase() !== n) continue;
      if (distanceUnits(u.x, u.y, h.x, h.y) > km) continue;
      const bonus = H.generalBonus(h.data.stars);
      if (!best || bonus > best.bonus) best = { bonus, hero: h };
    }
    return best;
  }
  const factionNameById = id => state.factions.find(f => f.id === Number(id))?.name || '';
  const rawStat = (k, html) => `<div class="stat"><span class="muted">${k}</span><span>${html}</span></div>`;
  function heroPortraitHtml(m) {
    const role = H.ROLES[m.data?.role] || H.ROLES.general;
    if (m.iconUrl && Atlas.isRef(m.iconUrl)) return Atlas.html(m.iconUrl, 90);
    if (m.iconUrl) return `<img src="${esc(m.iconUrl)}" alt="">`;
    return `<span class="hero-initials">${esc(initials(m.name))}<small>${role.glyph}</small></span>`;
  }
  /** The hero card shown in the popup: 2:3 portrait in an animated golden ring, stars, role, stats, status. */
  function heroCardHtml(m) {
    const d = m.data || {}, role = H.ROLES[d.role] || H.ROLES.general, s = heroSettings(), km = state.lobby?.scaleLabel || 'km';
    let rows = nationStat(d.nation) + stat('Perception', d.perception) + stat('Intelligence', d.intelligence);
    if (d.role === 'general') rows += stat('Aura', `+${H.generalBonus(d.stars)} attack and defend within ${s.heroAuraKm ?? 60} ${km}`);
    if (d.role === 'spy') rows += stat('Missions', `recon and hunt within ${H.missionRadiusKm(d.stars)} ${km}${gameOn() ? ` · steals up to ${(s.spyStealPerStar ?? 5) * H.stars(d.stars)} RP` : ''}`);
    if (d.status === 'posted') rows += rawStat('Posted to', `${flagImg(factionNameById(d.postedTo))} ${esc(factionNameById(d.postedTo) || '?')}`);
    if (d.status === 'travelling' && d.travel) rows += rawStat(d.travel.home ? 'Returning to' : 'En route to', `${esc(d.travel.toName || '?')} <span class="hint">(arrives at the end of the turn)</span>`);
    if (d.status === 'captured') rows += stat('Captured by', d.capturedBy || '?');
    if (gameOn() && !['captured', 'travelling'].includes(d.status)) {
      const allow = (Number(d.movement) || 0) * (Number(s.kmPerMove) || 50), used = Number(d.movedKm) || 0;
      rows += stat('This turn', `${Math.max(0, (Number(d.ap) || 1) - (Number(d.apUsed) || 0))}/${Number(d.ap) || 1} actions · ${fmtNum(Math.max(0, allow - used))} of ${fmtNum(allow)} ${km} left`);
      rows += marchRow(m);
    }
    return `<div class="herocard ${esc(d.status || 'active')}">
      <div class="hero-portrait" title="${esc(role.label)}"><div class="hero-oval">${heroPortraitHtml(m)}</div></div>
      <div class="hero-info">
        <div class="hero-role">${role.glyph} ${esc(role.label)}${d.title ? ` <span class="hint">· ${esc(d.title)}</span>` : ''}</div>
        <div class="hero-stars" title="${H.stars(d.stars)} of 5 stars">${H.starText(d.stars)}</div>
        ${rows}
      </div>
    </div><p class="hint" style="margin:4px 0 0">${esc(role.blurb)}</p>`;
  }
  /** Orders a hero's commander (or the host of a posted diplomat) can give from the popup. */
  function heroActionsHtml(m) {
    const d = m.data || {};
    let out = '';
    const commander = canEdit(m) && !['captured', 'travelling'].includes(d.status);
    if (commander && d.role === 'spy') {
      out += `<button class="small" data-act="recon" title="Report every foreign unit within ${H.missionRadiusKm(d.stars)} km; contested on hostile ground">🔍 Recon</button>`;
      if (gameOn()) out += `<button class="small" data-act="steal" title="Take research points from the nation whose ground this spy stands on; contested by its spies">🗝 Steal research</button>`;
      out += `<button class="small" data-act="hunt" title="Try to catch enemy spies within ${H.missionRadiusKm(d.stars)} km: d20 + perception against each spy's d20 + intelligence">🕵 Hunt spies</button>`;
    }
    if (commander && d.role === 'diplomat') {
      const own = String(d.nation || '').toLowerCase();
      const opts = state.factions.filter(f => f.name.toLowerCase() !== own && !(d.status === 'posted' && f.id === Number(d.postedTo)))
        .map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
      if (opts) out += `<span class="herosend"><select id="heroSendTo">${opts}</select><button class="small" data-act="send" title="Travel to that nation's capital; arrives at the end of the turn">✉ Send</button></span>`;
      if (d.status === 'posted') out += `<button class="small secondary" data-act="recall">↩ Recall</button>`;
    }
    const host = d.role === 'diplomat' && d.status === 'posted' && (state.role === 'gm' || state.myFactionId === Number(d.postedTo));
    if (host) out += `<button class="small danger" data-act="expel" title="Send this diplomat home">Expel</button>`;
    return out;
  }
  async function heroOrder(act, m) {
    const body = act === 'send' ? { factionId: Number($('#heroSendTo')?.value) } : {};
    if (act === 'steal' && !confirm(`Send ${m.name} to steal research? If the other side's spies catch ${m.name}, the spy is lost.`)) return;
    const d = await api.post(`${base}/game/heroes/${m.id}/${act}`, body);
    toast(d.message || 'Done', d.intel ? 9000 : 6000);
  }
  /** "by Paris (garrison)", "by 2nd Supply Column", "by convoy …", "from a railhead". */
  function supplySourceText(f) {
    if (!f) return '';
    if (f.kind === 'rail') return ' from a railhead';
    if (f.kind === 'place') return ` by ${f.name}`;
    if (f.kind === 'convoy') return ` by the convoy ${f.name}`;
    return ` by ${f.name}`;
  }
  /** The chain a unit's supply runs along: unit → column → column … → place, convoy or railhead. */
  function supplyChain(m) {
    const pts = [[m.x, m.y]];
    let f = m.data?.supplyFrom, guard = 0;
    while (f && f.id != null && guard++ < 30) {
      const src = state.markers.get(f.id);
      if (!src) break;
      pts.push([src.x, src.y]);
      f = src.type === 'unit' ? src.data?.supplyFrom : null;
    }
    return pts;
  }
  function syncSupplyLine(m) {
    if (m && m.type === 'unit' && supplyOn() && m.data?.supplied === true && m.data?.supplyFrom) renderer.showSupplyLine(supplyChain(m));
    else renderer.hideSupplyLine();
  }
  function syncAura(m) {
    syncSupplyLine(m);
    if (m && m.type === 'hero' && m.data?.role === 'general' && heroReady(m)) {
      const [rx, ry] = kmToWorld(m.x, m.y, Number(heroSettings().heroAuraKm ?? 60));
      renderer.showAura(m.x, m.y, rx, ry);
      return;
    }
    const role = m && m.type === 'unit' && gameOn() ? supportRole(m) : null;
    if (role && role.km > 0) { const [rx, ry] = kmToWorld(m.x, m.y, role.km); renderer.showAura(m.x, m.y, rx, ry); }
    else renderer.hideAura();
  }
  function armHero() {
    if (state.placing?.hero) { disarmPlacing(); return; }
    disarmPlacing();
    state.placing = { hero: { role: $('#qaHeroRole').value, stars: Number($('#qaHeroStars').value) || 1, name: $('#qaHeroName').value.trim() } };
    $('#qaHeroPlace').classList.add('active');
    renderer.app.canvas.style.cursor = 'copy';
    updatePlaceHud();
  }

  function popupHtml(m) {
    const d = m.data || {};
    let body = '';
    if (m.type !== 'hero' && m.iconUrl && Atlas.isRef(m.iconUrl)) body += Atlas.html(m.iconUrl, 120);
    else if (m.type !== 'hero' && m.iconUrl) body += `<img class="icon" src="${esc(m.iconUrl)}" alt="">`;
    if (m.type === 'hero') {
      body += heroCardHtml(m);
    } else if (m.type === 'scenery') {
      body += stat('Scale', `${d.scale ?? 1}×`) + stat('Rotation', `${d.rotation || 0}°`);
    } else if (m.type === 'unit') {
      body += nationStat(d.nation) + stat('Unit type', d.unitType) + stat('Attack', d.attack) + stat('Defend', d.defend)
        + stat('Action points', d.ap) + stat('Range', gameOn() ? `${d.range ?? 0} (${(Number(d.range) || 0) * (Number(state.game.settings.kmPerRange) || 50)} ${state.lobby?.scaleLabel || 'km'})` : d.range)
        + stat('Movement', gameOn() ? `${d.movement ?? 0} (${(Number(d.movement) || 0) * (Number(state.game.settings.kmPerMove) || 50)} ${state.lobby?.scaleLabel || 'km'}/turn)` : d.movement)
        + stat('Strength', d.strength !== undefined ? `${d.strength}%${d.strength <= 0 ? ' (destroyed)' : ''}` : '');
      if (gameOn()) {
        const km = state.game.settings.kmPerMove, allow = (Number(d.movement) || 0) * km, used = Number(d.movedKm) || 0;
        body += stat('This turn', `${d.attacked ? 'attacked, cannot move' : `${fmtNum(Math.max(0, allow - used))} of ${fmtNum(allow)} ${state.lobby?.scaleLabel || 'km'} left`} · ${Math.max(0, (Number(d.ap) || 0) - (Number(d.apUsed) || 0))}/${Number(d.ap) || 0} AP`);
        body += marchRow(m);
      }
      if (gameOn()) {
        const S = state.game.settings || {}, worn = wornOf(m);
        if (worn) body += stat('Worn', `−${worn} attack and defend (${d.strength}% strength)`);
        if (d.dig) body += stat('Orders', `${d.dig.mode === 'reinforce' ? 'reinforcing' : 'digging'} ${S.trenchSectionKm ?? 10} ${state.lobby?.scaleLabel || 'km'} of trench at End turn (within ${S.trenchDigKm ?? 20} ${state.lobby?.scaleLabel || 'km'} of it)`);
        if (Number(d.replenishedTurn) === state.game.turn) body += stat('Refitting', 'took on replacements this turn');
      }
      if (d.submerged) body += stat('Submerged', `seen only by destroyers within ${state.game?.settings?.subDetectKm ?? 20} ${state.lobby?.scaleLabel || 'km'}; surfaces to attack`);
      if (d.corps) body += stat('Corps', corpsName(d.corps));
      const cover = trenchCoverFor(m);
      if (cover) body += stat('Cover', `+${cover.bonus} defend (${esc(cover.trench.label || 'trench')})`);
      const gen = generalFor(m);
      if (gen) body += stat('General', `+${gen.bonus} attack and defend (${gen.hero.name})`);
      body += unitDoctrineRows(m) + convoyRows(m);
      if (d.abilities?.length) body += `<div class="stat"><span class="muted">Abilities</span></div><ul style="margin:2px 0 4px 16px;padding:0;font-size:12px">${d.abilities.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`;
    } else if (m.type === 'town') {
      body += stat('Size', d.size) + nationStat(d.nation);
      if (gameOn() && d.blockaded) body += stat('Blockade', '⚓ enemy warships lie off the coast: it supplies no troops until they are driven off');
      if (gameOn()) body += developmentStat(m);
    } else if (m.type === 'resource') {
      const r = window.GameData?.byKey[d.kind];
      const y = GameData.resourceYield(m, state.game?.settings);
      body += stat('Resource', r ? r.name : d.kind) + stat('Yield per turn', y !== Number(d.yield || 0) ? `${y} (${d.yield} and its works)` : d.yield) + nationStat(d.nation);
      if (gameOn()) body += developmentStat(m);
      else if (d.improved) body += stat('Works', `level ${d.improved} / 3`);
    } else if (m.type === 'factory') {
      body += stat('Industry level', `${d.industry ?? 1} / 5`) + nationStat(d.nation);
      if (gameOn()) body += developmentStat(m);
    } else if (m.type === 'poi') {
      body += stat('Category', d.category);
    }
    const owner = m.ownerId && state.members.find(x => x.userId === m.ownerId);
    if (owner) body += stat('Owner', owner.displayName);
    if (m.visibleTo && m.visibleTo.length) body += stat('Visible to', m.visibleTo.join(', '));
    if (d.notes) body += `<p class="notes">${esc(d.notes)}</p>`;
    let actions = `<button class="small secondary" data-act="center">Center</button>`;
    if (canEdit(m)) actions += `<button class="small" data-act="edit">Edit</button>`;
    if (canEdit(m)) actions += `<button class="small secondary" data-act="lock" title="${m.locked ? 'Let it be selected and dragged again' : 'Clicks and drags pass through a locked token'}">${m.locked ? '🔓 Unlock' : '🔒 Lock'}</button>`;
    if (m.type === 'unit' && canEdit(m) && (d.strength ?? 100) > 0 && [...state.shapes.values()].some(s => s.kind === 'rail')) actions += `<button class="small danger" data-act="railcut" title="Cut (or blow up) a railway within reach. To attack a unit, select this one and right-click the enemy."${attacksClosed() ? ' disabled' : ''}>⛓ Cut railway…</button>`;
    if (m.type === 'unit' && canEdit(m) && (d.strength ?? 100) > 0) actions += unitOrderButtons(m);
    actions += developButton(m);
    if (m.type === 'hero') actions += heroActionsHtml(m);
    if (m.type === 'unit' || m.type === 'hero') actions += convoyActions(m);
    actions += `<button class="small secondary" data-act="history">History</button>`;
    if (state.role === 'gm') actions += `<button class="small secondary" data-act="dup">Duplicate</button>`;
    if (canEdit(m)) actions += `<button class="small danger" data-act="del">Delete</button>`;
    return `<h3><span class="dot" style="background:${esc(m.color)}"></span>${esc(m.name)} <span class="badge">${TYPE_LABEL[m.type] || m.type}</span>${visBadge(m)}</h3>${body}<div class="actions">${actions}</div>`;
  }

  function shapePopupHtml(s) {
    const creator = s.createdBy && state.members.find(x => x.userId === s.createdBy);
    let body = stat('Kind', s.kind === 'area' ? (s.data?.noMansLand ? "No Man's Land" : 'Area') : s.kind === 'trench' ? 'Trench' : s.kind === 'rail' ? 'Railway' : 'Line') + (s.kind === 'rail' ? '' : stat('Points', s.points.length));
    if (s.kind === 'rail') body += railPopupRows(s);
    if (s.kind === 'trench') {
      body += stat('State', { plan: 'planned', dug: 'dug', reinforced: 'reinforced' }[s.data?.state] || 'dug') + stat('Width', `${s.width} ${state.lobby?.scaleLabel || ''}`) + nationStat(s.data?.nation);
      const g = state.game?.settings, st = s.data?.state || 'dug';
      const bonus = st === 'plan' ? 0 : (st === 'reinforced' ? (g?.trenchBonusReinforced ?? 4) : (g?.trenchBonusDug ?? 2));
      if (bonus) body += stat('Cover', `+${bonus} defend for ${esc(s.data?.nation || 'any')} units within ${g?.trenchRangeKm ?? 20} ${state.lobby?.scaleLabel || 'km'}`);
    }
    if (s.data?.noMansLand) body += stat('Movement', `walking across it costs ${state.game?.settings?.noMansLandCost ?? 3}× the distance`);
    if (creator) body += stat('Drawn by', creator.displayName);
    if (s.visibleTo && s.visibleTo.length) body += stat('Visible to', s.visibleTo.join(', '));
    if (s.kind !== 'area') {
      body += stat('Length', `${fmtNum(pathUnits(s.points))} ${state.lobby?.scaleLabel || ''}`);
    } else {
      body += stat('Perimeter', `${fmtNum(pathUnits([...s.points, s.points[0]]))} ${state.lobby?.scaleLabel || ''}`);
    }
    let actions = '';
    if (canEditShape(s)) actions += `<button class="small" data-act="edit">Edit</button>`;
    if (canEditShape(s)) actions += `<button class="small secondary" data-act="lock">${s.locked ? '🔓 Unlock' : '🔒 Lock'}</button>`;
    if (canEditShape(s) && !s.locked && s.kind !== 'area' && !earthworks(s)) actions += `<button class="small secondary" data-act="continue" title="Keep adding points at the end">${s.kind === 'trench' || s.kind === 'rail' ? 'Extend' : 'Continue'}</button>`;
    if (canEditShape(s) && !earthworks(s)) actions += `<button class="small secondary" data-act="move" title="Drag the whole drawing to a new place">Move</button>`;
    actions += `<button class="small secondary" data-act="history">History</button>`;
    if (canEditShape(s)) actions += `<button class="small danger" data-act="del">Delete</button>`;
    const planNote = s.kind === 'trench' && gameOn() && (s.data?.state || 'dug') === 'plan' ? `<p class="hint" style="margin:6px 0 0">Planned: engineers or pioneers within ${state.game.settings.trenchDigKm ?? 20} ${state.lobby?.scaleLabel || 'km'} dig it ${state.game.settings.trenchSectionKm ?? 10} ${state.lobby?.scaleLabel || 'km'} a turn (🛠 Dig trench in their panel; ${state.game.settings.trenchDigTimber ?? 4} timber a section).</p>` : '';
    const hint = earthworks(s) ? '<p class="hint" style="margin:6px 0 0">Dug earthworks: engineers reinforce it and sappers blow it up, a section at a time.</p>' : canEditShape(s) && !s.locked ? `<p class="hint" style="margin:6px 0 0">Drag a point to move it · grab the line to add a point · right-click (or Alt-click) a point to remove it · Move button or Shift-drag to move everything</p>`
      : (s.locked ? '<p class="hint" style="margin:6px 0 0">Locked: clicks on the map pass through it. Unlock to edit.</p>' : '');
    return `<h3><span class="dot" style="background:${esc(s.kind === 'rail' ? '#8d8a86' : s.color)}"></span>${esc(shapeName(s))} <span class="badge">${s.kind === 'rail' ? 'Railway' : 'Drawing'}</span>${visBadge(s)}</h3>${body}${planNote}${hint}<div class="actions">${actions}</div>`;
  }

  async function popupAction(act, m, btn) {
    try {
      if (['board', 'embarkall', 'disembark', 'askland', 'showship'].includes(act)) await convoyAction(act, m, btn);
      else if (act === 'center') renderer.centerOn(m.x, m.y);
      else if (act === 'edit') openEdit(m);
      else if (act === 'lock') { const d = await api.patch(`${base}/markers/${m.id}`, { locked: !m.locked }); upsertMarker(d.marker); }
      else if (act === 'railcut') openRailCut(m);
      else if (act === 'unmarch') { const d = await api.del(`${base}/game/units/${m.id}/goal`); upsertMarker(d.marker); toast(`${m.name}'s march is called off`); }
      else if (['recon', 'steal', 'hunt', 'send', 'recall', 'expel'].includes(act)) await heroOrder(act, m);
      else if (['replenish', 'dig', 'reinforce', 'undig', 'demolish', 'wreck', 'dive', 'surface'].includes(act)) await unitOrder(act, m);
      else if (act === 'develop') { const f = (state.factions || []).find(x => x.name.toLowerCase() === String(m.data?.nation || '').toLowerCase()); await GameUI.startProject(GameData.projectFor(m), m.id, f?.id); renderPopup(); }
      else if (act === 'history') showHistoryFor('marker', m.id);
      else if (act === 'dup') {
        const d = await api.post(`${base}/markers`, {
          type: m.type, name: `${m.name} (copy)`, x: m.x + 40 / renderer.scale, y: m.y + 40 / renderer.scale,
          color: m.color, iconUrl: m.iconUrl && !m.iconUrl.startsWith('/uploads/') ? m.iconUrl : '',
          adminOnly: m.adminOnly, visibleTo: m.visibleTo || [], ownerId: m.ownerId, data: m.data,
        });
        upsertMarker(d.marker); renderer.select(d.marker.id);
      } else if (act === 'del') await deleteMarker(m);
    } catch (err) { toast(err.message); }
  }

  async function shapeAction(act, s, btn) {
    try {
      if (act === 'edit') openShapeModal(s);
      else if (act === 'gocut') { const c = (s.data?.cuts || []).find(x => x.id === btn?.dataset.cut); if (c) renderer.centerOn(c.x, c.y); }
      else if (act === 'repair') await repairRail(s, btn?.dataset.cut);
      else if (act === 'lock') { const d = await api.patch(`${base}/shapes/${s.id}`, { locked: !s.locked }); upsertShape(d.shape); }
      else if (act === 'continue') { renderer.startDraw(['trench', 'rail'].includes(s.kind) ? s.kind : 'line', s.points, s.id); toast('Click to add points at the end; double-click, Enter or Done to finish'); }
      else if (act === 'move') { renderer.armMove(s.id); toast('Now drag the drawing to move it'); }
      else if (act === 'history') showHistoryFor('shape', s.id);
      else if (act === 'del') {
        if (!confirm(`Delete "${s.label || 'this drawing'}"?`)) return;
        await api.del(`${base}/shapes/${s.id}`);
        removeShape(s.id);
      }
    } catch (err) { toast(err.message); }
  }

  async function deleteMarker(m) {
    if (!confirm(`Delete "${m.name}"? (It can be restored from History.)`)) return;
    await api.del(`${base}/markers/${m.id}`);
    removeMarker(m.id);
  }

  // ---- Marker forms (shared by Add and Edit) ----------------------------------------
  function formHtml(p, isGm) {
    const ownerOpts = state.members.map(m => `<option value="${m.userId}">${esc(m.displayName)}</option>`).join('');
    return `
      <label>Type<select id="${p}Type" ${isGm ? '' : 'disabled'}>
        <option value="unit">Unit / army</option><option value="town">Town</option><option value="poi">Point of interest</option><option value="player">Player</option>${isGm ? '<option value="scenery">Scenery / terrain</option><option value="resource">Resource node</option><option value="factory">Factory</option><option value="hero">Hero</option>' : ''}
      </select></label>
      <label>Name<input id="${p}Name" maxlength="60" autocomplete="off" placeholder="${p === 'add' ? 'Units: blank = numbered automatically' : ''}"></label>
      <div class="grid2 coloricon">
        <label>Colour<input id="${p}Color" type="color" value="${esc(state.member?.color || '#3498db')}"></label>
        <div class="field">Icon
          <div class="iconrow"><span id="${p}IconPreview"></span><button type="button" class="small" data-pick="${p}">Sprite…</button><label class="filebtn">Upload<input id="${p}IconFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label><button type="button" class="small secondary" data-pickclear="${p}" title="Clear the icon (back to the drawn symbol)">×</button></div>
        </div>
      </div>
      <input id="${p}IconUrl" placeholder="…or paste an image URL" autocomplete="off">
      <div data-for="scenery">
        <div class="grid2">
          <label>Scale <span class="hint">(map px per sprite px)</span><input id="${p}Scale" type="number" step="any" min="0.05" max="50" value="1"></label>
          <label>Rotation °<input id="${p}Rotation" type="number" step="any" min="0" max="359" value="0"></label>
        </div>
        <label class="inline"><input type="checkbox" id="${p}Flip"> Flip horizontally</label>
        <p class="hint">Scenery is drawn at map scale: it grows and shrinks with zoom, unlike unit counters.</p>
      </div>
      <div data-for="unit">
        <div class="grid2"><label>Faction<select id="${p}NationSel">${nationOptions()}</select></label><label>Unit type <a href="#" data-key title="Show all unit symbols">key</a><select id="${p}UnitTypeSel">${unitTypeOptions()}</select></label></div>
        <label id="${p}NationCustomWrap" hidden>Custom nation<input id="${p}Nation" list="nationList" maxlength="40"></label>
        <label id="${p}UnitTypeCustomWrap" hidden>Custom unit type<input id="${p}UnitType" maxlength="40" placeholder="e.g. Cossack sotnia"></label>
        <details class="sub" ${p === 'edit' ? 'open' : ''}><summary>Stats <span class="hint">from the campaign table · <a href="#" data-defaults title="Refill attack, defend, AP, range and movement from the campaign's table for this unit type">reset</a></span></summary>
          <div class="grid3"><label>Attack<input id="${p}Attack" type="number" step="any"></label><label>Defend<input id="${p}Defend" type="number" step="any"></label><label>AP<input id="${p}Ap" type="number" step="any"></label></div>
          <div class="grid3"><label>Range<input id="${p}Range" type="number" step="any"></label><label>Move<input id="${p}Movement" type="number" step="any"></label><label>Strength %<input id="${p}Strength" type="number" min="0" max="100" value="100"></label></div>
          <label>Abilities <span class="hint">(one per line)</span><textarea id="${p}Abilities" rows="2"></textarea></label>
        </details>
      </div>
      <div data-for="town"><div class="grid2">
        <label>Size<select id="${p}Size"><option value="capital">Capital</option><option value="city">City</option><option value="village">Village</option></select></label>
        <label>Faction<select id="${p}TownNationSel">${nationOptions()}</select></label>
      </div><div class="grid2"><label>Industry <span class="hint">(game mode: 0–10)</span><input id="${p}Industry2" type="number" min="0" max="10" step="1" placeholder="by size"></label><label>Development <span class="hint">(0–5)</span><input id="${p}Developed" type="number" min="0" max="5" step="1" placeholder="0"></label></div><label id="${p}TownNationCustomWrap" hidden>Custom nation<input id="${p}TownNation" list="nationList" maxlength="40"></label></div>
      <div data-for="poi"><label>Category<input id="${p}Category" maxlength="40" placeholder="Ruins, Mine, Fortress…"></label></div>
      <div data-for="hero">
        <div class="grid2">
          <label>Role<select id="${p}HeroRole">${H.ROLE_KEYS.map(k => `<option value="${k}">${H.ROLES[k].glyph} ${H.ROLES[k].label}</option>`).join('')}</select></label>
          <label>Stars<select id="${p}HeroStars">${[1, 2, 3, 4, 5].map(n => `<option value="${n}">${H.starText(n)}</option>`).join('')}</select></label>
        </div>
        <div class="grid2"><label>Faction<select id="${p}HeroNationSel">${nationOptions()}</select></label><label>Title<input id="${p}HeroTitle" maxlength="60" placeholder="e.g. Marshal of France"></label></div>
        <label id="${p}HeroNationCustomWrap" hidden>Custom nation<input id="${p}HeroNation" list="nationList" maxlength="60"></label>
        <details class="sub"><summary>Stats <span class="hint">from the role and stars · <a href="#" data-herodefaults>reset</a></span></summary>
          <div class="grid3"><label>Perception<input id="${p}HeroPer" type="number" min="0" max="20" step="1"></label><label>Intelligence<input id="${p}HeroInt" type="number" min="0" max="20" step="1"></label><label>Move<input id="${p}HeroMove" type="number" min="0" max="20" step="any"></label></div>
        </details>
        <p class="hint">Portrait: upload an image under Icon; it is shown 2:3 inside a golden ring. Spies are visible only to their own nation.</p>
      </div>
      <div data-for="resource"><div class="grid2">
        <label>Resource<select id="${p}Kind">${(window.GameData ? GameData.RESOURCES : []).map(r => `<option value="${r.key}">${esc(r.name)}</option>`).join('')}</select></label>
        <label>Yield per turn<input id="${p}Yield" type="number" min="0" max="50" step="any" value="3"></label>
      </div><div class="grid2"><label>Owner faction<select id="${p}ResNationSel">${nationOptions()}</select></label><label>Works <span class="hint">(improvements 0–3)</span><input id="${p}Improved" type="number" min="0" max="3" step="1" placeholder="0"></label></div>
      <label id="${p}ResNationCustomWrap" hidden>Custom nation<input id="${p}ResNation" list="nationList" maxlength="60"></label></div>
      <div data-for="factory"><div class="grid2">
        <label>Owner faction<select id="${p}FacNationSel">${nationOptions()}</select></label>
        <label>Industry level<input id="${p}Industry" type="number" min="1" max="5" step="1" value="1"></label>
      </div><label id="${p}FacNationCustomWrap" hidden>Custom nation<input id="${p}FacNation" list="nationList" maxlength="60"></label></div>
      <label>Notes<textarea id="${p}Notes" rows="2"></textarea></label>
      <details class="sub" ${p === 'edit' ? 'open' : ''}><summary>Visibility &amp; ownership</summary>
        <label class="inline"><input type="checkbox" id="${p}Locked"> Locked <span class="hint">(clicks and drags pass through; unlock from its popup)</span></label>
        ${isGm ? `<label>Owner <span class="hint">(player allowed to move it)</span><select id="${p}Owner"><option value="">— none —</option>${ownerOpts}</select></label>
        <label>Visible to nations <span class="hint">(comma separated, blank = everyone; owner always sees it)</span><input id="${p}VisibleTo" list="nationList" autocomplete="off" placeholder="Everyone"></label>
        <label class="inline"><input type="checkbox" id="${p}AdminOnly"> GM only (hidden from players)</label>` : ''}
      </details>`;
  }

  /** Role and stars refill perception, intelligence and movement (the "reset" link does it on demand). */
  function bindHeroDefaults(p, fillNow) {
    const fill = () => {
      const def = H.defaults(document.getElementById(p + 'HeroRole')?.value, document.getElementById(p + 'HeroStars')?.value);
      for (const [id, k] of [['HeroPer', 'perception'], ['HeroInt', 'intelligence'], ['HeroMove', 'movement']]) { const el = document.getElementById(p + id); if (el) el.value = def[k]; }
    };
    const role = document.getElementById(p + 'HeroRole'), st = document.getElementById(p + 'HeroStars');
    if (!role) return;
    role.onchange = fill; st.onchange = fill;
    const link = document.querySelector(`#${p === 'add' ? 'addForm' : 'editForm'} [data-herodefaults]`);
    if (link) link.onclick = e => { e.preventDefault(); fill(); };
    if (fillNow) { st.value = '3'; fill(); }
  }
  function toggleTypeFields(form, type, setLockDefault) {
    form.querySelectorAll('[data-for]').forEach(div => { div.style.display = div.dataset.for === type ? '' : 'none'; });
    if (setLockDefault) {
      const lk = form.querySelector('[id$="Locked"]');
      if (lk) lk.checked = ['town', 'poi', 'scenery'].includes(type);
    }
  }

  function unitTypeOptions() {
    const U = window.UnitTypes;
    if (!U) return '<option value="__custom">Custom…</option>';
    const ov = state.lobby?.settings?.unitStats;
    return U.categories.map(cat =>
      `<optgroup label="${esc(cat)}">${U.LIST.filter(t => t.cat === cat).map(t => `<option value="${esc(t.name)}">${esc(t.name)} — ${U.statLabel(t, ov)}</option>`).join('')}</optgroup>`
    ).join('') + '<option value="__custom">Custom…</option>';
  }

  /** Fill attack/defend/AP/range/movement from the campaign's defaults for the selected type (custom types are left alone). */
  function applyTypeDefaults(p) {
    const U = window.UnitTypes;
    if (!U) return false;
    const d = U.defaults(readUnitType(p), state.lobby?.settings?.unitStats);
    if (!d) return false;
    const set = (id, val) => { const el = document.getElementById(p + id); if (el) el.value = val; };
    set('Attack', d.attack); set('Defend', d.defend); set('Ap', d.ap); set('Range', d.range); set('Movement', d.movement);
    return true;
  }

  /** Wire the unit-type picker: choosing "Custom…" reveals a free-text field; picking a type fills its default stats. */
  function bindUnitTypePicker(p) {
    const sel = document.getElementById(p + 'UnitTypeSel'), wrap = document.getElementById(p + 'UnitTypeCustomWrap');
    if (!sel) return;
    sel.onchange = () => {
      wrap.hidden = sel.value !== '__custom';
      if (!wrap.hidden) document.getElementById(p + 'UnitType').focus();
      else applyTypeDefaults(p);
    };
    const link = sel.closest('label')?.querySelector('[data-key]');
    if (link) link.onclick = e => { e.preventDefault(); openSymbolKey(document.getElementById(p + 'Color')?.value); };
    const def = document.querySelector(`#${p}Form [data-defaults]`);
    if (def) def.onclick = e => { e.preventDefault(); e.stopPropagation(); if (!applyTypeDefaults(p)) toast('No catalogue defaults for a custom unit type'); };
  }

  /** Render every catalogue counter in the chosen colour and show them in a modal. */
  async function openSymbolKey(color) {
    const U = window.UnitTypes;
    if (!U) return;
    const grid = $('#keyGrid');
    grid.className = 'keygrid';
    grid.innerHTML = '<p class="muted">Rendering…</p>';
    $('#keyModal').classList.add('open');
    const col = /^#[0-9a-f]{6}$/i.test(color || '') ? color : (state.member?.color || '#3498db');
    const ov = state.lobby?.settings?.unitStats;
    let html = '';
    for (const cat of U.categories) {
      html += `<div class="section" style="grid-column:1/-1">${esc(cat)}</div>`;
      for (const t of U.LIST.filter(x => x.cat === cat)) {
        const url = await renderer.counterImage(t.name, col);
        html += `<div class="k"><img src="${url}" alt=""><span>${esc(t.name)}<br><span class="hint">${esc(U.statLabel(t, ov))}</span></span></div>`;
      }
    }
    grid.innerHTML = html;
  }
  /** Faction/nation picker: select of factions plus a custom text field. `id` is 'Nation' or 'TownNation'. */
  function bindNationPicker(p, id) {
    const sel = document.getElementById(p + id + 'Sel'), wrap = document.getElementById(p + id + 'CustomWrap');
    if (!sel) return;
    sel.onchange = () => {
      wrap.hidden = sel.value !== '__custom';
      const f = factionByName(sel.value);
      const col = document.getElementById(p + 'Color');
      if (f && col) col.value = f.color;
    };
  }
  function readNation(p, id) {
    const sel = document.getElementById(p + id + 'Sel');
    if (!sel) return document.getElementById(p + id)?.value ?? '';
    return sel.value === '__custom' ? (document.getElementById(p + id)?.value ?? '') : sel.value;
  }
  function setNation(p, id, value) {
    const sel = document.getElementById(p + id + 'Sel'), wrap = document.getElementById(p + id + 'CustomWrap'), txt = document.getElementById(p + id);
    if (!sel) { if (txt) txt.value = value ?? ''; return; }
    const known = [...sel.options].find(o => o.value && o.value !== '__custom' && o.value.toLowerCase() === String(value || '').toLowerCase());
    if (known) { sel.value = known.value; wrap.hidden = true; txt.value = ''; }
    else if (value) { sel.value = '__custom'; wrap.hidden = false; txt.value = value; }
    else { sel.value = ''; wrap.hidden = true; txt.value = ''; }
  }

  function readUnitType(p) {
    const sel = document.getElementById(p + 'UnitTypeSel');
    if (!sel) return document.getElementById(p + 'UnitType')?.value ?? '';
    return sel.value === '__custom' ? (document.getElementById(p + 'UnitType')?.value ?? '') : sel.value;
  }
  function setUnitType(p, value) {
    const sel = document.getElementById(p + 'UnitTypeSel'), wrap = document.getElementById(p + 'UnitTypeCustomWrap'), txt = document.getElementById(p + 'UnitType');
    if (!sel) { if (txt) txt.value = value ?? ''; return; }
    const known = [...sel.options].find(o => o.value.toLowerCase() === String(value || '').toLowerCase());
    if (known) { sel.value = known.value; wrap.hidden = true; txt.value = ''; }
    else if (value) { sel.value = '__custom'; wrap.hidden = false; txt.value = value; }
    else { sel.selectedIndex = 0; wrap.hidden = true; txt.value = ''; }
  }

  function readForm(p) {
    const v = id => document.getElementById(p + id)?.value ?? '';
    const type = v('Type');
    const data = { notes: v('Notes') };
    if (type === 'unit') Object.assign(data, {
      nation: readNation(p, 'Nation'), unitType: readUnitType(p), attack: v('Attack'), defend: v('Defend'), ap: v('Ap'), range: v('Range'),
      movement: v('Movement'), strength: v('Strength') === '' ? 100 : v('Strength'),
      abilities: v('Abilities').split('\n').map(s => s.trim()).filter(Boolean),
    });
    if (type === 'town') Object.assign(data, { size: v('Size'), nation: readNation(p, 'TownNation'), industry: v('Industry2'), developed: Number(v('Developed')) || 0 });
    if (type === 'poi') Object.assign(data, { category: v('Category') });
    if (type === 'resource') Object.assign(data, { kind: v('Kind'), yield: v('Yield') === '' ? 1 : v('Yield'), nation: readNation(p, 'ResNation'), improved: Number(v('Improved')) || 0 });
    if (type === 'factory') Object.assign(data, { industry: v('Industry') || 1, nation: readNation(p, 'FacNation') });
    if (type === 'scenery') Object.assign(data, { scale: v('Scale') || 1, rotation: v('Rotation') || 0, flip: !!document.getElementById(p + 'Flip')?.checked });
    if (type === 'hero') Object.assign(data, {
      role: v('HeroRole'), stars: Number(v('HeroStars')) || 1, title: v('HeroTitle'), nation: readNation(p, 'HeroNation'),
      perception: v('HeroPer'), intelligence: v('HeroInt'), movement: v('HeroMove'),
    });
    const name = v('Name').trim() || (type === 'scenery' ? sceneryName(v('IconUrl')) : type === 'hero' ? (H.ROLES[v('HeroRole')] || H.ROLES.general).label : '');
    const out = { type, name, color: v('Color'), iconUrl: v('IconUrl'), data, autoName: type === 'unit' && !name };
    const owner = document.getElementById(p + 'Owner');
    if (owner) out.ownerId = owner.value ? Number(owner.value) : null;
    const ao = document.getElementById(p + 'AdminOnly');
    if (ao) out.adminOnly = ao.checked;
    const lk = document.getElementById(p + 'Locked');
    if (lk) out.locked = lk.checked;
    const vt = document.getElementById(p + 'VisibleTo');
    if (vt) out.visibleTo = vt.value;
    out.file = document.getElementById(p + 'IconFile')?.files?.[0] || null;
    return out;
  }

  function fillForm(p, m) {
    const set = (id, val) => { const el = document.getElementById(p + id); if (el) el.value = val ?? ''; };
    const d = m.data || {};
    set('Type', m.type); set('Name', m.name); set('Color', m.color);
    set('IconUrl', m.iconUrl && !m.iconUrl.startsWith('/uploads/') ? m.iconUrl : '');
    setNation(p, 'Nation', m.type === 'unit' ? d.nation : ''); setUnitType(p, d.unitType); set('Attack', d.attack); set('Defend', d.defend); set('Ap', d.ap);
    set('Range', d.range); set('Movement', d.movement); set('Strength', d.strength ?? 100);
    set('Abilities', (d.abilities || []).join('\n'));
    set('Size', d.size || 'village'); setNation(p, 'TownNation', m.type === 'town' ? d.nation : ''); set('Category', d.category); set('Notes', d.notes);
    set('Kind', d.kind || 'grain'); set('Yield', d.yield ?? 3); setNation(p, 'ResNation', m.type === 'resource' ? d.nation : '');
    set('Industry', d.industry ?? 1); setNation(p, 'FacNation', m.type === 'factory' ? d.nation : '');
    set('Industry2', m.type === 'town' ? (d.industry ?? '') : '');
    set('Developed', m.type === 'town' ? (d.developed || '') : '');
    set('Improved', m.type === 'resource' ? (d.improved || '') : '');
    set('Owner', m.ownerId ?? ''); set('VisibleTo', (m.visibleTo || []).join(', '));
    set('Scale', d.scale ?? 1); set('Rotation', d.rotation ?? 0);
    if (m.type === 'hero') {
      set('HeroRole', d.role || 'general'); set('HeroStars', H.stars(d.stars)); set('HeroTitle', d.title || ''); setNation(p, 'HeroNation', d.nation || '');
      set('HeroPer', d.perception); set('HeroInt', d.intelligence); set('HeroMove', d.movement);
    }
    const fl = document.getElementById(p + 'Flip'); if (fl) fl.checked = !!d.flip;
    const ao = document.getElementById(p + 'AdminOnly'); if (ao) ao.checked = !!m.adminOnly;
    const lk = document.getElementById(p + 'Locked'); if (lk) lk.checked = !!m.locked;
    updateIconPreview(p);
  }

  function sceneryName(ref) {
    const p = Atlas.parse(ref);
    return p ? `${p.sheet.label} #${p.sprite.n}` : 'Scenery';
  }

  function updateIconPreview(p) {
    const el = document.getElementById(p + 'IconPreview');
    const val = document.getElementById(p + 'IconUrl')?.value || '';
    if (!el) return;
    const file = document.getElementById(p + 'IconFile')?.files?.[0];
    if (file) el.innerHTML = `<span class="hint" title="${esc(file.name)}">📎 ${esc(file.name.length > 18 ? file.name.slice(0, 16) + '…' : file.name)}</span>`;
    else if (Atlas.isRef(val)) el.innerHTML = Atlas.html(val, 40);
    else if (val) el.innerHTML = `<img src="${esc(val)}" alt="" style="max-width:40px;max-height:40px;border-radius:4px">`;
    else el.innerHTML = '<span class="hint" title="No icon: the marker uses its drawn symbol">symbol</span>';
  }

  /** Wire the sprite picker buttons, upload button and live preview for a form prefix. */
  function bindIconPicker(p) {
    const input = document.getElementById(p + 'IconUrl');
    if (!input) return;
    input.oninput = () => updateIconPreview(p);
    const file = document.getElementById(p + 'IconFile');
    if (file) file.onchange = () => updateIconPreview(p);
    document.querySelector(`[data-pick="${p}"]`).onclick = () => openSpritePicker(p);
    document.querySelector(`[data-pickclear="${p}"]`).onclick = () => { input.value = ''; if (file) file.value = ''; updateIconPreview(p); };
    updateIconPreview(p);
  }

  // ---- Sprite picker ------------------------------------------------------------------------------
  const picker = { prefix: null, category: null, sheet: null, tiles: false };
  function openSpritePicker(p) {
    if (!Atlas.data || !Atlas.data.sheets.length) { toast('No sprite atlas on this server (run scripts/extract-sprites.js)'); return; }
    picker.prefix = p;
    const cats = [...new Map(Atlas.data.sheets.map(s => [s.category, s.categoryLabel])).entries()];
    const catSel = $('#spriteCategory');
    catSel.innerHTML = cats.map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('');
    const current = Atlas.parse(document.getElementById(p + 'IconUrl').value);
    picker.category = current ? current.sheet.category : (picker.category || cats[0][0]);
    catSel.value = picker.category;
    fillSheetSelect(current ? current.sheet.id : null);
    $('#spriteModal').classList.add('open');
  }
  function fillSheetSelect(preferId) {
    const sheets = Atlas.data.sheets.filter(s => s.category === picker.category);
    const sel = $('#spriteSheet');
    sel.innerHTML = sheets.map(s => `<option value="${s.id}">${esc(s.label)} (${s.sprites.filter(x => !x.tile).length})</option>`).join('');
    picker.sheet = preferId && sheets.some(s => s.id === preferId) ? preferId : (sheets[0] && sheets[0].id);
    sel.value = picker.sheet;
    renderSpriteGrid();
  }
  function renderSpriteGrid() {
    const sheet = Atlas.bySheet.get(picker.sheet);
    const grid = $('#spriteGrid');
    if (!sheet) { grid.innerHTML = ''; return; }
    const cur = document.getElementById(picker.prefix + 'IconUrl').value;
    const list = sheet.sprites.filter(s => picker.tiles ? true : !s.tile);
    grid.innerHTML = list.map(s => {
      const ref = `sprite:${sheet.id}:${s.n}`;
      return `<div class="cell ${ref === cur ? 'selected' : ''}" data-ref="${ref}" title="${s.w}×${s.h}${s.tile ? ' tile' : ''}">${Atlas.html(ref, 70)}</div>`;
    }).join('') || '<p class="muted">Nothing in this sheet.</p>';
    grid.querySelectorAll('.cell').forEach(c => c.onclick = () => {
      const input = document.getElementById(picker.prefix + 'IconUrl');
      input.value = c.dataset.ref;
      updateIconPreview(picker.prefix);
      closeModals();
    });
  }
  $('#spriteCategory').onchange = e => { picker.category = e.target.value; fillSheetSelect(null); };
  $('#spriteSheet').onchange = e => { picker.sheet = e.target.value; renderSpriteGrid(); };
  $('#spriteTiles').onchange = e => { picker.tiles = e.target.checked; renderSpriteGrid(); };
  $('#spriteClear').onclick = () => { const input = document.getElementById(picker.prefix + 'IconUrl'); input.value = ''; updateIconPreview(picker.prefix); closeModals(); };

  function renderAddForm() {
    const form = $('#addForm');
    const gm = state.role === 'gm';
    const prevFilter = $('#qaFilter')?.value || '';
    const prevNation = $('#qaNation')?.value;
    form.innerHTML = gm ? `
      <div class="grid2">
        <label>Faction<select id="qaNation">${nationOptions()}</select></label>
        <label>Find<input id="qaFilter" type="search" placeholder="e.g. cavalry" autocomplete="off"></label>
      </div>
      <p class="hint">Click a unit type, then click the map to place it. Units are numbered per faction (1st, 2nd… or 1e, 1., 1ª to suit the faction) and take their stats from the campaign table. Rename or edit any unit from its popup.</p>
      <div id="qaList" class="qalist"></div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:4px"><span class="hint">Also:</span>
        <button type="button" class="small secondary" data-quick="town">Town</button><button type="button" class="small secondary" data-quick="poi">Point of interest</button><button type="button" class="small secondary" data-quick="scenery">Scenery</button><button type="button" class="small secondary" data-quick="player">Player</button>
      </div>
      <div class="row" style="margin-top:6px;flex-wrap:wrap;gap:4px" title="Resource nodes feed the faction that owns them each turn">
        <img id="qaResIcon" class="resicon" src="/icons/wheat.png" alt="" style="width:22px;height:22px;margin:0">
        <select id="qaResKind" style="width:auto;margin:0;padding:3px 6px">${(window.GameData ? GameData.RESOURCES : []).map(r => `<option value="${r.key}">${esc(r.name)}</option>`).join('')}</select>
        <input id="qaResYield" type="number" min="0" max="50" step="any" value="3" style="width:56px;margin:0;padding:3px 6px" title="Yield per turn">
        <button type="button" class="small secondary" id="qaResPlace" title="Then click the map to place nodes for the selected faction">Place…</button>
        <button type="button" class="small secondary" data-quick="factory">Factory</button>
      </div>
      <div class="row" style="margin-top:6px;flex-wrap:wrap;gap:4px" title="Heroes: generals buff nearby units, diplomats carry proposals, spies steal research, scout and hunt spies">
        <span class="hint">Hero</span>
        <select id="qaHeroRole" style="width:auto;margin:0;padding:3px 6px">${H.ROLE_KEYS.map(k => `<option value="${k}">${H.ROLES[k].glyph} ${H.ROLES[k].label}</option>`).join('')}</select>
        <select id="qaHeroStars" style="width:auto;margin:0;padding:3px 6px">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${H.starText(n)}</option>`).join('')}</select>
        <input id="qaHeroName" maxlength="60" placeholder="Name" autocomplete="off" style="width:130px;margin:0;padding:3px 6px">
        <button type="button" class="small secondary" id="qaHeroPlace" title="Then click the map to place the hero for the selected faction">Place…</button>
      </div>
      <details class="sub" id="customMarker"><summary>Custom marker</summary>
        ${formHtml('add', gm)}
        <button type="submit" style="width:100%">Place at map centre</button>
      </details>`
    : `<p class="hint">Players can place their own player marker. Ask the GM to place units and towns.</p>
      ${formHtml('add', gm)}
      <button type="submit" style="width:100%">Place at map centre</button>
      <p class="hint">Drag markers on the map to move them. Everyone connected sees changes live.</p>`;
    const typeSel = $('#addType');
    if (!gm) typeSel.value = 'player';
    toggleTypeFields(form, typeSel.value, true);
    typeSel.onchange = () => toggleTypeFields(form, typeSel.value, true);
    bindUnitTypePicker('add');
    bindIconPicker('add');
    bindNationPicker('add', 'Nation'); bindNationPicker('add', 'TownNation'); bindNationPicker('add', 'ResNation'); bindNationPicker('add', 'FacNation');
    bindNationPicker('add', 'HeroNation'); bindHeroDefaults('add', true);
    setNation('add', 'Nation', state.member?.nation || '');
    applyTypeDefaults('add');
    if (gm) {
      const nationSel = $('#qaNation');
      nationSel.querySelector('option[value="__custom"]')?.remove();
      nationSel.querySelector('option[value=""]').textContent = '— unaligned —';
      if (prevNation !== undefined && [...nationSel.options].some(o => o.value === prevNation)) nationSel.value = prevNation;
      else if (state.factions.length && !state.member?.nation) nationSel.value = state.factions[0].name;
      else nationSel.value = state.member?.nation || '';
      $('#qaFilter').value = prevFilter;
      let gen = 0;
      const renderQuick = async () => {
        const U = window.UnitTypes, ov = state.lobby?.settings?.unitStats;
        const q = $('#qaFilter').value.trim().toLowerCase();
        let html = '';
        for (const cat of U.categories) {
          const types = U.LIST.filter(t => t.cat === cat && (!q || t.name.toLowerCase().includes(q) || t.unit.toLowerCase().includes(q) || cat.toLowerCase().includes(q)));
          if (!types.length) continue;
          html += `<div class="section">${esc(cat)}</div>` + types.map(t =>
            `<button type="button" class="qa${state.placing?.typeId === t.id ? ' active' : ''}" data-qa="${t.id}" title="${esc(t.name)} · ${esc(U.statLabel(t, ov))}"><img alt="" data-counter="${esc(t.name)}"><span>${esc(t.unit)}</span></button>`).join('');
        }
        $('#qaList').innerHTML = html || '<p class="hint">No unit types match.</p>';
        $$('#qaList .qa').forEach(b => b.onclick = () => armPlacing(b.dataset.qa));
        const g = ++gen, color = quickColor();
        for (const img of $$('#qaList img[data-counter]')) {
          const url = await counterImg(img.dataset.counter, color);
          if (g !== gen) return;
          img.src = url;
        }
      };
      $('#qaFilter').oninput = renderQuick;
      nationSel.onchange = () => { renderQuick(); updatePlaceHud(); setNation('add', 'Nation', nationSel.value); };
      renderQuick();
      $('#qaResKind').onchange = () => { const u = window.GameData?.iconUrl($('#qaResKind').value); $('#qaResIcon').src = u || ''; if (state.placing?.resource) { state.placing.resource = $('#qaResKind').value; updatePlaceHud(); } };
      $('#qaResYield').onchange = () => { if (state.placing?.resource) { state.placing.yield = Number($('#qaResYield').value) || 0; updatePlaceHud(); } };
      $('#qaResPlace').onclick = () => {
        if (state.placing?.resource) { disarmPlacing(); return; }
        disarmPlacing();
        state.placing = { resource: $('#qaResKind').value, yield: Number($('#qaResYield').value) || 0 };
        $('#qaResPlace').classList.add('active');
        renderer.app.canvas.style.cursor = 'copy';
        updatePlaceHud();
      };
      $('#qaHeroPlace').onclick = armHero;
      $$('#addForm [data-quick]').forEach(b => b.onclick = () => {
        disarmPlacing();
        const det = $('#customMarker'); det.open = true;
        typeSel.value = b.dataset.quick; toggleTypeFields(form, typeSel.value, true);
        $('#addName').focus();
      });
    }
    form.onsubmit = async e => {
      e.preventDefault();
      const f = readForm('add');
      const c = renderer.getCenterWorld();
      try {
        const d = await api.post(`${base}/markers`, { ...f, file: undefined, x: round1(c.x), y: round1(c.y) });
        let marker = d.marker;
        if (f.file) marker = (await uploadIcon(marker.id, f.file)).marker;
        upsertMarker(marker);
        renderer.select(marker.id);
        form.reset();
        if (!gm) typeSel.value = 'player';
        typeSel.value = f.type; // keep placing the same kind of thing
        toggleTypeFields(form, typeSel.value, true);
        if (f.type === 'unit') {
          // Keep faction, unit type and the stats just used so a line of identical units is a name and a click each.
          setNation('add', 'Nation', f.data.nation);
          setUnitType('add', f.data.unitType);
          for (const k of ['Attack', 'Defend', 'Ap', 'Range', 'Movement']) {
            const el = document.getElementById('add' + k); if (el) el.value = f.data[k.toLowerCase()] ?? '';
          }
        }
        if (f.type === 'town') setNation('add', 'TownNation', f.data.nation);
        updateIconPreview('add');
        toast(`Placed ${marker.name}`);
      } catch (err) { toast(err.message); }
    };
  }

  async function uploadIcon(markerId, file) {
    const prepared = await prepareImage(file, { maxSide: 256, maxBytes: 300 * 1024 }).catch(() => file);
    const fd = new FormData(); fd.append('file', prepared, prepared.name);
    return api.post(`${base}/markers/${markerId}/icon`, fd);
  }

  function openEdit(m) {
    const form = $('#editForm');
    form.innerHTML = `${formHtml('edit', state.role === 'gm')}
      <div class="row"><button type="submit">Save</button><button type="button" class="danger" id="btnEditDelete">Delete</button></div>`;
    bindUnitTypePicker('edit');
    bindIconPicker('edit');
    bindNationPicker('edit', 'Nation'); bindNationPicker('edit', 'TownNation'); bindNationPicker('edit', 'ResNation'); bindNationPicker('edit', 'FacNation');
    bindNationPicker('edit', 'HeroNation'); bindHeroDefaults('edit', false);
    fillForm('edit', m);
    toggleTypeFields(form, m.type);
    $('#editType').onchange = () => toggleTypeFields(form, $('#editType').value);
    $('#btnEditDelete').onclick = async () => { try { await deleteMarker(m); closeModals(); } catch (err) { toast(err.message); } };
    form.onsubmit = async e => {
      e.preventDefault();
      const f = readForm('edit');
      try {
        const d = await api.patch(`${base}/markers/${m.id}`, { ...f, file: undefined });
        let marker = d.marker;
        if (f.file) marker = (await uploadIcon(marker.id, f.file)).marker;
        upsertMarker(marker);
        closeModals();
      } catch (err) { toast(err.message); }
    };
    $('#editModal').classList.add('open');
  }

  function closeModals() { $$('.modal').forEach(m => m.classList.remove('open')); }
  $$('[data-close]').forEach(b => b.onclick = closeModals);
  $$('.modal').forEach(m => m.addEventListener('pointerdown', e => { if (e.target === m) closeModals(); }));

  // ---- Shapes: create after drawing, or edit ---------------------------------------------------
  function openShapeModal(shape, pending) {
    state.editingShapeId = shape ? shape.id : null;
    state.pendingShape = pending || null;
    const kind = shape ? shape.kind : pending.kind;
    const trench = kind === 'trench', rail = kind === 'rail';
    $('#shapeModalTitle').textContent = shape ? (trench ? 'Edit trench' : rail ? 'Edit railway' : 'Edit drawing') : `New ${kind === 'area' ? 'area' : trench ? 'trench' : rail ? 'railway' : 'line'}`;
    $('#shapeLabel').value = shape ? shape.label : '';
    $('#shapeColor').value = shape ? shape.color : (state.member?.color || '#f1c40f');
    $('#shapeWidth').value = shape ? shape.width : (trench ? 0.5 : 3);
    $('#shapeWidth').step = trench ? 'any' : '1'; $('#shapeWidth').min = trench ? '0.05' : '1';
    $('#shapeColorWrap').hidden = trench || rail;
    $('#shapeWidthWrap').hidden = rail;
    $('#railFields').hidden = !rail;
    $('#shapeWidthLabel').textContent = trench ? `Trench width (${state.lobby?.scaleLabel || 'map units'})` : 'Line width';
    $('#trenchFields').hidden = !trench;
    $('#nmlFields').hidden = kind !== 'area';
    $('#shapeNoMansLand').checked = !!shape?.data?.noMansLand;
    $('#shapeNoMansLand').disabled = gameOn() && state.role !== 'gm';
    $('#trenchZigWrap').hidden = !trench || !!shape;                 // traverses are applied when the trench is first dug
    if (trench) {
      // While the game runs players only plan trenches; engineers dig them.
      const plansOnly = gameOn() && state.role !== 'gm';
      $('#trenchState').disabled = plansOnly;
      $('#trenchState').title = plansOnly ? 'Players plan trenches; engineers dig them a section a turn' : '';
      $('#trenchState').value = shape ? (shape.data?.state || 'dug') : (plansOnly ? 'plan' : 'dug');
      $('#trenchFacing').value = shape ? (shape.data?.facing || 'left') : 'left';
      $('#trenchZigzag').checked = shape ? shape.data?.zigzag !== false : true;
    }
    $('#shapeVisibleTo').value = shape && shape.visibleTo ? shape.visibleTo.join(', ') : '';
    $('#shapeAdminOnly').checked = !!(shape && shape.adminOnly);
    $('#btnShapeDelete').hidden = !shape;
    $('#shapeModal').classList.add('open');
    setTimeout(() => $('#shapeLabel').focus(), 50);
  }
  $('#shapeForm').onsubmit = async e => {
    e.preventDefault();
    const body = {
      label: $('#shapeLabel').value, color: $('#shapeColor').value, width: Number($('#shapeWidth').value) || 3,
      visibleTo: $('#shapeVisibleTo').value, adminOnly: $('#shapeAdminOnly').checked,
    };
    const editing = state.editingShapeId ? state.shapes.get(state.editingShapeId) : null;
    if ((editing && editing.kind === 'area') || state.pendingShape?.kind === 'area') body.data = { noMansLand: $('#shapeNoMansLand').checked };
    if ((editing && editing.kind === 'trench') || state.pendingShape?.kind === 'trench') {
      body.data = { state: $('#trenchState').value, facing: $('#trenchFacing').value, zigzag: $('#trenchZigzag').checked };
    }
    try {
      if (state.editingShapeId) {
        const d = await api.patch(`${base}/shapes/${state.editingShapeId}`, body);
        upsertShape(d.shape);
      } else if (state.pendingShape) {
        let points = state.pendingShape.points;
        if (state.pendingShape.kind === 'trench' && state.pendingShape.raw) {
          // Traverse size follows the on-screen width so the bays read at the zoom the trench was drawn at.
          const p0 = state.pendingShape.raw[0];
          const wPx = Math.max(renderer.unitsToPx(p0[0], p0[1], body.width), 10 / renderer.scale);
          points = Trench.processPath(state.pendingShape.raw, { tol: 2 / renderer.scale, width: wPx, zig: body.data.zigzag });
        }
        const d = await api.post(`${base}/shapes`, { ...body, kind: state.pendingShape.kind, points });
        upsertShape(d.shape);
        renderer.selectShape(d.shape.id);
      }
      state.pendingShape = null; state.editingShapeId = null;
      closeModals();
    } catch (err) { toast(err.message); }
  };
  $('#btnShapeDelete').onclick = async () => {
    const s = state.shapes.get(state.editingShapeId);
    if (!s) return;
    await shapeAction('del', s);
    closeModals();
  };

  // ---- Unit orders (server/routes/orders.js) --------------------------------------------------------------
  /** Combat penalty of a worn unit, as the server works it out: −1 per wornStep % of strength lost. */
  function wornOf(m) {
    const step = Number(state.game?.settings?.wornStep ?? 20);
    if (!gameOn() || step <= 0 || m.type !== 'unit') return 0;
    return Math.floor((100 - Math.max(0, Math.min(100, Number(m.data?.strength ?? 100)))) / step + 1e-9);
  }
  /** The order buttons a unit's commander gets: replenish, dig / reinforce, blow up a trench, dive / surface. */
  function unitOrderButtons(m) {
    const d = m.data || {}, t = window.UnitTypes?.resolve(d.unitType), S = state.game?.settings || {}, u = state.lobby?.scaleLabel || 'km';
    let out = '';
    if (t?.id === 'submarine') out += d.submerged ? '<button class="small secondary" data-act="surface" title="Come up: everyone in sight sees it again">⬆ Surface</button>'
      : `<button class="small secondary" data-act="dive" title="Run submerged: only destroyers within ${S.subDetectKm ?? 20} ${u} see it. It surfaces to attack."${gameOn() && d.attacked && state.role !== 'gm' ? ' disabled' : ''}>🌊 Dive</button>`;
    if (!gameOn()) return out;
    const strength = Number(d.strength ?? 100);
    if (strength < 100) {
      const cost = window.GameData.costFor(t?.id || 'infantry', S.unitCosts), amt = Math.min(Number(S.replenishMax ?? 50), 100 - strength);
      out += `<button class="small" data-act="replenish" title="Take on up to ${amt}% strength for about ${Math.ceil(cost.manpower * amt / 10) / 10} manpower and ${Math.ceil(cost.money * amt / 10) / 10} money. In own or allied territory, supplied, with no enemy within ${S.replenishEnemyKm ?? 50} ${u}; it then spends the turn refitting."${Number(d.replenishedTurn) === state.game.turn && state.role !== 'gm' ? ' disabled' : ''}>🩹 Replenish</button>`;
    }
    if (['engineers', 'pioneers'].includes(t?.id)) {
      if (d.dig) out += '<button class="small secondary" data-act="undig">✕ Stop digging</button>';
      else out += `<button class="small" data-act="dig" title="Dig ${S.trenchSectionKm ?? 10} ${u} of the nearest planned trench within ${S.trenchDigKm ?? 20} ${u} at End turn (${S.trenchDigTimber ?? 4} timber)">🛠 Dig trench</button><button class="small secondary" data-act="reinforce" title="Reinforce ${S.trenchSectionKm ?? 10} ${u} of the nearest dug trench of your side at End turn (${S.trenchReinforceTimber ?? 6} timber)">🛠 Reinforce</button>`;
    }
    if (t?.id === 'sappers') out += `<button class="small danger" data-act="wreck" title="Knock the works of the nearest improved resource node within ${S.trenchDigKm ?? 20} ${u} down a level: your own side's for certain (scorched earth), an enemy's on d20 + attack against d20 + ${S.trenchDemolishDefence ?? 2} + its best guard"${attacksClosed() ? ' disabled' : ''}>🔥 Wreck works</button>`;
    if (t?.id === 'sappers') out += `<button class="small danger" data-act="demolish" title="Blow up ${S.trenchSectionKm ?? 10} ${u} of the nearest enemy trench within ${S.trenchDigKm ?? 20} ${u}: d20 + attack against d20 + its works and its best guard"${attacksClosed() ? ' disabled' : ''}>💥 Blow up trench</button>`;
    return out;
  }
  async function unitOrder(act, m) {
    if (act === 'demolish' && !confirm(`Send ${m.name} against the nearest enemy trench? It uses its action for the turn.`)) return;
    if (act === 'wreck' && !confirm(`Send ${m.name} to wreck the works of the nearest improved resource node? It uses its action for the turn, and your own side's works go down too.`)) return;
    const path = { replenish: 'replenish', dig: 'dig', reinforce: 'dig', demolish: 'demolish', wreck: 'wreck', dive: 'dive', surface: 'dive' }[act];
    const body = act === 'reinforce' ? { mode: 'reinforce' } : act === 'dig' ? { mode: 'dig' } : act === 'surface' ? { submerged: false } : act === 'dive' ? { submerged: true } : {};
    const d = act === 'undig' ? await api.del(`${base}/game/units/${m.id}/dig`) : await api.post(`${base}/game/units/${m.id}/${path}`, body);
    if (d.marker) upsertMarker(d.marker);
    if (d.message) toast(d.message, act === 'demolish' || act === 'wreck' ? 8000 : 6000);
    if (d.event && !state.events.some(x => x.id === d.event.id)) { state.events.push(d.event); renderLog(true); }
    renderPopup();
  }

  // ---- Phases -------------------------------------------------------------------------------------------
  /** A banner over the map, a toast, a chime and a desktop notification when the GM changes the phase. */
  function showPhaseBanner(phase) {
    const el = $('#phaseBanner');
    const battle = phase === 'battle';
    el.className = battle ? 'battle' : '';
    el.innerHTML = battle ? '⚔ Battle phase<small>Attacks are open. Units hold their positions until the next turn.</small>'
      : '🚩 Movement phase<small>Units move. Attacks wait for the battle phase.</small>';
    el.hidden = false;
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(showPhaseBanner.t);
    showPhaseBanner.t = setTimeout(() => { el.hidden = true; }, 3300);
    toast(battle ? '⚔ The battle phase has begun: attacks are open' : '🚩 Back to the movement phase', 4000);
    beep();
    notify(battle ? 'Battle phase' : 'Movement phase', battle ? 'Attacks are open; units hold their positions' : 'Units may move again');
  }

  // ---- Corps (server/routes/orders.js) ---------------------------------------------------------------------
  state.corps = [];
  async function loadCorps() {
    if (!gameOn()) { state.corps = []; return; }
    try { state.corps = (await api.get(`${base}/game/corps`)).corps || []; } catch { state.corps = []; }
    GameUI.renderNation(); renderSelBar();
    if (state.selectedId != null) renderPopup();
  }
  function corpsName(id) { return state.corps.find(c => c.id === Number(id))?.name || `corps #${id}`; }
  const ROMAN = n => [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']].reduce((s, [v, r]) => { while (n >= v) { s += r; n -= v; } return s; }, '');
  /** Selected units a player may put in a corps: their own, alive, on land (not ships or aircraft). */
  function corpsCandidates() {
    return (state.selectedIds || []).map(id => state.markers.get(id)).filter(m => {
      if (!m || m.type !== 'unit' || !canEdit(m) || Number(m.data?.strength ?? 100) <= 0) return false;
      const cat = window.UnitTypes?.resolve(m.data?.unitType)?.cat;
      return cat !== 'Naval' && cat !== 'Air';
    });
  }
  /**
   * The bar shown with several of your units selected: form a corps, or add them to one; when they are all one corps,
   * its line orders too (the Nation panel's ⇥ Form line and ↻ Same line).
   */
  function renderSelBar() {
    const bar = $('#selBar');
    const list = gameOn() ? corpsCandidates() : [];
    if (list.length < 2) { bar.hidden = true; return; }
    const nation = String(list[0].data?.nation || '').toLowerCase();
    const same = list.every(m => String(m.data?.nation || '').toLowerCase() === nation);
    const mine = state.corps.filter(c => c.nation.toLowerCase() === nation);
    const corps = same ? mine.find(c => list.every(m => c.unitIds.includes(m.id))) : null;
    if (corps) {
      const off = holdsPosition() ? ' disabled title="Corps form up in the movement phase"' : '';
      bar.innerHTML = `<span class="hint">${list.length} units of</span> <b>${esc(corps.name)}</b>`
        + `<button type="button" class="small" data-corps="line:${corps.id}"${off || ' title="Draw a front line; the corps forms up on it"'}>⇥ Form line</button>`
        + (corps.line ? `<button type="button" class="small secondary" data-corps="again:${corps.id}"${off || ' title="Form up on the last line again (units short of movement carry on)"'}>↻ Same line</button>` : '');
      bar.hidden = false;
      return;
    }
    bar.innerHTML = `<span class="hint">${list.length} units</span>` + (same
      ? `<button type="button" class="small" data-selbar="form">⚑ Form corps</button>${mine.length ? `<select id="selBarCorps">${mine.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><button type="button" class="small secondary" data-selbar="add">＋ Add to corps</button>` : ''}`
      : '<span class="hint">· a corps is one nation\'s units</span>');
    bar.hidden = false;
  }
  $('#selBar').addEventListener('click', async e => {
    const b = e.target.closest('[data-selbar]');
    if (!b) return;
    const ids = corpsCandidates().map(m => m.id);
    try {
      if (b.dataset.selbar === 'form') {
        const nation = String(state.markers.get(ids[0])?.data?.nation || '');
        const n = state.corps.filter(c => c.nation.toLowerCase() === nation.toLowerCase()).length + 1;
        const name = prompt('Name the corps', `${ROMAN(n)} Corps`);
        if (!name) return;
        const d = await api.post(`${base}/game/corps`, { name, unitIds: ids });
        toast(`${d.corps.name} formed: ${d.corps.unitIds.length} units. ⇥ Form line in this bar draws its front.`, 5000);
      } else {
        const cid = Number($('#selBarCorps').value);
        await api.patch(`${base}/game/corps/${cid}`, { addIds: ids });
        toast(`${ids.length} units joined ${corpsName(cid)}`);
      }
      await loadCorps();
    } catch (err) { toast(err.message); }
  });
  /** The Nation panel's corps list for a faction: select, form line, add the selection, rename, disband. */
  function corpsHtml(e) {
    const list = (state.corps || []).filter(c => c.nation.toLowerCase() === e.faction.name.toLowerCase());
    const help = '<p class="hint">Select several of your land units on the map (⬚ or Shift-drag) and press ⚑ Form corps. A corps forms on a line you draw: front-line troops spread along it, artillery behind them, support further back, all facing the enemy.</p>';
    if (!list.length) return `<div class="section">Corps</div>${help}`;
    return `<div class="section">Corps <span class="hint">(${list.length})</span></div><div class="corpslist">${list.map(c => `<div class="corps"><b>${esc(c.name)}</b><span class="hint">${c.unitIds.length} unit${c.unitIds.length === 1 ? '' : 's'}</span>
      <button type="button" class="small secondary" data-corps="select:${c.id}" title="Select its units on the map">Select</button>
      <button type="button" class="small" data-corps="line:${c.id}" title="Draw a front line; the corps forms up on it"${holdsPosition() ? ' disabled' : ''}>⇥ Form line</button>
      ${c.line ? `<button type="button" class="small secondary" data-corps="again:${c.id}" title="Form up on the last line again (units short of movement carry on)"${holdsPosition() ? ' disabled' : ''}>↻ Same line</button>` : ''}
      <button type="button" class="small secondary" data-corps="rename:${c.id}">✎</button>
      <button type="button" class="small secondary" data-corps="disband:${c.id}" title="Disband the corps (its units stay where they are)">✕</button></div>`).join('')}</div>`;
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-corps]');
    if (!b) return;
    const [act, idText] = b.dataset.corps.split(':'), c = state.corps.find(x => x.id === Number(idText));
    if (!c) return;
    try {
      if (act === 'select') {
        const ids = c.unitIds.filter(id => state.markers.has(id));
        if (!ids.length) { toast(`${c.name} has no units on the map`); return; }
        const first = state.markers.get(ids[0]);
        renderer.centerOn(first.x, first.y);
        renderer.selectMany(ids, ids[0]);
      } else if (act === 'line') {
        state.corpsDraw = c.id;
        renderer.startDraw('corps');
        toast(`${c.name}: click points along its front, finish with a double-click, Enter or Done, then click the enemy's side`, 5000);
      } else if (act === 'again') {
        await sendCorpsLine(c, c.line, c.front);
      } else if (act === 'rename') {
        const name = prompt('Rename the corps', c.name);
        if (!name || name === c.name) return;
        await api.patch(`${base}/game/corps/${c.id}`, { name });
        await loadCorps();
      } else if (act === 'disband' && confirm(`Disband ${c.name}? Its units stay where they are.`)) {
        await api.del(`${base}/game/corps/${c.id}`);
        await loadCorps();
      }
    } catch (err) { toast(err.message); }
  });
  /** After drawing a corps line: wait for a click on the enemy's side of it. */
  function armCorpsFront(points) {
    const c = state.corps.find(x => x.id === state.corpsDraw);
    state.corpsDraw = null;
    if (!c) return;
    disarmPlacing();
    state.placing = { corpsFront: { id: c.id, name: c.name, points } };
    renderer.showCorpsLine(points, null);
    renderer.app.canvas.style.cursor = 'crosshair';
    updatePlaceHud();
  }
  /** Which side of the line (walked from its first point) a point is on: 'left' or 'right', by the nearest segment. */
  function sideOf(points, x, y) {
    let best = null, bd = Infinity;
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1], [bx, by] = points[i], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)), px = ax + dx * t, py = ay + dy * t, d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bd) { bd = d; best = { ax, ay, dx, dy }; }
    }
    // Left of the walking direction is (dy, −dx) in map space (y down), as on the server.
    return (x - best.ax) * best.dy - (y - best.ay) * best.dx > 0 ? 'left' : 'right';
  }
  async function formCorpsLine(x, y) {
    const p = state.placing.corpsFront, c = state.corps.find(k => k.id === p.id);
    disarmPlacing();
    if (!c) return;
    await sendCorpsLine(c, p.points, sideOf(p.points, x, y));
  }
  async function sendCorpsLine(c, points, front) {
    renderer.showCorpsLine(points, front);
    try {
      const d = await api.post(`${base}/game/corps/${c.id}/line`, { points: points.map(q => [round1(q[0]), round1(q[1])]), front });
      for (const m of d.moved || []) upsertMarker(m);
      toast(d.message + (d.errors?.length ? ` · ${d.errors.slice(0, 3).join('; ')}` : '') + (d.note ? ` · ${d.note}` : ''), 7000);
      await loadCorps();
    } catch (err) { toast(err.message); }
    setTimeout(() => renderer.hideCorpsLine(), 5000);
  }

  // ---- Combat -------------------------------------------------------------------------------------------
  // Select one of your units (or several), then right-click an enemy unit: every selected unit that can reach it
  // attacks, one after another, with no dialogue. Hovering the enemy first rings it (red: the attack would go in;
  // grey: it would not, and the right-click says why). The red dashed ring round a selected unit is its reach.
  let reachBonus = {};   // nation (lower case) -> { cat: { Artillery: 1 }, unit: { fieldgun: 1 } }: research range bonuses
  async function loadReachBonus() {
    if (!gameOn()) { reachBonus = {}; return; }
    try { reachBonus = (await api.get(`${base}/game/reach`)).bonus || {}; } catch { reachBonus = {}; }
    syncFireRange(); updateMoveRange(); syncMarches();
  }
  /** A unit's attack reach in campaign units, as the server works it out ((range + research) × km per range point). */
  function attackReachOf(m) {
    if (!gameOn() || state.game.settings.waiveMovement) return Infinity;
    const t = window.UnitTypes?.resolve(m.data?.unitType), b = reachBonus[String(m.data?.nation || '').toLowerCase()];
    const bonus = b && t ? (Number(b.cat?.[t.cat]) || 0) + (Number(b.unit?.[t.id]) || 0) : 0;
    return Math.max(0, (Number(m.data?.range) || 0) + bonus) * (Number(state.game.settings.kmPerRange) || 50);
  }
  /** Whether `a` may fight `m` at all: not the same nation, not an ally, and a submerged submarine only by destroyers. */
  function hostileTo(a, m) {
    const mine = String(a.data?.nation || '').toLowerCase(), theirs = String(m.data?.nation || '').toLowerCase();
    if (mine && mine === theirs) return false;
    if (m.data?.submerged && window.UnitTypes?.resolve(a.data?.unitType)?.id !== 'destroyer' && state.role !== 'gm') return false;
    if (!gameOn() || !mine || !theirs) return true;
    const fa = (state.factions || []).find(f => f.name.toLowerCase() === mine), fb = (state.factions || []).find(f => f.name.toLowerCase() === theirs);
    if (!fa || !fb) return true;
    const [x, y] = fa.id < fb.id ? [fa.id, fb.id] : [fb.id, fa.id];
    return !(state.relations || []).some(r => r.a === x && r.b === y && r.status === 'alliance');
  }
  /** Why a unit cannot attack this turn (null when it can), as the server would say. */
  function cannotFire(m) {
    if (Number(m.data?.strength ?? 100) <= 0) return `${m.name} has no strength left`;
    if (m.data?.aboard) return `${m.name} is aboard a convoy: land it first`;
    if (!gameOn() || state.role === 'gm') return null;
    if (cutOff(m) && window.UnitTypes?.resolve(m.data?.unitType)?.cat !== 'Emplacements') return `${m.name} is out of supply and cannot attack`;
    const ap = Number(m.data?.ap) || 0;
    if (ap <= 0) return `${m.name} has no action points and cannot attack`;
    if ((Number(m.data?.apUsed) || 0) >= ap) return `${m.name} has used its action points this turn`;
    return null;
  }
  /**
   * An attack on `target` by the selected units: { ready, blocked } (blocked: why each other one cannot), or null when
   * no selected unit of yours could ever fight it (then a right-click opens its panel instead).
   */
  function attackPlan(target) {
    if (target.type !== 'unit' || Number(target.data?.strength ?? 100) <= 0 || target.data?.aboard) return null;
    const ids = (state.selectedIds || []).length > 1 ? state.selectedIds : (state.selectedId != null ? [state.selectedId] : []);
    const list = ids.map(id => state.markers.get(id)).filter(m => m && m.type === 'unit' && m.id !== target.id && canEdit(m) && hostileTo(m, target));
    if (!list.length) return null;
    const u = state.lobby?.scaleLabel || 'km', ready = [], blocked = [];
    for (const m of list) {
      let why = cannotFire(m);
      if (!why) {
        const d = distanceUnits(m.x, m.y, target.x, target.y), reach = attackReachOf(m);
        if (d > reach + 1e-6) why = `${target.name} is ${fmtNum(d)} ${u} away; ${m.name} reaches ${fmtNum(reach)} ${u}`;
      }
      if (why) blocked.push(why); else ready.push(m);
    }
    return { ready, blocked };
  }
  /** Every ready unit attacks in turn (stopping once the target is destroyed); the log keeps every roll. */
  async function launchAttack(target, plan) {
    if (attacksClosed()) { toast('Movement phase: attacks open in the battle phase'); return; }
    if (!plan.ready.length) { toast(plan.blocked.length > 1 ? `None of them can attack ${target.name}: ${plan.blocked[0]}` : plan.blocked[0], 5000); return; }
    renderer.clearTarget();
    const done = [];
    for (const a of plan.ready) {
      try {
        const d = await api.post(`${base}/combat`, { attackerId: a.id, defenderId: target.id });
        done.push(d);
        if (d.returnFire && !state.events.some(x => x.id === d.returnFire.id)) state.events.push(d.returnFire);
        if (!state.events.some(x => x.id === d.event.id)) { state.events.push(d.event); renderLog(true); }
        if (Number(d.event.data?.losses?.[target.id]?.to) <= 0) break;
      } catch (err) { done.push({ error: `${a.name}: ${err.message}` }); }
    }
    const ok = done.filter(d => d.event);
    if (ok.length === 1 && done.length === 1) {
      const d = ok[0];
      toast(d.event.message + (d.captureNote ? ` · ${d.captureNote}` : '') + (d.returnFire ? ` · ${d.returnFire.message}` : ''), 8000);
    } else {
      const won = ok.filter(d => d.event.data?.outcome === 'attacker').length, last = ok[ok.length - 1];
      const left = last ? Number(last.event.data?.losses?.[target.id]?.to) : null;
      const errs = done.filter(d => d.error).map(d => d.error);
      toast(`${ok.length} attack${ok.length === 1 ? '' : 's'} on ${target.name}: ${won} succeeded` + (left === null || Number.isNaN(left) ? '' : left <= 0 ? `, ${target.name} destroyed` : `, ${target.name} at ${left}%`)
        + (last?.captureNote ? ` · ${last.captureNote}` : '') + (errs.length ? ` · ${errs.slice(0, 2).join('; ')}` : '') + ' (rolls in the log)', 8000);
    }
  }
  /** The red dashed ring: the selected unit's attack reach (the lead's, with several selected). */
  function syncFireRange() {
    const ids = (state.selectedIds || []).length > 1 ? state.selectedIds : (state.selectedId != null ? [state.selectedId] : []);
    const lead = state.markers.get(state.selectedId) || state.markers.get(ids[0]);
    if (!lead || lead.type !== 'unit' || !canEdit(lead) || !gameOn() || state.game.settings.waiveMovement || Number(lead.data?.strength ?? 100) <= 0) { renderer.hideFireRange(); return; }
    const reach = attackReachOf(lead);
    if (!(reach > 0)) { renderer.hideFireRange(); return; }
    const [rx, ry] = kmToWorld(lead.x, lead.y, reach);
    renderer.showFireRange(lead.x, lead.y, rx, ry, !attacksClosed() && !cannotFire(lead));
  }

  // ---- Railway sabotage: a unit's ⛓ Cut railway… lists the track within its reach ----------------------
  function openRailCut(attacker) {
    const why = cannotFire(attacker);
    if (why && state.role !== 'gm') { toast(why); return; }
    const reach = attackReachOf(attacker), limited = reach !== Infinity, u = state.lobby?.scaleLabel || 'km';
    const railTargets = railTargetsFor(attacker, reach);
    if (!railTargets.length) { toast(limited ? `No railways within ${attacker.name}'s reach (${fmtNum(reach)} ${u})` : 'No railways to cut'); return; }
    const wornA = wornOf(attacker);
    $('#combatIntro').textContent = `${attacker.name} (attack ${attacker.data?.attack ?? 0}${wornA ? ` −${wornA} worn` : ''}, strength ${attacker.data?.strength ?? 100}%${limited ? `, reach ${fmtNum(reach)} ${u}` : ''})`;
    $('#combatTarget').innerHTML = railTargets.map(t => `<option value="${t.rail.id}:${t.x}:${t.y}">${t.own ? 'Blow up' : 'Cut'} ${esc(shapeName(t.rail))} ${esc(t.place)}${t.holder ? ` — ${esc(t.holder)}` : ''} (${fmtNum(t.d)} ${esc(u)} away)</option>`).join('');
    const gs = state.game?.settings || {};
    const syncRule = () => {
      const own = $('#combatTarget').selectedOptions[0]?.textContent.startsWith('Blow up');
      $('#combatRule').textContent = own
        ? `Your own side's track: blown up without a roll. It closes ${fmtNum((gs.railCutKm ?? 10) * 2)} ${u} of line until repaired.`
        : `d20 + attack against d20 + the line's defence (${gs.railDefence ?? 4}) + the defend of its best guard within ${gs.railGuardKm ?? 30} ${u}. Success closes ${fmtNum((gs.railCutKm ?? 10) * 2)} ${u} of track until repaired; no one loses strength.`;
    };
    $('#combatTarget').onchange = syncRule;
    syncRule();
    $('#combatForm').onsubmit = async e => {
      e.preventDefault();
      try {
        const [sid, x, y] = $('#combatTarget').value.split(':');
        const r = await api.post(`${base}/game/rail/cut`, { unitId: attacker.id, shapeId: Number(sid), x: Number(x), y: Number(y) });
        closeModals();
        toast(r.event.message, 6000);
        if (r.shape) upsertShape(r.shape);
        if (!state.events.some(x => x.id === r.event.id)) { state.events.push(r.event); renderLog(true); }
      } catch (err) { toast(err.message); }
    };
    $('#combatModal').classList.add('open');
  }

  // ---- Log / chat / dice ------------------------------------------------------------------------------
  function renderLog(scroll) {
    const el = $('#logList');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = state.events.map(e => {
      if (e.kind === 'chat') return `<div class="ev"><span class="who">${esc(e.displayName)}</span><span class="when">${fmtTime(e.createdAt)}</span><br>${esc(e.message)}</div>`;
      if (e.kind === 'roll') return `<div class="ev roll"><span class="who">${esc(e.displayName)}</span> ${esc(e.message)}<span class="when">${fmtTime(e.createdAt)}</span></div>`;
      if (e.kind === 'combat') return `<div class="ev combat">${esc(e.message)}<span class="when">${fmtTime(e.createdAt)}</span></div>`;
      if (e.kind === 'turn') return `<div class="ev turn">📅 ${esc(e.message)}<span class="when">${fmtTime(e.createdAt)}</span></div>`;
      if (e.kind === 'announce') return `<div class="ev announce">📣 <span class="who">${esc(e.displayName)}</span> ${esc(e.message)}<span class="when">${fmtTime(e.createdAt)}</span></div>`;
      return `<div class="ev system">${esc(e.message)}<span class="when">${fmtTime(e.createdAt)}</span></div>`;
    }).join('') || '<p class="muted">Nothing has happened yet.</p>';
    if (scroll === undefined || atBottom || scroll) el.scrollTop = el.scrollHeight;
  }
  $('#chatForm').onsubmit = async e => {
    e.preventDefault();
    const input = $('#chatInput');
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    try { await api.post(`${base}/chat`, { message }); } catch (err) { toast(err.message); input.value = message; }
  };
  $('#btnRoll').onclick = async () => {
    const expr = prompt('Roll dice (e.g. 2d6+3, d20, 3d8-1):', 'd20');
    if (!expr) return;
    try { await api.post(`${base}/chat`, { message: `/roll ${expr.trim().replace(/^\/?r(oll)?\s*/i, '')}` }); } catch (err) { toast(err.message); }
  };

  // ---- History -----------------------------------------------------------------------------------------
  let historyFilter = null; // { entity, entityId } or null
  function renderHistory() {
    const el = $('#historyList');
    let list = state.history;
    let head = '';
    if (historyFilter) {
      list = list.filter(h => h.entity === historyFilter.entity && h.entityId === historyFilter.entityId);
      head = `<p class="hint">Showing one ${historyFilter.entity}. <a href="#" id="historyAll">Show everything</a></p>`;
    }
    el.innerHTML = head + (list.map(h => {
      const mine = h.userId === me.id;
      const canRevert = !h.revertedBy && (state.role === 'gm' || mine);
      const verb = h.action === 'delete' ? 'Restore' : (h.action === 'create' ? 'Remove' : 'Revert');
      return `<div class="ev history ${h.revertedBy ? 'reverted' : ''}">
        <span class="grow"><span class="who">${esc(h.displayName)}</span> ${esc(h.summary)}${h.reverts ? ' <span class="hint">(revert)</span>' : ''}<span class="when">${fmtTime(h.createdAt)}</span></span>
        ${canRevert ? `<button class="small secondary" data-revert="${h.id}" title="${verb} this change">${verb}</button>` : (h.revertedBy ? '<span class="badge">reverted</span>' : '')}
      </div>`;
    }).join('') || '<p class="muted">No changes yet.</p>');
    const all = $('#historyAll'); if (all) all.onclick = (e) => { e.preventDefault(); historyFilter = null; renderHistory(); };
    el.querySelectorAll('[data-revert]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try {
        const d = await api.post(`${base}/history/${b.dataset.revert}/revert`);
        toast(`Done: ${d.entry.summary}`);
        if (d.marker) upsertMarker(d.marker);
        if (d.shape) upsertShape(d.shape);
        await loadHistory();
      } catch (err) { toast(err.message); b.disabled = false; }
    });
  }
  function showHistoryFor(entity, entityId) {
    historyFilter = { entity, entityId };
    showPanel('history');
    renderHistory();
  }

  // ---- Settings (GM) -----------------------------------------------------------------------
  /** Settings window pages (left nav): campaign pages, then one page per group of game rules. */
  function showSetPage(page) {
    if (!$(`#setNav [data-page="${page}"]`)) page = 'general';
    state.setPage = page;
    $$('#setNav [data-page]').forEach(b => b.classList.toggle('on', b.dataset.page === page));
    $$('.setpages section[data-page]').forEach(p => { p.hidden = p.dataset.page !== page; });
    $('#rulesSave').hidden = !page.startsWith('r-');
    $('#rulesOffHint').hidden = !page.startsWith('r-') || gameOn();
  }
  $$('#setNav [data-page]').forEach(b => b.onclick = () => showSetPage(b.dataset.page));
  function openSettings(page) {
    showSetPage(typeof page === 'string' ? page : (state.setPage || 'general'));
    const l = state.lobby;
    $('#setName').value = l.name; $('#setUpp').value = l.unitsPerPx; $('#setScaleLabel').value = l.scaleLabel;
    const c = l.settings?.combat || {};
    $('#setDie').value = c.die ?? 20; $('#setBaseLoss').value = c.baseLoss ?? 10; $('#setMarginMult').value = c.marginMult ?? 2; $('#setWinnerLoss').value = c.winnerLoss ?? 5;
    $('#setTokenScale').value = l.settings?.tokenScale || 1;
    $('#setTokenMode').value = l.settings?.tokenMode || 'map';
    $('#setJoinCode').textContent = l.joinCode || '';
    const eb = l.settings?.earth?.borders;
    $('#mapInfo').textContent = l.mapKind === 'image' ? `Current map: uploaded image, ${l.mapWidth} × ${l.mapHeight} px`
      : l.mapKind === 'earth' ? `Current map: Earth (${l.settings.earth.style}, ${l.mapWidth} × ${l.mapHeight} px${eb && eb !== 'none' ? `, borders of ${eb === 'modern' ? 'today' : eb}` : ''})` : 'No map yet.';
    fillEarthYears().then(() => {
      if (l.settings?.earth) {
        const e = l.settings.earth;
        $('#earthStyle').value = e.style; $('#earthWidth').value = String(e.width);
        $('#earthRivers').checked = e.showRivers !== false; $('#earthLakes').checked = e.showLakes !== false;
        $('#earthBorders').value = e.borders || (e.showBorders ? 'modern' : 'none');
        $('#earthTint').checked = e.tint !== false; $('#earthLabels').checked = e.labels !== false;
        $('#earthGraticule').checked = !!e.showGraticule;
      }
    });
    $('#btnDeleteLobby').hidden = !(l.ownerId === me.id || me.role === 'admin');
    $('#importBordersBlock').hidden = l.mapKind !== 'earth';
    $('#settingsModal').classList.add('open');
  }
  $('#btnSettings').onclick = openSettings;
  $('#btnEmptyUpload').onclick = openSettings;
  $('#btnUnitStats').onclick = () => StatsEditor.open(state.lobby, {
    onSaved: l => { state.lobby = { ...l, joinCode: l.joinCode ?? state.lobby.joinCode, yourRole: state.role }; applyLobby(); },
  });
  $('#settingsForm').onsubmit = async e => {
    e.preventDefault();
    try {
      const d = await api.patch(base, {
        name: $('#setName').value, unitsPerPx: Number($('#setUpp').value), scaleLabel: $('#setScaleLabel').value,
        settings: {
          tokenScale: Number($('#setTokenScale').value) || 1,
          tokenMode: $('#setTokenMode').value,
          combat: { die: Number($('#setDie').value), baseLoss: Number($('#setBaseLoss').value), marginMult: Number($('#setMarginMult').value), winnerLoss: Number($('#setWinnerLoss').value) },
        },
      });
      state.lobby = d.lobby; applyLobby(); toast('Saved');
    } catch (err) { toast(err.message); }
  };
  $('#mapForm').onsubmit = async e => {
    e.preventDefault();
    const file = $('#mapFile').files[0];
    if (!file) return;
    const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const prepared = await prepareImage(file, { maxSide: 8192, maxBytes: 12 * 1024 * 1024, quality: 0.92 });
      if (prepared !== file) toast(`Image shrunk from ${Math.round(file.size / 1048576)} MB to ${Math.round(prepared.size / 1048576 * 10) / 10} MB before upload`);
      const dims = await imageDims(prepared).catch(() => null);
      const fd = new FormData(); fd.append('file', prepared, prepared.name);
      if (dims) { fd.append('width', dims.width); fd.append('height', dims.height); }
      btn.textContent = 'Uploading…';
      const d = await api.post(`${base}/map`, fd);
      state.lobby = d.lobby; applyLobby(); await applyMap(); toast('Map updated'); $('#mapFile').value = ''; openSettings();
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Upload'; }
  };
  let earthYearsLoaded = false;
  async function fillEarthYears() {
    if (earthYearsLoaded) return;
    try {
      const d = await api.get('/api/lobbies/earth/years');
      const sel = $('#earthBorders');
      for (const y of d.years) { const o = document.createElement('option'); o.value = String(y); o.textContent = `Borders of ${y}`; sel.appendChild(o); }
      earthYearsLoaded = true;
    } catch { /* leave the two default options */ }
  }
  $('#earthForm').onsubmit = async e => {
    e.preventDefault();
    if (state.lobby.mapKind === 'image' && !confirm('Replace the uploaded map image with the Earth map? Marker positions are kept as pixel coordinates, so they may no longer line up.')) return;
    const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const d = await api.post(`${base}/map/earth`, {
        style: $('#earthStyle').value, width: Number($('#earthWidth').value),
        showRivers: $('#earthRivers').checked, showLakes: $('#earthLakes').checked,
        borders: $('#earthBorders').value, tint: $('#earthTint').checked, labels: $('#earthLabels').checked,
        showGraticule: $('#earthGraticule').checked,
      });
      state.lobby = d.lobby; applyLobby(); await applyMap(); openSettings(); toast('Earth map ready');
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  };
  $('#btnRotateCode').onclick = async () => {
    if (!confirm('Generate a new join code? The old one stops working.')) return;
    try { const d = await api.post(`${base}/code`); state.lobby.joinCode = d.joinCode; applyLobby(); openSettings(); } catch (err) { toast(err.message); }
  };
  $('#btnDeleteLobby').onclick = async () => {
    if (!confirm(`Delete "${state.lobby.name}" and every marker in it? This cannot be undone.`)) return;
    try { await api.del(base); location.replace('/lobbies.html'); } catch (err) { toast(err.message); }
  };
  $('#btnLeave').onclick = async () => {
    if (!confirm('Leave this campaign?')) return;
    try { await api.del(`${base}/members/${me.id}`); location.replace('/lobbies.html'); } catch (err) { toast(err.message); }
  };

  // ---- Client-side image preparation ----------------------------------------------------------------------
  function imageDims(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
      img.onerror = () => { reject(new Error('bad image')); URL.revokeObjectURL(url); };
      img.src = url;
    });
  }

  /** Shrink an image in the browser if it is bigger than maxSide or maxBytes; returns the original otherwise. */
  async function prepareImage(file, { maxSide, maxBytes, quality = 0.9 }) {
    const dims = await imageDims(file);
    const longest = Math.max(dims.width, dims.height);
    if (longest <= maxSide && file.size <= maxBytes) return file;
    const scale = Math.min(1, maxSide / longest);
    const w = Math.max(1, Math.round(dims.width * scale)), h = Math.max(1, Math.round(dims.height * scale));
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const type = file.type === 'image/png' && file.size <= maxBytes ? 'image/png' : 'image/webp';
    const blob = await new Promise(r => canvas.toBlob(r, type, quality));
    if (!blob) return file;
    const ext = type === 'image/png' ? '.png' : '.webp';
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + ext, { type });
  }

  // ---- Toolbar / tabs / keys -----------------------------------------------------------------
  // Main menu rail (docs/UI.md): each button opens its panel over the map; the same button (or ×, or Esc) closes it.
  const PANELS = {
    nation: ['🏛', 'Nation'], production: ['🏭', 'Production'], diplomacy: ['🤝', 'Diplomacy'], markers: ['🗺', 'Map'],
    add: ['➕', 'Place tokens'], members: ['👥', 'People'], log: ['📜', 'Log'], history: ['🕘', 'History'], game: ['👑', 'Game master'],
  };
  function showPanel(tab) {
    state.panel = tab && PANELS[tab] ? tab : null;
    $('#sidebar').hidden = !state.panel;
    $('#app').classList.toggle('panel-open', !!state.panel);
    $$('#rail [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === state.panel));
    if (!state.panel) return;
    $$('#sidebar .panel').forEach(p => p.classList.toggle('active', p.dataset.panel === state.panel));
    $('#panelIcon').textContent = PANELS[state.panel][0];
    $('#panelTitle').textContent = PANELS[state.panel][1];
    if (state.panel === 'log') { const el = $('#logList'); el.scrollTop = el.scrollHeight; }
    if (state.panel === 'markers' && listsStale) renderMarkerListsNow();
  }
  /** A panel whose rail button was just hidden (game mode off, role changed) closes. */
  function syncRail() {
    if (state.panel && $(`#rail [data-tab="${state.panel}"]`)?.hidden) showPanel(null);
  }
  $$('#rail [data-tab]').forEach(b => b.onclick = () => showPanel(state.panel === b.dataset.tab ? null : b.dataset.tab));
  $('#panelClose').onclick = () => showPanel(null);
  $('#railRules').onclick = () => openSettings('r-move');
  // The nation bar opens the Nation panel; the Diplomacy panel's trade button opens the trade dialog.
  document.addEventListener('click', e => {
    if (e.target.closest('#nbRes [data-nb]')) { if (state.panel !== 'nation') showPanel('nation'); return; }
    if (e.target.closest('[data-opentrade]')) $('#notifTrade').click();
  });
  // The map fills whatever space is left: keep the renderer the size of the stage.
  new ResizeObserver(() => renderer.app.resize()).observe($('#stage'));
  $('#btnFit').onclick = () => renderer.fit();
  $('#btnZoomIn').onclick = () => renderer.zoomBy(1.3);
  $('#btnZoomOut').onclick = () => renderer.zoomBy(1 / 1.3);
  $('#btnGrid').onclick = () => { renderer.setGrid(!renderer.grid.visible); $('#btnGrid').classList.toggle('active', renderer.grid.visible); };
  $('#btnMeasure').onclick = () => renderer.setMeasure(renderer.mode !== 'measure');
  $('#btnSelect').onclick = () => renderer.setSelectMode(renderer.mode !== 'select');
  $('#btnDrawLine').onclick = () => (renderer.mode === 'draw' && renderer.draw.kind === 'line') ? renderer.cancelMode() : renderer.startDraw('line');
  $('#btnDrawArea').onclick = () => (renderer.mode === 'draw' && renderer.draw.kind === 'area') ? renderer.cancelMode() : renderer.startDraw('area');
  $('#btnDrawTrench').onclick = () => (renderer.mode === 'draw' && renderer.draw.kind === 'trench') ? renderer.cancelMode() : renderer.startDraw('trench');
  $('#btnPing').onclick = armPing;
  $('#btnDrawRail').onclick = () => (renderer.mode === 'draw' && renderer.draw.kind === 'rail') ? renderer.cancelMode() : renderer.startDraw('rail');
  $('#btnModeUndo').onclick = () => renderer.modeUndo();
  $('#btnModeClear').onclick = () => renderer.modeClear();
  $('#btnModeDone').onclick = () => { if (!renderer.finishDraw()) toast('Add more points first'); };
  $('#btnModeCancel').onclick = () => { if (renderer.mode) renderer.cancelMode(); else disarmPlacing(); };
  $('#searchInput').oninput = renderMarkerLists;

  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') {
      if ($$('.modal.open').length) { closeModals(); return; }
      if (renderer.mode) { renderer.cancelMode(); return; }
      if (state.placing) { disarmPlacing(); return; }
      if (state.selectedId == null && state.selectedShapeId == null && !(state.selectedIds || []).length && state.panel) { showPanel(null); return; }
      renderer.select(null);
      return;
    }
    // 1–9 and 0 open the main menu (only buttons the viewer has).
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9]$/.test(e.key)) {
      const b = $(`#rail [data-key="${e.key}"]`);
      if (b && !b.hidden) { b.click(); return; }
    }
    if (e.key === 'Enter' && renderer.mode === 'draw' && !typing) { e.preventDefault(); renderer.finishDraw(); return; }
    if (typing) return;
    if (e.key === 'm' || e.key === 'M') $('#btnMeasure').click();
    if (e.key === 's' || e.key === 'S') $('#btnSelect').click();
    if (e.key === 'g' || e.key === 'G') $('#btnGrid').click();
    if (e.key === 'f' || e.key === 'F') renderer.fit();
    if (e.key === 'l' || e.key === 'L') $('#btnDrawLine').click();
    if (e.key === 'a' || e.key === 'A') $('#btnDrawArea').click();
    if (e.key === 't' || e.key === 'T') $('#btnDrawTrench').click();
    if ((e.key === 'r' || e.key === 'R') && !$('#btnDrawRail').hidden) $('#btnDrawRail').click();
    if ((e.key === 'p' || e.key === 'P') && state.role === 'gm') armPing();
    if ((e.key === 'z' || e.key === 'Z') && renderer.mode) renderer.modeUndo();
    if (e.key === 'Delete') {
      if ((state.selectedIds || []).length > 1) {
        const ms = state.selectedIds.map(id => state.markers.get(id)).filter(m => m && canEdit(m));
        if (ms.length && confirm(`Delete ${ms.length} selected tokens? (They can be restored from History.)`)) {
          (async () => { for (const m of ms) { try { await api.del(`${base}/markers/${m.id}`); removeMarker(m.id); } catch (err) { toast(err.message); } } })();
        }
      } else if (state.selectedId != null) {
        const m = state.markers.get(state.selectedId);
        if (m && canEdit(m)) deleteMarker(m).catch(err => toast(err.message));
      } else if (state.selectedShapeId != null) {
        const s = state.shapes.get(state.selectedShapeId);
        if (s && canEditShape(s)) shapeAction('del', s);
      }
    }
  });

  // ---- Go ---------------------------------------------------------------------------------------
  try {
    await loadLobby();
    await loadFactions();
    GameUI.init({ state, renderer, base, $, $$, flagImg, openPanel, loadMarkers, corpsHtml, loadTerritories, loadProvinces, removeBorderDrawings, armBrush, armFactory, notify, renderReady, onRail: syncRail, onLayout: () => renderer.app.resize(), isGm: () => state.role === 'gm' });
    await GameUI.load().catch(err => console.warn('game state', err));
    syncRailButton();
    await loadTerritories();
    loadProvinces();
    await loadMarkers();
    await loadShapes();
    loadVision();
    await loadEvents();
    await loadHistory();
    syncTrails();
    loadCorps();
    loadReachBonus();
    if (isEarth() && window.Reach) Reach.loadMask(`${base}/landmask`).then(() => { reachChanged(); });
    await Comms.init({ state, me, base, renderer, notify, GameUI });
    loadPings();
    loadBattles();
    connectWs();
    if (state.viewAs) toast(`Viewing as ${state.viewAs.name}: you see what its player sees and have only their powers. 👁 to switch back.`, 6000);
  } catch (err) {
    if (err.status === 403 || err.status === 404) { alert(err.message); location.replace('/lobbies.html'); }
    else toast(err.message);
  }
})();
