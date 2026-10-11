# Heroes

Named characters with a star rating from 1 to 5: **generals**, **statesmen**, **diplomats** and **spies**. Built 29 Sep 2026.
The shared numbers are in `public/js/heroes.js`, the server rules in `server/heroes.js` and the orders in
`server/routes/game.js` (`POST /api/lobbies/:id/game/heroes/:heroId/:order`).

## On the map and in the card

A hero is a marker of type **Hero**. Its token is the portrait (the marker's icon, cropped to 2:3) in an oval
golden ring with a band of light running round it, the star rating beneath and a small role badge. Without a
portrait it shows the hero's initials. Selecting a hero opens its card: the same portrait in an animated golden
ring, role, title, stars, perception and intelligence, what the role does, where it is posted or travelling,
and the orders it can take. The 🏛 Nation panel lists each nation's heroes; click one to find it.

The GM creates heroes from the ➕ Place panel (role, stars, name, then click the map) or as a custom marker, uploads
the portrait from Edit, and gives a hero an **owner**: the player who commands it. Players move and command their
heroes but cannot change their role, stars or stats.

## Stars and stats

| Stars | Default perception / intelligence | General's bonus | Spy's mission radius | Research a theft takes |
|---|---|---|---|---|
| ★ | spy 2 / 2 · diplomat 2 / 3 · general 1 / 1 | +1 | 60 km | 5 |
| ★★ | spy 4 / 4 · diplomat 4 / 4 · general 2 / 2 | +1 | 80 km | 10 |
| ★★★ | spy 6 / 6 · diplomat 6 / 5 · general 3 / 3 | +2 | 100 km | 15 |
| ★★★★ | spy 8 / 8 · diplomat 8 / 6 · general 4 / 4 | +2 | 120 km | 20 |
| ★★★★★ | spy 10 / 10 · diplomat 10 / 7 · general 5 / 5 | +3 | 140 km | 25 |

The GM can change any hero's perception, intelligence and movement. Heroes move like units (generals 3,
spies 4, diplomats 6 movement points) and, in game mode, take one order per turn.

## Generals

Friendly units within the general's aura (60 km, a campaign rule) add the general's bonus to attack when they
attack and to defend when they are attacked. Only the best general of a unit's own nation counts. The combat
report names it ("attacker +3 Joffre"). Selecting a general draws the aura on the map; a unit's popup shows the
general covering it.

## Diplomats

A **peace offer** or **alliance proposal** can only be sent to a nation where one of your diplomats is
**posted** (campaign rule, on by default; the GM is exempt). Declarations of war need no diplomat.

- **Send** a diplomat to a nation: it travels to that nation's capital (else a city) and takes up its post at
  the end of the turn. Outside game mode it arrives at once.
- **Recall** brings it home the same way. Moving a posted diplomat by hand also ends the posting.
- The host nation's player (or the GM) can **expel** a posted diplomat, and war between the two nations sends
  their diplomats home.
- The proposal records who carried it ("carried by ★★★★ Paul Cambon"), for the GM and the other side to weigh.

## Spies

Spies are secret: only their own nation and the GM see them on the map, in the log, in history and in live
moves. Three orders:

- **Recon**: reports every foreign unit within the mission radius (name, nation, type, strength, distance) to the
  spy's nation, and reveals any of them that were hidden from it ("Visible to") until the end of the turn.
- **Steal research** (game mode): takes research points from the nation whose ground the spy stands on and
  gives them to the spy's nation. The victim only learns that papers went missing.
- **Hunt spies**: tries to catch every enemy spy within the mission radius.

**Catching a spy.** A recon on hostile ground and every theft is contested: the defending nation's sharpest
spy within 150 km (a campaign rule) rolls **d20 + perception** against the agent's **d20 + intelligence**, and
catches the agent if it rolls higher; ties go to the agent. With no defending spy nearby, the defender rolls
d20 + the campaign's base security (0). A hunt rolls the hunter's d20 + perception against each enemy spy's
d20 + intelligence. A caught spy is taken off the map (GM only, marked captured); both nations are told, with
the rolls. The GM can release a captured spy by editing it.

Example odds: a ★★★★★ hunter (perception 10) catches a ★★ spy (intelligence 4) about 74 % of the time; a
★★★ thief (intelligence 6) facing no defending spy gets away about 77 % of the time.

## Campaign rules (⚖ Rules → Heroes)

General's aura (60 km) · spies contest missions within (150 km) · research stolen per star (5) · security with
no spy nearby (0) · peace offers and alliance proposals need a diplomat (on).

## With fog of war

Recon reveals units by adding the spy's nation to a marker's `revealTo` list until the end of the turn, which
`canSee()` already honours. When automatic fog of war (`docs/FOG-OF-WAR.md`) is built, recon becomes the way to
see beyond your units' vision.

## Character traits (10 Oct 2026)

The GM chooses a defining trait on quick placement or in the Hero editor. The full editor also allows a second, earned trait. Traits are optional, fixed in strength, and independent of stars; existing Heroes keep their previous behaviour. Role changes remove incompatible traits. Players can command their Heroes but cannot edit traits. Diplomats have no mechanical traits.

Military traits affect the Hero’s own nation within the campaign general aura (60 km by default). Each distinct trait counts once, movement multipliers do not compound, and added combat bonuses cap at +2 attack and +2 defence per unit. These bonuses stack with the existing general, research and support bonuses. Captured, travelling, GM-only and embarked Heroes project no aura. Wrecks receive no effects.

Spy specialties modify existing recon, research theft and capture checks. Reconnaissance Expert leaves hunt range unchanged; Network Coordinator reaches other own-nation spies within 60 km and never boosts itself. Spy traits remain secret with their Hero.

Statesmen’s economic traits require no movement that turn and resolve from their current posting. Industrialist and Resource Baron reach 100 km and affect only their own nation. Industrialist adds one level only to goods output, including at level five: it grants no slots, income or permanent upgrades. Rail Magnate must stand within 1 km of an own-nation capital for the turn and boosts rail distance nationwide for units, from the default 4× to 5×. It grants no walking bonus or access to closed track. Relocating an economic Hero suspends their bonuses until the next turn.

Construction bonuses increase length and material costs together. Hospitals still require working support and linked patients, supply still requires real stores, and normal movement and action restrictions remain in force.

| Trait | Role | Effect |
|---|---|---|
| Master Logistician | General | Supply Columns: +25% delivery and link range. |
| Expert Cavalryman | General | Cavalry: +1 attack and +25% movement off rail. |
| Infantry Commander | General | Infantry: +1 attack and +1 defence. |
| Artillery Coordinator | General | Mobile artillery: +1 attack and +25% Signals spotting reach. |
| Siege Specialist | General | Artillery: +2 attack against forts and emplacements. |
| Defensive Strategist | General | Entrenched land units: +2 defence. |
| Assault Planner | General | Infantry and sappers: +2 attack against entrenched defenders. |
| Marching General | General | Linked infantry and support units: +25% movement off rail. |
| Combat Engineer | General | Engineers, pioneers and railway troops: +25% construction length, at proportional material cost. |
| Medical Organiser | General | Field hospitals: +5 percentage points of healing per turn. |
| Inspiring Commander | General | Troops: worn penalty reduced by 1, minimum zero. |
| Fleet Tactician | General | Warships: +1 attack and +1 defence. |
| Reconnaissance Expert | Spy | Recon mission radius: +25%. |
| Master of Disguise | Spy | +2 intelligence on capture checks. |
| Counterintelligence Chief | Spy | +2 perception when hunting or contesting enemy missions. |
| Research Thief | Spy | Research theft: +25% points, limited by the target’s stock. |
| Network Coordinator | Spy | Other friendly spies within 60 km: +1 intelligence on capture checks. |
| Industrialist | Statesman | Factories within 100 km: goods output as one level higher; no extra build slots. |
| Rail Magnate | Statesman | Stationed at the capital for the turn: national rail distance +25%. |
| Resource Baron | Statesman | Resource nodes within 100 km: +15% yield. |

Hero cards describe the traits and spy mission totals. Recipient cards show active bonuses and their sources; conditional combat bonuses appear in the combat report. Economic, supply and rail previews use the same shared rules as the server. Run `npm run test:heroes` for trait, supply, movement, economy, permission and combat coverage.
