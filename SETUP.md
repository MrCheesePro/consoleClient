# Running the panel on the VPS

Day-to-day runbook: deploying an update, restarting, and fixing the things that actually break.

For **first-time** setup (DNS, Node, Caddy, systemd), see [DEPLOY.md](DEPLOY.md). This file assumes
that's already done.

## This box

| | |
|---|---|
| Host | `root@66.42.106.121` (Vultr, Los Angeles, hostname `discordbot`) |
| App directory | `/root/consoleClient` |
| systemd service | `mcafk-panel` |
| Port | `3101`, bound to `127.0.0.1` (Caddy proxies to it) |
| Public URL | `https://afk.joshuyk.com` |

Confirm any of these rather than trusting the table:

```bash
grep -E '^(PORT|HOST|TZ)=' /root/consoleClient/.env
systemctl cat mcafk-panel | grep -E 'ExecStart|WorkingDirectory'
```

---

## Deploy an update

```bash
cd /root/consoleClient
git pull
sudo systemctl restart mcafk-panel
journalctl -u mcafk-panel -n 20 --no-pager
```

You want `MC AFK console client listening on 127.0.0.1:3101` and no restart loop.

Then **hard-reload the browser** — Cmd/Ctrl-Shift-R. `index.html`, `app.js` and `styles.css` are
served as static files, and a normal reload will hand you a mix of cached and fresh ones, which
looks like a broken page.

Database migrations run automatically on that restart. `.env` and `data/` are gitignored, so
pulling never touches your password, accounts, or stats.

### If you need `npm install`

Only when dependencies changed. **Read the next section first** — running it wrong is the single
most likely way to take this panel down.

---

## The Node version trap

Two Node versions live on this box:

| Which | Path | Version |
|---|---|---|
| What systemd runs | `/usr/bin/node` | 20.x |
| What your shell uses | `/root/.nvm/versions/node/*/bin/node` | 24.x |

`better-sqlite3` is a **native module**, compiled against one specific Node ABI. A plain
`npm install` builds it with your shell's Node 24; systemd then starts it with Node 20, which
can't load it, and the service crash-loops:

```
Error: The module '.../better_sqlite3.node' was compiled against a different Node.js version
using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 115.
```

**Always pin the path when installing or rebuilding:**

```bash
cd /root/consoleClient
PATH=/usr/bin:$PATH npm install
```

If you already hit it:

```bash
sudo systemctl stop mcafk-panel
cd /root/consoleClient
PATH=/usr/bin:$PATH npm rebuild better-sqlite3
/usr/bin/node -e "require('better-sqlite3'); console.log('loads OK')"
sudo systemctl start mcafk-panel
```

Only start the service once that prints `loads OK`.

---

## Health checks

```bash
systemctl status mcafk-panel          # running? restart counter climbing?
journalctl -u mcafk-panel -n 50 --no-pager
journalctl -u mcafk-panel -f          # live; Ctrl-C to leave
curl -sI http://127.0.0.1:3101/ | head -1     # expect HTTP/1.1 200
```

Prefer `-n 50 --no-pager` over `-f` when diagnosing. With `-f` the last crash is printed
immediately and looks current even when the service recovered minutes ago — that has caused
confusion more than once.

A **restart counter in the thousands** means it has been crash-looping, not that it restarted
recently. `RestartSec=3` means ~1,200 restarts per hour.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_DLOPEN_FAILED`, `NODE_MODULE_VERSION` | native module built with the wrong Node | rebuild pinned to `/usr/bin` — see above |
| `EADDRINUSE ... :3101` | something already holds the port, usually a stray manual `npm start` | see below |
| 502 from Caddy | service down, or `PORT` ≠ Caddy's `reverse_proxy` | `journalctl -u mcafk-panel -n 50`; compare `.env` with `/etc/caddy/Caddyfile` |
| Login form reloads, never logs in | `NODE_ENV=production` while browsing over plain HTTP | use the `https://` URL |
| Console empty, DevTools shows WS failing | not logged in, or session cookie not reaching the upgrade | confirm you're on `https://afk.joshuyk.com` and logged in |
| Quiet hours fire at the wrong time | no `TZ` — the box runs UTC | see Timezone below |
| Panel looks broken after a deploy | mixed cached/fresh static files | hard-reload |

### Finding what holds the port

```bash
sudo systemctl stop mcafk-panel
PID=$(sudo ss -tlnpH 'sport = :3101' | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$PID" ] && ps -o pid,user,etime,cmd -p "$PID" --no-headers || echo "3101 is free"
```

If that's a `node ... server/index.js` you started by hand, kill it and let systemd own the port:

```bash
sudo kill "$PID"
sleep 2
sudo systemctl start mcafk-panel
```

If it's anything else, don't kill it — change `PORT` in `.env` and the Caddyfile to match.

---

## Timezone

Quiet hours, the check log's *Clear at*, and the raid *Alert started* all read the **server's**
clock. A Vultr box runs UTC, so `00:00`–`14:00` means UTC unless you say otherwise.

```bash
date                                  # what the box currently thinks
grep TZ /root/consoleClient/.env      # is it set?
echo 'TZ=America/New_York' >> /root/consoleClient/.env
sudo systemctl restart mcafk-panel
```

`.env` is gitignored, so `git pull` will never add this for you.

---

## After a deploy: settings worth checking

In the panel (Wall Bot → Wall Settings), these need a human and won't be set by a migration:

- **Whisper command** — `/msg`, `/w`, `/tell`. Verification codes go out this way; wrong value and
  nobody can verify, silently.
- **Faction password** — blank means self-verification is **closed** by design.
- **Webhook URLs** — reminders, raid alerts, check logs, and the leaderboard can each have their
  own channel; each falls back to the wall webhook when blank.
- **Reminder message** — a new default only applies to fresh installs, never to your existing row.

Quickest end-to-end test: click **Mark checked** on the Wall Bot page. That fires a check
confirmation through chat and Discord at once.

---

## Data and backups

Everything that matters lives in `/root/consoleClient/data/` — the SQLite database, Microsoft
token caches, and wall-stat backups. It is gitignored and **backed up by nothing**.

```bash
# before anything risky
cp -r /root/consoleClient/data ~/afk-data-backup-$(date +%F)
```

The panel's **Export JSON** button pulls the wall stats out over HTTP any time. **Reset stats**
writes a timestamped backup into `data/wall-backups/` before wiping, and aborts without touching
the database if that write fails.

---

## More accounts than 3 (proxy pool)

The server allows 3 connections per IP. Each line in **Settings → Proxy Pool** is one IP slot
carrying 3 accounts, so **N accounts needs ⌈N/3⌉ lines**:

```
direct
socks5://botuser:password@127.0.0.1:1080
socks5://botuser:password@127.0.0.1:1081
```

`direct` is this box's main IP. To add another slot:

**1. Buy the IP** — Vultr panel → your instance → Settings → IPv4 → *Add Another IPv4 Address*,
then *Show Details* and note the address **and its netmask**. Vultr may hand out a `/32` in an
unrelated block rather than a neighbour of your primary, so don't assume `/23`.

**2. Make the box hold it.** Don't touch `50-cloud-init.yaml` — cloud-init regenerates it on boot
and your IP silently disappears. Use a file of your own, which netplan merges and cloud-init
leaves alone:

```bash
sudo nano /etc/netplan/99-extra-ips.yaml
```

```yaml
network:
  version: 2
  ethernets:
    enp1s0:
      addresses:
        - 45.32.79.133/32
```

```bash
sudo chmod 600 /etc/netplan/99-extra-ips.yaml
sudo netplan try          # reverts after 120s unless confirmed — safer than `apply`
ip -4 addr show enp1s0    # the new IP must appear before you continue
```

Use `netplan try`, never `apply`: a YAML slip with `apply` can cost you SSH. Keep Vultr's web
console open as the way back in.

**3. Run the proxy script.** Nothing in it needs editing — it detects every global IP that isn't
the DHCP primary, generates a password, and writes the pool to `/root/proxy-pool.txt` (mode 600):

```bash
sudo bash scripts/setup-vultr-proxies.sh
cat /root/proxy-pool.txt
```

Override any of it if you want: `sudo EXTRA_IPS="1.2.3.4" PROXY_PASS='mine' bash scripts/...`

**4. Prove each proxy leaves from its own IP** before trusting it — this is what catches a bad
netmask or a bind that isn't taking:

```bash
curl --socks5 botuser:PASS@127.0.0.1:1080 https://ifconfig.me; echo
```

**5. Paste the pool lines** into Settings → Proxy Pool, then reconnect the bots.

Worth checking once: `sudo reboot`, then `ip -4 addr show enp1s0` — that proves the IP survives
cloud-init regenerating its own netplan file, which is the whole reason for the separate `99-`
file. Better to learn that deliberately than during a raid.

**Before buying several:** extra IPs from one provider can share a subnet, and a server that
range-bans drops them together. Buy one, run it for a day, then buy the rest.

Verify each proxy leaves from its own IP before trusting it:

```bash
curl --socks5 botuser:PASS@127.0.0.1:1080 https://ifconfig.me; echo
```

---

## Full restart from scratch

If the service is wedged and you want a clean start:

```bash
sudo systemctl stop mcafk-panel
pgrep -af 'server/index.js'                  # kill any strays it lists
cd /root/consoleClient
git pull
PATH=/usr/bin:$PATH npm install
sudo systemctl start mcafk-panel
journalctl -u mcafk-panel -n 30 --no-pager
```

Reinstalling the service unit itself (only if it's damaged or Node moved):

```bash
cd /root/consoleClient
sudo bash scripts/install-panel-service.sh
```

That regenerates `/etc/systemd/system/mcafk-panel.service` from whatever `node` is on `sudo`'s
PATH — so make sure that's the Node you intend before running it.
