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
    renderTree();
    $('#techModal').classList.add('open');
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
      case 'flag': return ef.name;
      default: return ef.type;
    }
  }
  function renderTree() {
    if (!view) return;
    const q = $('#techFilter').value.trim().toLowerCase(), hideDone = $('#techHideDone').checked;
    const gm = ctx.isGm(), actor = gm || (ctx.state.myFactionId === view.factionId);
    const hasFaction = !!view.factionId;
    $('#techHint').textContent = hasFaction
      ? `Game year ${view.year}: techs dated up to ${view.year + view.lead} can be researched. RP banked: ${fmt(view.rp)} · money: ${fmt(view.money)}. One project at a time; money is paid when it starts.`
      : 'No faction selected: showing the tree only.';
    const branches = [...new Set(view.techs.map(t => t.branch))];
    let html = '';
    for (const br of branches) {
      const techs = view.techs.filter(t => t.branch === br && (!q || t.name.toLowerCase().includes(q) || t.key.includes(q) || br.toLowerCase().includes(q)) && !(hideDone && t.unlocked)).sort((a, b) => a.year - b.year || a.sort - b.sort);
      if (!techs.length) continue;
      html += `<div class="section branch">${esc(br)}</div><div class="techgrid">`;
      for (const t of techs) {
        const cls = t.unlocked ? 'done' : t.active ? 'active' : t.queued ? 'queued' : (t.blocker ? 'locked' : '');
        const pct = t.rp ? Math.min(100, Math.round((t.progress / t.rp) * 100)) : 0;
        const pre = t.prereqs.length ? `<div class="hint">needs ${t.prereqs.map(p => esc(view.techs.find(x => x.key === p)?.name || p)).join(', ')}</div>` : '';
        let status = '';
        if (t.unlocked) status = '<span class="rel alliance">researched</span>';
        else if (t.active) status = '<span class="rel war">researching</span>';
        else if (t.queued) status = '<span class="rel peace">queued</span>';
        else if (t.blocker) status = `<span class="hint">${esc(t.blocker)}</span>`;
        let actions = '';
        if (hasFaction && actor && !t.unlocked && !t.active && !t.queued && !t.blocker) actions += `<button class="small" data-research="${t.key}">Research</button>`;
        if (hasFaction && actor && (t.active || t.queued)) actions += `<button class="small secondary" data-dropresearch="${t.key}">Drop</button>`;
        if (hasFaction && gm) actions += `<button class="small secondary" data-techunlock="${t.key}" data-on="${t.unlocked ? 0 : 1}" title="GM: grant or remove this tech">${t.unlocked ? 'Lock' : 'Unlock'}</button>`;
        if (gm) actions += `<button class="small secondary" data-techedit="${t.key}" title="Edit this tech">✎</button>`;
        html += `<div class="tech ${cls}"><div class="t"><span>${esc(t.name)}</span><span class="yr">${t.year}</span></div>
          <div class="hint">${t.rp} RP${t.money ? ` · ${t.money} money` : ''}${t.effects.length ? ' · ' + t.effects.map(effectText).map(esc).join('; ') : ''}</div>
          ${t.desc ? `<div>${esc(t.desc)}</div>` : ''}${pre}
          ${(t.active || (t.progress > 0 && !t.unlocked)) ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
          <div class="actions">${status}${actions}</div></div>`;
      }
      html += '</div>';
    }
    $('#techTree').innerHTML = html || '<p class="hint">No techs match.</p>';
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
