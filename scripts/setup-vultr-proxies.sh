#!/usr/bin/env bash
#
# Sets up one SOCKS5 proxy (microsocks) per EXTRA IP on this Vultr VPS.
# Each proxy sends its outbound traffic FROM a specific IP, so the AFK panel can
# spread accounts across IPs (3 accounts per IP).
#
# PREREQUISITES (do these in the Vultr panel + OS FIRST):
#   1. Vultr panel -> your instance -> Settings -> IPv4 -> "Add Another IPv4 Address"
#      (a few $/mo each). Then "Show Details" and note each IP AND its netmask — Vultr may
#      hand out a /32 in an unrelated block, not a neighbour of your primary.
#   2. Add those IPs to the OS network config so the box actually holds them.
#      Do NOT edit 50-cloud-init.yaml: cloud-init regenerates it on boot and your IPs vanish.
#      Put them in a file of your own, which netplan merges and cloud-init leaves alone:
#         sudo nano /etc/netplan/99-extra-ips.yaml
#         ---
#         network:
#           version: 2
#           ethernets:
#             enp1s0:                    # <-- your NIC name (run: ip -br addr)
#               addresses:
#                 - 45.32.79.133/32      # extra IP + the netmask Vultr showed
#         ---
#         sudo chmod 600 /etc/netplan/99-extra-ips.yaml
#         sudo netplan try               # reverts itself after 120s; safer than `apply`
#      Verify:  ip -4 addr show          (each extra IP must be listed before continuing)
#
# THEN just run it — nothing in this file needs editing:
#      sudo bash scripts/setup-vultr-proxies.sh
#
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run with sudo/root."; exit 1; fi

# ===================== CONFIG =====================
# Nothing here needs editing. Every value can be overridden on the command line, e.g.
#   sudo EXTRA_IPS="45.32.79.133 45.32.79.134" PROXY_PASS='mine' bash scripts/setup-vultr-proxies.sh
#
# EXTRA_IPS: left unset, the extra IPs are detected — every global IPv4 on this box that isn't
# the DHCP-assigned primary. The primary is the one carrying the default route, and it is already
# covered by the "direct" pool entry, so it must not become a proxy.
PROXY_USER="${PROXY_USER:-botuser}"
POOL_FILE="${POOL_FILE:-/root/proxy-pool.txt}"

# Generated rather than hard-coded, so no password ends up committed to the repo. It is written
# to the pool file (mode 600) at the end, which is where you read it back from.
#
# A previous run's password is reused when one exists. Re-running this script is normal — an apt
# lock or a new IP will send you back through it — and minting a fresh password each time would
# silently invalidate the pool lines already pasted into the panel.
if [[ -z "${PROXY_PASS:-}" && -r "$POOL_FILE" ]]; then
  PROXY_PASS="$(sed -n 's|^socks5://[^:]*:\([^@]*\)@.*|\1|p' "$POOL_FILE" | head -1)"
  [[ -n "$PROXY_PASS" ]] && echo ">> Reusing the proxy password from $POOL_FILE"
fi
PROXY_PASS="${PROXY_PASS:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)}"
BASE_PORT="${BASE_PORT:-1080}"
# Where the proxies listen. Keep 127.0.0.1 if the PANEL RUNS ON THIS VPS (most secure).
# Use 0.0.0.0 only if the panel runs elsewhere (then firewall these ports!).
LISTEN_IP="${LISTEN_IP:-127.0.0.1}"
# ==================================================

if [[ -n "${EXTRA_IPS:-}" ]]; then
  read -r -a IP_LIST <<< "$EXTRA_IPS"
else
  # `dynamic` marks the DHCP-assigned primary; anything else global was added by hand.
  mapfile -t IP_LIST < <(ip -4 -o addr show scope global | grep -v ' dynamic ' | awk '{print $4}' | cut -d/ -f1)
fi

if [[ ${#IP_LIST[@]} -eq 0 ]]; then
  echo "No extra IPs found on this machine, and EXTRA_IPS was not set."
  echo "Add them in the Vultr panel, put them in /etc/netplan/99-extra-ips.yaml, run"
  echo "'sudo netplan try', and confirm with 'ip -4 addr show' before running this."
  exit 1
fi

echo ">> Extra IPs to proxy: ${IP_LIST[*]}"

# Build + install microsocks if missing.
if ! command -v microsocks >/dev/null 2>&1; then
  echo ">> Installing microsocks..."
  # Only touch apt if something is actually missing. A wedged apt-get (a hung `update` can sit on
  # the lock for days) shouldn't block a build whose tools are already installed.
  if command -v git >/dev/null 2>&1 && command -v make >/dev/null 2>&1 && command -v cc >/dev/null 2>&1; then
    echo ">> git, make and cc already present — skipping apt."
  else
    echo ">> Fetching build tools via apt..."
    if ! apt-get update -y || ! apt-get install -y git build-essential; then
      echo
      echo "!! apt failed. Something else may be holding its lock — check with:"
      echo "     sudo fuser -v /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend"
      echo "   Install the tools yourself, then re-run this script:"
      echo "     sudo apt-get install -y git build-essential"
      exit 1
    fi
  fi
  rm -rf /opt/microsocks
  git clone --depth 1 https://github.com/rofl0r/microsocks /opt/microsocks
  make -C /opt/microsocks
  install -m 0755 /opt/microsocks/microsocks /usr/local/bin/microsocks
fi

# The pool lines embed the proxy password, so this file is a secret. Lock it before writing.
touch "$POOL_FILE"
chmod 600 "$POOL_FILE"
echo "# Paste these lines into the panel's Settings -> Proxy pool:" > "$POOL_FILE"
echo "direct" >> "$POOL_FILE"   # the VPS primary IP is a valid slot too (3 accounts)

port=$BASE_PORT
for ip in "${IP_LIST[@]}"; do
  # Fatal, not a warning. microsocks would start happily and then fail to bind, leaving a
  # service that looks healthy in systemctl but sends every connection out of the wrong IP —
  # which is exactly the thing this script exists to prevent.
  if ! ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -qx "$ip"; then
    echo
    echo "!! $ip is NOT on any interface — refusing to build a proxy that cannot bind."
    echo
    echo "   Most likely 'netplan try' rolled back: it reverts after 120s unless you press"
    echo "   Enter to confirm. Check the address is configured, then re-apply:"
    echo "     cat /etc/netplan/99-extra-ips.yaml"
    echo "     sudo netplan apply          # the YAML already applied cleanly once"
    echo "     ip -4 addr show             # $ip must be listed"
    echo
    exit 1
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
echo "Done. ${#IP_LIST[@]} proxy(ies) + 'direct' = $(( (${#IP_LIST[@]} + 1) * 3 )) accounts max."
echo "Proxy pool lines (also saved to ${POOL_FILE}):"
echo "--------------------------------------------------------------------"
cat "$POOL_FILE"
echo "--------------------------------------------------------------------"
echo "Test one:  curl --socks5 ${PROXY_USER}:${PROXY_PASS}@${LISTEN_IP}:${BASE_PORT} https://ifconfig.me"
echo "(should print the bound extra IP, not the primary IP)"
