'use strict';
/* global GameData, UnitTypes, api, esc, toast */

/**
 * Research UI: the Nation tab's research section (bank, active project, queue) and the tech tree modal
 * (every tech by branch with its status and a Research button; GM sees Unlock/Lock per faction and can
 * edit the tree). GameUI hands it the shared context and the faction currently shown on the Nation tab.
 */
const ResearchUI = (() => {
  let ctx = null, view = null, factionId = null, editing = null;
  const $ = s => document.querySelector(s);
  const fmt = n => Math.round(Number(n) * 10) / 10;

  function init(c) {
    ctx = c;
    $('#techFilter').oninput = renderTree;
    $('#techHideDone').onchange = renderTree;
    $('#btnTechReset').onclick = resetTree;
    $('#btnTechEdit').onclick = () => openEditor(null);
    $('#techEditForm').onsubmit = saveTech;
    $('#btnTechDelete').onclick = deleteTech;
    $('#techHint').addEventListener('click', e => { if (e.target.closest('[data-techjump]')) jumpToAvailable(); });
    $('#techTree').addEventListener('mouseover', e => showTechTooltip(e.target.closest('.tech-node')));
    $('#techTree').addEventListener('focusin', e => showTechTooltip(e.target.closest('.tech-node')));
    $('#techTree').addEventListener('mouseout', e => {
      if (!e.relatedTarget?.closest?.('.tech-node') || e.relatedTarget.closest('.tech-node') !== e.target.closest('.tech-node')) hideTechTooltip();
    });
    $('#techTree').addEventListener('focusout', e => {
      if (!e.relatedTarget?.closest?.('.tech-node') || e.relatedTarget.closest('.tech-node') !== e.target.closest('.tech-node')) hideTechTooltip();
    });
    $('#techTree').addEventListener('scroll', e => {
      hideTechTooltip();
      if (e.target.classList.contains('tech-tree-scroll')) $('#techTree .tech-branch-rail').scrollTop = e.target.scrollTop;
    }, true);
    window.addEventListener('resize', () => { drawTechLinks(); hideTechTooltip(); });
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-research]');
      if (b) { startResearch(b.dataset.research); return; }
      const d = e.target.closest('[data-dropresearch]');
      if (d) { dropResearch(d.dataset.dropresearch); return; }
      const u = e.target.closest('[data-techunlock]');
      if (u) { setUnlocked(u.dataset.techunlock, u.dataset.on === '1'); return; }
      const ed = e.target.closest('[data-techedit]');
      if (ed) { openEditor(ed.dataset.techedit); return; }
      const o = e.target.closest('[data-opentree]');
      if (o) openTree();
    });
  }

  /** Fetch the tree for a faction (or the bare tree when none). */
  async function load(fid) {
    factionId = fid || null;
    try { view = await api.get(`${ctx.base}/game/techs${fid ? `?factionId=${fid}` : ''}`); }
    catch { view = null; }
    ctx.renderNation();
    if ($('#techModal').classList.contains('open')) renderTree();
  }

  /** Research block for the Nation tab. */
  function sectionHtml(e) {
    if (!view || view.factionId !== e.faction.id) return `<div class="section">Research</div><p class="hint">Loading…</p>`;
    const r = view.research || { active: null, queue: [], progress: {} };
    const byKey = new Map(view.techs.map(t => [t.key, t]));
    const active = r.active ? byKey.get(r.active) : null;
    const done = view.techs.filter(t => t.unlocked).length;
    const actor = ctx.isGm() || ctx.state.myFactionId === e.faction.id;
    let html = `<div class="section">Research <span class="hint">(${done}/${view.techs.length} known · ${fmt(view.rp)} RP banked)</span></div>`;
    if (active) {
      const pct = Math.min(100, Math.round((active.progress / Math.max(1, active.rp)) * 100));
      html += `<div><b>${esc(active.name)}</b> <span class="hint">${fmt(active.progress)}/${active.rp} RP</span><div class="progress"><i style="width:${pct}%"></i></div></div>`;
    } else html += `<p class="hint">No active project${actor ? ': open the tree to pick one' : ''}.</p>`;
    if (r.queue.length) html += `<div class="hint">Next: ${r.queue.map(k => esc(byKey.get(k)?.name || k)).join(' → ')}</div>`;
    html += `<p><button class="small secondary" data-opentree="1">Open tech tree</button></p>`;
    return html;
  }

  function openTree() {
    if (!view) return;
    const e = ctx.currentFaction();
    $('#techFaction').textContent = e ? e.faction.name : 'tree';
    $('#techGmTools').hidden = !ctx.isGm();
    $('#techModal').classList.add('open');
    renderTree();
    requestAnimationFrame(jumpToAvailable);
  }
  /** Scroll the tree to the active tech, else the first one available, else the current year. */
  function jumpToAvailable() {
    const node = $('#techTree .tech-node.active') || $('#techTree .tech-node:not(.done):not(.locked):not(.queued)') || $('#techTree .tech-year.current');
    const sc = $('#techTree .tech-tree-scroll');
    if (!node || !sc) return;
    const r = node.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    sc.scrollLeft += r.left - sr.left - 40;
    node.scrollIntoView({ block: 'nearest' });
    if (node.classList.contains('tech-node')) { node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 1600); }
  }
  function effectText(ef) {
    const unitName = id => UnitTypes.LIST.find(t => t.id === id)?.unit || id;
    switch (ef.type) {
      case 'unlockUnit': return `unlocks ${unitName(ef.unit)}`;
      case 'stat': { const who = ef.unit ? unitName(ef.unit) : ef.cat || 'all units'; const parts = ['attack', 'defend', 'movement', 'range', 'ap'].filter(k => ef[k]).map(k => `${k} ${ef[k] > 0 ? '+' : ''}${ef[k]}`); return `${who}: ${parts.join(', ')}`; }
      case 'cost': return `${ef.unit ? unitName(ef.unit) : ef.cat || 'everything'} ${ef.resource ? ef.resource + ' ' : ''}cost ×${ef.factor}`;
      case 'buildTime': return `${ef.unit ? unitName(ef.unit) : ef.cat || 'all'} build time ${ef.delta > 0 ? '+' : ''}${ef.delta}`;
      case 'income': return `${ef.key} income ${ef.factor && ef.factor !== 1 ? '×' + ef.factor : ''}${ef.add ? (ef.add > 0 ? ' +' : ' ') + ef.add : ''}`.trim();
      case 'removeCost': return `${ef.resource} no longer needed`;
      case 'cover': return `trench cover +${ef.add}`;
      case 'capacity': return `+${ef.add} builds per site`;
      case 'recover': return `damaged units recover ${ef.add}%/turn`;
      case 'vision': return `${ef.unit ? unitName(ef.unit) : ef.cat || 'all units'} see ${ef.km > 0 ? '+' : ''}${ef.km} km further (fog of war)`;
      case 'flag': return ef.name;
      default: return ef.type;
    }
  }
  const iconByUnit = {
    horseartillery: 'horse.png', heavyartillery: 'steel.png', siegeartillery: 'steel.png',
    railwaygun: 'machine_parts.png', antiaircraft: 'machine_parts.png', aaemplacement: 'machine_parts.png',
    coastal: 'naval_supplies.png', mountain: 'stone.png', marines: 'naval_supplies.png',
    bicycle: 'machine_parts.png', tank: 'steel.png', submarine: 'naval_supplies.png',
    mortar: 'artillery_shells.png', machinegun: 'ammo_boxes.png', mgbunker: 'concrete_bricks.png'
  };
  const iconByBranch = {
    Infantry: 'ammo_boxes.png', Artillery: 'artillery_shells.png', Aviation: 'fuel.png',
    Naval: 'naval_supplies.png', Chemical: 'sulphuric_acid_flask.png', Doctrine: 'paper_roll.png',
    Economy: 'cash.png', 'Industry & logistics': 'machine_parts.png', 'Armour & motor': 'electric_motor.png'
  };
  function techIcon(t) {
    const unit = t.effects.find(e => e.type === 'unlockUnit')?.unit;
    if (unit && iconByUnit[unit]) return iconByUnit[unit];
    const name = `${t.key} ${t.name}`.toLowerCase();
    const matches = [
      [/rail|train/, 'machine_parts.png'], [/horse|cavalry/, 'horse.png'], [/concrete|bunker|fort/, 'concrete_bricks.png'],
      [/steel|armour|armor|helmet/, 'steel.png'], [/fuel|oil|petrol/, 'fuel.png'], [/electr/, 'electric_motor.png'],
      [/gas|chemical|phosgene|chlorine/, 'sulphuric_acid_flask.png'], [/shell|artillery|barrage|gun|mortar/, 'artillery_shells.png'],
      [/ship|naval|submarine|torpedo|sea/, 'naval_supplies.png'], [/air|flight|aviat|plane/, 'fuel.png'],
      [/factory|machine|industry/, 'machine_parts.png'], [/supply|logistic/, 'barrel.png'],
      [/medical|hospital|recover/, 'cloth_bolts.png'], [/money|bank|saving|trade|econom/, 'cash.png']
    ];
    return matches.find(([re]) => re.test(name))?.[1] || iconByBranch[t.branch] || 'paper_roll.png';
  }
  function hideTechTooltip() { $('#techTooltip').hidden = true; }
  function showTechTooltip(node) {
    if (!node || !view) return;
    const t = view.techs.find(item => item.key === node.dataset.key);
    if (!t) return;
    const names = new Map(view.techs.map(item => [item.key, item.name]));
    const bonuses = t.effects.length ? `<ul>${t.effects.map(e => `<li>${esc(effectText(e))}</li>`).join('')}</ul>` : '<p>No direct bonus.</p>';
    const tooltip = $('#techTooltip');
    tooltip.innerHTML = `<strong>${esc(t.name)}</strong>${t.desc ? `<p>${esc(t.desc)}</p>` : ''}<div class="tech-tooltip-heading">Unlock bonuses</div>${bonuses}${t.prereqs.length ? `<div class="tech-tooltip-needs">Requires ${t.prereqs.map(key => esc(names.get(key) || key)).join(', ')}</div>` : ''}${t.blocker && !t.unlocked ? `<div class="tech-tooltip-needs">${esc(t.blocker)}</div>` : ''}`;
    tooltip.hidden = false;
    const rect = node.getBoundingClientRect();
    const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
    tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
    tooltip.style.top = `${rect.bottom + height + 12 <= window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - height - 8)}px`;
  }
  function drawTechLinks() {
    const board = $('#techTree .tech-timeline'), svg = $('#techTree .tech-links');
    if (!board || !svg) return;
    const cards = new Map([...board.querySelectorAll('.tech-node')].map(el => [el.dataset.key, el]));
    svg.setAttribute('width', board.offsetWidth);
    svg.setAttribute('height', board.offsetHeight);
    svg.setAttribute('viewBox', `0 0 ${board.offsetWidth} ${board.offsetHeight}`);
    const paths = [];
    for (const t of view.techs) {
      const target = cards.get(t.key);
      if (!target) continue;
      for (const key of t.prereqs) {
        const source = cards.get(key);
        if (!source) continue;
        const x1 = source.offsetLeft + source.offsetWidth, y1 = source.offsetTop + source.offsetHeight / 2;
        const x2 = target.offsetLeft, y2 = target.offsetTop + target.offsetHeight / 2;
        const bend = x2 > x1 + 28 ? x1 + (x2 - x1) / 2 : x1 + 14;
        const d = `M${x1} ${y1} H${bend} V${y2} H${x2}`;
        paths.push(`<path d="${d}" class="${source.classList.contains('done') && target.classList.contains('done') ? 'complete' : ''}"/>`);
      }
    }
    svg.innerHTML = paths.join('');
  }
  function renderTree() {
    if (!view) return;
    hideTechTooltip();
    const q = $('#techFilter').value.trim().toLowerCase(), hideDone = $('#techHideDone').checked;
    const gm = ctx.isGm(), actor = gm || (ctx.state.myFactionId === view.factionId);
    const hasFaction = !!view.factionId;
    const activeT = view.techs.find(t => t.active), avail = view.techs.filter(t => !t.unlocked && !t.active && !t.queued && !t.blocker).length;
    $('#techHint').innerHTML = hasFaction
      ? `<div class="techfacts"><span title="Techs dated up to ${view.year + view.lead} can be researched">📅 <b>${view.year}</b> research up to ${view.year + view.lead}</span><span><img src="/icons/paper_roll.png" alt=""> <b>${fmt(view.rp)}</b> RP banked</span><span><img src="/icons/cash.png" alt=""> <b>${fmt(view.money)}</b> money</span>`
        + `<span class="${activeT ? 'on' : 'idle'}">🔬 ${activeT ? `<b>${esc(activeT.name)}</b> ${Math.min(100, Math.round(activeT.progress / Math.max(1, activeT.rp) * 100))}%` : 'nothing under way'}</span><span>✅ <b>${avail}</b> available now</span>`
        + `<button type="button" class="small secondary" data-techjump="1" title="Scroll to the techs you can research now">➜ Go to available</button></div>`
        + `<details class="sub howto"><summary>How research works</summary><p class="hint">One project at a time; its money is paid when it starts. At End turn the active project draws on the RP banked now (this turn's income arrives after), and at most one tech completes per turn. Queue more and they start in order.</p></details>`
      : '<p class="hint">No faction selected: showing the tree only.</p>';
    const techs = view.techs.filter(t => (!q || t.name.toLowerCase().includes(q) || t.key.toLowerCase().includes(q) || t.branch.toLowerCase().includes(q)) && !(hideDone && t.unlocked));
    if (!techs.length) { $('#techTree').innerHTML = '<p class="hint">No techs match.</p>'; return; }
    const years = [...new Set(techs.map(t => t.year))].sort((a, b) => a - b);
    const branches = [...new Set(techs.map(t => t.branch))];
    const rows = branches.map(br => {
      const counts = years.map(year => techs.filter(t => t.branch === br && t.year === year).length);
      return { branch: br, height: Math.max(144, Math.max(...counts) * 116 + 28) };
    });
    let rail = '<div class="tech-rail-head">Branch</div>';
    let board = `<div class="tech-years">${years.map(year => `<div class="tech-year${year === view.year ? ' current' : ''}">${year}${year === view.year ? '<small>current</small>' : ''}</div>`).join('')}</div><svg class="tech-links" aria-hidden="true"></svg>`;
    for (const row of rows) {
      rail += `<div class="tech-rail-row" style="height:${row.height}px"><span>${esc(row.branch)}</span></div>`;
      board += `<div class="tech-lane" style="height:${row.height}px">`;
      for (const year of years) {
        board += '<div class="tech-year-cell">';
        for (const t of techs.filter(item => item.branch === row.branch && item.year === year).sort((a, b) => a.sort - b.sort)) {
        const cls = t.unlocked ? 'done' : t.active ? 'active' : t.queued ? 'queued' : (t.blocker ? 'locked' : '');
        const pct = t.rp ? Math.min(100, Math.round((t.progress / t.rp) * 100)) : 0;
        const status = t.unlocked ? 'Researched' : t.active ? 'Researching' : t.queued ? 'Queued' : t.blocker ? 'Locked' : 'Available';
        let actions = '';
        if (hasFaction && actor && !t.unlocked && !t.active && !t.queued && !t.blocker) actions += `<button class="small" data-research="${t.key}">Research</button>`;
        if (hasFaction && actor && (t.active || t.queued)) actions += `<button class="small secondary" data-dropresearch="${t.key}">Drop</button>`;
        if (hasFaction && gm) actions += `<button class="small secondary" data-techunlock="${t.key}" data-on="${t.unlocked ? 0 : 1}" title="GM: grant or remove this tech">${t.unlocked ? 'Lock' : 'Unlock'}</button>`;
        if (gm) actions += `<button class="small secondary" data-techedit="${t.key}" title="Edit this tech">✎</button>`;
        board += `<div class="tech-node ${cls}" data-key="${esc(t.key)}" tabindex="0" aria-label="${esc(t.name)}; ${status}; ${t.rp} research points" aria-describedby="techTooltip">
          <span class="tech-icon"><img src="/icons/${techIcon(t)}" alt=""></span>
          <span class="tech-node-main"><span class="tech-node-title">${esc(t.name)}</span><span class="tech-node-meta">${t.rp} RP${t.money ? ` · ${t.money} money` : ''}</span></span>
          <span class="tech-node-status">${status}</span>
          ${actions ? `<span class="tech-node-actions">${actions}</span>` : ''}
          ${(t.active || (t.progress > 0 && !t.unlocked)) ? `<span class="tech-node-progress"><i style="width:${pct}%"></i></span>` : ''}
        </div>`;
        }
        board += '</div>';
      }
      board += '</div>';
    }
    $('#techTree').innerHTML = `<div class="tech-branch-rail">${rail}</div><div class="tech-tree-scroll"><div class="tech-timeline" style="--tech-years:${years.length}">${board}</div></div>`;
    requestAnimationFrame(drawTechLinks);
  }

  async function startResearch(key) {
    try { view = await api.post(`${ctx.base}/game/research`, { key, factionId: factionId || undefined }); ctx.renderNation(); renderTree(); toast(view.research.active === key ? 'Research started' : 'Queued'); }
    catch (err) { toast(err.message); }
  }
  async function dropResearch(key) {
    try { view = await api.del(`${ctx.base}/game/research/${key}?factionId=${factionId || ''}`); ctx.renderNation(); renderTree(); }
    catch (err) { toast(err.message); }
  }
  async function setUnlocked(key, on) {
    try { view = await api.post(`${ctx.base}/game/factions/${factionId}/techs`, { key, unlocked: on }); ctx.renderNation(); renderTree(); }
    catch (err) { toast(err.message); }
  }
  async function resetTree() {
    if (!confirm('Replace the campaign tech tree with the default WW1 tree? Factions keep the techs they have already unlocked.')) return;
    try { await api.post(`${ctx.base}/game/techs/reset`, {}); await load(factionId); toast('Tree reset'); }
    catch (err) { toast(err.message); }
  }

  // ---- GM editor ---------------------------------------------------------------------------
  function openEditor(key) {
    editing = key ? view.techs.find(t => t.key === key) : null;
    $('#techEditTitle').textContent = editing ? `Edit ${editing.name}` : 'New tech';
    $('#teKey').value = editing ? editing.key : ''; $('#teKey').readOnly = !!editing;
    $('#teBranch').value = editing ? editing.branch : ''; $('#teName').value = editing ? editing.name : '';
    $('#teYear').value = editing ? editing.year : view.year; $('#teRp').value = editing ? editing.rp : 30; $('#teMoney').value = editing ? editing.money : 10;
    $('#tePrereqs').value = editing ? editing.prereqs.join(', ') : '';
    $('#teEffects').value = JSON.stringify(editing ? editing.effects : [], null, 1);
    $('#teDesc').value = editing ? editing.desc : '';
    $('#btnTechDelete').hidden = !editing;
    $('#teBranches').innerHTML = [...new Set(view.techs.map(t => t.branch))].map(b => `<option value="${esc(b)}">`).join('');
    $('#teKeys').innerHTML = view.techs.map(t => `<option value="${esc(t.key)}">${esc(t.name)}</option>`).join('');
    $('#techEditModal').classList.add('open');
  }
  async function saveTech(e) {
    e.preventDefault();
    let effects;
    try { effects = JSON.parse($('#teEffects').value || '[]'); if (!Array.isArray(effects)) throw new Error(); } catch { toast('Effects must be a JSON array'); return; }
    const body = { key: $('#teKey').value, branch: $('#teBranch').value, name: $('#teName').value, year: Number($('#teYear').value), rp: Number($('#teRp').value), money: Number($('#teMoney').value),
      prereqs: $('#tePrereqs').value.split(',').map(s => s.trim()).filter(Boolean), effects, desc: $('#teDesc').value };
    try { await api.post(`${ctx.base}/game/techs`, body); $('#techEditModal').classList.remove('open'); await load(factionId); toast('Saved'); }
    catch (err) { toast(err.message); }
  }
  async function deleteTech() {
    if (!editing || !confirm(`Delete ${editing.name} from the tree?`)) return;
    try { await api.del(`${ctx.base}/game/techs/${editing.key}`); $('#techEditModal').classList.remove('open'); await load(factionId); }
    catch (err) { toast(err.message); }
  }

  return { init, load, sectionHtml, openTree, get view() { return view; } };
})();

window.ResearchUI = ResearchUI;
