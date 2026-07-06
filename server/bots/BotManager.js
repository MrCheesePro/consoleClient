import BotSession from './BotSession.js';
import {
  getSettings, listAccounts, getAccountById, getLeaderboard, upsertLeaderboard,
} from '../db/db.js';

const MAX_BOTS_PER_USER = Number(process.env.MAX_BOTS_PER_USER || 20);
const ACCOUNTS_PER_IP = 3; // the target server's per-IP connection cap
const LEADERBOARD_INTERVAL_MS = 60 * 60 * 1000; // refresh the board hourly
const LEADERBOARD_CAPTURE_MS = 4000;            // window to collect the /f top reply
const LEADERBOARD_ONLINE_DELAY_MS = 30 * 1000;  // wait after a bot connects before auto-fetch

/**
 * Parse a factions `/f top` chat reply into ranked entries. Lines look like:
 *   "1. TurtleGang - 189,101 Faction Points (+24,221)"
 * The header ("Top Factions (1/5)") and any other chatter are ignored. Returns up to 10
 * `{ rank, name, points, gain }` entries sorted by rank (gain may be null).
 */
export function parseLeaderboard(lines) {
  const re = /^\s*(\d+)\.\s+(.+?)\s+-\s+([\d,]+)\s+Faction Points(?:\s*\(([+-][\d,]+)\))?/i;
  const byRank = new Map();
  for (const line of lines || []) {
    const m = re.exec(String(line));
    if (!m) continue;
    const rank = Number(m[1]);
    if (byRank.has(rank)) continue; // first occurrence wins
    byRank.set(rank, {
      rank,
      name: m[2].trim(),
      points: Number(m[3].replace(/,/g, '')),
      gain: m[4] ? Number(m[4].replace(/,/g, '')) : null,
    });
  }
  return [...byRank.values()].sort((a, b) => a.rank - b.rank).slice(0, 10);
}

/**
 * Parse the proxy pool (one entry per line). Each entry becomes an outbound "IP slot"
 * that holds up to ACCOUNTS_PER_IP accounts. An entry is either:
 *   - `direct` (or blank line, ignored) → use the machine's own IP
 *   - a SOCKS5 URL: `socks5://[user:pass@]host:port` (scheme optional, defaults socks5)
 * Returns an array of: null (direct) | { host, port, type, userId, password } | { invalid }.
 */
export function parseProxyPool(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toLowerCase() === 'direct') { out.push(null); continue; }
    try {
      const url = new URL(/:\/\//.test(line) ? line : `socks5://${line}`);
      out.push({
        host: url.hostname,
        port: Number(url.port) || 1080,
        type: 5,
        userId: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
      });
    } catch {
      out.push({ invalid: line });
    }
  }
  return out;
}

/**
 * Owns every live bot in the process, keyed by `${userId}:${accountId}`.
 * Fans bot events out to per-user WebSocket subscribers via `emitToUser`.
 */
export default class BotManager {
  constructor({ emitToUser }) {
    this.emitToUser = emitToUser;         // (userId, {type, ...payload}) => void
    this.sessions = new Map();            // key -> BotSession
    this._lbAutoTimers = new Map();       // userId -> pending post-online refresh timer
    this._lbBusy = new Set();             // userIds with a refresh in flight (avoid overlap)
    // Hourly leaderboard refresh for every user that currently has bots online.
    this._leaderboardTimer = setInterval(() => this._hourlyLeaderboard(), LEADERBOARD_INTERVAL_MS);
  }

  _key(userId, accountId) { return `${userId}:${accountId}`; }

  countForUser(userId) {
    let n = 0;
    for (const key of this.sessions.keys()) if (key.startsWith(`${userId}:`)) n++;
    return n;
  }

  _emit(userId) {
    return (type, payload) => {
      this.emitToUser(userId, { type, ...payload });
      if (type === 'botStatus') {
        this._broadcastOnlineCount(userId);
        if (payload && payload.status === 'online') this._maybeAutoRefreshLeaderboard(userId);
      }
    };
  }

  _broadcastOnlineCount(userId) {
    let online = 0;
    for (const [key, s] of this.sessions) {
      if (key.startsWith(`${userId}:`) && s.status === 'online') online++;
    }
    const total = this.countForUser(userId);
    this.emitToUser(userId, { type: 'onlineCount', online, total });
  }

  /** Start bots for the given account ids (or all load-enabled accounts). */
  connect(userId, accountIds = null) {
    const settings = getSettings.get(userId);
    const allAccounts = listAccounts.all(userId);
    const pool = parseProxyPool(settings.proxy_pool);
    let accounts = allAccounts;
    if (accountIds && accountIds.length) {
      const set = new Set(accountIds);
      accounts = allAccounts.filter((a) => set.has(a.id));
    } else {
      accounts = allAccounts.filter((a) => a.load_enabled);
    }

    const results = [];
    for (const account of accounts) {
      const key = this._key(userId, account.id);
      if (this.sessions.has(key)) continue; // already running
      if (this.countForUser(userId) >= MAX_BOTS_PER_USER) {
        this.emitToUser(userId, { type: 'error', message: `Bot limit reached (${MAX_BOTS_PER_USER}).` });
        break;
      }

      // Auto-group: an account is pinned to one IP slot by its fixed position among all
      // accounts, ACCOUNTS_PER_IP per slot — so no IP ever carries more than the cap.
      let proxy = null;
      if (pool.length) {
        const idx = allAccounts.findIndex((a) => a.id === account.id);
        const slot = Math.floor(idx / ACCOUNTS_PER_IP);
        const entry = pool[slot];
        if (slot >= pool.length) {
          this.emitToUser(userId, { type: 'error', message: `No IP slot for ${account.label || account.username}: only ${pool.length} proxy entr${pool.length === 1 ? 'y' : 'ies'} × ${ACCOUNTS_PER_IP} accounts. Add more to the proxy pool.` });
          continue;
        }
        if (entry && entry.invalid) {
          this.emitToUser(userId, { type: 'error', message: `Invalid proxy in pool (line ${slot + 1}): "${entry.invalid}".` });
          continue;
        }
        proxy = entry; // null = direct/primary IP
      }

      const session = new BotSession({ userId, account, settings, emit: this._emit(userId), proxy });
      this.sessions.set(key, session);
      session.start();
      results.push(account.id);
    }
    this._broadcastOnlineCount(userId);
    return results;
  }

  /** Stop bots for given account ids (or all of the user's bots). */
  disconnect(userId, accountIds = null) {
    const ids = accountIds && accountIds.length
      ? accountIds
      : [...this.sessions.keys()].filter((k) => k.startsWith(`${userId}:`)).map((k) => k.split(':').slice(1).join(':'));
    for (const accountId of ids) {
      const key = this._key(userId, accountId);
      const session = this.sessions.get(key);
      if (session) { session.stop(); this.sessions.delete(key); }
    }
    this._broadcastOnlineCount(userId);
  }

  /** Push updated settings to all of a user's running bots. */
  applySettings(userId) {
    const settings = getSettings.get(userId);
    for (const [key, session] of this.sessions) {
      if (key.startsWith(`${userId}:`)) session.applySettings(settings);
    }
  }

  _forEachTarget(userId, accountId, fn) {
    if (accountId && accountId !== 'all') {
      const s = this.sessions.get(this._key(userId, accountId));
      if (s) fn(s);
      return;
    }
    for (const [key, s] of this.sessions) if (key.startsWith(`${userId}:`)) fn(s);
  }

  sendChat(userId, accountId, message) { this._forEachTarget(userId, accountId, (s) => s.sendChat(message)); }
  dropAll(userId, accountId) { this._forEachTarget(userId, accountId, (s) => s.dropAll()); }
  equipArmor(userId, accountId) { this._forEachTarget(userId, accountId, (s) => s.equipArmor()); }
  useItem(userId, accountId) { this._forEachTarget(userId, accountId, (s) => s.useItem()); }

  /** Current status snapshot for a user's accounts (for WS reconnect / initial load). */
  statusSnapshot(userId) {
    const snapshot = {};
    for (const [key, s] of this.sessions) {
      if (key.startsWith(`${userId}:`)) snapshot[s.account.id] = s.status;
    }
    return snapshot;
  }

  // ---- Leaderboard ----

  /** Latest stored leaderboard for a user (for WS reconnect / initial load), or null. */
  leaderboardSnapshot(userId) {
    const row = getLeaderboard.get(userId);
    if (!row) return null;
    try { return { entries: JSON.parse(row.entries), updatedAt: row.updated_at }; }
    catch { return null; }
  }

  _onlineSessionsFor(userId) {
    const out = [];
    for (const [key, s] of this.sessions) {
      if (key.startsWith(`${userId}:`) && s.status === 'online') out.push(s);
    }
    return out;
  }

  /** Have a bot run the leaderboard command, parse the reply, persist + broadcast it. */
  async refreshLeaderboard(userId) {
    const settings = getSettings.get(userId);
    if (!settings || !settings.leaderboard_enabled) return;
    if (this._lbBusy.has(userId)) return; // one refresh at a time per user
    const command = settings.leaderboard_command || '/f top';

    // Prefer the designated account; fall back to any online bot.
    let session = null;
    if (settings.leaderboard_account) {
      const s = this.sessions.get(this._key(userId, settings.leaderboard_account));
      if (s && s.status === 'online') session = s;
    }
    if (!session) session = this._onlineSessionsFor(userId)[0] || null;
    if (!session) {
      this.emitToUser(userId, { type: 'error', message: 'Leaderboard: no online bot to run the command.' });
      return;
    }

    this._lbBusy.add(userId);
    try {
      const lines = await session.runCommandCapture(command, LEADERBOARD_CAPTURE_MS);
      const entries = parseLeaderboard(lines);
      if (!entries.length) {
        this.emitToUser(userId, { type: 'error', message: `Leaderboard: no entries parsed from "${command}" reply.` });
        return;
      }
      const updatedAt = Date.now();
      upsertLeaderboard.run({ user_id: userId, updated_at: updatedAt, entries: JSON.stringify(entries) });
      this.emitToUser(userId, { type: 'leaderboard', entries, updatedAt });
    } catch (e) {
      this.emitToUser(userId, { type: 'error', message: `Leaderboard refresh failed: ${e.message}` });
    } finally {
      this._lbBusy.delete(userId);
    }
  }

  _hourlyLeaderboard() {
    const userIds = new Set([...this.sessions.keys()].map((k) => k.split(':')[0]));
    for (const userId of userIds) {
      const s = getSettings.get(userId);
      if (s && s.leaderboard_enabled) this.refreshLeaderboard(userId).catch(() => {});
    }
  }

  // After a bot comes online, do one delayed refresh (debounced per user) so the board
  // populates soon after connecting instead of waiting for the next hourly tick.
  _maybeAutoRefreshLeaderboard(userId) {
    const s = getSettings.get(userId);
    if (!s || !s.leaderboard_enabled) return;
    if (this._lbAutoTimers.has(userId)) return;
    const t = setTimeout(() => {
      this._lbAutoTimers.delete(userId);
      this.refreshLeaderboard(userId).catch(() => {});
    }, LEADERBOARD_ONLINE_DELAY_MS);
    this._lbAutoTimers.set(userId, t);
  }
}
