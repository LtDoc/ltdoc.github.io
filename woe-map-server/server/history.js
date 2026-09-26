'use strict';
// Change history for markers and shapes: every create/update/delete is recorded with the full
// before/after state so a GM can revert it later.
const { db, now } = require('./db');

const insert = db.prepare(`
  INSERT INTO history (lobby_id, user_id, entity, entity_id, action, summary, before, after, reverts, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const selectOne = db.prepare(`
  SELECT h.*, u.display_name FROM history h LEFT JOIN users u ON u.id = h.user_id WHERE h.id = ?`);
const markReverted = db.prepare('UPDATE history SET reverted_by = ? WHERE id = ?');
const list = db.prepare(`
  SELECT h.*, u.display_name FROM history h LEFT JOIN users u ON u.id = h.user_id
  WHERE h.lobby_id = ? AND (? = '' OR h.entity = ?) AND (? = 0 OR h.entity_id = ?)
  ORDER BY h.id DESC LIMIT ?`);

function nameOf(entity, obj) {
  if (!obj) return '?';
  return entity === 'shape' ? (obj.label || (obj.kind === 'area' ? 'an area' : 'a line')) : obj.name;
}

function summarize(entity, action, before, after) {
  const what = entity === 'shape' ? 'drawing' : entity;
  const n = nameOf(entity, after || before);
  if (action === 'create') return entity === 'shape' ? `drew ${n}` : `placed ${n}`;
  if (action === 'delete') return `removed ${what} ${n}`;
  const changes = [];
  if (entity === 'marker') {
    if (before.x !== after.x || before.y !== after.y) {
      changes.push(`moved ${n} (${Math.round(before.x)},${Math.round(before.y)} → ${Math.round(after.x)},${Math.round(after.y)})`);
    }
    const s0 = before.data?.strength, s1 = after.data?.strength;
    if (s0 !== s1 && (s0 !== undefined || s1 !== undefined)) changes.push(`${n} strength ${s0 ?? 100}% → ${s1 ?? 100}%`);
    if (before.name !== after.name) changes.push(`renamed ${before.name} → ${after.name}`);
    if (before.adminOnly !== after.adminOnly) changes.push(after.adminOnly ? `hid ${n} from players` : `revealed ${n}`);
    if (JSON.stringify(before.visibleTo) !== JSON.stringify(after.visibleTo)) {
      changes.push(after.visibleTo ? `limited ${n} to ${after.visibleTo.join(', ')}` : `made ${n} visible to everyone`);
    }
    if (before.ownerId !== after.ownerId) changes.push(`changed owner of ${n}`);
    if (before.iconUrl !== after.iconUrl) changes.push(`changed icon of ${n}`);
    if (!!before.locked !== !!after.locked) changes.push(after.locked ? `locked ${n}` : `unlocked ${n}`);
  } else {
    if (JSON.stringify(before.points) !== JSON.stringify(after.points)) changes.push(`reshaped ${n}`);
    if (before.label !== after.label) changes.push(`relabelled ${n}`);
    if (!!before.locked !== !!after.locked) changes.push(after.locked ? `locked ${n}` : `unlocked ${n}`);
    if (before.adminOnly !== after.adminOnly) changes.push(after.adminOnly ? `hid ${n} from players` : `revealed ${n}`);
    if (JSON.stringify(before.visibleTo) !== JSON.stringify(after.visibleTo)) changes.push(`changed who can see ${n}`);
  }
  return changes.length ? changes.join('; ') : `edited ${what} ${n}`;
}

function serialize(row) {
  return {
    id: row.id, lobbyId: row.lobby_id, entity: row.entity, entityId: row.entity_id, action: row.action, summary: row.summary,
    userId: row.user_id, displayName: row.display_name || 'System',
    before: row.before ? JSON.parse(row.before) : null,
    after: row.after ? JSON.parse(row.after) : null,
    reverts: row.reverts, revertedBy: row.reverted_by, createdAt: row.created_at,
  };
}

/** Record a change. `before`/`after` are serialized entities (null for create/delete respectively). */
function record({ lobbyId, userId, entity, entityId, action, before, after, reverts = null }) {
  const summary = summarize(entity, action, before, after);
  const id = insert.run(lobbyId, userId, entity, entityId, action, summary,
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reverts, now()).lastInsertRowid;
  if (reverts) markReverted.run(id, reverts);
  return serialize(selectOne.get(id));
}

function get(id) { const r = selectOne.get(Number(id)); return r ? serialize(r) : null; }

function listFor(lobbyId, { entity = '', entityId = 0, limit = 100 } = {}) {
  return list.all(lobbyId, entity, entity, entityId, entityId, limit).map(serialize);
}

module.exports = { record, get, listFor, serialize };
