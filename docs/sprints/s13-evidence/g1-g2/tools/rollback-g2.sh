#!/bin/bash
# Roll the DEV gate back from G2 to the pre-G2 state (G1 kept), from a verified backup.
# Usage: rollback-g2.sh /var/backups/tbi-lab/g2-pre-<ts>
set -euo pipefail
B=${1:?backup dir}
sudo test -f "$B/oauth2-proxy.cfg" && sudo test -f "$B/Caddyfile"
sudo install -m 640 -o root -g oauth2-proxy "$B/oauth2-proxy.cfg" /etc/oauth2-proxy/oauth2-proxy.cfg
sudo rm -f /etc/systemd/system/oauth2-proxy.service.d/10-log-filter.conf
sudo rmdir --ignore-fail-on-non-empty /etc/systemd/system/oauth2-proxy.service.d 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl restart oauth2-proxy
sudo install -m 644 -o root -g root "$B/Caddyfile" /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
sudo systemctl reload caddy
sudo cmp "$B/oauth2-proxy.cfg" /etc/oauth2-proxy/oauth2-proxy.cfg
sudo cmp "$B/Caddyfile" /etc/caddy/Caddyfile
echo "restored; LogFilterPatterns: [$(systemctl show oauth2-proxy -p LogFilterPatterns --value)]"
systemctl is-active oauth2-proxy caddy
