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

// Body of the Discord embed for a raid alert.
export const DISCORD_RAID_DEFAULT = 'Check walls immediately and get online.';

// Raid Outpost reminders. The single line covers grace period and quiet hours (raid only); the
// combined one is sent when walls and the outpost are both overdue at once.
export const RAID_OUTPOST_REMINDER_DEFAULT =
  'Check Raid Outpost /msg {bot} raid : Minutes since last checked: {raidMinutes}m [{raidPlayer}]';
export const RAID_OUTPOST_COMBINED_DEFAULT =
  'Check Raid Outpost | Walls /msg {bot} walls / raid : Minutes since last checked: '
  + 'Raid: {raidMinutes}m [{raidPlayer}] | Walls: {minutes}m [{player}]';
export const DISCORD_RAID_OUTPOST_DEFAULT =
  'Raid Minutes Unchecked: **{raidMinutes}**\nLast Checker: **{raidPlayer}** (Total Raid Checks: {raidChecks})';

export const WALL_TRIGGER_DEFAULT = 'walls, check';
export const RAID_TRIGGER_DEFAULT = 'weewoo';

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
    leaderboard_to_discord INTEGER NOT NULL DEFAULT 0,
    leaderboard_discord_webhook TEXT NOT NULL DEFAULT '',
    wall_enabled          INTEGER NOT NULL DEFAULT 0,
    wall_account          TEXT    NOT NULL DEFAULT '',
    wall_interval_ms      INTEGER NOT NULL DEFAULT 600000,
    wall_trigger          TEXT    NOT NULL DEFAULT '${WALL_TRIGGER_DEFAULT}',
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
    raid_trigger          TEXT    NOT NULL DEFAULT '${RAID_TRIGGER_DEFAULT}',
    raid_off_trigger      TEXT    NOT NULL DEFAULT 'weeoff, raidoff',
    raid_message          TEXT    NOT NULL DEFAULT 'RAID ALERT - DEFEND THE BASE',
    raid_discord_message  TEXT    NOT NULL DEFAULT '${DISCORD_RAID_DEFAULT}',
    raid_delay_ms         INTEGER NOT NULL DEFAULT 15000,
    raid_to_discord       INTEGER NOT NULL DEFAULT 0,
    raid_discord_webhook  TEXT    NOT NULL DEFAULT '',
    check_to_discord      INTEGER NOT NULL DEFAULT 0,
    check_discord_webhook TEXT    NOT NULL DEFAULT '',
    grace_period          INTEGER NOT NULL DEFAULT 0,
    raid_outpost_faction       TEXT    NOT NULL DEFAULT '',
    raid_outpost_trigger       TEXT    NOT NULL DEFAULT 'raid',
    raid_outpost_reminder_message TEXT NOT NULL DEFAULT '${RAID_OUTPOST_REMINDER_DEFAULT}',
    raid_outpost_combined_message TEXT NOT NULL DEFAULT '${RAID_OUTPOST_COMBINED_DEFAULT}',
    raid_outpost_discord_webhook TEXT NOT NULL DEFAULT '',
    check_board_discord_webhook TEXT NOT NULL DEFAULT '',
    report_discord_webhook TEXT NOT NULL DEFAULT '',
    ban_discord_webhook   TEXT NOT NULL DEFAULT '',
    match_discord_webhook TEXT NOT NULL DEFAULT '',
    match_nsfw            INTEGER NOT NULL DEFAULT 0,
    reports_enabled       INTEGER NOT NULL DEFAULT 1,
    reports_verified_only INTEGER NOT NULL DEFAULT 1,
    discord_ping_role     TEXT    NOT NULL DEFAULT '',
    ping_weewoo           INTEGER NOT NULL DEFAULT 1,
    ping_raid_outpost     INTEGER NOT NULL DEFAULT 1,
    wall_board_sort       TEXT    NOT NULL DEFAULT 'total',
    tax_discord_webhook   TEXT    NOT NULL DEFAULT '',
    tax_log_discord_webhook TEXT  NOT NULL DEFAULT ''
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
    last_raid_check INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, player)
  );

  CREATE TABLE IF NOT EXISTS wall_state (
    user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    total_checks  INTEGER NOT NULL DEFAULT 0,
    last_check_at INTEGER NOT NULL DEFAULT 0,
    raid_outpost_state TEXT    NOT NULL DEFAULT 'IDLE',
    raid_outpost_holder TEXT   NOT NULL DEFAULT '',
    raid_outpost_claimed_at INTEGER NOT NULL DEFAULT 0,
    last_raid_check_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS wall_players (
    user_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    player   TEXT    NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    label    TEXT    NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, player)
  );

  -- Report log. id is the ticket number shown in Discord and the panel.
  CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    player     TEXT    NOT NULL,
    about      TEXT    NOT NULL DEFAULT '',
    text       TEXT    NOT NULL,
    anonymous  INTEGER NOT NULL DEFAULT 1,
    kind       TEXT    NOT NULL DEFAULT 'report',
    created_at INTEGER NOT NULL
  );
`);

// The reporter's choice: anonymous hides the sender from Discord (the panel always sees it).
{
  const cols = new Set(db.prepare(`PRAGMA table_info(reports)`).all().map((c) => c.name));
  if (!cols.has('anonymous')) db.exec(`ALTER TABLE reports ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 1`);
  // 'report' (something bad) or 'praise' (a good message). Same ticket numbering for both.
  if (!cols.has('kind')) db.exec(`ALTER TABLE reports ADD COLUMN kind TEXT NOT NULL DEFAULT 'report'`);
}

// ---- Lightweight migrations. CREATE TABLE IF NOT EXISTS won't add new columns to an
// already-existing DB, so ALTER in any settings columns that are missing. ----
{
  const cols = new Set(db.prepare(`PRAGMA table_info(settings)`).all().map((c) => c.name));
  const addColumn = (name, ddl) => { if (!cols.has(name)) db.exec(`ALTER TABLE settings ADD COLUMN ${ddl}`); };
  addColumn('proxy_pool', `proxy_pool TEXT NOT NULL DEFAULT ''`);
  addColumn('leaderboard_enabled', `leaderboard_enabled INTEGER NOT NULL DEFAULT 0`);
  addColumn('leaderboard_command', `leaderboard_command TEXT NOT NULL DEFAULT '/f top'`);
  addColumn('leaderboard_account', `leaderboard_account TEXT NOT NULL DEFAULT ''`);
  addColumn('leaderboard_to_discord', `leaderboard_to_discord INTEGER NOT NULL DEFAULT 0`);
  addColumn('leaderboard_discord_webhook', `leaderboard_discord_webhook TEXT NOT NULL DEFAULT ''`);
  addColumn('wall_enabled', `wall_enabled INTEGER NOT NULL DEFAULT 0`);
  addColumn('wall_account', `wall_account TEXT NOT NULL DEFAULT ''`);
  addColumn('wall_interval_ms', `wall_interval_ms INTEGER NOT NULL DEFAULT 600000`);
  addColumn('wall_trigger', `wall_trigger TEXT NOT NULL DEFAULT '${WALL_TRIGGER_DEFAULT}'`);
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
  addColumn('raid_trigger', `raid_trigger TEXT NOT NULL DEFAULT '${RAID_TRIGGER_DEFAULT}'`);
  addColumn('raid_off_trigger', `raid_off_trigger TEXT NOT NULL DEFAULT 'weeoff, raidoff'`);
  addColumn('raid_message', `raid_message TEXT NOT NULL DEFAULT 'RAID ALERT - DEFEND THE BASE'`);
  addColumn('raid_discord_message', `raid_discord_message TEXT NOT NULL DEFAULT '${DISCORD_RAID_DEFAULT}'`);
  addColumn('raid_delay_ms', `raid_delay_ms INTEGER NOT NULL DEFAULT 15000`);
  addColumn('raid_to_discord', `raid_to_discord INTEGER NOT NULL DEFAULT 0`);
  addColumn('raid_discord_webhook', `raid_discord_webhook TEXT NOT NULL DEFAULT ''`);
  addColumn('check_to_discord', `check_to_discord INTEGER NOT NULL DEFAULT 0`);
  addColumn('check_discord_webhook', `check_discord_webhook TEXT NOT NULL DEFAULT ''`);
  addColumn('grace_period', `grace_period INTEGER NOT NULL DEFAULT 0`);
  addColumn('raid_outpost_faction', `raid_outpost_faction TEXT NOT NULL DEFAULT ''`);
  addColumn('raid_outpost_trigger', `raid_outpost_trigger TEXT NOT NULL DEFAULT 'raid'`);
  addColumn('raid_outpost_reminder_message', `raid_outpost_reminder_message TEXT NOT NULL DEFAULT '${RAID_OUTPOST_REMINDER_DEFAULT}'`);
  addColumn('raid_outpost_discord_webhook', `raid_outpost_discord_webhook TEXT NOT NULL DEFAULT ''`);
  addColumn('check_board_discord_webhook', `check_board_discord_webhook TEXT NOT NULL DEFAULT ''`);
  addColumn('discord_ping_role', `discord_ping_role TEXT NOT NULL DEFAULT ''`);
  addColumn('ping_weewoo', `ping_weewoo INTEGER NOT NULL DEFAULT 1`);
  addColumn('ping_raid_outpost', `ping_raid_outpost INTEGER NOT NULL DEFAULT 1`);
  addColumn('wall_board_sort', `wall_board_sort TEXT NOT NULL DEFAULT 'total'`);
  addColumn('report_discord_webhook', `report_discord_webhook TEXT NOT NULL DEFAULT ''`);
  addColumn('ban_discord_webhook', `ban_discord_webhook TEXT NOT NULL DEFAULT ''`);
  addColumn('match_discord_webhook', `match_discord_webhook TEXT NOT NULL DEFAULT ''`);
  addColumn('match_nsfw', `match_nsfw INTEGER NOT NULL DEFAULT 0`);
  addColumn('reports_enabled', `reports_enabled INTEGER NOT NULL DEFAULT 1`);
  addColumn('reports_verified_only', `reports_verified_only INTEGER NOT NULL DEFAULT 1`);
  addColumn('tax_discord_webhook', `tax_discord_webhook TEXT NOT NULL DEFAULT ''`);
  addColumn('tax_log_discord_webhook', `tax_log_discord_webhook TEXT NOT NULL DEFAULT ''`);
  addColumn('raid_outpost_combined_message', `raid_outpost_combined_message TEXT NOT NULL DEFAULT '${RAID_OUTPOST_COMBINED_DEFAULT}'`);
}

// Raid Outpost state lives in wall_state so a restart mid-hold (the hold lasts 12h) remembers it.
{
  const cols = new Set(db.prepare(`PRAGMA table_info(wall_state)`).all().map((c) => c.name));
  const addColumn = (name, ddl) => { if (!cols.has(name)) db.exec(`ALTER TABLE wall_state ADD COLUMN ${ddl}`); };
  addColumn('raid_outpost_state', `raid_outpost_state TEXT NOT NULL DEFAULT 'IDLE'`);
  addColumn('raid_outpost_holder', `raid_outpost_holder TEXT NOT NULL DEFAULT ''`);
  addColumn('raid_outpost_claimed_at', `raid_outpost_claimed_at INTEGER NOT NULL DEFAULT 0`);
  addColumn('last_raid_check_at', `last_raid_check_at INTEGER NOT NULL DEFAULT 0`);
  // The running tax. tax_due_at = 0 means none; persisted so a 24h tax survives a restart.
  addColumn('tax_amount', `tax_amount INTEGER NOT NULL DEFAULT 0`);
  addColumn('tax_started_at', `tax_started_at INTEGER NOT NULL DEFAULT 0`);
  addColumn('tax_due_at', `tax_due_at INTEGER NOT NULL DEFAULT 0`);
  addColumn('tax_last_reminder_at', `tax_last_reminder_at INTEGER NOT NULL DEFAULT 0`);
  addColumn('tax_started_by', `tax_started_by TEXT NOT NULL DEFAULT ''`);
  // Bans already posted to Discord (JSON array of parseBans rows); '' = never synced, seed quietly.
  addColumn('posted_bans', `posted_bans TEXT NOT NULL DEFAULT ''`);
}

// Tax tags live on the roster row, so a rename (linkPlayerUuid) carries them along.
// tax_status: '' unpaid | 'claimed' (said "paid", awaiting an admin) | 'paid' (confirmed).
{
  const cols = new Set(db.prepare(`PRAGMA table_info(wall_players)`).all().map((c) => c.name));
  const addColumn = (name, ddl) => { if (!cols.has(name)) db.exec(`ALTER TABLE wall_players ADD COLUMN ${ddl}`); };
  addColumn('tax', `tax INTEGER NOT NULL DEFAULT 0`);
  addColumn('tax_admin', `tax_admin INTEGER NOT NULL DEFAULT 0`);
  addColumn('discord_id', `discord_id TEXT NOT NULL DEFAULT ''`);
  addColumn('tax_status', `tax_status TEXT NOT NULL DEFAULT ''`);
}

// Same problem one table over: CREATE TABLE IF NOT EXISTS won't add raid_checks to a wall_stats
// table that already exists.
{
  const cols = new Set(db.prepare(`PRAGMA table_info(wall_stats)`).all().map((c) => c.name));
  if (!cols.has('raid_checks')) {
    db.exec(`ALTER TABLE wall_stats ADD COLUMN raid_checks INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has('last_raid_check')) {
    db.exec(`ALTER TABLE wall_stats ADD COLUMN last_raid_check INTEGER NOT NULL DEFAULT 0`);
  }
}

// Mojang UUID (32 hex, no dashes) behind each name, so a player who changes IGN keeps their row.
// '' = not seen since this column existed; the first DM fills it in (linkPlayerUuid).
for (const table of ['wall_stats', 'wall_players']) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  if (!cols.has('uuid')) db.exec(`ALTER TABLE ${table} ADD COLUMN uuid TEXT NOT NULL DEFAULT ''`);
}
// The name as Mojang/the server spells it ("DSP_05"), for display only. `player` stays the
// lowercased key everything compares on. '' = not resolved yet.
for (const table of ['wall_stats', 'wall_players']) {
  if (!new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)).has('display_name')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`);
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


  // "raid" now means a Raid Outpost check, so the raid alarm can no longer listen for it, and the
  // wall trigger was trimmed to the two words players actually use.
  db.prepare(`UPDATE settings SET wall_trigger = ? WHERE wall_trigger = ?`)
    .run(WALL_TRIGGER_DEFAULT, 'check, checked, walls, wall');
  db.prepare(`UPDATE settings SET raid_trigger = ? WHERE raid_trigger = ?`)
    .run(RAID_TRIGGER_DEFAULT, 'weewoo, raid, raided');
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
  'leaderboard_to_discord', 'leaderboard_discord_webhook',
  'wall_enabled', 'wall_account', 'wall_interval_ms', 'wall_trigger',
  'wall_require_verified', 'wall_reminder_message', 'wall_check_message', 'wall_discord_message',
  'wall_chat_pattern', 'wall_msg_command', 'wall_verify_password',
  'wall_to_minecraft', 'wall_to_discord', 'wall_discord_webhook',
  'wall_quiet_start', 'wall_quiet_end',
  'raid_enabled', 'raid_trigger', 'raid_off_trigger', 'raid_message', 'raid_discord_message',
  'raid_delay_ms',
  'raid_to_discord', 'raid_discord_webhook',
  'check_to_discord', 'check_discord_webhook',
  'grace_period', 'raid_outpost_faction', 'raid_outpost_trigger',
  'raid_outpost_reminder_message', 'raid_outpost_combined_message',
  'raid_outpost_discord_webhook', 'report_discord_webhook', 'reports_enabled', 'reports_verified_only',
  'discord_ping_role', 'ping_weewoo', 'ping_raid_outpost', 'wall_board_sort',
  'check_board_discord_webhook', 'ban_discord_webhook', 'match_discord_webhook', 'match_nsfw',
  'tax_discord_webhook', 'tax_log_discord_webhook',
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
// uuid is optional on these writes: '' when the caller doesn't know it (panel adds, tests).
const withUuid = (stmt) => ({ run: (params) => stmt.run({ uuid: '', ...params }) });
// Every `player` argument here is expected to be lowercased by the caller (see normalizePlayer
// in WallBot.js) so that casing can never split one player across two rows.

export const getWallState = db.prepare(`SELECT * FROM wall_state WHERE user_id = ?`);
export const upsertWallState = db.prepare(`
  INSERT INTO wall_state (user_id, total_checks, last_check_at,
    raid_outpost_state, raid_outpost_holder, raid_outpost_claimed_at, last_raid_check_at)
  VALUES (@user_id, @total_checks, @last_check_at,
    @raid_outpost_state, @raid_outpost_holder, @raid_outpost_claimed_at, @last_raid_check_at)
  ON CONFLICT(user_id) DO UPDATE SET total_checks = @total_checks, last_check_at = @last_check_at,
    raid_outpost_state = @raid_outpost_state, raid_outpost_holder = @raid_outpost_holder,
    raid_outpost_claimed_at = @raid_outpost_claimed_at, last_raid_check_at = @last_raid_check_at
`);

export const incWallCheck = withUuid(db.prepare(`
  INSERT INTO wall_stats (user_id, player, uuid, checks, last_check)
  VALUES (@user_id, @player, @uuid, 1, @last_check)
  ON CONFLICT(user_id, player) DO UPDATE SET checks = checks + 1, last_check = @last_check,
    uuid = CASE WHEN uuid = '' THEN @uuid ELSE uuid END
`));

// A Raid Outpost check. It stamps its own column and leaves last_check alone, so lastWallChecker
// keeps meaning "who last checked walls".
export const incRaidCheck = withUuid(db.prepare(`
  INSERT INTO wall_stats (user_id, player, uuid, raid_checks, last_raid_check)
  VALUES (@user_id, @player, @uuid, 1, @last_check)
  ON CONFLICT(user_id, player) DO UPDATE SET raid_checks = raid_checks + 1, last_raid_check = @last_check,
    uuid = CASE WHEN uuid = '' THEN @uuid ELSE uuid END
`));

export const topWallCheckers = db.prepare(
  `SELECT player, display_name, checks, raid_checks, last_check FROM wall_stats WHERE user_id = ?
   ORDER BY checks DESC, player ASC LIMIT 10`
);
// Who checked most recently. Read from the table rather than tracked in memory so the {player}
// placeholder still resolves after a restart.
export const lastWallChecker = db.prepare(
  `SELECT player, display_name, checks, raid_checks FROM wall_stats WHERE user_id = ?
   ORDER BY last_check DESC LIMIT 1`
);
export const lastRaidChecker = db.prepare(
  `SELECT player, display_name, checks, raid_checks FROM wall_stats WHERE user_id = ? AND last_raid_check > 0
   ORDER BY last_raid_check DESC LIMIT 1`
);
export const allWallCheckers = db.prepare(
  `SELECT player, display_name, checks, raid_checks, last_check FROM wall_stats WHERE user_id = ?
   ORDER BY checks DESC, player ASC`
);

export const listWallPlayers = db.prepare(
  `SELECT player, display_name, verified, label, added_at, tax, tax_admin, discord_id, tax_status
   FROM wall_players WHERE user_id = ? ORDER BY player ASC`
);
const _displayStmts = ['wall_stats', 'wall_players'].map((t) => db.prepare(
  `UPDATE ${t} SET display_name = @name WHERE user_id = @user_id AND player = @player AND display_name != @name`
));
/** Set the real-case name on both the stats and roster rows. Returns how many rows changed. */
export const setDisplayName = (name, user_id, player) =>
  _displayStmts.reduce((n, s) => n + s.run({ name, user_id, player }).changes, 0);
export const missingDisplayNames = db.prepare(`
  SELECT user_id, player, MAX(uuid) AS uuid FROM (
    SELECT user_id, player, uuid FROM wall_stats WHERE display_name = ''
    UNION ALL SELECT user_id, player, uuid FROM wall_players WHERE display_name = ''
  ) WHERE player NOT LIKE '~%' GROUP BY user_id, player
`);
export const getWallPlayer = db.prepare(
  `SELECT * FROM wall_players WHERE user_id = ? AND player = ?`
);
export const upsertWallPlayer = withUuid(db.prepare(`
  INSERT INTO wall_players (user_id, player, uuid, verified, label, added_at)
  VALUES (@user_id, @player, @uuid, @verified, @label, @added_at)
  ON CONFLICT(user_id, player) DO UPDATE SET verified = @verified,
    label = CASE WHEN @label = '' THEN label ELSE @label END,
    uuid = CASE WHEN uuid = '' THEN @uuid ELSE uuid END
`));
// ---- Tax ----
export const updateWallPlayerTax = db.prepare(
  `UPDATE wall_players SET tax = @tax, tax_admin = @tax_admin, discord_id = @discord_id, label = @label
   WHERE user_id = @user_id AND player = @player`
);
export const setTaxStatus = db.prepare(
  `UPDATE wall_players SET tax_status = ? WHERE user_id = ? AND player = ?`
);
export const resetTaxStatuses = db.prepare(`UPDATE wall_players SET tax_status = '' WHERE user_id = ?`);
export const saveTax = db.prepare(`
  INSERT INTO wall_state (user_id, tax_amount, tax_started_at, tax_due_at, tax_last_reminder_at, tax_started_by)
  VALUES (@user_id, @tax_amount, @tax_started_at, @tax_due_at, @tax_last_reminder_at, @tax_started_by)
  ON CONFLICT(user_id) DO UPDATE SET tax_amount = @tax_amount, tax_started_at = @tax_started_at,
    tax_due_at = @tax_due_at, tax_last_reminder_at = @tax_last_reminder_at, tax_started_by = @tax_started_by
`);
export const setPostedBans = db.prepare(`
  INSERT INTO wall_state (user_id, posted_bans) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET posted_bans = excluded.posted_bans
`);
export const setTaxReminderAt = db.prepare(`UPDATE wall_state SET tax_last_reminder_at = ? WHERE user_id = ?`);
export const clearTax = db.prepare(
  `UPDATE wall_state SET tax_amount = 0, tax_started_at = 0, tax_due_at = 0, tax_last_reminder_at = 0,
   tax_started_by = '' WHERE user_id = ?`
);

export const insertReport = db.prepare(
  `INSERT INTO reports (user_id, player, about, text, anonymous, kind, created_at)
   VALUES (@user_id, @player, @about, @text, @anonymous, @kind, @created_at)`
);
export const listReports = db.prepare(
  `SELECT id, player, about, text, anonymous, kind, created_at FROM reports WHERE user_id = ? ORDER BY id DESC LIMIT 200`
);
export const deleteWallPlayer = db.prepare(
  `DELETE FROM wall_players WHERE user_id = ? AND player = ?`
);

// Identity is the UUID; `player` is just the name we last saw it under. Called on every DM, so a
// renamed player's stats and roster entry follow them to the new name. A row already sitting on
// the new name that belongs to someone else (the name's previous owner, or an untagged legacy row
// when we already have a tagged one) is parked under `~<uuid or old name>` so it can't absorb
// this player's checks; its owner gets it back the next time they message the bot.
const _linkStmts = Object.fromEntries(['wall_stats', 'wall_players'].map((t) => [t, {
  byUuid: db.prepare(`SELECT player FROM ${t} WHERE user_id = ? AND uuid = ?`),
  byName: db.prepare(`SELECT uuid FROM ${t} WHERE user_id = ? AND player = ?`),
  adopt: db.prepare(`UPDATE ${t} SET uuid = ? WHERE user_id = ? AND player = ?`),
  rename: db.prepare(`UPDATE ${t} SET player = ? WHERE user_id = ? AND player = ?`),
}]));
export const linkPlayerUuid = db.transaction((userId, uuid, player) => {
  const renamed = [];
  for (const [table, q] of Object.entries(_linkStmts)) {
    const mine = q.byUuid.get(userId, uuid);
    if (mine?.player === player) continue;
    const other = q.byName.get(userId, player);
    if (other && !other.uuid && !mine) {
      q.adopt.run(uuid, userId, player); // pre-UUID row under this name: it's ours now
      continue;
    }
    if (other) q.rename.run(`~${other.uuid || player}`, userId, player);
    if (mine) {
      q.rename.run(player, userId, mine.player);
      if (table === 'wall_players') renamed.push(mine.player);
    }
  }
  return renamed; // old roster names, for the console
});

// Clear the scoreboard for one user in a single atomic step. Deliberately leaves wall_players
// alone: a map reset wipes scores, not who is authorized to log a check.
const _clearWallStats = db.prepare(`DELETE FROM wall_stats WHERE user_id = ?`);
const _zeroWallState = db.prepare(
  `UPDATE wall_state SET total_checks = 0, last_check_at = 0, last_raid_check_at = 0 WHERE user_id = ?`
);
export const resetWallStats = db.transaction((userId) => {
  _clearWallStats.run(userId);
  _zeroWallState.run(userId);
});

export default db;
