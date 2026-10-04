# Chat, notifications, trades, pings and moving units

Built 30 Sep 2026. Client: `public/js/comms.js` (chat window, notification centre, trade dialog) and
`public/js/map.js` (click to move, pings); renderer pieces in `public/js/map-renderer.js`. Server: chats and
pings in `server/routes/lobbies.js`, trades in `server/routes/game.js` and `server/game.js`.

## Chat window (bottom right)

**💬 Chat** opens a window with tabs:

- **OOC**: everyone's out-of-character chat. It is the same chat as the 📜 Log panel, so `/roll 2d6+3` works here too.
- **GM**: announcements. Everyone reads them, only the GM writes; each one also pops up as a toast and appears
  in the Log in orange.
- **🔒 Private chats**: **＋** starts one with any members (players or the GM), with an optional name ("Entente
  talks"); **Message the GM** opens a one-to-one with the GM. Opening a chat with exactly the same people
  re-uses it. Only members receive or can load its messages, and that includes the GM, who sees a private chat only
  when invited. **Leave** removes you; the last one out deletes it.

Unread counts show on each tab and on the Chat button. Which tabs you have read, and whether the window was
open, are remembered per browser.

API: `GET/POST /api/lobbies/:id/chats`, `POST /chats/:cid/leave`, `GET/POST /chats/:cid/messages`;
`POST /chat { message, channel: 'gm' }` for announcements. WebSocket: `chatChannel`, `chatMessage` (members
only), `event` with kind `announce`.

## Notification centre (top centre)

The 🔔 button counts what needs you, and rings (with a toast and, if switched on, a desktop alert) when
something new arrives. Answer directly from the list:

| Item | Who sees it | Buttons |
|---|---|---|
| A declaration of war, peace offer or alliance proposal awaiting approval | GM | Approve · Block |
| A peace offer or alliance proposal sent to you | that nation (and the GM) | Accept · Decline |
| Your own pending proposal | the proposer | Withdraw |
| A war declared (including a war the GM sets on the Diplomacy panel), peace made, alliance formed | everyone for wars; the two sides otherwise | dismiss |
| A trade offered to you | that nation (the GM can answer for it) | Accept · Decline |
| Your own trade offer | the proposer | Withdraw |
| A running recurring trade | both sides, GM | Cancel |
| A trade finished, declined or cancelled | both sides, GM | dismiss |

The 🔊 / 🔇 toolbar button still switches sound and desktop alerts on and off.

## Trades

**＋ Trade** in the notification centre offers another nation goods: any resource, money, manpower or research
points, in either direction ("4 coal for 25 money"). The GM can offer trades between any two nations.

- **Once**: both halves change hands the moment the other side accepts. If either side cannot cover its half,
  the acceptance is refused and nothing moves.
- **Every turn for N turns**: after acceptance, one delivery at each End turn, before income. A delivery
  happens only if both sides can cover it; otherwise that turn is skipped ("missed: France was short of coal")
  and the trade carries on. Deliveries appear in both turn reports. Undoing a turn restores the trade.
- Either side (or the GM) can cancel a running trade. War between the two sides cancels their open trades, and
  nations at war cannot trade.
- Trade messages in the log are seen only by the two sides and the GM.

API: `GET/POST /api/lobbies/:id/game/trades`, `POST /game/trades/:tid/accept|decline|withdraw|cancel`;
WebSocket `tradesChanged` (clients re-fetch their own list).

## Ready-up bar (top left, game mode)

Next to the campaign name, every nation that has a player shows its flag (or colour dot) and a count such as
**2/5 ready**. A player clicks their own nation (first in the bar, outlined in orange, labelled **Ready up**) when
they have finished their turn: the flag lights up with a green ✓. Clicking again takes it back. Hovering a flag
shows who readied it and when. Nations without a player (run by the GM) are left out.

The GM sees the same bar and can click any nation to mark or clear it for them. When the last nation readies,
the bar turns green and the GM gets a toast (and a chime / desktop alert when 🔊 is on): time to End turn.
End turn and Undo turn clear every mark. Ready status only informs the GM; it does not end the turn by itself.

On phones the bar floats just under the top bar, at the top left of the map.

API: `POST /api/lobbies/:id/game/ready { ready: true|false, factionId? }` (`factionId` for the GM only; a
player always marks their own nation); `GET /game` includes `ready` for the current turn. WebSocket: `ready`
`{ turn, ready: [{ factionId, userId, at }] }`. Table `turn_ready`.

## GM pings

The GM's 📍 button (or **P**) then a click on the map drops a pulsing red pin everyone sees for one minute.
Players get a toast and a **📍 Go to ping** button; when the pin is off screen an arrow at the screen edge
points to it. Pings are kept in memory only, so someone who loads the map during that minute still sees it.
API: `POST /api/lobbies/:id/pings` (GM), `GET /pings`; WebSocket `ping`.

## Moving units (game mode)

- **Left-click selects, right-click moves.** Left-click one of your units or heroes: a green area shows where it
  can still get to this turn, plus any railway track it can reach. It is the ground the server will let it reach
  in a straight walk, not a plain circle: a land unit's area stops at the coast (a strait of up to 20 km, with land
  beyond, is crossed) and never covers open water, a ship's stops at the shore, No Man's Land shrinks it (walking
  there costs its multiple of the distance), and a manned enemy trench you can see cuts it off just short of the
  line (docs/WARFARE.md). It follows the ground as it changes: a trench dug or blown, an enemy unit arriving to
  man it, an area redrawn. **Right-click** inside the area, or on highlighted track, to send it there; it stays
  selected so you can move it again. A right-click outside it says so.
  (`public/js/reach.js` casts 240 rays from the unit over the server's own land raster, `GET /landmask`, about
  90 KB, fetched once; a few ms, worked out only when the selection or the ground near it changes. Along the
  coast it stops a few km short of where the server would still let a unit wade ashore, never beyond.) A selected group (box or Shift-click) moves together to the point, keeping its shape, limited by its
  slowest member. Right-click and drag still pans the map; left-click on empty map deselects.
- **Right-click an enemy to attack it.** With one of your units selected, a dashed red ring shows how far it can
  attack (its range plus research; faint when it cannot attack now: the movement phase, its action spent, or cut
  off). Hover an enemy unit: a ring with sight marks closes round it, red with a line from your unit when the
  attack would go in, grey when it would not. **Right-click** it and the attack goes in at once (no dialogue); the
  roll and losses show on the map and in the log. With several of your units selected, every one that can reach
  it attacks in turn, stopping once it is destroyed. A right-click that cannot attack says why (out of reach, no
  action left, the movement phase).
- **Marching orders: right-click beyond the green area.** A destination further than the unit can get this turn
  (or any destination when it has no movement left, or in the battle phase) becomes a standing order: it goes as far
  as it can now, and at each End turn it carries on with the new turn's movement until it arrives. Every leg is an
  ordinary move planned afresh from where it stands, so it boards a train whenever the railway is quicker (and walks
  to the station first if need be), pays No Man's Land, and is halted by a manned enemy trench (which ends the order).
  The route shows as a dashed line in the unit's colour, split into one leg a turn (legs alternate light and full
  colour, a white bar and the turn number, "T34", where each turn's movement runs out) with a flag at the objective;
  the panel says where it is heading and the turn it arrives (**✕ Cancel** calls it off). The legs are worked out in
  the browser with the server's rules (rail planner, movement with research, No Man's Land) and land within a km of
  where the server stops the unit; the server re-plans each leg, so a railway cut or a front that moves changes the
  rest. A group keeps its shape, each unit marching at its own pace. Moving the unit by hand, or forming its corps'
  line, cancels the order; so does being attacked, which halts the unit and every marching unit of its corps (its
  side's log says so with a 🚩 line); an order across the sea is refused (a convoy is needed); only your own side sees your
  orders, fog of war or not. Each side's log gets a 🚩 line at End turn on how its marches went.
  (`POST /game/units/goal`, `DELETE /game/units/:id/goal`, End turn: `processMarches` in `server/routes/orders.js`.)
- **Panels open on right-click.** Right-click your own unit or hero (or pick it from the 🗺 Map panel list or the
  Nation panel) to open its panel; right-click an enemy with nothing of yours selected for its. Other markers open
  on a left-click as before. Railway sabotage stays in the panel: **⛓ Cut railway…**.
- Players no longer drag units or heroes while the game is running; the GM still can, to place things anywhere.
  Towns, resources and other markers drag as before, and outside game mode (or with movement limits waived)
  everything drags as it used to.
- **Trails.** Every move in game mode leaves a line in the unit's colour from where it started the turn, through
  each stop (and along the track for rail trips), with an arrow at its current position. Trails stay until End
  turn clears them. They are stored on the marker (`data.trail`), so everyone who can see the unit sees its trail.

## Log privacy (fix)

Log lines meant for some nations (spy reports, diplomacy in progress, trades, production and research notices)
were filtered on the live feed but shown to everyone when the Log was reloaded. They now carry their audience
(`data.audience`) and the Log honours it on reload too.
