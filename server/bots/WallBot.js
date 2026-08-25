import crypto from 'node:crypto';
import {
  getSettings, getWallState, upsertWallState, incWallCheck, topWallCheckers,
  listWallPlayers, getWallPlayer, upsertWallPlayer, lastWallChecker,
} from '../db/db.js';

const TICK_MS = 30 * 1000;             // how often the reminder loop wakes up
const CHECK_COOLDOWN_MS = 60 * 1000;   // per-player cooldown between counted checks
const SEND_GAP_MS = 1500;              // minimum spacing between outbound chat messages
const HOUR_MS = 60 * 60 * 1000;
const VERIFY_MAX_PER_HOUR = 5;         // wrong password/code guesses allowed per player, per hour
const CODE_TTL_MS = 15 * 60 * 1000;    // how long an issued verification code stays usable
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

/** Six-digit confirmation code. randomInt, not Math.random — this is a credential. */
export function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Substitute `{name}` placeholders in a message template. An unknown placeholder is left
 * untouched rather than blanked, so a literal brace in a message survives intact.
 */
export function fillPlaceholders(text, values) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
  ));
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
      verifyAttempts: new Map(), // player -> [ts, ...] of wrong password/code guesses this hour
      pendingCodes: new Map(),   // player -> { code, expiresAt } awaiting confirmation
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

  /**
   * Two-step self-verification, both steps over private message:
   *   1. `verify <password>` — the shared faction password from the panel. Correct, and the bot
   *      whispers back a random 6-digit code that lives for 15 minutes.
   *   2. `verify <code>` — confirms, and the sender lands on the roster.
   *
   * The code is bound to the player it was issued to, so knowing someone else's code is useless:
   * the lookup is keyed by whoever sent the message, and the server is what decides that name.
   */
  _handleVerify(userId, settings, player, message) {
    const m = /^\s*verify\b\s*(.*)$/i.exec(message);
    if (!m) return false;

    const supplied = m[1].trim();
    const password = String(settings.wall_verify_password || '').trim();
    const state = this._stateFor(userId);
    const now = Date.now();

    if (this._isAuthorized(userId, settings, player)) {
      this._whisper(userId, player, 'You are already verified.');
      return true;
    }

    // No password set = self-verification is closed, rather than open to everyone. Failing
    // shut matters here: the alternative would quietly let any passer-by onto the roster.
    if (!password) {
      this._whisper(userId, player, 'Self-verification is disabled. Ask an admin to add you.');
      return true;
    }

    // Asking without an argument is a help request, not a guess — don't spend an attempt on it.
    if (!supplied) {
      this._whisper(userId, player, 'Message me "verify <password>" with the faction password.');
      return true;
    }

    // Drop a stale code before anything else, so an expired one can't be completed and the
    // password path issues a fresh one.
    let pending = state.pendingCodes.get(player);
    if (pending && pending.expiresAt <= now) {
      state.pendingCodes.delete(player);
      pending = null;
    }

    const attempts = (state.verifyAttempts.get(player) || []).filter((ts) => now - ts < HOUR_MS);
    if (attempts.length >= VERIFY_MAX_PER_HOUR) {
      state.verifyAttempts.set(player, attempts);
      this._whisper(userId, player, 'Too many attempts. Try again later.');
      return true;
    }

    // Step 2: completing with a live code. Checked before the password so that a password which
    // happens to be six digits still can't be confused with a code.
    if (pending && supplied === pending.code) {
      state.pendingCodes.delete(player);
      state.verifyAttempts.delete(player);
      upsertWallPlayer.run({
        user_id: userId, player, verified: 1, label: '', added_at: now,
      });
      this._whisper(userId, player, 'Verified — your wall checks will now be counted.');
      this._console(userId, `${player} verified.`);
      this.broadcast(userId);
      return true;
    }

    // Step 1: correct password issues a code. Re-sending the password while one is still live
    // repeats the same code rather than minting a new one, so a lost whisper isn't a dead end
    // and nobody can spam themselves a stream of codes.
    if (supplied === password) {
      if (!pending) {
        pending = { code: generateCode(), expiresAt: now + CODE_TTL_MS };
        state.pendingCodes.set(player, pending);
        this._console(userId, `Verification code issued to ${player}.`);
      }
      const mins = Math.max(1, Math.round((pending.expiresAt - now) / 60000));
      this._whisper(userId, player, `Your code is ${pending.code} — message me "verify ${pending.code}" within ${mins} minute${mins === 1 ? '' : 's'}.`);
      return true;
    }

    attempts.push(now);
    state.verifyAttempts.set(player, attempts);
    const left = VERIFY_MAX_PER_HOUR - attempts.length;
    this._whisper(userId, player, pending ? 'Wrong code.' : 'Wrong password.');
    // Log that it happened, never what was guessed — the console is visible in the panel.
    this._console(userId, `Failed verify attempt from ${player} (${left} left this hour).`);
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
    this._send(userId, message, { channel: 'raid' });
    state.raidTimer = setInterval(() => this._send(userId, message, { channel: 'raid' }), delay);
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
    this._send(userId, 'Raid alert cleared.', { channel: 'raid' });
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

      // The template owns the whole wording now, including where the elapsed time goes — nothing
      // is appended behind the operator's back.
      const elapsed = Math.round((Date.now() - state.lastCheckAt) / 60000);
      const template = settings.wall_reminder_message || 'Wall check! Last checked {minutes}m ago.';
      this._send(userId, fillPlaceholders(template, {
        minutes: elapsed,
        total: state.totalChecks,
        player: lastWallChecker.get(userId)?.player || 'nobody',
      }));
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

  /**
   * Broadcast message: Minecraft and/or Discord per the routing toggles, always the console.
   * A multi-line message is sent as one chat message per line, so a single reminder can combine
   * (say) a public call-out with a private status whisper. The outbound queue still spaces them,
   * so a two-line reminder goes out 1.5s apart rather than as a burst.
   */
  _send(userId, text, { channel = 'wall' } = {}) {
    const settings = getSettings.get(userId);
    const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;

    for (const line of lines) {
      this._console(userId, line);
      if (settings?.wall_to_minecraft) this._enqueue(userId, line, line);
    }

    // Raid alerts can go to their own channel. If no raid webhook is configured they fall back
    // to the wall routing, so turning the raid webhook off never silently drops the alert.
    const useRaid = channel === 'raid' && settings?.raid_to_discord && settings.raid_discord_webhook;
    const webhook = useRaid ? settings.raid_discord_webhook : settings?.wall_discord_webhook;
    const enabled = useRaid || settings?.wall_to_discord;
    // Discord gets it as one post — line breaks read fine there and it avoids N pings.
    if (enabled && webhook) {
      this._postDiscord(userId, webhook, lines.join('\n'));
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
