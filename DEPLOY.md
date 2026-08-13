# Deploying to a Vultr VPS at afk.joshuyk.com

This panel is a Node server (Express + WebSocket + SQLite). It cannot be hosted on
GitHub Pages, Netlify, or any static host — GitHub holds the source, the VPS runs it.

The VPS already serves another website through Caddy. Nothing below changes that site:
Caddy routes requests by hostname, so the panel gets its own site block on the same
ports 80/443, and the panel's Node process listens privately on 127.0.0.1:3100.

## 0. Clean out a previous attempt (skip on a first install)

Only run this if an earlier install left things behind. It touches **only** the panel —
the other website's files, Caddy site block, and certificate are untouched.

```bash
sudo systemctl disable --now mcafk-panel     # ok if it errors: nothing was installed
sudo rm -f /etc/systemd/system/mcafk-panel.service
sudo systemctl daemon-reload
```

Then delete the old checkout. **This erases the panel's accounts and settings** —
`data/` holds the SQLite database and the cached Microsoft tokens. Back it up first if
you want to keep them:

```bash
cp -r ~/consoleClient/data ~/afk-data-backup    # optional
rm -rf ~/consoleClient
```

If a previous attempt added an `afk.joshuyk.com` block to `/etc/caddy/Caddyfile`,
open the file and delete that block only — leave every other block alone:

```bash
sudo nano /etc/caddy/Caddyfile
```

## 1. DNS

At whoever manages `joshuyk.com`, add:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `afk` | your VPS's public IPv4 | 300 |

Do this **before** step 6 — Caddy issues the certificate on the first request, and
that fails if the hostname does not resolve here yet. Verify:

```bash
dig +short afk.joshuyk.com
```

## 2. Node 18+ on the VPS

`better-sqlite3` is a native module, so a C toolchain must be present:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3
node -v          # must be >= 18
```

## 3. Clone and install

```bash
cd ~
git clone https://github.com/MrCheesePro/consoleClient.git
cd consoleClient
npm install      # compiles better-sqlite3; needs build-essential from step 2
```

## 4. Configure

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # session secret
nano .env
```

Set these exactly — the port and host matter, because Caddy already owns 80/443 and the
panel must sit behind it rather than on the public IP:

```
APP_PASSWORD=<a strong password, not the default>
SESSION_SECRET=<the hex string generated above>
PORT=3100
HOST=127.0.0.1
NODE_ENV=production
```

`NODE_ENV=production` turns on `Secure` session cookies. That is correct here, because
Caddy serves the panel over HTTPS from the very first request. (If you ever test over
plain HTTP, unset it — otherwise the browser discards the cookie and login fails
silently on every attempt.)

Check 3100 is free on this box; if not, pick another port and use it consistently in
`.env` and the Caddyfile:

```bash
sudo ss -tlnp | grep 3100     # no output = free
```

## 5. Run it as a service

```bash
sudo bash scripts/install-panel-service.sh
sudo systemctl status mcafk-panel
journalctl -u mcafk-panel -f      # live logs, Ctrl-C to leave
```

The startup line should read `listening on 127.0.0.1:3100`.

## 6. Caddy site block

Append the block from `scripts/Caddyfile.afk.example` to the bottom of
`/etc/caddy/Caddyfile`, below the existing site's block:

```bash
sudo nano /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Reload (not restart) keeps the other site serving without a gap. Then open
`https://afk.joshuyk.com` — Caddy fetches the certificate on that first request, which
can take a few seconds. Watch it happen:

```bash
journalctl -u caddy -f
```

No certbot, no cron entry: Caddy renews on its own.

## 7. Firewall

Only 80, 443, and SSH need to be open. 3100 stays closed — it is bound to 127.0.0.1 so
it is unreachable from outside regardless, but do not open it.

```bash
sudo ufw status
```

## Updating after a push to GitHub

```bash
cd ~/consoleClient
git pull
npm install
sudo systemctl restart mcafk-panel
```

`.env` and `data/` are gitignored, so pulling never overwrites your password or the
account database.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| 502 from Caddy | Node process down, or on a different port | `journalctl -u mcafk-panel -n 50`; confirm `PORT` in `.env` matches `reverse_proxy` |
| Certificate never issues | DNS not pointing here, or 80/443 blocked | `dig +short afk.joshuyk.com`, `sudo ufw status`, then `journalctl -u caddy -n 50` |
| Login form reloads, never logs in | `NODE_ENV=production` while reaching the panel over plain HTTP | use the `https://` URL, or unset `NODE_ENV` for HTTP testing |
| Console stays empty, DevTools shows WS failing | panel not seeing the session cookie on upgrade | confirm you are on `https://afk.joshuyk.com` and logged in; check `journalctl -u mcafk-panel -f` while reloading |
| `npm install` dies on better-sqlite3 | no compiler | `sudo apt-get install -y build-essential python3` |
| The *other* site answers at afk.joshuyk.com | the new block is missing or Caddy did not reload | `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy` |
| `caddy validate` errors on `basic_auth` | Caddy older than 2.8 | rename the directive to `basicauth` |
