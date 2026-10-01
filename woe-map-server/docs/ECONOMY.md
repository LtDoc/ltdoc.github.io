# Long-term economic growth

Built 30 Sep 2026. Three slow ways for a nation to grow its income without touching its army, meant to pay
back over many turns rather than cover this month's spending:

1. **Factory upgrades**: raise a factory's industry level, 1 → 5.
2. **Town development**: raise a town's development level (capital 5, city 4, village 2).
3. **The Economy research branch**: late, expensive techs with small compounding gains and cheaper projects.

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
