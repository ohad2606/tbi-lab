#!/usr/bin/env bash
# Gate C full rollback: restore dev-lab exactly to the pre-S12 state captured in /var/backups/tbi-lab/pre-s12-gatec-20261011T141919Z.
set -euo pipefail
B=/var/backups/tbi-lab/pre-s12-gatec-20261011T141919Z
sudo test -d "$B"
active="$(systemctl list-units --plain --no-legend --state=active 'tbi-qemu@*.service' | wc -l)"
[ "$active" -eq 0 ] || echo "warning: $active session(s) active; they end with the restart"
# Frontend first (the S12 frontend must never face the S11 backend longer than necessary).
sudo ln -sfn "$(sudo cat $B/frontend-current)" /srv/tbi-lab/dev-lab/current.tmp && sudo mv -T /srv/tbi-lab/dev-lab/current.tmp /srv/tbi-lab/dev-lab/current
for u in tbi-build.service tbi-build-job@.service tbi-session-host.service tbi-qemu@.service; do sudo cp -p "$B/$u" /etc/systemd/system/$u; done
sudo rm -f /etc/tbi/runtime.json
sudo ln -sfn "$(sudo cat $B/services-current)" /srv/tbi-lab/services/current.tmp && sudo mv -T /srv/tbi-lab/services/current.tmp /srv/tbi-lab/services/current
sudo systemctl daemon-reload
sudo systemctl restart tbi-build.service tbi-session-host.service
for _ in $(seq 1 40); do sudo curl -sf --unix-socket /run/tbi-runtime/api.sock http://localhost/health >/dev/null 2>&1 && break; sleep 0.5; done
echo "health: $(sudo curl -sf --unix-socket /run/tbi-runtime/api.sock http://localhost/health)"
echo "services -> $(readlink -f /srv/tbi-lab/services/current); frontend -> $(readlink -f /srv/tbi-lab/dev-lab/current)"
echo "qemu bind: $(sudo sed -n 's|^BindReadOnlyPaths=\(.*\):/opt/tbi-runtime$|\1|p' /etc/systemd/system/tbi-qemu@.service)"
# Remove the reference images Gate C imported (inert test images; never present before).
while read -r sha; do sudo rm -f "/var/lib/tbi-lab/artifacts/$sha.bin"; done < "$B/imported-reference-images.txt"
echo "removed imported reference images"
