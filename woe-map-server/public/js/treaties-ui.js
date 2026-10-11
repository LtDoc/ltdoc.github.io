'use strict';
/* global api, esc, toast, UnitTypes, PIXI */
const TreatiesUI = (() => {
  let ctx, modal, data = { treaties: [], wars: [], coalitions: [] }, draft, baseline, fid, dirty = false, remote, busy = false, returnFocus;
  const $ = s => modal.querySelector(s), clone = x => JSON.parse(JSON.stringify(x));
  const factions = () => ctx.state.factions || [];
  const name = id => factions().find(f => f.id === Number(id))?.name || `#${id}`;
  const ns = ids => ids.map(name).join(', ');
  const labels = { transfer: 'Province transfer', annex: 'Annexation', research: 'Mutual research agreement', license: 'Unit production license', access: 'Movement and supply rights', defense: 'Mutual defensive pact', coalition: 'Form permanent coalition', dissolve: 'Dissolve coalition', endAlliance: 'Dissolve bilateral alliance', reparations: 'Currency payments / reparations', truce: 'Truce' };
  const nations = (ids, selected) => ids.map(id => `<option value="${id}" ${Number(selected) === id ? 'selected' : ''}>${esc(name(id))}</option>`).join('');
  const turn = () => ctx.state.game?.turn || 1;
  function init(c) {
    ctx = c;
    modal = document.createElement('div'); modal.id = 'treatyModal'; modal.className = 'modal';
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'treatyHeading');
    modal.innerHTML = '<div class="card treaty-card"><header><div><p class="treaty-eyebrow">Diplomatic affairs</p><h2 id="treatyHeading">Treaties & coalitions</h2></div><button type="button" class="secondary treaty-close" data-treaty="close" aria-label="Close treaties">×</button></header><div id="treatyContent"></div></div>';
    document.body.appendChild(modal);
    modal.addEventListener('input', e => {
      if (!draft || draft.status !== 'draft') return;
      if (e.target.closest('#treatyEditor')) { dirty = true; updateSaveStatus(); }
    });
    modal.addEventListener('change', e => {
      if (!draft || draft.status !== 'draft') return;
      if (e.target.matches('[data-clause-kind]')) { capture(); renderEditor(); }
    });
    modal.addEventListener('click', async e => {
      const b = e.target.closest('[data-treaty]'); if (!b || busy) return;
      const label = b.textContent, locked = [...modal.querySelectorAll('button, input, select, textarea')].filter(el => !el.disabled);
      busy = true; modal.setAttribute('aria-busy', 'true'); locked.forEach(el => { el.disabled = true; });
      const pending = { save: 'Saving…', generate: 'Generating…', approve: 'Submitting approval…', create: 'Creating…' }[b.dataset.treaty];
      if (pending) b.textContent = pending;
      try { await action(b.dataset.treaty, b.dataset.id); } catch (err) { toast(err.message, 5000); }
      finally { busy = false; modal.removeAttribute('aria-busy'); locked.forEach(el => { el.disabled = false; }); b.textContent = label; updateSaveStatus(); }
    });
    document.addEventListener('keydown', e => {
      if (!modal.classList.contains('open')) return;
      if (e.key === 'Tab') {
        const items = [...modal.querySelectorAll('button, input, select, textarea, summary')].filter(el => !el.disabled && el.getClientRects().length);
        const first = items[0], last = items[items.length - 1];
        if (first && e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (last && !e.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.key !== 'Escape' || busy) return;
      e.preventDefault(); e.stopPropagation(); action('close').catch(err => toast(err.message));
    }, true);
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-treaty-open]'); if (b) open(Number(b.dataset.treatyOpen) || ctx.state.myFactionId);
      const p = e.target.closest('[data-treaty-peace]'); if (p) open(Number(p.dataset.from) || ctx.state.myFactionId, Number(p.dataset.treatyPeace));
    });
  }
  async function fetchData() { data = await api.get(`${ctx.base}/game/treaties`); }
  async function open(represent = ctx.state.myFactionId, enemy) {
    returnFocus = document.activeElement;
    fid = represent; await fetchData(); draft = baseline = remote = null; dirty = false;
    modal.classList.add('open'); renderLibrary(); modal.querySelector('[data-treaty="close"]').focus();
    if (enemy) {
      const war = data.wars.find(w => w.status === 'active' && (w.attackers.includes(fid) && w.defenders.includes(enemy) || w.attackers.includes(enemy) && w.defenders.includes(fid)));
      if (war) {
        const existing = data.treaties.find(t => t.warId === war.id && ['draft', 'scheduled'].includes(t.status));
        if (existing) edit(existing); else await create(war.id);
      }
    }
  }
  const canAct = () => !!fid && (ctx.isGm() || ctx.state.myFactionId === fid) && ctx.state.role !== 'observer' && ctx.state.realRole !== 'observer';
  const statusBadge = t => `<span class="treaty-status treaty-status-${esc(t.status)}">${esc({ draft: 'In negotiation', scheduled: 'Ratified · scheduled', active: 'In effect', withdrawn: 'Withdrawn', expired: 'Expired' }[t.status] || t.status)}</span>`;
  function updateSaveStatus() {
    const status = $('#treatySaveStatus');
    if (status) { status.textContent = dirty ? 'Unsaved changes' : 'All changes saved'; status.classList.toggle('is-dirty', dirty); }
    const approve = $('[data-treaty="approve"]');
    if (approve) { approve.disabled = busy || dirty || !!remote || !!draft?.documentNeedsReview || draft?.approvals[fid]?.revision === draft?.revision; approve.title = dirty ? 'Save your changes before approving this revision' : draft?.documentNeedsReview ? 'Update the document to reflect the agreed terms first' : ''; }
  }
  function renderLibrary() {
    const wars = data.wars.filter(w => w.status === 'active').map(w => `<div class="box"><h4>${esc(w.name)}</h4><p>${esc(ns(w.attackers))} against ${esc(ns(w.defenders))}</p><p class="hint">Lead negotiators: ${esc(ns([w.leadAttacker, w.leadDefender]))}</p>${canAct() ? [...w.attackers, ...w.defenders].includes(fid)
      ? `<button data-treaty="conference" data-id="${w.id}">Open peace conference</button>` : `<button class="secondary" data-treaty="joinAttackers" data-id="${w.id}">Join attacking side</button> <button class="secondary" data-treaty="joinDefenders" data-id="${w.id}">Join defending side</button>` : ''}</div>`).join('');
    const coalitions = data.coalitions.filter(c => c.status === 'active').map(c => `<div class="diplo"><span class="grow"><b>${esc(c.name)}</b><br>${esc(ns(c.members))}</span>${canAct() && c.members.includes(fid) ? `<button class="secondary small" data-treaty="leave" data-id="${c.id}">Leave</button>` : ''}</div>`).join('');
    const list = data.treaties.slice().reverse().map(t => `<article class="treaty-list-item"><div class="grow"><div class="treaty-list-meta">${statusBadge(t)}<span>Revision ${t.revision}</span></div><h4>${esc(t.title)}</h4><p class="hint">${esc(ns(t.participants))}</p></div><button class="secondary" data-treaty="edit" data-id="${t.id}">${t.status === 'draft' && t.participants.includes(fid) ? 'Negotiate' : 'Read treaty'}</button></article>`).join('');
    $('#treatyContent').innerHTML = `<div class="treaty-library-toolbar">${ctx.isGm() ? `<label>Representing<select id="treatyActor">${nations(factions().map(f => f.id), fid)}</select></label>` : `<p class="hint">Representing <strong>${fid ? esc(name(fid)) : 'an observer'}</strong></p>`}
      ${canAct() ? '<button class="treaty-primary" data-treaty="new">New diplomatic treaty</button>' : ''}</div><div class="treaty-library-grid"><section class="treaty-library-main"><p class="treaty-eyebrow">Shared agreements</p><h3>Negotiations & treaties</h3><p class="hint">Review shared terms, follow approvals, and read past agreements.</p>${list || '<div class="treaty-empty"><h4>Your negotiating table is clear</h4><p>Create a treaty to agree on territory, access, or other commitments.</p></div>'}</section><aside><section class="treaty-panel"><h3>Active wars</h3>${wars || '<p class="hint">No active wars. Peace conferences appear here when a war begins.</p>'}</section><section class="treaty-panel"><h3>Permanent coalitions</h3>${coalitions || '<p class="hint">No coalitions have been formed.</p>'}</section></aside></div>`;
    const actor = $('#treatyActor'); if (actor) actor.onchange = () => { fid = Number(actor.value); renderLibrary(); };
  }
  async function create(warId) {
    const participants = $('#newSignatories') ? [...modal.querySelectorAll('#newSignatories input:checked')].map(x => Number(x.value)) : [];
    const r = await api.post(`${ctx.base}/game/treaties`, { factionId: fid, warId, participants }); await fetchData(); edit(r.treaty);
  }
  function edit(t) { draft = clone(t); baseline = clone(t); dirty = false; remote = null; renderEditor(); }
  function summary(c) {
    if (c.kind === 'coalition') return `${c.name}: ${ns(c.members)}`;
    if (c.kind === 'dissolve') return data.coalitions.find(x => x.id === c.coalitionId)?.name || c.coalitionId;
    return `${name(c.from)} → ${name(c.to)}${c.kind === 'research' || c.kind === 'defense' || c.kind === 'truce' ? ' (mutual)' : ''}${c.kind === 'transfer' ? ` · ${c.provinceIds.length} provinces` : ''}${c.kind === 'license' ? ` · ${c.unitType}` : ''}${c.kind === 'access' ? ` · ${c.rights.join(', ')}` : ''}${c.kind === 'reparations' ? ` · ${c.amount} currency × ${c.turns} turns` : ''}`;
  }
  function clauseHtml(c, i, editable) {
    const ids = draft.participants, timed = !['transfer', 'annex', 'coalition', 'dissolve', 'endAlliance'].includes(c.kind);
    if (!editable) return `<div class="box"><b>${esc(labels[c.kind])}</b><p>${esc(summary(c))}</p><p class="hint">Starts turn ${c.startTurn ?? draft.effectiveTurn}${c.duration === null ? ' · indefinite' : ` · ${c.duration} turns`}${draft.runtime[c.id]?.broken ? ' · breached' : ''}</p>${c.kind === 'reparations' ? `<p>Paid: ${draft.runtime[c.id]?.paid || 0} · Arrears: ${draft.runtime[c.id]?.due || 0}</p>` : ''}</div>`;
    let specific = '';
    if (c.kind === 'transfer') specific = `<p><button type="button" class="secondary" data-treaty="pick" data-id="${i}">Select provinces on map (${c.provinceIds?.length || 0})</button></p><p class="hint">${esc((c.provinceIds || []).map(id => ctx.renderer.provinces.find(p => p.id === id)?.n || `#${id}`).join(', '))}</p>`;
    if (c.kind === 'license') specific = `<label>Unit type<select data-field="unitType">${UnitTypes.LIST.map(t => `<option value="${esc(t.id)}" ${t.id === c.unitType ? 'selected' : ''}>${esc(t.unit)}</option>`).join('')}</select></label><p class="hint">Negotiate fees using a currency payment clause. Expiry cancels unfinished licensed production and refunds its cost.</p>`;
    if (c.kind === 'access') specific = `<div class="treaty-checks">${['land', 'ports', 'airfields', 'supply'].map(r => `<label><input type="checkbox" data-right="${r}" ${(c.rights || []).includes(r) ? 'checked' : ''}>${r === 'land' ? 'Land passage' : r === 'ports' ? 'Ports' : r === 'airfields' ? 'Airfields / landing' : 'Supply access'}</label>`).join('')}</div>`;
    if (c.kind === 'reparations') specific = `<div class="treaty-row"><label>Currency per payment<input type="number" min="0.1" step="0.1" data-field="amount" value="${c.amount || 1}"></label><label>Number of payments<input type="number" min="1" data-field="turns" value="${c.turns || 1}"></label></div><p class="hint">One payment at the end of each turn. One payment can represent an upfront license fee. Missed payments remain in arrears and make the news.</p>`;
    if (c.kind === 'coalition') specific = `<label>Coalition name<input data-field="name" maxlength="100" value="${esc(c.name || '')}"></label><div class="treaty-checks">${ids.map(id => `<label><input type="checkbox" data-member="${id}" ${(c.members || []).includes(id) ? 'checked' : ''}>${esc(name(id))}</label>`).join('')}</div><p class="hint">Permanent until members leave or agree to dissolve it. Joining future wars is a choice; a defensive pact makes defensive entry automatic.</p>`;
    if (c.kind === 'dissolve') specific = `<label>Coalition<select data-field="coalitionId">${data.coalitions.filter(x => x.status === 'active').map(x => `<option value="${x.id}" ${x.id === c.coalitionId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label><p class="hint">Every member must sign the treaty.</p>`;
    return `<div class="box treaty-clause" data-clause="${i}"><div class="treaty-clause-heading"><span class="treaty-eyebrow">Article ${i + 1}</span><button class="small secondary" data-treaty="remove" data-id="${i}" aria-label="Remove article ${i + 1}">Remove</button></div><label>Agreement type<select data-clause-kind>${Object.entries(labels).map(([k, v]) => `<option value="${k}" ${k === c.kind ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${!['coalition', 'dissolve'].includes(c.kind) ? `<div class="treaty-row"><label>${c.kind === 'access' ? 'Host granting rights' : c.kind === 'license' ? 'Licensor' : 'From'}<select data-field="from">${nations(ids, c.from)}</select></label><label>${c.kind === 'access' ? 'Nation receiving rights' : 'To'}<select data-field="to">${nations(ids, c.to)}</select></label></div>` : ''}${specific}
      ${timed ? `<div class="treaty-row"><label>Start turn (blank = treaty start)<input type="number" min="${draft.effectiveTurn}" data-field="startTurn" value="${c.startTurn ?? ''}"></label><label>Duration in turns (blank = indefinite)<input type="number" min="1" data-field="duration" value="${c.duration ?? ''}"></label></div>` : '<p class="hint">Takes effect with the treaty. Territory changes and coalitions persist.</p>'}</div>`;
  }
  function renderEditor() {
    const t = draft, editable = t.status === 'draft' && canAct() && t.participants.includes(fid);
    const approved = t.participants.filter(id => t.approvals[id]?.revision === t.revision).length;
    $('#treatyContent').innerHTML = `<div class="treaty-editor-nav"><button class="secondary" data-treaty="back">← All treaties</button><div>${statusBadge(t)}<span class="hint">Revision ${t.revision}</span></div></div>
      <div id="treatyConflict" role="alert" ${remote ? '' : 'hidden'}></div><div id="treatyEditor" class="treaty-grid"><section class="treaty-terms"><div class="treaty-panel"><div class="treaty-section-heading"><h3>Signatories</h3><span class="hint">${approved} of ${t.participants.length} approved</span></div><progress class="treaty-progress" value="${approved}" max="${t.participants.length}" aria-label="Signatory approvals"></progress>
      ${t.participants.map(id => `<div class="treaty-signatory"><div><strong>${esc(name(id))}</strong>${t.leadNegotiators.includes(id) ? '<span class="hint">Lead negotiator</span>' : ''}</div><span class="treaty-approval ${t.approvals[id]?.revision === t.revision ? 'is-approved' : ''}">${t.approvals[id]?.revision === t.revision ? '✓ Approved' : 'Pending'}</span></div>`).join('')}
      ${editable && !t.warId ? `<details><summary>Edit signatories</summary><div id="treatySignatories" class="treaty-checks">${factions().map(f => `<label><input type="checkbox" value="${f.id}" ${t.participants.includes(f.id) ? 'checked' : ''} ${f.id === fid ? 'disabled' : ''}>${esc(f.name)}</label>`).join('')}</div></details>` : ''}
      </div><div class="treaty-panel"><h3>Timeline</h3><div class="treaty-row"><label>Effective turn<input id="treatyTurn" type="number" min="${turn()}" value="${t.effectiveTurn}" ${editable ? '' : 'disabled'}></label><label>Duration in turns<input id="treatyDuration" type="number" min="1" placeholder="Indefinite" value="${t.duration ?? ''}" ${editable ? '' : 'disabled'}></label></div><p class="hint">Leave duration blank for an agreement without expiry.</p>
      ${t.warId ? '<p class="treaty-peace-note">War continues until every signatory approves and the effective turn arrives. Occupied land stays with its occupier unless an article transfers it.</p>' : ''}</div>
      <div class="treaty-section-heading"><h3>Articles & terms</h3><span class="hint">${t.clauses.length} ${t.clauses.length === 1 ? 'article' : 'articles'}</span></div><div id="treatyClauses">${t.clauses.map((c, i) => clauseHtml(c, i, editable)).join('') || '<div class="treaty-empty"><p>No game effects agreed yet. Add an article for territory, payments, or access rights.</p></div>'}</div>${editable ? '<button class="secondary treaty-add" data-treaty="add">＋ Add demand / agreement</button>' : ''}
      </section><section class="treaty-document"><div class="treaty-section-heading"><div><p class="treaty-eyebrow">Shared document</p><h3>The agreement</h3></div>${editable ? '<button class="secondary small" data-treaty="generate">Generate standard document</button>' : ''}</div><label>Treaty title<input id="treatyTitle" maxlength="160" value="${esc(t.title)}" ${editable ? '' : 'readonly'}></label>
      <p class="hint">Write your shared commitments below. Articles determine game effects; custom wording is upheld through roleplay.</p>
      ${t.documentNeedsReview ? '<p class="treaty-text-warning">The demands or timeline changed. Regenerate the standard document or edit its wording to reflect those changes before approving.</p>' : ''}
      <label class="treaty-document-label">Main treaty text<textarea id="treatyText" maxlength="30000" ${editable ? '' : 'readonly'}>${esc(t.text)}</textarea></label>
      <details class="treaty-history-section"><summary>Revision history (${t.history.length})</summary>${t.history.slice().reverse().map(h => `<details><summary>Revision ${h.revision} · ${esc(h.by ? name(h.by) : 'War update')} · ${esc(h.action)}</summary><pre class="treaty-history">${esc(h.text)}</pre>${h.clauses ? `<pre class="treaty-history">${esc(h.clauses.map(summary).join('\n'))}</pre>` : ''}</details>`).join('')}</details>
      ${t.events.length ? `<details><summary>Treaty record (${t.events.length})</summary>${t.events.map(e => `<p>Turn ${e.turn}: ${esc(e.text)}</p>`).join('')}</details>` : ''}
      ${canAct() && t.participants.includes(fid) && ['draft', 'scheduled', 'active'].includes(t.status) ? `<details class="treaty-danger-zone"><summary>Withdrawal options</summary><p class="hint">${t.status === 'draft' ? 'Leave this negotiation without changing the current war.' : 'Breaking a ratified treaty is recorded publicly. Completed transfers and peace remain in effect.'}</p><button class="danger secondary" data-treaty="withdraw">${t.status === 'draft' ? 'Withdraw negotiation' : 'Break treaty'}</button></details>` : ''}</section></div>
      <footer class="treaty-action-bar"><div><p id="treatySaveStatus" role="status" aria-live="polite">${dirty ? 'Unsaved changes' : 'All changes saved'}</p><p class="hint">${editable ? 'Saving a revision resets every signatory’s approval.' : 'Every signatory must approve the same revision.'}</p></div>${editable ? `<div class="treaty-actions">${t.approvals[fid] ? '<button class="secondary" data-treaty="revoke">Revoke my approval</button>' : ''}<button class="secondary" data-treaty="save">Save shared revision</button><button class="treaty-primary" data-treaty="approve">Approve revision ${t.revision}</button></div>` : ''}</footer>`;
    if (remote) showConflict();
    updateSaveStatus();
  }
  function capture() {
    if (!draft || !$('#treatyTitle')) return;
    draft.title = $('#treatyTitle').value; draft.text = $('#treatyText').value; draft.effectiveTurn = Number($('#treatyTurn').value); draft.duration = $('#treatyDuration').value ? Number($('#treatyDuration').value) : null;
    if ($('#treatySignatories')) draft.participants = [...modal.querySelectorAll('#treatySignatories input:checked')].map(x => Number(x.value));
    for (const el of modal.querySelectorAll('[data-clause]')) {
      const i = Number(el.dataset.clause), old = draft.clauses[i], kind = el.querySelector('[data-clause-kind]')?.value || old.kind;
      if (kind !== old.kind) { draft.clauses[i] = defaults(kind); continue; }
      for (const input of el.querySelectorAll('[data-field]')) {
        const k = input.dataset.field;
        old[k] = ['from', 'to', 'amount', 'turns'].includes(k) ? Number(input.value) : ['duration', 'startTurn'].includes(k) ? input.value ? Number(input.value) : null : input.value;
        if (k === 'startTurn' && old[k] === null) delete old[k];
      }
      if (kind === 'access') old.rights = [...el.querySelectorAll('[data-right]:checked')].map(x => x.dataset.right);
      if (kind === 'coalition') old.members = [...el.querySelectorAll('[data-member]:checked')].map(x => Number(x.dataset.member));
    }
  }
  const defaults = kind => ({ kind, from: fid, to: draft.participants.find(id => id !== fid), duration: null,
    ...(kind === 'transfer' ? { provinceIds: [] } : kind === 'access' ? { rights: ['land'] } : kind === 'coalition' ? { name: '', members: [...draft.participants] } : kind === 'license' ? { unitType: UnitTypes.LIST[0].id } : kind === 'reparations' ? { amount: 1, turns: 1 } : {}) });
  async function save(generateText = false) {
    capture();
    try {
      const r = await api.patch(`${ctx.base}/game/treaties/${draft.id}`, { factionId: fid, revision: draft.revision, title: draft.title, text: draft.text, clauses: draft.clauses, participants: draft.participants, effectiveTurn: draft.effectiveTurn, duration: draft.duration, generateText });
      edit(r.treaty); await fetchData(); toast('Shared revision saved; approvals reset'); return true;
    } catch (err) { if (err.status === 409) { await fetchData(); remote = data.treaties.find(t => t.id === draft.id); showConflict(); } throw err; }
  }
  function showConflict() {
    const el = $('#treatyConflict'); if (!el || !remote) return;
    el.hidden = false;
    el.innerHTML = `<h4>Another participant updated this treaty</h4><p>Your unsaved draft is preserved. Review revision ${remote.revision} before merging. Changes to the same text or terms need your review.</p><details open><summary>Latest shared document and terms</summary><pre class="treaty-history">${esc(remote.text)}</pre><p>${esc(remote.clauses.map(summary).join('; '))}</p><p>Effective turn ${remote.effectiveTurn}; duration ${remote.duration ?? 'indefinite'}; signatories ${esc(ns(remote.participants))}</p></details><button class="secondary" data-treaty="latest">Use latest shared revision</button> <button data-treaty="merge">Merge my changes after review</button>`;
  }
  async function changed() {
    if (!ctx || busy) return;
    try {
      await fetchData(); if (!modal.classList.contains('open')) return;
      if (!draft) { renderLibrary(); return; }
      const latest = data.treaties.find(t => t.id === draft.id); if (!latest) return;
      if (!dirty) edit(latest);
      else if (latest.revision !== baseline.revision || latest.status !== baseline.status) { remote = latest; showConflict(); }
    } catch { /* reconnect or opening refreshes the authoritative ledger */ }
  }
  function pick(i) {
    capture(); const c = draft.clauses[i];
    if (!ctx.renderer.provinces.length) { toast('This map needs provinces before you can select a province transfer'); return; }
    const chosen = new Set(c.provinceIds || []), original = [...chosen];
    const graphics = new PIXI.Graphics(); graphics.eventMode = 'none'; ctx.renderer.overlayLayer.addChild(graphics);
    const draw = () => {
      graphics.clear();
      for (const p of ctx.renderer.provinces.filter(p => chosen.has(p.id))) for (const poly of p.g) for (const ring of poly) graphics.poly(ring.flat(), true).stroke({ color: 0xffdf6b, width: 3 / ctx.renderer.scale });
    };
    modal.classList.remove('open'); draw();
    ctx.armTreatyPicker({ label: `Select provinces ceded by ${name(c.from)} to ${name(c.to)}. Click to toggle; Done returns to the treaty.`,
      pick: (x, y) => { const p = ctx.renderer.provinceAt(x, y); if (!p) return; if (ctx.renderer.territoryOwnerAt(x, y) !== c.from) { toast(`Select provinces belonging to ${name(c.from)}`); return; } if (chosen.has(p.id)) chosen.delete(p.id); else chosen.add(p.id); draw(); toast(`${chosen.size} provinces selected`, 1000); },
      finish: cancelled => { c.provinceIds = cancelled ? original : [...chosen]; graphics.destroy(); modal.classList.add('open'); if (!cancelled) dirty = true; renderEditor(); } });
  }
  async function action(act, id) {
    if (act === 'close' || act === 'back') { if (dirty && !confirm('Discard your unsaved treaty changes?')) return; draft = baseline = remote = null; dirty = false; if (act === 'close') { modal.classList.remove('open'); returnFocus?.focus(); } else { await fetchData(); renderLibrary(); } return; }
    if (act === 'new') { $('#treatyContent').innerHTML = `<div class="treaty-create"><p class="treaty-eyebrow">New agreement</p><h3>Invite nations to the table</h3><p class="hint">${esc(name(fid))} is automatically included. Choose at least one other signatory.</p><div id="newSignatories" class="treaty-checks">${factions().filter(f => f.id !== fid).map(f => `<label><input type="checkbox" value="${f.id}">${esc(f.name)}</label>`).join('')}</div><div class="treaty-actions"><button class="treaty-primary" data-treaty="create">Create shared draft</button> <button class="secondary" data-treaty="back">Back</button></div></div>`; return; }
    if (act === 'create') { await create(); return; }
    if (act === 'conference') { const t = data.treaties.find(t => t.warId === id && ['draft', 'scheduled'].includes(t.status)); if (t) edit(t); else await create(id); return; }
    if (act === 'edit') { edit(data.treaties.find(t => t.id === id)); return; }
    if (act === 'add') { capture(); draft.clauses.push(defaults('research')); dirty = true; renderEditor(); return; }
    if (act === 'remove') { capture(); draft.clauses.splice(Number(id), 1); dirty = true; renderEditor(); return; }
    if (act === 'pick') { pick(Number(id)); return; }
    if (act === 'save') { await save(); return; }
    if (act === 'generate') { if (confirm('Replace the document text with a standard treaty reflecting the current clauses? Your previous text remains in revision history.')) await save(true); return; }
    if (act === 'latest') { edit(remote); return; }
    if (act === 'merge') {
      capture(); if (remote.status !== 'draft') { toast('The treaty has been ratified or closed; your draft cannot replace it'); return; }
      const merged = clone(remote);
      for (const k of ['title', 'text', 'clauses', 'participants', 'effectiveTurn', 'duration']) if (JSON.stringify(draft[k]) !== JSON.stringify(baseline[k])) merged[k] = clone(draft[k]);
      baseline = clone(remote); draft = merged; remote = null; dirty = true; renderEditor(); return;
    }
    if (act === 'joinAttackers' || act === 'joinDefenders' || act === 'leave') {
      if (!confirm(act === 'leave' ? 'Leave this coalition? Your nation remains in any wars it has already joined.' : 'Join this war? Your nation will fight every opponent and participate in its shared peace conference.')) return;
      await api.post(`${ctx.base}/game/treaties/${act === 'leave' ? `coalitions/${id}/leave` : `wars/${id}/join`}`, { factionId: fid, side: act === 'joinAttackers' ? 'attackers' : 'defenders' }); await fetchData(); renderLibrary(); return;
    }
    if (['approve', 'revoke', 'withdraw'].includes(act)) {
      if (dirty) { toast('Save and review the shared revision before approving or withdrawing'); return; }
      if (act === 'approve' && !confirm(`Approve revision ${draft.revision}? It takes effect once every signatory approves this exact revision.`)) return;
      if (act === 'withdraw' && !confirm(draft.status === 'draft' ? 'Withdraw this negotiation?' : 'Break this treaty? The breach will appear in the news. Peace and completed territory transfers remain in effect.')) return;
      const r = await api.post(`${ctx.base}/game/treaties/${draft.id}/${act}`, { factionId: fid, revision: draft.revision }); edit(r.treaty); await fetchData();
    }
  }
  return { init, open, changed };
})();
