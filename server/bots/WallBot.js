import crypto from 'node:crypto';
import {
  getSettings, getWallState, upsertWallState, incWallCheck, topWallCheckers,
  listWallPlayers, getWallPlayer, upsertWallPlayer,
} from '../db/db.js';

const TICK_MS = 30 * 1000;             // how often the reminder loop wakes up
const CHECK_COOLDOWN_MS = 60 * 1000;   // per-player cooldown between counted checks
const SEND_GAP_MS = 1500;              // minimum spacing between outbound chat messages
const CODE_TTL_MS = 10 * 60 * 1000;    // verification code lifetime
const CODE_MAX_PER_HOUR = 3;           // outstanding-code rate limit, per player
const NOTICE_COOLDOWN_MS = 60 * 1000;  // how often one player can be told to verify
const RECENT_SENT_MAX = 20;            // echo-suppression ring size

// Two built-in chat parsers, selected by name from the wall_chat_pattern setting.
//
// `dm` — only private messages sent TO the bot. Leading server/world tags are skipped, then
// `[sender -> me] message`. This deliberately does NOT match public chat, so a stray "check"
// in faction chat can't register; a player has to message the bot on purpose. It also can't
// match the bot's own outgoing whispers, which read `[me -> sender] ...`.
export const DM_CHAT_PATTERN = '^(?:\\[[^\\]]*\\]\\s*)*\\[\\s*(\\w{3,16})\\s*->\\s*(?:me|you)\\s*\\]\\s*(.*)$';

// `chat` — public/faction chat: optional bracketed tags, an optional rank word, then
// `Name: message` or `Name > message`. Deliberately loose, since formats vary a lot.
export const PUBLIC_CHAT_PATTERN = '^(?:\\[[^\\]]*\\]\\s*)*(?:\\S+\\s+)??(\\w{3,16})\\s*[:>]\\s*(.*)$';

// Blank setting = private messages only. Triggers should be a deliberate act, not something
// anyone can fire by mentioning a word in chat.
export const DEFAULT_CHAT_PATTERN = DM_CHAT_PATTERN;

const NAMED_PATTERNS = {
  dm: DM_CHAT_PATTERN,
  chat: PUBLIC_CHAT_PATTERN,
  public: PUBLIC_CHAT_PATTERN,
};

// ---- pure helpers (exported for tests) ----

/** Minecraft names are case-preserving but not case-sensitive — key everything off this. */
export function normalizePlayer(name) {
  return String(name ?? '').trim().toLowerCase();
}

/** Drop legacy section-sign color codes so they can't break the chat pattern. */
export function stripFormatting(text) {
  return String(text ?? '').replace(/§./g, '');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `/pattern/flags` → RegExp, else treat the whole string as a pattern body.
function toRegExp(source, extraFlags = '') {
  const slash = /^\/(.*)\/([a-z]*)$/s.exec(source);
  const body = slash ? slash[1] : source;
  let flags = slash ? slash[2] : '';
  for (const f of extraFlags) if (!flags.includes(f)) flags += f;
  return new RegExp(body, flags);
}

const patternCache = new Map();
function compilePattern(pattern) {
  const raw = String(pattern ?? '').trim();
  // Accept the friendly names "dm" / "chat" as well as a raw regex, so the common cases don't
  // require anyone to write one.
  const key = NAMED_PATTERNS[raw.toLowerCase()] || raw || DEFAULT_CHAT_PATTERN;
  if (patternCache.has(key)) return patternCache.get(key);
  let re;
  try {
    // Case-insensitive so "-> me" / "-> You" and rank tags of any casing all match.
    re = toRegExp(key, 'i');
  } catch {
    // A user-supplied pattern that doesn't compile falls back to the built-in one rather than
    // throwing from inside the chat handler, which would kill the listener for every later line.
    try { re = new RegExp(DEFAULT_CHAT_PATTERN, 'i'); } catch { re = null; }
  }
  patternCache.set(key, re);
  return re;
}

/**
 * Split a server chat line into who said it and what they said.
 * Returns null when the line doesn't look like player chat (server broadcasts, join messages…).
 */
export function parseChatLine(text, pattern) {
  const raw = stripFormatting(text).trim();
  if (!raw) return null;
  const re = compilePattern(pattern);
  if (!re) return null;
  let m;
  try { m = re.exec(raw); } catch { return null; }
  if (!m || !m[1]) return null;
  return { player: m[1], message: String(m[2] ?? '').trim() };
}

/**
 * Build a matcher from a trigger setting. Accepts either a comma-separated word list
 * (`check, checked, walls`) matched on whole-word boundaries, or a `/regex/flags` literal.
 * A regex that doesn't compile falls back to reading the value as a word list.
 * Always case-insensitive. An empty setting matches nothing.
 */
export function compileTriggers(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return () => false;

  if (/^\/.*\/[a-z]*$/s.test(raw)) {
    try {
      const re = toRegExp(raw, 'i');
      return (message) => re.test(String(message ?? ''));
    } catch { /* not a usable regex — fall through and read it as a word list */ }
  }

  const words = raw.split(',').map((w) => w.trim()).filter(Boolean);
  if (!words.length) return () => false;
  // Hand-rolled boundaries instead of \b so trigger words containing punctuation still work.
  const re = new RegExp(`(?:^|[^\\w])(?:${words.map(escapeRegExp).join('|')})(?![\\w])`, 'i');
  return (message) => re.test(String(message ?? ''));
}

function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is `now` inside the quiet window? Times are `HH:MM` in server local time. Either bound blank
 * (or malformed) disables quiet hours entirely. Handles windows that wrap midnight.
 */
export function isQuietHours(now, start, end) {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === null || e === null || s === e) return false;
  const d = now instanceof Date ? now : new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  return s < e ? (mins >= s && mins < e) : (mins >= s || mins < e);
}

export function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

// ---- the bot ----

/**
 * Wall-check reminders, in-chat check tracking, player verification, and raid alerts for one
 * designated account per user. Owned by BotManager, which feeds it every chat line the wall
 * account sees and supplies `resolveSession` to find that account's live BotSession.
 */
export default class WallBot {
  constructor({ emitToUser, resolveSession }) {
    this.emitToUser = emitToUser;         // (userId, message) => void
    this.resolveSession = resolveSession; // (userId) => BotSession | null
    this.users = new Map();               // userId -> runtime state
    this._tickTimer = setInterval(() => this._tick(), TICK_MS);
  }

  stopAll() {
    clearInterval(this._tickTimer);
    for (const state of this.users.values()) {
      clearInterval(state.raidTimer);
      clearTimeout(state.sendTimer);
    }
    this.users.clear();
  }

  _stateFor(userId) {
    let state = this.users.get(userId);
    if (state) return state;
    const row = getWallState.get(userId);
    state = {
      wallActive: false,
      raidActive: false,
      lastCheckAt: row?.last_check_at || 0,
      totalChecks: row?.total_checks || 0,
      raidTimer: null,
      cooldowns: new Map(),      // player -> ts of last counted check
      notices: new Map(),        // player -> ts of last "please verify" reply
      pendingCodes: new Map(),   // player -> { code, expiresAt }
      codeIssues: new Map(),     // player -> [ts, ...] within the last hour
      queue: [],                 // pending outbound messages
      sendTimer: null,
      lastSentAt: 0,
      recentSent: [],            // our own recent message bodies, for echo suppression
    };
    this.users.set(userId, state);
    return state;
  }

  // ---- panel-driven controls ----

  wallStart(userId) {
    const settings = getSettings.get(userId);
    if (!settings?.wall_enabled) {
      this._error(userId, 'Wall bot is disabled — turn it on in Settings first.');
      return;
    }
    const state = this._stateFor(userId);
    if (state.wallActive) return;
    state.wallActive = true;
    state.lastCheckAt = Date.now();
    this._persist(userId, state);
    this._console(userId, 'Wall checks started.');
    this.broadcast(userId);
  }

  wallEnd(userId) {
    const state = this._stateFor(userId);
    if (!state.wallActive) return;
    state.wallActive = false;
    this._console(userId, 'Wall checks stopped.');
    this.broadcast(userId);
  }

  raidStart(userId) {
    const settings = getSettings.get(userId);
    if (!settings?.raid_enabled) {
      this._error(userId, 'Raid alerts are disabled — turn them on in Settings first.');
      return;
    }
    this._beginRaid(userId, settings, null);
  }

  raidStop(userId) {
    this._endRaid(userId, null);
  }

  /** Credit a check from the panel rather than from chat. */
  manualCheck(userId, player) {
    const settings = getSettings.get(userId);
    const name = normalizePlayer(player) || 'panel';
    this._countCheck(userId, settings, name, { announce: !!settings?.wall_enabled });
  }

  // ---- chat intake ----

  /**
   * Called by BotManager for every chat line seen by a bot. Ignores everything that isn't the
   * designated wall account, so other bots' chat never double-counts.
   */
  handleChat(userId, session, text) {
    const settings = getSettings.get(userId);
    if (!settings?.wall_enabled) return;
    const wallSession = this.resolveSession(userId);
    if (!wallSession || wallSession !== session) return;

    const parsed = parseChatLine(text, settings.wall_chat_pattern);
    if (!parsed) return;

    const player = normalizePlayer(parsed.player);
    const message = parsed.message;
    if (!player || !message) return;
    if (this._isSelf(userId, session, player, message)) return;

    if (this._handleVerify(userId, settings, player, message)) return;
    if (this._handleRaidTriggers(userId, settings, player, message)) return;
    this._handleCheckTrigger(userId, settings, player, message);
  }

  // Our own messages come back through chat. Without this the reminder would satisfy its own
  // trigger and the bot would talk to itself forever.
  _isSelf(userId, session, player, message) {
    const botName = normalizePlayer(session?.bot?.username || session?.account?.username);
    if (botName && player === botName) return true;
    const state = this._stateFor(userId);
    return state.recentSent.some((sent) => message.includes(sent));
  }

  _handleVerify(userId, settings, player, message) {
    const m = /^\s*verify\b\s*(\d{6})?\s*$/i.exec(message);
    if (!m) return false;

    const state = this._stateFor(userId);
    const supplied = m[1];

    if (!supplied) {
      if (this._isAuthorized(userId, settings, player)) {
        this._whisper(userId, player, 'You are already verified.');
        return true;
      }
      const now = Date.now();
      const issues = (state.codeIssues.get(player) || []).filter((ts) => now - ts < 60 * 60 * 1000);
      if (issues.length >= CODE_MAX_PER_HOUR) {
        this._whisper(userId, player, 'Too many verification attempts. Try again later.');
        state.codeIssues.set(player, issues);
        return true;
      }
      const code = generateCode();
      state.pendingCodes.set(player, { code, expiresAt: now + CODE_TTL_MS });
      issues.push(now);
      state.codeIssues.set(player, issues);
      this._whisper(userId, player, `Your verification code is ${code} — reply "verify ${code}" in chat within 10 minutes.`);
      this._console(userId, `Verification code issued to ${player}.`);
      return true;
    }

    const pending = state.pendingCodes.get(player);
    if (!pending || pending.expiresAt < Date.now()) {
      state.pendingCodes.delete(player);
      this._whisper(userId, player, 'No pending code, or it expired. Say "verify" to get a new one.');
      return true;
    }
    // A wrong code burns the pending entry, so guessing costs a fresh (rate-limited) request.
    state.pendingCodes.delete(player);
    if (supplied !== pending.code) {
      this._whisper(userId, player, 'Incorrect code. Say "verify" to get a new one.');
      return true;
    }

    upsertWallPlayer.run({
      user_id: userId, player, verified: 1, label: '', added_at: Date.now(),
    });
    this._whisper(userId, player, 'Verified — your wall checks will now be counted.');
    this._console(userId, `${player} verified.`);
    this.broadcast(userId);
    return true;
  }

  _handleRaidTriggers(userId, settings, player, message) {
    if (!settings.raid_enabled) return false;

    if (compileTriggers(settings.raid_off_trigger)(message)) {
      if (!this._requireAuthorized(userId, settings, player)) return true;
      this._endRaid(userId, player);
      return true;
    }
    if (compileTriggers(settings.raid_trigger)(message)) {
      if (!this._requireAuthorized(userId, settings, player)) return true;
      this._beginRaid(userId, settings, player);
      return true;
    }
    return false;
  }

  _handleCheckTrigger(userId, settings, player, message) {
    if (!compileTriggers(settings.wall_trigger)(message)) return;
    if (!this._requireAuthorized(userId, settings, player)) return;

    const state = this._stateFor(userId);
    const now = Date.now();
    const last = state.cooldowns.get(player) || 0;
    if (now - last < CHECK_COOLDOWN_MS) {
      const wait = Math.ceil((CHECK_COOLDOWN_MS - (now - last)) / 1000);
      this._whisper(userId, player, `Already counted — wait ${wait}s before checking again.`);
      return;
    }
    this._countCheck(userId, settings, player, { announce: true });
  }

  _countCheck(userId, settings, player, { announce }) {
    const state = this._stateFor(userId);
    const now = Date.now();

    incWallCheck.run({ user_id: userId, player, last_check: now });
    state.cooldowns.set(player, now);
    state.totalChecks += 1;
    state.lastCheckAt = now;
    this._persist(userId, state);

    if (announce) {
      const mine = topWallCheckers.all(userId).find((r) => r.player === player);
      const own = mine ? mine.checks : 1;
      this._send(userId, `Walls checked by ${player} — ${own} check${own === 1 ? '' : 's'} (${state.totalChecks} total).`);
    }
    this.broadcast(userId);
  }

  // ---- raid ----

  _beginRaid(userId, settings, byPlayer) {
    const state = this._stateFor(userId);
    if (state.raidActive) {
      if (byPlayer) this._whisper(userId, byPlayer, 'Raid alert is already active.');
      return;
    }
    state.raidActive = true;
    const delay = Math.max(3000, Number(settings.raid_delay_ms) || 15000);
    const message = settings.raid_message || 'RAID ALERT - DEFEND THE BASE';
    this._send(userId, message);
    state.raidTimer = setInterval(() => this._send(userId, message), delay);
    this._console(userId, `Raid alert started${byPlayer ? ` by ${byPlayer}` : ''}.`);
    this.broadcast(userId);
  }

  _endRaid(userId, byPlayer) {
    const state = this._stateFor(userId);
    if (!state.raidActive) {
      if (byPlayer) this._whisper(userId, byPlayer, 'No raid alert is active.');
      return;
    }
    state.raidActive = false;
    clearInterval(state.raidTimer);
    state.raidTimer = null;
    this._send(userId, 'Raid alert cleared.');
    this._console(userId, `Raid alert stopped${byPlayer ? ` by ${byPlayer}` : ''}.`);
    this.broadcast(userId);
  }

  // ---- reminder loop ----

  _tick() {
    for (const [userId, state] of this.users) {
      if (!state.wallActive || state.raidActive) continue;
      const settings = getSettings.get(userId);
      if (!settings?.wall_enabled) continue;
      if (isQuietHours(Date.now(), settings.wall_quiet_start, settings.wall_quiet_end)) continue;

      const interval = Math.max(30000, Number(settings.wall_interval_ms) || 600000);
      if (Date.now() - state.lastCheckAt < interval) continue;

      const elapsed = Math.round((Date.now() - state.lastCheckAt) / 60000);
      const reminder = settings.wall_reminder_message || 'Wall check!';
      this._send(userId, `${reminder} (last check ${elapsed}m ago)`);
      // Reset the clock so reminders repeat on a fixed cadence instead of every tick.
      state.lastCheckAt = Date.now();
      this._persist(userId, state);
      this.broadcast(userId);
    }
  }

  // ---- authorization ----

  _isAuthorized(userId, settings, player) {
    if (!settings.wall_require_verified) return true;
    const row = getWallPlayer.get(userId, player);
    return !!(row && row.verified);
  }

  // Returns true when the player may proceed; otherwise replies (at most once a minute).
  _requireAuthorized(userId, settings, player) {
    if (this._isAuthorized(userId, settings, player)) return true;
    const state = this._stateFor(userId);
    const now = Date.now();
    if (now - (state.notices.get(player) || 0) >= NOTICE_COOLDOWN_MS) {
      state.notices.set(player, now);
      this._whisper(userId, player, 'You are not verified — say "verify" in chat to get a code.');
    }
    return false;
  }

  // ---- output ----

  /** Broadcast message: Minecraft and/or Discord per the routing toggles, always the console. */
  _send(userId, text) {
    const settings = getSettings.get(userId);
    this._console(userId, text);
    if (settings?.wall_to_minecraft) {
      this._enqueue(userId, `${settings.wall_chat_prefix || ''}${text}`, text);
    }
    if (settings?.wall_to_discord && settings.wall_discord_webhook) {
      this._postDiscord(userId, settings.wall_discord_webhook, text);
    }
  }

  /** Private reply to one player. Never leaves Minecraft — codes and refusals aren't for Discord. */
  _whisper(userId, player, text) {
    const settings = getSettings.get(userId);
    if (!settings?.wall_to_minecraft) {
      this._console(userId, `(to ${player}) ${text}`);
      return;
    }
    // Servers differ on the whisper command (/msg, /w, /tell, /pm). Verification codes are
    // delivered this way, so getting it wrong silently breaks verification.
    const cmd = String(settings.wall_msg_command || '/msg').trim();
    this._enqueue(userId, `${cmd} ${player} ${text}`, text);
  }

  // Space outbound chat out. Bursting is what trips server anti-spam and gets the account muted.
  _enqueue(userId, line, body) {
    const state = this._stateFor(userId);
    state.queue.push(line);
    if (body) {
      state.recentSent.push(body);
      while (state.recentSent.length > RECENT_SENT_MAX) state.recentSent.shift();
    }
    this._drain(userId);
  }

  _drain(userId) {
    const state = this._stateFor(userId);
    if (state.sendTimer || !state.queue.length) return;
    const wait = Math.max(0, SEND_GAP_MS - (Date.now() - state.lastSentAt));
    state.sendTimer = setTimeout(() => {
      state.sendTimer = null;
      const line = state.queue.shift();
      if (line) {
        const session = this.resolveSession(userId);
        if (session) {
          session.sendChat(line);
          state.lastSentAt = Date.now();
        } else {
          this._error(userId, 'Wall bot: no online account to send through.');
          state.queue.length = 0;
          return;
        }
      }
      this._drain(userId);
    }, wait);
  }

  async _postDiscord(userId, webhook, text) {
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      // Never let a dead webhook break the Minecraft path.
      this._error(userId, `Discord webhook failed: ${e.message}`);
    }
  }

  _console(userId, text) {
    const session = this.resolveSession(userId);
    this.emitToUser(userId, {
      type: 'consoleLine',
      accountId: session?.account?.id,
      username: session?.account?.username || 'wallbot',
      text: `[wall] ${text}`,
    });
  }

  _error(userId, message) {
    this.emitToUser(userId, { type: 'error', message });
  }

  // ---- state ----

  _persist(userId, state) {
    upsertWallState.run({
      user_id: userId,
      total_checks: state.totalChecks,
      last_check_at: state.lastCheckAt,
    });
  }

  /** Re-read persisted counters, e.g. after a reset wiped them out from under us. */
  reload(userId) {
    const state = this._stateFor(userId);
    const row = getWallState.get(userId);
    state.totalChecks = row?.total_checks || 0;
    state.lastCheckAt = row?.last_check_at || 0;
    state.cooldowns.clear();
    this.broadcast(userId);
  }

  snapshot(userId) {
    const state = this._stateFor(userId);
    return {
      type: 'wallState',
      active: state.wallActive,
      raidActive: state.raidActive,
      lastCheckAt: state.lastCheckAt,
      totalChecks: state.totalChecks,
      top: topWallCheckers.all(userId),
      roster: listWallPlayers.all(userId),
      accountOnline: !!this.resolveSession(userId),
    };
  }

  broadcast(userId) {
    this.emitToUser(userId, this.snapshot(userId));
  }
}
