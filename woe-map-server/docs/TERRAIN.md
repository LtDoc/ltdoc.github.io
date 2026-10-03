# Hills and mountains

The ground has three classes: **flat**, **hills** and **mountains**. They slow movement, keep tanks and artillery out
of the mountains (except by rail), favour the defender on higher ground, cut supply lines and block sight. The
campaign rule *Hills and mountains* (⚖ Rules → Movement) switches all of it off; the map still shows the relief.

## Where the ground comes from

**Earth maps** use a bundled elevation grid, `public/earth/terrain.bin.gz` (2.1 MB): 5400 × 2700 cells of 1/15°
(about 7.4 km at the equator, 1.5 map px on the usual 8192 px Earth), in the map's own equirectangular layout, so a
map point's cell is simply `(x / W · 5400, y / H · 2700)` at any map size. Each byte is the land's height,
0..255 = 0..6400 m; the sea is 0.

It comes from NASA's Blue Marble topography (*"Imagery by Jesse Allen, NASA's Earth Observatory, using data from the
General Bathymetric Chart of the Oceans (GEBCO) produced by the British Oceanographic Data Centre"*, public domain):
`gebco_08_rev_elev_5400x2700.tif` from
<https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/topography-bathymetry-maps>.
`node scripts/prepare-terrain.js gebco_08_rev_elev_5400x2700.tif` rebuilds the file.

`public/js/terrain.js` (shared by the server and the browser) classifies every cell by its height and its **local
relief** (the highest minus the lowest ground within two cells, about 35 km):

| Class | Rule (metres) |
|---|---|
| Mountains | height ≥ 2400, or relief ≥ 750 on ground above 700, or relief ≥ 1150 |
| Hills | height ≥ 1300, or relief ≥ 260 on ground above 150 |
| Flat | everything else |

A lone mountain cell among lower ground becomes hills, and a lone flat cell inside a range becomes hills. About half
the world's land is flat, a quarter hills, a quarter mountains (counting the ice sheets of Greenland and Antarctica).
The Alps, Pyrenees, Carpathians, Apennines, Dinaric Alps, Caucasus, Rockies, Sierra Nevada, Cascades and Andes are
mountains; the Ardennes, Vosges foothills, Massif Central, Appalachians and Scottish uplands mostly hills.

**Image maps** have no elevation. The GM paints the ground instead: in an area's dialog, *Ground* → Hills or
Mountains (while the game is running only the GM can set it). On an Earth map a painted area raises the ground too
(the higher class wins), for a ridge the grid is too coarse to show.

## Movement

Walking pays for the ground it crosses (`game.walkCost`, sampled every quarter map px, on top of No Man's Land):

| Unit | Flat | Hills | Mountains |
|---|---|---|---|
| Mountain Regiment (mountain troops) | 1× | 1× | 1× (*Mountain troops in mountains*) |
| Everyone else on foot, horse or wheels | 1× | 1.5× (*Hills cost*) | 4× (*Mountains cost*) |
| Tank Battalion and every Artillery unit | 1× | 1.5× | **cannot enter** |

Ships, aircraft and units aboard a convoy ignore the ground. Heroes walk like infantry.

- A tank or gun walking into mountains **stops where they begin**, keeping the movement it did not use ("stopped where
  the mountains begin"). Ordered straight into them it does not move at all.
- One that is already in the mountains (placed there, or left there by a train) may walk **out**, at the mountain
  cost, to a destination outside them; it cannot go deeper.
- A formation moves as one: if its guns stop at the mountains, the whole group stops there too.
- **Railways run through hills and mountains at their usual speed**, for every unit that can ride. The train is
  taken whenever it beats walking over the ground (`rails.plan` compares the trip with the terrain-weighted walk, not
  the straight distance), so a range with a railway over it is crossed by rail. The walks to and from the track pay
  for their ground; a tank or gun can only get off a train where the ground it walks to is open (it cannot detrain
  into the mountains).
- The move's note says what slowed it: "slowed by the hills and the mountains".

## Combat: higher ground

The defender gains the height of its ground over the attacker's (`terrain.heightBonus`, added to defend like trench
cover and shown in the combat line, e.g. "defender +2 on higher ground (mountains above flat)"):

| Attacker on | Defender on | Defender gets |
|---|---|---|
| Flat | Hills | +1 (*Higher ground: hills*) |
| Flat | Mountains | +2 (*Higher ground: mountains*) |
| Hills | Mountains | +1 (the difference) |
| Higher than the defender, or level | — | nothing (attacking downhill brings no bonus of its own) |

It counts for artillery firing from range too. Aircraft (attacking or attacked) and ships attacked at sea ignore it;
a ship bombarding the shore attacks from flat ground, so a battery on hills or cliffs gains it.

## Supply: mountains cut supply lines

Every supply link is a straight line (`supply.compute`): a place, column, railhead or convoy to a unit; a place,
railhead or convoy to a Supply Column; one column to the next. A line may cross at most **10 km of mountains**
(*Supply lines may cross mountains for*, about one grid cell, so a unit standing at the edge of a range is still
reached), or **50 km when it ends at mountain troops** (*… to mountain troops*), who can be supplied some way into
a range. Of the sources in reach, the nearest with a clear line counts. Hills do not cut supply.

**Railways carry supply through** regardless: open track connected to a friendly place supplies columns near any of
its railheads, on either side of a range, so a railway over a pass keeps the far side supplied. Without one, units
beyond a range are cut off unless a friendly place, column or convoy reaches them from their own side. (On the
Brenner: German units in the Po valley are out of supply from Munich until a railway runs over the pass.)

## Sight: mountains block it (fog of war)

With fog of war on, a side still sees all of its **own ground**. Elsewhere, an enemy in a province (or, on image
maps, a spot) in vision is seen only if **one of the sources bringing it into vision has a clear line to it**
(`terrain.lineOfSight`, used by `vision.inVision`):

- **Earth maps:** a mountain cell between the two (not the cells they stand in) that rises **above both** the
  observer's eye (30 m over its ground) and the target (10 m over its own) blocks the line. So a range hides what lies
  beyond its crest, below it, until the enemy climbs onto the slope facing the observer or the crest itself; a unit
  climbing towards the observer stays in view, and a hollow behind a nearer shoulder is hidden. (A ridge test rather
  than a true sightline: on 7 km cells a bulging slope would otherwise hide its own upper part.) Hills never block.
- **Painted Mountains:** a line crossing a painted range is blocked unless the observer or the target stands in it.
- **Aircraft and balloons** see over the mountains.

Fog stays drawn by province: a hidden valley inside a province you see shows no enemies rather than being shaded.
Enemies that slip behind a ridge leave a last-known-position ghost like any other. (Tested on the Pyrenees: from the
French foothills, units on the north slope and the crest are seen, the Spanish side below the crest is not.)

## How it looks

`public/js/relief.js` draws the ground over the land and the territory colours (so it reads whoever holds it) and
under towns, drawings and units. Less is more: only the shading and a few mountain clusters with trees at their
feet. **Hills have no drawing of their own** (their rules stand); they show only through the shading. Painted Hills
areas show only as the drawing itself.

- **Earth maps, every zoom:** a hillshade of the grid lit from the north-west (exaggerated 28×, heights smoothed over
  3 × 3 cells, a small dead zone so the plains stay calm): shadowed slopes darken, lit ones lighten a little. No
  tints or snow overlay. Built once per map in 900-cell tiles, sea-only tiles skipped, one tile per idle moment.
- **Close in** (fading in from 220 % to 300 % on the Earth, three times sooner on image maps): the user's mountain
  and tree sprites from `rob assets/Terrain Assets`, packed by `node scripts/build-terrain.js "rob assets/Terrain Assets"`
  into `public/assets/terrain.png`: `gl1`–`gl5` (snow-tipped), `p1`–`p5` (bare), each from a single peak to a
  broad cluster of peaks, and the trees `dl1`–`dl3`, `dp1`–`dp3` and the deciduous grove.
  - **Mountains:** candidate spots on a lattice fixed to the map (3 map px apart, jittered) are taken **highest
    ground first**. Each picks a sprite by height (single peaks low, broad clusters on the crests), snow-tipped where
    the snow lies (`snowAt`: the 3 × 3 average height above the snow line, which falls with latitude: about 4000 m at
    30°, 2900 m at 38°, 2100 m at 46°, 1450 m at 61°), bare below, drawn at its own width (the broadest 30 map px).
    A cluster that would spill well off the mountains steps down a size; a spot that would stand closer to a placed
    sprite than their mean width is skipped, and a third of the low spots are dropped. So a range gets a few
    clusters along its spine with gaps between, not a carpet.
  - **Trees** stand round the foot of the ranges: ground below 1400 m with mountains within about 20 km (fewer in the
    dry subtropics, 14°–36°), sparse stands, mostly the bigger ones, kept clear of the mountain sprites, so the
    ranges meet the plain.
  - Nearer sprites (lower on the screen) are drawn in front. Built per 64 px chunk (with a margin so neighbouring
    chunks agree), ten new chunks a frame at most, a few hundred kept. On image maps sizes, spacing and chunks are
    three times larger. Painted Mountains areas have no heights, so the depth inside the area stands in for one: its
    spine takes the broad snow-tipped clusters, its edge band the trees.
