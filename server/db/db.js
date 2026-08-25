import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'app.db');

// better-sqlite3 won't create the parent dir, and data/ is gitignored (so absent on a
// fresh clone) — create it up front so first boot works without a manual mkdir.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Shipped wall-bot reminder template. A constant because the schema default, the migration
// default, and the stale-default refresh below all have to agree on the same string.
export const REMINDER_DEFAULT =
  'Check Walls /msg captunnel WALLS : Minutes since last checked: {minutes} by {player}';

// Sent in chat when someone logs a check.
export const CHECK_DEFAULT = 'Walls checked by {player} [{checks}]';

// Body of the Discord embed for a reminder. Discord renders markdown, so this can be richer
// than the in-game line, which has to stay a single sendable chat message.
export const DISCORD_REMINDER_DEFAULT =
  'Minutes Unchecked: **{minutes}**\nLast Checker: **{player}** (Total Checks: {checks})';

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label        TEXT NOT NULL,
    username     TEXT NOT NULL,
    auth_type    TEXT NOT NULL CHECK (auth_type IN ('offline','microsoft')),
    token_ref    TEXT,
    load_enabled INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    server_ip           TEXT    NOT NULL DEFAULT '',
    login_message       TEXT    NOT NULL DEFAULT '',
    world_change_message TEXT   NOT NULL DEFAULT '',
    login_delay_ms      INTEGER NOT NULL DEFAULT 4000,
    server_version      TEXT    NOT NULL DEFAULT '1.8.9',
    show_chat           INTEGER NOT NULL DEFAULT 1,
    auto_reconnect      INTEGER NOT NULL DEFAULT 1,
    sneak               INTEGER NOT NULL DEFAULT 0,
    anti_afk            INTEGER NOT NULL DEFAULT 0,
    offline_mode        INTEGER NOT NULL DEFAULT 0,
    spam_message        TEXT    NOT NULL DEFAULT '',
    spam_delay_ms       INTEGER NOT NULL DEFAULT 5000,
    spam_enabled        INTEGER NOT NULL DEFAULT 0,
    proxy_pool          TEXT    NOT NULL DEFAULT '',
    leaderboard_enabled INTEGER NOT NULL DEFAULT 0,
    leaderboard_command TEXT    NOT NULL DEFAULT '/f top',
    leaderboard_account TEXT    NOT NULL DEFAULT '',
    wall_enabled          INTEGER NOT NULL DEFAULT 0,
    wall_account          TEXT    NOT NULL DEFAULT '',
    wall_interval_ms      INTEGER NOT NULL DEFAULT 600000,
    wall_trigger          TEXT    NOT NULL DEFAULT 'check, checked, walls, wall',
    wall_require_verified INTEGER NOT NULL DEFAULT 1,
    wall_reminder_message TEXT    NOT NULL DEFAULT '${REMINDER_DEFAULT}',
    wall_check_message    TEXT    NOT NULL DEFAULT '${CHECK_DEFAULT}',
    wall_discord_message  TEXT    NOT NULL DEFAULT '${DISCORD_REMINDER_DEFAULT}',
    wall_chat_pattern     TEXT    NOT NULL DEFAULT '',
    wall_msg_command      TEXT    NOT NULL DEFAULT '/msg',
    wall_verify_password  TEXT    NOT NULL DEFAULT '',
    wall_to_minecraft     INTEGER NOT NULL DEFAULT 1,
    wall_to_discord       INTEGER NOT NULL DEFAULT 0,
    wall_discord_webhook  TEXT    NOT NULL DEFAULT '',
    wall_quiet_start      TEXT    NOT NULL DEFAULT '',
    wall_quiet_end        TEXT    NOT NULL DEFAULT '',
    raid_enabled          INTEGER NOT NULL DEFAULT 0,
    raid_trigger          TEXT    NOT NULL DEFAULT 'weewoo, raid, raided',
    raid_off_trigger      TEXT    NOT NULL DEFAULT 'weeoff, raidoff',
    raid_message          TEXT    NOT NULL DEFAULT 'RAID ALERT - DEFEND THE BASE',
    raid_delay_ms         INTEGER NOT NULL DEFAULT 15000,
    raid_to_discord       INTEGER NOT NULL DEFAULT 0,
    raid_discord_webhook  TEXT    NOT NULL DEFAULT '',
    check_to_discord      INTEGER NOT NULL DEFAULT 0,
    check_discord_webhook TEXT    NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS leaderboard (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    updated_at INTEGER NOT NULL,
    entries    TEXT    NOT NULL DEFAULT '[]'
  );

  -- Wall bot: per-player check counts, the running total, and the authorized-player roster.
  -- The player column is always stored lowercased (Minecraft names are case-preserving but
  -- not case-sensitive) so lookups can't miss on casing alone.
  CREATE TABLE IF NOT EXISTS wall_stats (
    user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    player      TEXT    NOT NULL,
    checks      INTEGER NOT NULL DEFAULT 0,
    raid_checks INTEGER NOT NULL DEFAULT 0,
    last_check  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, player)
  );

  CREATE TABLE IF NOT EXISTS wall_state (
    user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    total_checks  INTEGER NOT NULL DEFAULT 0,
    last_check_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS wall_players (
    user_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    player   TEXT    NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    label    TEXT    NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, player)
  );
`);

// ---- Lightweight migrations. CREATE TABLE IF NOT EXISTS won't add new columns to an
// already-existing DB, so ALTER in any settings columns that are missing. ----
{
  const cols = new Set(db.prepare(`PRAGMA table_info(settings)`).all().map((c) => c.name));
  const addColumn = (name, ddl) => { if (!cols.has(name)) db.exec(`ALTER TABLE settings ADD COLUMN ${ddl}`); };
  addColumn('proxy_pool', `proxy_pool TEXT NOT NULL DEFAULT ''`);
  addColumn('leaderboard_enabled', `leaderboard_enabled INTEGER NOT NULL DEFAULT 0`);
  addColumn('leaderboard_command', `leaderboard_command TEXT NOT NULL DEFAULT '/f top'`);
  addColumn('leaderboard_account', `leaderboard_account TEXT NOT NULL DEFAULT ''`);
  addColumn('wall_enabled', `wall_enabled INTEGER NOT NULL DEFAULT 0`);
  addColumn('wall_account', `wall_account TEXT NOT NULL DEFAULT ''`);
  addColumn('wall_interval_ms', `wall_interval_ms INTEGER NOT NULL DEFAULT 600000`);
  addColumn('wall_trigger', `wall_trigger TEXT NOT NULL DEFAULT 'check, checked, walls, wall'`);
  addColumn('wall_require_verified', `wall_require_verified INTEGER NOT NULL DEFAULT 1`);
  addColumn('wall_reminder_message', `wall_reminder_message TEXT NOT NULL DEFAULT '${REMINDER_DEFAULT}'`);
  addColumn('wall_check_message', `wall_check_message TEXT NOT NULL DEFAULT '${CHECK_DEFAULT}'`);
  addColumn('wall_discord_message', `wall_discord_message TEXT NOT NULL DEFAULT '${DISCORD_REMINDER_DEFAULT}'`);
  addColumn('wall_chat_pattern', `wall_chat_pattern TEXT NOT NULL DEFAULT ''`);
  addColumn('wall_msg_command', `wall_msg_command TEXT NOT NULL DEFAULT '/msg'`);
  addColumn('wall_verify_password', `wall_verify_password TEXT NOT NULL DEFAULT ''`);
  addColumn('wall_to_minecraft', `wall_to_minecraft INTEGER NOT NULL DEFAULT 1`);
  addColumn('wall_to_discord', `wall_to_discord INTEGER NOT NULL DEFAULT 0`);
  addColumn('wall_discord_webhook', `wall_discord_webhook TEXT NOT NULL DEFAULT ''`);
  addColumn('wall_quiet_start', `wall_quiet_start TEXT NOT NULL DEFAULT ''`);
  addColumn('wall_quiet_end', `wall_quiet_end TEXT NOT NULL DEFAULT ''`);
  addColumn('raid_enabled', `raid_enabled INTEGER NOT NULL DEFAULT 0`);
  addColumn('raid_trigger', `raid_trigger TEXT NOT NULL DEFAULT 'weewoo, raid, raided'`);
  addColumn('raid_off_trigger', `raid_off_trigger TEXT NOT NULL DEFAULT 'weeoff, raidoff'`);
  addColumn('raid_message', `raid_message TEXT NOT NULL DEFAULT 'RAID ALERT - DEFEND THE BASE'`);
  addColumn('raid_delay_ms', `raid_delay_ms INTEGER NOT NULL DEFAULT 15000`);
  addColumn('raid_to_discord', `raid_to_discord INTEGER NOT NULL DEFAULT 0`);
  addColumn('raid_discord_webhook', `raid_discord_webhook TEXT NOT NULL DEFAULT ''`);
  addColumn('check_to_discord', `check_to_discord INTEGER NOT NULL DEFAULT 0`);
  addColumn('check_discord_webhook', `check_discord_webhook TEXT NOT NULL DEFAULT ''`);
}

// Same problem one table over: CREATE TABLE IF NOT EXISTS won't add raid_checks to a wall_stats
// table that already exists.
{
  const cols = new Set(db.prepare(`PRAGMA table_info(wall_stats)`).all().map((c) => c.name));
  if (!cols.has('raid_checks')) {
    db.exec(`ALTER TABLE wall_stats ADD COLUMN raid_checks INTEGER NOT NULL DEFAULT 0`);
  }
}

// Changing a column DEFAULT does not touch rows that already exist, so an install created before
// the template changed would keep the old wording forever. Refresh it — but only where the stored
// value is still verbatim one of the defaults we previously shipped, so a message someone actually
// wrote is never overwritten.
{
  const SUPERSEDED_DEFAULTS = [
    'Wall check! Say "check" when done.',
    'Wall check! Last checked {minutes}m ago.',
  ];
  const refresh = db.prepare(
    `UPDATE settings SET wall_reminder_message = ? WHERE wall_reminder_message = ?`
  );
  for (const old of SUPERSEDED_DEFAULTS) refresh.run(REMINDER_DEFAULT, old);
}

const now = () => Date.now();

// ---- Users ----
export const createUser = db.prepare(
  `INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`
);
export function insertUser(email, passwordHash) {
  const id = randomUUID();
  createUser.run(id, email, passwordHash, now());
  // Seed a default settings row for the new user.
  db.prepare(`INSERT INTO settings (user_id) VALUES (?)`).run(id);
  return id;
}
export const getUserByEmail = db.prepare(`SELECT * FROM users WHERE email = ?`);
export const getUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);

// Single-user mode: everything belongs to one fixed local user.
export const DEFAULT_USER_ID = 'local';
export function ensureDefaultUser() {
  if (!getUserById.get(DEFAULT_USER_ID)) {
    createUser.run(DEFAULT_USER_ID, 'local', '', now());
  }
  db.prepare(`INSERT OR IGNORE INTO settings (user_id) VALUES (?)`).run(DEFAULT_USER_ID);
}
ensureDefaultUser();

// ---- Accounts ----
export function insertAccount(userId, { label, username, authType, tokenRef = null }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO accounts (id, user_id, label, username, auth_type, token_ref, load_enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(id, userId, label, username, authType, tokenRef, now());
  return getAccountById.get(id, userId);
}
export const getAccountById = db.prepare(
  `SELECT * FROM accounts WHERE id = ? AND user_id = ?`
);
export const listAccounts = db.prepare(
  `SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at ASC`
);
export const deleteAccount = db.prepare(
  `DELETE FROM accounts WHERE id = ? AND user_id = ?`
);
export const setAccountLoad = db.prepare(
  `UPDATE accounts SET load_enabled = ? WHERE id = ? AND user_id = ?`
);
export const setAllAccountsLoad = db.prepare(
  `UPDATE accounts SET load_enabled = ? WHERE user_id = ?`
);

// ---- Settings ----
export const getSettings = db.prepare(`SELECT * FROM settings WHERE user_id = ?`);

const SETTINGS_FIELDS = [
  'server_ip', 'login_message', 'world_change_message', 'login_delay_ms',
  'server_version', 'show_chat', 'auto_reconnect', 'sneak', 'anti_afk',
  'offline_mode', 'spam_message', 'spam_delay_ms', 'spam_enabled', 'proxy_pool',
  'leaderboard_enabled', 'leaderboard_command', 'leaderboard_account',
  'wall_enabled', 'wall_account', 'wall_interval_ms', 'wall_trigger',
  'wall_require_verified', 'wall_reminder_message', 'wall_check_message', 'wall_discord_message',
  'wall_chat_pattern', 'wall_msg_command', 'wall_verify_password',
  'wall_to_minecraft', 'wall_to_discord', 'wall_discord_webhook',
  'wall_quiet_start', 'wall_quiet_end',
  'raid_enabled', 'raid_trigger', 'raid_off_trigger', 'raid_message', 'raid_delay_ms',
  'raid_to_discord', 'raid_discord_webhook',
  'check_to_discord', 'check_discord_webhook',
];

export function updateSettings(userId, patch) {
  const fields = Object.keys(patch).filter((k) => SETTINGS_FIELDS.includes(k));
  if (fields.length === 0) return getSettings.get(userId);
  const assignments = fields.map((f) => `${f} = @${f}`).join(', ');
  const values = { user_id: userId };
  for (const f of fields) values[f] = patch[f];
  db.prepare(`UPDATE settings SET ${assignments} WHERE user_id = @user_id`).run(values);
  return getSettings.get(userId);
}

// ---- Leaderboard (latest parsed `/f top` snapshot per user) ----
export const getLeaderboard = db.prepare(`SELECT * FROM leaderboard WHERE user_id = ?`);
export const upsertLeaderboard = db.prepare(`
  INSERT INTO leaderboard (user_id, updated_at, entries) VALUES (@user_id, @updated_at, @entries)
  ON CONFLICT(user_id) DO UPDATE SET updated_at = @updated_at, entries = @entries
`);

// ---- Wall bot ----
// Every `player` argument here is expected to be lowercased by the caller (see normalizePlayer
// in WallBot.js) so that casing can never split one player across two rows.

export const getWallState = db.prepare(`SELECT * FROM wall_state WHERE user_id = ?`);
export const upsertWallState = db.prepare(`
  INSERT INTO wall_state (user_id, total_checks, last_check_at)
  VALUES (@user_id, @total_checks, @last_check_at)
  ON CONFLICT(user_id) DO UPDATE SET total_checks = @total_checks, last_check_at = @last_check_at
`);

export const incWallCheck = db.prepare(`
  INSERT INTO wall_stats (user_id, player, checks, last_check)
  VALUES (@user_id, @player, 1, @last_check)
  ON CONFLICT(user_id, player) DO UPDATE SET checks = checks + 1, last_check = @last_check
`);

// A check logged while a raid alert is running counts separately, so the two can be reported
// apart the way the Discord log embed shows them.
export const incRaidCheck = db.prepare(`
  INSERT INTO wall_stats (user_id, player, raid_checks, last_check)
  VALUES (@user_id, @player, 1, @last_check)
  ON CONFLICT(user_id, player) DO UPDATE SET raid_checks = raid_checks + 1, last_check = @last_check
`);

export const topWallCheckers = db.prepare(
  `SELECT player, checks, raid_checks, last_check FROM wall_stats WHERE user_id = ?
   ORDER BY checks DESC, player ASC LIMIT 10`
);
// Who checked most recently. Read from the table rather than tracked in memory so the {player}
// placeholder still resolves after a restart.
export const lastWallChecker = db.prepare(
  `SELECT player, checks, raid_checks FROM wall_stats WHERE user_id = ?
   ORDER BY last_check DESC LIMIT 1`
);
export const allWallCheckers = db.prepare(
  `SELECT player, checks, raid_checks, last_check FROM wall_stats WHERE user_id = ?
   ORDER BY checks DESC, player ASC`
);

export const listWallPlayers = db.prepare(
  `SELECT player, verified, label, added_at FROM wall_players WHERE user_id = ?
   ORDER BY player ASC`
);
export const getWallPlayer = db.prepare(
  `SELECT * FROM wall_players WHERE user_id = ? AND player = ?`
);
export const upsertWallPlayer = db.prepare(`
  INSERT INTO wall_players (user_id, player, verified, label, added_at)
  VALUES (@user_id, @player, @verified, @label, @added_at)
  ON CONFLICT(user_id, player) DO UPDATE SET verified = @verified, label = @label
`);
export const deleteWallPlayer = db.prepare(
  `DELETE FROM wall_players WHERE user_id = ? AND player = ?`
);

// Clear the scoreboard for one user in a single atomic step. Deliberately leaves wall_players
// alone: a map reset wipes scores, not who is authorized to log a check.
const _clearWallStats = db.prepare(`DELETE FROM wall_stats WHERE user_id = ?`);
const _zeroWallState = db.prepare(
  `UPDATE wall_state SET total_checks = 0, last_check_at = 0 WHERE user_id = ?`
);
export const resetWallStats = db.transaction((userId) => {
  _clearWallStats.run(userId);
  _zeroWallState.run(userId);
});

export default db;
