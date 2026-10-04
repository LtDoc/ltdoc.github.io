# Supply, support units and matchups

Built 30 Sep 2026. Phased turns, worn units, replacements, corps, engineers' trenches, blockades and submerged
submarines (3 Oct 2026): docs/WARFARE.md. Shared matchup table: `public/js/matchups.js`. Supply and support rules: `server/supply.js`;
End-turn hooks and movement/attack checks: `server/game.js`; combat: `server/routes/lobbies.js` (`POST /combat`).
All distances and bonuses are campaign rules (⚖ Rules → Supply & support).

## Supply

Every land unit (infantry, mounted, artillery, support, and custom types) is either **linked** to supply or **cut
off**, and carries **supplies for 3 turns** (**3/3**; ⚖ Rules → Supply carried, `supplyStock`). Linked, it is topped
up to 3/3 at once. Cut off, it lives on what it carries, using one at each End turn, and it moves and fights as usual
meanwhile: room for a breakthrough or a wide flank to outrun its columns for a while. Only at **0/3** is it **out of
supply** (below). Ships, aircraft, heroes and **emplacements** do not need supply.

## Emplacements

Fixed works, in their own category: they never move (movement 0), need no supply (never cut off, no attrition) and
count as **entrenched** for every matchup. They are drawn in grey concrete pits, the MG bunker and fortress behind
wire.

| Type | Attack / defend / range | Notes |
|---|---|---|
| Coastal battery | 9 / 6 / 5 | was Artillery; shells, +2 against ships, returns fire on ships that attack it (tech: Coastal batteries) |
| Fortress guns | 8 / 9 / 4 | turret guns of a fortress; shells, +2 against ships, returns fire on ships that attack it |
| MG bunker / pillbox | 3 / 10 / 1 | concrete machine-gun post: counts as machine guns in matchups (tech: Concrete pillboxes, 1916) |
| AA emplacement | 4 / 6 / 3 | fixed anti-aircraft guns: +4 against aircraft (tech: Fixed anti-aircraft defences, 1915) |

Coastal batteries, fortress guns and AA emplacements fire from range like artillery (`UnitTypes.firesFromRange`):
they shell their target, are spared the reply when repelled, and signals units spot for them. Heavy, siege and
railway guns get +1 against any emplacement.

- **Towns are the nodes.** A unit in a friendly town (its nation's or an ally's) is supplied directly, as a
  garrison: anywhere in the town's drawn streets, or within **30 km** of its centre, whichever reaches further (a
  capital is drawn up to ~55 km from its centre north to south on the Earth map, so the 30 km alone left part of it
  unsupplied). A **blockaded** port (enemy warships within 50 km, none of its side's) supplies nothing
  until the blockade is lifted (docs/WARFARE.md).
- **Supply Columns carry it forward.** A Supply Column (unit type *Supply / logistics*) is **linked** when a
  friendly place is close enough for its size: **capitals within 600 km, cities within 400 km, villages within
  200 km**. A column is also linked within **150 km** of open friendly
  **railway** connected to a friendly place (a railhead; cut or enemy-held track does not count) or of another
  linked column, so columns can chain forward.
- **Convoys supply invasions.** A convoy (unit type *Transports / convoy*) is a floating supply base that works
  anywhere, independent of home places: it supplies friendly land units within **100 km** (a beachhead) and
  feeds Supply Columns within **200 km**, which can then chain inland.
- **Convoys carry troops.** Up to **10** land units or heroes within **30 km** of a convoy embark on it (the
  convoy's card: **⛴ Embark nearby**; a unit's card: **⛴ Board …**). Aboard they leave the map and sail with it:
  they cannot move, fight or be attacked, need no supply and hold no ground. **⚓ Land troops** puts everyone ashore
  at once on the nearest beach within **100 km** of the convoy; with no beach that close they stay aboard. Landing
  on enemy ground takes it like any advance (defended ground holds). Boarding and landing each use up the units'
  move for the turn. If the convoy is **sunk or removed, everyone aboard goes down with it**. Rules: ⚖ Rules →
  Supply & support → Troops at sea (`convoyCapacity`, `convoyBoardKm`, `convoyLandKm`).
- **Allies share convoys, by request.** Whichever side acts asks the other, and nothing happens until it agrees
  (🔔 notifications: **Allow** / **Refuse**; the asker can **Withdraw**):
  - a convoy's nation embarking an ally's units asks that ally; an ally's player boarding its own units onto
    the convoy (**⛴ Ask to board**) asks the convoy's nation;
  - landing with allied troops aboard asks every nation with troops aboard; an ally with troops aboard can ask
    the convoy's nation to land them (**⚓ Ask to land**).
  On approval the move is made then, if it still can be (in reach, room aboard, a beach close enough). Once
  aboard, the convoy's nation sails it as usual; the troops stay their own nation's and are theirs again
  ashore. Requests lapse at End turn. The GM acts directly, no request needed.
- **Columns chain.** A column within **150 km** of another linked column is linked through it, so a string of
  columns carries supply as far from a place, railhead or convoy as you like (each one supplies its own 100 km).
- **A linked column supplies** friendly land units within **100 km**: its stretch of front. A column itself is
  supplied when linked.
- **Live:** supply is recomputed whenever something that can move a supply line changes (a unit or place is
  moved, created, removed or changes hands, a railway is cut or repaired, war or an alliance changes) and every
  open map gets the new status at once. Bringing a column up, or marching into a friendly town, tops a unit up to
  3/3 that turn, so a unit out of supply can move and fight again. End turn, switching game mode on and
  **Recalculate supply now** also recompute it.

A **cut-off** unit with supplies left (amber badge, a dot for each turn's worth; its panel: "2/3 · CUT OFF") moves
and fights normally, but gets no replacements and no hospital care, and uses one turn's supplies at each End turn.

An **out-of-supply** unit (cut off at 0/3):
- cannot move (the move is refused; clicking it shows a red ring and says why);
- cannot attack or sabotage railways;
- takes **double losses** when an attack on it succeeds;
- gets no healing from field hospitals or medical tech;
- suffers **attrition** at each End turn still cut off: it loses **25 %** of its remaining strength each turn
  (100 → 75 → 56 → 42 …); below **10 %** it **surrenders**: strength 0, a **white flag** over the counter instead
  of smoke. Its panel counts the turns cut off; turn reports list the strength lost and any surrender. Getting
  supply back tops it up to 3/3 and resets the count.

So a unit cut off from turn 1 lives on its supplies through three End turns and first loses strength at the
fourth. It shows a red no-entry badge and is slightly dimmed; its panel says "0/3 · OUT OF SUPPLY". A supplied unit's panel
says where its supply comes from ("supplied by 2nd Supply Column"), and selecting it draws its supply line: a
dashed amber line through each column back to the place, convoy or railhead it starts from. Turn reports list each
nation's cut-off units with what they have left ("cut off (9e RI 1/3)"). The GM is never limited, and the rules switch turns supply off entirely.

## Support units

Support units help friendly units (their nation's and allies') around them while they are alive and not out of
supply (a cut-off one still works while it has supplies left).
Selecting one shows its reach on the map; its panel says what it does.

| Unit | Effect | Reach |
|---|---|---|
| Transports / convoy | supplies land units (above), anywhere | 100 km (feeds columns within 200 km) |
| Supply / logistics (Supply Column) | supplies land units (above) | 100 km (fed from capitals 600 km, cities 400 km, villages 200 km) |
| Medical / field hospital | heals damaged units by 10 % strength at each End turn (not destroyed ones) | 40 km |
| Headquarters | +1 attack and +1 defend | 40 km |
| Engineers, pioneers, sappers | +1 defend; engineers and pioneers dig and reinforce trenches, sappers blow up enemy ones and wreck resource works (docs/WARFARE.md) | 20 km |
| Signals | +1 attack for artillery (spotting) | 60 km |

The best support unit of each kind counts once; these stack with generals, tech and trench cover, and appear in
the combat log ("attacker +1 Corps HQ").

## Matchups

Strengths and weaknesses are added to the attacker's roll, capped at ±5 in total. The unit panel lists a type's
strengths and weaknesses, the attack dialog shows the modifier against each target, and the combat log names
each rule that applied. "Entrenched" means the defender has trench cover, or is an emplacement.

| Attacker | Defender | Modifier |
|---|---|---|
| Cavalry (all mounted horse types, camels, reconnaissance) | entrenched troops | −3 |
| Cavalry | machine guns (and MG bunkers) | −3 |
| Cavalry | artillery | +3 |
| Cavalry | support troops | +2 |
| Infantry (not machine guns) | machine guns (and MG bunkers) | −2 |
| Machine guns | cavalry | +2 |
| Stormtroopers | entrenched | +2 |
| Tanks | entrenched / machine guns / artillery | +2 / +2 / −1 |
| Armoured cars | entrenched / cavalry | −2 / +2 |
| Field and horse artillery | entrenched | +1 |
| Heavy, siege, railway guns, mortars | entrenched | +2 |
| Gas troops, sappers | entrenched | +2 |
| Coastal batteries, fortress guns | ships | +2 |
| Heavy, siege, railway guns | emplacements | +1 |
| Anti-aircraft, AA emplacements | aircraft | +4 |
| Aircraft | anti-aircraft | −2 |
| Fighters | bombers, airships, spotters | +2 |
| Infantry, mounted troops | aircraft | −3 |
| Submarines | transports, minelayers / capital ships | +3 / +2 |
| Torpedo boats | capital ships | +2 |
| Destroyers | submarines, torpedo boats | +3 |
| Capital ships | destroyers, torpedo boats | −1 |

## Men and machines in a fight

While an infantry unit (any type in the Infantry category: line infantry, conscripts, marines…) is in a battle this
turn, a section of 8 men fights on the map from 800 % zoom, spread out about its line rather than on it: from a
little ahead of it to well behind. Living men = strength ÷ 12.5, rounded up (100 % → 8, 74 % → 6, 50 % → 4,
0 → none); the rest lie dead where they were (only those lost in this turn's fighting: men lost before lie where
they fell then). Purely visual: nothing here changes combat. Code: `public/js/skirmish.js`, wired in by
`MapRenderer._tickBattles`.

**Out of a fight** every land unit on screen (infantry, guns, tanks, cavalry) still stands on the map from 800 %
zoom: its living men and machines at ease about a line 62 px ahead of its token, 110 px wide, facing the nearest unit
of another nation within about 60 map px (else the way it last moved, else down the screen). Riflemen stand about,
looking this way and that (in their pits, behind their wire, once dug in); guns stand with their crews, tanks parked,
horsemen formed up with the echelon closed up. Nobody fires. Going into a fight, each man runs (a tank rolls, a rider
walks his horse) from where he stands to his place on the line; when it ends, back. Squads at ease are still pictures:
they ask for frames only while someone is moving.

**The dead** stay on the field for the turn of the fight and the next two (`REMAINS_TURNS` = 3 in skirmish.js and
server/game.js; 30 minutes outside game mode), drawn under the living from 800 % zoom, a little darker each turn:
- When a squad leaves its fight (End turn, the fight over, the unit gone) its dead are left where they lay, men and
  fallen riders with their dead horses, placed by the unit's token where it stood plus an offset in screen px, so
  they keep with the figures at every zoom. Each browser keeps them in localStorage (`woe.remains.<campaign>`, 1,500
  at most).
- Fights a browser did not see are laid out from the server's record: every battle stores `losses` (each side's
  strength before and after, unit type and nation) and is kept for those turns (End turn deletes older ones);
  `GET /api/lobbies/:id/battles` returns them as `past`. Each side loses as many men as its strength crossed
  12.5 % steps, laid out on its line as it stood (riders strewn between the lines, by their horses).

**Armies.** Every faction fights as one of eight armies: **American**, **ANZAC**, **Arab**, **British &
Commonwealth**, **French**, **German**, **Ottoman** or **Russian**. The GM picks it on the faction (👥 People →
faction → *Army*); left on *Automatic* it comes from the name:
- German: Germany, Austria-Hungary, Bulgaria and the northern neutrals.
- Ottoman: the Ottoman Empire (Turkey).
- British: the Empire and the other Dominions, Japan, Portugal and Egypt.
- ANZAC: Australia and New Zealand.
- Arab: Arabia (Hejaz, Nejd, Yemen, Oman, the Gulf), and the Senussi.
- French: France, Belgium and French North Africa.
- Russian: Russia, Italy, the Balkans, Greece, China and Persia.
- American: the Americas, the Philippines and Liberia.

Factions saved with the old colours read grey as German, beige as British and green as American.

The kit follows the game's date. Before 1916 the men wear 1914 dress: soft caps, the pickelhaube, French blue
coats, the ANZACs' slouch hats and lemon-squeezers (Australians and New Zealanders together, in shirtsleeves as at
Gallipoli). From 1916 they wear steel helmets and horizon blue, and the Lewis gun, Chauchat and MG 08/15 appear.
The Ottomans keep their early-war kit until 1918, then wear their 1918 kit. German greatcoats and British winter
dress are worn from November to February. American, Arab and Russian kits do not change.

**The section.**
- An officer, a sergeant (or corporal), a light machine-gunner (where the army and year have one, firing in
  bursts), a medic and riflemen. Who is who changes from unit to unit.
- Each man lies, kneels or stands to aim at the enemy. Now and then one gets up and rushes to a new spot, forward
  or back and across (three at most at a time, never more than a quarter of the way to the enemy).
- **Fire comes only from the men and guns.** Each round leaves the muzzle of the man or gun that fired it, with a
  flash, as a tracer that flies at one of the enemy's men or machines (else at his line) and kicks up dust where it
  lands. Rates of fire are the weapons' own:
  - riflemen fire aimed rounds at a bolt-action rate, 10 to 15 a minute each (officers slower);
  - light machine guns fire bursts of 4 to 9 at their cyclic rates: Lewis and BAR 550 a minute, MG 08/15 500, the
    Chauchat 240 (bursts of 3 to 5);
  - machine-gun teams fire bursts of 10 to 20 with 2 to 4 s between them, at 450 a minute (Vickers, MG 08,
    Hotchkiss), 500 (Browning M1917) or 550 (Russian Maxim);
  - field guns and tanks firing over open sights send a shell along the same way.
  Units drawn this way have no other firing line; units drawn without figures keep the plain
  firing line from their token.
- **Dug in.** A unit that stays put digs in: End turn counts the turns it has held its ground (`heldTurns`, reset
  when it moves). After one turn each man fights from his own rifle pit, the spoil heaped up in front and topped with
  sandbags, and stays in it (no more rushing about); guns sit in sandbagged pits, machine guns and mortars behind a
  ring of sandbags. After two turns, or when the defender fights from a trench line, a belt of concertina wire on
  pickets runs across its front, and cavalry charging it slow to a struggle while they get through the wire.
- **Rout and surrender.** A section that loses a quarter of its strength or more in one blow breaks: its men run
  back 40–75 px behind the line in disorder, hold there a few seconds, then work their way back to their places.
  A section destroyed outright does not all die: its last men (three at most) give up, one waving a white rag on a
  stick, and are marched off towards the enemy's line, fading from sight.
- **Gas.** Gas troops (Gas / chemical troops) attack with a cloud instead of a firing line: a row of cylinders on
  their line hisses out yellow-green gas for a few seconds, and the cloud rolls downwind across to the enemy at
  about 18 px a second, swelling and thinning, lingers over his line and clears; then the cylinders are opened
  again (every 26 s). Men in the cloud take on a sickly cast (masks on) and stop firing until it thins.
- The medic kneels on the line until someone falls, then runs out to the fallen and kneels by him a while, an
  empty stretcher laid beside them. Then the stretcher party carries the wounded man back to the aid post behind
  the line (the medic at the head, a second bearer at the foot, 12 px/s), where he is taken away; the medic goes
  back to his place. Stretchers from the misc-03 sprite sheet. The ANZAC medics are stretcher bearers; the Arab and Ottoman art has no medic, so they have none.
- The Arabs' leader is the fighter in red with a revolver.
- Assault regiments (stormtroopers) go in as the army's assault troops: German stormtroopers with carbines and
  MP 18s, British and American trench raiders, Russian shock troops. French colonial troops go in as zouaves. Where
  the army has no such figures, they fight in its line kit.

**Machine-gun companies and trench mortars** go in as four teams along the line, each gun drawn with its crew: the
Vickers, MG 08, Hotchkiss, Browning and Maxim; the Stokes, the French mortar and the Minenwerfer. Machine guns fire
in bursts and mortars thump and smoke (a mortar battery's bombs leave from its teams). Two men per team fall like
riflemen and lie beside the gun. When both are down the gun is left standing empty, as the abandoned-gun art, and
falls silent. The Russians have no mortar team, so theirs is the mortar from the gun sheet, crewed by Russians;
nor do the ANZACs, Arabs and Ottomans. Their machine-gun teams have no
abandoned art, so an uncrewed one goes grey.

**The figures.** Atlas: `public/assets/soldiers.png`, built by `node scripts/build-soldiers.js "rob assets"` from
the folders American Infantry, Anzac Infantry, Arab Infantry, Commonwealth Infantry, French Infantry, German
Infantry, Ottoman Infantry and Russian Infantry.
- The script sorts each file by its name into a kit (army, year, season, or the assault/zouave set) and a role
  (rifleman lying/kneeling/standing/advancing, officer, NCO, light machine-gunner, medic, casualty, gun crew, MG or
  mortar team crewed/empty). Where a kit lacks a role, the next best figure stands in.
- Scale: each army's figures keep their sizes against each other. The armies are brought to one size by their
  riflemen's torsos, so a man is about 7 px across and about 20 px lying full length (before the zoom boost).
- Facing: figures face up the page, as drawn. Aimed rifles face along the rifle. The Vickers and MG 08 point their
  barrels up and to the right. The few exceptions are listed in the script.
- Not used: snipers, highlanders, the bagpipers, the anti-tank rifle, the flamethrower, and the Russian field gun.
  The field gun is drawn to true scale, far bigger than the map's guns.

Other units in a battle (attacking or attacked, gunfire or shelling) show their own kit on the same line:

- **Artillery**: four guns spread along the line, each worked by two men of the nation's army. Field guns,
  anti-aircraft and AA emplacements use the field gun, heavy and coastal batteries and fortress guns the heavy gun, siege batteries and railway guns the
  siege gun, horse artillery the horse-drawn gun (and trench mortars and machine guns, for an army without teams, the
  mortar and the Maxim). Guns recoil, flash and smoke as they fire, and a battery's shells leave from one of its
  guns. The eight crew fall like riflemen (one per 12.5 % lost); a gun whose two crew are both down goes grey and
  silent.
- **Tanks**: two, rolling out from the unit to the line and firing every few seconds; one is knocked out (dark,
  smoking) at 50 % strength, both at 0. Each nation has its own tank design from the tank sheet.

Guns and tanks are sized against the soldiers (a field gun about twice a soldier's length, a tank about three
times). Atlas: `public/assets/machines.png`, cut by `node scripts/build-machines.js "rob assets"` from Tank.png,
FieldArtillery.png, HeavyArtilleryBattery.png, SiegeBattery.png, TrenchMortarBattery.png, HorseArtilleryBattery.png
and HeavyMG.png.

### Cavalry and aircraft in a fight

- **Cavalry** (cavalry, dragoons, lancers/uhlans, hussars, reconnaissance): eight horsemen of the nation's army
  form up on the unit's line in echelon (each rider beside the next and a little behind him, the line slanting back
  to one side), then charge: from a canter up to the gallop (about 50 px a second on screen), kicking up dust,
  straight through the enemy's line and on well past it. Each rider then swings round in a wide loop out beyond the
  troop's flank and canters back to his place, coming in from behind; when all are back, the troop stands a few
  seconds and charges again. A troop that has just attacked rides straight out of its unit at the enemy. Riders fall like riflemen (one per 12.5 % lost) and lie where they fell, as the army's casualties,
  each beside his dead horse (one of five, from DeadHorses.png; camel riders fall without one).
  British and ANZAC riders wear khaki, Germans field grey, Americans olive, the French horizon blue and the
  Ottomans their own khaki. Russians ride the Russian set's own horseman. Arabs ride camels, half with rifles and
  half with sabres. Their tokens fire no rifle
  line: the charge is their attack.
- **Balloons and airships.** An observation balloon rides on its tether above a winch lorry, swaying, its basket
  hanging below, with its shadow on the ground (from 800 % zoom, in a fight or not); heavy, siege and railway guns
  that are shelling put up a spotter balloon behind the battery. A balloon that loses half its strength is shot down
  in flames: it burns from end to end, drops, and smoulders where it fell. An airship (Zeppelin) slowly circles its
  unit; attacking, it circles over the target and drops a bomb every few seconds.
- **Flak.** Anti-aircraft guns fighting aircraft or balloons fire every 1.5–3 s, each shell bursting as a flash and
  a ball of black smoke in the sky close to one of the enemy's planes.
- **Aircraft** (fighter, bomber, reconnaissance and seaplane squadrons): four planes flying above the units, each with
  a shadow on the ground, from 800 % zoom, in or out of a fight.
  - Out of a fight they circle over their unit, one behind the other.
  - Against ground units or ships they make strafing runs over the target: in from about 120 px out, guns firing as
    they close (tracer, and dust where the rounds strike), over the top, then a turn back for another pass from a
    new angle. Bombers drop a stick of three bombs over the target instead.
  - Against another air unit both squadrons meet over the defender and dogfight: each plane chases an enemy (aiming
    a little ahead), fires when it has it close and in its sights, and breaks hard to one side now and then when an
    enemy is on its tail.
  - One plane is lost per 25 % of strength: the plane being chased (if any) is shot down, spins away trailing black
    smoke, drops to its shadow and bursts on the ground. Healing brings one back in from out of sight.
  - Each nation flies its own livery, every plane in it painted alike. Germany flies grey with crosses, Austria-Hungary
    olive with crosses, the Ottomans sand with crosses, Britain olive with roundels, France khaki with tricolour
    roundels, the United States silver, Russia green, Belgium linen and Italy splinter camouflage. Every other nation
    takes the next livery not yet flown on its side: crosses for the Central Powers and field-grey nations, roundels
    for the rest, then unmarked schemes. Factions are taken in order, so two nations rarely look alike.
  - There are no rifle lines in a fight with an air unit; ground units under attack still fire from their squads.

Atlas: `public/assets/mounts.png`, cut by `node scripts/build-mounts.js "rob assets"` from Cavalry.png (recoloured
into field grey, olive, horizon blue and Ottoman khaki), the Russian Infantry folder's cavalryman, the Arab Infantry
folder's two camel riders (turned to face up the page like the horses), the five dead horses of DeadHorses.png
(at full size, lying on their sides, saddle up), and Army Assets/PlaneSprites.png. The 36 planes are sorted by eye into 23
liveries; the table is at the top of the script.

### Ships in a fight

Every naval unit is a squadron or flotilla of its class, shown from 800 % zoom, in or out of a fight:

| Unit | Ships | Picture |
|---|---|---|
| Dreadnought / battleship | 2 | Battleship.png |
| Pre-dreadnought | 2 | Predreadnought.png |
| Battlecruiser | 2 | Battlecruiser.png |
| Armoured cruiser | 3 | ArmouredCruiser.png |
| Light cruiser | 3–4 | LightCruiser.png |
| Destroyers | 6–7 | DestroyerSprites.png (one design per nation) |
| Torpedo boats | 6–8 | TorpedoBoat.png |
| Submarine / U-boat | 4–6 | SubSprites.png (one design per nation) |
| Minelayer / minesweeper | 2–3 | TorpedoBoat.png |
| Gunboat / river monitor | 3–4 | TorpedoBoat.png |
| Transports / convoy | 5–6 | CargoConvoy.png (a mix of freighters) |
| Seaplane carrier | 1 | CargoConvoy.png (a converted merchantman) |

Where there is a range, each unit keeps its own number. Gunboat.png, Minelayer.png and TorpedoBoat.png are the same
picture, so the small craft share it.

- **Formation:** the ships lie in loose formation around their token (in a fight, around their line, a little ahead
  of it), one behind the other down the screen. The art is in profile, so ships face left or right, never up or
  down. In a fight their bows point at the enemy; out of one, the way the unit last moved. Each rolls a little,
  with a bow wave and foam streaming astern. Submarines run submerged: faint and blue-grey.
- **Gunfire:** in a fight, ships fire salvoes on their own clocks, with flashes along the deck and gun smoke. The
  shells land after their flight time as splashes around the enemy's line, or as bursts if he is ashore.
  - Capital ships fire four guns a salvo, cruisers three, destroyers and gunboats two, the rest one.
  - Freighters and submarines do not fire guns.
  - When a ship unit bombards at range, its shells fly from one of its ships along the usual shell arcs.
- **Torpedoes:** destroyers, torpedo boats and submarines loose them now and then. A short pale track runs out to the
  enemy and ends in a column of water, sometimes with a hit.
- **Losses:** one ship per share of the unit's strength (a two-ship squadron loses one at 50 %). The ship lists,
  burns, smokes, settles and goes down, leaving a ring of foam and an oil slick that spreads, burns for two minutes
  and fades over a quarter of an hour, wreckage drifting in it. Repairs bring a ship back.
- **Gun lines:** naval units' tokens draw no rifle-fire line; their ships do the fighting.

Atlas: `public/assets/ships.png`, cut by `node scripts/build-ships.js "rob assets"` (sheets split into ships at the
emptiest line between them, shrunk by half). Ship sizes are not to true scale: a battleship is about 84 px long
(before the zoom boost) and a destroyer 40 px, sized against the guns and tanks.

## Campaign rules

Supply on/off · a place feeds a column within: capital (600 km), city (400 km), village (200 km) · column supplies
within (100 km) · railhead / column chain (150 km) · garrison within a place (30 km) · convoy feeds columns within (200 km) ·
convoy supplies units within (100 km) · supplies carried (3 turns) · attrition (25 % a turn once out of supplies) · surrenders below (10 %) ·
hospital heals within (40 km) and by (10 %) · HQ within (40 km) and bonus (+1) · engineers within (20 km) and
+defend (1) · signals within (60 km) and +artillery attack (1).
