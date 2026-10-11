'use strict';
window.Government = (() => {
  let ctx, current = null, dirty = false, sequence = 0, editing = false, saving = false;
  const $ = s => document.querySelector(s);
  const selected = () => Number($('#governmentFaction').value) || 0;
  function nations() {
    const old = selected(), list = ctx.state.factions || [];
    $('#governmentFaction').innerHTML = list.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    $('#governmentFaction').value = String(list.some(f => f.id === old) ? old : (ctx.state.myFactionId || list[0]?.id || ''));
  }
  function heroOptions() {
    const nation = current?.faction.name.toLowerCase();
    return [...ctx.state.markers.values()].filter(m => m.type === 'hero' &&
      String(m.data?.nation || '').toLowerCase() === nation && ['statesman', 'general', 'diplomat'].includes(m.data?.role) &&
      !m.adminOnly && !m.visibleTo?.length).sort((a, b) => a.name.localeCompare(b.name));
  }
  function priorityRow(value = '') {
    return `<div class="government-row"><label>Priority<input data-gpriority maxlength="300" value="${esc(value)}" placeholder="e.g. Preserve independence"></label><button type="button" class="small secondary" data-gremove aria-label="Remove priority">×</button></div>`;
  }
  function factionRow(x = {}) {
    return `<div class="government-row government-detail"><label>Faction name<input data-gfname maxlength="100" value="${esc(x.name || '')}" placeholder="e.g. Reformers"></label><label>Goals and supporters<input data-gfdesc maxlength="600" value="${esc(x.description || '')}" placeholder="What it wants, and who supports it"></label><button type="button" class="small secondary" data-gremove aria-label="Remove political faction">×</button></div>`;
  }
  function figureRow(x = {}) {
    const options = heroOptions();
    return `<div class="government-row government-detail"><label>Name<input data-gname maxlength="100" value="${esc(x.name || '')}" placeholder="Name"></label><label>Office or title<input data-gtitle maxlength="100" value="${esc(x.title || '')}" placeholder="e.g. Prime minister"></label><label>Character and role<input data-gdesc maxlength="600" value="${esc(x.description || '')}" placeholder="Role in the government"></label><label>Public map character<select data-ghero><option value="">No map hero</option>${options.map(h => `<option value="${h.id}" ${Number(x.heroId) === h.id ? 'selected' : ''}>${esc(h.name)} · ${esc(h.data.role)}</option>`).join('')}</select></label><button type="button" class="small secondary" data-gremove aria-label="Remove figure">×</button></div>`;
  }
  function setEditing(value) {
    editing = value && ctx.canEdit;
    $('#governmentForm').hidden = !editing;
    $('#governmentView').hidden = editing;
    $('#governmentEdit').textContent = editing ? 'View profile' : 'Edit profile';
    $('#governmentEdit').setAttribute('aria-expanded', String(editing));
  }
  const list = (items, render, empty) => items.length ? `<ul class="government-list">${items.map(render).join('')}</ul>` : `<p class="hint">${empty}</p>`;
  function render() {
    const p = current;
    if (!p) return;
    const figures = (p.figures || []).map(f => {
      const hero = f.hero;
      const locate = hero && ctx.state.markers.has(hero.id) ? `<button type="button" class="small secondary" data-herofind="${hero.id}">Find on map</button>` : '';
      return `<li><b>${esc(f.name)}</b>${f.title ? ` · ${esc(f.title)}` : ''}${hero ? ` <span class="hint">(${esc(hero.role)})</span>` : ''}${f.description ? `<p>${esc(f.description)}</p>` : ''}${locate}</li>`;
    });
    $('#governmentView').innerHTML = `<div class="box"><div class="story-heading"><span class="story-art story-art--government" aria-hidden="true"></span><div><h3>${esc(p.faction.name)}</h3><span class="story-eyebrow">${esc(p.governmentForm || 'Government not yet described')}</span></div></div><h4>National character</h4>${p.character ? `<p>${esc(p.character)}</p>` : '<p class="hint">This nation has not described its outlook yet.</p>'}</div>
      <div class="box"><h4>Priorities</h4>${list(p.priorities || [], x => `<li>${esc(x)}</li>`, 'No priorities yet.')}</div>
      <div class="box"><h4>Political factions</h4>${list(p.politicalFactions || [], x => `<li><b>${esc(x.name)}</b>${x.description ? `<p>${esc(x.description)}</p>` : ''}</li>`, 'No political factions yet.')}</div>
      <div class="box"><h4>Key figures</h4>${figures.length ? `<ul class="government-list">${figures.join('')}</ul>` : '<p class="hint">No key figures yet.</p>'}</div>`;
    $('#governmentEdit').hidden = !ctx.canEdit;
    setEditing(editing);
    if (!ctx.canEdit) return;
    $('#governmentFormName').value = p.governmentForm;
    $('#governmentCharacter').value = p.character;
    $('#governmentPriorities').innerHTML = (p.priorities || []).map(priorityRow).join('');
    $('#governmentFactions').innerHTML = (p.politicalFactions || []).map(factionRow).join('');
    $('#governmentFigures').innerHTML = (p.figures || []).map(figureRow).join('');
    dirty = false;
  }
  async function load() {
    nations();
    const id = selected();
    if (dirty && current?.faction.id === id) return;
    const seq = ++sequence;
    if (!id) { $('#governmentView').innerHTML = '<p class="hint">Add a nation to describe its government.</p>'; $('#governmentForm').hidden = true; $('#governmentEdit').hidden = true; return; }
    $('#governmentStatus').textContent = 'Loading profile…';
    $('#governmentEdit').disabled = true;
    $('#governmentView').hidden = true;
    $('#governmentForm').hidden = true;
    try {
      const data = await api.get(`${ctx.base}/game/government/${id}`);
      if (seq !== sequence) return;
      current = data.profile; ctx.canEdit = data.canEdit;
      $('#governmentStatus').textContent = current.updatedName ? `Last updated by ${current.updatedName}` : 'Everyone in this nation can help write its profile.';
      render();
    } catch (err) { if (seq === sequence) $('#governmentStatus').textContent = err.message; }
    finally { if (seq === sequence) $('#governmentEdit').disabled = current?.faction.id !== selected(); }
  }
  function read() {
    const text = (node, selector) => node.querySelector(selector)?.value.trim() || '';
    return {
      revision: current.revision, governmentForm: $('#governmentFormName').value, character: $('#governmentCharacter').value,
      priorities: [...$('#governmentPriorities').querySelectorAll('[data-gpriority]')].map(x => x.value.trim()).filter(Boolean),
      politicalFactions: [...$('#governmentFactions').querySelectorAll('.government-row')].map(x => ({ name: text(x, '[data-gfname]'), description: text(x, '[data-gfdesc]') })).filter(x => x.name),
      figures: [...$('#governmentFigures').querySelectorAll('.government-row')].map(x => ({ name: text(x, '[data-gname]'), title: text(x, '[data-gtitle]'), description: text(x, '[data-gdesc]'), heroId: Number(text(x, '[data-ghero]')) || null })).filter(x => x.name || x.heroId),
    };
  }
  async function save(ev) {
    ev.preventDefault();
    if (saving) return;
    const submit = $('#governmentForm button[type="submit"]'), fid = selected(), draft = read();
    saving = true; submit.disabled = true; submit.textContent = 'Saving…';
    $('#governmentFaction').disabled = true;
    try {
      const result = await api.put(`${ctx.base}/game/government/${fid}`, draft);
      current = result.profile; dirty = false; editing = false; render();
      $('#governmentStatus').textContent = `Saved by ${current.updatedName}`;
      toast('Government saved');
    } catch (err) { $('#governmentStatus').textContent = err.message; toast(err.message); }
    finally { saving = false; submit.disabled = false; submit.textContent = 'Save profile'; $('#governmentFaction').disabled = false; }
  }
  function init(c) {
    ctx = c;
    $('#governmentFaction').onchange = () => {
      if (dirty && !confirm('Discard your unsaved profile changes and switch nations?')) { $('#governmentFaction').value = String(current.faction.id); return; }
      dirty = false; editing = false; load();
    };
    $('#governmentEdit').onclick = () => { setEditing(!editing); if (editing) $('#governmentFormName').focus(); };
    $('#governmentForm').onsubmit = save;
    $('#governmentReload').onclick = () => {
      if (saving || (dirty && !confirm('Discard your unsaved profile changes?'))) return;
      dirty = false; editing = false; render(); load();
    };
    const markDirty = () => { dirty = true; $('#governmentStatus').textContent = 'Unsaved changes'; };
    $('#governmentForm').addEventListener('input', markDirty);
    $('#governmentForm').addEventListener('change', markDirty);
    $('#governmentForm').onclick = ev => {
      const target = ev.target;
      if (target.closest('[data-gremove]')) { target.closest('.government-row').remove(); dirty = true; }
      else if (target.id === 'governmentAddPriority' && $('#governmentPriorities').children.length < 8) { $('#governmentPriorities').insertAdjacentHTML('beforeend', priorityRow()); dirty = true; }
      else if (target.id === 'governmentAddFaction' && $('#governmentFactions').children.length < 12) { $('#governmentFactions').insertAdjacentHTML('beforeend', factionRow()); dirty = true; }
      else if (target.id === 'governmentAddFigure' && $('#governmentFigures').children.length < 20) { $('#governmentFigures').insertAdjacentHTML('beforeend', figureRow()); dirty = true; }
      if (dirty) $('#governmentStatus').textContent = 'Unsaved changes';
    };
  }
  function changed(factionId) {
    if (selected() !== Number(factionId)) return;
    if (dirty) $('#governmentStatus').textContent = 'Another player updated this profile. Reload before saving your changes.';
    else load();
  }
  return { init, load, changed };
})();
