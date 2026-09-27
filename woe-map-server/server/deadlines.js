'use strict';
/**
 * Turn deadline reminders (phase 5). The GM sets a real-world deadline on the Game tab; when it is a date
 * this watcher posts a campaign log entry 24 hours before it and again when it passes. Nothing is forced:
 * the turn still ends only when the GM presses End turn. Reminders are recorded on the game row
 * ("<deadline>|<stage>") so a restart does not repeat them, and changing the deadline arms them again.
 */
const { db, now } = require('./db');
const hub = require('./ws');
const game = require('./game');
const GameData = require('../public/js/game-data');

const insertEvent = db.prepare('INSERT INTO events (lobby_id, user_id, kind, message, data, created_at) VALUES (?, NULL, ?, ?, ?, ?)');
const REMIND_MS = 24 * 3600e3;

function post(lobbyId, message, data) {
  const t = now();
  const id = insertEvent.run(lobbyId, 'system', message, JSON.stringify(data), t).lastInsertRowid;
  hub.broadcast(lobbyId, { type: 'event', event: { id, kind: 'system', message, userId: null, displayName: 'System', data, createdAt: t } });
}

/** One pass over every running game with a deadline; exported for tests. */
function check(nowMs = Date.now()) {
  let sent = 0;
  for (const row of game.q.enabledGames.all()) {
    const info = GameData.deadlineInfo(row.deadline, nowMs);
    if (!info || !info.at) continue;
    const stage = nowMs >= info.at ? 'passed' : (nowMs >= info.at - REMIND_MS ? 'soon' : null);
    if (!stage) continue;
    const mark = `${row.deadline}|${stage}`;
    const done = String(row.deadline_notified || '');
    if (done === mark || (stage === 'soon' && done === `${row.deadline}|passed`)) continue;
    const when = new Date(info.at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const msg = stage === 'passed'
      ? `⏰ The deadline for turn ${row.turn} has passed (${when}). Finish your moves; the GM will end the turn.`
      : `⏰ Turn ${row.turn} ends ${when}: about 24 hours left for moves, builds and research.`;
    post(row.lobby_id, msg, { deadline: stage, turn: row.turn, at: info.at });
    game.q.setDeadlineNotified.run(mark, row.lobby_id);
    sent++;
  }
  return sent;
}

let timer = null;
function schedule(intervalMs = 60e3) {
  if (timer) return timer;
  timer = setInterval(() => { try { check(); } catch (e) { console.warn('deadline check failed', e); } }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { check, schedule };
