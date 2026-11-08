#!/usr/bin/env bash
# Read-only snapshot of an instance: dev (tbi) or staging (tbi-s8). Hashes are 16-hex prefixes.
set -u
h() { sudo -n sha256sum "$1" | cut -c1-16 | tr -d '\n'; echo " $1"; }
pid() { echo "$1 pid=$(systemctl show -p MainPID --value $1) since=$(systemctl show -p ActiveEnterTimestamp --value $1)"; }
if [ "$1" = dev ]; then
  echo "services/current -> $(readlink -f /srv/tbi-lab/services/current)"
  for u in tbi-build.service tbi-build-job@.service tbi-session-host.service tbi-qemu@.service; do h /etc/systemd/system/$u; done
  h /etc/polkit-1/rules.d/50-tbi.rules
  for f in identity.key policy.json runtime.json ticket.key; do h /etc/tbi/$f; done
  for f in $(ls /srv/tbi-lab/services/current/); do h /srv/tbi-lab/services/current/$f; done
  pid tbi-build; pid tbi-session-host; pid caddy; pid oauth2-proxy
  echo "tbi-qemu@ binds: $(grep -o 'BindReadOnlyPaths=[^ ]*' /etc/systemd/system/tbi-qemu@.service | head -1)"
  echo "dev-lab frontend -> $(readlink -f /srv/tbi-lab/dev-lab/current)"
  echo "health: $(sudo -n curl -s -m 5 --unix-socket /run/tbi-runtime/api.sock http://x/health)"
else
  for u in tbi-s8-build.service tbi-s8-build-job@.service tbi-s8-session-host.service tbi-s8-qemu@.service; do h /etc/systemd/system/$u; done
  h /etc/polkit-1/rules.d/50-tbi-s8.rules
  for f in identity.key policy.json runtime.json ticket.key; do h /etc/tbi-s8/$f; done
  for f in build-job.mjs build-service.mjs session-host.mjs; do h /srv/tbi-lab/s8-staging/$f; done
  pid tbi-s8-build; pid tbi-s8-session-host
  echo "health: $(sudo -n curl -s -m 5 --unix-socket /run/tbi-s8-runtime/api.sock http://x/health)"
fi
echo "qemu units: $(systemctl list-units --plain --no-legend --state=active 'tbi-qemu@*' 'tbi-s8-qemu@*' | wc -l)"
