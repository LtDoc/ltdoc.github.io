'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const config = require('./config');
require('./db');
const { attachUser } = require('./auth');
const hub = require('./ws');
const build = require('./build');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(attachUser);

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/lobbies', require('./routes/lobbies'));
app.use('/api/klipy', require('./routes/klipy'));   // GIFs for the chat (docs/COMMS.md)

app.use('/uploads', express.static(config.uploadsDir, { fallthrough: false, immutable: true, maxAge: '30d', index: false }));

// Bundled Earth layers are stored pre-gzipped; serve them as JSON with Content-Encoding so the browser inflates them.
app.get('/earth/:name.json.gz', (req, res) => {
  if (!/^[a-z0-9_]+$/.test(req.params.name)) return res.status(404).end();
  const file = path.join(config.root, 'public', 'earth', `${req.params.name}.json.gz`);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(file, err => { if (err) res.status(404).end(); });
});
app.use('/vendor/pixi', express.static(path.join(config.root, 'node_modules', 'pixi.js', 'dist'), { maxAge: '7d', index: false }));

// Pages: every /js and /css URL gets ?v=<build> so browsers fetch fresh code after a restart; pages are never cached.
app.get('/api/version', (req, res) => res.json(build));
const pageCache = new Map();   // file -> { mtime, html }
function sendPage(res, name, status = 200) {
  const file = path.join(config.root, 'public', name);
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  let hit = pageCache.get(file);
  if (!hit || hit.mtime !== st.mtimeMs) {
    const html = fs.readFileSync(file, 'utf8')
      .replace(/(src|href)="(\/(?:js|css)\/[^"?#]+)"/g, (m, attr, url) => `${attr}="${url}?v=${build.asset}"`)
      .replace(/__WOE_BUILD__/g, build.label);
    hit = { mtime: st.mtimeMs, html };
    pageCache.set(file, hit);
  }
  res.status(status).set('Cache-Control', 'no-cache').type('html').send(hit.html);
  return true;
}
app.get('/', (req, res) => sendPage(res, 'index.html'));
app.get(/^\/([a-z0-9-]+)(?:\.html)?$/, (req, res, next) => { if (!sendPage(res, `${req.params[0]}.html`)) next(); });
// Pretty URL for a campaign map
app.get('/map/:id', (req, res) => sendPage(res, 'map.html'));
app.use(express.static(path.join(config.root, 'public'), { index: false }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  sendPage(res, '404.html', 404);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? (req.path.endsWith('/map/azgaar') ? 'File too large (max 30 MB)'
        : req.path.endsWith('/map') ? `File too large (max ${Math.round(config.maxUploadBytes / 1048576)} MB)` : 'File too large (max 5 MB)')
      : err.message;
    return res.status(400).json({ error: msg });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
  if (err.status === 404) return res.status(404).json({ error: 'Not found' });
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

const server = http.createServer(app);
hub.attach(server);
server.listen(config.port, config.host, () => {
  console.log(`WoE Strategy Map listening on http://${config.host}:${config.port}`);
  console.log(`Build ${build.label}${build.commitDate ? `, committed ${build.commitDate}` : ''}${build.dirty ? ' (with uncommitted changes)' : ''}`);
  console.log(`Data directory: ${config.dataDir}`);
  if (require('./backup').schedule()) console.log(`Automatic backups every ${config.backupHours}h into ${config.backupDir}`);
  require('./deadlines').schedule();   // turn deadline reminders, checked once a minute
});

function shutdown() {
  console.log('Shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
