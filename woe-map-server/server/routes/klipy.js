'use strict';
/**
 * GIFs in the chat (docs/COMMS.md, "GIFs"): a proxy to the KLIPY GIF API (https://docs.klipy.com/gifs-api), so the
 * API key stays on the server. Set WOE_KLIPY_KEY to switch it on; without it the chat shows no GIF button.
 *
 *   GET /api/klipy/status                 { enabled }
 *   GET /api/klipy/trending?page=1        { gifs, hasNext }
 *   GET /api/klipy/search?q=hello&page=1  { gifs, hasNext }
 *
 * Each gif: { id, title, preview: { url, w, h }, full: { url, w, h } }: the preview is the small webp (or gif) for the
 * picker, the full one the medium gif for the message. KLIPY asks for "Powered by KLIPY" where its GIFs are picked.
 */
const express = require('express');
const config = require('../config');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const enabled = () => !!config.klipyKey;
const pick = (file, sizes, formats) => {
  for (const s of sizes) for (const f of formats) { const v = file?.[s]?.[f]; if (v?.url) return { url: v.url, w: Number(v.width) || 0, h: Number(v.height) || 0 }; }
  return null;
};
function normalise(item) {
  const preview = pick(item.file, ['xs', 'sm'], ['webp', 'gif', 'jpg']), full = pick(item.file, ['md', 'sm', 'hd'], ['gif', 'webp']);
  if (!preview || !full) return null;
  return { id: String(item.slug || item.id || full.url), title: String(item.title || '').slice(0, 120), preview, full };
}
async function fetchGifs(res, path, params) {
  if (!enabled()) return res.status(404).json({ error: 'GIFs are not set up on this server (WOE_KLIPY_KEY)' });
  const url = new URL(`${config.klipyBase.replace(/\/$/, '')}/${encodeURIComponent(config.klipyKey)}/gifs/${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  if (config.klipyFilter) url.searchParams.set('content_filter', config.klipyFilter);
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(8000) }); }
  catch { return res.status(502).json({ error: 'KLIPY did not answer' }); }
  if (!r.ok) return res.status(502).json({ error: `KLIPY answered ${r.status}` });
  const body = await r.json().catch(() => null);
  const page = body?.data;
  const list = Array.isArray(page?.data) ? page.data : Array.isArray(page) ? page : [];
  res.set('Cache-Control', 'private, max-age=300');
  res.json({ gifs: list.map(normalise).filter(Boolean), hasNext: !!page?.has_next });
}

router.get('/status', (req, res) => res.json({ enabled: enabled() }));
router.get('/trending', (req, res) => fetchGifs(res, 'trending', { page: Math.max(1, Math.floor(Number(req.query.page) || 1)), per_page: 24 }));
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) return res.status(400).json({ error: 'Search for something' });
  return fetchGifs(res, 'search', { q, page: Math.max(1, Math.floor(Number(req.query.page) || 1)), per_page: 24 });
});

/** A GIF a message may carry: from KLIPY's own file store only, so nothing else can be put in a bubble. */
const GIF_HOST = /^https:\/\/([a-z0-9-]+\.)*klipy\.com\//i;
function cleanGif(g) {
  if (!g || typeof g !== 'object') return null;
  const url = String(g.url || ''), preview = String(g.preview || url);
  if (!GIF_HOST.test(url) || !GIF_HOST.test(preview) || url.length > 500 || preview.length > 500) return null;
  const w = Math.max(0, Math.min(4000, Math.floor(Number(g.w) || 0))), h = Math.max(0, Math.min(4000, Math.floor(Number(g.h) || 0)));
  return { url, preview, w, h, title: String(g.title || '').slice(0, 120), source: 'klipy' };
}

module.exports = router;
module.exports.cleanGif = cleanGif;
