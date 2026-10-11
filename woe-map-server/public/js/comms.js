'use strict';
/* global api, esc, toast, fmtTime, fmtNum, GameData, ChatModel */

/**
 * Communications (docs/COMMS.md): the chat window (bottom right) and the notification centre (top centre).
 *
 * Chat: a window with the channels and people down the left and the conversation on the right. Channels are
 * OOC (everyone, with /roll), GM (announcements: everyone reads, only the GM writes) and private chats, which
 * start from the people list: click someone for a one-to-one, Shift-click several for a group. Every chat has
 * read receipts (who has read up to where), server-side unread counts (the same on every device), typing
 * notices, day dividers and a "New messages" line. After a reconnect the open chat catches up on what it missed.
 * GIFs come from KLIPY through the server (routes/klipy.js) when a key is set. Each message has a ⋯ menu: delete
 * (a site admin or the campaign's owner any message, anyone their own) and report the sender to the site admins.
 * Notifications: diplomacy needing an answer, war declarations and trades, answered from the list; Clear all dismisses
 * the notices that need none. Trades are offered from the Diplomacy panel (openTrade).
 *
 *   Comms.init(ctx)  ctx = { state, me, base, renderer, notify, GameUI }
 *   Comms.onChatChannel(c) / onChatMessage(m) / onChatRead(r) / onTyping(t) / resync()
 *   Comms.onRelations() / onTradesChanged(msg) / refresh()
 */
const Comms = (() => {
  let ctx = null;
  const $ = s => document.querySelector(s);
  const store = {
    key: () => `woe-comms-${ctx.state.lobby?.id}-${ctx.me.id}`,
    load() { try { return JSON.parse(localStorage.getItem(this.key()) || '{}'); } catch { return {}; } },
    save(v) { try { localStorage.setItem(this.key(), JSON.stringify(v)); } catch { /* private mode: the window forgets whether it was open */ } },
  };
  let prefs = {};          // { open, tab, big, notifSeen: [keys], dismissed: [keys] }
  const channels = new Map();     // key -> { key, kind: 'ooc'|'gm'|'private', id, name, members, lastAt, lastId, unread, myRead, reads: [{ userId, lastId, at }] }
  const messages = new Map();     // key -> { list: [message], more } (loaded on first open; messages come in ascending id)
  const typing = new Map();       // key -> Map(userId -> until ms)
  const picked = new Set();       // people Shift-clicked in the list, for a group chat
  let tab = 'ooc', open = false, big = false, side = false;
  let draft = null;               // { members, name }: a private chat that is created when its first message is sent (tab 'draft')
  const gifs = { enabled: false, open: false, q: '', list: [], page: 1, hasNext: false, loading: false };
  let report = null;              // { userId, channel, messageId, text }: a report being written (the bar above the messages)
  let newMark = 0;                // the first unread message when the tab was opened: the "New messages" line
  const drafts = new Map(), outgoing = new Map(), creating = new Map(), created = new Map(), creationTokens = new Map();
  const readTimers = new Map(), readPending = new Map(), readFlights = new Map(), readHold = new Set();
  const loads = new Map(), edits = new Map();
  let revision = 0, groupMode = false, groupName = '', findSeq = 0, findState = null;
  let mentionOptions = [], mentionIndex = 0, mentionStart = 0;
  const draftKey = () => ChatModel.draftKey(tab, draft);
  const uid = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
  function saveDraft() {
    const key = $('#chatMsg').dataset.draftKey;
    if (key) drafts.set(key, { ...(drafts.get(key) || {}), text: $('#chatMsg').value });
  }
  function restoreDraft() {
    const key = draftKey(), input = $('#chatMsg');
    input.dataset.draftKey = key; input.value = drafts.get(key)?.text || ''; autosize(); renderReply();
  }

  const isGm = () => ctx.state.role === 'gm';
  const gameOn = () => !!ctx.state.game?.enabled;
  const member = id => ctx.state.members.find(m => m.userId === id);
  const memberName = id => member(id)?.displayName || 'Someone';
  const memberColor = id => member(id)?.color || '#95a5a6';
  const online = id => (ctx.state.presence || []).some(u => u.id === id);
  const factions = () => (ctx.state.gameFactions || []).map(x => x.faction).filter(Boolean);
  const factionName = id => factions().find(f => f.id === id)?.name || (ctx.state.factions || []).find(f => f.id === id)?.name || '?';
  const myFactionId = () => ctx.state.myFactionId || null;
  const savePrefs = () => store.save(prefs);
  const initials = name => String(name || '?').trim().split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase();
  const nameClass = id => member(id)?.siteRole === 'admin' ? 'name-site-admin' : member(id)?.siteVip ? 'name-site-vip' : '';
  const avatarClass = id => member(id)?.siteRole === 'admin' ? 'site-admin' : member(id)?.siteVip ? 'site-vip' : '';
  const avatar = (id, cls = '') => `<span class="cav ${cls} ${avatarClass(id)}" style="background:${esc(memberColor(id))}" title="${esc(memberName(id))}">${member(id)?.avatarUrl ? `<img src="${esc(member(id).avatarUrl)}" alt="">` : esc(initials(memberName(id)))}</span>`;
  const flag = nation => {
    const f = (ctx.state.factions || []).find(x => x.name.toLowerCase() === String(nation || '').toLowerCase());
    return f?.flagUrl ? `<img class="flag" src="${esc(f.flagUrl)}" alt="">` : '';
  };
  const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function dayLabel(t) {
    const d = new Date(t), now = new Date(), day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  }
  /** Escaped text with its web addresses made links. */
  const linkify = ChatModel.linkify;

  // ---- Chat ---------------------------------------------------------------------------------------
  const chan = k => channels.get(k);
  const isDm = c => c.kind === 'private' && !c.name && c.members.length === 2;
  const dmWith = uid => [...channels.values()].find(c => isDm(c) && c.members.includes(uid) && c.members.includes(ctx.me.id));
  const sameMembers = (c, ids) => c.kind === 'private' && !c.name && c.members.length === ids.length && ids.every(id => c.members.includes(id));
  function channelTitle(c) {
    if (c.kind === 'ooc') return 'OOC';
    if (c.kind === 'gm') return 'GM announcements';
    if (c.name) return c.name;
    const others = c.members.filter(id => id !== ctx.me.id).map(memberName);
    return others.length ? others.join(', ') : 'Just you';
  }
  /** Reading this chat now: the window open on it, the page visible and focused. */
  const reading = k => open && !side && tab === k && document.visibilityState === 'visible' && document.hasFocus();
  function totalUnread() {
    let n = 0;
    for (const c of channels.values()) n += c.unread || 0;
    return n;
  }
  /** Take a channel from the server, keeping what we already know of it that the message did not carry. */
  function addChannel(c, authoritative = false) {
    const old = channels.get(c.key) || { unread: 0, myRead: 0, reads: [], lastId: 0 };
    channels.set(c.key, authoritative ? { ...old, ...c } : { ...old, ...c, unread: c.unread ?? old.unread, myRead: c.myRead ?? old.myRead, reads: c.reads ?? old.reads, lastId: c.lastId ?? old.lastId });
  }

  /** The Chat button: the sealed letter while something waits, the open one when nothing does. */
  function renderBadge() {
    const total = totalUnread();
    const badge = $('#chatBadge');
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.hidden = !total;
    const icon = $('#chatIcon'), src = total ? '/icons/mail-new.png' : '/icons/mail-read.png';
    if (icon.getAttribute('src') !== src) icon.setAttribute('src', src);
    $('#chatToggle').classList.toggle('has', total > 0);
    $('#chatToggle').classList.toggle('active', open);
    $('#chatToggle').title = total ? `Chat: ${total} unread` : 'Chat: OOC, GM announcements and private chats';
    const mentions = [...channels.values()].reduce((n, c) => n + (c.mentions || 0), 0);
    $('#chatMentionBadge').hidden = !mentions;
    $('#chatMentionBadge').textContent = `@ ${mentions}`;
  }
  function renderChat() {
    renderBadge();
    $('#chatWin').hidden = !open;
    if (!open) return;
    $('#chatWin').classList.toggle('big', big);
    $('#chatWin').classList.toggle('show-side', side);
    renderSide(); renderHead(); renderPick(); renderReport(); renderBody(); renderComposer(); renderGifs(); renderReply(); renderOutgoing();
  }
  /** Who may delete a message: a site admin, the campaign's owner, or its author. */
  const canDelete = m => ctx.me.role === 'admin' || ctx.state.lobby?.ownerId === ctx.me.id || m.userId === ctx.me.id;
  /** A message's body: its GIF, "(message deleted)", or its text with links. */
  function content(m) {
    if (m.data?.deleted) return `<div class="text del">(message deleted${m.data.deleted.by !== m.userId && m.data.deleted.byName ? ` by ${esc(m.data.deleted.byName)}` : ''})</div>`;
    const g = m.data?.gif;
    const body = g ? `<a class="cgif" href="${esc(g.url)}" target="_blank" rel="noopener" title="${esc(g.title || 'GIF')}"><img src="${esc(g.url)}" alt="${esc(g.title || 'GIF')}" ${g.w && g.h ? `style="aspect-ratio:${g.w}/${g.h}"` : ''} loading="lazy"></a>` : `<div class="text">${ChatModel.textHtml(m, ctx.me.id)}</div>`;
    return `${m.reply ? `<button type="button" class="chat-quote" data-jump="${m.reply.id}">${esc(m.reply.name)}: ${esc(m.reply.text)}</button>` : ''}${body}${m.pinned ? '<span class="chat-pin">Pinned</span>' : ''}`;
  }
  const menuBtn = m => (m.data?.deleted || !m.userId) ? '' : `<button type="button" class="cmenu" data-mid="${m.id}" aria-label="Actions for message from ${esc(m.displayName)}" aria-haspopup="menu" title="Message actions">⋯</button>`;

  function renderSide() {
    const list = [...channels.values()];
    const row = (c, icon, label, sub, key = c.key) => `<button type="button" class="crow ${tab === key ? 'on' : ''}" data-chan="${key}">
      <span class="cic">${icon}</span><span class="clab"><span class="cname">${label}</span>${sub ? `<span class="csub">${sub}</span>` : ''}</span>${c.unread ? `<span class="cnt">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</button>`;
    const rooms = ['ooc', 'gm'].map(k => chan(k)).filter(Boolean)
      .map(c => row(c, c.kind === 'ooc' ? '#' : '📣', c.kind === 'ooc' ? 'OOC' : 'GM', c.kind === 'ooc' ? 'everyone · /roll' : 'announcements'));
    const groups = list.filter(c => c.kind === 'private' && !isDm(c)).sort((a, b) => b.lastAt - a.lastAt)
      .map(c => row(c, '🔒', esc(channelTitle(c)), esc(c.members.filter(id => id !== ctx.me.id).map(memberName).join(', '))));
    const rank = m => (m.role === 'gm' ? 0 : 2) + (online(m.userId) ? 0 : 1);
    const others = ctx.state.members.filter(m => m.userId !== ctx.me.id).sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
    const people = others.map(m => {
      const dm = dmWith(m.userId), on = tab === (dm ? dm.key : 'draft') && (dm || (draft && draft.members.length === 1 && draft.members[0] === m.userId));
      const sub = m.role === 'gm' ? 'Game master' : `${flag(m.nation)} ${esc(m.nation || 'player')}`;
      return `<button type="button" class="prow ${picked.has(m.userId) ? 'picked' : ''} ${on ? 'on' : ''}" data-person="${m.userId}" ${groupMode ? `aria-pressed="${picked.has(m.userId)}"` : ''} title="${esc(m.displayName)}: ${groupMode ? 'select for this group' : 'click to message, Shift-click to pick several for a group'}">
        ${avatar(m.userId)}<span class="pdot ${online(m.userId) ? 'on' : ''}"></span><span class="clab"><span class="cname ${nameClass(m.userId)}">${esc(m.displayName)}</span><span class="csub">${sub}</span></span>
        ${picked.has(m.userId) ? '<span class="tick">✓</span>' : dm?.unread ? `<span class="cnt">${dm.unread}</span>` : ''}</button>`;
    });
    const nOn = others.filter(m => online(m.userId)).length;
    $('#chatSide').innerHTML = `<button type="button" id="chatNewGroup" class="small secondary">${groupMode ? 'Cancel group' : 'New group'}</button><div class="sh">Channels</div>${rooms.join('')}
      ${groups.length ? `<div class="sh">Groups</div>${groups.join('')}` : ''}
      <div class="sh">People <span class="hint">${nOn} online</span></div>${people.join('') || '<p class="hint" style="padding:0 8px">No one else has joined yet.</p>'}${groupMode ? '<button type="button" class="small secondary" id="chatPickDone">Done selecting</button>' : ''}`;
    $('#chatSide').querySelectorAll('[data-chan]').forEach(b => b.onclick = () => openTab(b.dataset.chan));
    $('#chatNewGroup').onclick = () => { groupMode = !groupMode; picked.clear(); groupName = ''; renderChat(); };
    if (groupMode) $('#chatPickDone').onclick = () => { side = false; $('#chatWin').classList.remove('show-side'); $('#chatPick input').focus(); };
    $('#chatSide').querySelectorAll('[data-person]').forEach(b => b.onclick = e => {
      const id = Number(b.dataset.person);
      if (groupMode || e.shiftKey || e.ctrlKey || e.metaKey) { groupMode = true; if (picked.has(id)) picked.delete(id); else picked.add(id); renderChat(); }
      else openPerson(id);
    });
    $('#chatSide').querySelectorAll('[data-person]').forEach(b => b.oncontextmenu = e => { e.preventDefault(); startReport(Number(b.dataset.person)); });
  }
  /** The bar for a group in the making: who is picked, a name, Start. */
  function renderPick() {
    const el = $('#chatPick');
    el.hidden = !groupMode;
    if (!groupMode) { el.dataset.signature = ''; return; }
    const signature = [...picked].join(',');
    if (el.dataset.signature === signature && el.children.length) return;
    el.dataset.signature = signature;
    const name = groupName;
    el.innerHTML = `<span class="hint">Group with</span>${[...picked].map(id => `<span class="chip" style="border-color:${esc(memberColor(id))}">${esc(memberName(id))}<button type="button" data-unpick="${id}" title="Remove">×</button></span>`).join('')}
      <span class="hint">Select people from the list.</span><input aria-label="Group name" maxlength="60" placeholder="Name (optional)" value="${esc(name)}"><button type="button" class="small" id="chatPickStart" ${picked.size ? '' : 'disabled'}>Start chat</button><button type="button" class="small secondary" id="chatPickClear">Cancel</button>`;
    el.querySelector('input').oninput = e => { groupName = e.target.value; };
    el.querySelectorAll('[data-unpick]').forEach(b => b.onclick = () => { picked.delete(Number(b.dataset.unpick)); renderChat(); });
    $('#chatPickStart').onclick = () => startPicked(el.querySelector('input').value.trim());
    $('#chatPickClear').onclick = () => { picked.clear(); groupMode = false; groupName = ''; renderChat(); };
    el.querySelector('input').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); startPicked(e.target.value.trim()); } };
  }
  function renderHead() {
    const nOn = (ctx.state.presence || []).length;
    let html = '';
    if (tab === 'draft' && draft) {
      html = `<span class="ct">🔒 ${esc(draft.name || draft.members.map(memberName).join(', '))}</span><span class="cs">New private chat · ${draft.members.length + 1} people · created when you send</span>`;
    } else {
      const c = chan(tab);
      if (!c) html = '';
      else if (c.kind === 'ooc') html = `<span class="ct"># OOC</span><span class="cs">Everyone in the campaign · ${nOn} online · /roll 2d6+1 works here</span>`;
      else if (c.kind === 'gm') html = `<span class="ct">📣 GM announcements</span><span class="cs">${isGm() ? 'Everyone reads what you post here' : 'Only the GM posts here'}</span>`;
      else html = `<span class="ct">🔒 ${esc(channelTitle(c))}</span><span class="cs">${c.members.map(id => `<span style="color:${esc(memberColor(id))}">${esc(memberName(id))}</span>`).join(', ')}</span>`;
    }
    $('#chatHead').innerHTML = html;
    const c = chan(tab);
    $('#chatLeave').hidden = !(c && c.kind === 'private');
    $('#chatTools').hidden = !c;
    if (c) $('#chatNotifyMode').value = c.notifications || 'all';
  }
  function renderBody() {
    const body = $('#chatBody');
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40, sameTab = body.dataset.tab === tab;
    const c = tab === 'draft' ? null : chan(tab);
    const page = c && messages.get(tab);
    const list = page ? page.list : [];
    // Read receipts: each other member's mark goes under the last message they have read.
    const seenAt = new Map();
    if (c) for (const r of c.reads || []) {
      let target = null;
      for (const m of list) { if (m.id <= r.lastId) target = m; else break; }
      if (target) { if (!seenAt.has(target.id)) seenAt.set(target.id, []); seenAt.get(target.id).push(r.userId); }
    }
    const others = c ? c.members.filter(id => id !== ctx.me.id) : [];
    const readBy = id => others.filter(uid => ((c.reads || []).find(r => r.userId === uid)?.lastId || 0) >= id);
    let html = '';
    if (tab === 'draft' && draft) {
      html = `<div class="chat-empty"><div class="cavs">${draft.members.map(id => avatar(id, 'big')).join('')}</div>
        <p class="muted">No messages yet. The chat is created, and the others see it, when you send the first one.</p></div>`;
    } else if (!c) html = '<p class="muted chat-empty">Pick a channel or a person on the left.</p>';
    else if (!page) html = '<p class="muted chat-empty">Loading…</p>';
    else {
      if (page.more) html += '<div class="cmore"><button type="button" class="small secondary" id="chatMore">Load earlier messages</button></div>';
      if (page.error) html += '<button type="button" class="small secondary" id="chatReload">Could not load messages — retry</button>';
      let prev = null, day = '', marked = false;
      for (const m of list) {
        const d = dayLabel(m.createdAt);
        if (d !== day) { day = d; html += `<div class="cday"><span>${d}</span></div>`; prev = null; }
        if (newMark && !marked && m.id >= newMark) { html += '<div class="cnew"><span>New messages</span></div>'; marked = true; prev = null; }
        const own = m.userId === ctx.me.id;
        if (m.kind === 'roll') {
          html += `<div class="cmsg roll" data-message="${m.id}">${avatar(m.userId)}<div class="line"><span class="who ${nameClass(m.userId)}" style="${nameClass(m.userId) ? '' : `color:${esc(memberColor(m.userId))}`}">${esc(m.displayName)}</span> ${content(m)}<span class="when">${clock(m.createdAt)}</span>${menuBtn(m)}</div></div>`;
          prev = null;
        } else if (!m.userId || m.kind === 'system') {
          html += `<div class="cmsg sys" data-message="${m.id}">${esc(m.message)}<span class="when">${clock(m.createdAt)}</span></div>`;
          prev = null;
        } else if (m.kind === 'announce') {
          html += `<div class="cmsg announce" data-message="${m.id}"><div class="line">📣 <span class="who ${nameClass(m.userId)}">${esc(m.displayName)}</span><span class="when">${clock(m.createdAt)}</span>${content(m)}${menuBtn(m)}</div></div>`;
          prev = null;
        } else {
          const cont = prev && prev.userId === m.userId && m.createdAt - prev.createdAt < 5 * 60000;
          const all = own && others.length > 0 && readBy(m.id).length === others.length;
          const ticks = own ? `<span class="ticks ${all ? 'all' : ''}" title="${all ? 'Read by everyone' : others.length ? `Read by ${readBy(m.id).length} of ${others.length}` : 'Sent'}">${all ? '✓✓' : '✓'}</span>` : '';
          html += `<div data-message="${m.id}" class="cmsg ${own ? 'own' : ''} ${cont ? 'cont' : ''} ${m.data?.gif ? 'gif' : ''}">${own ? '' : cont ? '<span class="cav gap"></span>' : avatar(m.userId)}
            <div class="bubble">${cont || own ? '' : `<span class="who ${nameClass(m.userId)}" style="${nameClass(m.userId) ? '' : `color:${esc(memberColor(m.userId))}`}">${esc(m.displayName)}</span>`}${content(m)}<span class="when">${clock(m.createdAt)}${ticks}</span>${menuBtn(m)}</div></div>`;
          prev = m;
        }
        const seen = seenAt.get(m.id);
        if (seen) html += `<div class="seenby" title="Seen by ${esc(seen.map(memberName).join(', '))}">${seen.map(id => avatar(id, 'mini')).join('')}</div>`;
      }
      if (page.newer) html += '<div class="cmore"><button type="button" class="small secondary" id="chatLater">Load newer messages</button></div>';
      if (!list.length && !page.error) html = `<p class="muted chat-empty">${c.kind === 'gm' ? 'No announcements yet.' : 'No messages yet.'}</p>`;
    }
    // Receipts and presence updates need not recreate unchanged bubbles or restart GIFs.
    if (body._html === html && sameTab) { renderTyping(); updateJump(); return; }
    const scroll = body.scrollTop;
    body.innerHTML = html; body._html = html;
    if ($('#chatMore')) $('#chatMore').onclick = loadEarlier;
    if ($('#chatLater')) $('#chatLater').onclick = loadLater;
    if ($('#chatReload')) $('#chatReload').onclick = async () => { await loadPage(tab); renderChat(); };
    body.querySelectorAll('.cmenu').forEach(b => b.onclick = e => { e.stopPropagation(); openMenu(list.find(m => m.id === Number(b.dataset.mid)), b); });
    body.querySelectorAll('[data-jump]').forEach(b => b.onclick = () => jumpTo(Number(b.dataset.jump)));
    if (!sameTab) {
      const mark = body.querySelector('.cnew'); body.scrollTop = 0;
      body.scrollTop = mark ? Math.max(0, mark.getBoundingClientRect().top - body.getBoundingClientRect().top - 20) : body.scrollHeight;
    }
    else if (atBottom) body.scrollTop = body.scrollHeight;
    else body.scrollTop = scroll;
    body.dataset.tab = tab;
    renderTyping(); updateJump();
  }
  /** The ⋯ menu by a message: delete it, report its sender. */
  function openMenu(m, btn) {
    const menu = $('#chatMenu');
    if (!m) return;
    const items = [];
    if (chan(tab)?.kind !== 'gm' || isGm()) items.push('<button type="button" role="menuitem" data-act="reply">Reply</button>');
    items.push('<button type="button" role="menuitem" data-act="unread">Mark unread from here</button>');
    if (chan(tab)?.kind === 'private' || isGm()) items.push(`<button type="button" role="menuitem" data-act="pin">${m.pinned ? 'Unpin' : 'Pin message'}</button>`);
    if (canDelete(m)) items.push(`<button type="button" data-act="delete">Delete message</button>`);
    if (m.userId !== ctx.me.id) items.push(`<button type="button" data-act="report">Report ${esc(memberName(m.userId))}…</button>`);
    if (!items.length) return;
    menu.innerHTML = items.join('');
    menu.hidden = false;
    const r = btn.getBoundingClientRect(), w = menu.offsetParent.getBoundingClientRect();
    menu.style.top = `${Math.max(4, Math.min(r.bottom - w.top + 2, w.height - menu.offsetHeight - 4))}px`;
    menu.style.left = `${Math.max(4, Math.min(r.left - w.left, w.width - menu.offsetWidth - 4))}px`;
    menu.querySelectorAll('button').forEach(b => b.setAttribute('role', 'menuitem'));
    menu.querySelector('button')?.focus();
    menu.onkeydown = e => {
      const buttons = [...menu.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); menu.hidden = true; btn.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); buttons[(index + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); }
    };
    menu.querySelector('[data-act="reply"]')?.addEventListener('click', () => { menu.hidden = true; saveDraft(); drafts.set(draftKey(), { ...(drafts.get(draftKey()) || {}), reply: m }); renderReply(); $('#chatMsg').focus(); });
    menu.querySelector('[data-act="unread"]')?.addEventListener('click', () => { menu.hidden = true; markUnread(m); });
    menu.querySelector('[data-act="pin"]')?.addEventListener('click', async () => {
      menu.hidden = true;
      try { const d = await api.post(`${ctx.base}/chats/${m.channel}/messages/${m.id}/pin`, { pinned: !m.pinned }); ingest(d.message, true); renderChat(); }
      catch (e) { toast(e.message); }
    });
    menu.querySelector('[data-act="delete"]')?.addEventListener('click', () => { menu.hidden = true; deleteMessage(m); });
    menu.querySelector('[data-act="report"]')?.addEventListener('click', () => { menu.hidden = true; startReport(m.userId, m); });
  }
  async function deleteMessage(m) {
    if (!confirm('Delete this message for everyone in the chat?')) return;
    try { const d = await api.del(`${ctx.base}/chats/${m.channel}/messages/${m.id}`); if (d.message) ingest(d.message, true); renderChat(); }
    catch (err) { toast(err.message); }
  }
  /** Report a member to the site admins, about a message or in general; the bar above the conversation takes the reason. */
  function startReport(userId, m = null) {
    report = { userId, channel: m ? m.channel : '', messageId: m ? m.id : null, text: m ? (m.data?.gif ? `GIF: ${m.data.gif.title || ''}` : m.message) : '' };
    $('#chatReport').replaceChildren();
    renderReport();
    $('#chatReport textarea')?.focus();
  }
  function renderReport() {
    const el = $('#chatReport');
    el.hidden = !report;
    if (!report) { el.replaceChildren(); return; }
    if (el.querySelector('textarea')) return; // Incoming messages must not steal the report field's focus.
    const reason = el.querySelector('textarea')?.value || '';
    el.innerHTML = `<div class="rhead"><b>Report ${esc(memberName(report.userId))}</b> <span class="hint">to the site admins</span></div>
      ${report.text ? `<blockquote>${esc(report.text.slice(0, 300))}</blockquote>` : ''}
      <textarea aria-label="Reason for reporting" rows="2" maxlength="500" placeholder="What happened?">${esc(reason)}</textarea>
      <div class="racts"><button type="button" class="small" id="chatReportSend">Send report</button><button type="button" class="small secondary" id="chatReportCancel">Cancel</button></div>`;
    $('#chatReportCancel').onclick = () => { report = null; renderReport(); };
    $('#chatReportSend').onclick = async () => {
      const text = el.querySelector('textarea').value.trim();
      if (!text) { toast('Say what the report is about'); return; }
      try {
        await api.post(`${ctx.base}/reports`, { userId: report.userId, reason: text, channel: report.channel || undefined, messageId: report.messageId || undefined });
        toast('Reported to the site admins');
        report = null; renderReport();
      } catch (err) { toast(err.message); }
    };
  }
  // ---- GIFs (KLIPY, through the server) --------------------------------------------------------------------
  function renderGifs() {
    const el = $('#chatGifs');
    el.hidden = !gifs.open;
    $('#chatGif').classList.toggle('on', gifs.open);
    if (!gifs.open) return;
    const grid = $('#chatGifGrid');
    grid.innerHTML = gifs.list.map((g, i) => `<button type="button" class="gtile" data-i="${i}" title="${esc(g.title)}"><img src="${esc(g.preview.url)}" alt="${esc(g.title)}" loading="lazy"></button>`).join('')
      || `<p class="hint">${gifs.loading ? 'Looking…' : gifs.q ? 'Nothing found.' : 'Nothing trending right now.'}</p>`;
    grid.querySelectorAll('.gtile').forEach(b => b.onclick = () => sendGif(gifs.list[Number(b.dataset.i)]));
    $('#chatGifMore').hidden = !gifs.hasNext || gifs.loading;
    $('#chatGifHead').textContent = gifs.q ? `GIFs for "${gifs.q}"` : 'Trending GIFs';
  }
  let gifTimer = 0, gifSeq = 0;
  async function loadGifs(more = false) {
    const seq = ++gifSeq;
    gifs.loading = true; if (!more) { gifs.list = []; gifs.page = 1; } else gifs.page++;
    renderGifs();
    try {
      const d = await api.get(gifs.q ? `/api/klipy/search?q=${encodeURIComponent(gifs.q)}&page=${gifs.page}` : `/api/klipy/trending?page=${gifs.page}`);
      if (seq !== gifSeq) return;
      gifs.list = more ? [...gifs.list, ...d.gifs] : d.gifs; gifs.hasNext = d.hasNext;
    } catch (err) { if (seq === gifSeq) toast(err.message); }
    if (seq === gifSeq) { gifs.loading = false; renderGifs(); }
  }
  function toggleGifs(on = !gifs.open) {
    gifs.open = on;
    if (on && !gifs.list.length && !gifs.q) loadGifs();
    renderGifs();
    if (on) $('#chatGifQ').focus();
  }
  async function sendGif(g) {
    if (!g) return;
    toggleGifs(false);
    queueSend({ gif: { url: g.full.url, preview: g.preview.url, w: g.full.w, h: g.full.h, title: g.title } });
  }
  function renderTyping() {
    const now = Date.now(), t = typing.get(tab);
    const names = t ? [...t.entries()].filter(([, until]) => until > now).map(([id]) => memberName(id)) : [];
    $('#chatTyping').textContent = !names.length ? '' : names.length === 1 ? `${names[0]} is typing…` : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : 'Several people are typing…';
  }
  function renderComposer() {
    const c = chan(tab);
    const canWrite = tab === 'draft' ? !!draft : !!c && (c.kind !== 'gm' || isGm());
    $('#chatSend').hidden = !canWrite;
    $('#chatReadOnly').hidden = canWrite;
    $('#chatGif').hidden = !canWrite || !gifs.enabled;
    if (!canWrite && gifs.open) { gifs.open = false; }
    $('#chatMsg').placeholder = tab === 'draft' ? 'Say hello…' : c?.kind === 'ooc' ? 'Message everyone… (/roll 2d6+1)' : c?.kind === 'gm' ? 'Announce to everyone…' : 'Private message…';
  }

  async function openTab(k, target = null) {
    const changed = k !== tab || !!target, needsLoad = k !== 'draft' && !messages.get(k)?.loaded;
    saveDraft();
    if (target) draft = target;
    if (k !== 'draft') draft = null;
    tab = k; prefs.tab = k; savePrefs(); side = false; newMark = 0;
    readHold.delete(k); findState = null; findSeq++; $('#chatFind').hidden = true; $('#chatMenu').hidden = true; hideMentions(); restoreDraft();
    const c = chan(k);
    if (c) {
      if (!messages.get(k)?.loaded) { renderChat(); await loadPage(k); if (tab !== k) return; }
      const first = (messages.get(k)?.list || []).find(m => m.id > (c.myRead || 0) && m.userId !== ctx.me.id);
      newMark = first ? first.id : 0;
    }
    if (changed || needsLoad) $('#chatBody').dataset.tab = '';
    renderChat();
    markRead();
    if (window.matchMedia('(min-width: 761px)').matches) $('#chatMsg').focus();
  }
  async function loadPage(k) {
    if (loads.has(k)) return loads.get(k);
    const promise = (async () => {
      const c = chan(k), start = revision, p = messages.get(k) || { list: [] };
      messages.set(k, p);
      const unread = c?.unread > 0;
      try {
        const d = await api.get(`${ctx.base}/chats/${k}/messages?limit=60${unread ? `&after=${c.myRead || 0}` : ''}`);
        mergePage(k, d.messages, start);
        if (unread && d.more) p.list = p.list.filter(m => m.id <= (d.messages.at(-1)?.id || 0));
        Object.assign(p, { more: unread ? (c.myRead || 0) > 0 : d.more, newer: unread && d.more, loaded: true, error: false });
      } catch (err) { p.error = true; p.loaded = false; toast(err.message); }
    })();
    loads.set(k, promise);
    try { await promise; } finally { loads.delete(k); }
  }
  function mergePage(k, incoming, start) {
    const p = messages.get(k) || { list: [], more: true, loaded: false };
    const live = p.list.filter(m => (edits.get(`${k}:${m.id}`) || 0) > start);
    p.list = ChatModel.merge(ChatModel.merge(p.list, incoming), live); messages.set(k, p);
  }
  async function loadEarlier() {
    const k = tab, p = messages.get(k), first = p?.list[0], start = revision;
    if (!first || p.busy) return;
    p.busy = true;
    const body = $('#chatBody'), h0 = body.scrollHeight;
    try {
      const d = await api.get(`${ctx.base}/chats/${k}/messages?limit=60&before=${first.id}`);
      mergePage(k, d.messages, start);
      p.more = d.more;
      if (tab === k) { renderBody(); body.scrollTop += body.scrollHeight - h0; }
    } catch (err) { toast(err.message); } finally { p.busy = false; }
  }
  async function loadLater() {
    const k = tab, p = messages.get(k), last = p?.list.at(-1), start = revision;
    if (!last || p.busy) return;
    p.busy = true;
    try {
      const d = await api.get(`${ctx.base}/chats/${k}/messages?limit=60&after=${last.id}`);
      mergePage(k, d.messages, start); p.newer = d.more || (chan(k)?.lastId || 0) > (p.list.at(-1)?.id || 0);
      if (tab === k) { renderBody(); markRead(); }
    } catch (e) { toast(e.message); } finally { p.busy = false; }
  }
  function openPerson(id) {
    const dm = dmWith(id);
    picked.clear();
    if (dm) return openTab(dm.key);
    return openTab('draft', { members: [id], name: '' });
  }
  function startPicked(name) {
    const ids = [...picked];
    if (!ids.length) return;
    picked.clear(); groupMode = false; groupName = '';
    const have = !name && [...channels.values()].find(c => sameMembers(c, [ctx.me.id, ...ids]));
    if (have) return openTab(have.key);
    return openTab('draft', { members: ids, name });
  }
  function setOpen(on) {
    saveDraft(); open = on; prefs.open = on; savePrefs();
    if (on) openTab(tab === 'draft' && draft ? 'draft' : chan(tab) ? tab : 'ooc'); else renderChat();
  }
  async function leaveTab() {
    const c = chan(tab);
    if (!c || c.kind !== 'private') return;
    if (!confirm(`Leave "${channelTitle(c)}"? You will no longer see its messages.`)) return;
    try { await api.post(`${ctx.base}/chats/${c.key}/leave`, {}); channels.delete(c.key); messages.delete(c.key); openTab('ooc'); }
    catch (err) { toast(err.message); }
  }

  /** Acknowledge only messages actually displayed in the viewport, separately per conversation. */
  function markRead() {
    const c = chan(tab);
    const page = messages.get(tab);
    if (!c || !reading(tab) || readHold.has(tab) || !page?.loaded || page.syncing || page.error) return;
    const bounds = $('#chatBody').getBoundingClientRect();
    const visible = [...$('#chatBody').querySelectorAll('[data-message]')].filter(el => { const r = el.getBoundingClientRect(); return r.top < bounds.bottom && r.bottom > bounds.top; });
    const last = Math.max(0, ...visible.map(el => Number(el.dataset.message)));
    if (last <= (c.myRead || 0)) return;
    readPending.set(c.key, Math.max(last, readPending.get(c.key) || 0));
    if (!readTimers.has(c.key)) readTimers.set(c.key, setTimeout(() => { readTimers.delete(c.key); flushRead(c.key); }, 300));
  }
  async function flushRead(k) {
    if (readFlights.has(k) || readHold.has(k)) return;
    const last = readPending.get(k); if (!last) return;
    const task = (async () => {
      try {
        const start = revision, d = await api.post(`${ctx.base}/chats/${k}/read`, { lastId: last });
        const c = chan(k); if (!c) return;
        c.myRead = Math.max(c.myRead || 0, d.lastId);
        if (revision === start && d.channel) { c.unread = d.channel.unread; c.mentions = d.channel.mentions; }
        else if (c.myRead >= c.lastId) { c.unread = 0; c.mentions = 0; }
        if ((readPending.get(k) || 0) <= d.lastId) readPending.delete(k);
        renderBadge(); if (open) renderSide();
      } catch { /* Keep pending acknowledgements for focus/reconnect retry. */ }
    })();
    readFlights.set(k, task);
    await task; readFlights.delete(k);
    if ((readPending.get(k) || 0) > last) flushRead(k);
  }
  async function markUnread(m) {
    const k = m.channel;
    readHold.add(k); clearTimeout(readTimers.get(k)); readTimers.delete(k); readPending.delete(k);
    await readFlights.get(k);
    try { const d = await api.post(`${ctx.base}/chats/${k}/unread`, { beforeId: m.id }); addChannel(d.channel, true); if (tab === k) setOpen(false); else renderBadge(); }
    catch (e) { readHold.delete(k); toast(e.message); }
  }

  /** A message in (from the socket or our own send): into its page, counts and marks. True when it is new to us. */
  function ingest(m, update = false) {
    const c = chan(m.channel);
    if (!c) { if (m.channel[0] === 'c') resync(); return false; }   // a chat we had not heard of: fetch the list
    const fresh = !update && !m.data?.deleted && m.id > (c.lastId || 0);
    const p = messages.get(m.channel) || { list: [], more: true, loaded: false };
    edits.set(`${m.channel}:${m.id}`, ++revision);
    // Do not stitch a live message across an unloaded history gap.
    if (!p.newer || p.list.some(x => x.id === m.id)) p.list = ChatModel.merge(p.list, [m]);
    messages.set(m.channel, p);
    if (m.data?.deleted) for (const msg of p.list) if (msg.reply?.id === m.id) msg.reply.text = '(message deleted)';
    if (m.id > (c.lastId || 0)) c.lastId = m.id;
    c.lastAt = Math.max(c.lastAt || 0, m.createdAt);
    const mine = m.userId === ctx.me.id;
    if (!mine && fresh) {
      c.unread = (c.unread || 0) + 1;
      if (m.data?.mentions?.some(x => x.userId === ctx.me.id)) c.mentions = (c.mentions || 0) + 1;
    }
    if (m.data?.clientId) outgoing.delete(m.data.clientId);
    if (m.userId) typing.get(m.channel)?.delete(m.userId);
    return fresh;
  }
  let typedAt = 0;
  function sendTyping() {
    const now = Date.now();
    if (tab === 'draft' || !chan(tab) || now - typedAt < 2000) return;
    typedAt = now;
    const ws = ctx.state.ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'typing', channel: tab }));
  }
  function autosize() {
    const ta = $('#chatMsg');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }
  async function send(e) {
    if (e) e.preventDefault();
    const input = $('#chatMsg'), message = input.value.trim();
    if (!message) return;
    queueSend({ message });
  }
  function queueSend(payload) {
    if (tab === 'gm' && !isGm()) return;
    saveDraft(); const context = draftKey(), reply = drafts.get(context)?.reply;
    const item = { id: uid(), context, channel: tab, target: draft ? { ...draft, members: [...draft.members] } : null, payload: { ...payload, ...(reply ? { replyTo: reply.id } : {}) }, status: 'pending' };
    if (payload.message) { drafts.set(context, {}); $('#chatMsg').value = ''; autosize(); typedAt = 0; hideMentions(); }
    else if (reply) { const saved = drafts.get(context); delete saved.reply; renderReply(); }
    outgoing.set(item.id, item); transmit(item);
  }
  async function ensureChannel(item) {
    if (item.channel !== 'draft') return item.channel;
    if (created.has(item.context)) return created.get(item.context);
    if (!creating.has(item.context)) {
      if (!creationTokens.has(item.context)) creationTokens.set(item.context, `group:${item.id}`);
      const token = creationTokens.get(item.context);
      creating.set(item.context, api.post(`${ctx.base}/chats`, { ...item.target, clientId: token }).then(d => { addChannel(d.channel); created.set(item.context, d.channel.key); return d.channel.key; }));
    }
    try { return await creating.get(item.context); } finally { creating.delete(item.context); }
  }
  async function transmit(item) {
    if (item.sending) return;
    item.sending = true; item.status = 'pending'; renderOutgoing();
    try {
      const key = await ensureChannel(item); item.channel = key;
      // A slow response must never switch a user back from another conversation.
      if (draftKey() === item.context && tab === 'draft') {
        saveDraft(); drafts.set(key, drafts.get(item.context) || {}); draft = null; tab = key; prefs.tab = key; savePrefs(); restoreDraft();
      }
      const d = await api.post(`${ctx.base}/chats/${key}/messages`, { ...item.payload, clientId: item.id });
      ingest(d.message); outgoing.delete(item.id);
      if (tab === key) { if (!messages.get(key)?.loaded) await loadPage(key); renderChat(); markRead(); }
      else renderBadge();
    } catch (err) { item.status = 'failed'; item.error = err.message; }
    finally { item.sending = false; renderOutgoing(); }
  }
  function renderOutgoing() {
    const el = $('#chatOutgoing'), list = [...outgoing.values()].filter(x => x.channel === tab || x.context === draftKey());
    el.hidden = !list.length;
    el.innerHTML = list.map(x => `<div><span>${esc((x.payload.message || `GIF: ${x.payload.gif?.title || ''}`).slice(0, 100))}</span> <span role="status">${x.status === 'pending' ? 'Sending…' : `Not sent: ${esc(x.error)}`}</span>${x.status === 'failed' ? `<button type="button" data-retry="${x.id}">Retry</button><button type="button" data-discard="${x.id}">Dismiss</button>` : ''}</div>`).join('');
    el.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => transmit(outgoing.get(b.dataset.retry)));
    el.querySelectorAll('[data-discard]').forEach(b => b.onclick = () => { outgoing.delete(b.dataset.discard); renderOutgoing(); });
  }
  /** Fetch the chats afresh (unread counts, read marks, new chats) and catch the open one up on what it missed. */
  let syncing = null;
  function resync() {
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const start = revision, d = await api.get(`${ctx.base}/chats`);
        const seen = new Set();
        for (const c of d.channels) {
          seen.add(c.key);
          const live = chan(c.key);
          if (live && revision !== start && live.lastId > c.lastId) { c.lastId = live.lastId; c.unread = live.unread; c.mentions = live.mentions; }
          addChannel(c, true);
        }
        for (const k of [...channels.keys()]) if (!seen.has(k)) { channels.delete(k); messages.delete(k); }
        for (const k of [...messages.keys()]) {
          const p = messages.get(k), first = p.list[0];
          if (k !== tab || !first || !p.loaded) { messages.delete(k); continue; }
          p.syncing = true;
          try {
            // Re-fetch the retained range too: deletions and pins use existing IDs.
            let after = first.id - 1;
            const through = chan(k).lastId;
            do {
              const stamp = revision;
              const r = await api.get(`${ctx.base}/chats/${k}/messages?after=${after}&before=${through + 1}&limit=200`);
              mergePage(k, r.messages, stamp);
              if (!r.messages.length || !r.more) break;
              after = r.messages.at(-1).id;
            } while (after < through);
            p.newer = (chan(k)?.lastId || 0) > (p.list.at(-1)?.id || 0); p.error = false;
          } finally { p.syncing = false; }
        }
        if (tab !== 'draft' && !chan(tab)) tab = 'ooc';
        if (open && chan(tab) && !messages.get(tab)?.loaded) await loadPage(tab);
        for (const k of readPending.keys()) flushRead(k);
      } catch { const p = messages.get(tab); if (p) p.error = true; }
      syncing = null;
      renderChat();
      markRead();
    })();
    return syncing;
  }

  function renderReply() {
    const el = $('#chatReply'), reply = drafts.get(draftKey())?.reply;
    el.hidden = !reply;
    if (!reply) { el.replaceChildren(); return; }
    el.innerHTML = `<span>Replying to ${esc(reply.displayName)}: ${esc(reply.message.slice(0, 120))}</span><button type="button" aria-label="Cancel reply">×</button>`;
    el.querySelector('button').onclick = () => { const d = drafts.get(draftKey()); if (d) delete d.reply; renderReply(); };
  }
  function updateJump() {
    const body = $('#chatBody'), c = chan(tab), p = messages.get(tab);
    $('#chatJump').hidden = !c || !(p?.newer || body.scrollHeight - body.scrollTop - body.clientHeight > 60);
    $('#chatJump').textContent = c?.unread ? `New messages (${c.unread}) ↓` : 'Latest messages ↓';
  }
  async function latest() {
    const k = tab, start = revision;
    try {
      const d = await api.get(`${ctx.base}/chats/${k}/messages?limit=60`);
      const p = messages.get(k) || { list: [] };
      const live = p.list.filter(m => (edits.get(`${k}:${m.id}`) || 0) > start);
      Object.assign(p, { list: ChatModel.merge(d.messages, live), more: d.more, newer: false, loaded: true, error: false }); messages.set(k, p);
      p.newer = (chan(k)?.lastId || 0) > (p.list.at(-1)?.id || 0);
      if (tab === k) { newMark = 0; renderBody(); $('#chatBody').scrollTop = $('#chatBody').scrollHeight; readHold.delete(k); markRead(); updateJump(); }
    } catch (e) { toast(e.message); }
  }
  async function jumpTo(id) {
    const k = tab, start = revision;
    try {
      const d = await api.get(`${ctx.base}/chats/${k}/messages?around=${id}`);
      // This is a separate contiguous window; do not merge with unrelated history.
      const live = (messages.get(k)?.list || []).filter(m => (edits.get(`${k}:${m.id}`) || 0) > start && d.messages.some(x => x.id === m.id));
      messages.set(k, { list: ChatModel.merge(d.messages, live), loaded: true, more: d.more, newer: d.newer });
      if (tab !== k) return;
      findState = null; findSeq++; $('#chatFind').hidden = true; newMark = 0; renderBody();
      const target = $('#chatBody').querySelector(`[data-message="${id}"]`);
      target?.scrollIntoView({ block: 'center' }); target?.classList.add('chat-highlight'); updateJump();
    } catch (e) { toast(e.message); }
  }
  async function findMessages(mode, more = false) {
    const k = tab, q = $('#chatSearch').value.trim(), seq = ++findSeq;
    if (!chan(k)) return;
    const before = more ? findState?.before : null;
    if (!more) findState = { mode, key: k, list: [], before: null };
    const state = findState;
    $('#chatFind').hidden = false; $('#chatFindResults').textContent = 'Loading…';
    try {
      const suffix = mode === 'mentions' ? 'mentions=1' : mode === 'pins' ? 'pins=1' : `q=${encodeURIComponent(q)}`;
      const d = await api.get(`${ctx.base}/chats/${k}/messages?limit=30&${suffix}${before ? `&before=${before}` : ''}`);
      if (seq !== findSeq || tab !== k) return;
      state.list = more ? [...state.list, ...d.messages.slice().reverse()] : d.messages.slice().reverse();
      state.before = d.messages[0]?.id;
      $('#chatFindResults').innerHTML = state.list.map(m => `<button type="button" data-result="${m.id}"><b>${esc(m.displayName)}</b> · ${esc(fmtTime(m.createdAt))}<span>${esc(m.message.slice(0, 180))}</span></button>`).join('') || '<p class="hint">No messages found.</p>';
      $('#chatFindResults').querySelectorAll('[data-result]').forEach(b => b.onclick = () => jumpTo(Number(b.dataset.result)));
      $('#chatFindMore').hidden = !d.more; $('#chatFindMore').onclick = () => findMessages(mode, true);
    } catch (e) { if (seq === findSeq) $('#chatFindResults').textContent = e.message; }
  }
  function hideMentions() {
    mentionOptions = []; $('#chatMentions').hidden = true;
    $('#chatMsg').setAttribute('aria-expanded', 'false'); $('#chatMsg').removeAttribute('aria-activedescendant');
  }
  function suggestMentions() {
    const input = $('#chatMsg'), before = input.value.slice(0, input.selectionStart), match = /(?:^|\s)@([A-Za-z0-9_.-]*)$/.exec(before);
    if (!match) { hideMentions(); return; }
    const ids = tab === 'draft' ? [ctx.me.id, ...draft.members] : chan(tab)?.members || [];
    const q = match[1].toLowerCase(); mentionStart = before.lastIndexOf('@'); mentionIndex = 0;
    mentionOptions = ctx.state.members.filter(m => ids.includes(m.userId) && m.userId !== ctx.me.id && (m.username || '').length && `${m.username} ${m.displayName} ${m.nation}`.toLowerCase().includes(q)).slice(0, 8);
    const el = $('#chatMentions'); el.hidden = !mentionOptions.length;
    el.innerHTML = mentionOptions.map((m, i) => `<button type="button" role="option" id="chatMention${i}" aria-selected="${i === 0}" data-mention="${i}"><b>${esc(m.displayName)}</b> @${esc(m.username)}${m.nation ? ` · ${esc(m.nation)}` : ''}</button>`).join('');
    el.querySelectorAll('[data-mention]').forEach(b => b.onclick = () => chooseMention(Number(b.dataset.mention)));
    input.setAttribute('aria-expanded', String(!!mentionOptions.length));
    if (mentionOptions.length) input.setAttribute('aria-activedescendant', 'chatMention0');
  }
  function chooseMention(index) {
    const m = mentionOptions[index]; if (!m) return;
    const input = $('#chatMsg'), end = input.selectionStart, insert = `@${m.username} `;
    input.setRangeText(insert, mentionStart, end, 'end'); hideMentions(); saveDraft(); autosize(); input.focus();
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
    // The envelope: open and read when there is nothing new, a fresh letter when there is.
    const icon = $('#notifIcon'), src = count > 0 ? '/icons/mail-new.png' : '/icons/mail-read.png';
    if (icon && icon.getAttribute('src') !== src) icon.setAttribute('src', src);
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
    $('#notifList').querySelectorAll('[data-dismiss]').forEach(b => b.onclick = () => dismiss([b.dataset.dismiss]));
    // Clear all: every notice that needs no answer. What waits on you stays until you answer it.
    $('#notifClear').hidden = !list.some(i => i.info);
    $('#notifClear').onclick = () => dismiss(list.filter(i => i.info).map(i => i.key));
  }
  function dismiss(keys) {
    prefs.dismissed = [...new Set([...(prefs.dismissed || []), ...keys])].slice(-500);
    savePrefs();
    renderNotifs();
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
  // My offer against theirs (docs/COMMS.md, Trades): every stock a nation can trade is a row with a slider, from
  // nothing up to what is in the stockpile when that is known (your own; another nation's with public treasuries,
  // or for the GM). The number box takes any amount, and the slider stretches to it.
  const amounts = { give: {}, take: {} };
  const TREASURY = [['money', 'Money', '<img class="resicon" src="/icons/cash.png" alt="">'], ['manpower', 'Manpower', '<span class="tr-emoji">👥</span>'], ['rp', 'Research points', '<img class="resicon" src="/icons/paper_roll.png" alt="">']];
  /** Everything tradeable, by group: [[title, [[key, name, iconHtml], ...]], ...]. */
  function tradeGroups() {
    const G = window.GameData, out = [['Treasury', TREASURY]];
    out.push(['Resources', (G?.RESOURCE_KEYS || []).map(k => [k, G.byKey[k].name, `<img class="resicon" src="/icons/${G.byKey[k].icon}" alt="">`])]);
    if (ctx.state.game?.settings?.goodsEnabled !== false) out.push(['Goods', (G?.GOODS || []).map(x => [x.key, x.name, `<img class="resicon" src="/icons/${x.icon}" alt="">`])]);
    return out;
  }
  /** A nation's stock of each key, or null when this viewer may not know it. */
  function stockOf(fid) {
    const e = (ctx.state.gameFactions || []).find(x => x.faction?.id === fid);
    if (!e || !e.state) return null;
    const s = { money: e.state.money, manpower: e.state.manpower, rp: e.state.rp, ...(e.state.resources || {}) };
    for (const [k, v] of Object.entries(e.goods?.stock || {})) s[k] = v;
    return s;
  }
  const flagOf = fid => { const f = (ctx.state.factions || []).find(x => x.id === fid) || factions().find(x => x.id === fid); return f?.flagUrl ? `<img src="${esc(f.flagUrl)}" alt="">` : `<span style="width:100%;height:100%;background:${esc(f?.color || '#555')}"></span>`; };
  const goodName = k => k === 'rp' ? 'RP' : k === 'money' ? 'money' : k === 'manpower' ? 'manpower' : (window.GameData?.byKey[k]?.name || window.GameData?.GOODS?.find(x => x.key === k)?.name || k).toLowerCase();
  function goods(b) {
    const parts = Object.entries(b || {}).filter(([, v]) => v > 0).map(([k, v]) => `${fmtNum(v)} ${goodName(k)}`);
    return parts.length ? parts.join(', ') : 'nothing';
  }
  const tradeFrom = () => isGm() ? Number($('#tradeFrom').value) : myFactionId();
  const tradeTo = () => Number($('#tradeTo').value);
  /** The rows of one side, each a slider and a box, from the stock when known. */
  function renderTradeSide(side, fid) {
    const stock = stockOf(fid), el = $(side === 'give' ? '#tradeGive' : '#tradeTake');
    el.innerHTML = tradeGroups().map(([title, items]) => `<div class="sh">${title}</div>` + items.map(([k, name, icon]) => {
      const have = stock ? Math.max(0, Math.floor(Number(stock[k]) || 0)) : null, v = amounts[side][k] || 0;
      const max = Math.max(v, have ?? (['money', 'manpower', 'rp'].includes(k) ? 2000 : 200), 1);
      return `<div class="tr-row ${v ? 'on' : ''} ${have === 0 ? 'none' : ''} ${have !== null && v > have ? 'over' : ''}" data-side="${side}" data-key="${k}">
        ${icon}<span class="tr-name">${esc(name)}</span><span class="tr-have" title="${have === null ? 'Their stock is not known to you' : (side === 'give' ? 'In the stockpile' : 'In their stockpile')}">${have === null ? '?' : fmtNum(have)}</span>
        <input type="range" min="0" max="${max}" step="1" value="${v}" ${have === 0 ? 'disabled' : ''}><input type="number" min="0" step="1" value="${v || ''}" placeholder="0"></div>`;
    }).join('')).join('');
    el.querySelectorAll('.tr-row').forEach(row => {
      const range = row.querySelector('input[type=range]'), box = row.querySelector('input[type=number]');
      const set = (v, fromBox) => {
        v = Math.max(0, Math.round(Number(v) || 0));
        amounts[side][row.dataset.key] = v;
        if (fromBox && v > Number(range.max)) range.max = v;
        if (!fromBox) box.value = v || '';
        range.value = v;
        const have = row.querySelector('.tr-have').textContent, h = have === '?' ? null : Number(have.replace(/[^\d.]/g, ''));
        row.classList.toggle('on', v > 0);
        row.classList.toggle('over', h !== null && v > h);
        renderTradeSummary();
      };
      range.oninput = () => set(range.value, false);
      box.oninput = () => set(box.value, true);
    });
  }
  function renderTradeSummary() {
    const g = goods(amounts.give), t = goods(amounts.take), to = factions().find(f => f.id === tradeTo())?.name || 'them';
    $('#tradeGiveSum').innerHTML = `<b>You give</b> <span class="${g === 'nothing' ? 'muted' : ''}">${esc(g)}</span>`;
    $('#tradeTakeSum').innerHTML = `<b>${esc(to)} gives</b> <span class="${t === 'nothing' ? 'muted' : ''}">${esc(t)}</span>`;
  }
  function renderTradeParties() {
    const from = tradeFrom(), to = tradeTo();
    $('#tradeFromFlag').innerHTML = flagOf(from);
    $('#tradeToFlag').innerHTML = flagOf(to);
    $('#tradeFromName').textContent = factions().find(f => f.id === from)?.name || '';
  }
  function openTrade(toId) {
    const fs = factions(), mine = myFactionId();
    const opts = (exclude) => fs.filter(f => f.id !== exclude).map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    amounts.give = {}; amounts.take = {};
    $('#tradeFromWrap').hidden = !isGm();
    $('#tradeFromName').hidden = isGm();
    $('#tradeFrom').innerHTML = opts(null);
    if (mine) $('#tradeFrom').value = String(mine);
    const syncTo = () => {
      const from = tradeFrom();
      $('#tradeTo').innerHTML = opts(from);
      if (toId && toId !== from) $('#tradeTo').value = String(toId);
      renderTradeParties(); renderTradeSide('give', from); renderTradeSide('take', tradeTo()); renderTradeSummary();
    };
    $('#tradeFrom').onchange = syncTo;
    $('#tradeTo').onchange = () => { renderTradeParties(); renderTradeSide('take', tradeTo()); renderTradeSummary(); };
    syncTo();
    $('#tradeOnce').checked = true; $('#tradeTurns').value = 4; $('#tradeNote').value = '';
    $('#tradeModal').classList.add('open');
  }
  const readGoods = side => Object.fromEntries(Object.entries(amounts[side]).filter(([, v]) => v > 0));
  async function submitTrade(e) {
    e.preventDefault();
    const body = {
      fromFactionId: isGm() ? tradeFrom() : undefined, toFactionId: tradeTo(),
      give: readGoods('give'), take: readGoods('take'),
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
  let hiddenAt = 0;
  async function init(c) {
    ctx = c;
    prefs = store.load();
    tab = prefs.tab || 'ooc';
    big = !!prefs.big;
    $('#chatToggle').onclick = () => setOpen(!open);
    $('#chatMin').onclick = () => setOpen(false);
    $('#chatBig').onclick = () => { big = !big; prefs.big = big; savePrefs(); renderChat(); };
    $('#chatSideBtn').onclick = () => { side = !side; renderChat(); };
    $('#chatLeave').onclick = leaveTab;
    $('#chatSend').onsubmit = send;
    const ta = $('#chatMsg');
    ta.onkeydown = e => {
      if (e.isComposing) return;
      if (mentionOptions.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
        e.preventDefault();
        if (e.key === 'Escape') hideMentions();
        else if (e.key === 'Enter' || e.key === 'Tab') chooseMention(mentionIndex);
        else {
          mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : mentionOptions.length - 1)) % mentionOptions.length;
          $('#chatMentions').querySelectorAll('[data-mention]').forEach((b, i) => b.setAttribute('aria-selected', String(i === mentionIndex)));
          ta.setAttribute('aria-activedescendant', `chatMention${mentionIndex}`);
        }
      }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    };
    ta.oninput = () => { autosize(); saveDraft(); suggestMentions(); sendTyping(); };
    ta.onfocus = markRead;
    $('#chatBody').onscroll = () => { markRead(); updateJump(); $('#chatMenu').hidden = true; };
    $('#chatJump').onclick = latest;
    $('#chatSearchForm').onsubmit = e => { e.preventDefault(); findMessages('search'); };
    $('#chatShowMentions').onclick = () => findMessages('mentions');
    $('#chatShowPins').onclick = () => findMessages('pins');
    $('#chatFindClose').onclick = () => { findSeq++; findState = null; $('#chatFind').hidden = true; };
    $('#chatNotifyMode').onchange = async e => {
      const k = tab, notifications = e.target.value;
      try { await api.patch(`${ctx.base}/chats/${k}/preferences`, { notifications }); if (chan(k)) chan(k).notifications = notifications; }
      catch (err) { toast(err.message); renderHead(); }
    };
    $('#chatGif').onclick = () => toggleGifs();
    $('#chatGifClose').onclick = () => toggleGifs(false);
    $('#chatGifMore').onclick = () => loadGifs(true);
    $('#chatGifQ').oninput = e => { gifs.q = e.target.value.trim(); clearTimeout(gifTimer); gifTimer = setTimeout(() => loadGifs(), 350); };
    $('#chatGifQ').onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); toggleGifs(false); } };
    document.addEventListener('pointerdown', e => { if (!$('#chatMenu').hidden && !e.target.closest('#chatMenu')) $('#chatMenu').hidden = true; });
    api.get('/api/klipy/status').then(d => { gifs.enabled = !!d.enabled; if (open) renderComposer(); }).catch(() => {});
    window.addEventListener('focus', () => { for (const k of readPending.keys()) flushRead(k); markRead(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      // Back after a while (a phone asleep, a tab in the background): the socket may have missed things.
      if (Date.now() - hiddenAt > 15000) resync(); else markRead();
    });
    $('#notifBtn').onclick = e => { e.stopPropagation(); toggleNotifs(); };
    document.addEventListener('pointerdown', e => { if (!$('#notifPanel').hidden && !e.target.closest('#notifWrap')) toggleNotifs(false); });
    $('#tradeForm').onsubmit = submitTrade;
    $('#tradeTurns').onfocus = () => { $('#tradeRecurring').checked = true; };
    const initiallyOpen = !!prefs.open;
    open = false; // Position the first unread message before acknowledging anything on initial load.
    await resync();
    open = initiallyOpen;
    if (tab === 'draft' || !chan(tab)) tab = 'ooc';
    if (open) await openTab(tab); else renderChat();
    await loadTrades();
    await loadConvoyRequests();
  }

  function onChatChannel(c) { addChannel(c); renderChat(); }
  function onChatMessage(m, update = false) {
    const fresh = ingest(m, update), c = chan(m.channel);
    const mentioned = m.data?.mentions?.some(x => x.userId === ctx.me.id);
    const notify = c && c.notifications !== 'muted' && (c.notifications !== 'mentions' || mentioned);
    const body = $('#chatBody'), atLatest = reading(m.channel) && body.scrollHeight - body.scrollTop - body.clientHeight < 40 && !messages.get(m.channel)?.newer;
    if (fresh && m.userId && m.userId !== ctx.me.id && notify && !atLatest) {
      const title = mentioned ? `${m.displayName} mentioned you` : m.channel === 'gm' ? 'GM announcement' : `${m.displayName} · ${channelTitle(c)}`;
      ctx.notify(title, m.message);
      if (document.visibilityState === 'visible' && (mentioned || m.channel === 'gm')) toast(`${title}: ${m.message}`, 5000);
    }
    renderChat();
    markRead();
  }
  /** Someone read up to a message: their mark moves; our own mark from another tab clears the count here. */
  function onChatRead(r) {
    const c = chan(r.channel);
    if (!c) return;
    if (r.userId === ctx.me.id) {
      c.myRead = r.reset ? r.lastId : Math.max(c.myRead || 0, r.lastId);
      if (r.reset) { readHold.add(r.channel); clearTimeout(readTimers.get(r.channel)); readTimers.delete(r.channel); readPending.delete(r.channel); }
      if (c.myRead >= (c.lastId || 0)) { c.unread = 0; c.mentions = 0; }
      else refreshCounts();
    } else {
      const mark = (c.reads || (c.reads = [])).find(x => x.userId === r.userId);
      if (mark) { mark.lastId = r.reset ? r.lastId : Math.max(mark.lastId, r.lastId); mark.at = r.at; } else c.reads.push({ userId: r.userId, lastId: r.lastId, at: r.at });
    }
    renderChat();
  }
  let typingTimer = 0;
  let countsPending = null;
  function refreshCounts() {
    if (countsPending) return countsPending;
    const start = revision;
    countsPending = api.get(`${ctx.base}/chats`).then(d => {
      if (start !== revision) return;
      for (const c of d.channels) addChannel(c, true);
      renderBadge(); if (open) renderSide();
    }).catch(() => {}).finally(() => { countsPending = null; });
    return countsPending;
  }
  function onChatPreference(m) { const c = chan(m.channel); if (c) c.notifications = m.notifications; if (open) renderHead(); }
  function onChatLeft(m) { channels.delete(m.channel); messages.delete(m.channel); readPending.delete(m.channel); if (tab === m.channel) openTab('ooc'); else renderChat(); }
  function onTyping(t) {
    if (t.userId === ctx.me.id) return;
    if (!typing.has(t.channel)) typing.set(t.channel, new Map());
    typing.get(t.channel).set(t.userId, Date.now() + 4000);
    if (open && tab === t.channel) renderTyping();
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { if (open) renderTyping(); }, 4200);
  }
  function onRelations() { renderNotifs(); }
  async function onTradesChanged(msg) {
    await loadTrades();
    if (msg && msg.treasury) ctx.GameUI.load().catch(() => {});
  }
  function refresh() { if (!ctx) return; renderChat(); renderNotifs(); }

  return { init, onChatChannel, onChatMessage, onChatRead, onChatPreference, onChatLeft, onTyping, resync, onRelations, onTradesChanged, refresh, loadTrades, loadConvoyRequests, openTrade, openPerson };
})();

window.Comms = Comms;
