# Chat, notifications, trades, pings and moving units

Built 30 Sep 2026. Client: `public/js/comms.js` (chat window, notification centre, trade dialog) and
`public/js/map.js` (click to move, pings); renderer pieces in `public/js/map-renderer.js`. Server: chats and
pings in `server/routes/lobbies.js`, trades in `server/routes/game.js` and `server/game.js`.

## Chat window (bottom right)

Rebuilt 4 Oct 2026. The **Chat** button (the envelope: open and read when nothing waits, a sealed letter with a
count when something does) opens a window with the channels and people down the left and the conversation on the
right; **⤢** makes it larger, **–** or `Esc` in the message box closes it. On phones it fills the screen and
**☰** shows the left column.

**Channels**
- **# OOC**: everyone's out-of-character chat; `/roll 2d6+3` works here. Dice rolls also appear in the Log.
- **📣 GM**: announcements. Everyone reads them; only the GM can send text or GIFs here.
- **📜 Log** is read-only game activity. Ordinary chat and announcements never appear there, including old
  messages loaded from storage. There is no Log composer; use OOC for dice commands.
- **Groups** (🔒): private chats with several people or a name. **Leave** (top right) removes you; the last one out
  deletes the chat.

**People**: every other member, the GM first, then whoever is online (green dot), with their nation's flag.
- **Click** someone for a private chat with them: an existing one opens, otherwise a draft that is created (and
  appears for them) when you send the first message. So an unsent click leaves nothing behind.
- **New group**, then select people (or Shift/Ctrl-click them): a bar above the conversation lists them, takes an optional
  name ("Entente talks") and **Start chat** opens the group (a nameless group with exactly the same people is
  re-used). On phones, **Done selecting** closes the people list to show this bar. Only members receive or can load a private chat's messages, the GM included: the GM sees one only when
  invited.

**Reading**
- **Read receipts.** Each chat keeps how far every member has read. Your own message shows ✓ when sent and ✓✓
  (gold) once everyone else in the chat has read it (hover for "Read by 2 of 3"); each other member's small
  avatar sits under the last message they have read, so in a group you see who has caught up to where. A chat is
  marked read only through messages actually visible in its focused, visible tab (not while loading or in
  the background). Acknowledgements are retried after failures and kept on the server across devices.
- **Unread counts** on each channel and person, and the total on the Chat button. Opening a chat puts a
  **New messages** line above the first message you had not read and scrolls to it.
- A **New messages / Latest messages** button lets you catch up without incoming messages pulling you away
  from older history. **Mark unread from here** in a message menu sets a reminder across devices.
- **"X is typing…"** under the conversation while someone else writes in it (nothing is stored).
- Messages are grouped by sender when less than five minutes apart, split by day (Today, Yesterday, a date), web
  addresses are links, and **Load earlier messages** at the top pages back 60 at a time. Enter sends, Shift+Enter
  starts a new line. Each conversation keeps its own unsent draft for the current page session. Failed sends
  stay in a separate **Retry / Dismiss** row, so newer typing is never overwritten; retries cannot duplicate a send.

**Mentions, replies and finding messages** (5 Oct 2026).
- Type `@` and choose a participant by username, display name or nation. Arrow keys select; Enter/Tab inserts
  their `@username`, Escape closes suggestions. The server resolves participants to stable user IDs; private
  chats cannot tag outsiders. Mentions are highlighted, with a separate `@` count on the Chat button.
- **Reply** in the message menu quotes a message. Clicking a quote opens the original with surrounding context.
  Deleted messages disappear from quoted previews too.
- Search the current conversation, open **@ Mentions**, or browse **Pins**. Results open the matching message;
  **More results** pages back. Members can pin private messages; the GM controls pins in OOC and GM (20 per chat).
- Each conversation has **All notifications**, **Mentions only**, or **Muted**. These control alerts, not unread
  counts, and are stored per user on the server. The global sound/desktop switch still applies.

**GIFs** (4 Oct 2026). With a KLIPY key on the server (`WOE_KLIPY_KEY`, from https://klipy.com/developers), the
message box has a **GIF** button: a picker with trending GIFs, a search box and **More**, "Powered by KLIPY" as its
terms ask. Clicking one sends it to the open chat (or starts a draft chat) as a message whose text is "GIF: title"
(that is what notifications show) and whose `data.gif` holds the picture; the chat draws it in the
bubble, up to 240 px, as a link to the full size. The key never reaches a browser: the server proxies the search
(`GET /api/klipy/trending|search?q&page`, `server/routes/klipy.js`) and only accepts GIFs from KLIPY's own file
store in a message. `WOE_KLIPY_FILTER` passes KLIPY's `content_filter` (e.g. `high`) when wanted. Without a key
there is no GIF button.

**Deleting messages.** Every message has a visible **⋯** menu, accessible by keyboard or touch. **Delete message** is there for a site
admin and for the campaign's owner on any message in the campaign, and for anyone on their own. The message stays
in place as *(message deleted by X)*, so pages and read marks keep their footing, and the chat's members see the
change at once; a GIF goes with it. A site admin or owner can also delete a message in a private chat they are not
in, by its id, which is how a reported message is removed (`DELETE /chats/:key/messages/:mid`).

**Reporting.** **Report X…** in the same menu (or right-click someone in the people list) opens a bar above the
conversation: the message quoted, a box for what happened, **Send report**. Reports go to the **site admins**
(not the GM): on the Site admin page (`/admin.html`, from the campaigns page) the *Reports* card lists each one with who reported whom, the
campaign, the reason and the message's text (kept with the report, so it survives the message's deletion), with
**Delete message**, **Open campaign** and **Close** (with a reason the reporter reads under *Notices* on their
campaigns page). A whole campaign can be reported too (abuse, racism, anything
that should not be on the site): **⚑** by it on the campaigns page. Site admins are the site's moderators, not game
masters: a GM never sees or closes reports, and a site admin is a member of a campaign like anyone, or not in it
at all (they join one as a player to look, and can delete any campaign or reported message from their page). Ten
reports an hour per person at most. Table `reports`; `POST /api/lobbies/:id/reports { userId | campaign: true,
reason, channel?, messageId? }`, `GET /api/auth/reports`, `POST /api/auth/reports/:id/close`,
`DELETE /api/auth/reports/:id/message`, `GET /api/auth/lobbies`, `POST /api/auth/lobbies/:id/join`,
`DELETE /api/auth/lobbies/:id` (site admin).

**Nothing is wiped between turns.** OOC and GM lines live in the lobby's events for good (End turn deletes
nothing); the old window only ever showed the Log's last 100 events of every kind, so after a turn's worth of
reports the chat looked emptied, and its private chats did not catch up after a dropped connection. The chat now
pages through its own lines, and after a reconnect (or coming back to a tab that was hidden for a while) it
fetches the chats afresh and the open one catches up through every missing page, including gaps over 200 messages.
Cached history is refreshed so deletions made while offline also disappear. Live updates arriving during a load
are merged by ID and preserved rather than overwritten.

API (one shape for all three kinds; a chat's key is `ooc`, `gm` or `c<id>`): `GET /api/lobbies/:id/chats`
(each with `lastId`, your `unread`, `mentions`, `myRead`, `notifications`, and the others' `reads`),
`POST /chats { members, name, clientId? }`, `GET /chats/:key/messages?limit&before|after`
(`more` follows the requested paging direction), with optional `q`, `mentions=1`, `pins=1`, or `around=<id>`;
`POST /chats/:key/messages { message | gif, replyTo?, clientId? }`, `POST /chats/:key/read { lastId }`,
`POST /chats/:key/unread { beforeId }`, `PATCH /chats/:key/preferences { notifications }`,
`POST /chats/:key/messages/:mid/pin { pinned: true|false }`, `POST /chats/:key/leave`,
`DELETE /chats/:key/messages/:mid`. The legacy `POST /chat` still posts to rooms.
Message `data` can carry `gif`, `deleted`, `mentions`, `replyTo`, and `clientId`; serialized messages include
`reply` and `pinned`. Tables: `chat_channels`, `chat_messages`, `chat_reads`, `chat_preferences`, `chat_pins`,
`chat_requests`. Room history keeps its existing event IDs for compatibility; `/events` excludes chat and announcements.
WebSocket: `chatChannel`, `chatMessage` (with `update: true` for deletion/pin changes), `chatRead`,
`chatPreference`, `chatLeft` (restricted to the appropriate members/user); `typing` is permission checked and
throttled. Rolls also broadcast a Log `event`; ordinary chat/announcements use only `chatMessage`.

Regression checks: `npm run test:chat`. Tests use a disposable database and cover authorization, Log separation,
mentions/replies/pins, retry deduplication, paging, read acknowledgements, reconnects, drafts and URL formatting.
Supporting modules: `server/chat.js` (metadata/queries) and `public/js/chat-model.js` (merging/formatting).

## Notification centre (top centre)

The ✉ envelope button (`public/icons/mail-read.png` when everything is read, `mail-new.png`, a fresh letter, when
something waits) counts what needs you, and shakes (with a toast and, if switched on, a desktop alert) when
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

**Clear all** (top right of the list) dismisses every notice that needs no answer: the news of wars made, trades
done, convoys landed. Anything waiting for your answer stays until you answer it; your own pending offers stay until
they are answered or withdrawn. Dismissals are remembered per browser.

The 🔊 / 🔇 toolbar button still switches sound and desktop alerts on and off.

## Trades

**＋ Offer a trade…** on the 🤝 Diplomacy panel offers another nation goods: any resource, consumer or military goods,
money, manpower or research points, in either direction ("4 coal for 25 money"). Consumer and military goods come
out of the giver's fullest town stores and go into the taker's capital (or biggest town); End turn spreads them over
its network (docs/ECONOMY.md). The GM can offer trades between any two nations.

The dialog (rebuilt 4 Oct 2026) sets the two offers side by side under the two flags, **My offer** against
**Their offer**, with a row for every tradeable stock (treasury, every resource, the goods): a slider from nothing
up to what is in the stockpile, and a box for typing any amount (the slider stretches to it). Your own stocks are
shown; the other nation's when treasuries are public (or for the GM), else "?". A row is lit while it carries an
amount, turns red when it asks more than the stock holds (the server refuses such a trade at acceptance, so this
is only a warning), and the two summary bars read the offer back ("You give 20 coal, 100 money · France gives 1
rubber"). Below: once or every turn for N turns, and a note.

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
