'use strict';

const api = {
  headers: {},   // sent with every request (the map page's X-View-As)
  async request(method, url, body) {
    const init = { method, headers: { ...api.headers }, credentials: 'same-origin' };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(url, init);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get: (u) => api.request('GET', u),
  post: (u, b) => api.request('POST', u, b),
  patch: (u, b) => api.request('PATCH', u, b),
  del: (u) => api.request('DELETE', u),
};

/** Resolve the signed-in user or bounce to the login page. */
async function requireUser() {
  try {
    return (await api.get('/api/auth/me')).user;
  } catch {
    location.replace('/?next=' + encodeURIComponent(location.pathname + location.search));
    await new Promise(() => {}); // never resolves; page is navigating away
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, ms = 2600) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function fmtTime(t) {
  const d = new Date(t);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 100) return Math.round(n).toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
