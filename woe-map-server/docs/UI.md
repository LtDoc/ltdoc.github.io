# The map screen

Rebuilt 30 Sep 2026 along the lines of Hearts of Iron and Civilization: the map fills the screen, a menu down
the left opens panels over it, the nation's resources run along the top, and the turn button sits bottom right.
Markup in `public/map.html`, layout in `public/css/app.css` ("Map app layout"), panel logic in `public/js/map.js`
(`showPanel`, `showSetPage`) and `public/js/game-ui.js` (`renderNation`, `renderNationBar`, `updateHud`).

```
┌ ← Campaign name [ready bar] ─────────── ✉ ──────────── people online · 🔊 · ⚙ ┐
│🏛 │ 🏴 France │ 💰 100 +77 │ 👥 20 +28 │ 📜 0 +21 │ grain 20 +13 · coal 20 +7 …  │  ← nation bar (game mode)
│🏭 ├───────────────┐                                                          │
│🔬 │  open panel   │                        the map                           │
│🤝 │  (Nation,     │                                                          │
│── │  Production…) │                                                          │
│🗺 │               │ ┌ selection card ┐                            ┌ Turn 3 ──┐ │
│➕ │               │ └────────────────┘                            │ 11 Aug   │ │
│👥 │               │ [− 100% + ⛶] [⬚ 📏 〰 ▱ ⌇ 🛤 📍 ▦]      💬 Chat │END TURN│ │
│👑 │               │                                               └──────────┘ │
└⚖ ─┴───────────────┴───────────────────────────────────────────────────────────┘
```

## Campaign documents

Journal, Government and News open as reading views in the map sidebar. Their shared document styling lives
in `public/css/campaign-stories.css`, loaded after the campaign theme.

- **News** uses a miniature newspaper clipping on the menu rail. Newspaper posts are parchment clippings
  with a masthead, date, headline and byline; private editions remain visibly separated. Publishing opens
  from **Publish a dispatch**, leaving the feed visible by default.
- **Journal** presents dated entries with explicit Private or Recovered labels. **Write an entry** opens the
  composer; editing an existing entry opens it and focuses its title.
- **Government** presents the nation's character, priorities, factions and figures as a dossier. **Edit profile**
  switches to labelled fields; **View profile** preserves the draft, **Cancel** discards it after confirmation,
  and a successful save returns to the dossier. Reopening the panel preserves unsaved changes. Switching
  nations requires confirmation when there is a draft.

The panels include loading and save feedback, prevent duplicate submissions, and adapt to the mobile sidebar.

## Top bar

- **← / campaign name / ready bar** (left). The ready bar shows each player nation's flag with a green ✓ once
  its player is done for the turn (`docs/COMMS.md`).
- **✉ notifications** (centre: an envelope, a fresh letter in it when something waits): diplomacy, wars and trades, with answers inline.
- **People online, 👁 view as player, 🔊 alerts, ⚙ settings** (right; 👁 and ⚙ for the GM).

## Nation bar (game mode)

The viewed nation's flag and name, then money, manpower and research with their change per turn, then every
stockpile (red when empty). Hover a figure for its name and change; click any of them for the Nation panel. The
GM's name is a picker: choosing a faction there switches the nation bar and the Nation, Production and
Diplomacy panels to it.

## Main menu (left rail)

Each button opens its panel over the map; the same button, the panel's ×, or `Esc` (with nothing selected)
closes it. Keys `1`–`9` and `0` press them.

| Key | Button | What it holds |
|---|---|---|
| 1 | 🏛 Nation | money, manpower, research; **at a glance** (build slots, research, forces, unrest: each opens where it is handled); stockpiles (and where they come from); goods (stored, made, used, balance) and the war economy; places taken and lost this turn; forces and heroes; research progress; all nations (public treasuries); last turn and its report |
| 2 | 🏭 Production | slots busy and free, **🏗 Build a unit…** and **📖 Unit guide**; finished emplacements to place; every city and factory with its build slots, what it can build (⚓ ships, ✈ aircraft), its queue with progress bars and **＋ Build** (*Hide full* hides busy sites); new factories; Development (long-term projects) |
| 3 | 🔬 Research | opens the tech tree |
| 4 | 🤝 Diplomacy | open proposals first; relations grouped At war / Allies / At peace, with a search box; treaties; **Offer a trade…**; for the GM, approvals and setting relations directly |
| 5 | 🗺 Map | every unit, place and drawing, with search and lock all / unlock all |
| 6 | ➕ Place | place new units, towns, resources, heroes and other tokens |
| 7 | 👥 People | join code (GM), factions, members |
| 8 | 📜 Log | read-only game activity and dice; chat stays in Chat |
| 9 | 🕘 History | every change, with revert |
| 0 | 👑 GM | **Turn** (undo, reports, calendar and deadline, game mode on/off), **Nations** (treasuries, edit treasuries, unit costs), **World** (territory, provinces, brush, cities and resources, recalculate supply); **Map cleanup** (clear dead units) at the bottom, with game mode on or off |
| | ⚖ Rules | opens the settings window on the game rules (GM) |

Nation, Production, Research and Diplomacy appear in game mode only; 👑 GM and ⚖ Rules for the GM only.
On phones the rail runs along the bottom of the screen and panels take the whole map.

The buttons show the user's painted icons (the emoji above only stand for them here): a flag over a map (Nation), a
factory, a flask, a handshake, a folded map with a route, a unit dropping onto a map (Place), three soldiers under
their flags (People), an open logbook, a chronicle with a clock (History), a staff officer with his map (GM) and a
field manual with a checklist (Rules). They are one sheet, `public/assets/tabs.png`, built by
`node scripts/build-tabs.js "rob assets/Tab Icons"` (the file each button takes is listed in the script); a
button's `<i class="ti" style="--n:…">` picks its cell. The open panel's title, and the hints that name a panel,
show the same icon.

## Zoom levels

Zoomed out to **50 % or further** the map is a strategic view: the land, the national borders and the nations'
names, nothing else. Tokens (units, towns, resources, factories, heroes), drawings and their names, trenches,
railways, trails, last known positions, trains and the fighting all appear again past 50 %
(`STRATEGIC_SCALE` in `public/js/map-renderer.js`). Towns' own drawings and resource works come at 150 % and
craters at 400 %; the men of each unit at 800 %. Towns never carry a flag: the border says whose they are.

## Map tools (bottom left)

Zoom out, zoom level, zoom in, fit (`F`); then select box (`S`), measure (`M`), line (`L`), area (`A`), trench
(`T`), railway (`R`), ping (`P`, GM) and grid (`G`). They move right when a panel is open.

Select multiple units with a box or Shift-click, then right-click the map to move the group. This also works
while the select-box tool is active and with movement rules waived or game mode off. Units receive separate
destinations in a compact grid near the click; at map edges the whole grid shifts inward. With movement rules
enabled, each unit uses its own allowance and keeps marching to its destination at End turn if needed.

## Build and the unit guide

One window, `#buildModal` (`openBuildPicker` and `openUnitGuide` in `public/js/game-ui.js`; the explainer is
`public/js/unit-guide.js`, styles `public/css/unit-guide.css`):

- **Build** (Production → **🏗 Build a unit…** or a site's **＋ Build**): the site is a picker at the top (free slots,
  ⚓ ships, ✈ aircraft), so a player can choose the unit first and the place second.
- **Unit guide** (Production → **📖 Unit guide**, a unit card's **ⓘ Guide**, or *guide* beside the unit type when
  placing or editing a unit): the same window without building, for any type, the enemy's included.
- **Left:** category tabs with counts, a search (names, categories and roles), a sort (attack, defence, movement,
  range, cost, build time) and *Can build now*. Each row has the unit's counter in the nation's colour (the map's own
  symbol, drawn on a canvas), its role, attack ⚔ / defence 🛡 / movement ➜ / range ◎, money and turns, and why it
  cannot be built (research, the site, the treasury, a full site). Arrow keys move through the list.
- **Right:** the unit explained: its role and what it is for; rating bars for attack, defence, movement, range,
  armour and penetration (with the distances under the campaign's rules); matchups as chips (⚔ when it attacks,
  🛡 when it is attacked; green helps, red hurts); abilities from the rules (support auras, orders, supply, fuel,
  sight, fixed works, blockades); what its armour stops and what its penetration cannot hurt; the cost with each
  shortfall marked; and **🏗 Build**. A locked type names the tech that unlocks it, with **Open the tech tree**; a type
  the site cannot build offers other sites that can.
- **⇄ Compare with others** pins a type; every other type then shows its stats against it (+/−).

The roles and descriptions are in `INFO` in unit-guide.js and never quote numbers a campaign can change: those come
from the rules when shown.

## Selection card

What used to be the popup beside a marker is now a card docked bottom left, above the tools (beside the open
panel, if any): a unit's or a place's or drawing's details and actions. A unit's card (`unitCardHtml` in map.js)
leads with its counter, type, role and nation (**ⓘ Guide** opens the Unit guide on its type), a strength bar, six
stat tiles (distances in km), what it has left this turn (movement bar, attack pips), and status chips: supply
(green supplied, amber cut off, red out of supply, with one line on what that means), worn, dug in, general, corps,
submerged, refitting. Then the details that apply (march, orders, supplies carried, support, sight, traits,
convoy) and its matchups. Orders come first in the buttons; Center, Edit, Lock, History, Duplicate and Delete sit in a
quieter row underneath. Right-click a unit or hero for it (left-click selects to move; right-clicking an enemy while your
units are selected attacks it instead, docs/COMMS.md); other markers and drawings open it on a left-click. × or
`Esc` closes it.

## Research tree

The header is a strip of facts: the year and how far ahead techs can be researched, RP banked, money, the project
under way, how many techs are available now, and **➜ Go to available**. The tree opens scrolled to the active tech,
else the first available one, else the current year. *How research works* holds the rules.

## Turn widget (bottom right, game mode)

Turn number, date, the phase (🚩 Movement phase, ⚔ Battle phase; docs/WARFARE.md) and the deadline countdown. The
GM's button is **⚔ Battle phase** in the movement phase and **End turn** in the battle phase (it pulses once every
nation is ready; without phased turns it is always End turn); a player's is **Ready up** / **✓ Ready**, the same
switch as their flag in the ready bar, and ready-ups start again with each phase. Underneath: how many nations are
ready. The Chat envelope sits beside it (docs/COMMS.md). A phase change puts a banner over everyone's map for a few seconds.

## Selection bar (game mode)

With several of your land units selected, a bar at the bottom of the map offers **⚑ Form corps** and **＋ Add to
corps**. Corps are listed on 🏛 Nation → Forces with **Select**, **⇥ Form line**, **↻ Same line**, rename and disband
(docs/WARFARE.md).

## View as player (👁, GM)

The 👁 button opens a list of the nations (with who plays each) and *Game master view*. Picking a nation reloads the
tab as that nation's player:

- **What they see.** The server answers every request as that player (`X-View-As: <faction id>` on REST calls,
  `viewAs` in the socket's join), so GM-only markers, items visible to other nations, other treasuries, other
  nations' diplomacy and trades, and private log lines are filtered out exactly as for the real player.
- **What they can do.** Player rules apply: movement allowance and supply, action points and range for attacks,
  ships kept at sea, no 👑 GM panel, ⚖ Rules, ⚙ or End turn (Ready up instead). They command the nation's units and
  heroes (by the unit's nation, not by who created it); other nations' units are refused.
- **How it looks.** The 👁 button turns gold with the nation's flag and name, a gold frame runs round the map, and a
  "Viewing as …" tag sits at its top. People online still show them as GM.
- **Fog of war.** With the rule on, the view includes the nation's fog: shaded land out of its sight and the faded
  "last seen" markers of enemy units (docs/FOG-OF-WAR.md). The GM's own view has no fog.

It is per tab (`?as=<faction id>` in the address), so a GM can keep one tab as GM and another as a nation; opening
the campaign from the list starts in the GM view. `access.viewAsFaction`, `viewerFor` and `canControl` in
`server/lobbyAccess.js` hold the rules; `renderViewAs` in `public/js/map.js` the button.

## Settings window (⚙, or ⚖ Rules)

One window with a page list on the left:

- **Campaign**: General (name, scale, tokens, join code, delete), Combat (dice and losses, unit stats table),
  Map (upload an image, or the Earth and its options, editable borders).
- **Game rules**: Movement, Economy (base income, income by place size, town development and factory income,
  upkeep, starting stockpiles, public treasuries), Production, Research, Territory, Supply & support, Railways,
  Heroes, Trenches. **Save rules** at the bottom saves every rules page at once.
