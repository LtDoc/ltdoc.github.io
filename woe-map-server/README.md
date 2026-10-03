# WoE Strategy Map (self-hosted)

A ground-up rebuild of the old `WoE-Player-Map` GitHub Pages page as a real server application
you run yourself on Windows Server. Everything lives on your machine: accounts, campaigns, markers,
drawings, history, uploaded map images. No Firebase, no cloud, no build step.

It is a shared position tracker for a tabletop world, not a strategy game: the GM and players move
units, towns and player tokens on a map, draw lines and areas, roll dice, resolve the odd fight, and
everyone sees it live.

What changed compared with the old page:

| Old page | This server |
| --- | --- |
| Admin = your public IP hardcoded in the HTML | Real accounts with scrypt-hashed passwords, site admin + per-campaign GM/player roles |
| One shared Firebase database for everyone | Campaigns (lobbies) with join codes; each has its own map, members, markers, drawings and log |
| Firebase rules were the only real security; anyone could write | Every write goes through the server, which checks the session and role |
| "Admin Only" flag stored but never enforced | GM-only and nation-restricted markers are never sent to people who may not see them |
| No record of who changed what | Full change history with one-click revert and restore |
| Leaflet DOM markers | PixiJS WebGL renderer with animated units (spawn pop, movement tweens, trails, idle bob, hit shake, selection pulse) |
| Measure tool that reported nonsense | Pixel-accurate measure tool scaled by a per-campaign "units per pixel" setting |
| No drawing | Lines and areas with labels, colours and the same visibility rules as markers |
| Edits by others required a page reload in places | WebSocket push: markers, drawings, live drag previews, presence, chat, history, membership |

## Requirements

- Windows Server 2016+ (or Windows 10/11) with **Node.js 22.13 or newer** (24 LTS recommended). The
  built-in `node:sqlite` module is used for storage, so there are no native add-ons to compile.
- A browser with WebGL (every modern browser). Chrome, Edge and Firefox are all fine.

## Quick start (console)

```bat
cd woe-map-server
npm install
start.cmd
```

Then open <http://localhost:8080/>. **The first account you create becomes the site admin.**
Create a campaign, open its settings (⚙) and upload the map image. Share the join code with players.

There is no build step: `start.cmd` and the service run the code in this folder as it is, so after pulling
or switching branches just restart the server. The console prints the build at start-up ("Build 45224595
(woe-map-server)", with a **+** when there are uncommitted changes), the campaigns page shows it at the bottom
and the map's settings dialog next to its title. Every script and stylesheet URL carries that build, so
browsers fetch the new code after a restart instead of running a cached copy.

## Run as a Windows service

Open an elevated PowerShell in the project folder:

```powershell
.\scripts\install-service.ps1 -Port 8080
```

If [NSSM](https://nssm.cc) is on the PATH it installs a proper service named `WoEStrategyMap` with log
rotation in `logs\`. Otherwise it registers a scheduled task that starts at boot as SYSTEM and restarts on
failure. Either way it opens the port in Windows Firewall. Remove it with `.\scripts\uninstall-service.ps1`.

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listening port |
| `HOST` | `0.0.0.0` | Bind address |
| `WOE_DATA_DIR` | `.\data` | Where `woe.db`, `uploads\` and `backups\` live |
| `WOE_SESSION_DAYS` | `14` | Sign-in lifetime |
| `WOE_MAX_UPLOAD_MB` | `50` | Max map/icon upload size (the browser shrinks maps before upload anyway) |
| `WOE_SECURE_COOKIES` | unset | Set to `1` when serving over HTTPS |
| `WOE_BACKUP_HOURS` | `24` | Automatic backup interval; `0` disables |
| `WOE_BACKUP_KEEP` | `14` | Number of database snapshots to keep |
| `WOE_BACKUP_DIR` | `.\data\backups` | Where snapshots go; point it at another drive or a synced folder |

### HTTPS

The server speaks plain HTTP. For internet exposure put it behind a reverse proxy that terminates TLS
(IIS with ARR + URL Rewrite, Caddy, or nginx) and forward `/ws` as a WebSocket. Then set
`WOE_SECURE_COOKIES=1`. On a LAN plain HTTP is fine.

### Backups

The server writes a consistent SQLite snapshot (`VACUUM INTO`) every `WOE_BACKUP_HOURS` hours into the backup
folder and mirrors any new upload files next to it, keeping the newest `WOE_BACKUP_KEEP` snapshots. To take one
on demand, or from Task Scheduler to an off-box location:

```bat
node scripts\backup.js D:\Backups\woe
```

To restore, stop the service, copy a snapshot over `data\woe.db` (delete any `woe.db-wal` and `woe.db-shm`
next to it) and copy `backups\uploads\*` back into `data\uploads\`.

## Admin tasks

- **Reset a lost admin password:** `node scripts/create-admin.js <username> <newpassword>` creates the user as a
  site admin, or promotes an existing user and sets the password.
- **Manage users:** site admins see a user list on the campaigns page (promote, reset password, delete).
- **Import the old Firebase data:** export the database (or a node of it) from the Firebase console as JSON,
  then `node scripts/import-firebase.js export.json <lobbyId>`. It imports every section it finds, or only
  the ones you name: `--markers` (the old WoE-Player-Map; upload the map image to the campaign first so the
  height is known, or pass `--height N`; army markers become units and `lat` is flipped to top-left pixel
  coordinates), `--tree` (the techtree page's `research_tree`: trees → branches → techs with year, RP cost,
  money cost, description and prerequisites become techs in the campaign's tree, branch "Tree: Branch";
  `--replace-tree` wipes the current tree first; imported techs have no effects until the GM adds them in the
  tree editor) and `--nations` (the techtree page's `nations`: a faction per nation, created if missing, its
  banked RP, its RP per week as a per-turn modifier, and its unlocked techs).
- **Reclaim disk:** icon files are kept when a marker is edited or deleted so History can restore them.
  `node scripts/cleanup-uploads.js --dry-run` lists files no marker, map or recent history entry references;
  drop `--dry-run` to delete them (`--history-days N` sets how far back history counts, default 90).

## Features

### The screen
The map fills the screen. A menu down the left (keys `1`–`0`) opens panels over it: 🏛 Nation, 🏭 Production,
🔬 Research and 🤝 Diplomacy in game mode, then 🗺 Map (every marker, with search), ➕ Place, 👥 People, 📜 Log and
🕘 History, and for the GM 👑 GM (turn, nations, world) and ⚖ Rules. In game mode a nation bar above the map shows
the nation's money, manpower, research and stockpiles with their change per turn, and the turn button (End turn
for the GM, Ready up for players) sits bottom right beside 💬 Chat. Map tools are bottom left; the selected
unit's or place's card docks above them. Every setting and game rule is in one window (⚙). Details:
`docs/UI.md`.

### Factions and flags

A GM defines factions from the 👥 People panel: a name, a colour and a flag, chosen from the bundled set in
`public/flags/` (drop more image files in that folder and they appear) or uploaded (PNG, JPEG, WebP or GIF, 5 MB
max). Members are assigned to a faction from their row, and units and towns pick one in their form (a custom
free-text nation is still allowed). Every token then shows a small flag above it: units and towns use their own
faction, player tokens use their owner's. Renaming a faction renames it on every member and marker, so
nation-restricted visibility keeps working. The faction colour is only a default for new counters; the flag is
what identifies the side on the map.

### Roles and visibility

- **Site admin**: first registered account. Can manage users and is GM in every campaign.
- **GM** (per campaign): the campaign owner plus anyone promoted. Full control of markers, drawings, members, map, settings.
- **Player**: can place and move their own player marker, move any marker a GM assigned to them as owner
  (e.g. their nation's armies), draw lines and areas, chat, roll and attack with units they own.

Every marker and drawing has two visibility controls, set by the GM:

- **GM only** hides it from all players.
- **Visible to nations** limits it to players whose membership nation is listed (the GM sets each
  member's nation from the 👥 People panel). The owner of a marker always sees it.

The server applies these rules to the initial load, every WebSocket push, live drag previews, history entries and
combat reports, so a restricted item never reaches a browser that may not show it.

**Fog of war** (game mode rule, off by default; ⚖ Rules → Fog of war). Players see other nations' units and heroes
only within sight of their own units, places and ground; allies share sight, and territory, towns and resources
stay public. On the Earth map sight goes by province, on uploaded maps by distance; ranges are a table by unit type
(infantry 50 km, cavalry 80, reconnaissance 120, artillery 30, aircraft 150, places 30–100…). The server never sends
a unit out of sight, so nothing can be read from the browser. Out-of-sight land is shaded, enemy units that slip
out of view leave a faded "seen turn N" marker where they were last seen, an attacker is revealed to the side it
attacks until End turn, and battles are news only to the two sides. Details: `docs/FOG-OF-WAR.md`.

**View as player (GM).** The 👁 button in the top bar lets a GM use a tab as one nation's player: they see only
what that player sees (the same markers, treasuries, diplomacy, trades and log) and play by the player rules (moves
limited by movement and supply, attacks by action points and range, no GM panels or End turn). They command that
nation's units and heroes, not everything they created. The tab shows a gold frame and "Viewing as …"; 👁 → *Game
master view* switches back. It is per tab (`?as=<faction id>` in the address), so another tab can stay in the GM
view. Details: `docs/UI.md`.

### Marker types

- **Quick add (GM)**: the ➕ Place panel opens on a faction picker and a grid of every unit type drawn as a counter in
  that faction's colour. Click a type, then click the map wherever you want the unit; keep clicking to drop
  more, press Esc (or Cancel on the HUD, or click the type again) to stop. While placing, existing tokens and
  drawings ignore clicks, so a unit can be dropped right next to (or on top of) another one; the same holds for
  resource nodes, factories and the territory brush. Each unit is named by its type's
  formation and numbered per faction and formation: "1st Infantry Regiment", "2nd Infantry Regiment",
  "1st Assault Regiment", "1st Cavalry Regiment", "1st Field Artillery Battery", "1st Fighter Squadron"…
  The ordinal style comes from keywords in the faction name (`public/js/naming.js`): French, Belgian and
  Dutch factions count 1e, 2e, 3e; German, Austrian, Hungarian, Scandinavian, Polish, Czech, Serbian and
  Turkish ones 1., 2., 3.; Italian, Spanish and Portuguese 1ª, 2ª; Russian and Bulgarian 1-я; Greek 1η;
  Romanian 1-a; Japanese and Chinese 第1; everything else 1st, 2nd, 3rd. The server assigns the number from
  the units that exist, skipping past the highest one already used, so renaming or deleting units never
  produces duplicates. Stats come from the campaign's stat table and the colour from the faction. Rename or
  edit any unit later from its popup. Blank names in the custom form get the same treatment.
- **Custom marker**: below the grid, a collapsed form for towns, points of interest, scenery, players and
  units that need a specific icon, name or stats. Stats and visibility/ownership sit in collapsible sections;
  the icon row offers a sprite picker, an upload button and an image URL.
- **Unit / army**: drawn as a NATO-style counter in the nation colour with a symbol for the unit type and a
  strength bar. Fields: nation, unit type, attack, defend, action points, range, movement, strength %, abilities, notes.
  The unit type picker offers a WW1-era catalogue of 53 types in six groups (infantry, mounted & mobile,
  artillery, support, air, naval), each with its own drawn symbol: infantry cross, cavalry slash, armour oval,
  artillery dot and heavy ring, railway gun, mortar and machine-gun arrows, anti-aircraft arc, HQ flag,
  engineers E, signals zigzag, supply bar, medical cross, gas cloud, aircraft bow-tie, balloon, airship, and
  ship silhouettes for battleships, cruisers, destroyers, torpedo boats, submarines, minelayers, gunboats and
  transports. Variants carry a small corner tag (ST, MTN, BC, …). A "key" link beside the picker renders the whole
  catalogue in the chosen colour. Free-text types still work: known words map onto a symbol, anything else shows
  a short abbreviation. The catalogue lives in `public/js/units.js` and is easy to extend.
- **Default unit stats**: picking a type fills attack, defend, action points, range and movement from the
  campaign's stat table, so placing a unit is usually a name and a click. After a unit is placed the form
  keeps the faction, type and stats, ready for the next one. A "defaults" link beside Attack refills the
  numbers if you have changed them; custom free-text types are left alone. Attack and defend are d20
  modifiers: 0–1 very weak, 2–3 weak, 4–5 mid, 6–7 strong, 8–9 very strong, 10 extreme. The catalogue
  baseline follows the brief that infantry are mid/mid (4/4), cavalry very strong attack but very weak
  defence (8/1), marines mid attack and very strong defence (4/8), stormtroopers extreme attack and very
  weak defence (10/1) and conscripts very weak attack with mid defence (1/4), extrapolated across the rest:
  machine-gun companies defend at 9, heavy and siege guns hit at 8–10 with range 4, tanks are 8/7 but move
  1, dreadnoughts 10/9, transports 0/1, and so on (the full table is the `stats` column in `units.js`).
- **Per-campaign stat table**: a GM can change any of those numbers for one campaign with the **Unit stats**
  button beside the campaign on the campaigns page, or the "Unit stats table…" button in campaign settings
  on the map. Every type gets a row with **+ / −** steppers (Shift-click steps by 5) and a typeable field;
  changed cells are highlighted with the catalogue value in their tooltip, each row has a reset arrow, and
  "Reset all" returns to the catalogue. Only the differences are stored (in the campaign settings as
  `unitStats`), so catalogue improvements still flow through to untouched types. Changing the table never
  edits units already on the map; it only changes what new units start with. Stats also appear in the type
  dropdown and the symbol key.
- **Town**: capital (star), city, village. **POI**: diamond. **Player**: circle with initial.
- **Towns on the ground.** Under each town's counter the town itself is drawn from above at map scale, grown
  procedurally from its name (`public/js/towns.js`), so it always looks the same: main roads out of the centre,
  bending as they go, ring boulevards, a dense web of side streets and lanes, houses packed several rows deep in the
  old centre and thinning out along the roads, a square and a cathedral or church, parks, and a patchwork of hedged
  fields, woods and farms round it, spreading out unevenly (furthest along the roads) rather than in a ring. Towns keep to the land: their streets stop at
  the coast and at lakeshores (the vector Earth's lakes count as water, though the provinces cover them), and the
  lakes are drawn again over the territory colours so they read as water whoever holds the shore. Capitals are very large (about 20 map px across), cities large (10), villages
  small (3) in the middle of their fields. Shown from 150 % zoom, in full detail from 500 %. Shelled towns show the
  damage: houses near a crater are burnt-out shells or rubble, and this turn's hits set them burning, with flames
  and tall smoke columns.
- Any marker can use an uploaded image or external URL as its icon instead. Prefer uploads: an external
  image host must send CORS headers for WebGL to use it, and when it does not the marker silently falls back
  to the drawn sprite. Uploaded icons are shrunk to 256 px in the browser first.

### Pixel-art sprites and scenery

`public/sprites/` holds the pixel-art sheets (tanks, ships, submarines, guns, soldiers, trenches, ruins, craters,
buildings, equipment) cut into a 3,000-sprite atlas by `scripts/extract-sprites.js`. The extractor needs no fixed
grid: it finds every connected blob of opaque pixels, attaches small detached fragments (wheels, barrels) to the
sprite they belong to, and additionally cuts tile-based blobs such as trench networks into 96 px cells. Re-run it
on a folder of sheets to rebuild the atlas: `node scripts/extract-sprites.js "path/to/sheets"`.

Any marker's icon can be a sprite: press **Pick sprite…** in the Add or Edit form, browse by category and sheet,
click one. It is drawn as-is (no plate) with the faction flag above it; units keep a thin strength bar beneath.
Aircraft gently float and ships ride a swell; ground units sit still. Icon uploads are capped at 5 MB.

**Token sizing** (campaign settings): by default tokens are map objects about 27 map pixels wide, so they shrink
as you zoom out and grow as you zoom in, clamped between roughly 9 and 59 screen pixels so they never vanish or
turn into giants. The map zooms in to 32×, well past the point where tokens stop growing, so a crowded front
can be spread out until every unit is clear. Labels keep a constant text size and appear once a token is about 24 px or larger (hovered or
selected tokens always show theirs). Where names would overlap, only one shows: units win over towns and
other markers, a name already showing keeps its place so labels do not flicker while you pan, and hovering or
selecting a token always brings its name back. The old behaviour, a fixed pixel size at every zoom, is available as
"Fixed size on screen". **Token size** multiplies either mode.

**Scenery** is a GM-only marker type for buildings, trenches, craters, wrecks and other dressing. Unlike counters it
is drawn at map scale, so it grows and shrinks with the zoom; it has a scale (map px per sprite px), a rotation and
a flip, sits in a layer under drawings and units, shows its name only when hovered or selected, and can be dragged
like anything else. Scenery obeys the same visibility rules as markers, so a GM can also hide a fortification from
players.

### Selecting, moving and locking

- **Group select:** the ⬚ tool (or `S`) turns a drag on empty map into a selection box; Shift-drag does the same
  at any time, and Shift-click adds or removes a single token. Drag any selected token and the whole group moves
  by the same offset, so a line of units keeps its shape. Group moves are saved in one request and recorded as
  one history entry per token. `Delete` removes the whole selection after a confirmation.
- **Locking:** every token and drawing has a lock. A locked item lets clicks and drags pass straight through it,
  so borders, areas, trenches and towns no longer get in the way of moving units. Towns, POIs and scenery are
  locked when placed; units and players are not. Lock or unlock from the popup, from the Locked checkbox in the
  form, or with the "lock all / unlock all" links on the Towns, Scenery and Drawings sections of the 🗺 Map panel. A
  locked item can still be selected from the Map panel list to reach its popup. The server refuses to move or
  reshape a locked item unless the same request unlocks it.

### Drawings

The 〰 and ▱ buttons (or `L` / `A`) start a line or area. Click points, then double-click, press Enter or hit Done.
A dialog asks for a label, colour, width and (for GMs) visibility. Drawings show in the Markers tab, can be
selected on the map, edited, deleted and reverted like markers. Popups show a line's length or an area's perimeter.

Editing a drawing you own (or any, as GM) is direct manipulation on the map, built for borders and front lines:

- select it and drag any vertex handle;
- grab the line anywhere between two vertices and drag: a new vertex is pulled out of that spot;
- right-click (or Alt-click) a vertex to remove it;
- **Move** in the popup, or Shift-drag, moves the whole drawing;
- **Continue** on a line keeps adding points at its end.

Each release saves and records one "reshaped" history entry, so an overzealous edit is one revert away.

**No Man's Land.** Tick *No Man's Land* in an area's dialog (while the game is running only the GM can) and the area
becomes the ground between the lines (`public/js/nomansland.js`): churned mud and standing water at every zoom, shell
holes from 250 %, belts of barbed wire along its length (broken by gaps) from 300 %, coils on pickets from 600 %, and
the dead of earlier fighting, men of the campaign's armies and here and there a horse and rider, from 800 %. All of
it is generated from the area's shape, the same in every browser. Walking across it costs **3×** the distance
inside (⚖ Rules → Movement → *No Man's Land movement cost*); a move cut short says so, and the popup shows the cost.
Rail trips are not slowed.

### Trenches

The ⌇ toolbar button (or **T**) digs a trench: click points like a line, or press and drag to draw freehand.
When you finish, the pointer samples are simplified (Ramer–Douglas–Peucker), smoothed (one Chaikin pass) and,
unless you untick it, long straights get **traverses** so the line reads as a fire trench. A trench is a
drawing of kind `trench`: its **centreline** is the object the game uses (occupancy, editing, history, the
Extend button, vertex dragging from the popup all work on it); the look is derived from it and never the other
way round. Fields: width in the campaign's units (km on the Earth map; default 0.5), build **state** and
which side is the **rear**. The real width is honoured when you zoom in close; zoomed out, a trench never
drops below about 10 screen pixels so the line stays readable (that minimum is a vertex-shader uniform, so
zooming never rebuilds a mesh).

Trenches also play: a trench **belongs to the faction whose territory most of its centreline lies in**
(recomputed whenever borders move, with the ownership of towns and nodes), and a unit attacked while within
the **cover range** (20 km) of a dug or reinforced trench of its own faction (or of an unowned trench) adds the
trench's **cover bonus** to its defend roll: +2 dug, +4 reinforced, planned trenches give nothing. The combat
log shows the bonus, the unit's popup shows the cover it currently enjoys, and the range and bonuses are
campaign rules (⚖ Rules → Trenches). An enemy's trench never shelters you.

Rendering (`public/js/trench.js`) is a triangulated ribbon, not a line: each centreline point becomes a
left/right vertex pair at ±half-width (slightly varied along the path) on a mitred normal, sharp corners are
capped so they do not spike, and the ends are rounded in the shader. One shared GLSL program draws three
ribbons per trench: a soft drop shadow, the dirt ribbon and, offset to the rear, a narrower broken **spoil**
ribbon. The dirt look is a seamless value-noise texture tiled along the trench and across it, darkened to a
wet floor down the middle and lightened at the lips, with noise nibbling the edges. **Planned** trenches draw
as a pale dashed engineer line; **dug** ones get the full ribbon; **reinforced** ones have darker, timbered
lips and sandbag props along the rear lip. Zoomed far out, texture detail and spoil fade to a dark stroke with
a light rim. Where a trench's end meets another trench a sandbag node marks the junction. Meshes are rebuilt
only when the centreline, width or facing change.

### The Earth as a map

Campaign settings offer **Use Earth map** as an alternative to uploading an image. It draws the planet from
Natural Earth 1:50m data (public domain, bundled in `public/earth/`, about 540 KB gzipped for the whole world) in an
equirectangular projection: coastlines, lakes, rivers, optional present-day country borders and a
latitude/longitude grid, in an atlas, parchment or dark style. Everything is vector, so it stays sharp at any
zoom, and the detail setting only changes how many pixels a degree gets (marker precision), not the file size.
On an Earth map the measure tool and the combat target list report true great-circle kilometres.

**Historical borders.** The Borders choice offers none, present day, or the political map of 1880, 1900, 1914,
1920 or 1938. Historical states come from the
[historical-basemaps](https://github.com/aourednik/historical-basemaps) project by André Ourednik (bundled as
`public/earth/world_<year>.json.gz`, about 150 KB each); each state carries its name and the power it belonged to,
so colonies are tinted to match their empire and labelled "Nigeria (United Kingdom of Great Britain and Ireland)".
Country names appear once a state is large enough on screen. Tinting and labels can each be switched off. The
data's border precision varies by region; it is a good game map, not a legal atlas.

**Seeding factions from history.** The 👥 People panel has **Seed from history…**: pick a year, and every sovereign
power of that year is listed with a suggested colour and, where a bundled flag's name matches (British Empire,
German Empire, Austro-Hungarian Empire, Russia, Italy, United States, Canada, Mexico …), its flag. Tick the ones
you want and they become factions; existing names are skipped. Add your own flags to `public/flags/` named after
the power (e.g. `OttomanEmpire.png`, `France.png`) and they match automatically.

**Editable borders.** Campaign settings → Editable borders converts a year's borders into locked area drawings,
one per country (largest pieces only, simplified to 800 points), for the whole world or just the countries in the
current view. They are named and tinted like the drawn layer, which is hidden afterwards so the two do not overlap.
Unlock a country from its popup and reshape it like any drawing: drag vertices, grab the line to add one,
right-click to remove one, Move to shift it. Every change is in History.

`scripts/prepare-earth.js` rebuilds the bundle: give it a folder holding the Natural Earth GeoJSON files and any
`world_<year>.geojson` files from historical-basemaps (it has years from 123,000 BC to 2010) and every year found
appears in the Borders list.

**Hills and mountains** ([docs/TERRAIN.md](docs/TERRAIN.md)). The Earth map knows its relief from NASA's Blue Marble
elevation grid (`public/earth/terrain.bin.gz`, 2.1 MB, public domain): every 7 km cell is flat, hills or mountains.
Walking across hills costs 1.5× the distance and mountains 4× (⚖ Rules → Movement); Mountain Regiments cross both at
full pace. Tank Battalions and artillery cannot enter mountains at all: they stop where the mountains begin, and cross
a range only by **rail**, which runs through hills and mountains at its usual speed for everyone. On image maps the
GM paints the ground: an area's dialog has *Ground* → Hills or Mountains. The map shows the relief: shaded slopes and
snow-capped ranges at every zoom (the Alps, Rockies and Sierra Nevada are white-topped), and from 250 % drawn peaks
over the mountains and rounded mounds over the hills.

### History and revert

Every create, edit, move and delete of a marker or drawing is recorded with its full before/after state. The
History tab lists them newest first; a marker's popup has a History button that filters to that one item.
GMs can revert any entry, players their own. Reverting a move puts it back, reverting an edit restores the old
fields, "Remove" undoes a placement and "Restore" brings a deleted item back with the same id. A revert is itself
a history entry, so it can be reverted too.

### Game mode (turns and economy)

Off by default: a campaign is the plain map tracker described above. A GM switches it on from the **Game**
tab (pick a start date; the 1914 scenario uses 28 July 1914) and the campaign gains turns, treasuries,
movement limits and action points. Switching it off pauses all of that and keeps the treasuries. The full
design is in `docs/GAME-DESIGN.md`.

- **Turns.** Weekly by default (fortnight, month and season are options). The turn widget (bottom right) shows the turn,
  the game date and the deadline. Everyone acts during the turn; the GM presses **End turn** there, which
  pays income, resets every unit's movement and action points, advances the date and posts a private turn
  summary to each faction (and the GM). **Undo last turn** restores treasuries and the calendar from a
  snapshot taken before the resolution (the last five are kept); units stay where they are.
- **Deadlines.** The GM picks a real-world date and time on the 👑 GM panel's Turn page (or "1 day / 3 days / 7 days" from
  now). The turn widget counts down ("ends in 46h 12m", red once it has passed), the campaign log gets a reminder
  24 hours before and another when the deadline passes (with a chime and desktop notification for anyone
  who has them on), and nothing is forced: the turn still ends only when the GM presses End turn, which also
  clears the deadline.
- **Turn reports.** Ending a turn writes a report per faction: money, manpower and research points with
  their change, every stockpile's change and new level, where the income came from, places taken and lost
  (and from or to whom), builds completed, builds lost with a captured site, what is still in production,
  research completed and the active project's progress, and any shortage. The report opens for every
  player (their own) and the GM (every faction, in tabs) as soon as the turn ends, and can be reopened from
  the 🏛 Nation panel's **Turn report…** button or the GM panel's **Turn reports…**, with arrows to earlier turns
  (the last 60 are kept). Undoing a turn removes its reports.
- **Captured this turn.** A resource node, factory or town that changes hands is stamped with the turn and
  its previous owner. On the map it pulses a ring in its new owner's colour until the turn ends, the Nation
  tab lists what the faction took and lost this turn, and by default (rule switch) a place captured this
  turn yields nothing at End turn: it produces for its new owner from the next turn. Builds queued at a city
  by its previous owner are lost with the city, without refund.
- **Treasuries.** Each faction has stockpiles of the ten map resources (grain, coal, iron, oil, copper,
  rubber, nitrates, timber, cotton, horses) plus money, manpower and research points. New factions start
  with the campaign's starting stockpiles. The GM's **Edit treasuries…** table sets every number with +/-
  steppers (Shift for 10) and, on its second tab, per-turn modifiers added to a faction's income.
- **Income per turn** = base allowance + resource nodes the faction owns + towns in its colours (capital,
  city and village rates) + factories (rate × industry level) + the GM's modifiers − upkeep when enabled.
  The **Nation** tab shows each faction its stockpiles with the change it will receive, where the change
  comes from, its forces by category with how many have moved or attacked, and its last turn summary. The
  GM can view any faction from the same tab; players see only their own unless the GM makes treasuries
  public, in which case the 🏛 Nation panel adds an **All nations** table (money, manpower, RP, units) and
  players can read every faction's turn report.
- **Resource nodes** are markers (➕ Place panel: pick the resource and yield, choose the faction, click the map)
  drawn with the bundled painted icons in `public/icons/` inside a ring in the owner's colour; the ring
  colour and the owner follow the faction. **Factories** are markers with an industry level 1–5. Both are
  locked by default like towns. Ownership by territory arrives in phase 2; until then the GM sets it.
- **Movement.** A unit may move `movement × distance per movement point` per turn (50 km by default on the
  Earth map, map units elsewhere). Click a unit or hero to see a green ring of how far it may still go
  this turn, then right-click the map inside it to move there (players no longer drag units in game mode; the GM
still can).
  Each move leaves a trail in the unit's colour until End turn. A formation moves as one and is limited
  by its slowest unit. Units that have moved carry an amber dot (red when their allowance is spent). The GM
  is never limited, and a rule switch waives the limits for everyone.
- **Attack reach.** A unit's range stat times the campaign's *attack reach per range point* (50 km by
  default) is how far it can strike: infantry (range 1) 50 km, cavalry (2) 100 km, field artillery (3)
  150 km, heavy artillery (4) 200 km, aircraft and battleships further. The attack picker lists only enemy
  units within reach, sorted by distance, and the server refuses anything further. Tech bonuses to range
  count; the GM and the waive switch are not limited.
- **Action points.** Attacking costs one AP; a unit with none left cannot attack until the next turn. A unit
  that has attacked (a unit, or a railway) cannot move again until the next turn, so move first, then attack. The
  GM and the waive switch are not limited.
  Players cannot edit their units' stats, type or faction while game mode is on.
- **Upkeep** is built in but off: when enabled every unit costs grain per turn and vehicles, aircraft and
  ships cost oil; a faction that runs out has its three strongest units lose 10 % strength.
- **Rules** (⚖ Rules window): distance per movement point, waive limits, base money/RP/manpower, city and factory
  income rates, upkeep, starting stockpiles, public treasuries, the capture radius and city district (30 km
  and 75 km by default, so a single unit takes about one province and a city its immediate neighbours),
  whether units may occupy neutral ground, and whether captured places yield nothing the turn they change hands.

### Production, cities and resources (game mode)

- **Costs.** Every unit type has a cost in resources, money and manpower and a build time in turns
  (`GameData.DEFAULT_COSTS`): an Infantry Regiment is 10 grain, 5 cotton, 20 money and 3 manpower in one
  turn; a Tank Battalion 15 iron, 10 coal, 5 oil, 5 rubber, 80 money and 2 manpower in two; a Battleship
  40 iron, 30 coal, 10 copper and 200 money in six. The GM's **Unit costs…** table (👑 GM panel → Nations) changes any of
  it per campaign with +/- steppers; only differences are stored.
- **Sites.** A faction builds at the cities and capitals in its colours (capacity: capital 3, city 2
  parallel builds; villages build nothing) and at its factories (capacity = industry level). Ships need a
  **coastal** city (sea within 30 km on the Earth map); aircraft need a site of industry 2 or more. Cost is
  paid when a build is queued and refunded if it is cancelled. Work starts at the End turn of the turn a build
  was ordered in (the queue says "starts at End turn" until then), and each End turn after that takes one turn
  off: a 1-turn Infantry Regiment ordered in turn 3 stands at the start of turn 5. Finished
  units appear beside their site with the usual numbered name and the faction's stats, owned by the
  faction's player. The 🏭 Production panel lists every site with its queue, a **Build…** picker that shows each
  type's cost and why it cannot be built if it cannot, and a cancel button per item.
- **Factories.** A player may **build a factory** within 50 km of one of their cities or towns (never a
  village) on their own or neutral ground: press the button on the 🏭 Production panel, click the map, and two turns
  after the one it was ordered in a level-1 factory stands there (15 iron, 10 timber, 80 money, 2 manpower). The GM can place or
  upgrade factories directly.
- **Major cities (Earth).** **Add major cities** places about 270 towns of the 1914 world with the names of
  the time (St Petersburg, Constantinople, Christiania, Lemberg, Peking, Bombay…), the capitals of the
  1914 powers marked as capitals, and an industry level 1–5 that feeds income and production. Coordinates
  come from Natural Earth (`scripts/prepare-cities.js` rebuilds `public/earth/cities.json`); the list,
  names, capitals and industry are authored. Cities take the faction whose territory they sit in and are
  skipped if a town of that name already exists.
- **Resources (Earth).** **Generate resources** places about 200 authored historical regions from
  `public/earth/resources.json` (Ruhr, Donets and Welsh coal; Lorraine, Kiruna, Mesabi and Bell Island iron;
  Baku, Ploiești, Texas and Persian oil; Chilean nitrates; Malayan and Congo rubber; Ukrainian, prairie and
  pampas grain; steppe and Argentine horses; and so on) with yields of 1–9 per turn, plus an optional **fill**
  of small random deposits on land so remote factions have something to work with. Everything is an ordinary
  resource marker afterwards.

### Supply, support units and matchups (game mode)

Land units are **supplied or cut off**, kept up to date live as units, places and railways change: places supply units within 30 km, and **Supply
Columns** supply units within 100 km once linked (fed by a friendly capital within 600 km, a city within 400 km,
a village within 200 km, or a railhead or another linked column within 150 km, so columns can be strung out
far from home). **Convoys** (transport ships) supply troops within 100 km and feed columns within 200 km anywhere,
so invasions can be supplied; selecting a unit draws its supply line back to its source.
A cut-off unit (red badge) cannot move or attack and takes double losses when beaten; from its second End turn
cut off it loses a quarter of its remaining strength each turn and below 10 % surrenders under a white flag. **Field hospitals** heal
units around them each turn, **HQs** add attack and defend, **engineers** add defend and **signals** help
artillery. **Matchups** add strengths and weaknesses to attacks: cavalry is weak against entrenched troops and
machine guns but strong against artillery, tanks break wire and machine guns, anti-aircraft hits aircraft,
destroyers hunt submarines, and so on; the attack dialog shows the modifier for each target. Details, all the
numbers and the full table: `docs/UNITS.md`.

### Long-term growth (game mode)

Nations can grow their income without cutting their army, slowly. From **Nation → Production → Development**
(or a town's or factory's popup) they can **upgrade factories** (level 1–5, each level +2 money a turn and a
build slot) and **develop towns** (capital up to 5, city 4, village 2; each level +3 money and +1 RP a turn, a
build slot every second level). Each step costs more and takes longer (3–12 turns), one project per site, and
the levels stay with the place if it is captured. The **Economy** research branch (1915–1919) adds small,
compounding income bonuses and makes the projects cheaper; existing campaigns receive it automatically.
Details and numbers: `docs/ECONOMY.md`.

### Research (game mode)

- **The tree.** When game mode starts the campaign gets a copy of the default WW1 tree
  (`defaults/techtree-ww1.json`: 81 techs in eight branches, Infantry, Artillery, Armour & motor, Aviation,
  Naval, Chemical, Industry & logistics and Doctrine, dated 1890–1918). Each tech has a year, an RP cost, a
  money cost paid when the project starts, prerequisites, effects and a description. Every faction starts
  with every tech dated on or before the campaign's **start year** (1914 for the scenario), so nations begin
  with rifles, machine guns, field artillery, dreadnoughts and balloons but no tanks, gas or fighters.
- **Researching.** Research points come in each turn (base allowance, cities, factories, modifiers). From
  the 🔬 Research button on the menu, a player starts one project at a time and can queue up to five more;
  at End turn the RP the faction had banked during the turn flows into the active project (that turn's RP
  income is banked afterwards, so nothing is finished on points the faction did not have yet); it unlocks when
  paid for, its effects apply, and the next queued project starts (if its money can be paid) and draws on the
  bank from the next End turn, so at most one tech completes per turn. A tech can be researched only when
  its prerequisites are known and its year is within the **research lead** (1 year) of the game date, so
  1918 tanks cannot appear in 1915. Progress on a dropped project is kept. Completed research is announced
  campaign-wide.
- **Effects** are data on each tech and are recomputed from the unlocked set whenever they are needed,
  so a GM locking a tech again cleanly removes its bonuses: `unlockUnit` makes a type buildable (types no
  tech gates are always buildable; 45 of the 54 are gated), `stat` adds attack/defend/movement/range/AP to a
  type or category (applied in combat and to movement allowances, never baked into units), `cost`
  multiplies production costs, `buildTime` changes build turns, `income` adds to or scales money, RP,
  manpower or a resource, `removeCost` makes a resource unnecessary (Haber process: nitrates), `cover`
  adds to trench cover, `capacity` adds parallel builds per site, `recover` heals damaged units each turn
  (medical services) and `flag` marks a rule for later. The combat log shows tech bonuses on either side.
- **GM.** From the same tree the GM can **Unlock** or **Lock** any tech for any faction, **edit** any tech
  (key, branch, year, costs, prerequisites, effects as JSON, description), add new ones, delete, or
  **reset to the default tree**. Research lead and start year are rules (⚖ Rules → Research).

### Territory and war (game mode)

- **Setting up a new Earth campaign.** Pick the Earth map (with the year's borders if you like), seed the
  factions from history on the 👥 People panel, then switch game mode on with **Set up the world** ticked (the
  default when there are no provinces yet). In one background job of a minute or two the server cuts the
  provinces for the map's year, gives each faction its states, and adds the major cities and the historical
  resource regions; progress shows on the 👑 GM panel's World page. **Set up the world** on that section
  runs the same job later, keeping any cities and resources already on the map, and **Cut provinces only**
  redoes just the provinces.
- **Provinces (Earth map).** **Cut provinces only** (👑 GM panel → World; pick the year and a size, 100 km by
  default; the year defaults to the one the Earth map shows) slices the land into provinces that follow that year's state borders and the coastline: one
  around every major city plus a jittered grid inside each state, every cell clipped to the coast and cut
  along the border, fragments merged into their neighbour. **Lakes are water**, like the sea: provinces stop at
  their shores (islands in them are land), and the server's land tests treat them as water, so no craters on
  them, ships may sail on them, and lakeside cities count as coastal. Provinces cut before this have their lakes
  cut out the first time the lobby loads (`lakes_cut`); one lying wholly in a lake is dropped. The whole world is about 15,000 provinces and
  takes a minute or two; progress shows next to the button. Each province is named after the city inside
  it or the nearest one with a compass direction ("Reims NE"), and hovering the map names the province and
  its owner on the HUD. Provinces are then assigned to factions by state name, and every capture, brush
  stroke and assignment works on whole provinces, so borders always follow province edges and never paint
  the sea. Zoomed in, hairline province edges show inside each territory. Border drawings imported from
  history (locked areas named after states) are removed when provinces are cut, since they would only draw
  a second, coarser border on top.
- **Territories** are one polygon set per faction plus neutral land (derived from the provinces when they
  exist), drawn as tinted fills with a dark border carrying the owner's colour and the faction's name on every
  sizeable piece. On the Earth
  map, **Assign borders of that year** gives every state of the chosen year, and every
  colony, dominion and protectorate of it, to the faction of that power; unmatched states become neutral.
  A faction matches its power under any of the power's names: "British Empire", "United Kingdom", "Great
  Britain" and "United Kingdom of Great Britain and Ireland" are one power, as are "Russia" and "Russian
  Empire", "Germany" and "German Empire", and so on. The historical dataset leaves many holdings without an
  owner (in 1914 Canada, Australia, Ceylon, Malaya, Togoland, Kamerun, Finland, Suriname…) and some islands
  without a name (the Hebrides, Orkney, Shetland, the Faroes, the Aegean islands); `public/js/powers.js`
  lists their owners per bundled year, and splits 1914 New Guinea into German New Guinea and British Papua.
  Dominions count as British up to 1920 but not in 1938. Port cities that sit just outside the coarse
  historical borders, or a little offshore on the coastline data, take the owner of the nearest province.
  The faction seeder lists each power once under that name ("British Empire", with its flag).
  That assignment redoes every faction's borders. To **add one nation without touching the others** (an alt-history
  map whose borders the GM has already reshaped), use **Give a faction its historical land** on the 👑 GM panel's
  World page: pick the faction and the historical state it should get ("Land of", its own name by default;
  several separated by commas, with suggestions), and **Give land**. By default it takes only **unclaimed**
  (neutral) provinces of that state, so every faction's existing ground stays as it is; untick *Unclaimed land
  only* to take the state from whoever holds it. It gives the state itself ("United Kingdom" is Great Britain and
  Ireland); tick *Include its colonies* for every colony and dependency the power held. Provinces are not re-cut.
  The Earth layer's own
  political borders, tint and labels hide while territories exist. On any map the GM can **assign a selected area
  drawing** to a faction (or to neutral), paint with a **brush** (pick a faction and a radius, then click
  the map; each click gives that circle, or the provinces whose centre is inside it, to the faction) or
  **pick provinces** one click at a time. **Clear territories and provinces** removes them all.
- **Ownership follows the ground.** Resource nodes, factories and towns take the faction whose territory
  they stand in, at every capture, assignment or brush stroke, and again before income is paid at End turn.
  Places at sea or outside any territory keep their faction.
- **Advancing moves the border.** When a **land unit** (infantry, mounted, artillery, support) ends a move on
  ground that belongs to a faction it is **at war** with, or on neutral ground (rule switch), it carves a
  circle of the capture radius (30 km) out of that territory into its own. A city or capital of the enemy
  inside the circle is taken with a larger district (75 km) and flips to the attacker, with a campaign
  event. **Defended ground does not fall**: a province with a defender anywhere in it (a land unit of its owner,
  or of anyone at war with the attacker) stays put. Ending a move in one, or with a defender within the capture
  radius, the front holds and nothing changes; a defended province or city nearby is left out of what is taken.
  The defenders must be beaten first: when an attack destroys a defender, an attacker standing on enemy ground
  takes it at once if no other defender holds it (on maps without provinces, "in it" means within the capture
  radius of the defender). Naval and air units never change borders, and allies can march through each
  other. Units at zero strength do not capture. Territory is never given back automatically: the line stays
  until someone advances the other way.
- **Relations and diplomacy.** Every pair of factions is at peace, at war or allied. A player queues a
  **declaration of war**, a **peace offer** or an **alliance proposal** from the 🤝 Diplomacy panel (the GM can do it
  for any faction). Declarations and offers wait for the GM: **Approve** puts a declaration into effect at
  once, or passes an offer to the other faction, whose player (or the GM) then **accepts** or **declines**;
  **Block** stops it. The GM also sets any relation directly at the foot of the 🤝 Diplomacy panel. Everything is logged; war declarations
  are announced campaign-wide.
- **Undo last turn** also restores territories and relations from the snapshot.

### Heroes

Generals, diplomats and spies with a star rating (1–5), shown as a 2:3 portrait in an animated golden ring on
the map and as a card in their popup. **Generals** add +1 to +3 attack and defend to their nation's units within
60 km. **Diplomats** must be posted to a nation (sent to its capital, arriving at the end of the turn) before a
peace offer or alliance proposal can go to it; the host can expel them and war sends them home. **Spies** are
seen only by their own nation; they reconnoitre an area (a report, and hidden units revealed until the end of
the turn), steal research points, or hunt enemy spies. Missions on hostile ground are contested: the defender's
sharpest spy nearby rolls d20 + perception against the agent's d20 + intelligence, and a caught spy is taken
off the map. The GM creates heroes from the ➕ Place panel and assigns each an owner. Full rules and numbers:
`docs/HEROES.md`.

### Railways

The GM lays railways with the 🛤 tool (R): click points or drag freehand; lines that start or end on other track
join it, and lines that cross or end within 20 km of other track are joined into one network. The track is drawn
with the pixel-art tile from the train sheet, and trains run back and forth along every open stretch. A unit going
by rail is shown boarding a train in its colours that runs along the line and drops it off (no movement line is
drawn for the trip). In game mode land units and heroes ride any open track held by their side, an ally or no one
at 4× their normal pace (selecting a unit highlights the track it can still reach). A unit's **Attack…** list also
offers railway sections in reach: d20 + attack against d20 + the line's defence and its best guard; a success
closes 20 km of line, marked with smoke, until the GM or a nearby unit of the holder repairs it. Full rules:
`docs/RAILWAYS.md`.

**Convoys** (*Transports / convoy*) carry up to 10 land units or heroes: they embark within 30 km, sail with the
convoy out of sight, and land together on the nearest beach within 100 km (no beach, no landing). A convoy sunk
or removed takes everyone aboard with it. Allies can share a convoy: whichever side acts (boarding an ally's
troops, asking to board an ally's convoy, landing with allies aboard) sends the other side a request to allow.
Details: `docs/UNITS.md`.

### Dice and combat

Type `/roll 2d6+3 optional note` (or `/r d20`) in the chat, or use the 🎲 button. Rolls happen on the server with
a cryptographic RNG and are logged for everyone, so nobody can fudge them. Up to 20 dice of up to 1000 sides.

A unit's popup has **Attack…** for its owner or a GM. Pick a target (enemy units only, sorted by distance; the
attacker's own nation, destroyed units, troops aboard a convoy and, in game mode, its allies are never offered or
accepted) and the server rolls:
each side rolls the campaign's combat die and adds attack or defend. The loser loses *base loss* + *margin ×
extra per point* of strength, the winner loses the *winner's loss*, ties cost both half the base. The defaults
(d20, 10 %, 2 %, 5 %) live in campaign settings. Results go to the log, both units shake and an explosion
sprite plays over them (bigger, with two follow-up blasts, when a unit is destroyed), and the losses pop up
over each unit as **floating numbers** (red "−23" with the strength left, bigger for heavy blows, "DESTROYED" at
zero, "No loss" for a side that came off unharmed). Any strength change shows the same way, wherever it comes
from: attrition at End turn, a hospital (green "+10"), or the GM. The strength changes
are ordinary history entries, so a bad fight can be reverted. A unit at zero strength is greyed out and burns
with a looping fire-and-smoke sprite until a GM deletes it or restores its strength (an edit or a revert both
work).

**Coastal batteries and fortress guns return fire** on a ship that attacks them: straight after its attack, if both still stand and the
ship is within the battery's reach, the battery rolls a free shot back (no action point; its attack, tech, general,
support and the +2 against ships, against the ship's defend). A hit costs the ship the base loss plus the margin; a
miss costs nothing; the battery takes nothing from its own shot. It is logged as a 🎯 line of its own, and the
battery's guns shell the ship on the map for the rest of the turn while the ship keeps firing its salvoes.

**Artillery** (and gun emplacements: coastal batteries, fortress guns, AA emplacements) firing from range takes no losses when its attack is repelled or ends in a stalemate (the log
notes "guns out of reach of the reply"); it still takes the winner's loss when it wins.

**Battles stay on the map for the turn.** Every attack is recorded until End turn (`battles` table,
`GET /api/lobbies/:id/battles`, WebSocket `battle`; hidden fights only for the GM and the attacking player).
Units drawn as men and machines (below) fire from where those are: each round a tracer from the man or gun that
fired it, at one of the enemy's men, at the weapon's rate (bolt-action rifles 10–15 rounds a minute, machine guns
in bursts at 450–550). Other direct-fire attackers show **gunfire**: a regiment's firing line (a ragged front of riflemen
as wide as the gap between the units, 70–190 px on screen) sending tracers at points along the enemy's front,
with muzzle flashes on each shot, a haze of powder smoke and dust where rounds land. Each round keeps the
heading it was fired on while sections of the line sweep their aim along the enemy front, fire in bursts and
lulls at their own cadence, and every 7–11 s loose a volley together; tracer speed, length and colour vary
shot to shot. The defender's line fires back with about two thirds as many rifles and its own pattern; a side
that has been destroyed or removed stops firing. Visible from 800 % zoom.
**Units stand on the map.** From 800 % zoom every land unit on screen is drawn as its men and machines, in a fight
or out of it, like the pieces of a board game: out of a fight the section stands at ease a little ahead of its
token (in its pits behind its wire once dug in), guns with their crews, tanks parked, horsemen formed up, facing the
nearest unit of another nation (else the way it last moved). When it goes into a fight they run, roll or ride from
there to its line, and back when the fight ends. Units at ease draw no frames of their own while nobody moves.
**The dead stay where they fell** for the turn of the fight and the two after it (half an hour outside game mode),
then are cleared: men, and fallen horsemen beside their dead horses, darkening a little each turn. Each browser
keeps the ones it saw fall (localStorage, per campaign); fights it did not see have theirs laid out from the server's
record of the fight (each battle keeps who fell, its `losses`, for those turns: `GET /battles` → `past`).
**Infantry** fight about a line 60 px ahead of their token.
- A section of eight runs out from the unit when the fight starts: an officer, a sergeant, a light machine-gunner,
  a medic and riflemen, spread out ahead of and behind the line, lying, kneeling or standing to aim at the enemy.
- Now and then one rushes forward or back to a new spot, and the medic goes out to kneel by the fallen.
- Each 12.5 % of strength lost leaves one dead on the line, falling one after another when a blow lands (at 50 %:
  four firing, four fallen). Healing brings them back.

**Armies.** Every faction fights as one of eight armies: American, ANZAC, Arab, British & Commonwealth, French,
German, Ottoman or Russian. Set it on the faction (👥 People → faction → *Army*), or leave it on *Automatic* to
choose from the name.
- The kit follows the game's date: 1914 dress, steel helmets and the new light machine guns from 1916 (the Ottomans'
  new kit from 1918), greatcoats and winter dress from November to February.
- Cavalry form up in echelon, charge through the enemy and on past him, and loop wide round a flank back to
  their places. Arab cavalry ride camels. A fallen horseman lies beside his dead horse.
- Stormtroopers go in as the army's assault troops; French colonial troops go in as zouaves.

Troops that hold their ground **dig in**: rifle pits and sandbags after a turn, a belt of barbed wire in front after two
(or at once in a trench line), which slows charging cavalry to a crawl. A unit that moves leaves its pits and wire
behind and starts digging again from nothing.
**Holding fire:** the target of a bombardment does not shoot back at the distant guns, and artillery attacked at
close quarters does not return fire; their men stand to their positions. (Visual only: the dice are unchanged.) **Gas troops** attack with a cloud of
yellow-green gas let out from cylinders, which rolls over the enemy's line; his men mask up and stop firing until it clears.
Observation balloons float on their tethers (heavy guns shelling put up a spotter), and are shot down in flames;
airships circle and bomb; anti-aircraft guns fill the sky round enemy planes with black flak bursts.
A haze of **battle smoke** drifts over every fight, thickening the longer it has gone on (full after ten minutes);
under a bombardment it is dust and smoke over the target. Fights **mark the ground**: tank tracks churned behind the tanks,
hoofprints where cavalry rode, small shell holes where guns and tanks firing over open sights hit; they fade over a
quarter of an hour (they are drawn in the browser, not saved).
A section hit hard **routs** back behind its line and rallies; one destroyed **surrenders**: its last men are
marched off under a white flag. **Stretcher bearers** carry the wounded back to the aid post.
A ship that goes down leaves an **oil slick**, burning at first, with wreckage drifting in it.
**Weather** follows the game's date: in winter snow lies on the land beyond a snow line that moves with the month
(on the vector Earth: from about 43° north in January to 55° in November and March, deepening northwards), and each
turn has its weather from its date, snow falling on some winter turns and rain on some turns all year, most in
autumn, drawn over the view from 400 % zoom; from autumn to spring the mud round shell craters is darker.
**Battle sounds** (🎧 in the top bar, off until switched on, remembered per browser; `public/js/sound.js`), from
recordings in `public/assets/sounds`: looping beds faded in and out with the fights in view (close in, from 800 %,
the gunfire of the nearest fights over the din of the battlefield; at middling zoom the din; zoomed out, a
bombardment far off; the drum of hooves while cavalry in view charge or wheel), panned towards them; and an incoming shell's whistle for each shell, bomb or splash on
screen, timed so its burst lands with the explosion. The recordings are from Pixabay (freesound_community,
soundreality, fronbondi_skegs, pwlpl), under the Pixabay Content License.

**Machine-gun companies** and **trench mortars** go in as four gun-and-crew teams, left empty when their crew are
down. Other **artillery** shows four guns of its type, each worked by two men (guns recoil and smoke, shells leave
from them, a gun whose crew is down falls silent).

**Tanks** roll out two to a unit, one knocked out at 50 % strength. Each nation has its own tank design.

**Ships:** each naval unit shows its squadron (two battleships, six or seven destroyers, four to six submarines, a
convoy of freighters…), in or out of a fight. In a fight the ships fire salvoes that splash around the enemy,
torpedo craft and submarines loose torpedoes, and ships lost go down burning. Built by
`node scripts/build-ships.js "rob assets"`.

The figures come from `public/assets/soldiers.png`, built from the army folders by
`node scripts/build-soldiers.js "rob assets"` (`public/js/skirmish.js`). Details: `docs/UNITS.md`.
**Artillery** (and ships) **shell** the target instead: bursts from `public/assets/shellburst.png` land at random
around it every second or two. Each shell leaves the guns with a flash and climbs a slow arc (1–2.4 s, a bright
shell with a fading trail over a faint dotted trajectory) to where it lands, so the line of fire is clear even
when the battery's counter hides its muzzle; shells and flashes draw above the tokens. Each bombardment also leaves
**4–5 craters** around the target (on land only: shells that fall in the sea leave none), picked from the crater sheet (`rob assets/tile-B-04.png`, atlas `misc-04`;
plain, dark and scorched), drawn 0.8–1.5 map px across (65 % of the size stored with them) and shown from 400 % zoom. Craters are static sprites stored in
the `craters` table and stay for **ten turns** (End turn removes the old ones; outside game mode, a day). Each
crater lies in a scar of **churned mud** about three times its size (generated in the renderer: ragged wet and dry
earth, scorched dark round the hole, a few standing puddles, clods and pale subsoil thrown out; shown from 250 %), so
ground shelled again and again goes dark and battle-worn. Craters weather over their ten turns, scar and hole fading
as the grass comes back, and this turn's craters still **smoke** (grey wisps drifting up, now and then a smouldering
glow). Both follow the units if
they move and sleep when off screen. Shells that land in water raise a **splash** instead of an earth burst (drawn by
the renderer: a white column that leaps and collapses, thrown spray, a churned patch and two foam rings); with
provinces each landing point is tested, otherwise the server says whether the target is at sea.

**Ships stay at sea.** A player's ship may only move to water or a coastal spot (within about 10–15 km of the
sea, for harbours), and its straight course may not cross land ("go round by sea"); the GM is exempt. New ships
are launched on the nearest water to their shipyard. The test uses a cached land raster (2 map px per cell)
built from the bundled Natural Earth land in about 40 ms (`territory.landMask`).

**Land units stay ashore.** A player's land unit may only move to land (anywhere within 8 km of it counts, as the
coastline is coarse and ports can lie just off it), and walking there it may not cross open water wider than a
strait (20 km: the Bosporus, the Dardanelles, Messina, the Danish sounds pass; the Channel, the seas and lakes such
as Lake Michigan need a convoy). By rail only the end is tested (the track decides the way). A unit already in the
water may cross a strait's width plus however far out it stands, enough to wade ashore. Units aboard a convoy move
with it, and the GM is exempt (`territory.landCourseError`, in `game.checkMove`). Outside game mode, where there are no turns, they last five minutes.

The sheets are `public/assets/explosion.png` (hits: one row of 8 frames of 128 px), `public/assets/shellburst.png`
(shelling: one row of 7 frames of 128 px) and `public/assets/burning.webp` (8×8 frames of 128 px); any sheet of
square frames in one row can replace the first two.

### Chat, notifications, trades and pings

**💬 Chat** (bottom right) has an OOC tab for everyone (the same chat as the Log, with `/roll`), a GM tab for
announcements only the GM can post, and private chats between any members, including the GM. The **🔔**
notification centre (top centre) lists diplomacy and trades that need your answer, with Accept, Decline,
Approve or Block right there, and rings when wars are declared. **＋ Trade** offers another nation resources,
money, manpower or research points, once or every turn for a set number of turns. The GM's **📍** tool (P) pings
a spot on the map for everyone for a minute. In game mode the ready-up bar beside the campaign name shows each
player nation's flag with a green ✓ once its player has finished the turn, so the GM knows when to End turn.
Details: `docs/COMMS.md`.

### Alerts

The 🔊 / 🔇 button turns on a chime and, if the browser allows it, a desktop notification whenever someone else
moves a marker, chats, rolls or fights while your tab is in the background. It never fires while you are looking
at the map.

### Real-time protocol

Clients open `/ws` (authenticated by the session cookie) and send `{type:'join', lobbyId}` (plus `viewAs`, a
faction id, for a GM viewing as a player; REST calls carry it as the `X-View-As` header). The server pushes
`marker` and `shape` (upsert/delete, filtered per viewer), `drag` (live preview while someone drags), `history`,
`presence`, `event` (chat/system/roll/combat/announce), `members`, `lobby` (settings/map changed), `role`, `kicked`,
`chatChannel` and `chatMessage` (private chats, members only), `tradesChanged`, `ping`.
All persistent changes go through the REST API, which validates, records history and then broadcasts.

## Keyboard

`S` select box · Shift-drag select box · Shift-click add to selection · `M` measure · `L` line · `A` area ·
`Z` undo last point · `Enter` finish drawing · right-click a vertex to remove it ·
Shift-drag a selected drawing to move it · `G` grid · `F` fit ·
`Esc` cancel/close · `Delete` delete selected marker or drawing (if allowed) · wheel to zoom · drag empty map to pan ·
drag a marker to move it (if allowed; in game mode left-click a unit to select it, then right-click the map inside
its ring to move it there) · right-click a unit or hero for its panel · `R` railway ·
`P` ping (GM) · `1`–`9`, `0` open the menu panels (Nation, Production, Research, Diplomacy, Map, Place, People,
Log, History, GM) · `Esc` with nothing selected closes the open panel.

## How it is put together

```
server/
  index.js        Express app + static files + WebSocket attach + backup timer
  config.js       env-driven settings
  db.js           node:sqlite schema (users, sessions, lobbies, lobby_members, markers, shapes, history, events)
  auth.js         scrypt password hashing, session cookies, rate limiter, middleware
  lobbyAccess.js  role resolution, the canSee() visibility rule, serializers
  history.js      change log with summaries, before/after state and revert links
  backup.js       VACUUM INTO snapshots + upload mirror, scheduled
  ws.js           WebSocket hub: rooms per campaign, presence, per-viewer filtered broadcasts
  routes/auth.js  register / login / logout / me / password / user admin
  routes/lobbies.js  campaigns, members, map upload, markers, shapes, history/revert, events, dice, combat
public/
  index.html      sign in / register
  lobbies.html    campaign list, create, join, account, user admin
  map.html        the map app shell
  js/map-renderer.js  PixiJS WebGL renderer (camera, procedural sprites, shapes + vertex editing, animations, measure/draw modes)
  js/earth.js     vector Earth built from the Natural Earth bundle, plus the equirectangular projection helpers
  js/atlas.js     sprite atlas loader: "sprite:<sheet>:<n>" references → PixiJS textures and CSS previews
  js/units.js     WW1 unit catalogue, default stats and the drawn NATO-style counter symbols
  js/naming.js    ordinal styles by faction keyword and the next-free-number rule (shared with the server)
  js/game-data.js the ten resources, default rules and calendar helpers (shared with the server)
  js/game-ui.js   turn widget, nation bar, Nation / Production / Diplomacy and GM panels, treasury editor
  icons/          painted resource and goods icons used by nodes, factories and the treasury
server/game.js    game rows, faction treasuries, income, End turn / undo, movement and action-point rules
server/routes/game.js  /api/lobbies/:id/game routes
server/geo.js     server-side projection and great-circle distance (mirrors earth.js)
server/territory.js  faction territories: seeding from a year, brush/assign, the capture rule, ownership of places
server/production.js  build queues, costs, sites, coastal and industry rules, factory placement
server/research.js  tech tree storage, research queue and the effects engine
defaults/techtree-ww1.json  the default WW1 research tree
  js/stats-editor.js  GM table of per-campaign unit stat overrides (+/- steppers), shared by both pages
  js/cost-editor.js  GM table of production costs
  js/research-ui.js  research section, tech tree modal and the GM tech editor
  sprites/        pixel-art sheets and atlas.json (generated)
  js/map.js       app logic: REST + WebSocket sync, menu rail and panels, forms, popups, history, combat, notifications
  earth/          land, lakes, rivers, borders (gzipped JSON, public domain)
scripts/
  create-admin.js, import-firebase.js, backup.js, cleanup-uploads.js, prepare-earth.js, extract-sprites.js,
  install-service.ps1, uninstall-service.ps1
```

### Rendering and CPU use

The renderer draws on demand rather than every display refresh. PixiJS's own ticker is stopped; a small loop
in `map-renderer.js` redraws only after something changed (`invalidate()` is called by every camera move,
marker or drawing update, hover, drag, selection and texture load) or while an animation is running. A map
nobody is touching costs no frames at all. Idle animations (aircraft floating, ships rolling, the selection
pulse, burning wrecks, explosions) are capped at `idleFps` (24) and stop drawing as soon as they finish, while
panning, dragging and vertex editing run at the full refresh rate. Before this change a 144 Hz monitor was
redrawing the whole scene 145 times a second and kept a CPU core busy for a static map.

With many units: tokens off screen are not drawn or animated, and on the Earth map at 100 % zoom and below
unit icons are replaced by one small dot per unit in its faction's colour (a single shape, redrawn only when
units or the zoom change); a unit's icon, textures and flag are only built the first time it is shown. The
Map panel list and the nation panels are rebuilt at most once per frame however many markers change, so loading a
campaign or moving a formation no longer rebuilds them once per marker (with 1,300 markers that alone froze the
page for about 17 s). Provinces are drawn as two meshes built once (fills and borders) and recoloured in place
when owners change: see `public/js/province-layer.js`.

## Known limitations

- Touch: pan and tap work on phones, but there is no pinch-to-zoom yet; use the + / − buttons.
- Map images are single textures. The browser shrinks uploads to 8192 px on the longest side, which every
  current GPU can display.
- A server restart drops live WebSocket connections; clients reconnect automatically and resync. Sessions are in
  SQLite, so nobody is signed out.
