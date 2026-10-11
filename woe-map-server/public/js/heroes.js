'use strict';
/**
 * Heroes: named characters with a star rating (1–5), shared by the server and the map page.
 *
 *   General   gives friendly units near them a bonus to attack and defend.
 *   Statesman is a public political figure who can be linked from a nation's government profile.
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
    statesman: { label: 'Statesman', glyph: '♛', movement: 3, blurb: 'A political leader or public figure. Add them to the government profile to give them a place in the nation’s story.' },
    diplomat: { label: 'Diplomat', glyph: '✉', movement: 6, blurb: 'Post to a nation to send it peace offers and alliance proposals.' },
    spy: { label: 'Spy', glyph: '👁', movement: 4, blurb: 'Steal research, reconnoitre an area, hunt enemy spies. Hidden from other nations.' },
  };
  const ROLE_KEYS = Object.keys(ROLES);
  const STATUS = { active: 'Active', posted: 'Posted', travelling: 'Travelling', captured: 'Captured' };
  const TRAITS = {
    logistician: { name: 'Master Logistician', role: 'general', text: 'Supply Columns: +25% delivery and link range.' },
    cavalryman: { name: 'Expert Cavalryman', role: 'general', text: 'Cavalry: +1 attack and +25% movement off rail.' },
    infantryCommander: { name: 'Infantry Commander', role: 'general', text: 'Infantry: +1 attack and +1 defence.' },
    artilleryCoordinator: { name: 'Artillery Coordinator', role: 'general', text: 'Mobile artillery: +1 attack and +25% Signals spotting reach.' },
    siegeSpecialist: { name: 'Siege Specialist', role: 'general', text: 'Artillery: +2 attack against forts and emplacements.' },
    defensiveStrategist: { name: 'Defensive Strategist', role: 'general', text: 'Entrenched land units: +2 defence.' },
    assaultPlanner: { name: 'Assault Planner', role: 'general', text: 'Infantry and sappers: +2 attack against entrenched defenders.' },
    marchingGeneral: { name: 'Marching General', role: 'general', text: 'Linked infantry and support units: +25% movement off rail.' },
    combatEngineer: { name: 'Combat Engineer', role: 'general', text: 'Engineers, pioneers and railway troops: +25% construction length, at proportional material cost.' },
    medicalOrganiser: { name: 'Medical Organiser', role: 'general', text: 'Field hospitals: +5 percentage points of healing per turn.' },
    inspiringCommander: { name: 'Inspiring Commander', role: 'general', text: 'Troops: worn penalty reduced by 1, minimum zero.' },
    fleetTactician: { name: 'Fleet Tactician', role: 'general', text: 'Warships: +1 attack and +1 defence.' },
    reconnaissanceExpert: { name: 'Reconnaissance Expert', role: 'spy', text: 'Recon mission radius: +25%.' },
    masterOfDisguise: { name: 'Master of Disguise', role: 'spy', text: '+2 intelligence on capture checks.' },
    counterintelligenceChief: { name: 'Counterintelligence Chief', role: 'spy', text: '+2 perception when hunting or contesting enemy missions.' },
    researchThief: { name: 'Research Thief', role: 'spy', text: 'Research theft: +25% points, limited by the target’s stock.' },
    networkCoordinator: { name: 'Network Coordinator', role: 'spy', text: 'Other friendly spies within 60 km: +1 intelligence on capture checks.' },
    industrialist: { name: 'Industrialist', role: 'statesman', text: 'Factories within 100 km: goods output as one level higher; no extra build slots.' },
    railMagnate: { name: 'Rail Magnate', role: 'statesman', text: 'Stationed at the capital for the turn: national rail distance +25%.' },
    resourceBaron: { name: 'Resource Baron', role: 'statesman', text: 'Resource nodes within 100 km: +15% yield.' },
  };
  const norm = s => String(s || '').trim().toLowerCase();
  const ready = h => h?.type === 'hero' && !h.adminOnly && !h.data?.aboard && !['captured', 'travelling'].includes(h.data?.status);
  function cleanTraits(role, values) {
    return [...new Set(Array.isArray(values) ? values : [])].filter(k => TRAITS[k]?.role === role).slice(0, 2);
  }
  const hasTrait = (h, key) => cleanTraits(h?.data?.role, h?.data?.traits).includes(key);
  /** Shared by browser previews and authoritative server rules. Distance is in campaign units. */
  function effects(markers, target, settings, distance, context = {}) {
    const out = { attack: 0, defend: 0, worn: 0, walk: 1, supply: 1, spotting: 1, build: 1, heal: 0, factory: 0, yield: 1, rail: 1, intelligence: 0, notes: [] };
    const nation = norm(target?.data?.nation);
    if (!nation || target?.data?.aboard || target?.type === 'unit' && Number(target.data?.strength ?? 100) <= 0) return out;
    const type = context.type, enemy = context.enemyType;
    const land = ['Infantry', 'Mounted & mobile', 'Artillery', 'Support'].includes(type?.cat);
    const keys = new Set();
    for (const h of markers) {
      if (!ready(h) || norm(h.data?.nation) !== nation || h.data.role === 'statesman' && Number(h.data.movedKm || 0) > 0) continue;
      for (const key of cleanTraits(h.data.role, h.data.traits)) {
        if (keys.has(key)) continue;
        const km = h.data.role === 'statesman' ? 100 : key === 'networkCoordinator' ? 60 : Number(settings?.heroAuraKm ?? 60);
        if (key === 'railMagnate') {
          const cap = markers.find(m => m.type === 'town' && m.data?.size === 'capital' && norm(m.data.nation) === nation);
          // A railway posting must be held throughout the turn, not gained by visiting after moving.
          if (!cap || Number(h.data.movedKm || 0) > 0 || distance(h.x, h.y, cap.x, cap.y) > 1) continue;
        } else if (distance(h.x, h.y, target.x, target.y) > km) continue;
        let applies = false; const fields = {};
        const add = (field, value) => { out[field] += value; fields[field] = value; applies = true; };
        const set = (field, value) => { out[field] = Math.max(out[field], value); fields[field] = value; applies = true; };
        switch (key) {
          case 'logistician': if (type?.id === 'supply') set('supply', 1.25); break;
          case 'cavalryman': if (type?.symbol === 'cavalry') { add('attack', 1); set('walk', 1.25); } break;
          case 'infantryCommander': if (type?.cat === 'Infantry') { add('attack', 1); add('defend', 1); } break;
          case 'artilleryCoordinator': if (type?.cat === 'Artillery') { add('attack', 1); set('spotting', 1.25); } break;
          case 'siegeSpecialist': if (type?.cat === 'Artillery' && enemy?.cat === 'Emplacements') add('attack', 2); break;
          case 'defensiveStrategist': if (land && context.entrenched) add('defend', 2); break;
          case 'assaultPlanner': if ((type?.cat === 'Infantry' || type?.id === 'sappers') && context.enemyEntrenched) add('attack', 2); break;
          case 'marchingGeneral': if (['Infantry', 'Support'].includes(type?.cat) && (target.data.supplied !== false || settings?.supplyEnabled === false)) set('walk', 1.25); break;
          case 'combatEngineer': if (['engineers', 'pioneers', 'railway'].includes(type?.id)) set('build', 1.25); break;
          case 'medicalOrganiser': if (type?.id === 'medical') set('heal', 5); break;
          case 'inspiringCommander': if (land || type?.cat === 'Naval') set('worn', 1); break;
          case 'fleetTactician': if (type?.cat === 'Naval' && type?.id !== 'transport') { add('attack', 1); add('defend', 1); } break;
          case 'networkCoordinator': if (target.type === 'hero' && target.data.role === 'spy' && h.id !== target.id) set('intelligence', 1); break;
          case 'industrialist': if (target.type === 'factory') set('factory', 1); break;
          case 'resourceBaron': if (target.type === 'resource') set('yield', 1.15); break;
          case 'railMagnate': if (target.type === 'unit') set('rail', 1.25); break;
        }
        if (applies) { keys.add(key); out.notes.push({ key, name: TRAITS[key].name, hero: h.name, fields }); }
      }
    }
    out.attack = Math.min(2, out.attack); out.defend = Math.min(2, out.defend);
    return out;
  }
  const spyPerception = h => Number(h.data?.perception || 0) + (hasTrait(h, 'counterintelligenceChief') ? 2 : 0);
  const spyIntelligence = h => Number(h.data?.intelligence || 0) + (hasTrait(h, 'masterOfDisguise') ? 2 : 0);
  const reconRadius = h => missionRadiusKm(h.data?.stars) * (hasTrait(h, 'reconnaissanceExpert') ? 1.25 : 1);
  const theftMultiplier = h => hasTrait(h, 'researchThief') ? 1.25 : 1;

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

  return { ROLES, ROLE_KEYS, STATUS, TRAITS, ready, cleanTraits, hasTrait, effects, spyPerception, spyIntelligence, reconRadius, theftMultiplier, stars, starText, defaults, generalBonus, missionRadiusKm };
})();

if (typeof window !== 'undefined') window.Heroes = Heroes;
if (typeof module !== 'undefined') module.exports = Heroes;
