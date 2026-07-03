#!/usr/bin/env bash
#
# Installs a systemd service so the AFK panel runs on boot and restarts if it crashes
# or you log out. Run from the project root ON THE VPS:
#
#   sudo bash scripts/install-panel-service.sh
#
# Manage it afterwards:
#   sudo systemctl restart mcafk-panel      # restart (e.g. after code changes)
#   sudo systemctl stop mcafk-panel         # stop
#   journalctl -u mcafk-panel -f            # live logs
#
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="${SUDO_USER:-root}"
NODE_BIN="$(command -v node || true)"
SERVICE=/etc/systemd/system/mcafk-panel.service

[[ -n "$NODE_BIN" ]] || { echo "node not found in PATH. Install Node 18+ first."; exit 1; }

# Seed .env from the example on first run, with a generated session secret.
if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  SECRET="$("$NODE_BIN" -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" "$APP_DIR/.env"
  chown "$RUN_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "!! Created $APP_DIR/.env — EDIT IT and set APP_PASSWORD before exposing the panel."
fi

cat >"$SERVICE" <<EOF
[Unit]
Description=MC AFK console panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now mcafk-panel

echo ">> Installed and started mcafk-panel.service (user: $RUN_USER, node: $NODE_BIN)"
echo "   Live logs:  journalctl -u mcafk-panel -f"
echo "   The panel loads config from $APP_DIR/.env"
