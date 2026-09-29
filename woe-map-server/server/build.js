'use strict';
/**
 * Which code is running. There is no build step: start.cmd and the service run server/index.js straight from
 * this folder, so "the build" is the git commit of the working copy plus whether it has uncommitted edits.
 * Pages show it (lobbies page footer, map settings) and every script and stylesheet URL carries `?v=<asset>`
 * so a browser never keeps running yesterday's JavaScript after the server restarts.
 */
const { execFileSync } = require('node:child_process');
const config = require('./config');
const pkg = require('../package.json');

function git(args) {
  try { return execFileSync('git', args, { cwd: config.root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim(); }
  catch { return ''; }
}

const commit = git(['rev-parse', '--short', 'HEAD']);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const dirty = commit ? git(['status', '--porcelain', '--', '.']).split('\n').filter(l => l && !/\sdata\//.test(l)).length > 0 : false;
const commitDate = commit ? git(['log', '-1', '--format=%cI']) : '';
const startedAt = Date.now();

const build = {
  version: pkg.version,
  commit: commit || null,
  branch: branch || null,
  dirty,
  commitDate: commitDate || null,
  startedAt,
  /** Short label for the UI: "45224595 (woe-map-server)" or "1.0.0". */
  label: commit ? `${commit}${dirty ? '+' : ''}${branch && branch !== 'HEAD' ? ` (${branch})` : ''}` : `v${pkg.version}`,
  /** Cache key for script and stylesheet URLs: changes with every commit and every restart. */
  asset: `${commit || pkg.version}-${startedAt.toString(36)}`,
};

module.exports = build;
