'use strict';
/* global GameData, UnitTypes, api, esc, toast */

/**
 * GM table of unit production costs for a campaign: every catalogue type (plus "Factory") with +/- steppers
 * for the ten resources, money, manpower and build turns. Only differences from the defaults are stored
 * (settings.unitCosts), so untouched types keep following GameData.DEFAULT_COSTS.
 */
const CostEditor = (() => {
  let modal = null, lobby = null, values = null, onSaved = null;
  const COLS = [...GameData.RESOURCES.map(r => [r.key, r.glyph, r.name]), ['money', '$', 'Money'], ['manpower', 'Mp', 'Manpower'], ['turns', 'T', 'Build turns']];
  const rows = () => [...UnitTypes.LIST.map(t => ({ id: t.id, name: t.unit, cat: t.cat })), { id: 'factory', name: 'Factory (new site)', cat: 'Buildings' }];

  function ensure() {
    if (modal) return;
    modal = document.createElement('div');
    modal.id = 'costModal'; modal.className = 'modal';
    modal.innerHTML = `<div class="card wide">
      <button class="close" data-close>×</button>
      <h2>Production costs · <span id="costLobbyName"></span></h2>
      <p class="hint">Paid when a build is queued (refunded if cancelled). Shift-click steps by 5. Changed cells are highlighted with the default in their tooltip.</p>
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
        <input type="search" id="costFilter" placeholder="Filter types…" style="width:180px;margin:0">
        <button type="button" class="small secondary" id="costResetAll">Reset all to defaults</button>
      </div>
      <div class="statswrap"><table class="stats"><thead><tr><th class="name">Type</th>${COLS.map(([, g, n]) => `<th title="${esc(n)}">${esc(g)}</th>`).join('')}<th></th></tr></thead><tbody id="costBody"></tbody></table></div>
      <div class="row" style="margin-top:10px"><button type="button" id="costSave">Save</button><button type="button" class="secondary" data-close>Cancel</button><span class="hint" id="costSummary"></span></div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    modal.querySelector('#costFilter').oninput = e => filter(e.target.value);
    modal.querySelector('#costResetAll').onclick = () => { for (const r of rows()) values[r.id] = GameData.costFor(r.id, null); render(); };
    modal.querySelector('#costSave').onclick = save;
    const body = modal.querySelector('#costBody');
    body.addEventListener('click', e => {
      const btn = e.target.closest('button[data-d], button[data-reset]');
      if (!btn) return;
      const tr = btn.closest('tr'), id = tr.dataset.id;
      if (btn.dataset.reset !== undefined) { values[id] = GameData.costFor(id, null); refreshRow(tr); return; }
      const k = btn.dataset.key, step = e.shiftKey ? 5 : 1;
      values[id][k] = Math.max(0, Math.round((values[id][k] + Number(btn.dataset.d) * step) * 10) / 10);
      if (k === 'turns') values[id][k] = Math.max(1, Math.round(values[id][k]));
      refreshRow(tr);
    });
    body.addEventListener('input', e => {
      const inp = e.target.closest('input[data-key]');
      if (!inp) return;
      const n = Number(inp.value);
      if (Number.isFinite(n)) { values[inp.closest('tr').dataset.id][inp.dataset.key] = Math.max(0, n); refreshRow(inp.closest('tr'), false); }
    });
  }
  function open(l, opts = {}) {
    ensure();
    lobby = l; onSaved = opts.onSaved || null;
    const ov = (opts.settings && opts.settings.unitCosts) || {};
    values = {};
    for (const r of rows()) values[r.id] = GameData.costFor(r.id, ov);
    modal.querySelector('#costLobbyName').textContent = l.name;
    modal.querySelector('#costFilter').value = '';
    render();
    modal.classList.add('open');
  }
  function close() { modal.classList.remove('open'); }
  function render() {
    const body = modal.querySelector('#costBody');
    let html = '', cat = null;
    for (const r of rows()) {
      if (r.cat !== cat) { cat = r.cat; html += `<tr class="cat" data-cat="${esc(cat)}"><td colspan="${COLS.length + 2}">${esc(cat)}</td></tr>`; }
      html += `<tr data-id="${r.id}" data-cat="${esc(cat)}" data-name="${esc(r.name.toLowerCase())}"><td class="name">${esc(r.name)}</td>` +
        COLS.map(([k]) => `<td><span class="pm"><button type="button" data-key="${k}" data-d="-1">−</button><input type="number" step="any" data-key="${k}" value="${values[r.id][k]}"><button type="button" data-key="${k}" data-d="1">+</button></span></td>`).join('') +
        `<td><button type="button" class="small secondary" data-reset title="Back to the default cost">↺</button></td></tr>`;
    }
    body.innerHTML = html;
    body.querySelectorAll('tr[data-id]').forEach(tr => refreshRow(tr, false));
    filter(modal.querySelector('#costFilter').value);
  }
  function refreshRow(tr, setInputs = true) {
    const id = tr.dataset.id, base = GameData.costFor(id, null), v = values[id];
    let changed = false;
    tr.querySelectorAll('.pm').forEach(pm => {
      const inp = pm.querySelector('input'), k = inp.dataset.key;
      if (setInputs) inp.value = v[k];
      const diff = v[k] !== base[k];
      pm.classList.toggle('chg', diff);
      inp.title = diff ? `Default: ${base[k]}` : '';
      if (diff) changed = true;
    });
    tr.classList.toggle('changed', changed);
    tr.querySelector('[data-reset]').style.visibility = changed ? '' : 'hidden';
    const n = Object.keys(overrides()).length;
    modal.querySelector('#costSummary').textContent = n ? `${n} type${n === 1 ? '' : 's'} differ from the defaults` : 'All costs at defaults';
  }
  function overrides() {
    const out = {};
    for (const r of rows()) {
      const base = GameData.costFor(r.id, null), v = values[r.id];
      const o = {};
      for (const k of GameData.COST_KEYS) if (v[k] !== base[k]) o[k] = v[k];
      if (Object.keys(o).length) out[r.id] = o;
    }
    return out;
  }
  function filter(text) {
    const s = String(text || '').trim().toLowerCase(), seen = new Set();
    modal.querySelectorAll('#costBody tr[data-id]').forEach(tr => {
      const show = !s || tr.dataset.name.includes(s) || tr.dataset.cat.toLowerCase().includes(s);
      tr.style.display = show ? '' : 'none';
      if (show) seen.add(tr.dataset.cat);
    });
    modal.querySelectorAll('#costBody tr.cat').forEach(tr => { tr.style.display = seen.has(tr.dataset.cat) ? '' : 'none'; });
  }
  async function save() {
    const btn = modal.querySelector('#costSave'); btn.disabled = true;
    try {
      const d = await api.patch(`/api/lobbies/${lobby.id}/game`, { settings: { unitCosts: overrides(), replaceUnitCosts: true } });
      toast('Costs saved'); close();
      if (onSaved) onSaved(d.game);
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  }
  return { open, close };
})();

window.CostEditor = CostEditor;
