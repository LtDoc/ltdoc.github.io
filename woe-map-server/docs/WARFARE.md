# Phases, corps, trenches and the war at sea

Built 3 Oct 2026. Orders (including sappers wrecking resource works): `server/routes/orders.js`; trench sections: `server/trenches.js`; phases and worn units:
`server/game.js`; blockades: `server/supply.js`; submerged submarines: `server/vision.js`. Every number is a campaign
rule (⚖ Rules). The GM is never limited by any of it.

## Phased turns

Each turn has two phases (⚖ Rules → Movement → *Phased turns*, on by default):

1. **Movement phase.** Units and heroes move, ride trains, board and land from convoys and form corps lines.
   Attacks, railway sabotage and sappers wait.
2. **Battle phase.** The GM opens it with **⚔ Battle phase** on the turn widget (or the 👑 GM panel's Turn page).
   Attacks, railway sabotage and sappers are open; every unit holds its position.

End turn then starts the next turn in its movement phase. The turn widget shows the phase (🚩 Movement phase,
⚔ Battle phase); when it changes everyone gets a banner over the map, a toast, a chime and a desktop notification,
and a line in the log. Ready-ups start again for each phase, so the GM sees when everyone has finished moving and
when everyone has finished fighting. The GM can go back to the movement phase from the Turn page. Building,
research, diplomacy, trades, replenishing and engineers' digging work in either phase.

Switch the rule off and the whole turn is open again, as before: move, then attack, in any order.

## Worn units

A unit fights at **−1 attack and defend for every 20 % of strength it has lost** (⚖ Rules → Movement → *Worn*): at
80 % −1, at 60 % −2, at 40 % −3, at 20 % −4. It counts in every attack, as attacker or defender, in railway
sabotage and against sappers. The combat log shows it ("attacker −2 worn (60%)") and so does the unit's panel.
Set it to 0 to switch it off.

## Replacements

**🩹 Replenish** (a damaged unit's panel) takes on up to **50 %** strength in one go. It costs the manpower and money
of a new unit of that type in proportion (half a new Infantry Regiment's 3 manpower and 20 money for 50 %), and the
unit spends the rest of the turn refitting: no more moving or attacking. It needs:

- its own or allied territory (a ship: within 30 km of a friendly town, in port);
- to be supplied, and not to have attacked this turn;
- **no enemy unit within 50 km** that its side can see (an enemy is a nation it is at war with);
- once a turn.

Field hospitals and medical research still heal for free, slowly; replacements are the quick way back.

## Corps

A corps is a named group of one nation's land units that forms up on a line, in the spirit of Hearts of Iron's front
lines.

- **Form one:** select several of your units on the map (⬚ or Shift-drag); the bar at the bottom offers
  **⚑ Form corps** (named I Corps, II Corps… by default) or **＋ Add to corps**.
- **Form a line:** select the corps (drag a box round it, or **Select** in 🏛 Nation → Forces) and press **⇥ Form
  line** in the bar at the bottom (also in Nation → Forces). Click points along the front, finish with a double-click,
  Enter or Done, then click on the **enemy's side** of the line. Front-line troops (infantry, cavalry, tanks…) spread
  evenly along it; artillery forms up **15 km behind** them and support units (HQ, engineers, hospitals, columns)
  twice as far; every unit faces the enemy (its men and guns in the battle scenes turn that way). Units keep their
  order along the line, so nobody crosses the corps to reach a place. A unit moved on its own afterwards stops facing
  the corps' front.
- Each unit moves by the usual rules (movement, water, railways, the phase). One that runs short gets as far as it
  can: **↻ Same line** next turn and it carries on.
- **Select** finds the corps on the map; ✎ renames it; ✕ disbands it (the units stay where they are). Ships, aircraft
  and fixed works are left out of the line.

## Trenches: engineers dig, sappers blow up

While the game runs, a player's trench tool (⌇) only **plans** a trench: a pale dashed line that gives no cover.

- **Engineers and pioneers** dig it: **🛠 Dig trench** in their panel orders them to dig the **10 km** section of the
  nearest planned trench (of their side, or nobody's) within **20 km** of them. The work is done at End turn, for
  **4 timber**, if the engineers are still within 20 km of a planned trench, supplied and alive. One section a
  turn per engineer battalion; sections dug next to each other join into one trench.
- **🛠 Reinforce** does the same to a dug trench of their side: a reinforced section, for **6 timber**.
- **Sappers** blow up the section of an enemy trench nearest them, within 20 km, in the battle phase:
  **💥 Blow up trench**, using their action. They roll d20 + attack (with tech, a general and worn penalty) against
  d20 + 2 + the trench's cover (+2 dug, +4 reinforced) + the defend of its best guard (a land unit of its side within
  20 km). On a success that section is gone; what is left either side stays.
- A dug trench cannot be redrawn, extended or moved by a player; the GM can still edit anything, and outside game
  mode trenches are drawn as before. Undo last turn does not fill in what was dug; revert the sections from 🕘 History.

Rules: ⚖ Rules → Trenches → Engineers and sappers (`trenchSectionKm`, `trenchDigKm`, `trenchDigTimber`,
`trenchReinforceTimber`, `trenchDemolishDefence`).

### Manned trenches hold the line

A land unit cannot cross a dug or reinforced trench of a nation it is at war with where the trench is **manned**: a
land unit of the trench's side (its nation or an ally) stands within the **cover range** (20 km, the distance that
gives trench cover) of the point where the move would cross. The move ends just short of the trench ("halted at
the German Empire's manned trench: beat its defenders or go round") and costs only the way there; a unit already at
the trench cannot cross at all. Cavalry charging the wire is stopped like everyone else.

Under fog of war (docs/FOG-OF-WAR.md, *The battlefield*) an enemy trench shows only where your side can see:
send reconnaissance to learn the shape of a line, and expect a halt at a manned stretch nobody had looked at.

To get through, beat the defenders (attack them, shell them, cut their supply), blow a gap with sappers, or go
round the end of the line. Stretches with no defender within 20 km, planned trenches, and the gaps sappers blew
let anyone through. The trench's own side and its allies cross freely, ships, aircraft and heroes are not stopped,
and the GM places anything anywhere. It applies to every kind of move: a click, a group, a corps forming its line,
and walking legs or trains that would cross. The rule can be turned off: ⚖ Rules → Trenches → *Manned trenches
hold the line* (`trenchBlocks`; the distance is `trenchRangeKm`).

## Scorched earth: sappers wreck the works

**🔥 Wreck works** (a sapper's panel, in the battle phase, using its action) knocks the works of the nearest improved
resource node within **20 km** down one level (docs/ECONOMY.md, Resource works):

- **Its own side's or an ally's**: for certain. A retreating army denies the enemy its oilfields and mines, as the
  British wrecked Romania's oil wells before the Germans reached them in November 1916; the works have to be paid
  for again.
- **An enemy's** (a nation at war with it): a raid, d20 + attack (tech, general, worn) against d20 + 2 + the
  defend of the node's best guard (a land unit of its side within 20 km).
- A nation at peace with it: left alone. A node with no improvements cannot be wrecked.

The log and the combat log carry it; the holder's income drops at once.

## Blockades

A **coastal town** is blockaded while enemy warships (of a nation at war with its owner) lie within **50 km** of it
and none of its own side's are there to contest them. Transports and submerged submarines do not count. A
blockaded town **supplies no troops** and feeds no Supply Column, so a garrison relying on it is cut off; it carries
a navy anchor badge, its panel says so, and the log announces each blockade and its lifting. Drive the ships off,
or bring your own warships within 50 km, and it supplies again. Rule: ⚖ Rules → Supply & support (`blockadeKm`).

## Submarines

A submarine's panel has **🌊 Dive** and **⬆ Surface**.

- **Submerged**, it is invisible to every other side, fog of war or not, except to a side with a **destroyer within
  20 km** of it. Only destroyers can attack it. Spies' recon does not find it. Its own side sees it faint.
- **To attack it surfaces**, and stays up (and in sight) for the rest of the turn: it cannot dive again until the
  next. Attacking a railway brings it up too.
- Submerged submarines do not blockade.

Rule: ⚖ Rules → Fog of war (`subDetectKm`). The server never sends a hidden submarine to a browser that may not see
it, in the same way as fog of war (docs/FOG-OF-WAR.md).
