import BotSession from './BotSession.js';
import { getSettings, listAccounts, getAccountById } from '../db/db.js';

const MAX_BOTS_PER_USER = Number(process.env.MAX_BOTS_PER_USER || 20);
const ACCOUNTS_PER_IP = 3; // the target server's per-IP connection cap

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
      if (type === 'botStatus') this._broadcastOnlineCount(userId);
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
}
