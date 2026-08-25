# CLAUDE.md

Guidance for working in this repo. Keep it current when structure or conventions change.

## What this is

A single-page web control panel for running Minecraft AFK bots via
[mineflayer](https://github.com/PrismarineJS/mineflayer). Node/Express backend + a
vanilla-JS SPA. Three-panel UI: **Accounts · Settings · Console**. State lives in a
local SQLite file; bot chat/status stream to the browser over one WebSocket.

## Commands

```bash
npm install
npm start      # node server/index.js  -> http://localhost:3000
npm run dev    # same, with --watch auto-restart
npm test       # node --test (test/wallbot.test.js: chat parsing, triggers, verification)
```

There is no build step or bundler — `public/` is served as static files.

## Runtime layout

```
server/
  index.js          Express + session + HTTP server; upgrades WS on the session cookie
  api.js            REST: /api/accounts, /api/settings (mounted behind requireAuth)
  auth/
    siteAuth.js     Panel unlock (shared APP_PASSWORD) + requireAuth middleware
    mcAuth.js       Microsoft device-code flow (prismarine-auth), warms token cache
  bots/
    BotManager.js   Owns all live bots, keyed `${userId}:${accountId}`; fans events to WS
    BotSession.js   One mineflayer bot: connect, reconnect, AFK behaviors, inventory
    WallBot.js      Wall-check reminders, chat triggers, player verification, raid alerts
  db/db.js          better-sqlite3: schema (users/accounts/settings) + prepared queries
  ws/hub.js         WebSocket registry per user; routes inbound control msgs to BotManager
public/
  index.html        Static markup for all three panels + MSA modal
  app.js            SPA logic: fetch REST, drive WS, render accounts/console/settings
  styles.css
data/                SQLite db + per-user MS token caches (gitignored)
```

## How auth actually works (important)

Despite the user-scoped DB schema, this runs in **single-user mode**:

- The whole panel is gated by one shared password, `APP_PASSWORD` (default
  `turtlegang`) in `server/auth/siteAuth.js`. There is no per-user registration.
- On login, the session is pinned to `DEFAULT_USER_ID = 'local'` (`db.js`). Every
  account, setting, and bot belongs to that fixed user.
- `users.email`/`password_hash` columns and `insertUser`/`getUserByEmail` exist for a
  possible future multi-user mode but are **not used** by the running app. Don't assume
  they're wired up.

There are two *Minecraft-account* auth types (separate from panel auth), chosen by the
"Offline/cracked accounts" toggle: `offline` (by username) and `microsoft`
(device-code OAuth; no MC password stored, tokens cached under `data/tokens/<userId>/`).

## Data flow conventions

- **REST is for CRUD** (accounts, settings). **WebSocket is for actions and live data**
  (connect/disconnect bots, sendChat, inventory buttons, and all console/status output).
  New realtime features go through `ws/hub.js` → `BotManager`, not REST.
- The Microsoft add-account flow is async: `POST /api/accounts` returns `202` immediately,
  then the device code and final `accountAdded` arrive over WS.
- Settings are a single flat row per user. Bool settings are stored as `0/1`; the client
  sends raw values and `api.js#normalizeSettingsPatch` coerces them. When adding a
  setting you must touch **all four**: the `settings` table in `db.js`, `SETTINGS_FIELDS`
  in `db.js`, the `BOOL_KEYS`/`INT_KEYS` sets in `api.js`, and a `data-setting`-tagged
  input in `index.html` (the client auto-wires any `[data-setting]` element).
- Every bot event carries `accountId`; `'all'` targets all of the user's bots.
- **Wall bot** state (`wallState`) streams over WS like `leaderboard` does — `hub.handleUpgrade`
  replays a snapshot on (re)connect. Inbound control messages: `wallStart`, `wallEnd`,
  `wallCheck`, `raidStart`, `raidStop`. But the stats **export/reset** and the **roster CRUD**
  live on REST (`/api/wall/*`) because they're file- and CRUD-shaped, not live data.
- `BotSession` takes an optional `onChat` callback that fires for every incoming chat line
  regardless of the `show_chat` display setting — that's how `WallBot` observes chat without
  forcing the console on. `BotManager` wires it when it constructs each session.
- Wall-bot player names are stored **lowercased** in `wall_stats` / `wall_players`
  (`normalizePlayer` in `WallBot.js`); compare lowercased or one player splits across two rows.
- `wall_chat_pattern` selects how chat is parsed: the names `dm` (default when blank) and `chat`
  resolve to `DM_CHAT_PATTERN` / `PUBLIC_CHAT_PATTERN` in `WallBot.js`, anything else is used as a
  regex. Group 1 must capture the player, group 2 the message. DM mode is the default so a trigger
  requires a deliberate whisper rather than any word said in public chat.
- The bot's outgoing whispers render as `[me -> player]`, the mirror of the `[player -> me]` DM
  pattern, so they can't parse as inbound and loop. Don't "improve" that regex to match both
  directions.
- Self-verification is two steps: `verify <wall_verify_password>` issues a 6-digit code with a
  15-minute TTL (`CODE_TTL_MS`), then `verify <code>` confirms. `_handleVerify` checks the pending
  code **before** the password, so a password that happens to be six digits still can't be read as
  a code. Codes live in memory (`pendingCodes`), keyed by player, so a restart drops them.
- A **blank password closes** self-verification rather than opening it — `_handleVerify` fails shut
  on purpose, so don't "fix" the empty case by letting it through. Wrong guesses are rate-limited
  per player and never logged verbatim.
- Quiet hours (`isQuietHours`) read the **Node process's local clock** via `getHours()`. Set `TZ`
  in `.env` to control it; a VPS defaults to UTC. Don't hard-code a zone into the comparison.
- Quiet hours suppress reminders **and** refuse in-game check triggers. `manualCheck` (the panel
  button) is an intentional override, and raid triggers are intentionally never gated.
- Leaving the quiet window sets `quietEndedAt`, and `{minutes}` measures from
  `max(lastCheckAt, quietEndedAt)`. `lastCheckAt` is deliberately **not** reset — it is the real
  record the panel and rail display, so don't "simplify" this by overwriting it.
- **`lastCheckAt` and `lastReminderAt` are separate on purpose.** The first only moves when someone
  actually checks and is the basis for `{minutes}`; the second only paces how often the bot repeats
  itself. Collapsing them (as an earlier version did) makes every reminder report the interval
  instead of the real elapsed time, and corrupts the persisted last-check timestamp that the panel
  and rail display. Only `lastCheckAt` is persisted.
- `WallBot#_send` takes `{ channel: 'wall' | 'raid' | 'check', embed }`. Each channel prefers its
  own webhook and **falls back to the wall webhook** when its toggle is off or its URL is blank —
  a message must never vanish because a field was left empty. With an `embed` the post is
  `{embeds:[…]}`; the caller's object *is* the embed, so `author`/`fields`/`footer` pass straight
  through and only `timestamp` is forced. No `embed` means a plain `{content}` post, so the embed
  is never load-bearing.
- `wall_stats` splits `checks` (wall) from `raid_checks` (logged while a raid was running). They
  are **mutually exclusive** — one check increments exactly one counter. The leaderboard and
  `{checks}` rank on `checks`. Raid output prefers `raid_discord_webhook`
  when `raid_to_discord` is on **and** the URL is non-empty, otherwise it falls back to the wall
  webhook — an alert should never silently go nowhere because a field was left blank.
- `WallBot#_send` splits its text on newlines and sends **one chat message per line** (spaced by
  the outbound queue). `wall_reminder_message` is a template run through `fillPlaceholders`
  (`{minutes}`, `{total}`, `{player}`); unknown placeholders are left as-is. Nothing is appended
  to the template — if you add a detail, add a placeholder rather than concatenating onto it.
- `BotSession#_redact` strips the verify password out of console lines before they reach the
  panel. The `onChat` observer still gets the raw line, because `WallBot` has to compare against
  it — keep that asymmetry if you touch the `messagestr` handler.

## Conventions

- ESM everywhere (`"type": "module"`), Node ≥ 18, 2-space indent.
- No framework on the client — plain DOM. `$ = getElementById`; render functions rebuild
  their section from state (`accounts`, `settings`, `statuses`).
- DB access is only via the prepared statements / helpers exported from `db.js`. Don't
  build ad-hoc SQL elsewhere.
- Bot behavior belongs in `BotSession.js`; multi-bot orchestration in `BotManager.js`.

## Config (env vars)

`PORT` (3000) · `APP_PASSWORD` (`turtlegang` — change it) · `SESSION_SECRET` (random per
boot; set a stable value in prod) · `DB_PATH` (`data/app.db`) · `TOKENS_DIR`
(`data/tokens`) · `WALL_BACKUPS_DIR` (`data/wall-backups`) · `MAX_BOTS_PER_USER` (20) ·
`NODE_ENV` (`production` enables secure cookies).

## Gotchas

- Not a git repo yet; `data/`, `node_modules/`, `.env`, `*.log` are gitignored.
- `better-sqlite3` is a native module — a Node version change may require `npm rebuild`.
- Serve behind HTTPS in production (WS uses `wss` and cookies use `secure` only when
  `NODE_ENV=production`).
