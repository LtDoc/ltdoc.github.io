'use strict';
/**
 * Game-layer routes, mounted by routes/lobbies.js under /api/lobbies/:id/game so the lobby middleware
 * (req.lobby, req.lobbyRole, req.member) is already in place.
 */
const express = require('express');
const access = require('../lobbyAccess');
const hub = require('../ws');
const game = require('../game');
const GameData = require('../../public/js/game-data');

const territory = require('../territory');
const provinces = require('../provinces');
const zlib = require('node:zlib');

const production = require('../production');
const research = require('../research');
const UnitTypes = require('../../public/js/units');
const geo = require('../geo');

module.exports = function gameRoutes({ logEvent, clean, num, clamp, setMarkerNation, setShapeNation, shapeById, createMarker }) {
  const router = express.Router({ mergeParams: true });

  function requireGm(req, res, next) {
    if (req.lobbyRole !== 'gm') return res.status(403).json({ error: 'Game master only' });
    next();
  }
  /** A faction's treasury is visible to the GM, to its player(s), and to everyone when the treasury is public. */
  function canSeeState(req, g, faction) {
    if (req.lobbyRole === 'gm' || g.settings.publicTreasury) return true;
    return String(req.member?.nation || '').toLowerCase() === faction.name.toLowerCase();
  }
  function myFaction(req) {
    const n = String(req.member?.nation || '').toLowerCase();
    return n ? game.q.factions.all(req.lobby.id).find(f => f.name.toLowerCase() === n) || null : null;
  }
  function stateView(req, g, markers) {
    return game.factionStates(req.lobby.id, g.settings).map(({ faction, state }) => {
      const visible = canSeeState(req, g, faction);
      const units = markers.filter(m => m.type === 'unit' && String(m.data?.nation || '').toLowerCase() === faction.name.toLowerCase());
      const out = { faction, unitCount: units.length, visible };
      if (visible) {
        out.state = state;
        out.income = game.incomeFor(req.lobby, g, faction, state, markers);
      }
      return out;
    });
  }
  function broadcastGame(lobbyId, g) { hub.broadcast(lobbyId, { type: 'game', game: g }); }
  /** Push one faction's state to its player(s) and the GM (everyone when treasuries are public). */
  function broadcastFaction(req, g, faction) {
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const state = game.serializeState(game.q.state.get(faction.id) || game.ensureState(req.lobby.id, faction.id, g.settings));
    const msg = { type: 'faction', faction: access.serializeFaction(faction), state, income: game.incomeFor(req.lobby, g, faction, state, markers) };
    hub.broadcast(req.lobby.id, msg, ws => ws.lobbyRole === 'gm' || g.settings.publicTreasury || String(ws.nation || '').toLowerCase() === faction.name.toLowerCase());
  }

  router.get('/', (req, res) => {
    const g = game.get(req.lobby.id);
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const mine = myFaction(req);
    res.json({
      game: g, factions: g.enabled ? stateView(req, g, markers) : [], myFactionId: mine ? mine.id : null,
      canUndo: req.lobbyRole === 'gm' && !!game.q.lastSnapshot.get(req.lobby.id),
      relations: game.relations(req.lobby.id),
      diplomacy: game.diplomacy(req.lobby.id).filter(d => req.lobbyRole === 'gm' || d.from === (mine && mine.id) || d.to === (mine && mine.id)),
      hasTerritories: territory.all(req.lobby.id).length > 0,
      reports: g.enabled ? visibleReports(req, g, game.reports(req.lobby.id)) : { turn: null, turns: [], reports: [] },
    });
  });

  /** Turn reports the viewer may read: the GM sees every faction, a player their own (everyone when treasuries are public). */
  function visibleReports(req, g, r) {
    const factions = game.q.factions.all(req.lobby.id).map(access.serializeFaction);
    return { ...r, reports: r.reports.map(x => ({ ...x, faction: factions.find(f => f.id === x.factionId) || null }))
      .filter(x => x.faction && canSeeState(req, g, x.faction)) };
  }
  router.get('/reports', (req, res) => {
    const g = game.get(req.lobby.id);
    res.json(visibleReports(req, g, game.reports(req.lobby.id, Number(req.query.turn) || undefined)));
  });

  // ---- Territories ----------------------------------------------------------------------------
  function broadcastTerritories(lobbyId, changed) {
    if (changed && changed.length) hub.broadcast(lobbyId, { type: 'territory', territories: changed });
  }
  /** Apply territory-driven ownership to nodes, factories and towns; returns the markers that changed. */
  function applyOwnership(req) {
    const factions = game.q.factions.all(req.lobby.id).map(access.serializeFaction);
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const terrs = territory.all(req.lobby.id);
    const changes = territory.ownershipChanges(terrs, factions, markers);
    const out = changes.map(c => setMarkerNation(req, c.marker, c.nation));
    for (const c of territory.trenchOwnershipChanges(terrs, factions, shapeById(req, null, true))) out.push(setShapeNation(req, c.shape, c.nation));
    return out;
  }

  router.get('/territories', (req, res) => res.json({ territories: territory.all(req.lobby.id) }));

  router.post('/territory/seed-earth', requireGm, (req, res) => {
    const g = game.get(req.lobby.id);
    const factions = game.q.factions.all(req.lobby.id).map(access.serializeFaction);
    let r;
    try { r = territory.seedFromYear(req.lobby, req.body?.year, factions); } catch (e) { return res.status(400).json({ error: e.message }); }
    const flipped = applyOwnership(req);
    logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} assigned the borders of ${Number(req.body.year)} to ${r.assigned.length} factions (${r.unassigned.length} states left neutral)`);
    hub.broadcast(req.lobby.id, { type: 'territory', territories: territory.all(req.lobby.id), replace: true });
    res.json({ territories: territory.all(req.lobby.id), assigned: r.assigned, unassigned: r.unassigned, flipped: flipped.length, game: g });
  });

  router.post('/territory/assign', requireGm, (req, res) => {
    const shape = shapeById(req, Number(req.body?.shapeId));
    if (!shape || shape.kind !== 'area') return res.status(400).json({ error: 'Pick an area drawing' });
    const fid = Number(req.body?.factionId) || territory.NEUTRAL;
    if (fid && !game.q.faction.get(fid, req.lobby.id)) return res.status(404).json({ error: 'No such faction' });
    const changed = territory.assignArea(req.lobby, fid, shape.points);
    const flipped = applyOwnership(req);
    broadcastTerritories(req.lobby.id, changed);
    res.json({ changed: changed.length, flipped: flipped.length });
  });

  router.post('/territory/brush', requireGm, (req, res) => {
    const fid = Number(req.body?.factionId) || territory.NEUTRAL;
    if (fid && !game.q.faction.get(fid, req.lobby.id)) return res.status(404).json({ error: 'No such faction' });
    const x = num(req.body?.x), y = num(req.body?.y), km = clamp(num(req.body?.radiusKm, 60), 1, 5000);
    const changed = territory.brush(req.lobby, fid, x, y, km);
    const flipped = applyOwnership(req);
    broadcastTerritories(req.lobby.id, changed);
    res.json({ changed: changed.length, flipped: flipped.length });
  });

  router.post('/territory/clear', requireGm, (req, res) => {
    territory.clear(req.lobby.id);
    const hadProvinces = provinces.has(req.lobby.id);
    provinces.clear(req.lobby.id);
    hub.broadcast(req.lobby.id, { type: 'territory', territories: [], replace: true });
    if (hadProvinces) hub.broadcast(req.lobby.id, { type: 'provinces' });
    logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} cleared all territories${hadProvinces ? ' and provinces' : ''}`);
    res.json({ ok: true });
  });

  // ---- Provinces (Earth map) --------------------------------------------------------------------
  /** The province set, gzipped (about 15k small polygons for the whole world); cached until it is regenerated. */
  const provinceCache = new Map();   // lobbyId -> { stamp, buf }
  router.get('/provinces', (req, res) => {
    const list = provinces.list(req.lobby.id);
    const stamp = list.length ? `${list.length}:${list[list.length - 1].id}` : '0';
    let hit = provinceCache.get(req.lobby.id);
    if (!hit || hit.stamp !== stamp) {
      const body = JSON.stringify({ provinces: list.map(p => ({ id: p.id, n: p.name, s: p.state, x: p.cx, y: p.cy, g: p.geometry })) });
      hit = { stamp, buf: zlib.gzipSync(Buffer.from(body, 'utf8')) };
      provinceCache.set(req.lobby.id, hit);
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Cache-Control', 'no-store');
    res.end(hit.buf);
  });

  const generating = new Set();
  router.post('/provinces/generate', requireGm, async (req, res) => {
    if (!geo.isEarth(req.lobby)) return res.status(400).json({ error: 'Provinces need the Earth map' });
    if (generating.has(req.lobby.id)) return res.status(409).json({ error: 'Provinces are already being generated' });
    const year = Number(req.body?.year) || 1914, sizeKm = clamp(num(req.body?.sizeKm, 100), 40, 400);
    generating.add(req.lobby.id);
    const lobbyId = req.lobby.id;
    const progress = (text, done, total) => hub.broadcast(lobbyId, { type: 'progress', task: 'provinces', text, done, total }, ws => ws.lobbyRole === 'gm');
    res.json({ started: true });   // the rest arrives over the socket
    try {
      const r = await provinces.generate(req.lobby, { year, sizeKm }, progress);
      const factions = game.q.factions.all(lobbyId).map(access.serializeFaction);
      const a = provinces.assignByState(lobbyId, factions);
      const flipped = applyOwnership(req);
      logEvent(lobbyId, req.user.id, 'system', `${req.user.displayName} cut the world of ${year} into ${r.count} provinces (about ${sizeKm} km across); ${a.assigned.length} states assigned, ${a.unassigned.length} left neutral${flipped.length ? `, ${flipped.length} places changed hands` : ''}`);
      hub.broadcast(lobbyId, { type: 'provinces' });
      hub.broadcast(lobbyId, { type: 'territory', territories: territory.all(lobbyId), replace: true });
      progress('Done', 1, 1);
    } catch (e) {
      console.warn('province generation failed', e);
      hub.broadcast(lobbyId, { type: 'progress', task: 'provinces', text: `Failed: ${e.message}`, done: 0, total: 0, error: true }, ws => ws.lobbyRole === 'gm');
    } finally { generating.delete(lobbyId); }
  });

  // ---- Production ------------------------------------------------------------------------------
  function factionFor(req, fid) {
    if (req.lobbyRole === 'gm' && fid) return game.q.faction.get(Number(fid), req.lobby.id) || null;
    return myFaction(req);
  }
  function productionView(req, g, faction) {
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const state = game.serializeState(game.q.state.get(faction.id) || game.ensureState(req.lobby.id, faction.id, g.settings));
    const fx = research.effectsFor(research.list(req.lobby.id), state.techs || []);
    const sites = production.sites(req.lobby, g, access.serializeFaction(faction), markers, fx).map(s => ({
      ...s, coastal: geo.isEarth(req.lobby) ? territory.isCoastal(req.lobby, s.x, s.y, num(g.settings.coastalKm, 30)) : true,
      queue: (state.production || []).filter(q => q.siteId === s.id && q.typeId !== 'factory'),
    }));
    const factories = (state.production || []).filter(q => q.typeId === 'factory');
    const costs = Object.fromEntries([...UnitTypes.LIST.map(t => t.id), 'factory'].map(id => [id, production.costWith(g, fx, id)]));
    const buildable = Object.fromEntries(UnitTypes.LIST.map(t => [t.id, research.canBuild(fx, t.id)]));
    return { factionId: faction.id, sites, factoryBuilds: factories, costs, buildable, state };
  }

  router.get('/production', (req, res) => {
    const g = game.get(req.lobby.id);
    if (!g.enabled) return res.status(400).json({ error: 'Game mode is off' });
    const f = factionFor(req, req.query.factionId);
    if (!f) return res.status(400).json({ error: 'You need a faction' });
    res.json(productionView(req, g, f));
  });

  /** Queue a build: { typeId, siteId } for units, { typeId: 'factory', x, y } for a new factory. */
  router.post('/production', (req, res) => {
    const g = game.get(req.lobby.id);
    if (!g.enabled) return res.status(400).json({ error: 'Game mode is off' });
    const f = factionFor(req, req.body?.factionId);
    if (!f) return res.status(400).json({ error: 'You need a faction to build' });
    const faction = access.serializeFaction(f);
    const state = game.serializeState(game.q.state.get(f.id) || game.ensureState(req.lobby.id, f.id, g.settings));
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    let item;
    const fx = research.effectsFor(research.list(req.lobby.id), state.techs || []);
    try { item = production.queue(req.lobby, g, faction, state, markers, { typeId: String(req.body?.typeId || ''), siteId: req.body?.siteId, x: req.body?.x, y: req.body?.y }, fx); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    game.writeState(state);
    const what = item.typeId === 'factory' ? 'a factory' : (UnitTypes.LIST.find(t => t.id === item.typeId)?.unit || item.typeId);
    logEvent(req.lobby.id, req.user.id, 'system', `${faction.name} begins building ${what} at ${item.siteName} (${item.turns} turn${item.turns === 1 ? '' : 's'})`, { faction: faction.name },
      ws => ws.lobbyRole === 'gm' || g.settings.publicTreasury || String(ws.nation || '').toLowerCase() === faction.name.toLowerCase());
    broadcastFaction(req, g, f);
    res.status(201).json({ item, ...productionView(req, g, f) });
  });

  router.delete('/production/:qid', (req, res) => {
    const g = game.get(req.lobby.id);
    const f = factionFor(req, req.query.factionId);
    if (!f) return res.status(400).json({ error: 'You need a faction' });
    const state = game.serializeState(game.q.state.get(f.id) || game.ensureState(req.lobby.id, f.id, g.settings));
    try { production.cancel(state, req.params.qid); } catch (e) { return res.status(404).json({ error: e.message }); }
    game.writeState(state);
    broadcastFaction(req, g, f);
    res.json(productionView(req, g, f));
  });

  // ---- Research --------------------------------------------------------------------------------
  function techView(req, g, faction) {
    const techs = research.list(req.lobby.id);
    const state = game.serializeState(game.q.state.get(faction.id) || game.ensureState(req.lobby.id, faction.id, g.settings));
    const r = research.researchState(state);
    const fx = research.effectsFor(techs, state.techs || []);
    const have = new Set(state.techs || []);
    const items = techs.map(t => ({
      ...t, unlocked: have.has(t.key), active: r.active === t.key, queued: r.queue.includes(t.key), progress: r.progress[t.key] || 0,
      blocker: have.has(t.key) ? null : research.blocker(t, state, techs, g),
    }));
    return {
      factionId: faction.id, techs: items, research: r, rp: state.rp, money: state.money, year: research.yearOf(g.date), lead: num(g.settings.researchLead, 1),
      effects: { unlocked: [...fx.unlocked], gated: [...fx.gated], cover: fx.cover, capacity: fx.capacity, recover: fx.recover, flags: [...fx.flags], income: fx.income, statCat: fx.statCat, statUnit: fx.statUnit },
    };
  }
  router.get('/techs', (req, res) => {
    const g = game.get(req.lobby.id);
    research.ensureTree(req.lobby.id);
    const f = factionFor(req, req.query.factionId);
    if (!f) return res.json({ factionId: null, techs: research.list(req.lobby.id), research: null, year: research.yearOf(g.date), lead: num(g.settings.researchLead, 1) });
    res.json(techView(req, g, f));
  });
  /** Player (or GM for a faction) starts or queues a project. */
  router.post('/research', (req, res) => {
    const g = game.get(req.lobby.id);
    if (!g.enabled) return res.status(400).json({ error: 'Game mode is off' });
    const f = factionFor(req, req.body?.factionId);
    if (!f) return res.status(400).json({ error: 'You need a faction to research' });
    const techs = research.list(req.lobby.id), tech = techs.find(t => t.key === String(req.body?.key || ''));
    const state = game.serializeState(game.q.state.get(f.id) || game.ensureState(req.lobby.id, f.id, g.settings));
    try { research.start(state, tech, techs, g); } catch (e) { return res.status(400).json({ error: e.message }); }
    game.writeState(state);
    const r = research.researchState(state);
    logEvent(req.lobby.id, req.user.id, 'system', `${f.name} ${r.active === tech.key ? 'begins researching' : 'plans to research'} ${tech.name}`, { faction: f.name },
      ws => ws.lobbyRole === 'gm' || g.settings.publicTreasury || String(ws.nation || '').toLowerCase() === f.name.toLowerCase());
    broadcastFaction(req, g, f);
    res.status(201).json(techView(req, g, f));
  });
  router.delete('/research/:key', (req, res) => {
    const g = game.get(req.lobby.id);
    const f = factionFor(req, req.query.factionId);
    if (!f) return res.status(400).json({ error: 'You need a faction' });
    const state = game.serializeState(game.q.state.get(f.id) || game.ensureState(req.lobby.id, f.id, g.settings));
    research.drop(state, String(req.params.key));
    research.promote(state, research.list(req.lobby.id), g);
    game.writeState(state);
    broadcastFaction(req, g, f);
    res.json(techView(req, g, f));
  });
  /** GM: unlock or lock a tech for a faction directly. */
  router.post('/factions/:fid/techs', requireGm, (req, res) => {
    const g = game.get(req.lobby.id);
    const f = game.q.faction.get(Number(req.params.fid), req.lobby.id);
    if (!f) return res.status(404).json({ error: 'No such faction' });
    const tech = research.get(req.lobby.id, String(req.body?.key || ''));
    if (!tech) return res.status(404).json({ error: 'No such tech' });
    const state = game.serializeState(game.q.state.get(f.id) || game.ensureState(req.lobby.id, f.id, g.settings));
    research.setUnlocked(state, tech.key, !!req.body?.unlocked);
    game.writeState(state);
    logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} ${req.body?.unlocked ? 'granted' : 'removed'} ${tech.name} ${req.body?.unlocked ? 'to' : 'from'} ${f.name}`);
    broadcastFaction(req, g, f);
    res.json(techView(req, g, f));
  });
  /** GM tree editing. */
  router.post('/techs', requireGm, (req, res) => {
    try { res.status(201).json({ tech: research.upsert(req.lobby.id, req.body || {}) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.delete('/techs/:key', requireGm, (req, res) => { research.remove(req.lobby.id, String(req.params.key)); res.json({ ok: true }); });
  router.post('/techs/reset', requireGm, (req, res) => {
    const n = research.seedDefault(req.lobby.id, true);
    logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} reset the tech tree to the default (${n} techs)`);
    res.json({ count: n });
  });

  // ---- Earth datasets: major cities and resource deposits ------------------------------------
  router.post('/cities/seed', requireGm, (req, res) => {
    if (!geo.isEarth(req.lobby)) return res.status(400).json({ error: 'Major cities come with the Earth map' });
    let cities;
    try { cities = JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('../config').root, 'public', 'earth', 'cities.json'), 'utf8')).cities; }
    catch { return res.status(500).json({ error: 'cities.json is missing: run scripts/prepare-cities.js' }); }
    const W = req.lobby.map_width, H = req.lobby.map_height;
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const existing = new Set(markers.filter(m => m.type === 'town').map(m => m.name.toLowerCase()));
    const terrs = territory.all(req.lobby.id);
    const factions = game.q.factions.all(req.lobby.id).map(access.serializeFaction);
    const byId = new Map(factions.map(f => [f.id, f]));
    let created = 0;
    for (const c of cities) {
      if (existing.has(c.n.toLowerCase())) continue;
      const [x, y] = geo.project(c.lon, c.lat, W, H);
      const owner = terrs.length ? territory.ownerAt(terrs, x, y) : null;
      const faction = owner && owner !== territory.NEUTRAL ? byId.get(owner) : null;
      const size = c.cap ? 'capital' : 'city';
      createMarker(req, { type: 'town', name: c.n, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, color: faction ? faction.color : '#95a5a6', locked: true,
        data: { size, nation: faction ? faction.name : '', industry: c.ind + (c.cap ? 1 : 0), major: true } }, true);
      created++;
    }
    logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} added ${created} major cities of 1914`);
    res.json({ created, skipped: cities.length - created });
  });

  /** Place resource nodes from the historical dataset and optionally scatter smaller "fill" nodes on land. */
  router.post('/resources/generate', requireGm, (req, res) => {
    if (!geo.isEarth(req.lobby)) return res.status(400).json({ error: 'Resource generation uses the Earth map; place nodes by hand on image maps' });
    let rows;
    try { rows = JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('../config').root, 'public', 'earth', 'resources.json'), 'utf8')).resources; }
    catch { return res.status(500).json({ error: 'resources.json is missing' }); }
    const W = req.lobby.map_width, H = req.lobby.map_height;
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const existing = new Set(markers.filter(m => m.type === 'resource').map(m => m.name.toLowerCase()));
    const terrs = territory.all(req.lobby.id);
    const factions = game.q.factions.all(req.lobby.id).map(access.serializeFaction);
    const byId = new Map(factions.map(f => [f.id, f]));
    const place = (name, kind, x, y, yieldN) => {
      const owner = terrs.length ? territory.ownerAt(terrs, x, y) : null;
      const faction = owner && owner !== territory.NEUTRAL ? byId.get(owner) : null;
      createMarker(req, { type: 'resource', name, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, color: faction ? faction.color : '#95a5a6', locked: true,
        data: { kind, yield: yieldN, nation: faction ? faction.name : '' } }, true);
    };
    let created = 0;
    if (req.body?.dataset !== false) {
      for (const r of rows) {
        if (existing.has(r.n.toLowerCase()) || !GameData.byKey[r.k]) continue;
        const [x, y] = geo.project(r.lon, r.lat, W, H);
        place(r.n, r.k, x, y, clamp(num(r.y, 2), 1, 20));
        created++;
      }
    }
    // Fill: random small nodes on land (rejection sampling in the map's land bbox), seeded so reruns differ.
    const fill = clamp(Math.round(num(req.body?.fill, 0)), 0, 400);
    let filled = 0;
    if (fill > 0) {
      const keys = GameData.RESOURCE_KEYS;
      let seed = (Date.now() % 100000) + 1;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      let tries = 0;
      while (filled < fill && tries < fill * 40) {
        tries++;
        const x = rnd() * W, y = (0.08 + rnd() * 0.78) * H;   // skip the polar rows
        if (!territory.isLand(req.lobby, x, y)) continue;
        const kind = keys[Math.floor(rnd() * keys.length)];
        place(`${GameData.byKey[kind].name} deposit`, kind, x, y, 1 + Math.floor(rnd() * 2));
        filled++;
      }
    }
    logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} generated ${created} historical resource regions${filled ? ` and ${filled} smaller deposits` : ''}`);
    res.json({ created, filled });
  });

  // ---- Relations and diplomacy ---------------------------------------------------------------
  function broadcastRelations(lobbyId) {
    hub.broadcast(lobbyId, { type: 'relations', relations: game.relations(lobbyId), diplomacy: game.diplomacy(lobbyId) });
  }
  function factionName(req, id) { return game.q.faction.get(Number(id), req.lobby.id)?.name || '?'; }

  router.patch('/relations', requireGm, (req, res) => {
    const a = Number(req.body?.a), b = Number(req.body?.b), status = ['peace', 'war', 'alliance'].includes(req.body?.status) ? req.body.status : null;
    if (!status || !a || !b || a === b) return res.status(400).json({ error: 'Pick two factions and a status' });
    if (!game.q.faction.get(a, req.lobby.id) || !game.q.faction.get(b, req.lobby.id)) return res.status(404).json({ error: 'No such faction' });
    const g = game.get(req.lobby.id);
    game.setRelation(req.lobby.id, a, b, status, g.turn);
    logEvent(req.lobby.id, req.user.id, 'system', `${factionName(req, a)} and ${factionName(req, b)} are now at ${status === 'alliance' ? 'alliance' : status}`);
    broadcastRelations(req.lobby.id);
    res.json({ relations: game.relations(req.lobby.id) });
  });

  /** A player (for their faction) or the GM queues a declaration or proposal. War waits for the GM; peace and alliance too, then the other side. */
  router.post('/diplomacy', (req, res) => {
    const kind = ['war', 'peace', 'alliance'].includes(req.body?.kind) ? req.body.kind : null;
    const to = Number(req.body?.toFactionId);
    const mine = req.lobbyRole === 'gm' && req.body?.fromFactionId ? game.q.faction.get(Number(req.body.fromFactionId), req.lobby.id) : myFaction(req);
    if (!kind || !mine) return res.status(400).json({ error: 'You need a faction to conduct diplomacy' });
    if (!game.q.faction.get(to, req.lobby.id) || to === mine.id) return res.status(400).json({ error: 'Pick another faction' });
    const cur = game.relationStatus(req.lobby.id, mine.id, to);
    if (kind === 'war' && cur === 'war') return res.status(400).json({ error: 'Already at war' });
    if (kind === 'peace' && cur !== 'war') return res.status(400).json({ error: 'Not at war' });
    if (kind === 'alliance' && cur === 'alliance') return res.status(400).json({ error: 'Already allied' });
    const g = game.get(req.lobby.id);
    const id = game.q.insertDiplomacy.run(req.lobby.id, mine.id, to, kind, 'pending', clean(req.body?.note, 200), req.user.id, Date.now()).lastInsertRowid;
    const verb = kind === 'war' ? 'queued a declaration of war on' : kind === 'peace' ? 'offered peace to' : 'proposed an alliance to';
    logEvent(req.lobby.id, req.user.id, 'system', `${mine.name} ${verb} ${factionName(req, to)} (awaiting the GM)`, { diplomacyId: id },
      ws => ws.lobbyRole === 'gm' || String(ws.nation || '').toLowerCase() === mine.name.toLowerCase());
    broadcastRelations(req.lobby.id);
    res.status(201).json({ diplomacy: game.serializeDiplomacy(game.q.diplomacyOne.get(id, req.lobby.id)), turn: g.turn });
  });

  /** GM approves or blocks; the other faction's player accepts or declines an approved offer. */
  router.post('/diplomacy/:did/:action', (req, res) => {
    const d = game.q.diplomacyOne.get(Number(req.params.did), req.lobby.id);
    if (!d) return res.status(404).json({ error: 'No such proposal' });
    const action = req.params.action, gm = req.lobbyRole === 'gm';
    const g = game.get(req.lobby.id);
    const from = factionName(req, d.from_faction), to = factionName(req, d.to_faction);
    const mine = myFaction(req);
    const finish = (status, message) => {
      game.q.resolveDiplomacy.run(status, Date.now(), d.id);
      if (message) logEvent(req.lobby.id, req.user.id, 'system', message);
      broadcastRelations(req.lobby.id);
      res.json({ diplomacy: game.serializeDiplomacy(game.q.diplomacyOne.get(d.id, req.lobby.id)), relations: game.relations(req.lobby.id) });
    };
    if (action === 'withdraw') {
      if (!gm && !(mine && mine.id === d.from_faction)) return res.status(403).json({ error: 'Not yours to withdraw' });
      if (!['pending', 'offered'].includes(d.status)) return res.status(400).json({ error: 'Already resolved' });
      return finish('withdrawn', null);
    }
    if (action === 'approve' || action === 'block') {
      if (!gm) return res.status(403).json({ error: 'Game master only' });
      if (d.status !== 'pending') return res.status(400).json({ error: 'Not awaiting the GM' });
      if (action === 'block') return finish('blocked', `The GM blocked ${from}'s ${d.kind === 'war' ? 'declaration of war on' : d.kind + ' offer to'} ${to}`);
      if (d.kind === 'war') {
        game.setRelation(req.lobby.id, d.from_faction, d.to_faction, 'war', g.turn);
        return finish('accepted', `⚔ ${from} declares war on ${to}!`);
      }
      // Peace and alliance: approved, now the other side decides.
      game.q.resolveDiplomacy.run('offered', null, d.id);
      logEvent(req.lobby.id, req.user.id, 'system', `${from} ${d.kind === 'peace' ? 'offers peace to' : 'proposes an alliance to'} ${to}`);
      broadcastRelations(req.lobby.id);
      return res.json({ diplomacy: game.serializeDiplomacy(game.q.diplomacyOne.get(d.id, req.lobby.id)), relations: game.relations(req.lobby.id) });
    }
    if (action === 'accept' || action === 'decline') {
      if (!gm && !(mine && mine.id === d.to_faction)) return res.status(403).json({ error: 'Only the other faction can answer' });
      if (d.status !== 'offered') return res.status(400).json({ error: 'Not open for an answer' });
      if (action === 'decline') return finish('declined', `${to} declined ${from}'s ${d.kind === 'peace' ? 'peace offer' : 'alliance proposal'}`);
      game.setRelation(req.lobby.id, d.from_faction, d.to_faction, d.kind === 'peace' ? 'peace' : 'alliance', g.turn);
      return finish('accepted', d.kind === 'peace' ? `🕊 ${from} and ${to} make peace` : `🤝 ${from} and ${to} form an alliance`);
    }
    res.status(400).json({ error: 'Unknown action' });
  });

  router.post('/enable', requireGm, (req, res) => {
    const g = game.get(req.lobby.id);
    const on = !!req.body?.enabled;
    if (on && !g.enabled) {
      const start = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.startDate || '')) ? req.body.startDate : g.date;
      g.date = start;
      if (req.body?.resetTurn) g.turn = 1;
    }
    g.enabled = on;
    if (on && !g.settings.startYear) g.settings = { ...g.settings, startYear: research.yearOf(g.date) };
    const saved = game.save(g);
    if (on) {
      research.ensureTree(req.lobby.id);
      const techs = research.list(req.lobby.id), starting = research.startingKeys(techs, research.yearOf(saved.settings.startYear || saved.date));
      for (const f of game.q.factions.all(req.lobby.id)) {
        game.ensureState(req.lobby.id, f.id, saved.settings);
        const st = game.serializeState(game.q.state.get(f.id));
        if (!st.techs.length) { st.techs = starting; game.writeState(st); }
      }
    }
    logEvent(req.lobby.id, req.user.id, 'system', on ? `${req.user.displayName} switched game mode on: turn ${saved.turn}, ${GameData.fmtDate(saved.date)}` : `${req.user.displayName} switched game mode off`);
    broadcastGame(req.lobby.id, saved);
    res.json({ game: saved });
  });

  router.patch('/', requireGm, (req, res) => {
    const g = game.get(req.lobby.id);
    const b = req.body || {};
    if (b.turnStep !== undefined && GameData.TURN_STEPS[b.turnStep]) g.turnStep = b.turnStep;
    if (b.deadline !== undefined) {
      // A date (ISO, from the Game tab's picker) is normalised so the countdown and reminders can parse it; free text is kept as written.
      const raw = clean(b.deadline, 80);
      const at = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : NaN;
      g.deadline = Number.isFinite(at) ? new Date(at).toISOString() : raw;
    }
    if (b.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) g.date = b.date;
    if (b.turn !== undefined) g.turn = clamp(Math.round(num(b.turn, g.turn)), 1, 100000);
    if (b.settings && typeof b.settings === 'object') {
      const s = b.settings, out = {};
      const numIn = (k, lo, hi) => { if (s[k] !== undefined) out[k] = clamp(num(s[k], g.settings[k]), lo, hi); };
      numIn('kmPerMove', 1, 100000); numIn('kmPerRange', 1, 100000); numIn('captureRadiusKm', 1, 5000); numIn('cityRadiusKm', 1, 5000);
      numIn('researchLead', 0, 50); numIn('baseMoney', -1000, 100000); numIn('baseRp', -1000, 100000); numIn('baseManpower', -1000, 100000);
      numIn('upkeepGrain', 0, 100); numIn('upkeepOil', 0, 100);
      numIn('trenchRangeKm', 0, 1000); numIn('trenchBonusDug', 0, 50); numIn('trenchBonusReinforced', 0, 50);
      numIn('factoryRangeKm', 1, 5000); numIn('coastalKm', 1, 500); numIn('researchLead', 0, 50);
      if (s.startYear !== undefined) out.startYear = clamp(Math.round(num(s.startYear, 1914)), 1000, 3000);
      if (s.cityCapacity && typeof s.cityCapacity === 'object') {
        out.cityCapacity = {};
        for (const k of ['capital', 'city', 'village']) if (s.cityCapacity[k] !== undefined) out.cityCapacity[k] = clamp(Math.round(num(s.cityCapacity[k])), 0, 20);
      }
      // Unit cost overrides: { typeId: { grain.., money, manpower, turns } }; null clears a type, replaceUnitCosts replaces all.
      if (s.unitCosts !== undefined) {
        const cur = s.replaceUnitCosts ? {} : { ...(g.settings.unitCosts || {}) };
        if (s.unitCosts && typeof s.unitCosts === 'object') {
          for (const [id, row] of Object.entries(s.unitCosts).slice(0, 200)) {
            if (!/^[a-z0-9_-]{1,40}$/.test(id)) continue;
            if (row === null) { delete cur[id]; continue; }
            if (!row || typeof row !== 'object') continue;
            const o = {};
            for (const k of GameData.COST_KEYS) if (row[k] !== undefined) o[k] = clamp(num(row[k]), 0, k === 'turns' ? 50 : 100000);
            if (Object.keys(o).length) cur[id] = o;
          }
        }
        out.unitCosts = cur;
      }
      for (const k of ['waiveMovement', 'occupyNeutrals', 'upkeep', 'publicTreasury', 'capturedIdle']) if (s[k] !== undefined) out[k] = !!s[k];
      for (const grp of ['cityIncome', 'factoryIncome', 'startStock']) {
        if (s[grp] && typeof s[grp] === 'object') {
          out[grp] = {};
          for (const [k, v] of Object.entries(s[grp])) {
            if (v && typeof v === 'object') { out[grp][k] = {}; for (const [k2, v2] of Object.entries(v)) if (['money', 'rp', 'manpower'].includes(k2)) out[grp][k][k2] = clamp(num(v2), -1000, 100000); }
            else if (['money', 'rp', 'manpower', 'resources'].includes(k)) out[grp][k] = clamp(num(v), -1000, 100000);
          }
        }
      }
      g.settings = GameData.mergeSettings(g.settings, out);
    }
    const saved = game.save(g);
    broadcastGame(req.lobby.id, saved);
    res.json({ game: saved });
  });

  router.post('/end-turn', requireGm, (req, res) => {
    const before = game.get(req.lobby.id);
    if (!before.enabled) return res.status(400).json({ error: 'Game mode is off' });
    // Ownership follows territory: settle nodes, factories and towns before income is counted.
    const settled = applyOwnership(req);
    let result;
    const membersByNation = new Map(access.getMembers(req.lobby.id).map(m => [String(m.nation || '').toLowerCase(), m.user_id]));
    const spawnIndex = new Map();
    const spawn = (faction, state, item) => {
      const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
      const site = markers.find(m => m.id === item.siteId);
      const owner = membersByNation.get(faction.name.toLowerCase()) || null;
      if (item.typeId === 'factory') {
        return createMarker(req, { type: 'factory', name: `${item.siteName || faction.name} Works`, x: item.x, y: item.y, color: faction.color, ownerId: owner, data: { nation: faction.name, industry: 1 } }, true);
      }
      const t = UnitTypes.LIST.find(u => u.id === item.typeId);
      if (!t) throw new Error('unknown type');
      const n = (spawnIndex.get(item.siteId) || 0); spawnIndex.set(item.siteId, n + 1);
      const p = site ? production.spawnPoint(req.lobby, site, n) : { x: item.x || 0, y: item.y || 0 };
      const d = UnitTypes.defaults(t, g0.settings.unitStats) || {};
      return createMarker(req, { type: 'unit', autoName: true, x: p.x, y: p.y, color: faction.color, ownerId: owner, data: { nation: faction.name, unitType: t.name, ...d, strength: 100 } }, true);
    };
    const g0 = before;
    try { result = game.endTurn(req.lobby, { spawn }); } catch (e) { return res.status(400).json({ error: e.message }); }
    const g = result.game;
    if (settled.length) logEvent(req.lobby.id, null, 'system', `${settled.length} place${settled.length === 1 ? '' : 's'} changed hands with the front line`);
    logEvent(req.lobby.id, req.user.id, 'system', `Turn ${before.turn} ended. Turn ${g.turn} begins: ${GameData.fmtDate(g.date)}. Movement and action points are reset.`);
    for (const s of result.summaries) {
      const nation = s.faction.name.toLowerCase();
      for (const name of s.data.researched || []) logEvent(req.lobby.id, null, 'system', `🔬 ${s.faction.name} completes research: ${name}`);
      logEvent(req.lobby.id, null, 'turn', `${s.faction.name}, turn ${before.turn}: ${s.text}`, { faction: s.faction.name, factionId: s.faction.id, income: s.data.income, turn: before.turn },
        ws => ws.lobbyRole === 'gm' || g.settings.publicTreasury || String(ws.nation || '').toLowerCase() === nation);
    }
    for (const hit of result.shortages) {
      logEvent(req.lobby.id, null, 'system', `${hit.faction.name} ran short of ${GameData.byKey[hit.resource].name.toLowerCase()}: ${hit.units.length ? hit.units.join(', ') + ' lose 10% strength' : 'no units to suffer'}`);
    }
    broadcastGame(req.lobby.id, g);
    hub.broadcast(req.lobby.id, { type: 'reload', what: 'markers' });
    for (const f of game.q.factions.all(req.lobby.id)) broadcastFaction(req, g, f);
    // Everyone learns the turn ended (toast, chime, report modal); the report itself is fetched per viewer.
    hub.broadcast(req.lobby.id, { type: 'turn', ended: before.turn, turn: g.turn, date: g.date });
    res.json({ game: g, summaries: result.summaries.map(s => ({ faction: s.faction.name, text: s.text })) });
  });

  router.post('/undo-turn', requireGm, (req, res) => {
    const g = game.undoTurn(req.lobby);
    if (!g) return res.status(400).json({ error: 'Nothing to undo' });
    logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} undid the last turn: back to turn ${g.turn}, ${GameData.fmtDate(g.date)}`);
    broadcastGame(req.lobby.id, g);
    hub.broadcast(req.lobby.id, { type: 'territory', territories: territory.all(req.lobby.id), replace: true });
    broadcastRelations(req.lobby.id);
    for (const f of game.q.factions.all(req.lobby.id)) broadcastFaction(req, g, f);
    res.json({ game: g });
  });

  /** GM edits a faction's stockpiles or per-turn modifiers (absolute values). */
  router.patch('/factions/:fid', requireGm, (req, res) => {
    const f = game.q.faction.get(Number(req.params.fid), req.lobby.id);
    if (!f) return res.status(404).json({ error: 'No such faction' });
    const g = game.get(req.lobby.id);
    const s = game.serializeState(game.q.state.get(f.id) || game.ensureState(req.lobby.id, f.id, g.settings));
    const b = req.body || {};
    const val = (v, cur) => clamp(num(v, cur), -1e6, 1e9);
    if (b.money !== undefined) s.money = val(b.money, s.money);
    if (b.manpower !== undefined) s.manpower = val(b.manpower, s.manpower);
    if (b.rp !== undefined) s.rp = val(b.rp, s.rp);
    if (b.resources && typeof b.resources === 'object') for (const k of GameData.RESOURCE_KEYS) if (b.resources[k] !== undefined) s.resources[k] = val(b.resources[k], s.resources[k]);
    if (b.mods && typeof b.mods === 'object') {
      const m = { ...s.mods };
      for (const k of ['money', 'rp', 'manpower']) if (b.mods[k] !== undefined) m[k] = val(b.mods[k], 0);
      if (b.mods.resources && typeof b.mods.resources === 'object') {
        m.resources = { ...(m.resources || {}) };
        for (const k of GameData.RESOURCE_KEYS) if (b.mods.resources[k] !== undefined) m.resources[k] = val(b.mods.resources[k], 0);
      }
      s.mods = m;
    }
    game.writeState(s);
    broadcastFaction(req, g, f);
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    res.json({ faction: access.serializeFaction(f), state: game.serializeState(game.q.state.get(f.id)), income: game.incomeFor(req.lobby, g, access.serializeFaction(f), s, markers) });
  });

  return router;
};
