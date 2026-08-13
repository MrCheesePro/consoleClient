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
  `BotSession.js` (one mineflayer bot + AFK behaviors).
- `server/ws/hub.js` — per-user WebSocket routing.
- `server/api.js` — accounts + settings REST.
- `server/db/db.js` — SQLite schema + queries.
- `public/` — vanilla-JS SPA (`index.html`, `styles.css`, `app.js`).

## Notes / responsible use

Multi-accounting AFK bots often violate individual server rules and can violate
Microsoft's Terms of Service. Device-code (not password) auth is the safest available
path. You are responsible for where you point this. Serve behind HTTPS in production.
