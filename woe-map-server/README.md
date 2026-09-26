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
- **Import the old Firebase markers:** export the `markers` node from the Firebase console as JSON, upload
  the map image to a campaign first (so the height is known), then
  `node scripts/import-firebase.js export.json <lobbyId>`. Old army markers become units, `lat` is flipped to
  top-left pixel coordinates automatically.
- **Reclaim disk:** icon files are kept when a marker is edited or deleted so History can restore them.
  `node scripts/cleanup-uploads.js --dry-run` lists files no marker, map or recent history entry references;
  drop `--dry-run` to delete them (`--history-days N` sets how far back history counts, default 90).

## Features

### Factions and flags

A GM defines factions from the Members tab: a name, a colour and a flag, chosen from the bundled set in
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
  member's nation from the Members tab). The owner of a marker always sees it.

The server applies these rules to the initial load, every WebSocket push, live drag previews, history entries and
combat reports, so a restricted item never reaches a browser that may not show it.

### Marker types

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

**Token sizing** (campaign settings): by default tokens are map objects about 36 map pixels wide, so they shrink
as you zoom out and grow as you zoom in, clamped between roughly 12 and 78 screen pixels so they never vanish or
turn into giants. Labels keep a constant text size and appear once a token is about 24 px or larger (hovered or
selected tokens always show theirs). The old behaviour, a fixed pixel size at every zoom, is available as
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
  form, or with the "lock all / unlock all" links on the Towns, Scenery and Drawings sections of the sidebar. A
  locked item can still be selected from the sidebar list to reach its popup. The server refuses to move or
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

**Seeding factions from history.** The Members tab has **Seed from history…**: pick a year, and every sovereign
power of that year is listed with a suggested colour and, where a bundled flag's name matches (British Empire,
German Empire, Austro-Hungarian Empire, Russia, Italy, United States, Canada, Mexico …), its flag. Tick the ones
you want and they become factions; existing names are skipped. Add your own flags to `public/flags/` named after
the power (e.g. `OttomanEmpire.png`, `France.png`) and they match automatically.

**Editable borders.** Campaign settings → Editable borders converts a year's borders into locked area drawings,
one per country (largest pieces only, simplified to 300 points), for the whole world or just the countries in the
current view. They are named and tinted like the drawn layer, which is hidden afterwards so the two do not overlap.
Unlock a country from its popup and reshape it like any drawing: drag vertices, grab the line to add one,
right-click to remove one, Move to shift it. Every change is in History.

`scripts/prepare-earth.js` rebuilds the bundle: give it a folder holding the Natural Earth GeoJSON files and any
`world_<year>.geojson` files from historical-basemaps (it has years from 123,000 BC to 2010) and every year found
appears in the Borders list.

### History and revert

Every create, edit, move and delete of a marker or drawing is recorded with its full before/after state. The
History tab lists them newest first; a marker's popup has a History button that filters to that one item.
GMs can revert any entry, players their own. Reverting a move puts it back, reverting an edit restores the old
fields, "Remove" undoes a placement and "Restore" brings a deleted item back with the same id. A revert is itself
a history entry, so it can be reverted too.

### Dice and combat

Type `/roll 2d6+3 optional note` (or `/r d20`) in the chat, or use the 🎲 button. Rolls happen on the server with
a cryptographic RNG and are logged for everyone, so nobody can fudge them. Up to 20 dice of up to 1000 sides.

A unit's popup has **Attack…** for its owner or a GM. Pick a target (sorted by distance) and the server rolls:
each side rolls the campaign's combat die and adds attack or defend. The loser loses *base loss* + *margin ×
extra per point* of strength, the winner loses the *winner's loss*, ties cost both half the base. The defaults
(d20, 10 %, 2 %, 5 %) live in campaign settings. Results go to the log, both units shake and an explosion
sprite plays over them (bigger, with two follow-up blasts, when a unit is destroyed), and the strength changes
are ordinary history entries, so a bad fight can be reverted. A unit at zero strength is greyed out and burns
with a looping fire-and-smoke sprite until a GM deletes it or restores its strength (an edit or a revert both
work). The sheets are `public/assets/explosion.png` (4×4 frames of 64 px) and `public/assets/burning.webp`
(8×8 frames of 128 px); swap in any sheet with the same layout to restyle them.

### Notifications

The 🔔 button turns on a chime and, if the browser allows it, a desktop notification whenever someone else
moves a marker, chats, rolls or fights while your tab is in the background. It never fires while you are looking
at the map.

### Real-time protocol

Clients open `/ws` (authenticated by the session cookie) and send `{type:'join', lobbyId}`. The server pushes
`marker` and `shape` (upsert/delete, filtered per viewer), `drag` (live preview while someone drags), `history`,
`presence`, `event` (chat/system/roll/combat), `members`, `lobby` (settings/map changed), `role` and `kicked`.
All persistent changes go through the REST API, which validates, records history and then broadcasts.

## Keyboard

`S` select box · Shift-drag select box · Shift-click add to selection · `M` measure · `L` line · `A` area ·
`Z` undo last point · `Enter` finish drawing · right-click a vertex to remove it ·
Shift-drag a selected drawing to move it · `G` grid · `F` fit ·
`Esc` cancel/close · `Delete` delete selected marker or drawing (if allowed) · wheel to zoom · drag empty map to pan ·
drag a marker to move it (if allowed).

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
  js/stats-editor.js  GM table of per-campaign unit stat overrides (+/- steppers), shared by both pages
  sprites/        pixel-art sheets and atlas.json (generated)
  js/map.js       app logic: REST + WebSocket sync, sidebar, forms, popups, history, combat, notifications
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

## Known limitations

- Touch: pan and tap work on phones, but there is no pinch-to-zoom yet; use the + / − buttons.
- Map images are single textures. The browser shrinks uploads to 8192 px on the longest side, which every
  current GPU can display.
- A server restart drops live WebSocket connections; clients reconnect automatically and resync. Sessions are in
  SQLite, so nobody is signed out.
