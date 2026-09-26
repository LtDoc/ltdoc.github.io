'use strict';
/* global UnitTypes, api, esc, toast */

/**
 * GM table for a campaign's default unit stats. Every catalogue type gets a row with +/- steppers for
 * attack, defend, action points, range and movement. Values that differ from the catalogue are stored as
 * overrides in the campaign settings (settings.unitStats = { typeId: [a, d, ap, r, m] }); everything else
 * keeps following the catalogue. Used from the campaigns page and from the map's settings modal.
 */
const StatsEditor = (() => {
  let modal = null, lobby = null, values = null, onSaved = null;

  function ensure() {
    if (modal) return;
    modal = document.createElement('div');
    modal.id = 'statsModal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="card wide">
        <button class="close" data-close>×</button>
        <h2>Unit stats · <span id="statsLobbyName"></span></h2>
        <p class="hint">Defaults filled in when a unit of each type is placed. Attack and defend are added to the d20 combat
          roll: 0–1 very weak, 2–3 weak, 4–5 mid, 6–7 strong, 8–9 very strong, 10 extreme. Range and movement are in map
          tiles per turn. Changed values are highlighted; existing units keep the stats they already have.</p>
        <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
          <label class="inline" style="margin:0"><input type="search" id="statsFilter" placeholder="Filter types…" style="width:180px;margin:0"></label>
          <span><button type="button" class="small secondary" id="statsResetAll">Reset all to catalogue</button></span>
        </div>
        <div class="statswrap"><table class="stats"><thead><tr><th class="name">Type</th>
          ${UnitTypes.STAT_LABELS.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr></thead><tbody id="statsBody"></tbody></table></div>
        <div class="row" style="margin-top:10px"><button type="button" id="statsSave">Save</button><button type="button" class="secondary" data-close>Cancel</button><span class="hint" id="statsSummary"></span></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    modal.querySelector('#statsFilter').oninput = e => filter(e.target.value);
    modal.querySelector('#statsResetAll').onclick = () => {
      for (const t of UnitTypes.LIST) values[t.id] = [...t.stats];
      render();
    };
    modal.querySelector('#statsSave').onclick = save;
    const body = modal.querySelector('#statsBody');
    body.addEventListener('click', e => {
      const btn = e.target.closest('button[data-d], button[data-reset]');
      if (!btn) return;
      const tr = btn.closest('tr'), id = tr.dataset.id;
      if (btn.dataset.reset !== undefined) {
        values[id] = [...UnitTypes.LIST.find(t => t.id === id).stats];
        refreshRow(tr);
        return;
      }
      const i = Number(btn.dataset.i), step = e.shiftKey ? 5 : 1;
      values[id][i] = round(values[id][i] + Number(btn.dataset.d) * step);
      refreshRow(tr);
    });
    body.addEventListener('input', e => {
      const inp = e.target.closest('input[data-i]');
      if (!inp) return;
      const tr = inp.closest('tr'), id = tr.dataset.id;
      const n = Number(inp.value);
      if (Number.isFinite(n)) { values[id][Number(inp.dataset.i)] = round(n); refreshRow(tr, false); }
    });
  }

  const round = n => Math.max(-99, Math.min(999, Math.round(n * 10) / 10));

  function open(l, opts = {}) {
    ensure();
    lobby = l; onSaved = opts.onSaved || null;
    const ov = (l.settings && l.settings.unitStats) || {};
    values = {};
    for (const t of UnitTypes.LIST) values[t.id] = UnitTypes.statsFor(t, ov);
    modal.querySelector('#statsLobbyName').textContent = l.name;
    modal.querySelector('#statsFilter').value = '';
    render();
    modal.classList.add('open');
  }
  function close() { modal.classList.remove('open'); }

  function render() {
    const body = modal.querySelector('#statsBody');
    let html = '';
    for (const cat of UnitTypes.categories) {
      html += `<tr class="cat" data-cat="${esc(cat)}"><td colspan="${UnitTypes.STAT_KEYS.length + 2}">${esc(cat)}</td></tr>`;
      for (const t of UnitTypes.LIST.filter(x => x.cat === cat)) {
        html += `<tr data-id="${t.id}" data-cat="${esc(cat)}" data-name="${esc(t.name.toLowerCase())}"><td class="name">${esc(t.name)}</td>` +
          UnitTypes.STAT_KEYS.map((k, i) => `<td><span class="pm"><button type="button" data-i="${i}" data-d="-1" title="−1 (Shift: −5)">−</button>` +
            `<input type="number" step="any" data-i="${i}" value="${values[t.id][i]}"><button type="button" data-i="${i}" data-d="1" title="+1 (Shift: +5)">+</button></span></td>`).join('') +
          `<td><button type="button" class="small secondary" data-reset title="Back to the catalogue value">↺</button></td></tr>`;
      }
    }
    body.innerHTML = html;
    body.querySelectorAll('tr[data-id]').forEach(tr => refreshRow(tr, false));
    filter(modal.querySelector('#statsFilter').value);
    updateSummary();
  }

  function refreshRow(tr, setInputs = true) {
    const t = UnitTypes.LIST.find(x => x.id === tr.dataset.id);
    const v = values[t.id];
    let changed = false;
    tr.querySelectorAll('.pm').forEach((pm, i) => {
      const inp = pm.querySelector('input');
      if (setInputs) inp.value = v[i];
      const diff = v[i] !== t.stats[i];
      pm.classList.toggle('chg', diff);
      inp.title = diff ? `Catalogue: ${t.stats[i]}` : '';
      if (diff) changed = true;
    });
    tr.classList.toggle('changed', changed);
    tr.querySelector('[data-reset]').style.visibility = changed ? '' : 'hidden';
    updateSummary();
  }

  function overrides() {
    const out = {};
    for (const t of UnitTypes.LIST) {
      const v = values[t.id];
      if (v.some((x, i) => x !== t.stats[i])) out[t.id] = v;
    }
    return out;
  }
  function updateSummary() {
    const n = Object.keys(overrides()).length;
    modal.querySelector('#statsSummary').textContent = n ? `${n} type${n === 1 ? '' : 's'} differ from the catalogue` : 'All types at catalogue defaults';
  }

  function filter(text) {
    const s = String(text || '').trim().toLowerCase();
    const rows = modal.querySelectorAll('#statsBody tr[data-id]');
    const seen = new Set();
    rows.forEach(tr => {
      const show = !s || tr.dataset.name.includes(s) || tr.dataset.cat.toLowerCase().includes(s);
      tr.style.display = show ? '' : 'none';
      if (show) seen.add(tr.dataset.cat);
    });
    modal.querySelectorAll('#statsBody tr.cat').forEach(tr => { tr.style.display = seen.has(tr.dataset.cat) ? '' : 'none'; });
  }

  async function save() {
    const btn = modal.querySelector('#statsSave');
    btn.disabled = true;
    try {
      const ov = overrides();
      const d = await api.patch(`/api/lobbies/${lobby.id}`, { settings: { unitStats: Object.keys(ov).length ? ov : null, replaceUnitStats: true } });
      toast('Unit stats saved');
      close();
      if (onSaved) onSaved(d.lobby);
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  }

  return { open, close };
})();

window.StatsEditor = StatsEditor;
