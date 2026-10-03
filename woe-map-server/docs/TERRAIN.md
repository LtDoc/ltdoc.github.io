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
