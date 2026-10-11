# Railways

Railways are a drawing kind: the GM lays them like lines, trains run along them, land units and heroes move
several times faster on them, and units can attack sections to close them. Built 30 Sep 2026.

- Network maths (joins, cuts, routes, reach), shared by browser and server: `public/js/railnet.js`
- Server rules: `server/rails.js`; movement in `server/game.js` (`checkMove`); sabotage and repair in
  `server/routes/game.js` (`POST /api/lobbies/:id/game/rail/cut`, `/rail/repair`)
- Drawing, trains and smoke: `public/js/rail.js`; art from the user's sheet `rob assets/Trains.png`, copied to
  `public/assets/trains.png`

## Laying track

The 🛤 button (or **R**) draws a railway: click points or drag freehand; double-click, Enter or Done to finish.
The line is simplified and its corners lightly rounded when you finish. Clicks within 14 px of existing track
snap onto it (a vertex first, else the nearest point on the line), so a branch that starts or ends on another
line is joined to it. When a railway is saved, an end within **Join line ends within** (20 km) of other track is
snapped onto it (another line's end if one is that close, else the nearest point on the line). The network joins
lines the same way even where the drawing was not snapped: a line's end within 20 km of other track, an inner
point within 5 km, and **wherever two lines cross**, vertex or not. (Before 1 Oct 2026 only vertices within 5 km
joined, so lines that crossed, or ended a little short, carried no through traffic.) **Extend** in the railway's popup adds track at its end. Points can be dragged like any drawing.

While the game is running players **plan** railways: the 🛤 tool draws a planned line (a dashed survey line with
its sleepers pegged out, "(planned)" after its name) that carries no traffic. **Engineers, pioneers and railway
troops** within 20 km of a planned line of their side can be ordered to **🛤 Lay track** (their panel): at End turn
they lay the **15 km** of it nearest them, for **5 iron and 5 timber** from their nation (⚖ Rules → Railways →
Building). The section becomes track whose ends meet the track already laid, so the network joins it up; the rest
stays planned. The order lasts the turn, like digging a trench. A player can redraw or remove their own plans; built
track is the GM's to change, as is everything while the game runs. Outside game mode anyone may draw railways. A
**GM only** railway is a plan too: drawn for the GM, carrying no traffic.

Railways also carry goods: a nation's towns on one stretch of open track share their stores however far apart they
are (docs/ECONOMY.md, Goods and unrest).

## Look

The track is a ribbon textured with the straight-track tile from the sheet (25 × 16 px, one seamless period of
sleepers), 2.5–24 px wide on screen (its natural size at deep zoom); zoomed far out it fades to a plain dark
line with pale rails. Trains (engine, coal tender, 1–3 wagons from the sheet's top-down cars) run back and forth
on each open stretch, about one per 250 km, as wide as the track; at the end of the line or a cut they wait,
the engine runs round, and they head back. On short stretches wagons are left behind so the train fits.
Trains appear once the track is 8 px wide and sleep when the line is off screen. A cut section is drawn
torn up and scorched, with the existing burning sprite over the point that was hit.

## Moving by rail (game mode)

A land unit (infantry, mounted, artillery, support, or a custom type) or a hero moving in game mode takes the
railway whenever that is cheaper than going straight: it walks to the nearest open track, rides, and walks off.
Distance on track costs **1 / Speed on rails** (4, so 4× movement); walking costs as usual. The move spends the
cheaper of the two; if the allowance runs out on the way, the unit stops along the route. Ships and aircraft do
not use railways.

Track is **open** to a nation when it is not cut and the ground under it belongs to that nation, an ally, no one
(neutral or unclaimed land), or no land at all (bridges and ferries). Another power's railways are closed to it,
at peace or at war, so captured provinces bring their railways with them.

Selecting a unit shows its movement ring plus the track it can still reach this turn, in green; clicking on that track sends it by rail. The move
toast says "went by rail (N km of track)". A formation moved together follows each unit's own route.

**The trip on the map.** Everyone watching sees the unit walk to the track and board a train in its colours, named
after it ("🚂 4e Infantry Regiment"); the train runs along the line, and the unit gets off and walks on to where it
was sent (a few seconds, whatever the distance; `data.ride` on the unit, `MapRenderer.playRide`). A rail trip
draws **no movement line**: the unit's trail for the turn starts again where it got off, instead of tracing the
track across the map.

## Attacking a railway

**⛓ Cut railway…** in a unit's panel lists railway sections within its reach: for each line, the nearest
open section on the ground of a power it is at war with ("Cut"), and the nearest section of its own side's
track ("Blow up"). Neutral ground and powers you are at peace with are off limits (the GM is exempt).

- **Cut**: d20 + the unit's attack (with tech and a covering general) against d20 + **Line's defence** (4) + the
  defend of the holder's strongest land unit within **Guards within** (30 km). Higher wins; ties hold.
- **Blow up** your own track: no roll (scorched earth when retreating).
- Either way the attack uses the unit's action for the turn, like combat, and no one loses strength.
- A cut closes **Cut closes (each side)** (10 km) of track either side of the point hit: 20 km of line.

## Repairs

A cut stays until it is repaired. The railway's popup lists each cut ("💥 Cut 55 km from Strasbourg · turn 3 ·
by France") with **Show** and, when you can, **🛠 Repair**:

- The GM repairs any cut.
- Select an **Engineer**, **Pioneer** or **Railway troops** unit and choose **🛠 Repair railway…** to pick a nearby
  broken link. The railway popup's **Repair** button also selects the nearest available engineering crew.
- The crew must be alive, not surrendered, ashore and within **Repair within** (30 km). The ground must be
  theirs, an ally's or no one's. Each repair uses one action point and reopens that break immediately; other cuts remain.

## Campaign rules (⚖ Rules → Railways)

Speed on rails (4×) · cut closes (10 km each side) · line's defence (4) · guards within (30 km) · repair within
(30 km) · join line ends within (20 km; crossings always join).

## Notes

- Cuts are stored on the railway drawing (`data.cuts`: point, turn, nation), so History shows and reverts them.
  Undoing a turn does not restore railways.
- A unit's popup does not yet preview rail trips; the drag preview and the move toast cover it.
- Hidden (Visible to) railways still carry traffic for everyone; only GM-only railways are excluded.
