#!/usr/bin/env bash
# Sprint 13 DEV full rollback: restore dev-lab exactly to the pre-deploy state in /var/backups/tbi-lab/pre-s13-dev-20261012T213407Z (release ba0f4a6).
set -euo pipefail
B=/var/backups/tbi-lab/pre-s13-dev-20261012T213407Z
sudo test -d "$B"
active="$(systemctl list-units --plain --no-legend --state=active 'tbi-qemu@*.service' | wc -l)"
[ "$active" -eq 0 ] || echo "warning: $active session(s) active; they end with the restart"
# Frontend first (the new frontend must not face the old host longer than necessary).
sudo ln -sfn "$(sudo cat $B/frontend-current)" /srv/tbi-lab/dev-lab/current.tmp && sudo mv -T /srv/tbi-lab/dev-lab/current.tmp /srv/tbi-lab/dev-lab/current
for u in tbi-build.service tbi-build-job@.service tbi-session-host.service tbi-qemu@.service; do sudo cp -p "$B/$u" /etc/systemd/system/$u; done
sudo cp -p "$B/50-tbi.rules" /etc/polkit-1/rules.d/50-tbi.rules
sudo sh -c "cp -p '$B'/etc/* /etc/tbi/"
sudo ln -sfn "$(sudo cat $B/services-current)" /srv/tbi-lab/services/current.tmp && sudo mv -T /srv/tbi-lab/services/current.tmp /srv/tbi-lab/services/current
sudo systemctl daemon-reload
sudo systemctl restart tbi-build.service tbi-session-host.service
for _ in $(seq 1 40); do sudo curl -sf --unix-socket /run/tbi-runtime/api.sock http://localhost/health >/dev/null 2>&1 && break; sleep 0.5; done
echo "health: $(sudo curl -sf --unix-socket /run/tbi-runtime/api.sock http://localhost/health)"
echo "services -> $(readlink -f /srv/tbi-lab/services/current); frontend -> $(readlink -f /srv/tbi-lab/dev-lab/current)"
(cd /srv/tbi-lab/services/current && sha256sum *)
