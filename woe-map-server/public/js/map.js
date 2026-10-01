'use strict';
/* global MapRenderer, api, requireUser, esc, toast, fmtTime, fmtNum */

(async function main() {
  const lobbyId = Number(location.pathname.match(/\/map\/(\d+)/)?.[1] || new URLSearchParams(location.search).get('lobby'));
  if (!lobbyId) { location.replace('/lobbies.html'); return; }
  const me = await requireUser();
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const base = `/api/lobbies/${lobbyId}`;

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
  renderer.canEditShape = s => canEditShape(s) && !s.locked;
  renderer.unitsToPx = (x, y, units) => units / (distanceUnits(x, y, x + 1, y) || 1);   // km (or map units) → px, locally
  Object.defineProperty(renderer, 'railCutKm', { get: () => Number(state.game?.settings?.railCutKm) || 10 });

  function canEdit(m) { return state.role === 'gm' || (m.ownerId === me.id && !m.adminOnly); }
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
    let text = m.type === 'town' ? `level ${lv.level} / ${lv.max}` : '';
    if (m.type === 'town' && lv.level) {
      const d = state.game?.settings?.townDevIncome || {};
      text += ` (+${lv.level * (d.money || 0)} money, +${lv.level * (d.rp || 0)} RP a turn)`;
    }
    if (info?.active) text += `${text ? ' · ' : ''}${m.type === 'factory' ? 'upgrading' : 'developing'} to ${info.active.toLevel}: ${info.active.turnsLeft} turn${info.active.turnsLeft === 1 ? '' : 's'} left`;
    return text ? stat(m.type === 'factory' ? 'Project' : 'Development', text) : '';
  }
  function developButton(m) {
    if (!mySite(m)) return '';
    const lv = GameData.projectLevel(m);
    if (lv.level >= lv.max) return '';
    const info = window.GameUI?.projectInfo(m.id);
    if (info?.active) return '';
    const cost = info?.cost || GameData.projectCost(lv.id, lv.step);
    return `<button class="small" data-act="develop" title="Level ${lv.level + 1}: ${esc(GameData.costLabel(cost))}">${lv.id === 'upgradeFactory' ? '⬆ Upgrade' : '🏗 Develop'}</button>`;
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
  /** Cut off from supply (decided at End turn): cannot move or attack, double losses when beaten. */
  function cutOff(m) { return !!m && m.type === 'unit' && supplyOn() && m.data?.supplied === false; }
  const ENGINEER_IDS = ['engineers', 'pioneers', 'sappers'];
  /** What a support unit does for those around it, with its reach in km (null for other units). */
  function supportRole(m) {
    const s = state.game?.settings || {}, id = window.UnitTypes?.resolve(m.data?.unitType)?.id, u = state.lobby?.scaleLabel || 'km';
    if (id === 'supply') {
      const lb = s.supplyLinkBySize || {};
      return { km: Number(s.supplyRangeKm ?? 100), text: `supplies friendly land units within ${s.supplyRangeKm ?? 100} ${u} when linked: within ${lb.capital ?? 600} ${u} of a friendly capital, ${lb.city ?? 400} ${u} of a city, ${lb.village ?? 200} ${u} of a village, or ${s.supplyLinkKm ?? 150} ${u} of a railhead or another linked column` };
    }
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
    const land = !t || ['Infantry', 'Mounted & mobile', 'Artillery', 'Support'].includes(t.cat);
    if (supplyOn() && land) {
      rows += stat('Supply', m.data?.supplied === false ? 'OUT OF SUPPLY: cannot move or attack; double losses when beaten' : (m.data?.supplied === true ? 'supplied' : 'not yet worked out (End turn decides)'));
    }
    const role = supportRole(m);
    if (role && gameOn()) rows += stat('Support', role.text + (m.data?.supplied === false ? ' (not while cut off)' : ''));
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
  function clickMoves(m) {
    return !!m && rulesOn() && MOVERS.includes(m.type) && canEdit(m) && !m.locked && !(m.type === 'hero' && ['travelling', 'captured'].includes(m.data?.status));
  }
  renderer.dragAllowed = m => !(rulesOn() && MOVERS.includes(m.type)) || state.role === 'gm';
  function remainingFor(m) {
    if (cutOff(m)) return 0;
    const km = Number(state.game?.settings?.kmPerMove) || 50;
    return Math.max(0, (Number(m.data?.movement) || 0) * km - (Number(m.data?.movedKm) || 0));
  }
  /** The selected tokens that move by click: { lead, list, remaining } (remaining = the slowest one's), or null. */
  function movers() {
    const ids = (state.selectedIds || []).length > 1 ? state.selectedIds : (state.selectedId != null ? [state.selectedId] : []);
    const list = ids.map(id => state.markers.get(id)).filter(clickMoves);
    if (!list.length) return null;
    const lead = list.find(m => m.id === state.selectedId) || list[0];
    return { lead, list, remaining: Math.min(...list.map(remainingFor)) };
  }
  let reachSegs = [];
  function updateMoveRange() {
    const ms = movers();
    reachSegs = [];
    if (!ms) { renderer.hideRange(); return; }
    const { lead, list, remaining } = ms;
    const rx = remaining / (distanceUnits(lead.x, lead.y, lead.x + 1, lead.y) || 1);
    const ry = remaining / (distanceUnits(lead.x, lead.y, lead.x, lead.y + 1) || 1);
    renderer.showRange(lead.x, lead.y, rx, remaining <= 0.01, ry);
    if (remaining > 0.01 && list.every(canRide)) reachSegs = showRailReach(lead, remaining) || [];
    else renderer.hideRailReach();
  }
  function insideReach(ms, x, y) {
    if (ms.remaining <= 0.01) return false;
    if (distanceUnits(ms.lead.x, ms.lead.y, x, y) <= ms.remaining + 1e-6) return true;
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
    if (ms.remaining <= 0.01) { toast(`${ms.list.length > 1 ? 'The slowest of them' : ms.lead.name} has no movement left this turn`); return; }
    if (!insideReach(ms, x, y)) { toast(`Out of reach: ${ms.list.length > 1 ? 'the group' : ms.lead.name} can still go ${fmtNum(ms.remaining)} ${state.lobby?.scaleLabel || 'km'} this turn (inside the green ring or along the green track)`); return; }
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
    try { const d = await api.get(`${base}/battles`); renderer.setBattles(d.battles); renderer.setCraters(d.craters || []); } catch { /* none */ }
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
      toast(rulesOn() ? 'Right-click the map to move it there · right-click a unit for its panel' : 'Right-click a unit to open its panel', 3200);
    }
    renderPopup(); highlightList();
    updateMoveRange();
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
    const remaining = Math.min(...units.map(m => Math.max(0, (Number(m.data?.movement) || 0) * km - (Number(m.data?.movedKm) || 0))));
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
  renderer.addEventListener('frame', positionPopup);
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
      $('#joinCodeBlock').innerHTML = `<div class="section">Join code</div><p><span class="code">${esc(l.joinCode)}</span> <button class="small secondary" id="btnCopyCode">Copy</button></p><p class="hint">Players enter this on the campaigns page.</p>`;
      $('#btnCopyCode').onclick = () => navigator.clipboard.writeText(l.joinCode).then(() => toast('Join code copied'));
    }
    $('#shapeGmFields').hidden = !gm;
    renderer.setTokenScale(l.settings?.tokenScale || 1);
    renderer.setTokenMode(l.settings?.tokenMode || 'map');
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
  }

  async function loadFactions() {
    const d = await api.get(`${base}/factions`);
    state.factions = d.factions;
    renderFactions();
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
    const isNew = !state.markers.has(m.id);
    m.flagUrl = flagFor(m);
    state.markers.set(m.id, m);
    renderer.upsert(m);
    if (isNew && !quiet) renderer.pulse(m.x, m.y, colorNum(m.color));
    renderMarkerLists();
    if (state.selectedId === m.id) renderPopup();
    if (state.selectedId === m.id || (state.selectedIds || []).includes(m.id)) updateMoveRange();
    gameMarkerChanged(m.type);
  }

  function removeMarker(id) {
    const type = state.markers.get(id)?.type;
    state.markers.delete(id);
    renderer.remove(id);
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
    state.shapes.set(s.id, s);
    renderer.upsertShape(s);
    renderMarkerLists();
    if (state.selectedShapeId === s.id) renderPopup();
  }

  function removeShape(id) {
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
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'join', lobbyId })); };
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
            const { attackerId, defenderId, outcome, losses } = e.data;
            const gone = id => !!(losses && losses[id] && losses[id].to === 0 && losses[id].from > 0);
            renderer.hit(defenderId, outcome !== 'defender', gone(defenderId));
            renderer.hit(attackerId, outcome === 'defender', gone(attackerId));
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
        case 'game': { const was = !!state.game?.enabled; GameUI.onGame(msg.game); syncRailButton(); syncTrails(); updateMoveRange(); if (was !== !!msg.game?.enabled) Comms.loadTrades(); else Comms.refresh(); break; }
        case 'turn': GameUI.onTurn(msg); loadBattles(); break;
        case 'faction': GameUI.onFaction(msg); break;
        case 'territory': renderer.setTerritories(msg.territories, !!msg.replace); GameUI.onTerritories(); break;
        case 'provinces': await loadProvinces(); break;
        case 'provinceOwners': renderer.setProvinceOwners(msg.owners || [], !!msg.replace); GameUI.onTerritories(); break;
        case 'progress': GameUI.onProgress(msg); break;
        case 'relations': GameUI.onRelations(msg); Comms.onRelations(); break;
        case 'tradesChanged': Comms.onTradesChanged(msg); break;
        case 'chatChannel': Comms.onChatChannel(msg.channel); break;
        case 'chatMessage': Comms.onChatMessage(msg.message); break;
        case 'ping': showPing(msg.ping); break;
        case 'battle': renderer.addBattle(msg.battle); break;
        case 'craters': renderer.addCraters(msg.craters); break;
        case 'reload': if (msg.what === 'markers') await loadMarkers(); break;
        case 'lobby': {
          state.lobby = { ...msg.lobby, joinCode: msg.lobby.joinCode ?? state.lobby?.joinCode, yourRole: state.role };
          applyLobby(); await applyMap();
          if ($('#settingsModal').classList.contains('open')) openSettings();
          break;
        }
        case 'role': state.role = msg.role; await loadLobby(); await loadMarkers(); await loadShapes(); await loadHistory(); GameUI.load().catch(() => {}); toast(`You are now a ${msg.role === 'gm' ? 'game master' : 'player'}${msg.nation ? ` of ${msg.nation}` : ''}`); break;
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
    const body = { name: $('#facName').value, color: $('#facColor').value };
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

  let listFrame = 0;
  function renderMarkerLists() {
    if (listFrame) return;
    listFrame = requestAnimationFrame(() => { listFrame = 0; renderMarkerListsNow(); });
  }
  function renderMarkerListsNow() {
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
  renderer.addEventListener('markercontext', e => openPanel(e.detail.id));
  function renderPopup() {
    const el = $('#popup');
    const m = state.selectedId != null ? state.markers.get(state.selectedId) : null;
    const s = state.selectedShapeId != null ? state.shapes.get(state.selectedShapeId) : null;
    syncAura(m);
    if (!m && !s) { el.style.display = 'none'; return; }
    if (m && PANEL_ON_RIGHT.includes(m.type) && state.panelFor !== m.id) { el.style.display = 'none'; return; }
    el.innerHTML = m ? popupHtml(m) : shapePopupHtml(s);
    el.style.display = 'block';
    el.querySelectorAll('[data-act]').forEach(b => b.onclick = () => (m ? popupAction(b.dataset.act, m) : shapeAction(b.dataset.act, s, b)));
    positionPopup();
  }

  function positionPopup() {
    const el = $('#popup');
    if (el.style.display !== 'block') return;
    const p = state.selectedId != null ? renderer.markerScreenPos(state.selectedId) : renderer.shapeScreenPos(state.selectedShapeId);
    if (!p) return;
    const stage = $('#stage');
    const W = stage.clientWidth, H = stage.clientHeight, w = el.offsetWidth, h = el.offsetHeight;
    let x = p.x + 22, y = p.y - 24;
    if (x + w > W - 8) x = p.x - w - 22;
    if (x < 8) x = 8;
    if (y + h > H - 8) y = H - 8 - h;
    if (y < 8) y = 8;
    el.style.left = x + 'px'; el.style.top = y + 'px';
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
  function syncAura(m) {
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
        body += stat('This turn', `${fmtNum(Math.max(0, allow - used))} of ${fmtNum(allow)} ${state.lobby?.scaleLabel || 'km'} left · ${Math.max(0, (Number(d.ap) || 0) - (Number(d.apUsed) || 0))}/${Number(d.ap) || 0} AP`);
      }
      const cover = trenchCoverFor(m);
      if (cover) body += stat('Cover', `+${cover.bonus} defend (${esc(cover.trench.label || 'trench')})`);
      const gen = generalFor(m);
      if (gen) body += stat('General', `+${gen.bonus} attack and defend (${gen.hero.name})`);
      body += unitDoctrineRows(m);
      if (d.abilities?.length) body += `<div class="stat"><span class="muted">Abilities</span></div><ul style="margin:2px 0 4px 16px;padding:0;font-size:12px">${d.abilities.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`;
    } else if (m.type === 'town') {
      body += stat('Size', d.size) + nationStat(d.nation);
      if (gameOn()) body += developmentStat(m);
    } else if (m.type === 'resource') {
      const r = window.GameData?.byKey[d.kind];
      body += stat('Resource', r ? r.name : d.kind) + stat('Yield per turn', d.yield) + nationStat(d.nation);
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
    if (m.type === 'unit' && canEdit(m) && (d.strength ?? 100) > 0) actions += `<button class="small danger" data-act="attack">⚔ Attack…</button>`;
    actions += developButton(m);
    if (m.type === 'hero') actions += heroActionsHtml(m);
    actions += `<button class="small secondary" data-act="history">History</button>`;
    if (state.role === 'gm') actions += `<button class="small secondary" data-act="dup">Duplicate</button>`;
    if (canEdit(m)) actions += `<button class="small danger" data-act="del">Delete</button>`;
    return `<h3><span class="dot" style="background:${esc(m.color)}"></span>${esc(m.name)} <span class="badge">${TYPE_LABEL[m.type] || m.type}</span>${visBadge(m)}</h3>${body}<div class="actions">${actions}</div>`;
  }

  function shapePopupHtml(s) {
    const creator = s.createdBy && state.members.find(x => x.userId === s.createdBy);
    let body = stat('Kind', s.kind === 'area' ? 'Area' : s.kind === 'trench' ? 'Trench' : s.kind === 'rail' ? 'Railway' : 'Line') + (s.kind === 'rail' ? '' : stat('Points', s.points.length));
    if (s.kind === 'rail') body += railPopupRows(s);
    if (s.kind === 'trench') {
      body += stat('State', { plan: 'planned', dug: 'dug', reinforced: 'reinforced' }[s.data?.state] || 'dug') + stat('Width', `${s.width} ${state.lobby?.scaleLabel || ''}`) + nationStat(s.data?.nation);
      const g = state.game?.settings, st = s.data?.state || 'dug';
      const bonus = st === 'plan' ? 0 : (st === 'reinforced' ? (g?.trenchBonusReinforced ?? 4) : (g?.trenchBonusDug ?? 2));
      if (bonus) body += stat('Cover', `+${bonus} defend for ${esc(s.data?.nation || 'any')} units within ${g?.trenchRangeKm ?? 20} ${state.lobby?.scaleLabel || 'km'}`);
    }
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
    if (canEditShape(s) && !s.locked && s.kind !== 'area') actions += `<button class="small secondary" data-act="continue" title="Keep adding points at the end">${s.kind === 'trench' || s.kind === 'rail' ? 'Extend' : 'Continue'}</button>`;
    if (canEditShape(s)) actions += `<button class="small secondary" data-act="move" title="Drag the whole drawing to a new place">Move</button>`;
    actions += `<button class="small secondary" data-act="history">History</button>`;
    if (canEditShape(s)) actions += `<button class="small danger" data-act="del">Delete</button>`;
    const hint = canEditShape(s) && !s.locked ? `<p class="hint" style="margin:6px 0 0">Drag a point to move it · grab the line to add a point · right-click (or Alt-click) a point to remove it · Move button or Shift-drag to move everything</p>`
      : (s.locked ? '<p class="hint" style="margin:6px 0 0">Locked: clicks on the map pass through it. Unlock to edit.</p>' : '');
    return `<h3><span class="dot" style="background:${esc(s.kind === 'rail' ? '#8d8a86' : s.color)}"></span>${esc(shapeName(s))} <span class="badge">${s.kind === 'rail' ? 'Railway' : 'Drawing'}</span>${visBadge(s)}</h3>${body}${hint}<div class="actions">${actions}</div>`;
  }

  async function popupAction(act, m) {
    try {
      if (act === 'center') renderer.centerOn(m.x, m.y);
      else if (act === 'edit') openEdit(m);
      else if (act === 'lock') { const d = await api.patch(`${base}/markers/${m.id}`, { locked: !m.locked }); upsertMarker(d.marker); }
      else if (act === 'attack') openCombat(m);
      else if (['recon', 'steal', 'hunt', 'send', 'recall', 'expel'].includes(act)) await heroOrder(act, m);
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
      </div><div class="grid2"><label>Owner faction<select id="${p}ResNationSel">${nationOptions()}</select></label></div>
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
    if (type === 'resource') Object.assign(data, { kind: v('Kind'), yield: v('Yield') === '' ? 1 : v('Yield'), nation: readNation(p, 'ResNation') });
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
    $('#trenchZigWrap').hidden = !trench || !!shape;                 // traverses are applied when the trench is first dug
    if (trench) {
      $('#trenchState').value = shape ? (shape.data?.state || 'dug') : 'dug';
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

  // ---- Combat -------------------------------------------------------------------------------------------
  function openCombat(attacker) {
    if (cutOff(attacker) && state.role !== 'gm') { toast(`${attacker.name} is out of supply and cannot attack`); return; }
    const typeA = window.UnitTypes?.resolve(attacker.data?.unitType);
    const matchText = m => {
      if (!window.Matchups) return '';
      const r = Matchups.matchup(typeA, window.UnitTypes?.resolve(m.data?.unitType), { entrenched: !!trenchCoverFor(m) });
      return r.notes.length ? ` · ${r.mod > 0 ? '+' : ''}${r.mod} (${r.notes.map(n => n.text).join('; ')})` : '';
    };
    // Only the other side's units: never the attacker's own nation, and never an ally while the game is on.
    const mine = String(attacker.data?.nation || '').toLowerCase();
    const myFaction = mine ? (state.factions || []).find(f => f.name.toLowerCase() === mine) : null;
    const allied = m => {
      if (!gameOn() || !myFaction) return false;
      const f = (state.factions || []).find(x => x.name.toLowerCase() === String(m.data?.nation || '').toLowerCase());
      if (!f || f.id === myFaction.id) return false;
      const [a, b] = f.id < myFaction.id ? [f.id, myFaction.id] : [myFaction.id, f.id];
      return (state.relations || []).some(r => r.a === a && r.b === b && r.status === 'alliance');
    };
    // Game mode: only targets within the unit's reach (range points × km per range point).
    const limited = gameOn() && !state.game.settings.waiveMovement;
    const reach = limited ? (Number(attacker.data?.range) || 0) * (Number(state.game.settings.kmPerRange) || 50) : Infinity;
    const unitLabel = state.lobby?.scaleLabel || 'km';
    const targets = [...state.markers.values()]
      .filter(m => m.type === 'unit' && m.id !== attacker.id && !(mine && String(m.data?.nation || '').toLowerCase() === mine) && !allied(m))
      .map(m => ({ m, d: distanceUnits(attacker.x, attacker.y, m.x, m.y) })).filter(t => t.d <= reach + 1e-6).sort((a, b) => a.d - b.d);
    const railTargets = railTargetsFor(attacker, reach);
    if (!targets.length && !railTargets.length) { toast(limited ? `No enemy units or railways within ${attacker.name}'s reach (${fmtNum(reach)} ${unitLabel})` : 'No enemy units to attack'); return; }
    $('#combatIntro').textContent = `${attacker.name} (attack ${attacker.data?.attack ?? 0}, strength ${attacker.data?.strength ?? 100}%${limited ? `, reach ${fmtNum(reach)} ${unitLabel}` : ''})`;
    const unitOpts = targets.map(({ m, d }) =>
      `<option value="${m.id}">${esc(m.name)} — ${esc(m.data?.nation || 'Unaligned')}, defend ${m.data?.defend ?? 0}, strength ${m.data?.strength ?? 100}%${cutOff(m) ? ', out of supply' : ''} (${fmtNum(d)} ${esc(state.lobby?.scaleLabel || '')} away)${esc(matchText(m))}</option>`).join('');
    const railOpts = railTargets.map(t => `<option value="rail:${t.rail.id}:${t.x}:${t.y}">${t.own ? 'Blow up' : 'Cut'} ${esc(shapeName(t.rail))} ${esc(t.place)}${t.holder ? ` — ${esc(t.holder)}` : ''} (${fmtNum(t.d)} ${esc(state.lobby?.scaleLabel || '')} away)</option>`).join('');
    $('#combatTarget').innerHTML = (unitOpts && railOpts) ? `<optgroup label="Units">${unitOpts}</optgroup><optgroup label="Railways">${railOpts}</optgroup>` : (unitOpts || railOpts);
    const c = state.lobby?.settings?.combat || { die: 20, baseLoss: 10, marginMult: 2, winnerLoss: 5 };
    const unitRule = `Each side rolls d${c.die} and adds attack or defend. Loser loses ${c.baseLoss}% + ${c.marginMult}% per point of margin; winner loses ${c.winnerLoss}%.`;
    const gs = state.game?.settings || {}, u = state.lobby?.scaleLabel || 'km';
    const railRule = own => own
      ? `Your own side's track: blown up without a roll. It closes ${fmtNum((gs.railCutKm ?? 10) * 2)} ${u} of line until repaired.`
      : `d20 + attack against d20 + the line's defence (${gs.railDefence ?? 4}) + the defend of its best guard within ${gs.railGuardKm ?? 30} ${u}. Success closes ${fmtNum((gs.railCutKm ?? 10) * 2)} ${u} of track until repaired; no one loses strength.`;
    const syncRule = () => {
      const v = $('#combatTarget').value;
      $('#combatRule').textContent = v.startsWith('rail:') ? railRule($('#combatTarget').selectedOptions[0]?.textContent.startsWith('Blow up')) : unitRule;
    };
    $('#combatTarget').onchange = syncRule;
    syncRule();
    $('#combatForm').onsubmit = async e => {
      e.preventDefault();
      try {
        const val = $('#combatTarget').value;
        if (val.startsWith('rail:')) {
          const [, sid, x, y] = val.split(':');
          const r = await api.post(`${base}/game/rail/cut`, { unitId: attacker.id, shapeId: Number(sid), x: Number(x), y: Number(y) });
          closeModals();
          toast(r.event.message, 6000);
          if (r.shape) upsertShape(r.shape);
          if (!state.events.some(x => x.id === r.event.id)) { state.events.push(r.event); renderLog(true); }
          return;
        }
        const d = await api.post(`${base}/combat`, { attackerId: attacker.id, defenderId: Number(val) });
        closeModals();
        toast(d.event.message, 6000);
        if (!state.events.some(x => x.id === d.event.id)) { state.events.push(d.event); renderLog(true); }
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
    $$('#sidebar .tabs button').find(b => b.dataset.tab === 'history').click();
    $('#app').classList.remove('nosidebar');
    renderHistory();
  }

  // ---- Settings (GM) -----------------------------------------------------------------------
  function openSettings() {
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
  $$('#sidebar .tabs button').forEach(b => b.onclick = () => {
    $$('#sidebar .tabs button').forEach(x => x.classList.toggle('active', x === b));
    $$('#sidebar .panel').forEach(p => p.classList.toggle('active', p.dataset.panel === b.dataset.tab));
    if (b.dataset.tab === 'log') { const el = $('#logList'); el.scrollTop = el.scrollHeight; }
  });
  $('#btnSidebar').onclick = () => { $('#app').classList.toggle('nosidebar'); setTimeout(() => renderer.app.resize(), 50); };
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
  if (window.innerWidth < 800) $('#app').classList.add('nosidebar');

  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') {
      if ($$('.modal.open').length) { closeModals(); return; }
      if (renderer.mode) { renderer.cancelMode(); return; }
      if (state.placing) { disarmPlacing(); return; }
      renderer.select(null);
      return;
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
    GameUI.init({ state, renderer, base, $, $$, flagImg, openPanel, loadMarkers, loadTerritories, loadProvinces, removeBorderDrawings, armBrush, armFactory, notify, isGm: () => state.role === 'gm' });
    await GameUI.load().catch(err => console.warn('game state', err));
    syncRailButton();
    await loadTerritories();
    loadProvinces();
    await loadMarkers();
    await loadShapes();
    await loadEvents();
    await loadHistory();
    syncTrails();
    await Comms.init({ state, me, base, renderer, notify, GameUI });
    loadPings();
    loadBattles();
    connectWs();
  } catch (err) {
    if (err.status === 403 || err.status === 404) { alert(err.message); location.replace('/lobbies.html'); }
    else toast(err.message);
  }
})();
