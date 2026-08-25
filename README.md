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

**The reminder is a template.** The shipped default is one line:

```
Check Walls /msg captunnel WALLS : Minutes since last checked: {minutes} by {player}
```

Placeholders, available in every message template:

| Placeholder | Meaning |
|---|---|
| `{minutes}` | minutes since the last real check |
| `{player}` | who checked last (`nobody` until someone has) |
| `{checks}` | that player's own check count |
| `{total}` | checks all-time |

An unrecognised `{name}` is left in the message untouched rather than blanked. Nothing is appended
automatically — what you write is what goes out.

**Check confirmation** is its own template (default `Walls checked by {player} [{checks}]`), sent
when someone logs a check.

`{minutes}` measures from the last **check**, not the last reminder, so it keeps climbing while
the walls go unchecked instead of resetting every time the bot speaks.

If you put the template on **several lines**, each line is sent as its own chat message 1.5s
apart. That is the way to make a `/command` actually run: most servers only treat a message as a
command when it *starts* with the slash, so a `/msg` sitting mid-sentence is sent as ordinary
chat text.

### Discord webhooks

A webhook posts into one channel. No bot, no token, no invite — just a URL.

1. In Discord, open the target channel's **Edit Channel → Integrations → Webhooks**.
   (You need *Manage Webhooks* on that channel.)
2. **New Webhook**, name it, pick the channel, then **Copy Webhook URL**.
3. Paste it into the panel and turn the matching toggle on:
   - *Send to Discord* + *Discord webhook URL* — reminders, check confirmations, raid alerts.
   - *Raid to its own Discord* + *Raid webhook URL* — sends raid alerts to a **different**
     channel instead, so alarms can live somewhere noisier than routine wall checks.

Raid routing in full: with the raid toggle **off**, raids follow the wall settings. With it **on**
and a URL set, raids go to that channel. With it on but the URL blank, raids fall back to the wall
webhook rather than disappearing.

The URL is a secret — anyone holding it can post to that channel. Treat it like a password, and
if it leaks, delete the webhook in Discord and make a new one.

Posts arrive as **embeds** — a coloured bar, a bold title, and a rendered timestamp. Reminders are
red (*Wall Check Alert!*), check confirmations green (*Wall Checked*), raid alerts red, all-clears
grey. The reminder embed has its own body field so it can use markdown and be richer than the
in-game line, which has to stay a single sendable chat message:

```
Minutes Unchecked: **{minutes}**
Last Checker: **{player}** (Total Checks: {checks})
```

**Raid alerts** post their own embed: a TNT icon, the headline *WE ARE GETTING RAIDED!*, a bold
call to action (*Raid Discord body*, default "Check walls immediately and get online."), when the
alert started, and a **time since alert** that climbs with each repeat. Clearing the alert posts
how long it lasted.

**While a raid alert is running, wall reminders stop**, and resume once it's turned off.

**Checks get their own log channel.** Turn on *Checks to a logs channel* with a webhook, and every
recorded check posts a log embed there instead: the player's head and name, the time the walls
were confirmed clear, how long since the previous check, and their raid/wall counts.

A check logged **while a raid alert is running** counts as a *raid* check rather than a wall
check — the two counters are mutually exclusive, so they can be reported apart.

There are three independent Discord destinations, each falling back to the wall webhook when its
own toggle is off or its URL is blank:

| Toggle | Sends | Colour |
|---|---|---|
| *Send to Discord* | reminders | red |
| *Raid to its own Discord* | raid alerts, all-clears | red / grey |
| *Checks to a logs channel* | check logs | cyan |

The player head in the log embed is fetched **by Discord** from `mc-heads.net`, so the player's
name reaches that third-party service. The panel itself never calls out.

### Quiet hours and timezone

Quiet hours are read on **the panel server's clock**, not your own. A VPS almost always runs UTC,
so `00:00`–`14:00` would mean UTC unless you say otherwise. Set your zone in `.env`:

```
TZ=America/New_York
```

Restart the panel afterwards (`sudo systemctl restart mcafk-panel`). Check what the server thinks
the time is with `date`, and list zone names with `timedatectl list-timezones`.

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
