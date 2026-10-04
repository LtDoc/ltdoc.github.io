# Long-term economic growth

Built 30 Sep 2026 (resource works 3 Oct 2026). Four slow ways for a nation to grow its income without touching its
army, meant to pay back over many turns rather than cover this month's spending:

1. **Factory upgrades**: raise a factory's industry level, 1 → 5.
2. **Town development**: raise a town's development level (capital 5, city 4, village 2).
3. **Resource works**: improve a resource node's works, 0 → 3, each level +25 % of its yield.
4. **The Economy research branch**: late, expensive techs with small compounding gains and cheaper projects.

Shared numbers: `public/js/game-data.js` (`PROJECTS`, `projectCost`, `projectLevel`, `devSlots`,
`DEFAULT_SETTINGS.townDevIncome`). Server: `server/production.js` (queue, site capacity), `server/game.js`
(town income), `server/routes/game.js` (production view and End turn completion), `server/research.js` (tree
merge). Techs: `defaults/techtree-ww1.json`, branch "Economy".

## Projects

Started from the 🏭 Production panel (**Development**, a list of every factory and town the
nation holds, running projects first) or from a town's or factory's popup (**🏗 Develop** / **⬆ Upgrade**).

- They are paid up front like a build and complete at End turn; cancelling refunds them.
- One project per site at a time. Projects do not take a build slot, so units keep coming.
- If the site is captured before the project finishes, the work is lost with it (no refund), like a build.
  The levels a town or factory has reached stay with the place, so a developed town is worth taking.
- Completion shows in the turn report ("completed Paris developed to level 1").
- The GM can set a town's development in its Edit form (Development 0–5) and a factory's level as before.

### Factory upgrade (level L → L + 1)

| Step | Cost | Turns | Gain |
|---|---|---|---|
| 1 → 2 | 50 money, 12 iron, 6 coal, 6 timber, 1 manpower | 3 | +2 money a turn (factory income per level), +1 build slot |
| 2 → 3 | 80 money, 18 iron, 10 coal, 6 timber, 1 manpower | 4 | the same again |
| 3 → 4 | 110 money, 24 iron, 14 coal, 6 timber, 1 manpower | 5 | |
| 4 → 5 | 140 money, 30 iron, 18 coal, 6 timber, 1 manpower | 6 | |

On money alone a step pays back in 25–70 turns; the extra build slot is the other half of the value.

### Town development (level n → n + 1)

| Step | Cost | Turns | Gain |
|---|---|---|---|
| 0 → 1 | 60 money, 10 timber, 5 iron, 8 grain, 2 manpower | 4 | +3 money and +1 RP a turn |
| 1 → 2 | 100 money, 15 timber, 8 iron, 8 grain, 3 manpower | 6 | the same, and +1 build slot |
| 2 → 3 | 140 money, 20 timber, 11 iron, 8 grain, 4 manpower | 8 | |
| 3 → 4 | 180 money, 25 timber, 14 iron, 8 grain, 5 manpower | 10 | the same, and +1 build slot |
| 4 → 5 (capitals) | 220 money, 30 timber, 17 iron, 8 grain, 6 manpower | 12 | |

Each level also adds 1 to the town's industry (aircraft need industry 2). A village developed to level 2
gains a build slot and so becomes a production site. On money alone a step pays back in about 20–75 turns.
The per-level income is a campaign rule (⚖ Rules → Economy → Town development: money, RP, manpower per level).

## Resource works

Every resource node can be improved three times (**⛏ Improve** in its popup, or Nation → Production →
Development). Each level adds **25 % of the node's base yield** (a campaign rule: ⚖ Rules → Economy → *Resource
works*), so a fully improved node yields 1¾ times as much: the Ruhr coalfield's 8 coal becomes 10, 12, then 14. Gains
keep their tenths (a yield of 1 gains 0.25 a turn a level); the income note says what the works add ("Ruhr coalfield:
+10 coal (2 from its works)").

The cost grows with the node's yield, so a rich field costs more to improve than a small deposit but pays back about
as fast, and a big power with many rich fields gains no more per money spent than a small one with a single good
one:

| Step | Cost | Turns |
|---|---|---|
| 0 → 1 | 30 money + 6 per point of yield, 6 iron + 1 per point of yield, 6 timber, 1 manpower | 3 |
| 1 → 2 | the same + 20 money, 4 iron, 2 timber | 4 |
| 2 → 3 | the same + 40 money, 8 iron, 4 timber | 5 |

(The Ruhr's first step: 78 money, 14 iron, 6 timber for +2 coal a turn. A yield-1 deposit's: 36 money, 7 iron for
+0.25.) Like the other projects they are paid up front, one at a time per node, lost if the node is captured
before they finish; the level stays with the node when it changes hands, so improved works are worth taking, and
worth denying.

Each level has a name by resource, shown in the popup, the turn report and the map's drawing of the works:

| Resource | Level 1 | Level 2 | Level 3 |
|---|---|---|---|
| Grain | Mechanised farms | Granaries | Rail siding |
| Coal | Deeper shafts | Coking ovens | Colliery railway |
| Iron | Steam shovels | Ore railway | Blast furnaces |
| Oil | More derricks | Pipeline | Refinery |
| Copper | Steam shovels | Concentrator | Smelter |
| Rubber | New plantings | Tapping gangs | Processing sheds |
| Nitrates | Oficina | Leaching vats | Nitrate railway |
| Timber | Sawmill | Logging railway | Pulp mill |
| Cotton | Gin house | Irrigation | Baling press |
| Horses | Stud farm | Paddocks | Remount depot |

**Scorched earth.** Sappers can knock a node's works down a level (docs/WARFARE.md): their own side's for
certain, before the enemy takes them, as the British wrecked Romania's oilfields in 1916, or an enemy's on a roll.

**On the map.** Every node is drawn as its works from above, under the towns (`public/js/resource-art.js`): estates
of hedged fields round a village and its farms (ripe wheat painted with the wheat sprites in
`public/sprites/fields`), cotton in rows, fenced paddocks with horses, rubber plantations in their grid, forest with
clear-cuts and a sawmill, pit heads with black spoil heaps and miners' terraces, stepped open pits for iron and
copper, oil leases crowded with derricks, nitrate oficinas on the pampa. The works grow with the yield and show
every improvement (more derricks, a refinery and its flare, silos, a railway and its sidings). A town's own fields
keep off the works, and the works keep off a town's centre. Purely visual: shown from 150 % zoom, in full detail
from 500 %.

The GM sets a node's works directly in its Edit form (*Works*, 0–3).

## The Economy branch

Every tech is dated 1915 or later, so no nation starts with them; with the default research lead a 1914
campaign can begin on the first two at once.

| Tech | Year | Cost | Needs | Effect |
|---|---|---|---|---|
| Industrial statistics | 1915 | 70 RP, 60 money | – | money income +4% |
| Municipal improvement boards | 1915 | 90 RP, 80 money | Industrial statistics | town development −15% cost, −1 turn |
| Standardised machine tools | 1916 | 110 RP, 100 money | Industrial statistics | factory upgrades −15% cost, −1 turn |
| National savings movement | 1916 | 120 RP, 60 money | Industrial statistics | money income +5% |
| Scientific management | 1917 | 160 RP, 140 money | Standardised machine tools | money +4%, research +5% |
| Grid electrification | 1918 | 220 RP, 200 money | Scientific management, Municipal improvement boards | money +6%; development and upgrades −10% cost |
| Reconstruction finance | 1919 | 260 RP, 220 money | National savings movement, Grid electrification | money +6%, manpower +5% |

All five money boosts together come to about +27%, applied to the whole money income (towns, development,
factories), so they compound with the projects.

Existing campaigns get the branch automatically the first time their tree is loaded (once; tracked in the
`tree_patches` table). If the GM had already made a tech with one of these keys, theirs is kept.

## Upkeep (balanced 3 Oct 2026)

Upkeep stays a campaign switch, off by default (⚖ Rules → Economy → Upkeep). When on, at each End turn:

- **Each town feeds a home army for free:** 8 units per capital, 3 per city, 1 per village. Every unit beyond that
  eats **0.2 grain** a turn. Small nations defend themselves with the army their towns feed; big armies, and
  armies built far beyond the home country's towns, need grain.
- **Ships burn coal** (0.25 a turn each; 1914 navies were coal-fired), as do armoured trains. **Aircraft, airships,
  tanks, armoured cars and submarines burn oil** (0.5 a turn each). Marching and riding units burn nothing.
- A nation that runs out of a resource sees its **three strongest units that need it** lose 10 % strength: ships
  when coal runs out, aircraft and motor vehicles when oil does, any unit when grain does.
- The 🏛 Nation panel's *Where it comes from* shows the upkeep line ("Upkeep: 30 units, 30 fed by its towns (71
  allowed); 23 ships burn 5.8 coal").

The old upkeep (1 grain for every unit, 1 oil for every ship, aircraft and vehicle) put every power deep in deficit
from the first turn: the bundled resource regions give the German Empire 9 grain a turn against an army of about 100
divisions. The new numbers were set against the 1914 powers' bundled regions (`public/earth/resources.json`) and
major cities (`cities.json`, assigned by the 1914 borders), with each nation's 1914 field army in divisions (one
game unit each), its navy in squadrons and flotillas, and about one air unit per 12 divisions:

| Power | Divisions | Ships | Towns feed | Grain needed / earned | Coal needed / earned | Oil needed / earned | Short under the old rules (grain / oil) |
|---|---|---|---|---|---|---|---|
| German Empire | 98 | 30 | 80 | 11.2 / 9 | 7.5 / 17 | 4.0 / 1 | 127 / 37 |
| France | 88 | 20 | 59 | 11.2 / 14 | 5.0 / 7 | 3.5 / 0 | 101 / 27 |
| Russian Empire | 115 | 15 | 86 | 10.8 / 20 | 3.8 / 18 | 5.0 / 11 | 120 / 14 |
| Austria-Hungary | 49 | 8 | 44 | 3.4 / 6 | 2.0 / 5 | 2.0 / 3 | 55 / 9 |
| British Empire | 11 | 60 | 186 | 0 / 34 | 15.0 / 38 | 0.5 / 6 | 38 / 55 |
| Italy | 36 | 12 | 38 | 2.6 / 4 | 3.0 / 0 | 1.5 / 0 | 47 / 15 |
| Ottoman Empire | 36 | 4 | 33 | 2.0 / 4 | 1.0 / 2 | 1.5 / 0 | 39 / 7 |
| Romania | 23 | 1 | 8 | 3.6 / 4 | 0.3 / 0 | 1.0 / 5 | 22 / 0 |
| Japan | 21 | 15 | 35 | 0.6 / 2 | 3.8 / 3 | 1.0 / 0 | 36 / 17 |
| Serbia | 11 | 0 | 8 | 0.8 / 0 | 0 / 0 | 0.5 / 0 | 12 / 1 |
| Bulgaria | 11 | 0 | 19 | 0 / 0 | 0 / 0 | 0.5 / 0 | 12 / 1 |
| Greece | 9 | 3 | 11 | 0.4 / 0 | 0.8 / 0 | 0.5 / 0 | 13 / 4 |
| Belgium | 7 | 0 | 23 | 0 / 0 | 0 / 4 | 0.5 / 0 | 8 / 1 |
| Montenegro | 4 | 0 | 8 | 0 / 0 | 0 / 0 | 0 / 0 | 4 / 0 |
| United States | 8 | 30 | 92 | 0 / 19 | 7.5 / 15 | 0.5 / 19 | 20 / 12 |

At their historical size every great power but Germany now feeds its army from its own regions; Germany runs a
little short of grain and oil, Italy and Japan of coal, France and the Ottomans of oil: the shortages they really
had, and reasons to trade or to take the Ploiești oilfields. A small nation like Serbia or Greece keeps most of its
army fed by its towns and runs a deficit under one grain a turn, which its 20 starting grain covers for twenty
turns or more, or a trade covers indefinitely. Divisions in the table are on mobilisation in 1914; a campaign
usually fields far fewer units, which makes upkeep lighter still.

Rules: `upkeepFree` (capital, city, village), `upkeepGrain`, `upkeepCoal`, `upkeepOil`. The analysis script is not
bundled; the inputs are the two bundled files above.
