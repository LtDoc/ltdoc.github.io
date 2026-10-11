'use strict';

const api = {
  headers: {},   // sent with every request (the map page's X-View-As)
  async request(method, url, body, { keepalive = false } = {}) {
    const ro = api.readOnlyCampaign;
    if (ro && (url === ro.base || url.startsWith(ro.base + '/')) && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const receipt = method === 'POST' && /\/chats\/[^/]+\/read$/.test(url);
      const leave = method === 'DELETE' && url === `${ro.base}/members/${ro.userId}`;
      if (!receipt && !leave) throw new Error('Observers have read-only access');
    }
    const init = { method, headers: { ...api.headers }, credentials: 'same-origin', keepalive };
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
  put: (u, b) => api.request('PUT', u, b),
  del: (u) => api.request('DELETE', u),
};

/** Resolve the signed-in user or bounce to the login page. */
async function requireUser() {
  try {
    return (await api.get('/api/auth/me')).user;
  } catch (err) {
    // A suspended account is told so on the login page (msg); anyone else just signs in.
    location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search) + (err?.status === 403 ? '&msg=' + encodeURIComponent(err.message) : ''));
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
