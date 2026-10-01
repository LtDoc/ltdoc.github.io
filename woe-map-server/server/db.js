'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.uploadsDir, { recursive: true });

const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'player',   -- 'admin' (site admin) | 'player'
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS lobbies (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  join_code    TEXT NOT NULL UNIQUE,
  owner_id     INTEGER NOT NULL REFERENCES users(id),
  map_file     TEXT,
  map_width    INTEGER NOT NULL DEFAULT 0,
  map_height   INTEGER NOT NULL DEFAULT 0,
  scale_label  TEXT NOT NULL DEFAULT 'km',
  units_per_px REAL NOT NULL DEFAULT 1,
  settings     TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lobby_members (
  lobby_id  INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'player',        -- 'gm' | 'player'
  nation    TEXT NOT NULL DEFAULT '',
  color     TEXT NOT NULL DEFAULT '#3498db',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (lobby_id, user_id)
);

CREATE TABLE IF NOT EXISTS factions (
  id         INTEGER PRIMARY KEY,
  lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#3498db',
  flag_file  TEXT,                                 -- uploaded flag in uploads/
  flag_asset TEXT,                                 -- bundled flag file name in public/flags/
  created_at INTEGER NOT NULL,
  UNIQUE (lobby_id, name COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS markers (
  id         INTEGER PRIMARY KEY,
  lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,                        -- 'unit' | 'town' | 'poi' | 'player'
  name       TEXT NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  icon_file  TEXT,
  icon_url   TEXT,
  color      TEXT NOT NULL DEFAULT '#3498db',
  admin_only INTEGER NOT NULL DEFAULT 0,
  visible_to TEXT,                                 -- JSON array of nation names, NULL = everyone
  owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_markers_lobby ON markers(lobby_id);

CREATE TABLE IF NOT EXISTS shapes (
  id         INTEGER PRIMARY KEY,
  lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                        -- 'line' | 'area'
  label      TEXT NOT NULL DEFAULT '',
  points     TEXT NOT NULL,                        -- JSON [[x,y],...]
  color      TEXT NOT NULL DEFAULT '#f1c40f',
  width      REAL NOT NULL DEFAULT 3,
  admin_only INTEGER NOT NULL DEFAULT 0,
  visible_to TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shapes_lobby ON shapes(lobby_id);

CREATE TABLE IF NOT EXISTS history (
  id          INTEGER PRIMARY KEY,
  lobby_id    INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity      TEXT NOT NULL,                       -- 'marker' | 'shape'
  entity_id   INTEGER NOT NULL,
  action      TEXT NOT NULL,                       -- 'create' | 'update' | 'delete'
  summary     TEXT NOT NULL,
  before      TEXT,                                -- serialized entity before the change
  after       TEXT,                                -- serialized entity after the change
  reverts     INTEGER,                             -- history id this entry reverted, if any
  reverted_by INTEGER,                             -- history id that reverted this entry, if any
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_lobby ON history(lobby_id, id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,                        -- 'chat' | 'system' | 'roll' | 'combat'
  message    TEXT NOT NULL,
  data       TEXT,                                 -- optional JSON payload (rolls, combat results)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_lobby ON events(lobby_id, id);

-- ---- Game layer (docs/GAME-DESIGN.md) -------------------------------------------------
CREATE TABLE IF NOT EXISTS game (
  lobby_id   INTEGER PRIMARY KEY REFERENCES lobbies(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 0,
  turn       INTEGER NOT NULL DEFAULT 1,
  date       TEXT NOT NULL DEFAULT '1914-07-28',   -- ISO game date
  turn_step  TEXT NOT NULL DEFAULT 'week',         -- week | fortnight | month | season
  deadline   TEXT NOT NULL DEFAULT '',             -- free text shown on the HUD ("ends Sunday")
  settings   TEXT NOT NULL DEFAULT '{}',           -- rule overrides, see GameData.DEFAULT_SETTINGS
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS faction_state (
  faction_id INTEGER PRIMARY KEY REFERENCES factions(id) ON DELETE CASCADE,
  lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  resources  TEXT NOT NULL DEFAULT '{}',           -- { grain: n, coal: n, ... }
  money      REAL NOT NULL DEFAULT 0,
  manpower   REAL NOT NULL DEFAULT 0,
  rp         REAL NOT NULL DEFAULT 0,
  techs      TEXT NOT NULL DEFAULT '[]',           -- unlocked tech keys (phase 4)
  research   TEXT NOT NULL DEFAULT '{}',           -- active project + queue (phase 4)
  production TEXT NOT NULL DEFAULT '[]',           -- build queue (phase 3)
  mods       TEXT NOT NULL DEFAULT '{}',           -- GM per-turn modifiers { money, rp, manpower, resources: {..} }
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_faction_state_lobby ON faction_state(lobby_id);

CREATE TABLE IF NOT EXISTS turn_snapshots (
  id         INTEGER PRIMARY KEY,
  lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  turn       INTEGER NOT NULL,                     -- the turn that was ended
  data       TEXT NOT NULL,                        -- JSON: faction states (and later territories) before resolution
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_snapshots_lobby ON turn_snapshots(lobby_id, turn);

CREATE TABLE IF NOT EXISTS territories (
  id         INTEGER PRIMARY KEY,
  lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  faction_id INTEGER NOT NULL,                     -- factions.id, or 0 for neutral land
  geometry   TEXT NOT NULL,                        -- JSON multipolygon in map pixels
  updated_at INTEGER NOT NULL,
  UNIQUE (lobby_id, faction_id)
);

CREATE TABLE IF NOT EXISTS relations (
  lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  a          INTEGER NOT NULL,                     -- faction ids, a < b
  b          INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'peace',        -- peace | war | alliance
  since_turn INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (lobby_id, a, b)
);

CREATE TABLE IF NOT EXISTS diplomacy (
  id           INTEGER PRIMARY KEY,
  lobby_id     INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  from_faction INTEGER NOT NULL,
  to_faction   INTEGER NOT NULL,
  kind         TEXT NOT NULL,                      -- war | peace | alliance
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending (GM) | offered (other player) | accepted | blocked | declined | withdrawn
  note         TEXT NOT NULL DEFAULT '',
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_diplomacy_lobby ON diplomacy(lobby_id, id);

CREATE TABLE IF NOT EXISTS provinces (
  id         INTEGER PRIMARY KEY,
  lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT '',              -- state of the seed year the province was cut from
  subject    TEXT NOT NULL DEFAULT '',              -- that state's overlord (colonies), if any
  cx         REAL NOT NULL,                         -- centre in map pixels (capture and brush radii test this)
  cy         REAL NOT NULL,
  faction_id INTEGER NOT NULL DEFAULT 0,            -- owner, 0 = neutral
  geometry   TEXT NOT NULL,                         -- JSON multipolygon in map pixels
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provinces_lobby ON provinces(lobby_id);

CREATE TABLE IF NOT EXISTS turn_reports (
  id         INTEGER PRIMARY KEY,
  lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  turn       INTEGER NOT NULL,                     -- the turn that was ended
  faction_id INTEGER NOT NULL,
  data       TEXT NOT NULL,                        -- JSON: income, builds, research, places gained and lost (server/game.js)
  created_at INTEGER NOT NULL,
  UNIQUE (lobby_id, turn, faction_id)
);

CREATE TABLE IF NOT EXISTS techs (
  id          INTEGER PRIMARY KEY,
  lobby_id    INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  branch      TEXT NOT NULL DEFAULT 'General',
  name        TEXT NOT NULL,
  year        INTEGER NOT NULL DEFAULT 1914,
  rp          REAL NOT NULL DEFAULT 10,
  money       REAL NOT NULL DEFAULT 0,
  prereqs     TEXT NOT NULL DEFAULT '[]',              -- JSON array of tech keys
  effects     TEXT NOT NULL DEFAULT '[]',              -- JSON array, see server/research.js
  description TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  UNIQUE (lobby_id, key)
);

-- Battle effects on the map (gunfire, shelling) for the rest of the turn; End turn clears them.
CREATE TABLE IF NOT EXISTS battles (
  id          INTEGER PRIMARY KEY,
  lobby_id    INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  turn        INTEGER NOT NULL,
  attacker_id INTEGER NOT NULL,
  defender_id INTEGER NOT NULL,
  kind        TEXT NOT NULL,                       -- gunfire | shells
  ax REAL NOT NULL, ay REAL NOT NULL, dx REAL NOT NULL, dy REAL NOT NULL,   -- where both stood (if one is removed)
  hidden      INTEGER NOT NULL DEFAULT 0,          -- like the combat log line: GM and the attacker's player only
  user_id     INTEGER,
  until_ms    INTEGER,                             -- outside game mode there are no turns: effects expire
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_battles_lobby ON battles(lobby_id, turn);

-- Bundled tech additions already merged into a campaign's tree (server/research.js PATCHES).
CREATE TABLE IF NOT EXISTS tree_patches (
  lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  patch      TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (lobby_id, patch)
);

-- Resource trades between factions (docs/COMMS.md): one-time on acceptance, or recurring at each End turn.
CREATE TABLE IF NOT EXISTS trades (
  id           INTEGER PRIMARY KEY,
  lobby_id     INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  from_faction INTEGER NOT NULL,
  to_faction   INTEGER NOT NULL,
  give         TEXT NOT NULL DEFAULT '{}',           -- JSON { coal: 10, money: 50, ... } sent by from_faction
  take         TEXT NOT NULL DEFAULT '{}',           -- JSON, sent back by to_faction
  mode         TEXT NOT NULL DEFAULT 'once',         -- once | recurring
  turns        INTEGER NOT NULL DEFAULT 1,           -- recurring: number of deliveries
  turns_left   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',      -- pending | active | completed | declined | withdrawn | cancelled
  note         TEXT NOT NULL DEFAULT '',
  log          TEXT NOT NULL DEFAULT '[]',           -- JSON [{ turn, ok, text }] deliveries
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trades_lobby ON trades(lobby_id, id);

-- Private chats between members (docs/COMMS.md). OOC chat and GM announcements live in events.
CREATE TABLE IF NOT EXISTS chat_channels (
  id         INTEGER PRIMARY KEY,
  lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  members    TEXT NOT NULL DEFAULT '[]',             -- JSON array of user ids
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  last_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_channels_lobby ON chat_channels(lobby_id);
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY,
  lobby_id   INTEGER NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id, id);
`);

// ---- Lightweight migrations for databases created by earlier versions -------------
function addColumnIfMissing(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
addColumnIfMissing('markers', 'visible_to', 'TEXT');
addColumnIfMissing('markers', 'locked', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('shapes', 'locked', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('shapes', 'data', 'TEXT');   // per-kind extras (trench: facing, state, zigzag)
addColumnIfMissing('events', 'data', 'TEXT');
addColumnIfMissing('game', 'deadline_notified', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('provinces', 'year', 'INTEGER NOT NULL DEFAULT 0');   // borders year the province was cut from (0 = before this column: 1914)   // "<deadline>|<stage>" of the last reminder sent

function now() { return Date.now(); }

module.exports = { db, now };
