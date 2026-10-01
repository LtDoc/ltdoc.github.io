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

module.exports = function gameRoutes({ logEvent, clean, num, clamp, setMarkerNation, setShapeNation, shapeById, createMarker, writeMarker, writeShape, canEditMarker }) {
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
      diplomacy: game.diplomacy(req.lobby.id).filter(d => req.lobbyRole === 'gm' || d.from === (mine && mine.id) || d.to === (mine && mine.id) || (d.kind === 'war' && d.status === 'accepted')),   // declared wars are public news
      trades: visibleTrades(req),
      hasTerritories: provinces.has(req.lobby.id) || territory.all(req.lobby.id).length > 0,
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
  /** Push a land change of either model: free-form territory polygons and/or province owner pairs. */
  function broadcastLand(lobbyId, r) {
    if (r.territories && r.territories.length) hub.broadcast(lobbyId, { type: 'territory', territories: r.territories });
    if (r.owners && (r.owners.length || r.replace)) hub.broadcast(lobbyId, { type: 'provinceOwners', owners: r.owners, replace: !!r.replace });
  }
  /** Apply territory-driven ownership to nodes, factories and towns; returns the markers that changed. */
  function applyOwnership(req) {
    const factions = game.q.factions.all(req.lobby.id).map(access.serializeFaction);
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const lookup = territory.ownerLookup(req.lobby);
    const changes = territory.ownershipChanges(lookup, factions, markers, req.lobby);
    const out = changes.map(c => setMarkerNation(req, c.marker, c.nation));
    for (const c of territory.trenchOwnershipChanges(lookup, factions, shapeById(req, null, true))) out.push(setShapeNation(req, c.shape, c.nation));
    return out;
  }

  // With provinces the land is drawn from the province owners instead (GET /provinces/owners).
  router.get('/territories', (req, res) => res.json({ territories: provinces.has(req.lobby.id) ? [] : territory.all(req.lobby.id) }));
  router.get('/provinces/owners', (req, res) => res.json({ owners: provinces.ownership(req.lobby.id) }));

  router.post('/territory/seed-earth', requireGm, (req, res) => {
    const g = game.get(req.lobby.id);
    const factions = game.q.factions.all(req.lobby.id).map(access.serializeFaction);
    let r;
    try { r = territory.seedFromYear(req.lobby, req.body?.year, factions); } catch (e) { return res.status(400).json({ error: e.message }); }
    const flipped = applyOwnership(req);
    logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} assigned the borders of ${Number(req.body.year)} to ${r.assigned.length} factions (${r.unassigned.length} states left neutral)`);
    hub.broadcast(req.lobby.id, { type: 'territory', territories: provinces.has(req.lobby.id) ? [] : territory.all(req.lobby.id), replace: true });
    broadcastLand(req.lobby.id, { owners: r.owners, replace: r.replace });
    res.json({ assigned: r.assigned, unassigned: r.unassigned, flipped: flipped.length, game: g });
  });

  router.post('/territory/assign', requireGm, (req, res) => {
    const shape = shapeById(req, Number(req.body?.shapeId));
    if (!shape || shape.kind !== 'area') return res.status(400).json({ error: 'Pick an area drawing' });
    const fid = Number(req.body?.factionId) || territory.NEUTRAL;
    if (fid && !game.q.faction.get(fid, req.lobby.id)) return res.status(404).json({ error: 'No such faction' });
    const r = territory.assignArea(req.lobby, fid, shape.points);
    const flipped = applyOwnership(req);
    broadcastLand(req.lobby.id, r);
    res.json({ changed: r.territories.length + r.owners.length, flipped: flipped.length });
  });

  router.post('/territory/brush', requireGm, (req, res) => {
    const fid = Number(req.body?.factionId) || territory.NEUTRAL;
    if (fid && !game.q.faction.get(fid, req.lobby.id)) return res.status(404).json({ error: 'No such faction' });
    const x = num(req.body?.x), y = num(req.body?.y), km = clamp(num(req.body?.radiusKm, 60), 1, 5000);
    const r = territory.brush(req.lobby, fid, x, y, km);
    broadcastLand(req.lobby.id, r);   // colour first: the owner pairs are tiny and clients recolour at once
    const flipped = r.territories.length || r.owners.length ? applyOwnership(req) : [];
    res.json({ changed: r.territories.length + r.owners.length, flipped: flipped.length });
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

  // ---- World setup (Earth): provinces, then major cities and resources, as one background job -------------
  const generating = new Set();
  /** The historical year whose borders a campaign uses: the one asked for, the Earth layer's year, else the nearest bundled one at or before the start. */
  function worldYear(req, g, asked) {
    const years = territory.earthYears();
    if (years.includes(Number(asked))) return Number(asked);
    const ls = access.serializeLobby(req.lobby, 'gm').settings || {};
    const layer = Number(ls.earth?.borders);
    if (years.includes(layer)) return layer;
    const y = Number(g.settings.startYear) || research.yearOf(g.date);
    return years.filter(x => x <= y).pop() || years[0] || 1914;
  }
  /**
   * Cut provinces and assign them by state; with opts.full also add the major cities and the resource regions
   * (skipping any already on the map). Progress goes to GMs over the socket as { type: 'progress', task: 'provinces' }.
   */
  async function setupWorld(req, opts) {
    const lobbyId = req.lobby.id;
    const progress = (text, done, total) => hub.broadcast(lobbyId, { type: 'progress', task: 'provinces', text, done, total }, ws => ws.lobbyRole === 'gm');
    const yieldToLoop = () => new Promise(done => setImmediate(done));
    generating.add(lobbyId);
    try {
      const r = await provinces.generate(req.lobby, { year: opts.year, sizeKm: opts.sizeKm }, progress);
      progress('Assigning states to factions…', 0, 1);
      await yieldToLoop();
      const factions = game.q.factions.all(lobbyId).map(access.serializeFaction);
      const a = provinces.assignByState(req.lobby, factions);
      let extra = '';
      if (opts.full) {
        progress('Adding major cities and resources…', 0, 1);
        await yieldToLoop();
        const c = seedCities(req), rs = generateResources(req, { dataset: true, fill: opts.fill || 0 });
        extra = `, added ${c.created} major cities and ${rs.created} resource regions${rs.filled ? ` plus ${rs.filled} small deposits` : ''}`;
      }
      const flipped = applyOwnership(req);
      const hint = factions.length ? '' : ' No factions exist yet: seed them from history on the People tab, then press "Assign borders of that year" on the Game tab.';
      logEvent(lobbyId, req.user.id, 'system', `${req.user.displayName} set up the world of ${opts.year}: ${r.count} provinces (about ${opts.sizeKm} km across), ${a.assigned.length} states assigned, ${a.unassigned.length} left neutral${extra}${flipped.length ? `, ${flipped.length} places changed hands` : ''}.${hint}`);
      hub.broadcast(lobbyId, { type: 'territory', territories: [], replace: true });
      hub.broadcast(lobbyId, { type: 'provinces' });   // clients reload geometry and owners
      if (opts.full) hub.broadcast(lobbyId, { type: 'reload', what: 'markers' });
      progress('Done', 1, 1);
    } catch (e) {
      console.warn('world setup failed', e);
      hub.broadcast(lobbyId, { type: 'progress', task: 'provinces', text: `Failed: ${e.message}`, done: 0, total: 0, error: true }, ws => ws.lobbyRole === 'gm');
    } finally { generating.delete(lobbyId); }
  }
  /** Start a setup job; returns an error string or null. The caller responds at once; the job reports over the socket. */
  function startSetup(req, body, full) {
    if (!geo.isEarth(req.lobby)) return 'The world setup needs the Earth map';
    if (generating.has(req.lobby.id)) return 'The world is already being set up';
    const year = worldYear(req, game.get(req.lobby.id), body?.year), sizeKm = clamp(num(body?.sizeKm, 100), 40, 400);
    setupWorld(req, { year, sizeKm, full, fill: body?.fill }).catch(() => {});
    return null;
  }
  router.post('/provinces/generate', requireGm, (req, res) => {
    const err = startSetup(req, req.body, false);
    if (err) return res.status(err.includes('already') ? 409 : 400).json({ error: err });
    res.json({ started: true });
  });
  router.post('/setup-world', requireGm, (req, res) => {
    const err = startSetup(req, req.body, true);
    if (err) return res.status(err.includes('already') ? 409 : 400).json({ error: err });
    res.json({ started: true });
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
    const isProject = q => !!GameData.PROJECTS[q.typeId];
    const sites = production.sites(req.lobby, g, access.serializeFaction(faction), markers, fx).map(s => ({
      ...s, coastal: geo.isEarth(req.lobby) ? territory.isCoastal(req.lobby, s.x, s.y, num(g.settings.coastalKm, 30)) : true,
      queue: (state.production || []).filter(q => q.siteId === s.id && q.typeId !== 'factory' && !isProject(q)),
    }));
    const factories = (state.production || []).filter(q => q.typeId === 'factory');
    // Long-term projects: every factory and town of the faction, with the next step's cost and any project under way.
    const name = faction.name.toLowerCase();
    const projects = markers.filter(m => ['factory', 'town'].includes(m.type) && String(m.data?.nation || '').toLowerCase() === name).map(m => {
      const p = production.projectCostFor(g, fx, m);
      const active = (state.production || []).find(q => isProject(q) && q.siteId === m.id) || null;
      return { id: m.id, name: m.name, kind: m.type === 'factory' ? 'factory' : (m.data?.size || 'village'), project: p.id, level: p.level, max: p.max, cost: p.cost, active };
    });
    const costs = Object.fromEntries([...UnitTypes.LIST.map(t => t.id), 'factory'].map(id => [id, production.costWith(g, fx, id)]));
    const buildable = Object.fromEntries(UnitTypes.LIST.map(t => [t.id, research.canBuild(fx, t.id)]));
    return { factionId: faction.id, sites, factoryBuilds: factories, projects, costs, buildable, state };
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
    const what = item.typeId === 'factory' ? 'building a factory at' : GameData.PROJECTS[item.typeId]
      ? `${item.typeId === 'upgradeFactory' ? 'upgrading' : 'developing'} ${item.siteName} to level ${item.toLevel}`
      : `building ${UnitTypes.LIST.find(t => t.id === item.typeId)?.unit || item.typeId} at`;
    logEvent(req.lobby.id, req.user.id, 'system', `${faction.name} begins ${what}${GameData.PROJECTS[item.typeId] ? '' : ` ${item.siteName}`} (${item.turns} turn${item.turns === 1 ? '' : 's'})`, { faction: faction.name, audience: { nations: [faction.name], treasury: true } },
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
    logEvent(req.lobby.id, req.user.id, 'system', `${f.name} ${r.active === tech.key ? 'begins researching' : 'plans to research'} ${tech.name}`, { faction: f.name, audience: { nations: [f.name], treasury: true } },
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
  /** Add the bundled major cities of 1914 as towns owned by the territory they stand in. Returns { created, skipped }. */
  function seedCities(req) {
    if (!geo.isEarth(req.lobby)) throw new Error('Major cities come with the Earth map');
    let cities;
    try { cities = JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('../config').root, 'public', 'earth', 'cities.json'), 'utf8')).cities; }
    catch { throw new Error('cities.json is missing: run scripts/prepare-cities.js'); }
    const W = req.lobby.map_width, H = req.lobby.map_height;
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const existing = new Set(markers.filter(m => m.type === 'town').map(m => m.name.toLowerCase()));
    const lookup = territory.ownerLookup(req.lobby);
    const factions = game.q.factions.all(req.lobby.id).map(access.serializeFaction);
    const byId = new Map(factions.map(f => [f.id, f]));
    let created = 0;
    for (const c of cities) {
      if (existing.has(c.n.toLowerCase())) continue;
      const [x, y] = geo.project(c.lon, c.lat, W, H);
      const owner = lookup ? lookup(x, y) : null;
      const faction = owner && owner !== territory.NEUTRAL ? byId.get(owner) : null;
      const size = c.cap ? 'capital' : 'city';
      createMarker(req, { type: 'town', name: c.n, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, color: faction ? faction.color : '#95a5a6', locked: true,
        data: { size, nation: faction ? faction.name : '', industry: c.ind + (c.cap ? 1 : 0), major: true } }, true);
      created++;
    }
    return { created, skipped: cities.length - created };
  }
  router.post('/cities/seed', requireGm, (req, res) => {
    let r;
    try { r = seedCities(req); } catch (e) { return res.status(400).json({ error: e.message }); }
    logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} added ${r.created} major cities of 1914`);
    res.json(r);
  });

  /** Place resource nodes from the historical dataset and optionally scatter smaller "fill" nodes on land. Returns { created, filled }. */
  function generateResources(req, { dataset = true, fill = 0 } = {}) {
    if (!geo.isEarth(req.lobby)) throw new Error('Resource generation uses the Earth map; place nodes by hand on image maps');
    let rows;
    try { rows = JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('../config').root, 'public', 'earth', 'resources.json'), 'utf8')).resources; }
    catch { throw new Error('resources.json is missing'); }
    const W = req.lobby.map_width, H = req.lobby.map_height;
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const existing = new Set(markers.filter(m => m.type === 'resource').map(m => m.name.toLowerCase()));
    const lookup = territory.ownerLookup(req.lobby);
    const factions = game.q.factions.all(req.lobby.id).map(access.serializeFaction);
    const byId = new Map(factions.map(f => [f.id, f]));
    const place = (name, kind, x, y, yieldN) => {
      const owner = lookup ? lookup(x, y) : null;
      const faction = owner && owner !== territory.NEUTRAL ? byId.get(owner) : null;
      createMarker(req, { type: 'resource', name, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, color: faction ? faction.color : '#95a5a6', locked: true,
        data: { kind, yield: yieldN, nation: faction ? faction.name : '' } }, true);
    };
    let created = 0;
    if (dataset !== false) {
      for (const r of rows) {
        if (existing.has(r.n.toLowerCase()) || !GameData.byKey[r.k]) continue;
        const [x, y] = geo.project(r.lon, r.lat, W, H);
        place(r.n, r.k, x, y, clamp(num(r.y, 2), 1, 20));
        created++;
      }
    }
    // Fill: random small nodes on land (rejection sampling in the map's land bbox), seeded so reruns differ.
    const nFill = clamp(Math.round(num(fill, 0)), 0, 400);
    let filled = 0;
    if (nFill > 0) {
      const keys = GameData.RESOURCE_KEYS;
      let seed = (Date.now() % 100000) + 1;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      let tries = 0;
      while (filled < nFill && tries < nFill * 40) {
        tries++;
        const x = rnd() * W, y = (0.08 + rnd() * 0.78) * H;   // skip the polar rows
        if (!territory.isLand(req.lobby, x, y)) continue;
        const kind = keys[Math.floor(rnd() * keys.length)];
        place(`${GameData.byKey[kind].name} deposit`, kind, x, y, 1 + Math.floor(rnd() * 2));
        filled++;
      }
    }
    return { created, filled };
  }
  router.post('/resources/generate', requireGm, (req, res) => {
    let r;
    try { r = generateResources(req, { dataset: req.body?.dataset, fill: req.body?.fill }); } catch (e) { return res.status(400).json({ error: e.message }); }
    logEvent(req.lobby.id, req.user.id, 'system', `${req.user.displayName} generated ${r.created} historical resource regions${r.filled ? ` and ${r.filled} smaller deposits` : ''}`);
    res.json(r);
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
    const was = game.relationStatus(req.lobby.id, a, b);
    game.setRelation(req.lobby.id, a, b, status, g.turn);
    if (was !== status) {
      // On the record like any treaty, so notifications announce wars the GM declares directly.
      const did = game.q.insertDiplomacy.run(req.lobby.id, a, b, status, 'accepted', 'set by the GM', req.user.id, Date.now()).lastInsertRowid;
      game.q.resolveDiplomacy.run('accepted', Date.now(), did);
    }
    if (status === 'war') { expelBetween(req, a, b); if (game.cancelTradesBetween(req.lobby.id, a, b, 'cancelled by war').length) tradesChanged(req.lobby.id); }
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
    // Heroes: a peace offer or alliance proposal travels with a diplomat posted to the other nation.
    let envoy = null;
    if (kind !== 'war' && g.settings.diplomatsRequired) {
      envoy = require('../heroes').postedDiplomat(game.q.markers.all(req.lobby.id).map(access.serializeMarker), mine.name, to);
      if (!envoy && req.lobbyRole !== 'gm') return res.status(400).json({ error: `Send a diplomat to ${factionName(req, to)} first: ${kind === 'peace' ? 'a peace offer' : 'an alliance proposal'} needs one posted there` });
    }
    const note = [clean(req.body?.note, 200), envoy ? `carried by ${require('../../public/js/heroes').starText(envoy.data.stars)} ${envoy.name}` : ''].filter(Boolean).join(' · ');
    const id = game.q.insertDiplomacy.run(req.lobby.id, mine.id, to, kind, 'pending', note, req.user.id, Date.now()).lastInsertRowid;
    const verb = kind === 'war' ? 'queued a declaration of war on' : kind === 'peace' ? 'offered peace to' : 'proposed an alliance to';
    logEvent(req.lobby.id, req.user.id, 'system', `${mine.name} ${verb} ${factionName(req, to)} (awaiting the GM)`, { diplomacyId: id, audience: { nations: [mine.name] } },
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
        expelBetween(req, d.from_faction, d.to_faction);
        if (game.cancelTradesBetween(req.lobby.id, d.from_faction, d.to_faction, 'cancelled by war').length) tradesChanged(req.lobby.id);
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

  // ---- Trades (docs/COMMS.md) -----------------------------------------------------------------------
  /** Trades a viewer may see: the GM sees all, a player those of their own faction. */
  function visibleTrades(req) {
    const mine = myFaction(req);
    return game.trades(req.lobby.id).filter(t => req.lobbyRole === 'gm' || (mine && (t.from === mine.id || t.to === mine.id)));
  }
  /** Tell everyone to refetch their trades (each sees a different list). */
  function tradesChanged(lobbyId) { hub.broadcast(lobbyId, { type: 'tradesChanged' }); }
  /** A log line for the two sides of a trade and the GM. */
  function tradeLog(req, t, message) {
    const names = [factionName(req, t.from), factionName(req, t.to)];
    const set = new Set(names.map(n => n.toLowerCase()));
    logEvent(req.lobby.id, req.user.id, 'system', message, { tradeId: t.id, audience: { nations: names } },
      ws => ws.lobbyRole === 'gm' || set.has(String(ws.nation || '').toLowerCase()));
  }
  /** { coal: 10, money: 50 } with only known goods and positive amounts. */
  function bundle(raw) {
    const out = {};
    if (raw && typeof raw === 'object') for (const k of game.TRADE_KEYS) { const v = Math.round(clamp(num(raw[k]), 0, 1e6) * 10) / 10; if (v > 0) out[k] = v; }
    return out;
  }
  const describe = t => `${game.goodsText(t.give)} for ${game.goodsText(t.take)}${t.mode === 'recurring' ? ` every turn for ${t.turns} turn${t.turns === 1 ? '' : 's'}` : ''}`;

  router.get('/trades', (req, res) => res.json({ trades: visibleTrades(req) }));

  /** Propose a trade: a player for their faction (the GM for any faction). The other side accepts or declines. */
  router.post('/trades', (req, res) => {
    const b = req.body || {};
    const gm = req.lobbyRole === 'gm';
    const from = gm && b.fromFactionId ? game.q.faction.get(Number(b.fromFactionId), req.lobby.id) : myFaction(req);
    if (!from) return res.status(400).json({ error: 'You need a faction to trade' });
    const to = game.q.faction.get(Number(b.toFactionId), req.lobby.id);
    if (!to || to.id === from.id) return res.status(400).json({ error: 'Pick another nation' });
    if (game.relationStatus(req.lobby.id, from.id, to.id) === 'war') return res.status(409).json({ error: `${from.name} is at war with ${to.name}` });
    const give = bundle(b.give), take = bundle(b.take);
    if (!Object.keys(give).length && !Object.keys(take).length) return res.status(400).json({ error: 'Add something to give or ask for' });
    const mode = b.mode === 'recurring' ? 'recurring' : 'once';
    const turns = mode === 'recurring' ? clamp(Math.round(num(b.turns, 4)), 1, 100) : 1;
    const note = clean(b.note, 200);
    const id = game.q.insertTrade.run(req.lobby.id, from.id, to.id, JSON.stringify(give), JSON.stringify(take), mode, turns, 0, 'pending', note, req.user.id, Date.now()).lastInsertRowid;
    const t = game.serializeTrade(game.q.tradeOne.get(id, req.lobby.id));
    tradeLog(req, t, `📦 ${from.name} offers ${to.name} a trade: ${describe(t)}`);
    tradesChanged(req.lobby.id);
    res.status(201).json({ trade: t });
  });

  /** accept / decline (the receiving side), withdraw (the proposer), cancel (either side, or the GM). */
  router.post('/trades/:tid/:action', (req, res) => {
    const row = game.q.tradeOne.get(Number(req.params.tid), req.lobby.id);
    if (!row) return res.status(404).json({ error: 'No such trade' });
    const t = game.serializeTrade(row);
    const gm = req.lobbyRole === 'gm', mine = myFaction(req), action = req.params.action;
    const isFrom = !!(mine && mine.id === t.from), isTo = !!(mine && mine.id === t.to);
    if (!gm && !isFrom && !isTo) return res.status(403).json({ error: 'Not your trade' });
    const from = factionName(req, t.from), to = factionName(req, t.to);
    const g = game.get(req.lobby.id);
    const settle = (status, turnsLeft, log) => {
      game.q.updateTrade.run(status, turnsLeft, JSON.stringify(log || t.log), ['pending', 'active'].includes(status) ? null : Date.now(), t.id);
      tradesChanged(req.lobby.id);
      return game.serializeTrade(game.q.tradeOne.get(t.id, req.lobby.id));
    };
    if (action === 'withdraw') {
      if (!gm && !isFrom) return res.status(403).json({ error: 'Only the proposer can withdraw' });
      if (t.status !== 'pending') return res.status(400).json({ error: 'Already answered' });
      const out = settle('withdrawn', 0);
      tradeLog(req, t, `📦 ${from} withdrew its trade offer to ${to}`);
      return res.json({ trade: out });
    }
    if (action === 'decline') {
      if (!gm && !isTo) return res.status(403).json({ error: 'Only the other side can answer' });
      if (t.status !== 'pending') return res.status(400).json({ error: 'Already answered' });
      const out = settle('declined', 0);
      tradeLog(req, t, `📦 ${to} declined ${from}'s trade (${describe(t)})`);
      return res.json({ trade: out });
    }
    if (action === 'cancel') {
      if (t.status !== 'active') return res.status(400).json({ error: 'Only a running trade can be cancelled' });
      const out = settle('cancelled', t.turnsLeft, [...t.log, { turn: g.turn, ok: false, text: `cancelled by ${gm && !mine ? 'the GM' : (isFrom ? from : to)}` }]);
      tradeLog(req, t, `📦 The trade between ${from} and ${to} was cancelled by ${gm && !isFrom && !isTo ? 'the GM' : (isFrom ? from : to)}`);
      return res.json({ trade: out });
    }
    if (action === 'accept') {
      if (!gm && !isTo) return res.status(403).json({ error: 'Only the other side can answer' });
      if (t.status !== 'pending') return res.status(400).json({ error: 'Already answered' });
      if (game.relationStatus(req.lobby.id, t.from, t.to) === 'war') return res.status(409).json({ error: `${from} and ${to} are at war` });
      if (t.mode === 'recurring') {
        const out = settle('active', t.turns);
        tradeLog(req, t, `🤝 ${to} accepted ${from}'s trade: ${describe(t)}, delivered at each End turn`);
        return res.json({ trade: out });
      }
      // One-time: both halves change hands now, or nothing does.
      const fs = game.factionStates(req.lobby.id, g.settings);
      const A = fs.find(x => x.faction.id === t.from), B = fs.find(x => x.faction.id === t.to);
      const r = game.exchange(A.state, B.state, t);
      if (!r.ok) return res.status(409).json({ error: `${r.short.side === 'from' ? from : to} does not have enough ${game.goodName(r.short.good)}` });
      game.writeState(A.state); game.writeState(B.state);
      const out = settle('completed', 0, [{ turn: g.turn, ok: true, text: `${from} → ${to}: ${describe(t)}` }]);
      tradeLog(req, t, `🤝 ${from} and ${to} traded: ${from} sent ${game.goodsText(t.give)}, ${to} sent ${game.goodsText(t.take)}`);
      hub.broadcast(req.lobby.id, { type: 'tradesChanged', treasury: true });   // treasuries changed: Nation tabs refresh
      return res.json({ trade: out });
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
    // Earth campaigns can set up the whole world (provinces, cities, resources) as the game starts.
    const setupError = on && req.body?.setup ? startSetup(req, req.body, true) : null;
    res.json({ game: saved, setupStarted: !!(on && req.body?.setup && !setupError), setupError });
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
      numIn('railSpeed', 1, 50); numIn('railCutKm', 1, 500); numIn('railDefence', -10, 50); numIn('railGuardKm', 0, 1000); numIn('railRepairKm', 0, 1000); numIn('railJoinKm', 0, 200);
      numIn('heroAuraKm', 0, 5000); numIn('spySecurity', -10, 30); numIn('spyCounterKm', 0, 5000); numIn('spyStealPerStar', 0, 1000);
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
      for (const k of ['waiveMovement', 'occupyNeutrals', 'upkeep', 'publicTreasury', 'capturedIdle', 'diplomatsRequired']) if (s[k] !== undefined) out[k] = !!s[k];
      for (const grp of ['cityIncome', 'factoryIncome', 'townDevIncome', 'startStock']) {
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
      if (GameData.PROJECTS[item.typeId]) {
        // A finished project raises the site's level (the site may have changed hands: then the work is lost earlier).
        if (!site) throw new Error(`${item.siteName || 'the site'} is gone`);
        const lv = GameData.projectLevel(site);
        const next = Math.min(lv.max, lv.level + 1);
        const after = writeMarker(req, site, { data: item.typeId === 'upgradeFactory' ? { industry: next } : { developed: next } });
        return { name: `${after.name} ${item.typeId === 'upgradeFactory' ? 'upgraded' : 'developed'} to level ${next}` };
      }
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
    // Heroes on the road arrive: diplomats take up their post (or come home).
    for (const h of game.q.markers.all(req.lobby.id).map(access.serializeMarker)) {
      if (h.type !== 'hero' || h.data?.status !== 'travelling' || !h.data.travel || num(h.data.travel.arrives) > g.turn) continue;
      const t = h.data.travel;
      writeMarker(req, h, { x: t.x, y: t.y, data: { status: t.home ? 'active' : 'posted', postedTo: t.home ? null : t.to, travel: null } });
      const host = t.home ? null : game.q.faction.get(Number(t.to), req.lobby.id);
      secretLog(req, [h.data.nation, host?.name], t.home ? `✉ ${h.name} is back in ${t.toName}` : `✉ ${h.name} (${h.data.nation}) arrives in ${t.toName} and is received by ${host?.name || 'the host'}`);
    }
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
    hub.broadcast(req.lobby.id, { type: 'territory', territories: provinces.has(req.lobby.id) ? [] : territory.all(req.lobby.id), replace: true });
    if (provinces.has(req.lobby.id)) broadcastLand(req.lobby.id, { owners: provinces.ownership(req.lobby.id), replace: true });
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

  // ---- Heroes: spies' missions, diplomats' journeys (docs/HEROES.md) ------------------------------------
  const heroRules = require('../heroes');
  const Heroes = require('../../public/js/heroes');
  const norm = heroRules.norm;
  const factionNamed = (req, name) => game.q.factions.all(req.lobby.id).find(f => norm(f.name) === norm(name)) || null;
  /** (nation) => true for the nation itself and its allies. */
  function friendsOf(req, nation) {
    const me = factionNamed(req, nation);
    return other => {
      if (!other) return false;
      if (norm(other) === norm(nation)) return true;
      const f = factionNamed(req, other);
      return !!(me && f && game.relationStatus(req.lobby.id, me.id, f.id) === 'alliance');
    };
  }
  /** A log line only the listed nations and the GM receive. */
  function secretLog(req, nations, message, data) {
    const set = new Set(nations.filter(Boolean).map(norm));
    logEvent(req.lobby.id, null, 'system', message, { ...(data || {}), audience: { nations: nations.filter(Boolean) } }, ws => ws.lobbyRole === 'gm' || set.has(norm(ws.nation)));
  }
  /** The nearest town's name, for reports ("near Strasbourg"). */
  function placeName(req, markers, x, y) {
    let best = null, bd = Infinity;
    for (const m of markers) {
      if (m.type !== 'town') continue;
      const dd = geo.distance(req.lobby, x, y, m.x, m.y);
      if (dd < bd) { bd = dd; best = m; }
    }
    return best ? (bd < 25 ? `near ${best.name}` : `${Math.round(bd)} km from ${best.name}`) : 'in the field';
  }
  /** Send a diplomat home (expulsion, recall, war): travelling to their own capital, arriving next turn. */
  function sendHome(req, g, markers, hero) {
    const home = heroRules.capitalOf(markers, hero.data.nation);
    if (!home) return writeMarker(req, hero, { data: { status: 'active', postedTo: null } });
    if (!g.enabled) return writeMarker(req, hero, { x: home.x, y: home.y, data: { status: 'active', postedTo: null } });
    return writeMarker(req, hero, { data: { status: 'travelling', postedTo: null, travel: { to: factionNamed(req, hero.data.nation)?.id || 0, toName: home.name, x: home.x, y: home.y, arrives: g.turn + 1, home: true } } });
  }
  /** War between two factions sends their diplomats home. */
  function expelBetween(req, aId, bId) {
    const g = game.get(req.lobby.id);
    const A = game.q.faction.get(aId, req.lobby.id), B = game.q.faction.get(bId, req.lobby.id);
    if (!A || !B) return;
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    for (const h of markers) {
      if (!heroRules.ready(h) || h.data.role !== 'diplomat' || h.data.status !== 'posted') continue;
      const own = norm(h.data.nation), post = Number(h.data.postedTo);
      if ((own === norm(A.name) && post === B.id) || (own === norm(B.name) && post === A.id)) {
        sendHome(req, g, markers, h);
        secretLog(req, [A.name, B.name], `✉ With war declared, ${h.name} (${h.data.nation}) is sent home`);
      }
    }
  }
  function capture(req, g, hero, by) {
    return writeMarker(req, hero, { adminOnly: true, data: { status: 'captured', capturedBy: by, capturedTurn: g.turn } });
  }

  router.post('/heroes/:mid/:action', (req, res) => {
    const g = game.get(req.lobby.id);
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const hero = markers.find(m => m.id === Number(req.params.mid));
    const viewer = { role: req.lobbyRole, userId: req.user.id, nation: req.member?.nation || '' };
    if (!hero || hero.type !== 'hero' || !access.canSee(hero, viewer)) return res.status(404).json({ error: 'No such hero' });
    const gm = req.lobbyRole === 'gm', action = req.params.action, d = hero.data;
    const place = placeName(req, markers, hero.x, hero.y);

    // The host nation may expel a diplomat posted to it.
    if (action === 'expel') {
      const mine = myFaction(req);
      if (d.role !== 'diplomat' || d.status !== 'posted') return res.status(400).json({ error: `${hero.name} is not posted anywhere` });
      if (!gm && !(mine && mine.id === Number(d.postedTo))) return res.status(403).json({ error: 'Only the host nation can expel a diplomat' });
      const host = game.q.faction.get(Number(d.postedTo), req.lobby.id);
      sendHome(req, g, markers, hero);
      secretLog(req, [d.nation, host?.name], `✉ ${host?.name || 'The host'} expels ${hero.name} (${d.nation})`);
      return res.json({ ok: true, message: `${hero.name} is sent home` });
    }

    if (!gm && hero.ownerId !== req.user.id) return res.status(403).json({ error: `Only the GM or ${hero.name}'s owner can give orders` });
    if (d.status === 'captured') return res.status(409).json({ error: `${hero.name} has been captured` });
    if (d.status === 'travelling') return res.status(409).json({ error: `${hero.name} is travelling and arrives at the end of the turn` });
    const need = { recon: 'spy', steal: 'spy', hunt: 'spy', send: 'diplomat', recall: 'diplomat' }[action];
    if (!need) return res.status(400).json({ error: 'Unknown order' });
    if (d.role !== need) return res.status(400).json({ error: `Only a ${need} can do that` });
    // One mission or journey per turn in game mode (the GM is never limited).
    if (g.enabled && !gm && num(d.apUsed) >= Math.max(1, num(d.ap, 1))) return res.status(409).json({ error: `${hero.name} has already acted this turn` });
    const spent = g.enabled ? { apUsed: num(d.apUsed) + 1 } : {};

    // ---- Diplomats ----
    if (action === 'send' || action === 'recall') {
      const target = action === 'send' ? game.q.faction.get(Number(req.body?.factionId), req.lobby.id) : factionNamed(req, d.nation);
      if (!target) return res.status(400).json({ error: action === 'send' ? 'Pick a nation' : `${d.nation || 'This hero'} has no faction` });
      if (action === 'send' && norm(target.name) === norm(d.nation)) return res.status(400).json({ error: 'Pick another nation' });
      if (action === 'send' && d.status === 'posted' && Number(d.postedTo) === target.id) return res.status(400).json({ error: `${hero.name} is already posted to ${target.name}` });
      const dest = heroRules.capitalOf(markers, target.name);
      if (!dest) return res.status(400).json({ error: `${target.name} has no capital or city on the map to receive an envoy` });
      const home = action === 'recall';
      if (!g.enabled) writeMarker(req, hero, { x: dest.x, y: dest.y, data: { status: home ? 'active' : 'posted', postedTo: home ? null : target.id } });
      else writeMarker(req, hero, { data: { ...spent, status: 'travelling', postedTo: null, travel: { to: target.id, toName: dest.name, x: dest.x, y: dest.y, arrives: g.turn + 1, home } } });
      const when = g.enabled ? 'arriving at the end of the turn' : 'arrived';
      const msg = home ? `✉ ${hero.name} is recalled to ${dest.name}, ${when}` : `✉ ${d.nation} sends ${Heroes.starText(d.stars)} ${hero.name} to ${target.name} (${dest.name}), ${when}`;
      secretLog(req, [d.nation, home ? null : target.name], msg);
      return res.json({ ok: true, message: msg });
    }

    // ---- Spies ----
    const friend = friendsOf(req, d.nation);
    const lookup = territory.ownerLookup(req.lobby);
    const groundId = lookup ? lookup(hero.x, hero.y) : null;
    const ground = groundId ? game.q.faction.get(groundId, req.lobby.id) : null;
    const km = Heroes.missionRadiusKm(d.stars);
    /** Counter-intelligence of `nation`: its sharpest spy nearby, or the campaign's base security. */
    const contested = nation => {
      const spy = heroRules.counterSpy(req.lobby, markers, nation, hero.x, hero.y, num(g.settings.spyCounterKm, 150));
      const per = spy ? num(spy.data.perception) : num(g.settings.spySecurity, 0);
      return { ...heroRules.contest(per, num(d.intelligence)), spy, per };
    };
    const caughtBy = (nation, c) => {
      capture(req, g, hero, nation);
      const who = c.spy ? `${nation}'s ${c.spy.name}` : `${nation}'s security`;
      const msg = `🕵 ${d.nation}'s spy ${hero.name} was caught ${place} by ${who}: ${c.sRoll}+${c.per}=${c.sTotal} vs ${c.hRoll}+${num(d.intelligence)}=${c.hTotal}`;
      secretLog(req, [d.nation, nation], msg, { heroId: hero.id, caught: true });
      return res.json({ ok: false, caught: true, message: msg });
    };

    if (action === 'steal') {
      if (!g.enabled) return res.status(400).json({ error: 'Stealing research needs game mode' });
      if (!ground || norm(ground.name) === norm(d.nation)) return res.status(400).json({ error: `${hero.name} must be on another nation's ground to steal its research` });
      const c = contested(ground.name);
      if (c.caught) return caughtBy(ground.name, c);
      const mine = factionNamed(req, d.nation);
      const theirs = game.serializeState(game.q.state.get(ground.id) || game.ensureState(req.lobby.id, ground.id, g.settings));
      const amount = Math.max(0, Math.min(num(g.settings.spyStealPerStar, 5) * Heroes.stars(d.stars), num(theirs.rp)));
      if (amount > 0 && mine) {
        const ours = game.serializeState(game.q.state.get(mine.id) || game.ensureState(req.lobby.id, mine.id, g.settings));
        theirs.rp = Math.round((theirs.rp - amount) * 10) / 10; ours.rp = Math.round((ours.rp + amount) * 10) / 10;
        game.writeState(theirs); game.writeState(ours);
        broadcastFaction(req, g, ground); broadcastFaction(req, g, mine);
      }
      writeMarker(req, hero, { data: spent });
      const rolls = `${c.hRoll}+${num(d.intelligence)}=${c.hTotal} vs ${c.sRoll}+${c.per}=${c.sTotal}`;
      const msg = amount > 0 ? `🗝 ${hero.name} stole ${amount} research points from ${ground.name} ${place} (${rolls})` : `🗝 ${hero.name} got into ${ground.name}'s offices ${place} but found no research points to take (${rolls})`;
      secretLog(req, [d.nation], msg);
      if (amount > 0) secretLog(req, [ground.name], `🗝 Research papers went missing ${place}: ${ground.name} lost ${amount} research points`);
      return res.json({ ok: true, message: msg, amount });
    }

    if (action === 'recon') {
      if (ground && !friend(ground.name)) {
        const c = contested(ground.name);
        if (c.caught) return caughtBy(ground.name, c);
      }
      const found = heroRules.unitsNear(req.lobby, markers, hero.x, hero.y, km, friend);
      // Units hidden from this nation by "Visible to" are revealed to it until the end of the turn.
      for (const f of found) {
        const m = f.marker;
        if (!m.visibleTo || !m.visibleTo.length) continue;
        const list = Array.isArray(m.data?.revealTo) ? m.data.revealTo : [];
        if (!list.some(n => norm(n) === norm(d.nation))) writeMarker(req, m, { data: { revealTo: [...list, d.nation] } });
      }
      writeMarker(req, hero, { data: spent });
      const intel = found.slice(0, 40).map(f => ({ id: f.marker.id, name: f.marker.name, nation: f.marker.data?.nation || '', type: f.marker.type === 'hero' ? (Heroes.ROLES[f.marker.data?.role]?.label || 'Hero') : (f.marker.data?.unitType || 'Unit'), strength: f.marker.type === 'unit' ? num(f.marker.data?.strength, 100) : null, km: f.km }));
      const msg = found.length ? `🔍 ${hero.name} reconnoitred ${km} km (${place}): ${found.length} foreign unit${found.length === 1 ? '' : 's'} (${intel.slice(0, 8).map(i => `${i.name}, ${i.nation || 'unaligned'}${i.strength !== null ? ` ${i.strength}%` : ''}`).join('; ')}${found.length > 8 ? '; …' : ''})`
        : `🔍 ${hero.name} reconnoitred ${km} km (${place}): no foreign units`;
      secretLog(req, [d.nation], msg, { intel, heroId: hero.id });
      return res.json({ ok: true, message: msg, intel });
    }

    if (action === 'hunt') {
      const targets = heroRules.spiesNear(req.lobby, markers, hero.x, hero.y, km, friend);
      const caught = [];
      for (const t of targets) {
        const c = heroRules.contest(num(d.perception), num(t.data.intelligence));
        if (!c.caught) continue;
        capture(req, g, t, d.nation);
        caught.push(t);
        secretLog(req, [t.data.nation, d.nation], `🕵 ${t.data.nation}'s spy ${t.name} was caught ${placeName(req, markers, t.x, t.y)} by ${d.nation}'s ${hero.name}: ${c.sRoll}+${num(d.perception)}=${c.sTotal} vs ${c.hRoll}+${num(t.data.intelligence)}=${c.hTotal}`, { heroId: t.id, caught: true });
      }
      writeMarker(req, hero, { data: spent });
      const msg = caught.length ? `🕵 ${hero.name} hunted within ${km} km (${place}) and caught ${caught.map(t => `${t.name} (${t.data.nation})`).join(', ')}` : `🕵 ${hero.name} hunted within ${km} km (${place}) and caught no one`;
      secretLog(req, [d.nation], msg);
      return res.json({ ok: true, message: msg, caught: caught.length });
    }
    return res.status(400).json({ error: 'Unknown order' });
  });

  // ---- Railways: sabotage and repair (docs/RAILWAYS.md) -------------------------------------------------
  const rails = require('../rails');
  const crypto = require('node:crypto');
  const unitsLabel = req => geo.isEarth(req.lobby) ? 'km' : (req.lobby.scale_label || 'units');
  function railTarget(req, res) {
    const viewer = { role: req.lobbyRole, userId: req.user.id, nation: req.member?.nation || '' };
    const rail = shapeById(req, Number(req.body?.shapeId));
    if (!rail || rail.kind !== 'rail' || !access.canSee(rail, viewer)) { res.status(404).json({ error: 'No such railway' }); return null; }
    return rail;
  }
  /** Who holds the ground under a point: { id, name } (id 0 = neutral), or null without territories / at sea. */
  function holderAt(req, x, y) {
    const lookup = territory.ownerLookup(req.lobby);
    if (!lookup) return null;
    const id = lookup(x, y);
    if (id === null || id === undefined) return null;
    if (id === territory.NEUTRAL) return { id: 0, name: '' };
    const f = game.q.faction.get(id, req.lobby.id);
    return f ? { id: f.id, name: f.name } : null;
  }
  const railName = r => r.label ? `the ${r.label} railway` : 'a railway';

  /** Cut a section of railway with a unit: d20 + attack against d20 + the line's defence and its best guard. */
  router.post('/rail/cut', (req, res) => {
    const g = game.get(req.lobby.id);
    const gm = req.lobbyRole === 'gm';
    const rail = railTarget(req, res);
    if (!rail) return;
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const viewer = { role: req.lobbyRole, userId: req.user.id, nation: req.member?.nation || '' };
    const unit = markers.find(m => m.id === Number(req.body?.unitId));
    if (!unit || !access.canSee(unit, viewer) || unit.type !== 'unit') return res.status(404).json({ error: 'Pick one of your units' });
    if (!canEditMarker(req, unit)) return res.status(403).json({ error: 'You can only attack with units you control' });
    if (num(unit.data?.strength, 100) <= 0) return res.status(400).json({ error: `${unit.name} has no strength left` });
    const at = rails.nearestOn(req.lobby, rail, num(req.body?.x, unit.x), num(req.body?.y, unit.y));
    if (!at) return res.status(400).json({ error: 'That railway has no track' });
    if (rails.cutAt(req.lobby, g.settings, rail, at.x, at.y)) return res.status(409).json({ error: 'That section is already cut' });
    const apError = game.checkAttack(g, gm, unit);
    if (apError) return res.status(409).json({ error: apError });
    const u = unitsLabel(req);
    const reach = game.attackRange(req.lobby, g, unit);
    const dist = geo.distance(req.lobby, unit.x, unit.y, at.x, at.y);
    if (g.enabled && !gm && !g.settings.waiveMovement && dist > reach + 1e-6) return res.status(409).json({ error: `That section is ${Math.round(dist)} ${u} away; ${unit.name} reaches ${Math.round(reach)} ${u}` });

    // Whose line is it? Your own (or an ally's) is simply blown up; an enemy's must be fought for.
    const holder = holderAt(req, at.x, at.y);
    const friend = friendsOf(req, unit.data?.nation);
    const own = !!(holder && holder.id && friend(holder.name));
    if (!gm && g.enabled && holder && !own) {
      const mine = factionNamed(req, unit.data?.nation);
      if (!holder.id) return res.status(409).json({ error: 'That section runs through neutral ground' });
      if (!mine || game.relationStatus(req.lobby.id, mine.id, holder.id) !== 'war') return res.status(409).json({ error: `${unit.data?.nation || 'Your side'} is not at war with ${holder.name}` });
    }
    const place = placeName(req, markers, at.x, at.y);
    let text, success = true, rolls = null;
    if (own) {
      text = `💥 ${unit.name} blew up ${railName(rail)} ${place}`;
    } else {
      const bonus = research.statBonus(game.factionEffects(req.lobby.id, unit.data?.nation), UnitTypes.resolve(unit.data?.unitType)).attack;
      const gen = heroRules.generalFor(req.lobby, g.settings, markers, unit);
      const atk = num(unit.data?.attack) + bonus + (gen ? gen.bonus : 0);
      // The holder's (or its allies') strongest land unit within the guard radius defends the line.
      const guardOf = holder && holder.id ? friendsOf(req, holder.name) : null;
      const guards = guardOf ? markers.filter(m => territory.isLandUnit(m) && num(m.data?.strength, 100) > 0 && guardOf(m.data?.nation) &&
        geo.distance(req.lobby, m.x, m.y, at.x, at.y) <= num(g.settings.railGuardKm, 30)) : [];
      const guard = guards.sort((a, b) => num(b.data?.defend) - num(a.data?.defend))[0] || null;
      const def = num(g.settings.railDefence, 4) + (guard ? num(guard.data?.defend) : 0);
      const aRoll = crypto.randomInt(1, 21), dRoll = crypto.randomInt(1, 21);
      success = aRoll + atk > dRoll + def;
      rolls = { aRoll, dRoll, atk, def, guard: guard ? guard.name : null };
      const notes = [bonus ? `+${bonus} tech` : '', gen ? `+${gen.bonus} ${gen.hero.name}` : '', guard ? `guarded by ${guard.name}` : ''].filter(Boolean);
      text = `💥 ${unit.name} attacked ${railName(rail)} ${place}: ${aRoll}+${atk}=${aRoll + atk} vs ${dRoll}+${def}=${dRoll + def}${notes.length ? ` (${notes.join(', ')})` : ''} → ` +
        (success ? `the line is cut (${Math.round(num(g.settings.railCutKm, 10) * 2)} ${u} of track)` : 'the line holds');
    }
    if (g.enabled) writeMarker(req, unit, { data: { apUsed: num(unit.data?.apUsed) + 1 } });
    let after = rail;
    if (success) {
      const cut = { id: crypto.randomBytes(4).toString('hex'), x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10, turn: g.turn, by: unit.data?.nation || '', at: new Date().toISOString() };
      after = writeShape(req, rail, { ...(rail.data || {}), cuts: [...(rail.data?.cuts || []), cut] });
    }
    const hidden = !!(unit.adminOnly || unit.visibleTo);
    const event = logEvent(req.lobby.id, req.user.id, 'combat', text, { railId: rail.id, unitId: unit.id, success, rolls, x: at.x, y: at.y, hidden },
      hidden ? (ws => ws.lobbyRole === 'gm' || ws.user.id === req.user.id) : null);
    res.status(201).json({ event, success, shape: after });
  });

  /** Repair a cut: the GM, or a unit of the side holding that ground within railRepairKm (uses its action). */
  router.post('/rail/repair', (req, res) => {
    const g = game.get(req.lobby.id);
    const gm = req.lobbyRole === 'gm';
    const rail = railTarget(req, res);
    if (!rail) return;
    const cut = (rail.data?.cuts || []).find(c => c.id === String(req.body?.cutId || ''));
    if (!cut) return res.status(404).json({ error: 'That section is not cut' });
    const markers = game.q.markers.all(req.lobby.id).map(access.serializeMarker);
    const place = placeName(req, markers, cut.x, cut.y);
    let who = 'The GM';
    if (!gm || req.body?.unitId) {
      const viewer = { role: req.lobbyRole, userId: req.user.id, nation: req.member?.nation || '' };
      const unit = markers.find(m => m.id === Number(req.body?.unitId));
      if (!unit || !access.canSee(unit, viewer) || !['unit', 'hero'].includes(unit.type)) return res.status(404).json({ error: 'Pick one of your units near the break' });
      if (!canEditMarker(req, unit)) return res.status(403).json({ error: 'You can only repair with units you control' });
      const u = unitsLabel(req), range = num(g.settings.railRepairKm, 30);
      const dist = geo.distance(req.lobby, unit.x, unit.y, cut.x, cut.y);
      if (!gm && dist > range + 1e-6) return res.status(409).json({ error: `${unit.name} is ${Math.round(dist)} ${u} from the break; repair crews work within ${range} ${u}` });
      const holder = holderAt(req, cut.x, cut.y);
      if (!gm && holder && holder.id && !friendsOf(req, unit.data?.nation)(holder.name)) return res.status(409).json({ error: `${holder.name} holds that ground` });
      if (g.enabled && !gm) {
        const ap = Math.max(1, num(unit.data?.ap, 1));
        if (num(unit.data?.apUsed) >= ap) return res.status(409).json({ error: `${unit.name} has used its action points this turn` });
        writeMarker(req, unit, { data: { apUsed: num(unit.data?.apUsed) + 1 } });
      }
      who = unit.name;
    }
    const after = writeShape(req, rail, { ...(rail.data || {}), cuts: (rail.data?.cuts || []).filter(c => c.id !== cut.id) });
    const event = logEvent(req.lobby.id, req.user.id, 'system', `🛠 ${who} repaired ${railName(rail)} ${place}`, { railId: rail.id, cutId: cut.id });
    res.json({ event, shape: after });
  });


  return router;
};
