import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'app.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
    proxy_pool          TEXT    NOT NULL DEFAULT ''
  );
`);

// ---- Lightweight migrations. CREATE TABLE IF NOT EXISTS won't add new columns to an
// already-existing DB, so ALTER in any settings columns that are missing. ----
{
  const cols = new Set(db.prepare(`PRAGMA table_info(settings)`).all().map((c) => c.name));
  const addColumn = (name, ddl) => { if (!cols.has(name)) db.exec(`ALTER TABLE settings ADD COLUMN ${ddl}`); };
  addColumn('proxy_pool', `proxy_pool TEXT NOT NULL DEFAULT ''`);
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

export default db;
