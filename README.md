# Minecraft AFK Console Client

A web-hosted control panel for running Minecraft AFK bots (built on
[mineflayer](https://github.com/PrismarineJS/mineflayer)). Three-panel UI:
**Accounts · Settings · Console**.

## Features

- **Single-user panel** — the whole panel is unlocked by one shared password
  (`APP_PASSWORD`). Everything runs under one fixed `local` user; there is no
  per-user registration. (The DB schema is user-scoped, so multi-user is possible
  later, but `server/auth/siteAuth.js` currently gates on the shared password.)
- **Two Minecraft-account auth modes** (per the "Offline/cracked accounts" toggle):
  - **Offline/cracked** — add accounts by username; works on `online-mode=false` servers.
  - **Microsoft device-code** — official OAuth; a code + link is shown to authorize.
    No Minecraft passwords are ever stored; tokens are cached per user.
- **AFK behaviors** — login message (with delay), world-change message, anti-AFK,
  sneak, configurable chat spam, auto-reconnect, show-chat-in-console.
- **Inventory buttons** — drop all items, equip armor, use held item.
- **Live console** — per-account or all-accounts chat stream over WebSocket, send chat.
- **Wall bot** — one designated account runs wall-check reminders for a factions base,
  watches chat for check triggers, tracks a per-player leaderboard, and can raise a repeating
  raid alert. See below.

## Wall bot

Pick one loaded account as the wall bot (Settings → *Wall bot account*, or leave it on Auto to
use the first online bot). It watches that account's chat and reacts to trigger words.

**Listening.** By default the bot only reacts to a **private message sent to it** — a player
whispers `walls` and it counts. A stray "check" in public chat is ignored, so nobody fires a
trigger by accident. Set *Listen on* to change this:

| Value | Behavior |
|-------|----------|
| `dm` (blank = this) | Private messages to the bot only: `[wzul -> me] walls` |
| `chat` | Public and faction chat: `[Member] wzul: walls` |
| `/regex/` | Custom — capture group 1 is the player, group 2 the message |

Set **Whisper command** to whatever your server uses (`/msg`, `/w`, `/tell`). The bot replies
privately for verification codes and refusals, so if this is wrong, verification silently fails.

**Triggers** are configured as a comma-separated list (`check, checked, walls, wall`) matched on
whole-word boundaries, so `checkers` won't fire `check`. If you need something more precise, wrap
a regex in slashes instead: `/^\s*wall\w*\b/`. The same applies to the raid on/off triggers.

**Reminders** fire when nobody has checked for longer than the reminder interval. Each one is
routed by two independent toggles: *Send to Minecraft* and *Send to Discord* (a plain webhook
URL — no bot, no `discord.py`). Everything is mirrored to the panel console either way. Quiet
hours (`HH:MM`, server local time) pause reminders; leave either bound blank to disable them.

Messages are sent exactly as written, so they land in normal chat. To scope them to faction
chat, start the reminder and raid messages themselves with `/f c `.

**Verification** is on by default, so only authorized names can log a check or start a raid.
Two ways onto the roster:

- **In game**, in two steps, both by private message to the bot:

  1. `verify <password>` — the **Faction password** you set in the panel. The bot whispers back a
     random 6-digit code, good for **15 minutes**.
  2. `verify <code>` — confirms, and they're on the roster.

  The code is tied to the player it was issued to, so overhearing someone else's is useless.
  Re-sending the password while a code is still live repeats the same code rather than minting a
  new one, so a lost whisper isn't a dead end.

  Leave the password **blank to close self-verification entirely** — it fails shut, so a blank
  field never means "anyone can join". Wrong guesses are capped at 5 per player per hour, and
  failures are logged to the console without the guessed text.

  The password travels through Minecraft chat as plain text and is stored unhashed in the
  settings row. It's redacted from the panel console, but assume server staff can see it in
  their chat logs — treat it as a shared door code, not a secret, and change it when someone
  leaves the faction.
- **From the panel** — type a username into *Authorized Players*; it lands pre-verified.

Turn *Require verification* off to count anyone who types a trigger.

**Stats** persist in SQLite. **Export JSON** downloads the current totals and roster at any time.
**Reset stats** writes a timestamped backup to `data/wall-backups/` *before* wiping, and aborts
without touching the database if that backup can't be written. A reset clears scores only — the
authorized-player roster and your settings survive it, since a map reset shouldn't make everyone
verify again.

Outbound chat is spaced at least 1.5s apart, the reminder interval has a 30s floor, and the raid
repeat has a 3s floor. Auto-sending faction chat on a timer is what anti-spam systems mute for —
test on your own server first.

## Run

```bash
npm install
npm start          # http://localhost:3000
```

Environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | HTTP port |
| `APP_PASSWORD` | `turtlegang` | **shared unlock password — change this** |
| `SESSION_SECRET` | random | **set a stable value in production** |
| `DB_PATH` | `data/app.db` | SQLite file |
| `TOKENS_DIR` | `data/tokens` | per-user MS token cache |
| `MAX_BOTS_PER_USER` | `20` | concurrent-bot cap |
| `NODE_ENV` | — | `production` enables secure cookies |

## Hosting it publicly

See [DEPLOY.md](DEPLOY.md) for a full walkthrough of putting the panel on a VPS behind
a subdomain, alongside a website that is already running there. Ready-made reverse-proxy
configs live in `scripts/` — `Caddyfile.afk.example` for Caddy, `nginx-afk.conf.example`
for nginx.

## Testing against a real server

Spin up a local Minecraft server with `online-mode=false`, then in the UI:
enable **Offline/cracked accounts**, add a username, set the Server IP, and click **Connect**.

## Architecture

- `server/index.js` — Express + session + WebSocket upgrade wiring.
- `server/auth/` — `siteAuth.js` (site login, bcrypt) · `mcAuth.js` (MS device-code).
- `server/bots/` — `BotManager.js` (lifecycle, per-user cap, event fan-out) ·
  `BotSession.js` (one mineflayer bot + AFK behaviors) · `WallBot.js` (wall checks,
  verification, raid alerts).
- `server/ws/hub.js` — per-user WebSocket routing.
- `server/api.js` — accounts + settings REST.
- `server/db/db.js` — SQLite schema + queries.
- `public/` — vanilla-JS SPA (`index.html`, `styles.css`, `app.js`).

## Notes / responsible use

Multi-accounting AFK bots often violate individual server rules and can violate
Microsoft's Terms of Service. Device-code (not password) auth is the safest available
path. You are responsible for where you point this. Serve behind HTTPS in production.
