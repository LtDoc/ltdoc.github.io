# WoE Strategy Map: automatic fog of war

Status: **built 1 Oct 2026** (proposal written 29 Sep 2026). Every recommendation in section 10 was taken; "As built"
below lists what differs from the proposal. The rest of this document is the design as proposed.

## As built

- **Switch**: ⚖ Rules → *Fog of war* (game mode only, off by default), with the vision range table (`settings.vision`,
  by unit type or category, places by size, heroes) and how close submarines are spotted (`subSpotKm`).
- **Server**: `server/vision.js` works out each nation's sight (cached per campaign, rebuilt when units, ownership,
  relations or rules change) and answers `canSee` (`server/lobbyAccess.js`), so first loads, live updates, history,
  drag previews and the attack picker all follow it. `schedulePush` sends each player the units that came into or
  went out of sight, their overlay and their ghosts (WebSocket `vision`; `GET /api/lobbies/:id/game/vision`).
  Units of other sides arrive without their trail, supply link or travel plans.
- **Overlay**: Earth maps darken the provinces out of sight (a second mesh in `public/js/province-layer.js`); image
  maps get a dark layer with the sight circles and own territory cut out (`MapRenderer.setFog`).
- **Last known positions** (decision 7): stored per nation in `fog_ghosts`, drawn as faded counters "seen turn N".
  A ghost appears only when the side's sight leaves the spot (an enemy seen walking away is known not to be there),
  and goes when the unit is seen again or the spot is back in sight without it.
- **Battles**: the combat report and the battle on the map go to the two sides (and their allies) and the GM; the
  attacker is revealed to the defender's side until End turn (`revealTo`, as a spy's recon). Capture lines name the
  nation, not the unit. Other sides' unit counts are hidden on the Nation panel even with public treasuries.
- **GM**: sees everything; 👁 View as player (docs/UI.md) shows a nation's view, fog included.
- **Submerged submarines** (3 Oct 2026, docs/WARFARE.md) are hidden from other sides in every game, fog or not,
  except within `subDetectKm` of one of their destroyers. Without fog the vision state then tracks only submarines,
  through the same pushes.
- **Research**: the `vision` effect (`{ type: 'vision', unit?|cat?|all?, km }`) and one new tech, *Aerial
  photography* (1915, aircraft +100 km), added to existing campaigns' trees. *Wireless telegraphy* and *Sound
  ranging* are unchanged.
- **Not built**: the "Reveal to everyone" checkbox (list every nation under *Visible to* instead), spotted versus
  identified (decision 6, later if needed), hidden or remembered enemy trenches (trenches stay public, the
  "always visible" alternative of decision 8), trench concealment.

## 1. What changes for players

Today every player sees every unit of every nation. The only way to hide one is by hand: the GM marks it
"GM only" or "Visible to" certain nations (`canSee()` in `server/lobbyAccess.js`).

With fog of war switched on for a campaign:

- A player always sees **their own nation's units**, and their **allies'** units (⚠ decision 4).
- They see an **enemy or neutral unit only while it is inside their vision**: near one of their units, near
  one of their towns, or on ground they own.
- Everything else about the world stays public: the map, **territory and province ownership** (the front line
  is known), towns, cities, resource nodes and factories.
- The GM sees everything, as now, and can look at the map through any nation's eyes.

Fog is a **campaign rule, off by default**, like upkeep. A campaign without it behaves exactly as today.

## 2. Principles

- **The server decides, the browser never knows.** A unit a player may not see never reaches their browser: not
  in the first load, not in a live update, not in a drag preview, a history entry, a combat report or a log
  line. This is how "GM only" already works, and fog extends the same rule. Hiding things only on screen
  would let anyone read enemy positions from the browser's developer tools.
- **Simple enough to reason about at the table.** A player should be able to say "my cavalry is here, so I
  can see 80 km around it" without a calculator. Ranges are round numbers in km, shown in the unit popup.
- **The manual controls keep working.** "GM only" still hides a unit from everyone, and "Visible to" still
  reveals a unit to the nations listed, fog or not. They become overrides on top of automatic vision.

## 3. Vision

### 3.1 Vision model ⚠ decision 1

**Earth map: vision by province.** A nation's vision is a set of provinces. A province is in vision when a
vision source (section 3.2) covers its centre, or the source stands inside it. An enemy unit is visible when
the province it stands in is in vision. Provinces are about 100 km across, so vision is a little coarse. It is
also cheap, easy to show on the map by shading, and matches what players already see: the land is cut
into provinces and fog follows the same edges.

**Uploaded image maps (no provinces): vision by radius.** An enemy unit is visible when it is within range of
any vision source, measured with the campaign's scale.

The alternative for the Earth map is pure radius everywhere: finer, but a player cannot see the edge of their
vision as clearly, and the fog overlay has to be drawn as circles instead of provinces.

### 3.2 Vision sources and ranges ⚠ decision 2

Ranges are defaults per unit category, with overrides for scouting types, editable per campaign like unit
stats (a +/- table in the GM's settings) and raised by research (section 7).

| Source | Default vision |
|---|---|
| Infantry, support, engineers, HQ | 50 km (the same as infantry attack reach, so infantry can always hit what it can reach) |
| Machine guns, mortars, all artillery | 30 km: guns do not scout, so artillery needs spotters to use its full reach |
| Cavalry, dragoons, lancers, hussars, camel corps, armoured cars | 80 km |
| Reconnaissance squadrons | 120 km |
| Tanks, armoured trains | 40 km |
| Surface warships | 80 km, at sea and along coasts |
| Submarines | 30 km |
| Fighters, bombers, seaplanes | 150 km |
| Reconnaissance aircraft, airships | 250 km |
| Observation balloons | 100 km |
| Capital / city / village | 100 / 60 / 30 km |
| Own provinces (⚠ decision 3) | the whole province: a nation always sees what is on its own ground |

Destroyed units (0 % strength) give no vision.

### 3.3 Hard to spot

- **Submarines** are only seen within 20 km of an enemy vision source (not the full range) unless they
  attacked this turn.
- ⚠ Later, if wanted: units in reinforced trenches are only seen within half range.

### 3.4 Allies ⚠ decision 4

Allied nations share vision: each sees what the other sees. War and peace follow the existing relations table,
so an alliance made mid-turn shares vision at once, and ending one stops it.

### 3.5 When vision updates ⚠ decision 5

**Live.** Vision is recomputed whenever a unit is placed, moved, destroyed or removed, or a relation changes.
When your cavalry rides forward, the enemy units it now covers appear on your map at once. When an enemy unit
walks out of your vision it disappears.

The alternative is a **snapshot at the start of each turn**: players see where the enemy was when the turn
began, plus anything their own units bump into. It suits hidden simultaneous orders better, but it confuses
anyone who moves a unit next to an enemy and cannot see it. Live fits a map where people move pieces during a
turn and talk about it in Discord.

### 3.6 What a player sees of a visible enemy ⚠ decision 6

**Everything, as today**: name, type, strength, flag. The alternative is two levels: *spotted* at the edge of
vision (a grey counter with only its category: "infantry") and *identified* closer in (full details).
Worth doing later if players start using vision edges to count divisions.

## 4. What fog covers, channel by channel

Every place where a unit's existence or position reaches a player has to respect vision. This is the list of
places in the code, so none is missed.

| Channel | Today | With fog |
|---|---|---|
| First load of markers (`GET /markers`) | filtered by `canSee` | filtered by `canSee` with vision |
| Live marker updates (`broadcastEntity`, `server/ws.js`) | upsert/delete per socket by `canSee` of the old and new state | the same, with vision: an enemy entering your vision arrives as an upsert, leaving it as a delete |
| **Your own units moving** | nothing extra | recompute your side's vision and push the difference: enemy units newly covered arrive, uncovered ones are removed (section 6.2) |
| Live drag previews (`drag` over the socket) | sent to everyone who can see the unit | sent only to the GM, the unit's own nation and its allies: a preview would otherwise reveal where a unit is heading |
| History tab | entries of items the player can see | enemy units' entries hidden entirely: "moved X (a → b)" gives positions away |
| Combat reports | visible to anyone who can see both units | a player can only attack a unit they can see; the report goes to both sides; the attacker is **revealed** to the defender until the end of the turn (guns give away their position) |
| Capture log lines ("4e Infantry Regiment (France) takes Strasbourg") | public | public text without unit names: "France takes Strasbourg and the surrounding German territory"; the named version goes to the capturing side and the GM |
| Unit counts on the Nation tab (public treasuries) | every nation's count | own and allied counts only |
| Turn reports | own nation only | unchanged |
| Attack picker | enemies within reach | enemies within reach **and in vision** |
| "Marker moved" desktop notifications | any visible unit | follows the upsert rule above |
| Trenches (drawings) | visible to all | ⚠ decision 8: enemy trenches appear once seen and stay known |
| Territory, provinces, towns, resources, factories | public | public, unchanged |

## 5. GM tools

- **Fog of war** switch in the Game tab's rules, off by default.
- **View as nation**: a picker on the Game tab that shows the map exactly as one nation sees it, fog overlay
  included, without logging in as that player. The GM's own view stays all-seeing.
- **Overrides on any unit**: "GM only" hides it from everyone; "Visible to" reveals it to the listed nations
  regardless of vision (famous units, a parade, a spy report); a new **Reveal to everyone** checkbox shows it
  to all nations.
- **Vision table**: the ranges of section 3.2 as a +/- table, like unit stats and costs.
- Players without a nation (spectators) see no enemy units at all under fog (⚠ decision 10).

## 6. How it works

### 6.1 Server

A new module `server/vision.js`:

- `visionFor(lobby, nation)` returns the set of visible province ids (Earth) or the list of vision circles
  (image maps) for a nation and its allies. It walks the nation's units, towns and provinces and uses the
  province grid index that already answers "who owns this point" (`provinces.within()`), so it stays in the low
  milliseconds even for a nation with hundreds of units.
- Results are cached per nation and thrown away when anything that feeds vision changes: a unit is placed,
  moved, destroyed or deleted; a town changes hands; a relation changes; ranges are edited.
- `canSee(obj, viewer)` in `server/lobbyAccess.js` gains one step: when fog is on and `obj` is a unit of a
  nation that is not the viewer's (or an ally's), the unit is visible only if `vision.inVision(viewer.nation,
  obj.x, obj.y)`, or it is revealed (attacker this turn, "Visible to", "Reveal to everyone"). Every channel
  that already calls `canSee` then follows fog without further work; the channels that do not (drag
  previews, log lines, unit counts) are changed as listed in section 4.

### 6.2 Vision changes push the difference

When a nation's vision changes, the server compares the enemy units it could see before with the ones it
sees now, and sends each of that nation's (and its allies') sockets an upsert for every unit that appeared and
a delete for every one that vanished. A move therefore costs one vision recomputation for the moving side plus
the usual per-socket check for the moved unit itself.

### 6.3 Map overlay

- **Earth map**: the server sends each player the ids of the provinces in their vision; the province layer
  (`public/js/province-layer.js`) darkens every other province. It recolours in place, as ownership does, so the
  overlay updates in a few milliseconds per move.
- **Image maps**: a dark layer over the map with the vision circles cut out.
- The GM sees no overlay, except in "View as nation".

### 6.4 Size

With 1,300 units and 15,000 provinces, recomputing one side's vision touches a few thousand provinces through
the grid index: a few milliseconds. A move triggers it for the moving side only.

## 7. Research

A new effect type in the tech tree, `{ "type": "vision", "cat": "Air", "km": 50 }`, adds range to a category,
the same way `stat` effects add attack or movement. Existing techs in the default tree that would gain a vision
effect: *Wireless telegraphy* (1912, +20 km for all units) and *Sound ranging and flash spotting* (1917:
enemy artillery that fired this turn is visible within 150 km). One new tech would be added: *Aerial
photography* (1915, needs *Reconnaissance aircraft*; reconnaissance aircraft +100 km).

## 8. Last known positions ⚠ decision 7

When an enemy unit leaves your vision, you keep a faded "last seen" marker where you last saw it, with its
type and the turn it was seen. It clears when your vision covers that spot again and the unit is gone. Stored
per nation on the server; drawn as a ghost token that cannot be selected or attacked. This is what makes fog
feel like intelligence rather than units blinking in and out.

## 9. Delivery

1. **Core rule**: the setting, `server/vision.js`, `canSee` with vision, every channel of section 4, attack
   needs sight, GM "View as nation".
2. **Live experience**: vision differences pushed on every move, the fog overlay, ranges shown in unit popups,
   the vision range table in settings.
3. **Depth**: last known positions, attacker reveal, submarine stealth, vision techs.

Each phase is usable without the next.

## 10. Decisions

1. **Vision model.** Recommendation: by province on the Earth map, by radius on image maps.
2. **Ranges.** Recommendation: the table in section 3.2 as the starting point, tuned in play.
3. **Own ground.** Recommendation: a nation always sees everything inside its own provinces. The alternative
   is vision only from units and towns, which leaves quiet stretches of a big empire unwatched.
4. **Allies.** Recommendation: allies share vision.
5. **Timing.** Recommendation: live, not start-of-turn snapshots.
6. **Detail.** Recommendation: a visible enemy shows everything, as today; spotted-versus-identified later if needed.
7. **Last known positions.** Recommendation: yes, in phase 3.
8. **Enemy trenches.** Recommendation: shown once seen and remembered after, since trench lines were mapped
   from the air and changed slowly. The alternatives are always visible, or visible only while in vision.
9. **Capture messages.** Recommendation: public messages name the nation and place, not the unit.
10. **Spectators.** Recommendation: players without a nation see no enemy units under fog.
