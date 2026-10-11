'use strict';
// A campaign ledger keeps conferences, war sides and negotiated obligations in the same transaction.
const { db, now } = require('./db');
const { randomUUID } = require('node:crypto');
db.exec(`CREATE TABLE IF NOT EXISTS treaty_ledgers (
  lobby_id INTEGER PRIMARY KEY REFERENCES lobbies(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}'
)`);
const read = db.prepare('SELECT data FROM treaty_ledgers WHERE lobby_id = ?');
const write = db.prepare('INSERT INTO treaty_ledgers (lobby_id, data) VALUES (?, ?) ON CONFLICT(lobby_id) DO UPDATE SET data = excluded.data');
const game = () => require('./game');
const load = id => ({ treaties: [], wars: [], coalitions: [], ...JSON.parse(read.get(id)?.data || '{}') });
const store = (id, data) => write.run(id, JSON.stringify(data));
const unique = a => [...new Set(a)];
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
const integer = (v, min, max, label) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < min || n > max) fail(`Invalid ${label}`); return n; };
const names = (id, ids) => ids.map(fid => game().q.faction.get(fid, id)?.name || `Nation #${fid}`).join(', ');
function announce(id, headline, body) {
  const gid = db.prepare(`INSERT INTO news_posts (lobby_id, faction_id, source_name, author_id, author_name, kind, headline,
    public_body, private_body, private_to, game_date, created_at) VALUES (?, NULL, 'Diplomatic dispatch', NULL, 'Diplomatic dispatch',
    'world-event', ?, ?, '', '[]', ?, ?)`).run(id, headline, body, game().get(id).date, now()).lastInsertRowid;
  require('./ws').broadcast(id, { type: 'newsChanged', id: Number(gid) });
}
function changed(id) { require('./ws').broadcast(id, { type: 'treatiesChanged' }); require('./vision').schedulePush(id); }
function actor(req) {
  if (req.lobbyRole === 'observer') fail('Observers cannot negotiate', 403);
  const f = req.lobbyRole === 'gm' ? game().q.faction.get(Number(req.body?.factionId), req.lobby.id)
    : game().q.factions.all(req.lobby.id).find(f => f.name.toLowerCase() === String(req.member?.nation || '').toLowerCase());
  if (!f) fail('Choose the nation you represent', 403);
  return f.id;
}
function live(t, c, turn) {
  return t.status === 'active' && turn >= (c.startTurn ?? t.effectiveTurn) &&
    (c.duration === null || turn < (c.startTurn ?? t.effectiveTurn) + c.duration) &&
    (t.duration === null || turn < t.effectiveTurn + t.duration) && !t.runtime?.[c.id]?.broken;
}
function clauses(id, kind, turn = game().get(id).turn) {
  return load(id).treaties.flatMap(t => t.clauses.filter(c => c.kind === kind && live(t, c, turn)).map(c => ({ t, c })));
}
function permission(id, guest, host, right) {
  if (guest === host) return true;
  if (game().relationStatus(id, guest, host) === 'war') return false;
  if (game().relationStatus(id, guest, host) === 'alliance') return true;
  return clauses(id, 'access').some(({ c }) => c.from === host && c.to === guest && c.rights.includes(right));
}
function accessResolver(id, guest, right) {
  const hosts = new Set(clauses(id, 'access').filter(({ c }) => c.to === guest && c.rights.includes(right)).map(({ c }) => c.from));
  const relations = game().relations(id), statuses = new Map(relations.filter(r => r.a === guest || r.b === guest).map(r => [r.a === guest ? r.b : r.a, r.status]));
  return host => host === guest || statuses.get(host) !== 'war' && (statuses.get(host) === 'alliance' || hosts.has(host));
}
function license(id, recipient, type, turn = game().get(id).turn) {
  return clauses(id, 'license', turn).find(({ c }) => c.to === recipient && c.unitType === type && game().relationStatus(id, c.from, c.to) !== 'war') || null;
}
function researchCost(id, fid, tech, state, turn = game().get(id).turn) {
  const r = require('./research').researchState(state);
  if (r.costs[tech.key] !== undefined) return r.costs[tech.key];
  if (r.active === tech.key || Number(r.progress[tech.key]) > 0) return tech.rp;
  const eligible = clauses(id, 'research', turn).some(({ c }) => {
    const partner = c.from === fid ? c.to : c.to === fid ? c.from : null;
    const row = partner && game().q.state.get(partner);
    return row && game().relationStatus(id, fid, partner) !== 'war' && JSON.parse(row.techs || '[]').includes(tech.key);
  });
  return eligible ? Math.round(tech.rp * 0.7 * 10) / 10 : tech.rp;
}
function validate(lobby, t, allowPast = false) {
  const id = lobby.id, members = t.participants;
  if (!Array.isArray(members) || members.length < 2 || members.length > 50 || unique(members).length !== members.length || members.some(fid => !game().q.faction.get(fid, id))) fail('Choose distinct participating nations');
  if (typeof t.title !== 'string' || !t.title.trim() || t.title.length > 160 || typeof t.text !== 'string' || t.text.length > 30000) fail('Add a title and keep the document under 30,000 characters');
  integer(t.effectiveTurn, allowPast ? 1 : game().get(id).turn, 1000000, 'effective turn');
  if (t.duration !== null) integer(t.duration, 1, 100000, 'treaty duration');
  if (!Array.isArray(t.clauses) || t.clauses.length > 100) fail('A treaty can contain up to 100 clauses');
  const ledger = load(id), war = t.warId && ledger.wars.find(w => w.id === t.warId && w.status === 'active');
  if (t.warId && (!war || JSON.stringify([...members].sort()) !== JSON.stringify([...war.attackers, ...war.defenders].sort()))) fail('A peace conference must include every nation on both sides of its active war');
  if (!war && members.some(a => members.some(b => a !== b && game().relationStatus(id, a, b) === 'war'))) fail('Use the shared peace conference when signatories are at war');
  const taken = new Set();
  for (const c of t.clauses) {
    if (!['transfer', 'annex', 'research', 'license', 'access', 'defense', 'coalition', 'dissolve', 'endAlliance', 'reparations', 'truce'].includes(c.kind)) fail('Unknown treaty clause');
    if (c.startTurn !== undefined) integer(c.startTurn, t.effectiveTurn, 1000000, 'clause start turn');
    if (c.duration !== null) integer(c.duration, 1, 100000, 'clause duration');
    if (t.duration !== null && (c.startTurn ?? t.effectiveTurn) >= t.effectiveTurn + t.duration) fail('A clause must start before the treaty expires');
    if (['transfer', 'annex', 'coalition', 'dissolve', 'endAlliance'].includes(c.kind) && (c.startTurn ?? t.effectiveTurn) !== t.effectiveTurn) fail('Territory and coalition changes must take effect with the treaty');
    if (c.kind === 'coalition') {
      if (!Array.isArray(c.members) || c.members.length < 2 || unique(c.members).length !== c.members.length || c.members.some(fid => !members.includes(fid))) fail('Choose at least two signatories for the coalition');
      if (!String(c.name || '').trim() || String(c.name).length > 100) fail('Name the coalition (up to 100 characters)');
      if (c.members.some(a => c.members.some(b => game().relationStatus(id, a, b) === 'war' && (!war || ![...war.attackers, ...war.defenders].includes(a) || ![...war.attackers, ...war.defenders].includes(b))))) fail('Coalition members must be at peace');
      continue;
    }
    if (c.kind === 'dissolve') {
      const co = ledger.coalitions.find(x => x.id === c.coalitionId && x.status === 'active');
      if (!co || co.members.some(fid => !members.includes(fid))) fail('Every member of an alliance being dissolved must sign');
      continue;
    }
    if (!members.includes(c.from) || !members.includes(c.to) || c.from === c.to) fail('Clause nations must be distinct signatories');
    if (c.kind === 'license') {
      const type = require('../public/js/units').forPack(lobby.unit_pack)?.LIST.find(u => u.id === c.unitType);
      const state = game().serializeState(game().q.state.get(c.from) || game().ensureState(id, c.from, game().get(id).settings));
      if (!type || !require('./research').canBuild(require('./research').effectsFor(require('./research').list(id), state.techs), c.unitType)) fail('The licensor must have unlocked that unit type');
    }
    if (c.kind === 'access' && (!Array.isArray(c.rights) || !c.rights.length || c.rights.some(r => !['land', 'ports', 'airfields', 'supply'].includes(r)))) fail('Choose movement or supply permissions');
    if (c.kind === 'reparations') {
      if (!Number.isFinite(c.amount) || c.amount <= 0 || c.amount > 1e9 || Math.round(c.amount * 10) !== c.amount * 10) fail('Payments must be positive currency amounts with at most one decimal place');
      integer(c.turns, 1, 100000, 'payment count');
      if (c.duration !== null && c.turns > c.duration) fail('Payment count exceeds clause duration');
      if (t.duration !== null && (c.startTurn ?? t.effectiveTurn) - t.effectiveTurn + c.turns > t.duration) fail('Payments must fall within the treaty duration');
    }
    if (c.kind === 'transfer' || c.kind === 'annex') {
      const provinces = require('./provinces');
      const list = provinces.list(id);
      const ids = c.kind === 'annex' ? list.filter(p => p.factionId === c.from).map(p => p.id) : c.provinceIds;
      if (!Array.isArray(ids) || !ids.length && !(c.kind === 'annex' && require('./territory').all(id).some(p => p.factionId === c.from))) fail('Select provinces to transfer');
      for (const pid of ids) {
        if (taken.has(pid) || !list.some(p => p.id === pid && p.factionId === c.from)) fail('A province is duplicated or no longer belongs to the ceding nation');
        taken.add(pid);
      }
    }
  }
}
function template(id, t) {
  const articles = t.clauses.map((c, i) => {
    const a = names(id, [c.from]), b = names(id, [c.to]);
    const content = {
      transfer: `${a} cedes ${c.provinceIds?.length || 0} selected provinces (${(c.provinceIds || []).join(', ')}) to ${b}.`,
      annex: `${a} cedes all its territory to ${b}.`, research: `${a} and ${b} establish a mutual research agreement: eligible new projects receive a 30% RP discount.`,
      license: `${a} licenses production of ${c.unitType} to ${b}. Unfinished licensed orders are cancelled and refunded when permission ends.`,
      access: `${a} grants ${b} access for ${(c.rights || []).join(', ')}.`, defense: `${a} and ${b} enter a mutual defensive pact.`,
      coalition: `${names(id, c.members || [])} form the permanent coalition “${c.name}”.`,
      dissolve: `The coalition ${load(id).coalitions.find(x => x.id === c.coalitionId)?.name || c.coalitionId} is dissolved.`, endAlliance: `${a} and ${b} dissolve their alliance.`,
      reparations: `${a} pays ${b} ${c.amount} currency per turn for ${c.turns} payment(s).`, truce: `${a} and ${b} agree to a truce.`,
    }[c.kind];
    return `Article ${i + 1}. ${content} Effective from turn ${c.startTurn ?? t.effectiveTurn}${c.duration === null ? ' indefinitely' : ` for ${c.duration} turns`}.`;
  });
  return `${t.title}\n\nSignatories: ${names(id, t.participants)}.\n\n${t.warId ? 'All signatories agree to end the covered war together upon this treaty taking effect. Occupied land remains with its current occupier unless an explicit territory clause assigns it otherwise.\n\n' : ''}${articles.join('\n\n')}\n\nEffective turn: ${t.effectiveTurn}. ${t.duration === null ? 'No overall expiry.' : `Duration: ${t.duration} turns.`}\n\nAdditional commitments:\n[Write roleplay terms here. Custom text is enforced by the players.]\n\nRatification requires every signatory to approve the same revision.`;
}
function normalizeClauses(cs) {
  if (!Array.isArray(cs)) fail('Choose treaty clauses');
  return cs.map(c => {
    const out = { id: randomUUID(), kind: c.kind, from: Number(c.from), to: Number(c.to), duration: c.duration == null || c.duration === '' ? null : Number(c.duration) };
    if (c.startTurn != null && c.startTurn !== '') out.startTurn = Number(c.startTurn);
    if (c.kind === 'transfer') out.provinceIds = Array.isArray(c.provinceIds) ? c.provinceIds.map(Number) : [];
    if (c.kind === 'access') out.rights = Array.isArray(c.rights) ? unique(c.rights) : [];
    if (c.kind === 'license') out.unitType = String(c.unitType || '');
    if (c.kind === 'coalition') { out.members = Array.isArray(c.members) ? c.members.map(Number) : []; out.name = String(c.name || '').trim(); }
    if (c.kind === 'dissolve') out.coalitionId = String(c.coalitionId || '');
    if (c.kind === 'reparations') { out.amount = Number(c.amount); out.turns = Number(c.turns); }
    return out;
  });
}
function invalidateConference(data, war, fid) {
  for (const t of data.treaties.filter(t => t.warId === war.id && ['draft', 'scheduled'].includes(t.status))) {
    t.status = 'draft'; t.participants = [...war.attackers, ...war.defenders]; t.approvals = {}; t.revision++; t.updatedAt = now();
    t.history.push({ revision: t.revision, by: fid, at: now(), action: 'War participants changed', text: t.text });
  }
}
// Legacy wars are imported without guessing that unrelated wars belong to one conference.
function importWars(id, data) {
  let dirty = false;
  for (const r of game().relations(id).filter(r => r.status === 'war')) {
    if (data.wars.some(w => w.status === 'active' && (w.attackers.includes(r.a) && w.defenders.includes(r.b) || w.attackers.includes(r.b) && w.defenders.includes(r.a)))) continue;
    data.wars.push({ id: randomUUID(), name: `${names(id, [r.a])}–${names(id, [r.b])} war`, attackers: [r.a], defenders: [r.b], leadAttacker: r.a, leadDefender: r.b, status: 'active', turn: r.sinceTurn }); dirty = true;
  }
  if (dirty) store(id, data);
}
function view(id, fid, gm) {
  const data = load(id); importWars(id, data);
  return { ...data, treaties: data.treaties.filter(t => gm || t.status !== 'draft' || t.participants.includes(fid)) };
}
function warEffects(lobby, data, war, turn) {
  const id = lobby.id, g = game();
  // A new participant can connect an existing allied war to this conference.
  let merging = true;
  while (merging) {
    merging = false;
    for (const other of data.wars.filter(w => w.id !== war.id && w.status === 'active')) {
      const aligned = other.attackers.some(a => war.attackers.includes(a)) && other.defenders.some(b => war.defenders.includes(b));
      const reversed = other.attackers.some(a => war.defenders.includes(a)) && other.defenders.some(b => war.attackers.includes(b));
      if (!aligned && !reversed) continue;
      const a = aligned ? other.attackers : other.defenders, b = aligned ? other.defenders : other.attackers;
      if (a.some(fid => war.defenders.includes(fid)) || b.some(fid => war.attackers.includes(fid))) fail('These wars have conflicting sides and cannot be merged');
      war.attackers = unique([...war.attackers, ...a]); war.defenders = unique([...war.defenders, ...b]);
      other.status = 'merged'; other.mergedInto = war.id; merging = true;
      for (const t of data.treaties.filter(t => t.warId === other.id && ['draft', 'scheduled'].includes(t.status))) t.warId = war.id;
    }
  }
  for (const a of war.attackers) for (const b of war.defenders) {
    g.setRelation(id, a, b, 'war', turn); g.cancelTradesBetween(id, a, b, 'cancelled by war');
    for (const t of data.treaties.filter(t => ['active', 'scheduled'].includes(t.status))) for (const c of t.clauses) {
      if (!((c.from === a && c.to === b) || (c.from === b && c.to === a)) || t.runtime[c.id]?.broken || c.duration !== null && turn >= (c.startTurn ?? t.effectiveTurn) + c.duration) continue;
      t.runtime[c.id] = { ...t.runtime[c.id], broken: true };
      t.events.push({ turn, kind: 'breach', text: `War between ${names(id, [a, b])} breaks article ${t.clauses.indexOf(c) + 1}.` });
      announce(id, `Treaty breached: ${t.title}`, t.events.at(-1).text);
    }
  }
}
function declare(lobby, a, b) {
  return game().transaction(() => {
    const data = load(lobby.id); importWars(lobby.id, data);
    let war = data.wars.find(w => w.status === 'active' && w.attackers.includes(a) && w.defenders.includes(b));
    if (!war) { war = { id: randomUUID(), name: `${names(lobby.id, [a])}–${names(lobby.id, [b])} war`, attackers: [a], defenders: [b], leadAttacker: a, leadDefender: b, status: 'active', turn: game().get(lobby.id).turn }; data.wars.push(war); }
    // Only defensive pacts force entry. Coalitions may choose to join either offensive or defensive wars.
    let added = true;
    while (added) {
      added = false;
      for (const { c } of clauses(lobby.id, 'defense')) {
        const ally = war.defenders.includes(c.from) ? c.to : war.defenders.includes(c.to) ? c.from : null;
        if (!ally || war.defenders.includes(ally) || war.attackers.includes(ally)) continue;
        war.defenders.push(ally); added = true;
      }
    }
    warEffects(lobby, data, war, game().get(lobby.id).turn); invalidateConference(data, war, a); store(lobby.id, data);
    refundInvalid(lobby, game().factionStates(lobby.id, game().get(lobby.id).settings), game().get(lobby.id).turn, true);
    announce(lobby.id, `War declared: ${war.name}`, `${names(lobby.id, war.attackers)} against ${names(lobby.id, war.defenders)}. Defensive partners have joined automatically.`);
    changed(lobby.id); return war;
  });
}
function activate(lobby, data, t, turn) {
  const g = game(), id = lobby.id;
  validate(lobby, t, true);
  t.status = 'active';
  const war = data.wars.find(w => w.id === t.warId);
  if (war) {
    for (const a of war.attackers) for (const b of war.defenders) {
      const another = data.wars.some(w => w.id !== war.id && w.status === 'active' && (w.attackers.includes(a) && w.defenders.includes(b) || w.attackers.includes(b) && w.defenders.includes(a)));
      if (!another) g.setRelation(id, a, b, 'peace', turn);
    }
    war.status = 'ended'; war.treatyId = t.id;
    for (const other of data.treaties.filter(x => x.id !== t.id && x.warId === war.id && ['draft', 'scheduled'].includes(x.status))) other.status = 'superseded';
  }
  applyDue(lobby, data, t, turn);
  t.events.push({ turn, kind: 'effective', text: 'Treaty entered into force.' });
  announce(id, `Treaty takes effect: ${t.title}`, `${names(id, t.participants)} have ratified revision ${t.revision}.${war ? ' The war has ended for all participants.' : ''}`);
  if (war) require('./discordWebhook').emit(id, lobby.name, { kind: 'peace', title: '🕊 Peace declared', description: `${t.title}: ${names(id, t.participants)} end the war together.`, fields: [{ name: 'Turn', value: turn, inline: true }] });
}
function applyDue(lobby, data, t, turn) {
  const id = lobby.id;
  for (const c of t.clauses.filter(c => live(t, c, turn))) {
    const rt = t.runtime[c.id] ||= {};
    if (rt.applied) continue;
    if (c.kind === 'transfer' || c.kind === 'annex') {
      const p = require('./provinces');
      const ids = c.kind === 'annex' ? p.list(id).filter(p => p.factionId === c.from).map(p => p.id) : c.provinceIds;
      if (ids.some(pid => !p.list(id).some(p => p.id === pid && p.factionId === c.from))) fail('Selected territory changed ownership before the treaty took effect');
      p.setOwner(id, ids, c.to);
      if (c.kind === 'annex' && !p.has(id)) {
        const territory = require('./territory');
        const land = territory.all(id).find(x => x.factionId === c.from);
        if (land) territory.carve(id, c.to, land.geometry, p.CLEAN);
      }
    }
    if (c.kind === 'coalition') {
      data.coalitions.push({ id: c.id, name: c.name, members: c.members, status: 'active', treatyId: t.id });
      for (const a of c.members) for (const b of c.members) if (a < b) game().setRelation(id, a, b, 'alliance', turn);
    }
    if (c.kind === 'dissolve') dissolve(id, data, c.coalitionId, turn);
    if (c.kind === 'endAlliance' && game().relationStatus(id, c.from, c.to) === 'alliance') {
      if (data.coalitions.some(x => x.status === 'active' && x.members.includes(c.from) && x.members.includes(c.to))) fail('Dissolve their coalition or leave it before ending its alliance');
      game().setRelation(id, c.from, c.to, 'peace', turn);
    }
    rt.applied = true;
  }
}
function dissolve(id, data, cid, turn) {
  const co = data.coalitions.find(x => x.id === cid && x.status === 'active');
  if (!co) return;
  co.status = 'dissolved';
  for (const a of co.members) for (const b of co.members) if (a < b && game().relationStatus(id, a, b) === 'alliance' && !data.coalitions.some(x => x.status === 'active' && x.members.includes(a) && x.members.includes(b))) game().setRelation(id, a, b, 'peace', turn);
}
// Called before production and research advance. Existing research keeps its locked RP requirement.
function tick(lobby, states, turn) {
  const data = load(lobby.id);
  for (const tid of data.treaties.map(t => t.id)) {
    const t = data.treaties.find(t => t.id === tid);
    if (t.status === 'scheduled' && t.effectiveTurn <= turn) {
      // A failed scheduled settlement must not partly end a war or cede territory.
      const backup = JSON.stringify(data);
      db.exec('SAVEPOINT treaty_activation');
      try { activate(lobby, data, t, turn); db.exec('RELEASE treaty_activation'); }
      catch (e) {
        db.exec('ROLLBACK TO treaty_activation'); db.exec('RELEASE treaty_activation');
        Object.assign(data, JSON.parse(backup)); require('./provinces').invalidate(lobby.id);
        const restored = data.treaties.find(x => x.id === t.id);
        restored.status = 'draft'; restored.approvals = {}; restored.revision++; restored.events.push({ turn, kind: 'blocked', text: e.message });
        announce(lobby.id, `Treaty requires renegotiation: ${restored.title}`, e.message); continue;
      }
    }
    if (t.status === 'active') applyDue(lobby, data, t, turn);
    for (const c of t.clauses.filter(c => c.kind === 'reparations')) {
      const rt = t.runtime[c.id] ||= { due: 0, paid: 0, payments: 0 };
      const paymentTurn = turn - 1;
      if (live(t, c, paymentTurn) && (rt.payments || 0) < c.turns && rt.lastTurn !== paymentTurn) {
        rt.due = (rt.due || 0) + c.amount; rt.payments = (rt.payments || 0) + 1; rt.lastTurn = paymentTurn;
      }
      const A = states.find(s => s.faction.id === c.from)?.state, B = states.find(s => s.faction.id === c.to)?.state;
      if (!A || !B || !(rt.due > 0)) continue;
      const amount = Math.round(Math.min(rt.due, Math.max(0, A.money)) * 10) / 10;
      A.money -= amount; B.money += amount; rt.paid = (rt.paid || 0) + amount; rt.due = Math.round((rt.due - amount) * 10) / 10;
      if (rt.due > 0 && rt.breachTurn !== turn) {
        rt.breachTurn = turn;
        const text = `${names(lobby.id, [c.from])} owes ${names(lobby.id, [c.to])} ${rt.due} currency in arrears under ${t.title}.`;
        t.events.push({ turn, kind: 'breach', text }); announce(lobby.id, `Reparations missed: ${t.title}`, text);
      }
    }
    if (t.status === 'active' && t.duration !== null && turn >= t.effectiveTurn + t.duration) t.status = 'expired';
  }
  store(lobby.id, data);
  syncOwnership(lobby);
  refundInvalid(lobby, states, turn);
  changed(lobby.id);
}
function refundInvalid(lobby, states, turn, save = false) {
  for (const { faction, state } of states) {
    for (const item of [...(state.production || [])]) if (item.license && !item.ready && !license(lobby.id, faction.id, item.typeId, turn)) {
      require('./production').cancel(state, item.id);
      announce(lobby.id, 'Licensed production cancelled', `${faction.name}'s unfinished ${item.typeId} production was cancelled and refunded because its license ended.`);
    }
    if (save) game().writeState(state);
  }
}
function syncOwnership(lobby) {
  const territory = require('./territory'), access = require('./lobbyAccess'), g = game();
  const factions = g.q.factions.all(lobby.id), markers = g.q.markers.all(lobby.id).map(access.serializeMarker);
  const lookup = territory.ownerLookup(lobby);
  for (const c of territory.ownershipChanges(lookup, factions, markers, lobby)) {
    const f = factions.find(f => f.name === c.nation), m = c.marker, emplacement = territory.isCapturableEmplacement(m);
    const data = { ...m.data, nation: c.nation, ...(emplacement ? { goal: null } : {}) };
    const owner = emplacement ? access.getMembers(lobby.id).find(member => member.nation?.toLowerCase() === c.nation.toLowerCase())?.user_id || null : m.ownerId;
    db.prepare('UPDATE markers SET data = ?, color = ?, owner_id = ?, updated_at = ? WHERE id = ? AND lobby_id = ?').run(JSON.stringify(data), emplacement ? f?.color || m.color : m.color, owner ?? null, now(), m.id, lobby.id);
  }
  const shapes = db.prepare("SELECT * FROM shapes WHERE lobby_id = ? AND kind = 'trench'").all(lobby.id).map(access.serializeShape);
  for (const c of territory.trenchOwnershipChanges(lookup, factions, shapes)) db.prepare('UPDATE shapes SET data = ?, updated_at = ? WHERE id = ? AND lobby_id = ?').run(JSON.stringify({ ...c.shape.data, nation: c.nation }), now(), c.shape.id, lobby.id);
}
function router(hooks) {
  const r = require('express').Router({ mergeParams: true });
  r.get('/', (req, res) => {
    const f = game().q.factions.all(req.lobby.id).find(f => f.name.toLowerCase() === String(req.member?.nation || '').toLowerCase());
    res.json(view(req.lobby.id, f?.id, req.lobbyRole === 'gm'));
  });
  const mutate = fn => (req, res) => {
    try {
      require('./provinces').get(req.lobby.id); // finish lazy geometry migrations before the treaty transaction
      const result = game().transaction(() => fn(req, actor(req)));
      hooks.sync(req); changed(req.lobby.id); res.json(result);
    } catch (e) { require('./provinces').invalidate(req.lobby.id); res.status(e.status || 400).json({ error: e.message }); }
  };
  r.post('/', mutate((req, fid) => {
    const id = req.lobby.id, data = load(id); importWars(id, data);
    const war = req.body.warId && data.wars.find(w => w.id === req.body.warId && w.status === 'active');
    if (req.body.warId && !war) fail('No active war');
    const participants = war ? [...war.attackers, ...war.defenders] : unique([fid, ...(Array.isArray(req.body.participants) ? req.body.participants.map(Number) : [])]);
    if (!participants.includes(fid)) fail('Your nation must be a participant', 403);
    const existing = war && data.treaties.find(t => t.warId === war.id && ['draft', 'scheduled'].includes(t.status));
    if (existing) return { treaty: existing };
    const t = { id: randomUUID(), title: String(req.body.title || (war ? `Peace treaty: ${war.name}` : 'Diplomatic treaty')).trim(), participants, warId: war?.id || null,
      leadNegotiators: war ? [war.leadAttacker, war.leadDefender] : [fid], text: '', clauses: normalizeClauses(req.body.clauses || []),
      effectiveTurn: game().get(id).turn, duration: null, status: 'draft', revision: 1, approvals: {}, runtime: {}, events: [], history: [], createdBy: fid, updatedAt: now() };
    validate(req.lobby, t); t.text = template(id, t); t.history.push({ revision: 1, by: fid, at: now(), action: 'Created', text: t.text });
    data.treaties.push(t); store(id, data); return { treaty: t };
  }));
  const find = (req, fid) => {
    const data = load(req.lobby.id), t = data.treaties.find(t => t.id === req.params.tid);
    if (!t) fail('No such treaty', 404);
    if (!t.participants.includes(fid)) fail('Only a signatory may negotiate', 403);
    if (Number(req.body.revision) !== t.revision) fail('Another participant changed this treaty. Your draft is preserved; review the latest revision before saving or approving.', 409);
    return { data, t };
  };
  r.patch('/:tid', mutate((req, fid) => {
    const { data, t } = find(req, fid);
    if (t.status !== 'draft') fail('Only drafts can be edited');
    const next = { ...t, title: String(req.body.title ?? t.title).trim(), text: String(req.body.text ?? t.text), clauses: req.body.clauses ? normalizeClauses(req.body.clauses) : t.clauses,
      effectiveTurn: Number(req.body.effectiveTurn ?? t.effectiveTurn), duration: req.body.duration === undefined ? t.duration : req.body.duration === null || req.body.duration === '' ? null : Number(req.body.duration) };
    if (!t.warId && req.body.participants) { if (!Array.isArray(req.body.participants)) fail('Choose signatories'); next.participants = unique(req.body.participants.map(Number)); if (!next.participants.includes(fid)) fail('You must remain a signatory'); }
    validate(req.lobby, next);
    if (req.body.generateText) next.text = template(req.lobby.id, next);
    const terms = cs => JSON.stringify(cs.map(({ id, ...c }) => c));
    const mechanicalChange = terms(next.clauses) !== terms(t.clauses) || next.effectiveTurn !== t.effectiveTurn || next.duration !== t.duration;
    next.documentNeedsReview = !req.body.generateText && next.text === t.text && (mechanicalChange || t.documentNeedsReview);
    Object.assign(t, next, { revision: t.revision + 1, approvals: {}, updatedAt: now() });
    t.history.push({ revision: t.revision, by: fid, at: now(), action: req.body.generateText ? 'Generated standard document' : 'Edited treaty', text: t.text, clauses: t.clauses, effectiveTurn: t.effectiveTurn, duration: t.duration }); t.history = t.history.slice(-40);
    store(req.lobby.id, data); return { treaty: t };
  }));
  r.post('/:tid/:action', mutate((req, fid) => {
    const { data, t } = find(req, fid), turn = game().get(req.lobby.id).turn;
    if (req.params.action === 'approve') {
      if (t.status !== 'draft') fail('Treaty is already ratified or closed'); validate(req.lobby, t);
      t.approvals[fid] = { revision: t.revision, at: now(), by: req.user.id };
      if (t.participants.every(fid => t.approvals[fid]?.revision === t.revision)) {
        t.status = 'scheduled';
        if (t.effectiveTurn <= turn) activate(req.lobby, data, t, turn);
      }
    } else if (req.params.action === 'revoke') {
      if (t.status !== 'draft') fail('Ratified treaties cannot revoke approval'); delete t.approvals[fid];
    } else if (req.params.action === 'withdraw') {
      if (!['draft', 'scheduled', 'active'].includes(t.status)) fail('Treaty is already closed');
      const breach = t.status !== 'draft'; t.status = 'withdrawn';
      const text = `${names(req.lobby.id, [fid])} withdrew from ${t.title}${breach ? ', breaking its remaining obligations' : ''}.`;
      t.events.push({ turn, kind: breach ? 'breach' : 'withdrawal', text });
      if (breach) announce(req.lobby.id, `Treaty broken: ${t.title}`, text);
    } else fail('Unknown treaty action');
    store(req.lobby.id, data);
    // Cancellation refunds must also happen immediately when an active license is withdrawn.
    for (const { faction, state } of game().factionStates(req.lobby.id, game().get(req.lobby.id).settings)) {
      for (const item of [...state.production]) if (item.license && !item.ready && !license(req.lobby.id, faction.id, item.typeId)) require('./production').cancel(state, item.id);
      game().writeState(state);
    }
    return { treaty: t };
  }));
  r.post('/wars/:wid/join', mutate((req, fid) => {
    const id = req.lobby.id, data = load(id), war = data.wars.find(w => w.id === req.params.wid && w.status === 'active');
    if (!war || !['attackers', 'defenders'].includes(req.body.side)) fail('Choose an active war and a side');
    if ([...war.attackers, ...war.defenders].includes(fid)) fail('Already participating');
    if (!war[req.body.side].some(ally => data.coalitions.some(c => c.status === 'active' && c.members.includes(ally) && c.members.includes(fid)) || game().relationStatus(id, fid, ally) === 'alliance')) fail('You must be allied to a member of that side');
    war[req.body.side].push(fid); warEffects(req.lobby, data, war, game().get(id).turn); invalidateConference(data, war, fid); store(id, data);
    announce(id, `${names(id, [fid])} joins ${war.name}`, `${names(id, war.attackers)} against ${names(id, war.defenders)}.`); return { war };
  }));
  r.post('/coalitions/:cid/leave', mutate((req, fid) => {
    const id = req.lobby.id, data = load(id), co = data.coalitions.find(c => c.id === req.params.cid && c.status === 'active');
    if (!co || !co.members.includes(fid)) fail('You are not a member of that coalition');
    const old = [...co.members]; co.members = co.members.filter(x => x !== fid);
    if (co.members.length < 2) co.status = 'dissolved';
    for (const ally of old.filter(x => x !== fid)) if (game().relationStatus(id, fid, ally) === 'alliance' && !data.coalitions.some(c => c.status === 'active' && c.members.includes(fid) && c.members.includes(ally))) game().setRelation(id, fid, ally, 'peace', game().get(id).turn);
    store(id, data); announce(id, 'Coalition membership changed', `${names(id, [fid])} left ${co.name}. Existing wars continue until a shared peace is ratified.`); return { coalition: co };
  }));
  return r;
}
module.exports = { load, store, view, router, declare, permission, accessResolver, license, researchCost, tick, template, validate, live, announce };
