# Supply, support units and matchups

Built 30 Sep 2026. Shared matchup table: `public/js/matchups.js`. Supply and support rules: `server/supply.js`;
End-turn hooks and movement/attack checks: `server/game.js`; combat: `server/routes/lobbies.js` (`POST /combat`).
All distances and bonuses are campaign rules (⚖ Rules → Supply & support).

## Supply

Every land unit (infantry, mounted, artillery, support, and custom types) is either **supplied** or **cut off**.
Ships, aircraft and heroes do not need supply.

- **Towns are the nodes.** A unit within **30 km** of a friendly town (its nation's or an ally's) is supplied
  directly, as a garrison.
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
  open map gets the new status at once. Bringing a column up frees cut-off units the same turn, so they can
  move and fight again. End turn, switching game mode on and **Recalculate supply now** also recompute it.

A **cut-off** unit:
- cannot move (the move is refused; clicking it shows a red ring and says why);
- cannot attack or sabotage railways;
- takes **double losses** when an attack on it succeeds;
- gets no healing from field hospitals or medical tech;
- suffers **attrition** at End turn: the first End turn cut off costs nothing; from the second on it loses
  **25 %** of its remaining strength each turn (100 → 75 → 56 → 42 …); below **10 %** it **surrenders**:
  strength 0, a **white flag** over the counter instead of smoke. Its panel counts the turns cut off; turn
  reports list the strength lost and any surrender. Getting supply back resets the count.

It shows a red no-entry badge and is slightly dimmed; its panel says "OUT OF SUPPLY". A supplied unit's panel
says where its supply comes from ("supplied by 2nd Supply Column"), and selecting it draws its supply line: a
dashed amber line through each column back to the place, convoy or railhead it starts from. Turn reports list each
nation's cut-off units. The GM is never limited, and the rules switch turns supply off entirely.

## Support units

Support units help friendly units (their nation's and allies') around them while they are alive and supplied.
Selecting one shows its reach on the map; its panel says what it does.

| Unit | Effect | Reach |
|---|---|---|
| Transports / convoy | supplies land units (above), anywhere | 100 km (feeds columns within 200 km) |
| Supply / logistics (Supply Column) | supplies land units (above) | 100 km (fed from capitals 600 km, cities 400 km, villages 200 km) |
| Medical / field hospital | heals damaged units by 10 % strength at each End turn (not destroyed ones) | 40 km |
| Headquarters | +1 attack and +1 defend | 40 km |
| Engineers, pioneers, sappers | +1 defend | 20 km |
| Signals | +1 attack for artillery (spotting) | 60 km |

The best support unit of each kind counts once; these stack with generals, tech and trench cover, and appear in
the combat log ("attacker +1 Corps HQ").

## Matchups

Strengths and weaknesses are added to the attacker's roll, capped at ±5 in total. The unit panel lists a type's
strengths and weaknesses, the attack dialog shows the modifier against each target, and the combat log names
each rule that applied. "Entrenched" means the defender has trench cover.

| Attacker | Defender | Modifier |
|---|---|---|
| Cavalry (all mounted horse types, camels, reconnaissance) | entrenched troops | −3 |
| Cavalry | machine guns | −3 |
| Cavalry | artillery | +3 |
| Cavalry | support troops | +2 |
| Infantry (not machine guns) | machine guns | −2 |
| Machine guns | cavalry | +2 |
| Stormtroopers | entrenched | +2 |
| Tanks | entrenched / machine guns / artillery | +2 / +2 / −1 |
| Armoured cars | entrenched / cavalry | −2 / +2 |
| Field and horse artillery | entrenched | +1 |
| Heavy, siege, railway guns, mortars | entrenched | +2 |
| Gas troops, sappers | entrenched | +2 |
| Coastal batteries | ships | +2 |
| Anti-aircraft | aircraft | +4 |
| Aircraft | anti-aircraft | −2 |
| Fighters | bombers, airships, spotters | +2 |
| Infantry, mounted troops | aircraft | −3 |
| Submarines | transports, minelayers / capital ships | +3 / +2 |
| Torpedo boats | capital ships | +2 |
| Destroyers | submarines, torpedo boats | +3 |
| Capital ships | destroyers, torpedo boats | −1 |

## Men and machines in a fight

While an infantry unit (any type in the Infantry category: line infantry, conscripts, marines…) is in a battle this
turn, a section of 8 men holds its firing line on the map from 800 % zoom. Living men = strength ÷ 12.5, rounded up
(100 % → 8, 74 % → 6, 50 % → 4, 0 → none); the rest lie dead along the line. Purely visual: nothing here changes
combat. Code: `public/js/skirmish.js`, wired in by `MapRenderer._tickBattles`.

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
- Each man lies, kneels or stands to aim at the enemy, with a flash at each shot. Now and then one gets up and runs
  along the line.
- The medic kneels on the line until someone falls, then runs out to the fallen, kneels by them a while and
  comes back. The ANZAC medics are stretcher bearers; the Arab and Ottoman art has no medic, so they have none.
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

- **Artillery**: four guns spread along the line, each worked by two men of the nation's army. Field guns and
  anti-aircraft use the field gun, heavy and coastal batteries the heavy gun, siege batteries and railway guns the
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
  form up on the unit's line, charge the enemy's line at the gallop (kicking up dust), wheel among the enemy there
  for a few seconds, ride back and charge again. A troop that has just attacked rides straight out of its unit at
  the enemy. Riders fall like riflemen (one per 12.5 % lost) and lie where they fell, as the army's casualties,
  each beside his dead horse (one of five, from DeadHorses.png; camel riders fall without one).
  British and ANZAC riders wear khaki, Germans field grey, Americans olive, the French horizon blue and the
  Ottomans their own khaki. Russians ride the Russian set's own horseman. Arabs ride camels, half with rifles and
  half with sabres. Their tokens fire no rifle
  line: the charge is their attack.
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
  burns, smokes, settles and goes down, leaving a ring of foam. Repairs bring a ship back.
- **Gun lines:** naval units' tokens draw no rifle-fire line; their ships do the fighting.

Atlas: `public/assets/ships.png`, cut by `node scripts/build-ships.js "rob assets"` (sheets split into ships at the
emptiest line between them, shrunk by half). Ship sizes are not to true scale: a battleship is about 84 px long
(before the zoom boost) and a destroyer 40 px, sized against the guns and tanks.

## Campaign rules

Supply on/off · a place feeds a column within: capital (600 km), city (400 km), village (200 km) · column supplies
within (100 km) · railhead / column chain (150 km) · garrison within a place (30 km) · convoy feeds columns within (200 km) ·
convoy supplies units within (100 km) · attrition (25 % a turn from the 2nd turn cut off) · surrenders below (10 %) ·
hospital heals within (40 km) and by (10 %) · HQ within (40 km) and bonus (+1) · engineers within (20 km) and
+defend (1) · signals within (60 km) and +artillery attack (1).
