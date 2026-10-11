'use strict';
window.Journal = (() => {
  let ctx, editing = null, entries = [], request = 0, saving = false;
  const $ = s => document.querySelector(s);
  const label = { event: 'Event', speech: 'Speech', law: 'Law', crisis: 'Crisis', 'turning-point': 'Turning point', note: 'Note' };
  const safeHref = s => /^\/(?!\/)[^\s\\<>]*$/.test(s || '') ? s : '';
  function selected() { return Number($('#journalFaction').value) || 0; }
  function updateNations() {
    const old = selected();
    const fs = ctx.state.factions || [];
    $('#journalFaction').innerHTML = fs.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    $('#journalFaction').value = String(fs.some(f => f.id === old) ? old : (ctx.state.myFactionId || fs[0]?.id || ''));
  }
  function resetForm() {
    editing = null;
    $('#journalForm').reset();
    $('#journalDate').value = ctx.state.game?.date || new Date().toISOString().slice(0, 10);
    $('#journalFormTitle').textContent = 'Write an entry';
    $('#journalCancel').hidden = true;
    $('#journalCompose').open = false;
  }
  function card(e, stolen = false) {
    const link = safeHref(e.link);
    const canEdit = !stolen && (ctx.state.role === 'gm' || (e.author_id === ctx.me.id && e.faction_id === ctx.state.myFactionId));
    const art = stolen ? 'stolen' : e.private ? 'private' : 'journal';
    return `<article class="box journal-entry${stolen ? ' journal-entry--stolen' : e.private ? ' journal-entry--private' : ''}"><div class="story-heading"><span class="story-art story-art--${art}" aria-hidden="true"></span><div><div class="journal-meta">${esc(e.entry_date)} · ${esc(label[e.kind] || e.kind)} · ${esc(e.author_name)}${e.private ? ' · <span class="story-tag">Private</span>' : ''}${stolen ? ` · <span class="story-tag">Recovered</span> From ${esc(e.source_faction_name)}` : ''}</div>
      <h3>${esc(e.title)}</h3></div></div><p>${esc(e.body)}</p>
      ${link ? `<a href="${esc(link)}">Related order or message ↗</a>` : ''}
      ${canEdit ? `<div class="toolrow"><button type="button" class="small secondary" data-jedit="${e.id}">Edit</button><button type="button" class="small danger" data-jdelete="${e.id}">Remove</button></div>` : ''}</article>`;
  }
  async function load() {
    updateNations();
    const fid = selected();
    const seq = ++request;
    if (!fid) { $('#journalList').innerHTML = '<p class="hint">Add a nation to start its journal.</p>'; $('#journalCompose').hidden = true; $('#journalStolen').innerHTML = ''; return; }
    $('#journalStatus').textContent = 'Loading entries…';
    $('#journalCompose').hidden = true;
    try {
      const d = await api.get(`${ctx.base}/game/journal?factionId=${fid}`);
      if (seq !== request) return;
      entries = d.entries || [];
      $('#journalCompose').hidden = !d.canWrite;
      $('#journalStatus').textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
      $('#journalList').innerHTML = `<h3>Journal</h3>${entries.length ? entries.map(e => card(e)).join('') : '<div class="story-empty"><strong>A story yet to be written</strong><p>No entries are visible for this nation yet.</p></div>'}`;
      $('#journalStolen').innerHTML = d.stolen?.length ? `<h3>Stolen notes</h3><p class="hint">Copies your spies recovered from other nations.</p>${d.stolen.map(e => card(e, true)).join('')}` : '';
    } catch (err) { if (seq === request) $('#journalStatus').textContent = `Could not load entries. ${err.message}`; }
  }
  async function save(ev) {
    ev.preventDefault();
    if (saving) return;
    const body = { factionId: selected(), date: $('#journalDate').value, kind: $('#journalKind').value,
      title: $('#journalTitle').value, body: $('#journalBody').value, link: $('#journalLink').value, private: $('#journalPrivate').checked };
    const submit = $('#journalForm button[type="submit"]');
    saving = true; submit.disabled = true; submit.textContent = 'Saving…';
    $('#journalFaction').disabled = true;
    try {
      if (editing) await api.patch(`${ctx.base}/game/journal/${editing}`, body);
      else await api.post(`${ctx.base}/game/journal`, body);
      resetForm(); await load(); toast('Journal entry saved');
    } catch (err) { toast(err.message); }
    finally { saving = false; submit.disabled = false; submit.textContent = 'Save entry'; $('#journalFaction').disabled = false; }
  }
  function init(c) {
    ctx = c;
    $('#journalFaction').onchange = () => { resetForm(); load(); };
    $('#journalForm').onsubmit = save;
    $('#journalCancel').onclick = resetForm;
    $('#journalList').onclick = async ev => {
      const edit = ev.target.closest('[data-jedit]');
      const del = ev.target.closest('[data-jdelete]');
      if (edit) {
        const e = entries.find(x => x.id === Number(edit.dataset.jedit));
        if (!e) return;
        editing = e.id;
        $('#journalDate').value = e.entry_date; $('#journalKind').value = e.kind;
        $('#journalTitle').value = e.title; $('#journalBody').value = e.body;
        $('#journalLink').value = e.link; $('#journalPrivate').checked = !!e.private;
        $('#journalFormTitle').textContent = 'Edit entry'; $('#journalCancel').hidden = false;
        $('#journalCompose').open = true;
        $('#journalForm').scrollIntoView({ block: 'nearest' });
        $('#journalTitle').focus();
      } else if (del && confirm('Remove this journal entry?')) {
        try { await api.del(`${ctx.base}/game/journal/${del.dataset.jdelete}`); resetForm(); await load(); }
        catch (err) { toast(err.message); }
      }
    };
    resetForm();
  }
  function showStolen() {
    if (ctx.state.myFactionId) $('#journalFaction').value = String(ctx.state.myFactionId);
    load();
  }
  return { init, load, showStolen };
})();
