'use strict';
window.News = (() => {
  let ctx, posts = [], before = null, sequence = 0, publishing = false;
  const $ = s => document.querySelector(s);
  const KINDS = { statement: 'Public statement', newspaper: 'Newspaper', 'diplomatic-note': 'Diplomatic note', report: 'Report', announcement: 'GM announcement', 'world-event': 'World event', briefing: 'GM briefing' };
  function sourceId() { return ctx.state.role === 'gm' ? Number($('#newsSource').value) || null : ctx.state.myFactionId; }
  function form() {
    const gm = ctx.state.role === 'gm', own = ctx.state.factions.find(f => f.id === ctx.state.myFactionId);
    const old = $('#newsSource').value;
    $('#newsSourceWrap').hidden = !gm;
    $('#newsSource').innerHTML = '<option value="">Game master</option>' + ctx.state.factions.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    if (gm && [...$('#newsSource').options].some(o => o.value === old)) $('#newsSource').value = old;
    $('#newsForm').hidden = !gm && !own;
    $('#newsCompose').hidden = !gm && !own;
    $('#newsByline').textContent = gm ? 'Publish a world event or speak for a nation.' : own ? `Publishing for ${own.name}. Your teammates can also post for this nation.` : '';
    $('#newsKind').querySelectorAll('[data-gm-only]').forEach(o => { o.hidden = !gm; o.disabled = !gm; });
    audience();
  }
  function audience() {
    const source = sourceId(), gm = ctx.state.role === 'gm';
    if (gm && !source && $('#newsAudience').value !== 'selected') $('#newsAudience').value = 'selected';
    for (const option of $('#newsAudience').options) option.disabled = gm && !source && option.value !== 'selected';
    const selected = $('#newsAudience').value === 'selected';
    $('#newsTargets').hidden = !selected;
    if (selected) {
      const checked = new Set([...$('#newsTargets').querySelectorAll('input:checked')].map(x => Number(x.value)));
      $('#newsTargets').innerHTML = ctx.state.factions.filter(f => f.id !== source).map(f => `<label class="inline"><input type="checkbox" value="${f.id}" ${checked.has(f.id) ? 'checked' : ''}> ${esc(f.name)}</label>`).join('');
    }
  }
  function card(p) {
    const targets = p.privateTo?.length ? p.privateTo.map(id => ctx.state.factions.find(f => f.id === id)?.name || `nation #${id}`).join(', ') : '';
    const art = KINDS[p.kind] ? p.kind : 'news';
    if (p.kind === 'newspaper') return `<article class="news-post news-clipping" data-news="${p.id}"><div class="clipping-masthead">${esc(p.sourceName)} · Gazette</div><div class="journal-meta">NEWSPAPER${p.gameDate ? ` · ${esc(p.gameDate)}` : ''}</div><h3>${esc(p.headline)}</h3>${p.publicBody ? `<div class="news-body">${esc(p.publicBody)}</div>` : ''}${p.privateBody ? `<div class="news-private"><b>Private edition</b><div class="hint">${esc(targets || 'Nation leadership and the GM')}</div><div class="news-body">${esc(p.privateBody)}</div></div>` : ''}<footer>By ${esc(p.authorName)} · ${esc(fmtTime(p.createdAt))}</footer></article>`;
    return `<article class="box news-post" data-news="${p.id}"><div class="story-heading"><span class="story-art story-art--${art}" aria-hidden="true"></span><div><div class="journal-meta">${esc(KINDS[p.kind] || p.kind)} · ${esc(p.sourceName)} · ${esc(p.authorName)} · ${esc(p.gameDate || '')} · ${esc(fmtTime(p.createdAt))}</div>
      <h3>${esc(p.headline)}</h3></div></div>${p.publicBody ? `<div class="news-body">${esc(p.publicBody)}</div>` : ''}
      ${p.privateBody ? `<div class="news-private"><b>Private version</b>${targets ? `<span class="hint"> · ${esc(targets)}</span>` : ''}<div class="news-body">${esc(p.privateBody)}</div></div>` : ''}</article>`;
  }
  function render() {
    $('#newsFeed').innerHTML = posts.length ? posts.map(card).join('') : '<div class="story-empty"><strong>The presses are waiting</strong><p>Published dispatches and newspaper clippings will appear here.</p></div>';
    $('#newsMore').hidden = !before;
  }
  async function load(older = false) {
    const seq = ++sequence;
    const cursor = older ? before : null;
    $('#newsStatus').textContent = older ? 'Loading older dispatches…' : 'Loading dispatches…';
    $('#newsMore').disabled = true;
    try {
      const d = await api.get(`${ctx.base}/game/news${cursor ? `?before=${cursor}` : ''}`);
      if (seq !== sequence) return;
      posts = older ? [...posts, ...d.posts] : d.posts;
      before = d.nextBefore;
      render();
      $('#newsStatus').textContent = '';
      $('#newsBadge').hidden = true;
    } catch (err) { if (seq === sequence) $('#newsStatus').textContent = `Could not load dispatches. ${err.message}`; }
    finally { if (seq === sequence) $('#newsMore').disabled = false; }
  }
  async function publish(ev) {
    ev.preventDefault();
    if (publishing) return;
    const publicBody = $('#newsPublic').value.trim(), privateBody = $('#newsPrivate').value.trim();
    if (!publicBody && !privateBody) { toast('Write public or private text'); return; }
    const targets = [...$('#newsTargets').querySelectorAll('input:checked')].map(x => Number(x.value));
    const body = { factionId: sourceId(), kind: $('#newsKind').value, headline: $('#newsHeadline').value,
      publicBody, privateBody, audience: $('#newsAudience').value, targets };
    const submit = $('#newsForm button[type="submit"]');
    publishing = true; submit.disabled = true; submit.textContent = 'Publishing…';
    try {
      await api.post(`${ctx.base}/game/news`, body);
      const source = $('#newsSource').value;
      $('#newsForm').reset();
      if (ctx.state.role === 'gm') $('#newsSource').value = source;
      audience();
      $('#newsPrivateWrap').open = false;
      $('#newsCompose').open = false;
      await load(); toast('News published');
    } catch (err) { toast(err.message); }
    finally { publishing = false; submit.disabled = false; submit.textContent = 'Publish'; }
  }
  function init(c) {
    ctx = c;
    $('#newsForm').onsubmit = publish;
    $('#newsMore').onclick = () => load(true);
    $('#newsSource').onchange = audience;
    $('#newsAudience').onchange = audience;
  }
  function open() { form(); load(); }
  function changed() {
    if (ctx.state.panel === 'news') load();
    else $('#newsBadge').hidden = false;
  }
  return { init, open, changed };
})();
