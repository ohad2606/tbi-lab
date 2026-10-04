#!/usr/bin/env bash
# Sprint 8 → Sprint 7 rollback of the dev-lab services and gate, from the backup taken before the
# first Sprint 8 deployment (units, Caddyfile, oauth2-proxy.cfg, the state tarball, the release
# symlinks).
#
#   deploy/dev-lab/s8/rollback-dev-lab.sh /var/backups/tbi-lab/pre-s8-<date>
#
# It restores the Sprint 7 units, gate configuration and app release, and removes the Sprint 8
# templates, polkit rule and Caddy drop-in. It leaves the Sprint 8 keys (/etc/tbi), state
# (/var/lib/tbi-build/state, /var/lib/tbi-runtime) and system accounts in place: the Sprint 7
# services never read them, and a later re-deployment keeps the same principals.
# The artifact store stays: Sprint 7 reads Sprint 8 manifests (no build records → "Build
# required", the existing UX). To restore the store byte for byte as well, extract
# var-lib-tbi.tgz from the backup (with the services stopped).
set -euo pipefail
b="${1:?usage: rollback-dev-lab.sh <backup dir>}"
sudo test -f "$b/tbi-build.service" && sudo test -f "$b/symlinks.txt"
app="$(sudo sed -n 1p "$b/symlinks.txt")"
sudo test -d "$app"

sudo systemctl stop tbi-build.service tbi-session-host.service
sudo systemctl stop 'tbi-build-job@*.service' 'tbi-qemu@*.service' 2>/dev/null || true
sudo install -m 0644 "$b/tbi-build.service" "$b/tbi-session-host.service" /etc/systemd/system/
sudo rm -f /etc/systemd/system/tbi-build-job@.service /etc/systemd/system/tbi-qemu@.service \
  /etc/polkit-1/rules.d/50-tbi.rules /etc/systemd/system/caddy.service.d/tbi-gate.conf
sudo install -m 0644 "$b/Caddyfile" /etc/caddy/Caddyfile
sudo install -m 0640 -o root -g oauth2-proxy "$b/oauth2-proxy.cfg" /etc/oauth2-proxy/oauth2-proxy.cfg
sudo ln -sfn "$app" /srv/tbi-lab/dev-lab/current.tmp
sudo mv -T /srv/tbi-lab/dev-lab/current.tmp /srv/tbi-lab/dev-lab/current
sudo systemctl daemon-reload
sudo systemctl start tbi-build.service tbi-session-host.service
sudo systemctl restart caddy oauth2-proxy
echo "rolled back to $(basename "$app")"
