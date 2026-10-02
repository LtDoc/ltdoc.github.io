# Supply, support units and matchups

Built 30 Sep 2026. Shared matchup table: `public/js/matchups.js`. Supply and support rules: `server/supply.js`;
End-turn hooks and movement/attack checks: `server/game.js`; combat: `server/routes/lobbies.js` (`POST /combat`).
All distances and bonuses are campaign rules (⚖ Rules → Supply & support).

## Supply

Every land unit (infantry, mounted, artillery, support, and custom types) is either **supplied** or **cut off**.
Ships, aircraft and heroes do not need supply.

- **Towns are the nodes.** A unit within **30 km** of a friendly town (its nation's or an ally's) is supplied
  directly, as a garrison.
- **Supply Columns carry it forward.** A Supply Column (unit type *Supply / logistics*) is **linked** when a
  friendly place is close enough for its size: **capitals within 600 km, cities within 400 km, villages within
  200 km**. A column is also linked within **150 km** of open friendly
  **railway** connected to a friendly place (a railhead; cut or enemy-held track does not count) or of another
  linked column, so columns can chain forward.
- **Convoys supply invasions.** A convoy (unit type *Transports / convoy*) is a floating supply base that works
  anywhere, independent of home places: it supplies friendly land units within **100 km** (a beachhead) and
  feeds Supply Columns within **200 km**, which can then chain inland.
- **Convoys carry troops.** Up to **10** land units or heroes within **30 km** of a convoy embark on it (the
  convoy's card: **⛴ Embark nearby**; a unit's card: **⛴ Board …**). Aboard they leave the map and sail with it:
  they cannot move, fight or be attacked, need no supply and hold no ground. **⚓ Land troops** puts everyone ashore
  at once on the nearest beach within **100 km** of the convoy; with no beach that close they stay aboard. Landing
  on enemy ground takes it like any advance (defended ground holds). Boarding and landing each use up the units'
  move for the turn. If the convoy is **sunk or removed, everyone aboard goes down with it**. Rules: ⚖ Rules →
  Supply & support → Troops at sea (`convoyCapacity`, `convoyBoardKm`, `convoyLandKm`).
- **Columns chain.** A column within **150 km** of another linked column is linked through it, so a string of
  columns carries supply as far from a place, railhead or convoy as you like (each one supplies its own 100 km).
- **A linked column supplies** friendly land units within **100 km**: its stretch of front. A column itself is
  supplied when linked.
- **Live:** supply is recomputed whenever something that can move a supply line changes (a unit or place is
  moved, created, removed or changes hands, a railway is cut or repaired, war or an alliance changes) and every
  open map gets the new status at once. Bringing a column up frees cut-off units the same turn, so they can
  move and fight again. End turn, switching game mode on and **Recalculate supply now** also recompute it.

A **cut-off** unit:
- cannot move (the move is refused; clicking it shows a red ring and says why);
- cannot attack or sabotage railways;
- takes **double losses** when an attack on it succeeds;
- gets no healing from field hospitals or medical tech;
- suffers **attrition** at End turn: the first End turn cut off costs nothing; from the second on it loses
  **25 %** of its remaining strength each turn (100 → 75 → 56 → 42 …); below **10 %** it **surrenders**:
  strength 0, a **white flag** over the counter instead of smoke. Its panel counts the turns cut off; turn
  reports list the strength lost and any surrender. Getting supply back resets the count.

It shows a red no-entry badge and is slightly dimmed; its panel says "OUT OF SUPPLY". A supplied unit's panel
says where its supply comes from ("supplied by 2nd Supply Column"), and selecting it draws its supply line: a
dashed amber line through each column back to the place, convoy or railhead it starts from. Turn reports list each
nation's cut-off units. The GM is never limited, and the rules switch turns supply off entirely.

## Support units

Support units help friendly units (their nation's and allies') around them while they are alive and supplied.
Selecting one shows its reach on the map; its panel says what it does.

| Unit | Effect | Reach |
|---|---|---|
| Transports / convoy | supplies land units (above), anywhere | 100 km (feeds columns within 200 km) |
| Supply / logistics (Supply Column) | supplies land units (above) | 100 km (fed from capitals 600 km, cities 400 km, villages 200 km) |
| Medical / field hospital | heals damaged units by 10 % strength at each End turn (not destroyed ones) | 40 km |
| Headquarters | +1 attack and +1 defend | 40 km |
| Engineers, pioneers, sappers | +1 defend | 20 km |
| Signals | +1 attack for artillery (spotting) | 60 km |

The best support unit of each kind counts once; these stack with generals, tech and trench cover, and appear in
the combat log ("attacker +1 Corps HQ").

## Matchups

Strengths and weaknesses are added to the attacker's roll, capped at ±5 in total. The unit panel lists a type's
strengths and weaknesses, the attack dialog shows the modifier against each target, and the combat log names
each rule that applied. "Entrenched" means the defender has trench cover.

| Attacker | Defender | Modifier |
|---|---|---|
| Cavalry (all mounted horse types, camels, reconnaissance) | entrenched troops | −3 |
| Cavalry | machine guns | −3 |
| Cavalry | artillery | +3 |
| Cavalry | support troops | +2 |
| Infantry (not machine guns) | machine guns | −2 |
| Machine guns | cavalry | +2 |
| Stormtroopers | entrenched | +2 |
| Tanks | entrenched / machine guns / artillery | +2 / +2 / −1 |
| Armoured cars | entrenched / cavalry | −2 / +2 |
| Field and horse artillery | entrenched | +1 |
| Heavy, siege, railway guns, mortars | entrenched | +2 |
| Gas troops, sappers | entrenched | +2 |
| Coastal batteries | ships | +2 |
| Anti-aircraft | aircraft | +4 |
| Aircraft | anti-aircraft | −2 |
| Fighters | bombers, airships, spotters | +2 |
| Infantry, mounted troops | aircraft | −3 |
| Submarines | transports, minelayers / capital ships | +3 / +2 |
| Torpedo boats | capital ships | +2 |
| Destroyers | submarines, torpedo boats | +3 |
| Capital ships | destroyers, torpedo boats | −1 |

## Riflemen in a firefight

While an infantry unit (any type in the Infantry category: line infantry, conscripts, marines, machine-gunners…)
is in a gunfire battle this turn, a squad of 8 soldiers holds its firing line on the map from 800 % zoom. Living
soldiers = strength ÷ 12.5, rounded up (100 % → 8, 74 % → 6, 50 % → 4, 0 → none); the rest lie dead along the
line. Uniforms: grey, beige or green per faction (chosen on the faction, else from its name), and the armoured
assault kit for stormtroopers. Purely visual: nothing here changes combat. Code: `public/js/skirmish.js`, wired in
by `MapRenderer._tickBattles`; atlas built by `scripts/build-soldiers.js`.

## Campaign rules

Supply on/off · a place feeds a column within: capital (600 km), city (400 km), village (200 km) · column supplies
within (100 km) · railhead / column chain (150 km) · garrison within a place (30 km) · convoy feeds columns within (200 km) ·
convoy supplies units within (100 km) · attrition (25 % a turn from the 2nd turn cut off) · surrenders below (10 %) ·
hospital heals within (40 km) and by (10 %) · HQ within (40 km) and bonus (+1) · engineers within (20 km) and
+defend (1) · signals within (60 km) and +artillery attack (1).
