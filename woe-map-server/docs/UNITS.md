# Supply, support units and matchups

Built 30 Sep 2026. Shared matchup table: `public/js/matchups.js`. Supply and support rules: `server/supply.js`;
End-turn hooks and movement/attack checks: `server/game.js`; combat: `server/routes/lobbies.js` (`POST /combat`).
All distances and bonuses are campaign rules (Game tab → Rules → Supply and support).

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
- **A linked column supplies** friendly land units within **100 km**: its stretch of front. A column itself is
  supplied when linked.
- **When:** supply is worked out at **End turn** for the coming turn (and when game mode is switched on, and
  when the GM presses **Recalculate supply now**). It holds for the whole turn, so moving a column up takes
  effect at the next End turn. Units placed mid-turn count as supplied until then.

A **cut-off** unit:
- cannot move (the move is refused; clicking it shows a red ring and says why);
- cannot attack or sabotage railways;
- takes **double losses** when an attack on it succeeds.

It shows a red no-entry badge and is slightly dimmed; its panel says "OUT OF SUPPLY". Turn reports list each
nation's cut-off units. The GM is never limited, and the rules switch turns supply off entirely.

## Support units

Support units help friendly units (their nation's and allies') around them while they are alive and supplied.
Selecting one shows its reach on the map; its panel says what it does.

| Unit | Effect | Reach |
|---|---|---|
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

## Campaign rules

Supply on/off · a place feeds a column within: capital (600 km), city (400 km), village (200 km) · column supplies
within (100 km) · railhead / column chain (150 km) · garrison within a place (30 km) ·
hospital heals within (40 km) and by (10 %) · HQ within (40 km) and bonus (+1) · engineers within (20 km) and
+defend (1) · signals within (60 km) and +artillery attack (1).
