#!/usr/bin/env bash
#
# Sets up one SOCKS5 proxy (microsocks) per EXTRA IP on this Vultr VPS.
# Each proxy sends its outbound traffic FROM a specific IP, so the AFK panel can
# spread accounts across IPs (3 accounts per IP).
#
# PREREQUISITES (do these in the Vultr panel + OS FIRST):
#   1. Vultr panel -> your instance -> Settings -> IPv4 -> "Add IPv4 Address"
#      (a few $/mo each). Note each new IP and the netmask Vultr shows.
#   2. Add those IPs to the OS network config so the box actually holds them.
#      On Ubuntu (netplan), edit /etc/netplan/*.yaml, e.g.:
#         network:
#           version: 2
#           ethernets:
#             enp1s0:                 # <-- your NIC name (run: ip -br addr)
#               dhcp4: true
#               addresses:
#                 - 45.32.0.11/23     # extra IP + Vultr's netmask
#                 - 45.32.0.12/23
#      then:  sudo netplan apply
#      Verify:  ip -4 addr show      (each extra IP should be listed)
#
# THEN edit the CONFIG block below and run:  sudo bash setup-vultr-proxies.sh
#
set -euo pipefail

# ===================== CONFIG =====================
# Your EXTRA IPv4 addresses (do NOT include the primary IP — "direct" covers that).
EXTRA_IPS=(
  "45.32.0.11"
  "45.32.0.12"
)
PROXY_USER="botuser"
PROXY_PASS="CHANGE-THIS-STRONG-PASSWORD"
BASE_PORT=1080
# Where the proxies listen. Keep 127.0.0.1 if the PANEL RUNS ON THIS VPS (most secure).
# Use 0.0.0.0 only if the panel runs elsewhere (then firewall these ports!).
LISTEN_IP="127.0.0.1"
# ==================================================

if [[ $EUID -ne 0 ]]; then echo "Run with sudo/root."; exit 1; fi

# Build + install microsocks if missing.
if ! command -v microsocks >/dev/null 2>&1; then
  echo ">> Installing microsocks..."
  apt-get update -y
  apt-get install -y git build-essential
  rm -rf /opt/microsocks
  git clone --depth 1 https://github.com/rofl0r/microsocks /opt/microsocks
  make -C /opt/microsocks
  install -m 0755 /opt/microsocks/microsocks /usr/local/bin/microsocks
fi

POOL_FILE="/root/proxy-pool.txt"
echo "# Paste these lines into the panel's Settings -> Proxy pool:" > "$POOL_FILE"
echo "direct" >> "$POOL_FILE"   # the VPS primary IP is a valid slot too (3 accounts)

port=$BASE_PORT
for ip in "${EXTRA_IPS[@]}"; do
  if ! ip -4 addr show | grep -qw "$ip"; then
    echo "!! WARNING: $ip is NOT on any interface. Add it via netplan first (see header)."
  fi

  svc="microsocks-${port}"
  cat >"/etc/systemd/system/${svc}.service" <<EOF
[Unit]
Description=microsocks SOCKS5 proxy (outbound bind ${ip})
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/microsocks -i ${LISTEN_IP} -p ${port} -b ${ip} -u ${PROXY_USER} -P ${PROXY_PASS}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now "$svc"
  echo "socks5://${PROXY_USER}:${PROXY_PASS}@${LISTEN_IP}:${port}" >> "$POOL_FILE"
  echo ">> ${svc}: listening ${LISTEN_IP}:${port}, outbound from ${ip}"
  port=$((port + 1))
done

echo
echo "===================================================================="
echo "Done. ${#EXTRA_IPS[@]} proxy(ies) + 'direct' = $(( (${#EXTRA_IPS[@]} + 1) * 3 )) accounts max."
echo "Proxy pool lines (also saved to ${POOL_FILE}):"
echo "--------------------------------------------------------------------"
cat "$POOL_FILE"
echo "--------------------------------------------------------------------"
echo "Test one:  curl --socks5 ${PROXY_USER}:${PROXY_PASS}@${LISTEN_IP}:${BASE_PORT} https://ifconfig.me"
echo "(should print the bound extra IP, not the primary IP)"
