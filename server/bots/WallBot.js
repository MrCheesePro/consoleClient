import crypto from 'node:crypto';
import {
  getSettings, getWallState, upsertWallState, incWallCheck, incRaidCheck,
  topWallCheckers, allWallCheckers,
  listWallPlayers, getWallPlayer, upsertWallPlayer, lastWallChecker, lastRaidChecker,
  CHECK_DEFAULT, DISCORD_REMINDER_DEFAULT, DISCORD_RAID_DEFAULT,
  RAID_OUTPOST_REMINDER_DEFAULT, RAID_OUTPOST_COMBINED_DEFAULT, DISCORD_RAID_OUTPOST_DEFAULT,
} from '../db/db.js';

// Discord embed accent colours, as the integers the webhook API expects.
const COLOR_ALERT = 0xED4245; // red — reminders and raids
const COLOR_OK = 0x57F287;    // green — a check landed
const COLOR_MUTED = 0x99AAB5; // grey — an all-clear
const COLOR_LOG = 0x22D3EE;   // cyan — the check log (walls)
const COLOR_RAID_LOG = 0x9B59B6; // purple — the check log (Raid Outpost)
const COLOR_BOARD = 0xF1C40F; // gold — the factions leaderboard

// Player head for the log embed's author line. Discord fetches this itself, so the player's name
// reaches a third-party skin service rather than us calling out. Blank the constant to drop it.
const HEAD_URL = (player) => `https://mc-heads.net/avatar/${encodeURIComponent(player)}/64`;

// MHF_TNT is one of Mojang's stock heads, so the same skin service renders a TNT block —
// no second image host to depend on.
const TNT_ICON = HEAD_URL('MHF_TNT');
const RAID_TITLE = 'WE ARE GETTING RAIDED!';

const TICK_MS = 30 * 1000;             // how often the reminder loop wakes up
const CHECK_COOLDOWN_MS = 60 * 1000;   // per-player cooldown between counted checks
const SEND_GAP_MS = 1500;              // minimum spacing between outbound chat messages
const HOUR_MS = 60 * 60 * 1000;
const VERIFY_MAX_PER_HOUR = 5;         // wrong password/code guesses allowed per player, per hour
const CODE_TTL_MS = 15 * 60 * 1000;    // how long an issued verification code stays usable
const NOTICE_COOLDOWN_MS = 60 * 1000;  // how often one player can be told to verify
const RECENT_SENT_MAX = 20;            // echo-suppression ring size

const RAID_OUTPOST_CHECK_DEFAULT = 'Raid Outpost checked by {player} [{checks}]';

// Raid Outpost server broadcasts, matched against color-stripped lines. Unanchored, so a server
// prefix in front of the "(!)" doesn't break them.
export const RAID_OUTPOST_CLAIMED_RE = /\(!\)\s+([A-Za-z0-9_]+)\s+have claimed the Raid Outpost!/i;
export const RAID_OUTPOST_COOLDOWN_RE = /The raid outpost is now unavailable for 1 HOUR!/i;
export const RAID_OUTPOST_STARTED_RE = /A RAID OUTPOST HAS STARTED!/i;
export const RAID_OUTPOST_LOST_RE = /\(!\)\s+([A-Za-z0-9_]+)\s+have lost the Raid Outpost,\s+as they have held control for 12 hours!/i;

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

/** "6h 59m 26s" — the largest non-zero unit downward, so short gaps stay readable. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** "2026/07/14 14:45:37" in the panel server's timezone — the same clock as quiet hours. */
export function formatClock(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * A Discord role ID from the ping setting. Accepts the bare ID or the copied mention form
 * `<@&123…>`. Anything else returns null, so a typo never turns into a stray ping.
 */
export function parseRoleId(value) {
  const m = /^\s*(?:<@&)?(\d{5,25})>?\s*$/.exec(String(value ?? ''));
  return m ? m[1] : null;
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
      lastReminderAt: 0,         // when we last reminded about walls, kept apart from lastCheckAt
      lastRaidReminderAt: 0,     // same for the outpost — own clock, so neither holds the other back
      wasQuiet: false,           // were walls paused (quiet hours or grace) on the previous tick?
      quietEndedAt: 0,           // when the pause last lifted; restarts the unchecked count
      // Raid Outpost: IDLE → CLAIMED_GRACE → COOLDOWN → ACTIVE_CHECKING → IDLE. Persisted.
      raidOutpostState: row?.raid_outpost_state || 'IDLE',
      raidOutpostHolder: row?.raid_outpost_holder || '', // last faction seen claiming it; '' = unknown
      raidOutpostClaimedAt: row?.raid_outpost_claimed_at || 0,
      lastRaidCheckAt: row?.last_raid_check_at || 0,
      raidStartedAt: 0,          // when the current raid alert began, for "time since alert"
      raidTimer: null,
      cooldowns: new Map(),      // `${kind}:${player}` -> ts of last counted check
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
      this._error(userId, 'Weewoo alerts are disabled — turn them on in Settings first.');
      return;
    }
    this._beginRaid(userId, settings, null);
  }

  raidStop(userId) {
    this._endRaid(userId, null);
  }

  /**
   * Credit a check from the panel rather than from chat. Deliberately not gated by quiet hours:
   * the panel is the operator, and an override is the point of having a button. In-game triggers
   * are the ones that get refused.
   */
  manualCheck(userId, player) {
    const settings = getSettings.get(userId);
    const name = normalizePlayer(player) || 'panel';
    this._countCheck(userId, settings, name, { kind: 'wall', announce: !!settings?.wall_enabled });
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

    // Server broadcasts first — they aren't player chat, so parseChatLine would drop them.
    if (this._handleRaidOutpost(userId, settings, stripFormatting(text))) return;

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

  /**
   * Raid Outpost server broadcasts drive a small state machine. It only ever touches outpost
   * fields — the wall loop, `lastCheckAt` and the wall counters carry on regardless.
   * Returns true when the line was one of the broadcasts.
   */
  _handleRaidOutpost(userId, settings, line) {
    const faction = normalizePlayer(settings.raid_outpost_faction);
    const state = this._stateFor(userId);
    const now = Date.now();
    let m;

    if ((m = RAID_OUTPOST_CLAIMED_RE.exec(line))) {
      const by = normalizePlayer(m[1]);
      const wasOurs = !!faction && (state.raidOutpostState !== 'IDLE' || state.raidOutpostHolder === faction);
      state.raidOutpostHolder = by;
      if (faction && by === faction) {
        state.raidOutpostState = 'CLAIMED_GRACE';
        state.raidOutpostClaimedAt = now;
        this._raidOutpostNotice(userId, COLOR_OK, `We claimed the Raid Outpost (${m[1]}).`);
      } else {
        this._resetRaidOutpost(state);
        if (wasOurs) this._raidOutpostNotice(userId, COLOR_ALERT, `${m[1]} took the Raid Outpost from us.`);
        else this._console(userId, `Raid Outpost claimed by ${by}.`);
      }
    } else if (RAID_OUTPOST_COOLDOWN_RE.test(line)) {
      if (state.raidOutpostState === 'CLAIMED_GRACE') {
        state.raidOutpostState = 'COOLDOWN';
      } else if (state.raidOutpostState === 'IDLE' && faction
        && (!state.raidOutpostHolder || state.raidOutpostHolder === faction)) {
        // The claim went by while we were offline. The cooldown line doesn't say whose it is, so
        // assume ours unless we saw someone else take it. A missed hold of our own outpost costs
        // 12 unchecked hours; a wrong guess costs some reminders the panel shows plainly.
        state.raidOutpostState = 'COOLDOWN';
        state.raidOutpostHolder = faction;
        this._console(userId, `Raid Outpost cooldown started but the claim was missed — assuming ${faction} holds it.`);
      } else {
        return true;
      }
      if (state.raidOutpostState === 'COOLDOWN') this._console(userId, 'Raid Outpost on 1 hour cooldown.');
    } else if (RAID_OUTPOST_STARTED_RE.test(line)) {
      if (state.raidOutpostState !== 'CLAIMED_GRACE' && state.raidOutpostState !== 'COOLDOWN') return true;
      state.raidOutpostState = 'ACTIVE_CHECKING';
      state.lastRaidCheckAt = now;
      state.lastRaidReminderAt = 0;
      this._console(userId, 'Raid Outpost is live — raid checks are on.');
    } else if ((m = RAID_OUTPOST_LOST_RE.exec(line))) {
      const by = normalizePlayer(m[1]);
      if (faction && by === faction) {
        this._resetRaidOutpost(state);
        state.raidOutpostHolder = '';
        this._raidOutpostNotice(userId, COLOR_MUTED, 'We lost the Raid Outpost after holding it for 12 hours.');
      } else if (state.raidOutpostHolder === by) {
        state.raidOutpostHolder = '';
      }
    } else {
      return false;
    }
    this._persist(userId, state);
    this.broadcast(userId);
    return true;
  }

  // Ownership changes go to Discord only (Raid Outpost webhook, falling back to wall) — the server
  // already announces them in game, so echoing them into chat would just be noise.
  _raidOutpostNotice(userId, color, text) {
    const settings = getSettings.get(userId);
    this._send(userId, text, {
      channel: 'raid_outpost', minecraft: false, embed: { color, description: `**${text}**` },
      ping: !!settings?.ping_raid_outpost,
    });
  }

  _resetRaidOutpost(state) {
    state.raidOutpostState = 'IDLE';
    state.raidOutpostClaimedAt = 0;
    state.lastRaidCheckAt = 0;
    state.lastRaidReminderAt = 0;
  }

  /**
   * `walls` and `raid` are separate checks that can share one message: "walls raid" logs both.
   * Each kind is refused on its own terms — walls during quiet hours or grace period, the outpost
   * whenever it isn't live. Outpost checks are deliberately allowed in quiet hours and grace.
   */
  _handleCheckTrigger(userId, settings, player, message) {
    const wantWall = compileTriggers(settings.wall_trigger)(message);
    const wantRaid = compileTriggers(settings.raid_outpost_trigger)(message);
    if (!wantWall && !wantRaid) return;

    const state = this._stateFor(userId);
    const kinds = [];
    if (wantWall) {
      // Checks don't count during quiet hours — nobody is expected to be walking the walls then,
      // and letting them bank checks would inflate the leaderboard for hours nobody was watching.
      if (settings.grace_period) {
        this._notifyOnce(userId, player, 'Grace period — wall checks are off.');
      } else if (isQuietHours(Date.now(), settings.wall_quiet_start, settings.wall_quiet_end)) {
        this._notifyOnce(userId, player, 'Wall checks are paused during quiet hours.');
      } else {
        kinds.push('wall');
      }
    }
    if (wantRaid) {
      if (state.raidOutpostState === 'ACTIVE_CHECKING') kinds.push('raid');
      else this._notifyOnce(userId, player, 'No Raid Outpost check is running.');
    }
    if (!kinds.length) return;

    if (!this._requireAuthorized(userId, settings, player)) return;

    const now = Date.now();
    for (const kind of kinds) {
      const last = state.cooldowns.get(`${kind}:${player}`) || 0;
      if (now - last < CHECK_COOLDOWN_MS) {
        const wait = Math.ceil((CHECK_COOLDOWN_MS - (now - last)) / 1000);
        this._whisper(userId, player, `Already counted — wait ${wait}s before checking again.`);
        continue;
      }
      this._countCheck(userId, settings, player, { kind, announce: true });
    }
  }

  // A wall check moves only the wall clock and counter; a raid check only the outpost's.
  _countCheck(userId, settings, player, { kind = 'wall', announce }) {
    const state = this._stateFor(userId);
    const now = Date.now();
    const raid = kind === 'raid';

    (raid ? incRaidCheck : incWallCheck).run({ user_id: userId, player, last_check: now });
    state.cooldowns.set(`${kind}:${player}`, now);
    state.totalChecks += 1;
    const prev = raid ? state.lastRaidCheckAt : state.lastCheckAt;
    const sinceLast = prev ? now - prev : 0;
    if (raid) {
      state.lastRaidCheckAt = now;
      state.lastRaidReminderAt = 0;
    } else {
      state.lastCheckAt = now;
      state.lastReminderAt = 0; // a real check restarts the reminder cycle
    }
    this._persist(userId, state);

    if (announce) {
      // allWallCheckers, not topWallCheckers — the latter stops at 10 rows, so anyone outside
      // the leaderboard would have been reported as having a single check.
      const mine = allWallCheckers.all(userId).find((r) => r.player === player) || {};
      const wallChecks = mine.checks || 0;
      const raidChecks = mine.raid_checks || 0;
      const values = {
        player,
        checks: raid ? raidChecks : wallChecks,
        total: state.totalChecks,
        minutes: Math.round(sinceLast / 60000),
      };
      const template = raid ? RAID_OUTPOST_CHECK_DEFAULT : (settings.wall_check_message || CHECK_DEFAULT);
      this._send(userId, fillPlaceholders(template, values), {
        channel: 'check',
        embed: {
          color: raid ? COLOR_RAID_LOG : COLOR_LOG,
          author: {
            name: `${player} recorded a ${raid ? 'RAID OUTPOST CHECK' : 'WALL CHECK'}.`,
            icon_url: HEAD_URL(player),
          },
          fields: [
            { name: 'Clear at', value: `\`${formatClock(now)}\``, inline: false },
            { name: 'Time since last check', value: `\`${formatDuration(sinceLast)}\``, inline: true },
            { name: 'Raid Checks', value: `\`${raidChecks}\``, inline: true },
            { name: 'Wall Checks', value: `\`${wallChecks}\``, inline: true },
          ],
          footer: { text: this.resolveSession(userId)?.account?.username || 'wallbot' },
        },
      });
    }
    this.broadcast(userId);
  }

  // ---- raid ----

  _beginRaid(userId, settings, byPlayer) {
    const state = this._stateFor(userId);
    if (state.raidActive) {
      if (byPlayer) this._whisper(userId, byPlayer, 'Weewoo alert is already active.');
      return;
    }
    state.raidActive = true;
    state.raidStartedAt = Date.now();
    const delay = Math.max(3000, Number(settings.raid_delay_ms) || 15000);
    // Rebuilt on every repeat, not captured once — otherwise "time since alert" would freeze at
    // 0s and every repost would carry the opening timestamp.
    // Only the opening alert pings the role; the repeats every few seconds stay silent.
    this._sendRaidAlert(userId, { first: true });
    state.raidTimer = setInterval(() => this._sendRaidAlert(userId), delay);
    this._console(userId, `Weewoo alert started${byPlayer ? ` by ${byPlayer}` : ''}.`);
    this.broadcast(userId);
  }

  /** One raid alert: in-game text plus the Discord embed, with the elapsed time refreshed. */
  _sendRaidAlert(userId, { first = false } = {}) {
    const settings = getSettings.get(userId);
    const state = this._stateFor(userId);
    const startedAt = state.raidStartedAt || Date.now();
    const message = settings.raid_message || 'RAID ALERT - DEFEND THE BASE';

    this._send(userId, message, {
      channel: 'raid',
      ping: first && !!settings.ping_weewoo,
      embed: {
        color: COLOR_ALERT,
        author: { name: RAID_TITLE, icon_url: TNT_ICON },
        description: `**${settings.raid_discord_message || DISCORD_RAID_DEFAULT}**`,
        fields: [
          { name: 'Alert started', value: `\`${formatClock(startedAt)}\``, inline: false },
          { name: 'Time since alert', value: `\`${formatDuration(Date.now() - startedAt)}\``, inline: true },
        ],
        footer: { text: this.resolveSession(userId)?.account?.username || 'wallbot' },
      },
    });
  }

  _endRaid(userId, byPlayer) {
    const state = this._stateFor(userId);
    if (!state.raidActive) {
      if (byPlayer) this._whisper(userId, byPlayer, 'No weewoo alert is active.');
      return;
    }
    const lasted = state.raidStartedAt ? Date.now() - state.raidStartedAt : 0;
    state.raidActive = false;
    state.raidStartedAt = 0;
    clearInterval(state.raidTimer);
    state.raidTimer = null;
    this._send(userId, 'Weewoo alert cleared.', {
      channel: 'raid',
      embed: {
        color: COLOR_MUTED,
        author: { name: 'Weewoo alert cleared.', icon_url: TNT_ICON },
        fields: [
          { name: 'Alert lasted', value: `\`${formatDuration(lasted)}\``, inline: true },
        ],
        footer: { text: this.resolveSession(userId)?.account?.username || 'wallbot' },
      },
    });
    this._console(userId, `Weewoo alert stopped${byPlayer ? ` by ${byPlayer}` : ''}.`);
    this.broadcast(userId);
  }

  // ---- reminder loop ----

  _tick() {
    for (const [userId, state] of this.users) {
      if (!state.wallActive || state.raidActive) continue;
      const settings = getSettings.get(userId);
      if (!settings?.wall_enabled) continue;

      const now = Date.now();
      const grace = !!settings.grace_period;
      const quiet = isQuietHours(now, settings.wall_quiet_start, settings.wall_quiet_end);
      // Grace period and quiet hours both pause walls. Coming out of either restarts the count —
      // nobody was expected to check, so carrying that silence forward would open with an
      // alarming number. `lastCheckAt` itself is left alone — it is the real record of when
      // someone last checked, and the panel reports it as such.
      const paused = grace || quiet;
      if (paused) {
        state.wasQuiet = true;
      } else if (state.wasQuiet) {
        state.wasQuiet = false;
        state.quietEndedAt = now;
        state.lastReminderAt = 0;
      }

      const interval = Math.max(30000, Number(settings.wall_interval_ms) || 600000);
      // Two separate clocks per kind, deliberately. `countFrom` is what "minutes unchecked"
      // measures — the last real check, or the end of the pause if that came later. The reminder
      // clocks control how often we repeat ourselves. Folding them together — as this used to —
      // made every reminder report the interval instead of the real elapsed time. Walls and the
      // outpost pace separately, so a fresh wall check never holds back an overdue raid reminder.
      const countFrom = Math.max(state.lastCheckAt, state.quietEndedAt || 0);
      const wallDue = !paused && now - countFrom >= interval
        && !(state.lastReminderAt && now - state.lastReminderAt < interval);
      const live = state.raidOutpostState === 'ACTIVE_CHECKING';
      const raidDue = live && now - state.lastRaidCheckAt >= interval
        && !(state.lastRaidReminderAt && now - state.lastRaidReminderAt < interval);
      if (!wallDue && !raidDue) continue;

      const last = lastWallChecker.get(userId);
      const lastRaid = lastRaidChecker.get(userId);
      const values = {
        minutes: Math.round((now - countFrom) / 60000),
        total: state.totalChecks,
        player: last?.player || 'nobody',
        checks: last?.checks ?? 0,
        raidMinutes: Math.floor((now - state.lastRaidCheckAt) / 60000),
        raidPlayer: lastRaid?.player || 'nobody',
        raidChecks: lastRaid?.raid_checks ?? 0,
        bot: this._botName(userId),
      };
      const wallBody = fillPlaceholders(settings.wall_discord_message || DISCORD_REMINDER_DEFAULT, values);
      const raidBody = fillPlaceholders(DISCORD_RAID_OUTPOST_DEFAULT, values);

      // The templates own the whole wording — nothing is appended behind the operator's back.
      let template;
      let embed;
      if (live && !paused) {
        // Outpost live in normal hours: one combined line whenever either side is overdue.
        template = settings.raid_outpost_combined_message || RAID_OUTPOST_COMBINED_DEFAULT;
        embed = { title: 'Raid Outpost | Walls Alert!', description: `${raidBody}\n\n${wallBody}` };
      } else if (wallDue) {
        template = settings.wall_reminder_message || 'Wall check! Last checked {minutes}m ago.';
        embed = { title: 'Wall Check Alert!', description: wallBody };
      } else {
        // Paused with the outpost live: grace period or quiet hours. Walls stay silent, but the
        // raid prompt still goes to Minecraft and Discord.
        template = settings.raid_outpost_reminder_message || RAID_OUTPOST_REMINDER_DEFAULT;
        embed = {
          title: grace ? 'Raid Outpost Alert (Grace Period)!' : 'Raid Outpost Alert!',
          description: raidBody,
        };
      }
      this._send(userId, fillPlaceholders(template, values), {
        // Reminders, outpost ones included, share the wall channel — they are the same alert.
        channel: 'wall',
        embed: { color: COLOR_ALERT, ...embed },
      });
      if (wallDue) state.lastReminderAt = now;
      if (raidDue) state.lastRaidReminderAt = now;
      this.broadcast(userId);
    }
  }

  _botName(userId) {
    const session = this.resolveSession(userId);
    return session?.bot?.username || session?.account?.username || 'bot';
  }

  // ---- authorization ----

  _isAuthorized(userId, settings, player) {
    if (!settings.wall_require_verified) return true;
    const row = getWallPlayer.get(userId, player);
    return !!(row && row.verified);
  }

  // Tell a player something at most once a minute, so a refused trigger repeated in frustration
  // doesn't turn into the bot spamming them back.
  _notifyOnce(userId, player, text) {
    const state = this._stateFor(userId);
    const now = Date.now();
    if (now - (state.notices.get(player) || 0) < NOTICE_COOLDOWN_MS) return;
    state.notices.set(player, now);
    this._whisper(userId, player, text);
  }

  // Returns true when the player may proceed; otherwise replies (at most once a minute).
  _requireAuthorized(userId, settings, player) {
    if (this._isAuthorized(userId, settings, player)) return true;
    this._notifyOnce(userId, player, 'You are not verified — say "verify" in chat to get a code.');
    return false;
  }

  // ---- output ----

  /**
   * Broadcast message: Minecraft and/or Discord per the routing toggles, always the console.
   * A multi-line message is sent as one chat message per line, so a single reminder can combine
   * (say) a public call-out with a private status whisper. The outbound queue still spaces them,
   * so a two-line reminder goes out 1.5s apart rather than as a burst.
   */
  _send(userId, text, { channel = 'wall', embed = null, minecraft = true, ping = false } = {}) {
    const settings = getSettings.get(userId);
    const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;

    for (const line of lines) {
      this._console(userId, line);
      if (minecraft && settings?.wall_to_minecraft) this._enqueue(userId, line, line);
    }

    // Raid alerts, Raid Outpost notices and check logs can each go to their own channel. Without a
    // webhook of their own they fall back to the wall routing, so an unfilled field never silently
    // drops a message.
    const useRaid = channel === 'raid' && settings?.raid_to_discord && settings.raid_discord_webhook;
    const useCheck = channel === 'check' && settings?.check_to_discord && settings.check_discord_webhook;
    // Raid Outpost ownership news needs no toggle: filling in the URL is the opt-in.
    const useOutpost = channel === 'raid_outpost' && settings?.raid_outpost_discord_webhook;
    const webhook = useRaid ? settings.raid_discord_webhook
      : useCheck ? settings.check_discord_webhook
        : useOutpost ? settings.raid_outpost_discord_webhook
          : settings?.wall_discord_webhook;
    const enabled = useRaid || useCheck || useOutpost || settings?.wall_to_discord;
    // Discord gets it as one post — line breaks read fine there and it avoids N pings.
    if (enabled && webhook) {
      this._postDiscord(userId, webhook, lines.join('\n'), embed, ping ? parseRoleId(settings.discord_ping_role) : null);
    }
  }

  /**
   * Post a parsed factions board to Discord. Discord-only by design: the whole point of the
   * hourly refresh is that nobody has to read the board in chat, so echoing ten lines back into
   * Minecraft would be the opposite of useful (and a fast route to a spam mute).
   */
  postLeaderboard(userId, entries) {
    if (!entries?.length) return;
    const settings = getSettings.get(userId);
    const useBoard = settings?.leaderboard_to_discord && settings.leaderboard_discord_webhook;
    const webhook = useBoard ? settings.leaderboard_discord_webhook : settings?.wall_discord_webhook;
    const enabled = useBoard || settings?.wall_to_discord;
    if (!enabled || !webhook) return;

    const rows = entries.map((e) => {
      const gain = e.gain === null || e.gain === undefined
        ? ''
        : ` (${e.gain >= 0 ? '+' : ''}${e.gain.toLocaleString('en-US')})`;
      return `\`${String(e.rank).padStart(2, ' ')}.\` **${e.name}** — ${e.points.toLocaleString('en-US')}${gain}`;
    });

    this._postDiscord(userId, webhook, '', {
      color: COLOR_BOARD,
      title: 'Top Factions',
      description: rows.join('\n'),
      footer: { text: this.resolveSession(userId)?.account?.username || 'wallbot' },
    });
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

  async _postDiscord(userId, webhook, text, embed = null, pingRole = null) {
    // An embed gives the message a coloured bar, a bold title and a rendered timestamp. Without
    // one we fall back to a plain content post, so nothing depends on the embed being supplied.
    let body;
    if (embed) {
      // The caller's object is the embed. Anything Discord accepts (author, fields, footer…)
      // passes straight through; only the timestamp is always ours.
      const built = { timestamp: new Date().toISOString(), ...embed };
      // Fall back to the chat text as the body, but not when the embed carries its own fields —
      // those already say everything, and a duplicate line above them just looks like a bug.
      if (built.description === undefined && !built.fields) built.description = text;
      body = { embeds: [built] };
    } else {
      body = { content: text };
    }
    // Embeds never ping, so a role mention has to ride in `content`. allowed_mentions limits the
    // post to exactly that role — nothing else in the message can ping anyone.
    if (pingRole) {
      body.content = `<@&${pingRole}>${body.content ? ` ${body.content}` : ''}`;
      body.allowed_mentions = { roles: [pingRole] };
    }
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
      raid_outpost_state: state.raidOutpostState,
      raid_outpost_holder: state.raidOutpostHolder,
      raid_outpost_claimed_at: state.raidOutpostClaimedAt,
      last_raid_check_at: state.lastRaidCheckAt,
    });
  }

  /** Re-read persisted counters, e.g. after a reset wiped them out from under us. */
  reload(userId) {
    const state = this._stateFor(userId);
    const row = getWallState.get(userId);
    state.totalChecks = row?.total_checks || 0;
    state.lastCheckAt = row?.last_check_at || 0;
    state.lastRaidCheckAt = row?.last_raid_check_at || 0;
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
      raidOutpostState: state.raidOutpostState,
      lastRaidCheckAt: state.lastRaidCheckAt,
      top: topWallCheckers.all(userId),
      roster: listWallPlayers.all(userId),
      accountOnline: !!this.resolveSession(userId),
    };
  }

  broadcast(userId) {
    this.emitToUser(userId, this.snapshot(userId));
  }
}
