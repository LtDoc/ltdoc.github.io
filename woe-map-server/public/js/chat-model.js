'use strict';
// Pure chat helpers shared by the interface and regression tests.
const ChatModel = (() => {
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function linkify(text) {
    const source = String(text || ''); let html = '', cursor = 0;
    for (const match of source.matchAll(/\bhttps?:\/\/[^\s<>"']+/g)) {
      let url = match[0], tail = '';
      while (/[.,!?;:]$/.test(url) || /[)\]}]$/.test(url) && (() => {
        const close = url.at(-1), open = { ')': '(', ']': '[', '}': '{' }[close];
        return [...url].filter(c => c === close).length > [...url].filter(c => c === open).length;
      })()) { tail = url.at(-1) + tail; url = url.slice(0, -1); }
      html += escape(source.slice(cursor, match.index));
      html += `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(url)}</a>${escape(tail)}`;
      cursor = match.index + match[0].length;
    }
    return html + escape(source.slice(cursor));
  }
  function textHtml(message, userId) {
    const text = String(message.message || ''), mentions = [...(message.data?.mentions || [])].sort((a, b) => a.start - b.start);
    let html = '', cursor = 0;
    for (const m of mentions) {
      if (!Number.isInteger(m.start) || !Number.isInteger(m.end) || m.start < cursor || m.end > text.length || m.end <= m.start) continue;
      html += linkify(text.slice(cursor, m.start)) + `<span class="mention${m.userId === userId ? ' mine' : ''}">${escape(text.slice(m.start, m.end))}</span>`;
      cursor = m.end;
    }
    return html + linkify(text.slice(cursor));
  }
  function merge(old, incoming) {
    return [...new Map([...old, ...incoming].map(m => [m.id, m])).values()].sort((a, b) => a.id - b.id);
  }
  function draftKey(tab, draft) { return tab === 'draft' ? `draft:${[...(draft?.members || [])].sort((a, b) => a - b).join(',')}:${draft?.name || ''}` : tab; }
  return { linkify, textHtml, merge, draftKey };
})();
if (typeof module !== 'undefined') module.exports = ChatModel;
if (typeof window !== 'undefined') window.ChatModel = ChatModel;
