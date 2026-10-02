'use strict';
/* global api, esc, toast, fmtTime, fmtNum, GameData */

/**
 * Communications (docs/COMMS.md): the chat window (bottom right) and the notification centre (top centre).
 *
 * Chat tabs: OOC (the campaign's chat, with /roll), GM (announcements: everyone reads, only the GM writes),
 * then private chats between members. Notifications: diplomacy needing an answer, war declarations, and
 * resource trades (propose, accept, decline, cancel) without opening the Nation tab.
 *
 *   Comms.init(ctx)  ctx = { state, me, base, renderer, notify, GameUI, flagImg }
 *   Comms.onEvent(e) / onChatChannel(c) / onChatMessage(m) / onRelations() / onTradesChanged(msg) / refresh()
 */
const Comms = (() => {
  let ctx = null;
  const $ = s => document.querySelector(s);
  const store = {
    key: () => `woe-comms-${ctx.state.lobby?.id}-${ctx.me.id}`,
    load() { try { return JSON.parse(localStorage.getItem(this.key()) || '{}'); } catch { return {}; } },
    save(v) { try { localStorage.setItem(this.key(), JSON.stringify(v)); } catch { /* private mode: unread counts reset on reload */ } },
  };
  let prefs = {};          // { seen: { tab: ms }, notifSeen: [keys], dismissed: [keys], open, tab }
  const channels = new Map();     // id -> channel
  const messages = new Map();     // channel id -> [message] (loaded on first open)
  let tab = 'ooc', open = false;

  const isGm = () => ctx.state.role === 'gm';
  const gameOn = () => !!ctx.state.game?.enabled;
  const memberName = id => ctx.state.members.find(m => m.userId === id)?.displayName || 'Someone';
  const memberColor = id => ctx.state.members.find(m => m.userId === id)?.color || '#95a5a6';
  const factions = () => (ctx.state.gameFactions || []).map(x => x.faction).filter(Boolean);
  const factionName = id => factions().find(f => f.id === id)?.name || (ctx.state.factions || []).find(f => f.id === id)?.name || '?';
  const myFactionId = () => ctx.state.myFactionId || null;
  const savePrefs = () => store.save(prefs);

  // ---- Chat ---------------------------------------------------------------------------------------
  function channelTitle(c) {
    if (c.name) return c.name;
    const others = c.members.filter(id => id !== ctx.me.id).map(memberName);
    return others.length ? others.join(', ') : 'Just you';
  }
  function tabMessages(t) {
    if (t === 'ooc') return (ctx.state.events || []).filter(e => e.kind === 'chat' || e.kind === 'roll');
    if (t === 'gm') return (ctx.state.events || []).filter(e => e.kind === 'announce');
    return messages.get(Number(t.slice(1))) || [];
  }
  function unread(t) {
    const seen = prefs.seen?.[t] || 0;
    if (t[0] === 'c' && !messages.has(Number(t.slice(1)))) {
      const c = channels.get(Number(t.slice(1)));
      return c && c.lastAt > seen && seen !== 0 ? 1 : (c && !seen && c.createdBy !== ctx.me.id ? 1 : 0);
    }
    return tabMessages(t).filter(m => m.createdAt > seen && m.userId !== ctx.me.id).length;
  }
  function markSeen(t) {
    prefs.seen = prefs.seen || {};
    const list = tabMessages(t);
    prefs.seen[t] = Math.max(Date.now(), ...list.map(m => m.createdAt || 0));
    savePrefs();
  }
  function tabs() { return ['ooc', 'gm', ...[...channels.values()].sort((a, b) => b.lastAt - a.lastAt).map(c => `c${c.id}`)]; }

  function renderChat() {
    const total = tabs().reduce((a, t) => a + (open && t === tab ? 0 : unread(t)), 0);
    const badge = $('#chatBadge');
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.hidden = !total;
    $('#chatWin').hidden = !open;
    $('#chatToggle').classList.toggle('active', open);
    if (!open) return;
    $('#chatTabs').innerHTML = tabs().map(t => {
      const n = t === tab ? 0 : unread(t);
      const label = t === 'ooc' ? 'OOC' : t === 'gm' ? 'GM' : esc(channelTitle(channels.get(Number(t.slice(1)))));
      const title = t === 'ooc' ? 'Out-of-character chat for everyone (/roll 2d6 works here)' : t === 'gm' ? 'Announcements from the GM' : 'Private chat';
      return `<button type="button" class="ctab ${t === tab ? 'on' : ''} ${t[0] === 'c' ? 'priv' : ''}" data-tab="${t}" title="${title}">${t[0] === 'c' ? '🔒 ' : ''}${label}${n ? `<span class="cnt">${n}</span>` : ''}</button>`;
    }).join('');
    $('#chatTabs').querySelectorAll('[data-tab]').forEach(b => b.onclick = () => openTab(b.dataset.tab));
    const list = tabMessages(tab);
    const body = $('#chatBody');
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    let head = '';
    if (tab[0] === 'c') {
      const c = channels.get(Number(tab.slice(1)));
      head = `<div class="chat-head"><span>${c.members.map(id => `<span class="who" style="color:${esc(memberColor(id))}">${esc(memberName(id))}</span>`).join(', ')}</span><button type="button" class="small secondary" id="chatLeave" title="Leave this chat">Leave</button></div>`;
    }
    body.innerHTML = head + (list.map(m => {
      const own = m.userId === ctx.me.id;
      if (m.kind === 'roll') return `<div class="cmsg roll"><span class="who" style="color:${esc(memberColor(m.userId))}">${esc(m.displayName)}</span> ${esc(m.message)}<span class="when">${fmtTime(m.createdAt)}</span></div>`;
      if (!m.userId) return `<div class="cmsg sys">${esc(m.message)}<span class="when">${fmtTime(m.createdAt)}</span></div>`;
      return `<div class="cmsg ${own ? 'own' : ''} ${m.kind === 'announce' ? 'announce' : ''}"><span class="who" style="color:${esc(memberColor(m.userId))}">${esc(m.displayName)}</span><span class="when">${fmtTime(m.createdAt)}</span><div class="text">${esc(m.message)}</div></div>`;
    }).join('') || `<p class="muted chat-empty">${tab === 'gm' ? 'No announcements yet.' : 'No messages yet.'}</p>`);
    if ($('#chatLeave')) $('#chatLeave').onclick = leaveTab;
    if (atBottom || body.dataset.tab !== tab) body.scrollTop = body.scrollHeight;
    body.dataset.tab = tab;
    const canWrite = tab !== 'gm' || isGm();
    $('#chatSend').hidden = !canWrite;
    $('#chatReadOnly').hidden = canWrite;
    $('#chatMsg').placeholder = tab === 'ooc' ? 'Message everyone… (/roll 2d6+1)' : tab === 'gm' ? 'Announce to everyone…' : 'Private message…';
  }

  async function openTab(t) {
    tab = t; prefs.tab = t; savePrefs();
    if (t[0] === 'c' && !messages.has(Number(t.slice(1)))) {
      try { const d = await api.get(`${ctx.base}/chats/${t.slice(1)}/messages`); messages.set(Number(t.slice(1)), d.messages); }
      catch (err) { toast(err.message); }
    }
    markSeen(t);
    renderChat();
    $('#chatMsg').focus();
  }
  function setOpen(on) {
    open = on; prefs.open = on; savePrefs();
    if (on) { $('#chatNewPanel').hidden = true; openTab(tabs().includes(tab) ? tab : 'ooc'); } else renderChat();
  }
  async function leaveTab() {
    const id = Number(tab.slice(1));
    if (!confirm(`Leave "${channelTitle(channels.get(id))}"? You will no longer see its messages.`)) return;
    try { await api.post(`${ctx.base}/chats/${id}/leave`, {}); channels.delete(id); messages.delete(id); openTab('ooc'); }
    catch (err) { toast(err.message); }
  }
  async function send(e) {
    e.preventDefault();
    const input = $('#chatMsg'), message = input.value.trim();
    if (!message) return;
    try {
      if (tab === 'ooc' || tab === 'gm') {
        const d = await api.post(`${ctx.base}/chat`, { message, channel: tab === 'gm' ? 'gm' : undefined });
        onEvent(d.event);
      } else {
        const d = await api.post(`${ctx.base}/chats/${tab.slice(1)}/messages`, { message });
        onChatMessage(d.message);
      }
      input.value = '';
    } catch (err) { toast(err.message); }
  }

  /** New private chat: pick people (players and the GM), optionally name it. */
  function showNewChat() {
    const others = ctx.state.members.filter(m => m.userId !== ctx.me.id);
    $('#chatNewList').innerHTML = others.map(m => `<label class="inline"><input type="checkbox" value="${m.userId}"> <span style="color:${esc(m.color || '#ccc')}">${esc(m.displayName)}</span> <span class="hint">${m.role === 'gm' ? 'GM' : esc(m.nation || 'player')}${m.online ? ' · online' : ''}</span></label>`).join('')
      || '<p class="muted">No one else has joined this campaign yet.</p>';
    $('#chatNewName').value = '';
    $('#chatNewPanel').hidden = false;
  }
  async function startChat(members, name) {
    try {
      const d = await api.post(`${ctx.base}/chats`, { members, name });
      channels.set(d.channel.id, d.channel);
      $('#chatNewPanel').hidden = true;
      if (!open) setOpen(true);
      await openTab(`c${d.channel.id}`);
    } catch (err) { toast(err.message); }
  }

  // ---- Notifications --------------------------------------------------------------------------------
  const DAY = 86400000;
  /** Everything worth a ping for this viewer: [{ key, icon, text, sub, actions: [[label, fn, cls]], needs }] */
  function items() {
    const out = [], mine = myFactionId(), gm = isGm();
    const now = Date.now();
    const dKind = d => d.kind === 'war' ? 'declaration of war' : d.kind === 'peace' ? 'peace offer' : 'alliance proposal';
    for (const d of ctx.state.diplomacy || []) {
      const from = factionName(d.from), to = factionName(d.to);
      const involved = mine && (d.from === mine || d.to === mine);
      if (d.status === 'pending' && gm) {
        out.push({ key: `d${d.id}:pending`, icon: d.kind === 'war' ? '⚔' : d.kind === 'peace' ? '🕊' : '🤝', needs: true,
          text: `${from}: ${dKind(d)} to ${to}`, sub: `Awaiting your approval${d.note ? ` · ${d.note}` : ''}`,
          actions: [['Approve', () => dip(d, 'approve')], ['Block', () => dip(d, 'block'), 'danger']] });
      } else if (d.status === 'offered' && (d.to === mine || (gm && !mine))) {
        out.push({ key: `d${d.id}:offered`, icon: d.kind === 'peace' ? '🕊' : '🤝', needs: d.to === mine || gm,
          text: `${from} sends ${to} a ${dKind(d)}`, sub: d.note || '',
          actions: [['Accept', () => dip(d, 'accept')], ['Decline', () => dip(d, 'decline'), 'danger']] });
      } else if (['pending', 'offered'].includes(d.status) && d.from === mine) {
        out.push({ key: `d${d.id}:${d.status}`, icon: '✉', needs: false,
          text: `Your ${dKind(d)} to ${to}`, sub: d.status === 'pending' ? 'Awaiting the GM' : `Awaiting ${to}'s answer`,
          actions: [['Withdraw', () => dip(d, 'withdraw'), 'secondary']] });
      } else if (d.status === 'accepted' && d.resolvedAt && now - d.resolvedAt < 3 * DAY && (d.kind === 'war' || involved || gm)) {
        out.push({ key: `d${d.id}:accepted`, icon: d.kind === 'war' ? '⚔' : d.kind === 'peace' ? '🕊' : '🤝', needs: false, info: true,
          text: d.kind === 'war' ? `${from} declared war on ${to}` : d.kind === 'peace' ? `${from} and ${to} made peace` : `${from} and ${to} are allied`,
          sub: fmtTime(d.resolvedAt) });
      } else if (['declined', 'blocked'].includes(d.status) && d.from === mine && d.resolvedAt && now - d.resolvedAt < 3 * DAY) {
        out.push({ key: `d${d.id}:${d.status}`, icon: '✉', needs: false, info: true,
          text: `Your ${dKind(d)} to ${to} was ${d.status === 'blocked' ? 'blocked by the GM' : 'declined'}`, sub: fmtTime(d.resolvedAt) });
      }
    }
    for (const t of ctx.state.trades || []) {
      const from = factionName(t.from), to = factionName(t.to);
      const what = `${goods(t.give)} for ${goods(t.take)}`;
      const when = t.mode === 'recurring' ? `every turn for ${t.turns} turn${t.turns === 1 ? '' : 's'}` : 'once, on acceptance';
      if (t.status === 'pending' && (t.to === mine || gm)) {
        out.push({ key: `t${t.id}:pending`, icon: '📦', needs: t.to === mine,
          text: `${from} offers ${to}: ${what}`, sub: `${when}${t.note ? ` · ${t.note}` : ''}`,
          actions: [['Accept', () => trade(t, 'accept')], ['Decline', () => trade(t, 'decline'), 'danger'], ...(gm && t.to !== mine ? [['Withdraw', () => trade(t, 'withdraw'), 'secondary']] : [])] });
      } else if (t.status === 'pending' && t.from === mine) {
        out.push({ key: `t${t.id}:pending`, icon: '📦', needs: false, text: `Your trade offer to ${to}: ${what}`, sub: `${when} · awaiting ${to}`,
          actions: [['Withdraw', () => trade(t, 'withdraw'), 'secondary']] });
      } else if (t.status === 'active') {
        const last = t.log[t.log.length - 1];
        out.push({ key: `t${t.id}:active`, icon: '🔁', needs: false, info: true,
          text: `Trade ${from} ⇄ ${to}: ${what}`, sub: `${t.turnsLeft} deliver${t.turnsLeft === 1 ? 'y' : 'ies'} to go${last ? ` · last: ${last.text}` : ' · first at End turn'}`,
          actions: [['Cancel', () => { if (confirm('Cancel this trade? Deliveries stop at once.')) trade(t, 'cancel'); }, 'danger']] });
      } else if (['completed', 'declined', 'withdrawn', 'cancelled'].includes(t.status) && t.resolvedAt && now - t.resolvedAt < 2 * DAY) {
        out.push({ key: `t${t.id}:${t.status}`, icon: '📦', needs: false, info: true,
          text: `Trade ${from} ⇄ ${to} ${t.status === 'completed' ? (t.mode === 'once' ? 'done' : 'finished') : t.status}`, sub: `${what} · ${fmtTime(t.resolvedAt)}` });
      }
    }
    // Allied convoys: boarding and landing requests between nations (docs/UNITS.md).
    const lc = s => String(s || '').trim().toLowerCase(), me = mine ? factionName(mine) : '';
    for (const r of ctx.state.convoyRequests || []) {
      const units = r.unitNames.length ? r.unitNames.join(', ') : 'units';
      const theirShip = lc(r.from) === lc(r.convoyNation);
      const text = r.kind === 'embark'
        ? (theirShip ? `${r.from} asks to carry your ${units} aboard ${r.convoyName}` : `${r.from} asks to board ${units} onto ${r.convoyName}`)
        : (theirShip ? `${r.from} wants to land the troops aboard ${r.convoyName}, yours included` : `${r.from} asks to land the troops aboard ${r.convoyName}`);
      const icon = r.kind === 'embark' ? '⛴' : '⚓';
      const waitingOnMe = r.to.some(n => lc(n) === lc(me)) && !r.approved.some(a => lc(a) === lc(me));
      if (r.status === 'pending' && (waitingOnMe || (gm && !me))) {
        out.push({ key: `cr${r.id}:pending`, icon, needs: true, text, sub: `Your answer${r.to.length > 1 ? ` (needed from ${r.to.join(', ')})` : ''}`,
          actions: [['Allow', () => convoyReq(r, 'approve')], ['Refuse', () => convoyReq(r, 'decline'), 'danger']] });
      } else if (r.status === 'pending' && lc(r.from) === lc(me)) {
        const waiting = r.to.filter(n => !r.approved.some(a => lc(a) === lc(n)));
        out.push({ key: `cr${r.id}:pending`, icon, needs: false, text: r.kind === 'embark' ? `You asked to board ${units} onto ${r.convoyName}` : `You asked to land the troops aboard ${r.convoyName}`,
          sub: `Waiting for ${waiting.join(', ')}`, actions: [['Withdraw', () => convoyReq(r, 'withdraw'), 'secondary']] });
      } else if (r.status !== 'pending' && r.resolvedAt && now - r.resolvedAt < DAY) {
        const how = { done: r.kind === 'embark' ? 'boarded' : 'landed', declined: 'refused', withdrawn: 'withdrawn', failed: 'could not be done', expired: 'expired' }[r.status] || r.status;
        out.push({ key: `cr${r.id}:${r.status}`, icon, needs: false, info: true, text: `${r.kind === 'embark' ? `Boarding ${r.convoyName}` : `Landing from ${r.convoyName}`}: ${how}`,
          sub: [r.note, fmtTime(r.resolvedAt)].filter(Boolean).join(' · ') });
      }
    }
    const dismissed = new Set(prefs.dismissed || []);
    // What waits for your answer comes first, then the rest in the order above.
    return out.filter(i => !(i.info && dismissed.has(i.key))).sort((x, y) => (y.needs ? 1 : 0) - (x.needs ? 1 : 0));
  }
  function goods(b) {
    const parts = Object.entries(b || {}).filter(([, v]) => v > 0)
      .map(([k, v]) => `${fmtNum(v)} ${k === 'rp' ? 'RP' : k === 'money' ? 'money' : k === 'manpower' ? 'manpower' : (window.GameData?.byKey[k]?.name || k).toLowerCase()}`);
    return parts.length ? parts.join(', ') : 'nothing';
  }
  async function dip(d, action) {
    try { const r = await api.post(`${ctx.base}/game/diplomacy/${d.id}/${action}`, {}); if (r.relations) ctx.state.relations = r.relations; await ctx.GameUI.load(); renderNotifs(); }
    catch (err) { toast(err.message); }
  }
  async function trade(t, action) {
    try { await api.post(`${ctx.base}/game/trades/${t.id}/${action}`, {}); await loadTrades(); if (action === 'accept') ctx.GameUI.load().catch(() => {}); }
    catch (err) { toast(err.message); }
  }
  async function convoyReq(r, action) {
    try {
      const d = await api.post(`${ctx.base}/convoy-requests/${r.id}/${action}`, {});
      if (d.embarked || d.landed) toast(d.embarked ? `${d.embarked.length} boarded ${r.convoyName}` : `${d.landed.length} landed from ${r.convoyName}`, 5000);
      await loadConvoyRequests();
    } catch (err) { toast(err.message); await loadConvoyRequests(); }
  }
  async function loadConvoyRequests() {
    if (!gameOn()) { ctx.state.convoyRequests = []; renderNotifs(); return; }
    try { ctx.state.convoyRequests = (await api.get(`${ctx.base}/convoy-requests`)).requests; } catch { /* not a member any more */ }
    renderNotifs();
  }
  async function loadTrades() {
    if (!gameOn()) { ctx.state.trades = []; renderNotifs(); return; }
    try { ctx.state.trades = (await api.get(`${ctx.base}/game/trades`)).trades; } catch { /* not a member any more */ }
    renderNotifs();
  }

  let lastKeys = null;
  function renderNotifs() {
    const list = items();
    const seen = new Set(prefs.notifSeen || []);
    const fresh = list.filter(i => !seen.has(i.key));
    const needs = list.filter(i => i.needs).length;
    const count = Math.max(needs, fresh.length);
    const btn = $('#notifBtn');
    $('#notifCount').textContent = count ? String(count) : '';
    btn.classList.toggle('has', count > 0);
    btn.title = needs ? `${needs} waiting for your answer` : 'Notifications';
    // Ping when something new arrives (not on the first render after loading).
    const keys = new Set(list.map(i => i.key));
    if (lastKeys) {
      const arrived = list.filter(i => !lastKeys.has(i.key) && !seen.has(i.key));
      if (arrived.length && $('#notifPanel').hidden) {
        btn.classList.remove('ring'); void btn.offsetWidth; btn.classList.add('ring');
        const i = arrived[0];
        toast(`${i.icon} ${i.text}`, 5000);
        ctx.notify(i.needs ? 'Needs your answer' : 'News', i.text);
      }
    }
    lastKeys = keys;
    if ($('#notifPanel').hidden) return;
    $('#notifList').innerHTML = list.map((i, n) => `<div class="nitem ${i.needs ? 'needs' : ''} ${seen.has(i.key) ? '' : 'new'}">
        <span class="nicon">${i.icon}</span>
        <div class="nbody"><div class="ntext">${esc(i.text)}</div>${i.sub ? `<div class="nsub">${esc(i.sub)}</div>` : ''}
          ${i.actions && i.actions.length ? `<div class="nacts">${i.actions.map((a, k) => `<button type="button" class="small ${a[2] || ''}" data-n="${n}" data-a="${k}">${esc(a[0])}</button>`).join('')}</div>` : ''}</div>
        ${i.info ? `<button type="button" class="ndismiss" data-dismiss="${esc(i.key)}" title="Dismiss">×</button>` : ''}
      </div>`).join('') || '<p class="muted" style="margin:10px">Nothing needs you right now.</p>';
    $('#notifList').querySelectorAll('[data-a]').forEach(b => b.onclick = () => list[Number(b.dataset.n)].actions[Number(b.dataset.a)][1]());
    $('#notifList').querySelectorAll('[data-dismiss]').forEach(b => b.onclick = () => { prefs.dismissed = [...new Set([...(prefs.dismissed || []), b.dataset.dismiss])].slice(-300); savePrefs(); renderNotifs(); });
    $('#notifTrade').hidden = !gameOn() || (!isGm() && !myFactionId());
  }
  function toggleNotifs(force) {
    const panel = $('#notifPanel');
    panel.hidden = force !== undefined ? !force : !panel.hidden;
    if (!panel.hidden) {
      renderNotifs();
      prefs.notifSeen = [...new Set([...(prefs.notifSeen || []), ...items().map(i => i.key)])].slice(-500);
      savePrefs();
      setTimeout(renderNotifs, 1200);   // the "new" highlight fades after a moment
    } else renderNotifs();
  }

  // ---- Trade dialog ------------------------------------------------------------------------------------
  const GOODS = () => [...(window.GameData?.RESOURCE_KEYS || []).map(k => [k, window.GameData.byKey[k].name]), ['money', 'Money'], ['manpower', 'Manpower'], ['rp', 'Research points']];
  function goodRow(listId) {
    const row = document.createElement('div');
    row.className = 'goodrow';
    row.innerHTML = `<select>${GOODS().map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}</select><input type="number" min="0" step="any" placeholder="0"><button type="button" class="small secondary" title="Remove">×</button>`;
    row.querySelector('button').onclick = () => row.remove();
    $(listId).appendChild(row);
  }
  function readGoods(listId) {
    const out = {};
    for (const row of $(listId).querySelectorAll('.goodrow')) {
      const k = row.querySelector('select').value, v = Number(row.querySelector('input').value);
      if (v > 0) out[k] = (out[k] || 0) + v;
    }
    return out;
  }
  function openTrade(toId) {
    const fs = factions(), mine = myFactionId();
    const opts = (exclude) => fs.filter(f => f.id !== exclude).map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    $('#tradeFromWrap').hidden = !isGm();
    $('#tradeFrom').innerHTML = opts(null);
    if (mine) $('#tradeFrom').value = String(mine);
    const syncTo = () => {
      const from = isGm() ? Number($('#tradeFrom').value) : mine;
      $('#tradeTo').innerHTML = opts(from);
      if (toId && toId !== from) $('#tradeTo').value = String(toId);
    };
    $('#tradeFrom').onchange = syncTo;
    syncTo();
    $('#tradeGive').innerHTML = ''; $('#tradeTake').innerHTML = '';
    goodRow('#tradeGive'); goodRow('#tradeTake');
    $('#tradeOnce').checked = true; $('#tradeTurns').value = 4; $('#tradeTurnsWrap').hidden = true; $('#tradeNote').value = '';
    $('#tradeModal').classList.add('open');
  }
  async function submitTrade(e) {
    e.preventDefault();
    const body = {
      fromFactionId: isGm() ? Number($('#tradeFrom').value) : undefined, toFactionId: Number($('#tradeTo').value),
      give: readGoods('#tradeGive'), take: readGoods('#tradeTake'),
      mode: $('#tradeRecurring').checked ? 'recurring' : 'once', turns: Number($('#tradeTurns').value) || 1, note: $('#tradeNote').value,
    };
    try {
      await api.post(`${ctx.base}/game/trades`, body);
      $('#tradeModal').classList.remove('open');
      toast('Trade offered: the other nation can accept it from their notifications');
      await loadTrades();
    } catch (err) { toast(err.message); }
  }

  // ---- Wiring --------------------------------------------------------------------------------------------
  async function init(c) {
    ctx = c;
    prefs = store.load();
    tab = prefs.tab || 'ooc';
    try { for (const ch of (await api.get(`${ctx.base}/chats`)).channels) channels.set(ch.id, ch); } catch { /* ignore */ }
    if (tab[0] === 'c' && !channels.has(Number(tab.slice(1)))) tab = 'ooc';
    $('#chatToggle').onclick = () => setOpen(!open);
    $('#chatMin').onclick = () => setOpen(false);
    $('#chatSend').onsubmit = send;
    $('#chatNew').onclick = () => { $('#chatNewPanel').hidden ? showNewChat() : ($('#chatNewPanel').hidden = true); };
    $('#chatNewCancel').onclick = () => { $('#chatNewPanel').hidden = true; };
    $('#chatNewGm').onclick = () => {
      const gms = ctx.state.members.filter(m => m.role === 'gm' && m.userId !== ctx.me.id).map(m => m.userId);
      if (!gms.length) { toast('You are the GM'); return; }
      startChat(gms, '');
    };
    $('#chatNewStart').onclick = () => {
      const ids = [...$('#chatNewList').querySelectorAll('input:checked')].map(i => Number(i.value));
      if (!ids.length) { toast('Pick at least one person'); return; }
      startChat(ids, $('#chatNewName').value.trim());
    };
    $('#notifBtn').onclick = e => { e.stopPropagation(); toggleNotifs(); };
    document.addEventListener('pointerdown', e => { if (!$('#notifPanel').hidden && !e.target.closest('#notifWrap')) toggleNotifs(false); });
    $('#notifTrade').onclick = () => openTrade();
    $('#tradeForm').onsubmit = submitTrade;
    $('#tradeAddGive').onclick = () => goodRow('#tradeGive');
    $('#tradeAddTake').onclick = () => goodRow('#tradeTake');
    for (const id of ['#tradeOnce', '#tradeRecurring']) $(id).onchange = () => { $('#tradeTurnsWrap').hidden = !$('#tradeRecurring').checked; };
    open = !!prefs.open;
    if (open) await openTab(tab); else renderChat();
    await loadTrades();
    await loadConvoyRequests();
  }

  function onEvent(e) {
    if (!['chat', 'roll', 'announce'].includes(e.kind)) return;
    if (!ctx.state.events.some(x => x.id === e.id)) ctx.state.events.push(e);
    const t = e.kind === 'announce' ? 'gm' : 'ooc';
    if (open && tab === t) markSeen(t);
    if (e.kind === 'announce' && e.userId !== ctx.me.id) { toast(`📣 GM: ${e.message}`, 6000); ctx.notify('GM announcement', e.message); }
    renderChat();
  }
  function onChatChannel(c) { channels.set(c.id, c); renderChat(); }
  function onChatMessage(m) {
    const c = channels.get(m.channelId);
    if (c) c.lastAt = Math.max(c.lastAt, m.createdAt);
    if (messages.has(m.channelId)) { const list = messages.get(m.channelId); if (!list.some(x => x.id === m.id)) list.push(m); }
    const t = `c${m.channelId}`;
    if (open && tab === t) markSeen(t);
    else if (m.userId && m.userId !== ctx.me.id) ctx.notify(`${m.displayName} (private)`, m.message);
    renderChat();
  }
  function onRelations() { renderNotifs(); }
  async function onTradesChanged(msg) {
    await loadTrades();
    if (msg && msg.treasury) ctx.GameUI.load().catch(() => {});
  }
  function refresh() { renderChat(); renderNotifs(); }

  return { init, onEvent, onChatChannel, onChatMessage, onRelations, onTradesChanged, refresh, loadTrades, loadConvoyRequests, openTrade, startChat };
})();

window.Comms = Comms;
