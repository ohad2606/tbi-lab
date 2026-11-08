#!/usr/bin/env bash
# Restore staging (tbi-s8) exactly to the pre-71b40fb state (/var/backups/tbi-lab/s13-staging-pre-71b40fb-20261013T083403Z, release c3b148b).
set -euo pipefail
B=/var/backups/tbi-lab/s13-staging-pre-71b40fb-20261013T083403Z
sudo -n test -d "$B"
sudo -n sh -c "set -e; for u in tbi-s8-build.service tbi-s8-build-job@.service tbi-s8-session-host.service tbi-s8-qemu@.service; do cp -p '$B'/\$u /etc/systemd/system/; done; cp -p '$B'/50-tbi-s8.rules /etc/polkit-1/rules.d/; cp -p '$B'/etc/* /etc/tbi-s8/; cp -p '$B'/bundles/* /srv/tbi-lab/s8-staging/"
sudo -n systemctl daemon-reload
sudo -n systemctl restart tbi-s8-build.service tbi-s8-session-host.service
for _ in $(seq 1 40); do sudo -n curl -sf --unix-socket /run/tbi-s8-runtime/api.sock http://x/health >/dev/null 2>&1 && break; sleep 0.25; done
echo "health: $(sudo -n curl -s --unix-socket /run/tbi-s8-runtime/api.sock http://x/health)"
sudo -n sh -c "cd /srv/tbi-lab/s8-staging && sha256sum *"
