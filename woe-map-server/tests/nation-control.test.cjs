'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const accessModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/lobbyAccess.js'), 'utf8'), {
  module: accessModule,
  require: () => ({ db: { prepare: () => ({}) } }),
});
const source = fs.readFileSync(path.join(__dirname, '../public/js/map.js'), 'utf8');
const client = { state: {}, me: { id: 2 }, readOnly: () => client.state.realRole === 'observer' };
vm.createContext(client);
vm.runInContext(source.slice(source.indexOf('  function canEdit(m)'), source.indexOf('  function canEditShape(')), client);

test('map and server grant nation control while retaining owner, observer and GM-view restrictions', () => {
  const player = { role: 'player', realRole: 'player', userId: 2, nation: '  Test Nation  ' };
  const unit = { type: 'unit', ownerId: 1, data: { nation: 'test nation' } };
  const cases = [
    [unit, player, true],
    [{ ...unit, ownerId: null }, player, true],
    [{ ...unit, type: 'hero' }, player, true],
    [{ ...unit, type: 'town' }, player, false],
    [{ ...unit, adminOnly: true }, player, false],
    [{ ...unit, data: { nation: 'Other nation' } }, player, false],
    [unit, { ...player, nation: 'Other nation' }, false],
    [unit, { ...player, nation: '' }, false],
    [{ ...unit, data: { nation: '' } }, { ...player, nation: '  ' }, false],
    [{ ...unit, ownerId: 2, data: {} }, { ...player, nation: '' }, true],
    [unit, { ...player, role: 'gm', realRole: 'observer' }, false],
    [{ ...unit, adminOnly: true }, { ...player, role: 'gm', realRole: 'gm' }, true],
    [unit, { ...player, realRole: 'gm', viewAs: 3 }, true],
    [{ ...unit, ownerId: 2, data: { nation: 'Other nation' } }, { ...player, realRole: 'gm', viewAs: 3 }, false],
  ];
  for (const [marker, viewer, expected] of cases) {
    client.state = { role: viewer.role, realRole: viewer.realRole, member: { nation: viewer.nation },
      viewAs: viewer.viewAs ? { name: viewer.nation } : null };
    assert.equal(accessModule.exports.canControl(marker, viewer), expected, JSON.stringify({ marker, viewer }));
    assert.equal(client.canEdit(marker), expected, 'map: ' + JSON.stringify({ marker, viewer }));
  }
});
