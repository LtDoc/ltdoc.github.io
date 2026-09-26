'use strict';
/* global GameData, UnitTypes, api, esc, toast */

/**
 * Game-layer UI for the map page: the turn HUD, the player's Nation tab, the GM's Game tab (turn control,
 * faction table, rules) and the treasury editor modal. map.js hands it the shared state and helpers via
 * init() and forwards the `game` / `faction` WebSocket messages.
 */
const GameUI = (() => {
  let ctx = null;   // { state, renderer, base, $, $$, flagImg, loadMarkers, isGm }
  const g = () => ctx.state.game;
  const fmt = n => (Math.round(Number(n) * 10) / 10).toLocaleString();
  const signed = n => (n > 0 ? '+' : '') + fmt(n);

  function init(c) {
    ctx = c;
    const { $ } = ctx;
    $('#nationFaction').onchange = () => { renderNation(); loadProduction(); };
    $('#btnGameToggle').onclick = toggleGame;
    $('#btnEndTurn').onclick = endTurn;
    $('#btnUndoTurn').onclick = undoTurn;
    $('#btnEditTreasuries').onclick = openTreasuryEditor;
    $('#turnForm').onsubmit = saveTurn;
    $('#rulesForm').onsubmit = saveRules;
    $('#relationForm').onsubmit = setRelation;
    $('#btnTerrSeed').onclick = seedTerritories;
    $('#btnTerrAssign').onclick = assignDrawing;
    $('#btnTerrBrush').onclick = () => {
      const sel = $('#terrBrushFaction');
      ctx.armBrush(Number(sel.value) || 0, Number($('#terrBrushKm').value) || 60, sel.options[sel.selectedIndex]?.textContent || 'neutral');
    };
    $('#btnTerrClear').onclick = clearTerritories;
    $('#btnCosts').onclick = () => CostEditor.open(ctx.state.lobby, { settings: g().settings, onSaved: game => { ctx.state.game = game; refresh(); loadProduction(); } });
    $('#btnSeedCities').onclick = seedCities;
    $('#btnGenResources').onclick = generateResources;
    $('#buildFilter').oninput = renderBuildList;
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-build]');
      if (b) { queueBuild(b.dataset.build, Number(b.dataset.site)); return; }
      const c = e.target.closest('[data-cancelbuild]');
      if (c) { cancelBuild(Number(c.dataset.cancelbuild)); return; }
      const o = e.target.closest('[data-openbuild]');
      if (o) { openBuildPicker(Number(o.dataset.openbuild)); return; }
      const f = e.target.closest('[data-buildfactory]');
      if (f) { ctx.armFactory(); }
    });
    // Diplomacy buttons live inside re-rendered panels: delegate.
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-diplo]');
      if (!b) return;
      const [action, id] = b.dataset.diplo.split(':');
      if (action === 'propose') proposeDiplomacy(b.dataset.kind, Number(b.dataset.to), b.dataset.from ? Number(b.dataset.from) : undefined);
      else diplomacyAct(Number(id), action);
    });
    fetch('/api/lobbies/earth/years').then(r => r.json()).then(d => {
      $('#terrYear').innerHTML = (d.years || []).map(y => `<option value="${y}" ${y === 1914 ? 'selected' : ''}>${y}</option>`).join('');
    }).catch(() => {});
  }

  async function load() {
    const d = await api.get(`${ctx.base}/game`);
    ctx.state.game = d.game; ctx.state.gameFactions = d.factions; ctx.state.myFactionId = d.myFactionId; ctx.state.canUndo = d.canUndo;
    ctx.state.relations = d.relations || []; ctx.state.diplomacy = d.diplomacy || []; ctx.state.hasTerritories = !!d.hasTerritories;
    refresh();
    loadProduction();
  }
  function onRelations(msg) {
    ctx.state.relations = msg.relations || []; ctx.state.diplomacy = msg.diplomacy || [];
    renderNation(); renderGameTab();
  }
  function onTerritories() { ctx.state.hasTerritories = ctx.renderer.territoryViews.size > 0; renderGameTab(); }

  // ---- Relations helpers ------------------------------------------------------------------
  function relStatus(a, b) {
    if (a === b) return 'self';
    const [x, y] = a < b ? [a, b] : [b, a];
    return (ctx.state.relations || []).find(r => r.a === x && r.b === y)?.status || 'peace';
  }
  const relBadge = s => `<span class="rel ${s}">${s === 'war' ? 'war' : s === 'alliance' ? 'allied' : 'peace'}</span>`;
  const factionName = id => (ctx.state.gameFactions || []).find(x => x.faction.id === id)?.faction.name || (id === 0 ? 'neutral' : `#${id}`);
  const openBetween = (a, b) => (ctx.state.diplomacy || []).find(d => ['pending', 'offered'].includes(d.status) && ((d.from === a && d.to === b) || (d.from === b && d.to === a)));
  const KIND_LABEL = { war: 'declaration of war', peace: 'peace offer', alliance: 'alliance proposal' };

  /** Diplomacy block for the Nation tab: every other faction with its status and the actions this viewer may take. */
  function diplomacyHtml(e) {
    const me = e.faction.id;
    const actor = ctx.isGm() || ctx.state.myFactionId === me;
    const others = (ctx.state.gameFactions || []).filter(x => x.faction.id !== me);
    if (!others.length) return '';
    const from = ctx.isGm() ? ` data-from="${me}"` : '';
    const rows = others.map(x => {
      const st = relStatus(me, x.faction.id), open = openBetween(me, x.faction.id);
      let act = '';
      if (actor && !open) {
        if (st !== 'war') act += `<button class="small danger" data-diplo="propose" data-kind="war" data-to="${x.faction.id}"${from} title="Declare war (queued for the GM to approve)">War</button>`;
        if (st === 'war') act += `<button class="small secondary" data-diplo="propose" data-kind="peace" data-to="${x.faction.id}"${from} title="Offer peace">Peace</button>`;
        if (st === 'peace') act += `<button class="small secondary" data-diplo="propose" data-kind="alliance" data-to="${x.faction.id}"${from} title="Propose an alliance">Ally</button>`;
      } else if (open) act = `<span class="hint">${open.status === 'pending' ? 'awaiting the GM' : 'awaiting an answer'}</span>`;
      return `<div class="diplo"><span class="grow">${ctx.flagImg(x.faction.name)} ${esc(x.faction.name)}</span>${relBadge(st)}${act}</div>`;
    }).join('');
    const mine = (ctx.state.diplomacy || []).filter(d => ['pending', 'offered'].includes(d.status) && (d.from === me || d.to === me));
    const items = mine.map(d => {
      const incoming = d.to === me;
      let act = '';
      if (incoming && d.status === 'offered' && actor) act = `<button class="small" data-diplo="accept:${d.id}">Accept</button><button class="small secondary" data-diplo="decline:${d.id}">Decline</button>`;
      else if (!incoming && actor) act = `<button class="small secondary" data-diplo="withdraw:${d.id}">Withdraw</button>`;
      const text = incoming ? `${esc(factionName(d.from))}: ${KIND_LABEL[d.kind]}${d.status === 'pending' ? ' (with the GM)' : ''}` : `To ${esc(factionName(d.to))}: ${KIND_LABEL[d.kind]}, ${d.status === 'pending' ? 'awaiting the GM' : 'awaiting their answer'}`;
      return `<div class="diplo"><span class="grow">${text}</span>${act}</div>`;
    }).join('');
    return `<div class="section">Diplomacy</div>${rows}${items ? `<div class="section">Open proposals</div>${items}` : ''}`;
  }

  async function proposeDiplomacy(kind, to, from) {
    const label = { war: `Queue a declaration of war on ${factionName(to)}? The GM decides whether it goes through.`, peace: `Offer peace to ${factionName(to)}? The GM reviews it, then they answer.`, alliance: `Propose an alliance to ${factionName(to)}? The GM reviews it, then they answer.` }[kind];
    if (!confirm(label)) return;
    try { await api.post(`${ctx.base}/game/diplomacy`, { kind, toFactionId: to, fromFactionId: from }); toast('Sent to the GM'); }
    catch (err) { toast(err.message); }
  }
  async function diplomacyAct(id, action) {
    try { await api.post(`${ctx.base}/game/diplomacy/${id}/${action}`, {}); }
    catch (err) { toast(err.message); }
  }
  async function setRelation(e) {
    e.preventDefault();
    const { $ } = ctx;
    try { await api.patch(`${ctx.base}/game/relations`, { a: Number($('#relA').value), b: Number($('#relB').value), status: $('#relStatus').value }); }
    catch (err) { toast(err.message); }
  }

  // ---- Territory tools (GM) ------------------------------------------------------------------
  async function seedTerritories() {
    const { $ } = ctx;
    const year = Number($('#terrYear').value);
    if (!year) { toast('No historical borders bundled'); return; }
    if (ctx.state.hasTerritories && !confirm(`Replace every territory with the borders of ${year}?`)) return;
    try {
      const d = await api.post(`${ctx.base}/game/territory/seed-earth`, { year });
      toast(`${d.assigned.length} states assigned, ${d.unassigned.length} neutral${d.flipped ? `, ${d.flipped} places changed hands` : ''}`, 4000);
      await ctx.loadTerritories();
    } catch (err) { toast(err.message); }
  }
  async function assignDrawing() {
    const { $, state } = ctx;
    if (state.selectedShapeId == null) { toast('Select an area drawing on the map first'); return; }
    try {
      const d = await api.post(`${ctx.base}/game/territory/assign`, { shapeId: state.selectedShapeId, factionId: Number($('#terrAssignFaction').value) || 0 });
      toast(d.flipped ? `Assigned; ${d.flipped} places changed hands` : 'Assigned');
    } catch (err) { toast(err.message); }
  }
  async function clearTerritories() {
    if (!confirm('Remove every territory? Ownership of places stays as it is until you assign new borders.')) return;
    try { await api.post(`${ctx.base}/game/territory/clear`, {}); await ctx.loadTerritories(); }
    catch (err) { toast(err.message); }
  }
  function onGame(game) {
    const was = ctx.state.game;
    ctx.state.game = game;
    if (!was || was.turn !== game.turn || was.enabled !== game.enabled) load().catch(() => refresh());
    else refresh();
  }
  function onFaction(msg) {
    const list = ctx.state.gameFactions || [];
    const i = list.findIndex(x => x.faction.id === msg.faction.id);
    const entry = { ...(i >= 0 ? list[i] : {}), faction: msg.faction, state: msg.state, income: msg.income, visible: true };
    if (i >= 0) list[i] = entry; else list.push(entry);
    ctx.state.gameFactions = list;
    renderNation(); renderGameTab();
    const e = myEntry();
    if (e && e.faction.id === msg.faction.id) loadProduction();
  }

  // ---- Production (Nation tab) --------------------------------------------------------------
  let prod = null;   // last production view for the faction shown on the Nation tab
  async function loadProduction() {
    const e = g() && g().enabled ? myEntry() : null;
    if (!e || !e.visible) { prod = null; renderNation(); return; }
    try {
      prod = await api.get(`${ctx.base}/game/production?factionId=${e.faction.id}`);
      if (prod.factionId !== e.faction.id) prod = null;
    } catch { prod = null; }
    renderNation();
  }
  function productionHtml(e) {
    if (!prod || prod.factionId !== e.faction.id) return `<div class="section">Production</div><p class="hint">Loading…</p>`;
    const actor = ctx.isGm() || ctx.state.myFactionId === e.faction.id;
    const sites = prod.sites.map(s => {
      const q = s.queue.map(item => {
        const t = UnitTypes.LIST.find(x => x.id === item.typeId);
        return `<div class="diplo"><span class="grow">${esc(t ? t.unit : item.typeId)} <span class="hint">${item.turnsLeft} turn${item.turnsLeft === 1 ? '' : 's'} left</span></span>${actor ? `<button class="small secondary" data-cancelbuild="${item.id}" title="Cancel and refund">×</button>` : ''}</div>`;
      }).join('');
      const free = s.capacity - s.queue.length;
      return `<div class="site"><div class="diplo"><span class="grow"><b>${esc(s.name)}</b> <span class="hint">${s.kind}${s.kind === 'factory' ? ` level ${s.industry}` : ''} · ${s.queue.length}/${s.capacity} building${s.coastal ? ' · port' : ''}</span></span>${actor && free > 0 ? `<button class="small" data-openbuild="${s.id}">Build…</button>` : ''}</div>${q}</div>`;
    }).join('');
    const factories = prod.factoryBuilds.map(item => `<div class="diplo"><span class="grow">Factory near ${esc(item.siteName || '')} <span class="hint">${item.turnsLeft} turn${item.turnsLeft === 1 ? '' : 's'} left</span></span>${actor ? `<button class="small secondary" data-cancelbuild="${item.id}" title="Cancel and refund">×</button>` : ''}</div>`).join('');
    const fc = prod.costs.factory;
    return `<div class="section">Production</div>
      ${sites.length ? sites : '<p class="hint">No cities or factories. Production needs a city, a capital or a factory in your colours.</p>'}
      ${factories}
      ${actor ? `<p><button class="small secondary" data-buildfactory="1" title="${esc(GameData.costLabel(fc))}">Build a factory…</button> <span class="hint">within ${g().settings.factoryRangeKm} ${ctx.state.lobby?.scaleLabel || 'km'} of your city or town</span></p>` : ''}`;
  }
  let buildSiteId = null;
  function openBuildPicker(siteId) {
    const { $ } = ctx;
    if (!prod) return;
    const site = prod.sites.find(s => s.id === siteId);
    if (!site) return;
    buildSiteId = siteId;
    $('#buildSite').textContent = site.name;
    $('#buildHint').textContent = `${site.kind}${site.kind === 'factory' ? ` level ${site.industry}` : ''} · ${site.capacity - site.queue.length} slot${site.capacity - site.queue.length === 1 ? '' : 's'} free${site.coastal ? ' · coastal (ships allowed)' : ' · inland (no ships)'}${site.industry < 2 ? ' · no aircraft below industry 2' : ''}`;
    $('#buildFilter').value = '';
    renderBuildList();
    $('#buildModal').classList.add('open');
  }
  function renderBuildList() {
    const { $ } = ctx;
    if (!prod) return;
    const site = prod.sites.find(s => s.id === buildSiteId);
    const q = $('#buildFilter').value.trim().toLowerCase();
    const st = prod.state;
    let html = '';
    for (const cat of UnitTypes.categories) {
      const types = UnitTypes.LIST.filter(t => t.cat === cat && (!q || t.unit.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || cat.toLowerCase().includes(q)));
      if (!types.length) continue;
      html += `<div class="section">${esc(cat)}</div>`;
      for (const t of types) {
        const cost = prod.costs[t.id];
        const short = [];
        for (const k of GameData.RESOURCE_KEYS) if ((st.resources[k] || 0) < cost[k]) short.push(GameData.byKey[k].name.toLowerCase());
        if (st.money < cost.money) short.push('money');
        if (st.manpower < cost.manpower) short.push('manpower');
        let blocked = short.length ? `short of ${short.join(', ')}` : '';
        if (!blocked && t.cat === 'Naval' && site && !site.coastal) blocked = 'needs a coastal city';
        if (!blocked && t.cat === 'Air' && site && site.industry < 2) blocked = 'needs industry 2';
        html += `<div class="diplo"><span class="grow"><b>${esc(t.unit)}</b><br><span class="hint">${esc(GameData.costLabel(cost))}</span>${blocked ? `<br><span class="hint" style="color:#ff9f80">${esc(blocked)}</span>` : ''}</span><button class="small" data-build="${t.id}" data-site="${buildSiteId}" ${blocked ? 'disabled' : ''}>Build</button></div>`;
      }
    }
    $('#buildList').innerHTML = html || '<p class="hint">No unit types match.</p>';
  }
  async function queueBuild(typeId, siteId) {
    const e = myEntry();
    try {
      prod = await api.post(`${ctx.base}/game/production`, { typeId, siteId, factionId: e ? e.faction.id : undefined });
      toast('Queued'); renderNation(); renderBuildList();
    } catch (err) { toast(err.message); }
  }
  async function cancelBuild(id) {
    const e = myEntry();
    try { prod = await api.del(`${ctx.base}/game/production/${id}?factionId=${e ? e.faction.id : ''}`); renderNation(); toast('Cancelled and refunded'); }
    catch (err) { toast(err.message); }
  }
  /** map.js calls this with the map point the player clicked while placing a factory. */
  async function buildFactoryAt(x, y) {
    const e = myEntry();
    try {
      prod = await api.post(`${ctx.base}/game/production`, { typeId: 'factory', x, y, factionId: e ? e.faction.id : undefined });
      renderNation(); toast(`Factory started (${prod.costs.factory.turns} turns)`); return true;
    } catch (err) { toast(err.message); return false; }
  }

  // ---- Earth datasets (GM) ----------------------------------------------------------------------
  async function seedCities() {
    if (!confirm('Add the major cities of 1914 as towns? Cities already on the map (by name) are skipped.')) return;
    try { const d = await api.post(`${ctx.base}/game/cities/seed`, {}); toast(`${d.created} cities added${d.skipped ? `, ${d.skipped} already there` : ''}`, 4000); await ctx.loadMarkers(); }
    catch (err) { toast(err.message); }
  }
  async function generateResources() {
    const fill = Number(ctx.$('#genFill').value) || 0;
    if (!confirm(`Place the historical resource regions${fill ? ` plus ${fill} random small deposits` : ''}? Regions already on the map (by name) are skipped.`)) return;
    try { const d = await api.post(`${ctx.base}/game/resources/generate`, { dataset: true, fill }); toast(`${d.created} regions${d.filled ? ` and ${d.filled} deposits` : ''} placed`, 4000); await ctx.loadMarkers(); }
    catch (err) { toast(err.message); }
  }

  /** Everything that depends on the game row: rules for the renderer, tab visibility, HUD, both panels. */
  function refresh() {
    const { $, state, renderer } = ctx;
    const game = g();
    renderer.setGameRules(game ? { enabled: game.enabled, kmPerMove: game.settings.kmPerMove } : null);
    const on = !!(game && game.enabled);
    $('#sidebar .tabs [data-tab="nation"]').hidden = !on;
    $('#sidebar .tabs [data-tab="game"]').hidden = !ctx.isGm();
    $('#turnLabel').hidden = !on;
    if (on) {
      $('#turnLabel').textContent = `Turn ${game.turn} · ${GameData.fmtDate(game.date)}${game.deadline ? ' · ' + game.deadline : ''}`;
      $('#turnLabel').title = `${GameData.TURN_STEPS[game.turnStep] || game.turnStep}ly turns. Movement: ${game.settings.kmPerMove} ${state.lobby?.scaleLabel || 'km'} per movement point.`;
    }
    renderNation(); renderGameTab();
  }

  // ---- Nation tab -----------------------------------------------------------------------
  function myEntry() {
    const { state, $ } = ctx;
    const list = state.gameFactions || [];
    const sel = $('#nationFaction');
    if (ctx.isGm()) {
      const cur = sel.value;
      sel.innerHTML = list.map(x => `<option value="${x.faction.id}">${esc(x.faction.name)}</option>`).join('');
      sel.hidden = list.length === 0;
      if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
      return list.find(x => String(x.faction.id) === sel.value) || list[0] || null;
    }
    sel.hidden = true;
    return list.find(x => x.faction.id === state.myFactionId) || null;
  }

  function renderNation() {
    const { $, state } = ctx;
    const el = $('#nationPanel');
    const game = g();
    if (!game || !game.enabled) { el.innerHTML = '<p class="hint">Game mode is off.</p>'; return; }
    const e = myEntry();
    if (!e) {
      el.innerHTML = `<p class="hint">${ctx.isGm() ? 'No factions yet. Create factions on the Members tab (or seed them from 1914).' : 'You are not assigned to a faction yet. Ask the GM to set your faction on the Members tab.'}</p>`;
      return;
    }
    if (!e.visible || !e.state) { el.innerHTML = `<h3>${ctx.flagImg(e.faction.name)} ${esc(e.faction.name)}</h3><p class="hint">This faction's treasury is private.</p>`; return; }
    const s = e.state, inc = e.income || { resources: {}, upkeep: {}, money: 0, rp: 0, manpower: 0, notes: [] };
    const rows = GameData.RESOURCES.map(r => {
      const delta = (inc.resources[r.key] || 0) - (inc.upkeep[r.key] || 0);
      const ic = r.icon ? `<img class="resicon" src="/icons/${r.icon}" alt="">` : `<span class="reskey" style="background:${r.color}"></span>`;
      return `<tr><td>${ic}${r.name}</td><td class="num">${fmt(s.resources[r.key] || 0)}</td><td class="num ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${delta ? signed(delta) : ''}</td></tr>`;
    }).join('');
    const units = [...state.markers.values()].filter(m => m.type === 'unit' && String(m.data?.nation || '').toLowerCase() === e.faction.name.toLowerCase());
    const cats = {};
    for (const u of units) {
      const t = window.UnitTypes ? UnitTypes.resolve(u.data?.unitType) : null;
      const cat = t ? t.cat : 'Other';
      cats[cat] = cats[cat] || { n: 0, moved: 0, spent: 0 };
      cats[cat].n++;
      if (Number(u.data?.movedKm) > 0) cats[cat].moved++;
      if (Number(u.data?.apUsed) > 0) cats[cat].spent++;
    }
    const lastTurn = [...state.events].reverse().find(ev => ev.kind === 'turn' && String(ev.data?.faction || '').toLowerCase() === e.faction.name.toLowerCase());
    el.innerHTML = `
      <h3 class="nationhead">${ctx.flagImg(e.faction.name)} ${esc(e.faction.name)} <span class="hint">turn ${game.turn} · ${GameData.fmtDate(game.date)}</span></h3>
      <div class="pools">
        <div><span class="hint"><img class="resicon" src="/icons/cash.png" alt="">Money</span><b>${fmt(s.money)}</b><span class="delta ${inc.money >= 0 ? 'up' : 'down'}">${signed(inc.money)}</span></div>
        <div><span class="hint">Manpower</span><b>${fmt(s.manpower)}</b><span class="delta up">${signed(inc.manpower)}</span></div>
        <div><span class="hint"><img class="resicon" src="/icons/paper_roll.png" alt="">Research</span><b>${fmt(s.rp)}</b><span class="delta up">${signed(inc.rp)}</span></div>
      </div>
      <div class="section">Stockpiles <span class="hint">(change per turn)</span></div>
      <table class="treasury"><tbody>${rows}</tbody></table>
      ${inc.notes && inc.notes.length ? `<details class="sub"><summary>Where it comes from</summary><ul class="hintlist">${inc.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
      <div class="section">Forces <span class="hint">(${units.length})</span></div>
      ${Object.keys(cats).length ? `<table class="treasury"><tbody>${Object.entries(cats).map(([c, v]) => `<tr><td>${esc(c)}</td><td class="num">${v.n}</td><td class="hint">${v.moved ? `${v.moved} moved` : ''}${v.spent ? `${v.moved ? ', ' : ''}${v.spent} attacked` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">No units on the map.</p>'}
      ${productionHtml(e)}
      ${diplomacyHtml(e)}
      ${lastTurn ? `<div class="section">Last turn</div><p class="hint">${esc(lastTurn.message)}</p>` : ''}`;
  }

  // ---- Game tab (GM) ----------------------------------------------------------------------
  function renderGameTab() {
    const { $, state } = ctx;
    if (!ctx.isGm()) return;
    const game = g() || { enabled: false, turn: 1, date: '1914-07-28', turnStep: 'week', deadline: '', settings: GameData.DEFAULT_SETTINGS };
    const on = !!game.enabled;
    $('#btnGameToggle').textContent = on ? 'Switch game mode off' : 'Switch game mode on';
    $('#btnGameToggle').className = on ? 'small secondary' : 'small';
    $('#gameStartWrap').hidden = on;
    $('#gameOnBlock').hidden = !on;
    $('#gameOffHint').hidden = on;
    if (on) {
      $('#turnInfo').textContent = `Turn ${game.turn} · ${GameData.fmtDate(game.date)}`;
      if (document.activeElement !== $('#turnStep')) $('#turnStep').value = game.turnStep;
      if (document.activeElement !== $('#turnDeadline')) $('#turnDeadline').value = game.deadline || '';
      if (document.activeElement !== $('#turnDate')) $('#turnDate').value = game.date;
      if (document.activeElement !== $('#turnNumber')) $('#turnNumber').value = game.turn;
      $('#btnUndoTurn').disabled = !state.canUndo;
      const list = state.gameFactions || [];
      $('#factionTable').innerHTML = list.length ? `<table class="treasury"><thead><tr><th>Faction</th><th class="num">Money</th><th class="num">RP</th><th class="num">Units</th></tr></thead><tbody>${
        list.map(x => `<tr><td>${ctx.flagImg(x.faction.name)} ${esc(x.faction.name)}</td><td class="num">${x.state ? fmt(x.state.money) : '·'}</td><td class="num">${x.state ? fmt(x.state.rp) : '·'}</td><td class="num">${x.unitCount}</td></tr>`).join('')
      }</tbody></table>` : '<p class="hint">No factions yet.</p>';
      // Diplomacy queue and relation setter.
      const pending = (state.diplomacy || []).filter(d => d.status === 'pending');
      $('#diploQueue').innerHTML = pending.length ? pending.map(d => `<div class="diplo"><span class="grow">${esc(factionName(d.from))} → ${esc(factionName(d.to))}: ${KIND_LABEL[d.kind]}${d.note ? ` <span class="hint">${esc(d.note)}</span>` : ''}</span><button class="small" data-diplo="approve:${d.id}">Approve</button><button class="small secondary" data-diplo="block:${d.id}">Block</button></div>`).join('')
        : '<p class="hint">No proposals waiting for you. Players queue declarations and offers from their Nation tab.</p>';
      const opts = list.map(x => `<option value="${x.faction.id}">${esc(x.faction.name)}</option>`).join('');
      for (const id of ['#relA', '#relB', '#terrAssignFaction', '#terrBrushFaction']) {
        const sel = $(id), cur = sel.value;
        sel.innerHTML = (id === '#terrAssignFaction' || id === '#terrBrushFaction' ? '<option value="0">neutral</option>' : '') + opts;
        if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
      }
      if ($('#relB').options.length > 1 && $('#relA').value === $('#relB').value) $('#relB').selectedIndex = 1;
      const rels = (state.relations || []).filter(r => r.status !== 'peace');
      $('#relationList').innerHTML = rels.length ? rels.map(r => `${esc(factionName(r.a))} ${relBadge(r.status)} ${esc(factionName(r.b))}`).join(' · ') : 'Everyone is at peace.';
      $('#territoryEarthRow').hidden = state.lobby?.mapKind !== 'earth';
    }
    // Rules form (only overwrite fields the GM is not typing in).
    const s = game.settings;
    const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; } };
    set('#ruleKmPerMove', s.kmPerMove); set('#ruleWaive', s.waiveMovement); set('#ruleUpkeep', s.upkeep);
    set('#ruleUpkeepGrain', s.upkeepGrain); set('#ruleUpkeepOil', s.upkeepOil);
    set('#ruleBaseMoney', s.baseMoney); set('#ruleBaseRp', s.baseRp); set('#ruleBaseManpower', s.baseManpower);
    set('#rulePublic', s.publicTreasury);
    set('#ruleTrenchRange', s.trenchRangeKm); set('#ruleTrenchDug', s.trenchBonusDug); set('#ruleTrenchReinforced', s.trenchBonusReinforced);
    set('#ruleCapCapital', s.cityCapacity.capital); set('#ruleCapCity', s.cityCapacity.city); set('#ruleCapVillage', s.cityCapacity.village);
    set('#ruleFactoryRange', s.factoryRangeKm); set('#ruleCoastal', s.coastalKm);
    $('#earthSeedRow').hidden = state.lobby?.mapKind !== 'earth';
    for (const size of ['capital', 'city', 'village']) for (const k of ['money', 'rp', 'manpower']) set(`#rule_${size}_${k}`, s.cityIncome[size][k]);
    set('#ruleFactoryMoney', s.factoryIncome.money); set('#ruleFactoryRp', s.factoryIncome.rp);
    set('#ruleStartRes', s.startStock.resources); set('#ruleStartMoney', s.startStock.money); set('#ruleStartMp', s.startStock.manpower);
  }

  async function toggleGame() {
    const { $ } = ctx;
    const game = g();
    const on = !(game && game.enabled);
    if (on && !confirm('Switch game mode on? Every faction gets its starting stockpiles and turns begin.')) return;
    if (!on && !confirm('Switch game mode off? Treasuries are kept and turns pause; nothing is deleted.')) return;
    try {
      const d = await api.post(`${ctx.base}/game/enable`, { enabled: on, startDate: $('#gameStartDate').value || undefined, resetTurn: on && $('#gameResetTurn').checked });
      ctx.state.game = d.game;
      await load();
      toast(on ? 'Game mode on' : 'Game mode off');
    } catch (err) { toast(err.message); }
  }
  async function endTurn() {
    const game = g();
    if (!confirm(`End turn ${game.turn}? Income is paid, movement and action points reset, and the date advances one ${game.turnStep}.`)) return;
    try {
      const d = await api.post(`${ctx.base}/game/end-turn`, {});
      ctx.state.game = d.game;
      await load();
      await ctx.loadMarkers();
      toast(`Turn ${d.game.turn} begins: ${GameData.fmtDate(d.game.date)}`);
    } catch (err) { toast(err.message); }
  }
  async function undoTurn() {
    if (!confirm('Undo the last turn? Treasuries and the calendar go back; units stay where they are.')) return;
    try { const d = await api.post(`${ctx.base}/game/undo-turn`, {}); ctx.state.game = d.game; await load(); toast('Turn undone'); }
    catch (err) { toast(err.message); }
  }
  async function saveTurn(e) {
    e.preventDefault();
    const { $ } = ctx;
    try {
      const d = await api.patch(`${ctx.base}/game`, { turnStep: $('#turnStep').value, deadline: $('#turnDeadline').value, date: $('#turnDate').value, turn: Number($('#turnNumber').value) });
      ctx.state.game = d.game; refresh(); toast('Saved');
    } catch (err) { toast(err.message); }
  }
  async function saveRules(e) {
    e.preventDefault();
    const { $ } = ctx;
    const v = id => Number($(id).value);
    const settings = {
      kmPerMove: v('#ruleKmPerMove'), waiveMovement: $('#ruleWaive').checked, upkeep: $('#ruleUpkeep').checked,
      upkeepGrain: v('#ruleUpkeepGrain'), upkeepOil: v('#ruleUpkeepOil'),
      baseMoney: v('#ruleBaseMoney'), baseRp: v('#ruleBaseRp'), baseManpower: v('#ruleBaseManpower'), publicTreasury: $('#rulePublic').checked,
      trenchRangeKm: v('#ruleTrenchRange'), trenchBonusDug: v('#ruleTrenchDug'), trenchBonusReinforced: v('#ruleTrenchReinforced'),
      cityCapacity: { capital: v('#ruleCapCapital'), city: v('#ruleCapCity'), village: v('#ruleCapVillage') },
      factoryRangeKm: v('#ruleFactoryRange'), coastalKm: v('#ruleCoastal'),
      cityIncome: {}, factoryIncome: { money: v('#ruleFactoryMoney'), rp: v('#ruleFactoryRp') },
      startStock: { resources: v('#ruleStartRes'), money: v('#ruleStartMoney'), manpower: v('#ruleStartMp') },
    };
    for (const size of ['capital', 'city', 'village']) settings.cityIncome[size] = { money: v(`#rule_${size}_money`), rp: v(`#rule_${size}_rp`), manpower: v(`#rule_${size}_manpower`) };
    try { const d = await api.patch(`${ctx.base}/game`, { settings }); ctx.state.game = d.game; await load(); toast('Rules saved'); }
    catch (err) { toast(err.message); }
  }

  // ---- Treasury editor (GM): +/- table of every faction's stockpiles or per-turn modifiers --------
  let modal = null, mode = 'stock', values = null;
  const COLS = [['money', 'Money'], ['manpower', 'Manpower'], ['rp', 'RP'], ...GameData.RESOURCES.map(r => [r.key, r.name])];
  function ensureModal() {
    if (modal) return;
    modal = document.createElement('div');
    modal.id = 'treasuryModal'; modal.className = 'modal';
    modal.innerHTML = `<div class="card wide">
      <button class="close" data-close>×</button>
      <h2>Treasuries</h2>
      <div class="row" style="gap:6px"><button type="button" class="small" data-mode="stock">Stockpiles</button><button type="button" class="small secondary" data-mode="mods">Per-turn modifiers</button>
        <span class="hint" id="treasuryHint"></span></div>
      <div class="statswrap"><table class="stats"><thead><tr><th class="name">Faction</th>${COLS.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody id="treasuryBody"></tbody></table></div>
      <div class="row" style="margin-top:10px"><button type="button" id="treasurySave">Save</button><button type="button" class="secondary" data-close>Cancel</button></div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-close]').forEach(b => b.onclick = () => modal.classList.remove('open'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
    modal.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { mode = b.dataset.mode; renderModal(); });
    modal.querySelector('#treasurySave').onclick = saveTreasuries;
    modal.querySelector('#treasuryBody').addEventListener('click', e => {
      const btn = e.target.closest('button[data-d]');
      if (!btn) return;
      const tr = btn.closest('tr'), key = btn.dataset.key, step = e.shiftKey ? 10 : 1;
      const cur = values[mode][tr.dataset.id][key] || 0;
      values[mode][tr.dataset.id][key] = Math.round((cur + Number(btn.dataset.d) * step) * 10) / 10;
      tr.querySelector(`input[data-key="${key}"]`).value = values[mode][tr.dataset.id][key];
    });
    modal.querySelector('#treasuryBody').addEventListener('input', e => {
      const inp = e.target.closest('input[data-key]');
      if (!inp) return;
      const n = Number(inp.value);
      if (Number.isFinite(n)) values[mode][inp.closest('tr').dataset.id][inp.dataset.key] = n;
    });
  }
  function openTreasuryEditor() {
    ensureModal();
    values = { stock: {}, mods: {} };
    for (const x of ctx.state.gameFactions || []) {
      if (!x.state) continue;
      values.stock[x.faction.id] = { money: x.state.money, manpower: x.state.manpower, rp: x.state.rp, ...x.state.resources };
      const m = x.state.mods || {};
      values.mods[x.faction.id] = { money: m.money || 0, manpower: m.manpower || 0, rp: m.rp || 0, ...GameData.emptyish(), ...(m.resources || {}) };
    }
    mode = 'stock';
    renderModal();
    modal.classList.add('open');
  }
  function renderModal() {
    modal.querySelectorAll('[data-mode]').forEach(b => b.className = 'small' + (b.dataset.mode === mode ? '' : ' secondary'));
    modal.querySelector('#treasuryHint').textContent = mode === 'stock' ? 'What each faction has now. Shift-click steps by 10.' : 'Added to (or taken from) each faction every turn, on top of nodes and cities.';
    const body = modal.querySelector('#treasuryBody');
    body.innerHTML = (ctx.state.gameFactions || []).filter(x => x.state).map(x => `<tr data-id="${x.faction.id}"><td class="name">${esc(x.faction.name)}</td>${
      COLS.map(([k]) => `<td><span class="pm"><button type="button" data-key="${k}" data-d="-1">−</button><input type="number" step="any" data-key="${k}" value="${values[mode][x.faction.id][k] || 0}"><button type="button" data-key="${k}" data-d="1">+</button></span></td>`).join('')
    }</tr>`).join('');
  }
  async function saveTreasuries() {
    const btn = modal.querySelector('#treasurySave'); btn.disabled = true;
    try {
      for (const x of ctx.state.gameFactions || []) {
        if (!x.state) continue;
        const st = values.stock[x.faction.id], md = values.mods[x.faction.id];
        const body = { money: st.money, manpower: st.manpower, rp: st.rp, resources: {}, mods: { money: md.money, manpower: md.manpower, rp: md.rp, resources: {} } };
        for (const k of GameData.RESOURCE_KEYS) { body.resources[k] = st[k] || 0; body.mods.resources[k] = md[k] || 0; }
        await api.patch(`${ctx.base}/game/factions/${x.faction.id}`, body);
      }
      modal.classList.remove('open');
      await load();
      toast('Treasuries saved');
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  }

  return { init, load, refresh, onGame, onFaction, onRelations, onTerritories, renderNation, loadProduction, buildFactoryAt };
})();

// Small helper so the modifiers table starts with every resource present.
GameData.emptyish = () => Object.fromEntries(GameData.RESOURCE_KEYS.map(k => [k, 0]));

window.GameUI = GameUI;
