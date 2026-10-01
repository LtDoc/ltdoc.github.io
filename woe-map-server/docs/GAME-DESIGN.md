# WoE Strategy Map: game layer design

Status: **agreed 26 Sep 2026; all five phases built 26 Sep 2026** (turns and economy, territory and war, production and cities, research, and the polish phase: turn reports, deadline countdown and reminders, captured-this-turn effects, public treasuries, Firebase import of the old tree and nations). The ⚠ marks show where a decision was needed; section 12 records the answers.

## 1. Goal and principles

Turn the position tracker into a light strategy game that supports RP: turns, unit production, movement
limits, ten map resources, a research tree that gates units, borders that follow armies, and the menus that
let players run a nation and the GM run the world.

Principles that shaped every choice below:

- **The GM is the referee, the server is the clerk.** Automation does bookkeeping (income, build timers,
  research progress, border carving) so nobody has to; every number it produces is editable by the GM, and
  every automated change lands in the history log like a manual one. Nothing is ever locked away from the GM.
- **Game mode is a layer, not a rewrite.** A campaign with game mode off behaves exactly like today. Turning
  it on adds the game tables, the Nation and Game tabs, and the movement/production rules. Existing markers,
  drawings, factions, visibility rules, combat, history and the renderer stay as they are.
- **Simultaneous turns, resolved by the GM.** All players act during a turn (move within their allowance,
  queue builds and research, talk). The GM presses End Turn when the story is ready; income, production,
  research and the calendar advance in one transaction. No timers force anything, though the GM can show a
  deadline. This fits Discord-paced RP far better than sequential "your go" turns.
- **Keep the numbers small and legible.** Resources in whole units per turn, unit costs in the tens, research
  in single-digit turns. Players should be able to do the arithmetic in their head.

Automatic fog of war is proposed separately in `docs/FOG-OF-WAR.md` (29 Sep 2026). Heroes (generals, diplomats and spies) are described in `docs/HEROES.md`. Railways (drawn track, 4× movement, sabotage and repair) are described in `docs/RAILWAYS.md` (30 Sep 2026). Chat, the notification centre, trades between nations, GM pings and click-to-move with trails are described in `docs/COMMS.md` (30 Sep 2026). Long-term growth (factory upgrades, town development, the Economy research branch) is described in `docs/ECONOMY.md` (30 Sep 2026). Supply, support units and unit matchups are described in `docs/UNITS.md` (30 Sep 2026).

Non-goals for this design: AI opponents, supply lines, terrain and weather modifiers, naval pathfinding,
trade routes as map objects. Each could be a later layer.

## 2. Game loop

### 2.1 Turn and calendar

- A campaign in game mode has a **turn number** and a **game date**. Each turn advances the date by a
  configurable step: 1 week, 2 weeks, 1 month (default) or 1 season. The 1914 scenario starts on 28 July 1914,
  turn 1.
- ⚠ Default turn length: **1 month** proposed. Shorter turns make movement allowances feel realistic; longer
  ones keep research and production meaningful without hundreds of turns. One month gives ~50 turns for the
  historical war.
- The **HUD** shows "Turn 7 · February 1915" plus the optional real-world deadline the GM set ("ends Sunday").

### 2.2 What happens during a turn

Players (and the GM on their behalf):
1. Move units within their remaining movement (section 4).
2. Attack with units that still have action points (existing dice combat, section 4.3).
3. Queue production at their cities and choose research (sections 6 and 7).
4. Declare war, propose peace or alliances (section 5.4). Chat and roll as now.

### 2.3 End of turn (GM presses **End turn**)

One server-side transaction, in this order, with every step logged to the campaign log as a "turn" event and
recorded as one history entry per changed entity:

1. **Snapshot** faction states and territories (for "undo last turn", kept for the last 5 turns).
2. **Income**: for each faction, sum the yields of resource nodes inside its territory (section 5.3),
   money from cities, research points from cities and the GM's base allowance. Subtract upkeep if enabled.
3. **Production**: advance every queued build by one turn; completed units spawn at their city with a
   quick-add name ("4th Infantry Regiment") and the faction's current stats.
4. **Research**: add the faction's RP income to the active project; unlock it when paid for, apply its
   effects, start the next queued project.
5. **Reset** every unit's movement and action points; clear "moved this turn" markers.
6. **Advance** turn number and date; broadcast the new state; post a per-faction turn summary
   ("+120 coal, +40 iron, 2nd Tank Battalion completed, Poison Gas researched") visible to that faction and the GM.

Border changes are **not** an end-of-turn step; they happen when units move (section 5). ⚠ Alternative:
apply border changes at end of turn only, which is more deterministic but loses the immediacy that makes
advances fun to watch. Recommendation: immediate.

**Undo last turn** (GM): restores the snapshot of faction states and territories and reverts the units the
resolution created. Markers moved by players after the turn ended stay where they are.

## 3. Data model

New tables in `server/db.js`, all keyed by lobby so game mode is per campaign:

| Table | Purpose |
|---|---|
| `game` | one row per lobby: `enabled`, `turn`, `date`, `turn_step`, `deadline`, `settings` JSON (section 9) |
| `faction_state` | per faction: `resources` JSON (10 stockpiles), `money`, `manpower`, `rp`, `income_mod` JSON, `techs` JSON (unlocked keys), `research` JSON (active + queue), `production` JSON (queue) |
| `techs` | the campaign's tech tree (copied from the bundled default so the GM can edit it): `key`, `branch`, `name`, `year`, `cost_rp`, `cost_money`, `prereqs` JSON, `effects` JSON, `description`, `image` |
| `territories` | one row per faction plus one for "neutral": `geometry` JSON (multipolygon in map pixels), `area_km2`, `updated_at` |
| `relations` | faction pairs: `status` (peace, war, alliance), `since_turn` |
| `turn_snapshots` | `turn`, `data` JSON blob of faction_state + territories, pruned to the last 5 |

Existing tables gain a few fields without migrations pain:
- `markers.data` for units: `movedKm`, `apUsed`, `builtTurn`; for towns: `industry` (0–5), `pop`,
  `major` flag; new marker type `resource` with `data.kind` and `data.yield`.
- `factions`: nothing new; `faction_state` is 1:1 and created lazily.

Everything stays in SQLite via `node:sqlite`; polygon maths runs in Node with the `polygon-clipping`
package (pure JS, ~30 KB, no native build), the only new dependency.

## 4. Units, movement and action points

### 4.1 Movement allowance

- A unit's `movement` stat is in **movement points**; the campaign setting `kmPerMove` (Earth default 50 km;
  image maps use map units) converts it to distance per turn. Infantry at 2 MP covers 100 km a month,
  cavalry at 5 MP 250 km, aircraft at 8 MP 400 km.
- The server tracks `movedKm` per unit per turn. A player's drag that would exceed the remaining allowance is
  **clamped** to the allowed radius (the client shows the remaining-range ring while dragging, the server
  enforces it on the move request). Group moves clamp to the slowest unit.
- GMs are never limited. A per-campaign toggle lets the GM waive limits for everyone (pure RP sessions).
- ⚠ Rail movement (moving far along a rail line for a fee) and sea transport are out of scope for v1; the GM
  can teleport units, which covers both for now.

### 4.2 Categories and the border rule

Unit categories already exist in the catalogue. Movement and capture behaviour per category:

| Category | Moves borders | Notes |
|---|---|---|
| Infantry, Mounted & mobile, Artillery, Support | yes | land units carve territory (section 5.2) |
| Air | no | may fly over anything |
| Naval | no | may not carve; a future rule could keep them on water |

### 4.3 Action points and combat

**Reach (added 27 Sep 2026).** A unit can only attack targets within `range × kmPerRange` (50 km per range point by default): infantry 50 km, cavalry 100 km, field artillery 150 km, heavy artillery 200 km, railway guns 300 km, aircraft and capital ships further. The attack picker lists only enemies within reach; the server enforces it for players (the GM and the waive switch pass), with tech range bonuses counted.

- `ap` finally does something: each attack costs 1 AP and the server refuses attacks from a unit with none
  left. Most units have 1 AP; cavalry, armoured cars, aircraft and destroyers have 2.
- Combat itself is unchanged (d20 + attack vs d20 + defend, strength losses, explosions). Tech effects can
  raise a faction's attack or defend for a category (section 7.3).

## 5. Territory, borders and war

### 5.1 Territory as a first-class layer

Today borders are imported as locked area drawings. That works for a static map but not for automatic updates:
they are independent polygons with no owner and no notion of "inside". Game mode introduces **territories**:
one multipolygon per faction plus one neutral multipolygon, stored server-side in map-pixel coordinates.

**Provinces (added 27 Sep 2026).** Free-form territories carved by circles produced ugly borders: three
border systems on top of each other, coarse historical outlines that did not meet the coastline, and
slivers of tinted sea. The Earth map now cuts its land into **provinces** about 100 km across
(`server/provinces.js`, GM: Game → Territory → Cut provinces): Voronoi cells around jittered seeds, one
per major city plus a grid inside every state of the seed year, each cell clipped to the Natural Earth
coast and cut along the state border, so every bit of land belongs to exactly one province, national
borders are exact, and no province straddles a coast. Fragments merge into their neighbour; a province is
named after the city inside it or the nearest one with a compass direction ("Reims NE"). Ownership lives
per province and nowhere else: "inside or outside" is a grid-indexed province lookup, and clients draw the
provinces coloured by owner (`public/js/province-layer.js`: one fill mesh with a colour per vertex, one border
mesh rebuilt from the edge segments whose two sides have different owners, a dark core with each owner's
colour on its side, hairline province edges when zoomed in, a faction name on each sizeable group). An owner
change travels as a few [province, faction] pairs, so a brush stroke recolours in well under a second; the
first version rebuilt whole faction polygons on the server and re-triangulated them in every browser, 6–10 s
per stroke on a world map (29 Sep 2026). The Earth layer's own political borders, tint and labels hide while
territories exist. Hovering names the province and its owner. Custom (non-Earth) maps keep free-form
territories for now.

- **Seeding for Earth**: "Assign 1914 borders to factions" maps each state polygon from the 1914 dataset to a
  faction by the same name matching the faction seeder already uses (aliases included); unmatched states become
  neutral. Colonies use the `SUBJECTO` field (the dataset records who a territory belonged to), so British India
  and French West Africa land with the right owner. That field turned out to be patchy (27–29 Sep 2026: a
  "British Empire" faction got nothing, "United Kingdom" only the Raj and Hong Kong), so `public/js/powers.js`
  now folds each power's names into one key, lists the owners of unlabelled holdings per bundled year, names
  nameless islands by position, and New Guinea is split along the 1885 Anglo-German line.
- **Seeding for image maps**: the GM draws areas and assigns them to factions ("Assign to faction" on an
  area's popup), or paints with a brush (section 8.2).
- Territories render as a filled, faction-tinted layer with outlines, replacing the tint that the 1914
  layer draws today. The existing imported drawings can be deleted or kept as reference; they no longer
  matter to the rules.
- Simplification after every operation (Douglas–Peucker at ~0.02°) keeps polygons small enough that unions
  stay in the low milliseconds even after hundreds of captures.

### 5.2 How armies move borders

When a **land unit's move is committed** (drop after a drag, or a group move) and the unit ends inside
territory that is not its own:

1. If the territory owner is at **war** with the unit's faction, or the territory is **neutral** and the
   campaign allows occupying neutrals, continue; otherwise nothing happens (you can march through an ally).
2. If an **enemy land unit** is within `captureRadius` of the landing point, the front holds: no change.
   Contested ground is resolved by combat, not by who clicks first.
3. Otherwise carve a circle of `captureRadius` (default 30 km) around the unit out of the owner's territory
   and union it into the mover's. The circle is clipped to land, so coastal advances do not paint the sea.
   With provinces, the unit takes the province it stands in plus the owner's provinces whose centre lies
   within `captureRadius`; borders therefore always follow province edges.
4. **Cities**: if a **major city** lies within the circle, the capture radius around that city grows to
   `cityRadius` (default 75 km) so taking the city takes its district, and the town marker's faction flips.
   With provinces: the owner's provinces whose centre lies within `cityRadius` of the city.
   Capitals additionally post a campaign-wide event.
5. Resource nodes inside the carved area change hands immediately (their income counts at the next end of turn).

Units that are **removed or destroyed** do not give territory back; the front stays where it was until the
enemy advances. This is simple, predictable and matches how the war actually looked.

⚠ Radii: 60 km per unit and 150 km per city are starting points chosen so a month's infantry advance (100 km)
carves a visible but not absurd bite out of a country. Both are campaign settings.

### 5.3 Inside or outside

"Which faction owns this point" is a point-in-multipolygon test used for resource income, city ownership and
the capture rule. It runs server-side and is cached per turn.

### 5.4 Relations

- Each pair of factions has a status: **peace** (default), **war** or **alliance**.
- Players can **declare war** from the Nation tab (posts an event, takes effect immediately) and **propose**
  peace or alliance (the other side accepts). ⚠ Alternative: every change waits for GM approval. Recommendation:
  declarations are immediate, proposals need the other player, and the GM can override anything.
- Allies can move through each other's territory without capturing; alliance does not (yet) share income.

## 6. Resources, cities and production

### 6.1 The ten map resources

| Resource | Used for | Where it is on Earth (1914) |
|---|---|---|
| Grain | food for units and cities, manpower growth | Ukraine, Hungarian plain, Po valley, US and Canadian prairies, Argentina, Punjab |
| Coal | industry, steel, ships | Ruhr, Silesia, Donbas, Wales and the Midlands, Appalachia, northern France |
| Iron | industry, artillery, armour | Lorraine, Kiruna, Krivoy Rog, Bilbao, Great Lakes, Urals |
| Oil | vehicles, aircraft, modern ships | Baku, Ploiești, Pennsylvania, Texas, Persia, Dutch East Indies, Burma |
| Copper | shells, wire, electrics | Rio Tinto, Chile, Katanga, Montana and Arizona, Urals |
| Rubber | vehicles, aircraft, gas masks | Malaya, Congo, Amazon, Ceylon |
| Nitrates | explosives and fertiliser | Chilean desert; later synthesised (a tech) |
| Timber | construction, trenches, ships | Scandinavia, Russia, Canada, Carpathians |
| Cotton | uniforms, cordite | US South, Egypt, India, Turkestan |
| Horses | cavalry, artillery draught, supply | Hungarian and Russian steppe, Argentina, US plains, Australia |

Plus three **derived** pools that are not on the map: **Money** (from cities and the GM), **Manpower** (from
cities' population and grain) and **Research points** (from cities' industry, universities the GM designates,
and a base allowance). Every pool is a whole number the GM can edit with +/- steppers.

### 6.2 Resource nodes

- A `resource` marker: kind, yield per turn (1–10), and an icon per kind (drawn glyphs in the counter style
  so they scale like scenery; sprite sheets can replace them later).
- **Earth generation**: a bundled dataset `public/earth/resources.json` of roughly 200 historically placed
  deposits and regions circa 1914 (lat/lon, kind, size), authored for this project. "Generate resources"
  in the Game tab projects them onto the map as nodes owned by whoever's territory contains them. Options:
  dataset only, or dataset plus a **fill** pass that scatters smaller random nodes across land so remote
  factions have something to work with. Everything is editable afterwards: move, delete, change yield, add.
- **Image maps**: the GM places nodes by hand (quick-add style: pick a kind, click the map).

### 6.3 Cities

- Towns gain `industry` (0–5), `pop` and a `major` flag. Industry drives money, research points and how many
  builds a city can run at once; the capital gets +1 industry.
- **Add major cities**: for Earth, a bundled `public/earth/cities.json` built from Natural Earth's
  populated-places file (public domain, pulled by the same `prepare-earth.js` script) filtered to capitals
  and cities above ~250,000, with a 1914 name override table (Constantinople, St Petersburg, Königsberg,
  Lemberg, Christiania, Breslau, Danzig, Pressburg, Salonika…). Industry level is derived from population
  (bands), the faction from the territory the city sits in. About 180 cities. Editable afterwards; the
  button is safe to run twice (it skips cities that already exist).

### 6.4 Production

- Each unit type gets a **cost** (resources, money, manpower) and a **build time** in turns, stored next to the
  stat table so the GM edits them the same way (+/- steppers). Examples to start from: Infantry Regiment
  10 grain, 5 cotton, 20 money, 3 manpower, 1 turn; Tank Battalion 15 iron, 10 coal, 5 oil, 5 rubber, 80 money,
  2 turns; Battleship 40 iron, 30 coal, 200 money, 6 turns.
- A faction queues builds at a **city it owns**; a city runs `industry` builds in parallel. Cost is paid when
  queued (refunded if cancelled). Naval units need a coastal city (a city within ~30 km of the coast, computed
  from the land polygon); aircraft need industry ≥ 2.
- Completed units spawn beside the city with quick-add naming and stats from the campaign table, owned by
  the faction's player if one is assigned.
- Tech gating: a type appears in the production list only when the faction has unlocked it (section 7.2).
- ⚠ Upkeep: optional setting, off by default. When on, each unit costs grain (and oil for vehicles/ships)
  per turn; a faction that cannot pay loses strength on its most expensive units. Recommendation: ship the
  switch off, so the GM can turn it on once the economy is tuned.

## 7. Research

### 7.1 Tree

The old tech tree page's model carries over almost unchanged, because it already fits: trees → branches →
techs with a **year**, an **RP cost**, a **money cost**, **prerequisites**, a description and an image. It
moves from Firebase into the `techs` table per campaign, seeded from a bundled default
`data/techtree-ww1.json` that the GM can edit in the browser (add node, edit, delete, set prerequisites with
the same search picker the old admin page had).

Proposed default tree, ~100 nodes across eight branches, years 1900–1925:

- **Infantry**: magazine rifles → machine-gun companies → grenades → trench mortars → light machine guns →
  infiltration tactics (unlocks Assault Regiment) → combined arms.
- **Artillery**: quick-firing field guns → heavy howitzers → indirect fire → creeping barrage → railway guns
  → sound ranging → gas shells.
- **Armour & motor**: armoured cars → tracked vehicles → Mark I tanks (unlocks Tank Battalion) → light tanks →
  motorised supply.
- **Aviation**: observation balloons → reconnaissance aircraft → synchronised guns (Fighter Squadron) →
  bombers → strategic bombing → airships → seaplane carriers.
- **Naval**: pre-dreadnoughts → dreadnoughts → battlecruisers → submarines → depth charges → convoys →
  minelaying → naval aviation.
- **Chemical**: chlorine → gas masks → phosgene → mustard gas → Haber process (synthetic nitrates: removes
  the nitrate cost from shells).
- **Industry & logistics**: railway troops → war economy (+industry) → mass production (build times −1) →
  wireless → motor transport → medical services (strength recovery).
- **Doctrine**: general staff → conscription (cheaper Conscript Regiments, +manpower) → total war →
  defence in depth (+defend) → stormtrooper tactics (+attack for Assault).

### 7.2 Starting tech and pacing

- When game mode starts, every faction unlocks all techs with `year ≤ startYear` (1914 for the scenario), so
  nations begin with the 1914 toolkit: rifles, machine guns, field artillery, dreadnoughts, balloons,
  reconnaissance aircraft, no tanks, no gas, no fighters.
- The GM can then tailor: give the German Empire Zeppelins, take dreadnoughts away from a minor power.
- **Year gate**: a tech can be researched only when the game date is within `researchLead` years (default 1)
  of its year, so 1918 tanks cannot appear in 1915 however rich a nation is. The GM can waive the gate per
  faction or per tech.
- Research runs **one project at a time** per faction (queue of up to 5). RP income arrives at end of turn.
  Costs are tuned so a normal power unlocks something every 2–4 turns.

### 7.3 Effects

A tech's `effects` list is data, applied by the server when unlocked:

| Effect | Example |
|---|---|
| `unlockUnit: <typeId>` | Mark I tanks → Tank Battalion buildable |
| `stat: {category or typeId, attack/defend/movement, +n}` | Stormtrooper tactics → Assault +2 attack |
| `cost: {typeId, resource, ×0.8}` | Mass production → all units 20 % cheaper in money |
| `buildTime: {category, −1}` | Mass production |
| `income: {resource or rp or money, +n or ×}` | War economy → +10 % money |
| `removeCost: {resource}` | Haber process → nitrates no longer needed |
| `flag: <name>` | Convoys → transports immune to submarine attack (a future combat rule) |

Effects are recomputed from the unlocked set whenever it changes, never stored as running totals, so a GM
locking a tech again cleanly removes its bonuses.

## 8. User interface

### 8.1 Player: the Nation tab

A new sidebar tab (visible in game mode) for a player's faction, with the GM able to open any faction's view:

- **Header**: flag, faction name, turn and date, deadline.
- **Treasury**: ten resources with stockpile and per-turn delta, money, manpower, RP. Hover explains the
  delta ("+8 coal: Ruhr 5, Saar 3").
- **Production**: list of owned cities with their queues, an "Add build" picker filtered to unlocked types
  (with cost and time), cancel.
- **Research**: current project with a progress bar, the queue, and "Open tech tree" (modal, the old page's
  year-column layout per branch, nodes coloured unlocked / available / locked / year-gated).
- **Diplomacy**: every other faction with status and buttons (declare war, propose peace, propose alliance;
  incoming proposals to accept).
- **Forces**: units by category with how many still have movement or AP this turn; click to centre.

### 8.2 GM: the Game tab

- **Turn control**: turn and date, step, deadline, **End turn**, **Undo last turn**, game-mode on/off.
- **Faction table**: one row per faction with money, RP, key resources, tech count, unit count, city count;
  click a cell to edit inline with +/- steppers (the stats-editor pattern); click the name for the full
  Nation view with GM powers (unlock or lock any tech, edit stockpiles, grant units, set relations).
- **Map tools**: Generate resources (Earth), Add major cities (Earth), Assign 1914 borders, Assign area to
  faction (uses a selected drawing), Territory brush (paint or erase a circle of a chosen radius for a
  faction), Add resource node (quick-add style), Add city.
- **Rules**: km per movement point, capture and city radii, occupy-neutrals, upkeep, research lead, waive
  movement limits, and the unit cost table (same editor as stats).

### 8.3 Map

- Territory fill and outlines per faction; hovering a border shows the owner.
- Resource nodes and city industry badges; a "captured this turn" flash on nodes and cities that changed hands.
- Movement range ring while dragging a unit (green while allowed, red when clamped); a small "moved" dot on
  units that have used their allowance; greyed attack button when AP is spent.
- Turn HUD next to the zoom controls; end-of-turn summary as a toast plus a log entry.

## 9. Settings (per campaign, all GM-editable)

`game.settings`: `turnStep` (week | fortnight | month | season), `startDate`, `kmPerMove` (50),
`kmPerRange` (50), `captureRadiusKm` (30), `cityRadiusKm` (75), `occupyNeutrals` (true), `upkeep` (false), `researchLead` (1),
`waiveMovement` (false), `baseRp` (per faction per turn, default 5), `baseMoney` (10), `costs` (unit cost
table overrides, like `unitStats`).

## 10. Server surface

New routes under `/api/lobbies/:id/game/…` (GM unless noted):

- `GET state` (any member, filtered to what they may see), `POST enable`, `POST end-turn`, `POST undo-turn`,
  `PATCH settings`
- `GET factions/:fid`, `PATCH factions/:fid` (resources, money, techs, relations), `POST factions/:fid/grant`
- `POST research` (player: choose or queue), `POST production` / `DELETE production/:qid` (player)
- `POST relations` (player: declare or propose), `POST relations/:id/accept`
- `POST territory/seed-earth`, `POST territory/assign`, `POST territory/brush`, `GET territories` (any member)
- `POST resources/generate`, `POST cities/seed`
- `GET techs`, `POST techs`, `PATCH techs/:key`, `DELETE techs/:key`

Existing marker routes enforce movement and AP when game mode is on and the actor is not a GM, and call the
capture routine after a committed land-unit move. WebSocket messages gain `game` (turn/date/settings),
`faction` (one faction's state, sent only to its player and the GM) and `territory` (a faction's polygon
changed). The existing `canSee` rule still filters markers; faction states are private to their player and
the GM by default, with a campaign switch to make treasuries public.

## 11. Delivery plan

Each phase ships on its own and is useful without the next.

1. **Turns and economy core** (done): game tables, enable/disable, turn and date, End turn with income
   and reset, faction_state, resource nodes placed by hand, movement and AP enforcement, Nation tab (treasury,
   forces) and Game tab (turn control, faction table with inline editing).
2. **Territory and war** (done): territories table, 1914 seeding, assign/brush tools, relations, the capture rule on
   move, city capture, territory rendering, undo last turn.
3. **Production and cities** (done): cost table and editor, production queues, spawning, major-city dataset and
   seeding, Earth resource dataset and generation with fill.
4. **Research** (done): default tree data, tech table and editor, research queue and progress, effects engine,
   production gating, tech tree modal, GM unlock/lock.
5. **Polish** (done): turn reports per faction (stored for 60 turns, shown when a turn ends and on demand),
   deadlines as a countdown with 24-hour and overdue reminders in the log, captured-this-turn stamps (pulsing
   ring, Nation tab list, no yield until the next turn, builds lost with a captured city), the All-nations
   table when treasuries are public, and `scripts/import-firebase.js --tree --nations` for the old techtree
   page's data.

Rough size: phases 1 and 2 are each about the size of the Earth-map work; 3 and 4 a little smaller; 5 small.

## 12. Decisions (agreed 26 Sep 2026)

1. **Turn length: 1 week.** The campaign runs over a few real months with RP happening in Discord alongside;
   weekly turns keep the map moving at that pace. Start date for the 1914 scenario: 28 July 1914.
2. **Borders change on move**, immediately when a land unit's move is committed.
3. **Diplomacy is queued for the GM.** A player queues a declaration of war, a peace offer or an alliance
   proposal; the GM is notified and approves or blocks it. Approved declarations take effect at once;
   approved proposals then go to the other player to accept.
4. **Upkeep is built but off by default.** The setting exists from phase 1 so it can be switched on once the
   economy is tuned.
5. **Resources stay as listed**, and the Earth dataset must give **Newfoundland iron** (the Bell Island mines
   were a major producer).
6. **Production at cities, plus factories.** Cities (towns of size city or capital) produce units. Players
   can also build a **factory** within 50 km of a city or town, never a village; a factory is a production
   site with its own industry level. Villages produce nothing.
7. **Tech tree: the authored default**, editable in the browser.
8. **Capture radii approved**: 60 km per unit, 150 km per city. **Halved on 27 Sep 2026 to 30 km and 75 km**: with 100 km provinces a single unit was taking all of Luxembourg in one move, and the user wants serious military power to be needed. Both remain campaign rules.
9. **Provinces (27 Sep 2026).** Territory on the Earth map is made of irregular provinces about 100 km
   across, cut along the seed year's borders and the coastline; custom maps keep free-form territories for
   now. Capture and the GM tools work on whole provinces.
