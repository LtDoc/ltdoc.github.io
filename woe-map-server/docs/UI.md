# The map screen

Rebuilt 30 Sep 2026 along the lines of Hearts of Iron and Civilization: the map fills the screen, a menu down
the left opens panels over it, the nation's resources run along the top, and the turn button sits bottom right.
Markup in `public/map.html`, layout in `public/css/app.css` ("Map app layout"), panel logic in `public/js/map.js`
(`showPanel`, `showSetPage`) and `public/js/game-ui.js` (`renderNation`, `renderNationBar`, `updateHud`).

```
┌ ← Campaign name [ready bar] ─────────── 🔔 ─────────── people online · 🔊 · ⚙ ┐
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

## Top bar

- **← / campaign name / ready bar** (left). The ready bar shows each player nation's flag with a green ✓ once
  its player is done for the turn (`docs/COMMS.md`).
- **🔔 notifications** (centre): diplomacy, wars and trades, with answers inline.
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
| 1 | 🏛 Nation | money, manpower, research, stockpiles (and where they come from), places taken and lost this turn, forces and heroes, research progress, all nations (public treasuries), last turn and its report |
| 2 | 🏭 Production | every city and factory with its build slots (●○), queue and **Build…**; new factories; Development (long-term projects) |
| 3 | 🔬 Research | opens the tech tree |
| 4 | 🤝 Diplomacy | relations with every nation (War / Peace / Ally), open proposals, **Offer a trade…**; for the GM, approvals and setting relations directly |
| 5 | 🗺 Map | every unit, place and drawing, with search and lock all / unlock all |
| 6 | ➕ Place | place new units, towns, resources, heroes and other tokens |
| 7 | 👥 People | join code (GM), factions, members |
| 8 | 📜 Log | everything that happens, chat and dice |
| 9 | 🕘 History | every change, with revert |
| 0 | 👑 GM | **Turn** (undo, reports, calendar and deadline, game mode on/off), **Nations** (treasuries, edit treasuries, unit costs), **World** (territory, provinces, brush, cities and resources, recalculate supply) |
| | ⚖ Rules | opens the settings window on the game rules (GM) |

Nation, Production, Research and Diplomacy appear in game mode only; 👑 GM and ⚖ Rules for the GM only.
On phones the rail runs along the bottom of the screen and panels take the whole map.

## Map tools (bottom left)

Zoom out, zoom level, zoom in, fit (`F`); then select box (`S`), measure (`M`), line (`L`), area (`A`), trench
(`T`), railway (`R`), ping (`P`, GM) and grid (`G`). They move right when a panel is open.

## Selection card

What used to be the popup beside a marker is now a card docked bottom left, above the tools (beside the open
panel, if any): the unit's stats, strengths and weaknesses, supply and orders, or a place's or drawing's details
and actions. Right-click a unit or hero for it (left-click selects to move); other markers and drawings open it
on a left-click. × or `Esc` closes it.

## Turn widget (bottom right, game mode)

Turn number, date and the deadline countdown. The GM's button is **End turn** (it pulses once every nation is
ready); a player's is **Ready up** / **✓ Ready**, the same switch as their flag in the ready bar. Underneath:
how many nations are ready. 💬 Chat sits beside it.

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
