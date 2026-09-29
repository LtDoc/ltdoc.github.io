'use strict';
/**
 * Heroes: named characters with a star rating (1–5), shared by the server and the map page.
 *
 *   General   gives friendly units near them a bonus to attack and defend.
 *   Diplomat  must be posted to a nation before a peace offer or alliance proposal can go to it.
 *   Spy       steals research points, reconnoitres an area, or hunts enemy spies. Missions on foreign ground
 *             are contested: the defender's best spy nearby rolls d20 + perception against the agent's
 *             d20 + intelligence, and catches the agent if it rolls higher.
 *
 * Spies are secret: only their own nation (and the GM) sees them on the map.
 */
const Heroes = (() => {
  const ROLES = {
    general: { label: 'General', glyph: '⚔', movement: 3, blurb: 'Units within the aura gain attack and defend.' },
    diplomat: { label: 'Diplomat', glyph: '✉', movement: 6, blurb: 'Post to a nation to send it peace offers and alliance proposals.' },
    spy: { label: 'Spy', glyph: '👁', movement: 4, blurb: 'Steal research, reconnoitre an area, hunt enemy spies. Hidden from other nations.' },
  };
  const ROLE_KEYS = Object.keys(ROLES);
  const STATUS = { active: 'Active', posted: 'Posted', travelling: 'Travelling', captured: 'Captured' };

  const stars = s => Math.max(1, Math.min(5, Math.round(Number(s) || 1)));
  const starText = s => '★'.repeat(stars(s)) + '☆'.repeat(5 - stars(s));

  /** Starting stats for a role and star rating; the GM can change any of them afterwards. */
  function defaults(role, s) {
    const n = stars(s), r = ROLES[role] ? role : 'general';
    const two = 2 * n;
    return {
      role: r, stars: n, ap: 1, movement: ROLES[r].movement,
      perception: r === 'general' ? n : two,             // spies and diplomats read people; generals read maps
      intelligence: r === 'general' ? n : (r === 'spy' ? two : n + 2),
    };
  }
  /** A general's bonus to attack and defend: +1 at 1–2 stars, +2 at 3–4, +3 at 5. */
  function generalBonus(s) { return Math.ceil(stars(s) / 2); }
  /** Radius of a spy's recon or hunt, in km: 60 km at 1 star, +20 per star. */
  function missionRadiusKm(s) { return 40 + 20 * stars(s); }

  return { ROLES, ROLE_KEYS, STATUS, stars, starText, defaults, generalBonus, missionRadiusKm };
})();

if (typeof window !== 'undefined') window.Heroes = Heroes;
if (typeof module !== 'undefined') module.exports = Heroes;
