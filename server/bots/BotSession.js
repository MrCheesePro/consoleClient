import { SocksClient } from 'socks';
import { profilesFolderFor } from '../auth/mcAuth.js';

// mineflayer pulls in a huge dependency tree (minecraft-data / -protocol / prismarine-*)
// that can take a long time to load on a cold/slow filesystem. Import it lazily on first
// connect so the web server can boot and serve the UI immediately, instead of blocking
// startup on it. The promise is cached, so it only loads once per process.
let mineflayerPromise = null;
function loadMineflayer() {
  if (!mineflayerPromise) mineflayerPromise = import('mineflayer').then((m) => m.default);
  return mineflayerPromise;
}

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;
const ANTI_AFK_INTERVAL_MS = 15000;

function parseAddress(serverIp) {
  const raw = String(serverIp || '').trim();
  const [host, portStr] = raw.split(':');
  const port = portStr ? parseInt(portStr, 10) : 25565;
  return { host: host || 'localhost', port: Number.isFinite(port) ? port : 25565 };
}

/**
 * One live mineflayer connection for a single account. Emits lifecycle + chat events
 * through the `emit(type, payload)` callback supplied by BotManager.
 */
export default class BotSession {
  constructor({ userId, account, settings, emit, proxy = null, onChat = null }) {
    this.userId = userId;
    this.account = account;      // { id, username, auth_type, token_ref }
    this.settings = settings;    // snapshot of the user's settings row
    this.emit = emit;
    this.proxy = proxy;          // null = direct; else { host, port, type, userId, password }
    // Optional observer for every incoming chat line, independent of the show_chat display
    // setting — the wall bot has to watch chat even when the console isn't showing it.
    this.onChat = onChat;

    this.bot = null;
    this.status = 'offline';     // offline | connecting | online
    this.stopped = false;
    this.spawnCount = 0;
    this.reconnectAttempts = 0;

    this._timers = { spam: null, antiAfk: null, reconnect: null, login: null };
  }

  // ---- public API ----
  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    this._setStatus('offline');
    if (this.bot) {
      try { this.bot.quit(); } catch { /* ignore */ }
      this.bot = null;
    }
  }

  applySettings(settings) {
    this.settings = settings;
    if (this.status !== 'online' || !this.bot) return;
    // Re-apply live-adjustable behaviors.
    this._applySneak();
    this._startSpamLoop();
    this._startAntiAfkLoop();
  }

  sendChat(message) {
    if (this.bot && this.status === 'online' && message) {
      try { this.bot.chat(String(message)); } catch (e) { this._err(e.message); }
    }
  }

  // Collect every incoming chat line for `windowMs`, then resolve with them. Used to grab a
  // command's reply (e.g. the /f top leaderboard) without disturbing the normal chat handler.
  captureChat(windowMs = 4000) {
    return new Promise((resolve) => {
      if (!this.bot || this.status !== 'online') { resolve([]); return; }
      const bot = this.bot;
      const lines = [];
      const handler = (msg) => lines.push(String(msg));
      bot.on('messagestr', handler);
      setTimeout(() => {
        try { bot.removeListener('messagestr', handler); } catch { /* ignore */ }
        resolve(lines);
      }, windowMs);
    });
  }

  // Send a command and return the chat lines that arrive within the window.
  async runCommandCapture(command, windowMs = 4000) {
    if (!this.bot || this.status !== 'online') return [];
    const capture = this.captureChat(windowMs); // start listening before sending
    this.sendChat(command);
    return capture;
  }

  dropAll() {
    if (!this.bot || this.status !== 'online') return;
    this._runInventory(async () => {
      const before = this.bot.inventory.items().length;
      for (const item of this.bot.inventory.items()) {
        if (!this.bot || this.status !== 'online') break;
        try {
          await this._clickWithRetry(() => this.bot.tossStack(item), 'drop failed');
          await this._waitTicks(2); // space clicks out so the server can keep up
        } catch (e) { this._err(e.message); }
      }
      // Re-read after a beat: if the server is going to revert the change, it does it now.
      await this._waitTicks(6);
      const after = this.bot?.inventory.items().length ?? before;
      this._reportInventoryResult('Dropped', before - after, before);
    });
  }

  equipArmor() {
    if (!this.bot || this.status !== 'online') return;
    const slots = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };
    this._runInventory(async () => {
      const before = this.bot.inventory.items().length;
      let found = 0;
      for (const item of this.bot.inventory.items()) {
        if (!this.bot || this.status !== 'online') break;
        const name = item.name || '';
        const dest = Object.keys(slots).find((s) => name.endsWith(`_${s}`) || name === s);
        if (!dest) continue;
        found++;
        try {
          await this._clickWithRetry(() => this.bot.equip(item, slots[dest]), 'equip failed');
          await this._waitTicks(2);
        } catch (e) { this._err(e.message); }
      }
      if (found === 0) { this._console('No armor pieces found in inventory.'); return; }
      // Equipping moves armor out of the main inventory, so a successful equip shrinks it.
      await this._waitTicks(6);
      const after = this.bot?.inventory.items().length ?? before;
      this._reportInventoryResult('Equipped', before - after, found);
    });
  }

  useItem() {
    if (!this.bot || this.status !== 'online') return;
    try { this.bot.activateItem(); } catch (e) { this._err(`use item failed: ${e.message}`); }
  }

  // ---- connection lifecycle ----
  async _connect() {
    if (this.stopped) return;
    this._setStatus('connecting');
    const { host, port } = parseAddress(this.settings.server_ip);
    const version = this.settings.server_version && this.settings.server_version !== 'auto'
      ? this.settings.server_version
      : false;

    const options = { host, port, version };

    // Route the TCP connection through this account's assigned SOCKS5 proxy so it leaves
    // from that proxy's IP — this is how we spread accounts across IPs (3 per IP).
    if (this.proxy) {
      options.connect = (client) => {
        SocksClient.createConnection({
          proxy: this.proxy,
          command: 'connect',
          destination: { host, port },
          timeout: 20000,
        }).then(({ socket }) => {
          client.setSocket(socket);
          client.emit('connect');
        }).catch((e) => {
          client.emit('error', new Error(`proxy connect failed (${this.proxy.host}:${this.proxy.port}): ${e.message}`));
        });
      };
    }

    if (this.account.auth_type === 'microsoft') {
      options.auth = 'microsoft';
      // Use the same identifier mcAuth.js warmed the token cache under (token_ref),
      // not the display name — otherwise prismarine-auth looks up a different cache
      // file and re-triggers the device-code prompt. The real in-game username is
      // resolved from the token by minecraft-protocol regardless.
      options.username = this.account.token_ref;
      options.profilesFolder = profilesFolderFor(this.userId);
      options.onMsaCode = (code) => this.emit('msaCode', { accountId: this.account.id, code });
    } else {
      options.auth = 'offline';
      options.username = this.account.username;
    }

    let bot;
    try {
      const mineflayer = await loadMineflayer();
      if (this.stopped) return; // may have been stopped during a slow first import
      bot = mineflayer.createBot(options);
    } catch (e) {
      this._err(`connect failed: ${e.message}`);
      return this._scheduleReconnect();
    }
    this.bot = bot;
    this.spawnCount = 0;

    bot.on('spawn', () => this._onSpawn());
    bot.on('messagestr', (msg) => {
      const text = String(msg);
      if (this.settings.show_chat) this._console(text);
      // An observer must never be able to take the chat listener down with it.
      if (this.onChat) { try { this.onChat(text); } catch { /* ignore */ } }
    });
    bot.on('kicked', (reason) => this._console(`Kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`));
    bot.on('error', (err) => this._err(err.message));
    bot.on('end', (reason) => this._onEnd(reason));
  }

  _onSpawn() {
    this.reconnectAttempts = 0;
    this._setStatus('online');
    this.spawnCount++;

    if (this.spawnCount === 1) {
      // Show the negotiated protocol version — inventory transactions on 1.8 (incl.
      // ViaVersion-fronted servers) are the usual cause of "Server rejected transaction".
      const via = this.proxy ? ` via ${this.proxy.host}:${this.proxy.port}` : '';
      this._console(`Connected (protocol v${this.bot.version})${via}.`);
      this._applySneak();
      this._startSpamLoop();
      this._startAntiAfkLoop();
      const msg = this.settings.login_message;
      if (msg) {
        this._timers.login = setTimeout(() => this.sendChat(msg), this.settings.login_delay_ms || 0);
      }
    } else {
      // Respawn / world change.
      const msg = this.settings.world_change_message;
      if (msg) this.sendChat(msg);
    }
  }

  _onEnd(reason) {
    this._clearTimers();
    this.bot = null;
    if (this.stopped) { this._setStatus('offline'); return; }
    this._console(`Disconnected${reason ? `: ${reason}` : ''}.`);
    if (this.settings.auto_reconnect) this._scheduleReconnect();
    else this._setStatus('offline');
  }

  _scheduleReconnect() {
    this._setStatus('offline');
    if (this.stopped || !this.settings.auto_reconnect) return;
    this.reconnectAttempts++;
    const delay = Math.min(RECONNECT_BASE_MS * this.reconnectAttempts, RECONNECT_MAX_MS);
    this._console(`Reconnecting in ${Math.round(delay / 1000)}s...`);
    this._timers.reconnect = setTimeout(() => this._connect(), delay);
  }

  // ---- behaviors ----
  _applySneak() {
    if (!this.bot) return;
    try { this.bot.setControlState('sneak', !!this.settings.sneak); } catch { /* ignore */ }
  }

  _startSpamLoop() {
    clearInterval(this._timers.spam);
    this._timers.spam = null;
    if (!this.settings.spam_enabled || !this.settings.spam_message) return;
    const delay = Math.max(1000, this.settings.spam_delay_ms || 5000);
    this._timers.spam = setInterval(() => this.sendChat(this.settings.spam_message), delay);
  }

  _startAntiAfkLoop() {
    clearInterval(this._timers.antiAfk);
    this._timers.antiAfk = null;
    if (!this.settings.anti_afk) return;
    this._timers.antiAfk = setInterval(() => {
      if (!this.bot || this.status !== 'online') return;
      try {
        this.bot.swingArm();
        const yaw = Math.random() * Math.PI * 2;
        this.bot.look(yaw, 0, false);
        this.bot.setControlState('jump', true);
        setTimeout(() => { try { this.bot?.setControlState('jump', false); } catch { /* ignore */ } }, 300);
      } catch { /* ignore */ }
    }, ANTI_AFK_INTERVAL_MS);
  }

  // ---- helpers ----
  // Serialize inventory operations onto one chain. Concurrent window clicks (a second
  // button press, or drop overlapping equip) desync the window and make the server
  // reject transactions, so each op waits for the previous one to finish.
  _runInventory(task) {
    this._invChain = (this._invChain || Promise.resolve())
      .then(() => task())
      .catch((e) => this._err(e.message));
    return this._invChain;
  }

  // "Server rejected transaction" on click-heavy versions (notably 1.8) is usually a
  // transient window desync. Wait a few ticks for the server to resync, then retry.
  async _clickWithRetry(fn, label, tries = 3) {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        const transient = /rejected transaction/i.test(e.message || '');
        if (!transient || attempt >= tries) throw new Error(`${label}: ${e.message}`);
        await this._waitTicks(5);
      }
    }
  }

  _waitTicks(n) {
    if (this.bot?.waitForTicks) return this.bot.waitForTicks(n);
    return new Promise((r) => setTimeout(r, n * 50));
  }

  // Report what actually changed in the inventory. If nothing moved, the server ignored
  // or reverted the clicks (locked/protected inventory) — say so instead of faking success.
  _reportInventoryResult(verb, changed, attempted) {
    if (changed <= 0) {
      this._console(`${verb}: no effect — the server kept the items (inventory is locked/protected server-side).`);
    } else {
      this._console(`${verb} ${changed}/${attempted} stack(s).`);
    }
  }

  _clearTimers() {
    clearTimeout(this._timers.login);
    clearTimeout(this._timers.reconnect);
    clearInterval(this._timers.spam);
    clearInterval(this._timers.antiAfk);
    this._timers = { spam: null, antiAfk: null, reconnect: null, login: null };
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('botStatus', { accountId: this.account.id, status });
  }

  _console(text) {
    this.emit('consoleLine', { accountId: this.account.id, username: this.account.username, text });
  }

  _err(text) {
    this.emit('consoleLine', { accountId: this.account.id, username: this.account.username, text: `[error] ${text}` });
  }
}
