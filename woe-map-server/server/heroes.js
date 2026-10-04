'use strict';
/**
 * Hero rules on the server (public/js/heroes.js has the shared numbers). Pure helpers over serialized
 * markers; the routes in routes/game.js write the results and log them.
 */
const crypto = require('node:crypto');
const geo = require('./geo');
const Heroes = require('../public/js/heroes');

const norm = s => String(s || '').trim().toLowerCase();
const num = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; };
const isHero = m => m && m.type === 'hero';
/** A hero that can act: not captured, not on the road, not hidden from play by the GM. */
const ready = m => isHero(m) && !m.adminOnly && !['captured', 'travelling'].includes(m.data?.status);

/** The best general of the unit's own nation within the aura, or null. */
function generalFor(lobby, settings, markers, unit) {
  const nation = norm(unit.data?.nation);
  if (!nation) return null;
  const km = num(settings.heroAuraKm, 60);
  let best = null;
  for (const m of markers) {
    if (!ready(m) || m.data.role !== 'general' || norm(m.data.nation) !== nation) continue;
    if (geo.distance(lobby, unit.x, unit.y, m.x, m.y) > km) continue;
    const bonus = Heroes.generalBonus(m.data.stars);
    if (!best || bonus > best.bonus) best = { bonus, hero: m };
  }
  return best;
}

/** A diplomat of `fromNation` posted to faction `toId`, or null. */
function postedDiplomat(markers, fromNation, toId) {
  return markers.find(m => ready(m) && m.data.role === 'diplomat' && norm(m.data.nation) === norm(fromNation)
    && m.data.status === 'posted' && Number(m.data.postedTo) === Number(toId)) || null;
}

/** Where a nation receives envoys: its capital, else a city, else any of its towns. */
function capitalOf(markers, nation) {
  const towns = markers.filter(m => m.type === 'town' && norm(m.data?.nation) === norm(nation));
  return towns.find(t => t.data.size === 'capital') || towns.find(t => t.data.size === 'city') || towns[0] || null;
}

/** The sharpest active spy of `nation` within km of a point (highest perception), or null. */
function counterSpy(lobby, markers, nation, x, y, km) {
  let best = null;
  for (const m of markers) {
    if (!ready(m) || m.data.role !== 'spy' || norm(m.data.nation) !== norm(nation)) continue;
    if (geo.distance(lobby, x, y, m.x, m.y) > km) continue;
    if (!best || num(m.data.perception) > num(best.data.perception)) best = m;
  }
  return best;
}

const d20 = () => crypto.randomInt(1, 21);
/**
 * Opposed check: the seeker rolls d20 + perception against the hider's d20 + intelligence. The hider is
 * caught only when the seeker rolls strictly higher (ties favour the agent).
 */
function contest(seekerPerception, hiderIntelligence) {
  const sRoll = d20(), hRoll = d20();
  const sTotal = sRoll + num(seekerPerception), hTotal = hRoll + num(hiderIntelligence);
  return { sRoll, hRoll, sTotal, hTotal, caught: sTotal > hTotal };
}

/** Enemy units (not the nation's own, its allies' or GM-only ones, and never spies) within km of a point. */
function unitsNear(lobby, markers, x, y, km, isFriend) {
  const out = [];
  for (const m of markers) {
    if (m.adminOnly || !['unit', 'hero'].includes(m.type)) continue;
    if (m.type === 'hero' && m.data?.role === 'spy') continue;
    if (m.data?.submerged) continue;   // a submerged submarine is found only by destroyers
    if (isFriend(m.data?.nation)) continue;
    const d = geo.distance(lobby, x, y, m.x, m.y);
    if (d <= km) out.push({ marker: m, km: Math.round(d) });
  }
  return out.sort((a, b) => a.km - b.km);
}

/** Enemy spies within km (for a hunt). */
function spiesNear(lobby, markers, x, y, km, isFriend) {
  return markers.filter(m => ready(m) && m.data.role === 'spy' && !isFriend(m.data.nation) && geo.distance(lobby, x, y, m.x, m.y) <= km);
}

module.exports = { isHero, ready, generalFor, postedDiplomat, capitalOf, counterSpy, contest, unitsNear, spiesNear, norm };
