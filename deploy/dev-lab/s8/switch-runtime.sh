#!/usr/bin/env bash
# Sprint 12 (architecture §5.3, step 2): switch an instance's QEMU runtime, side by side.
#
#   deploy/dev-lab/s8/switch-runtime.sh staging|dev-lab <runtime prefix>
#   rollback: the same command with the previous prefix (printed by every switch)
#
# A runtime prefix is a provisioned runtime directory (runtime/provision/provision.sh qemu):
# bin/qemu-system-xtensa, share/qemu and runtime.json. Runtime directories are never modified or
# deleted here; v1 and v2 stay installed side by side, so a switch back needs no rebuild.
#
# What it changes, and nothing else:
#   - /etc/systemd/system/<N>-qemu@.service, re-rendered from tbi-qemu@.service.in with the new
#     runtime bind (the same rendering as install.sh), then daemon-reload;
#   - /etc/<N>/runtime.json (the build service's capabilities, ADR-011 §5), then <N>-build is
#     restarted so its tickets match the runtime (it holds no session state).
# The Session Host is not restarted: it learns the runtime's capabilities at each session's
# bridge handshake. Refused while any <N>-qemu@ instance is active (a running session).
# Backups: /var/backups/tbi-lab/switch-runtime-<N>-<UTC time>/ (the unit and runtime.json).
# Needs sudo.
set -euo pipefail

target="${1:?usage: switch-runtime.sh staging|dev-lab <runtime prefix>}"
prefix="$(readlink -f "${2:?usage: switch-runtime.sh staging|dev-lab <runtime prefix>}")"
here="$(cd "$(dirname "$0")" && pwd)"
case "$target" in
  staging) N=tbi-s8; U=tbi-s8- ;;
  dev-lab) N=tbi; U=tbi- ;;
  *) echo "unknown target: $target" >&2; exit 2 ;;
esac
unit="/etc/systemd/system/$N-qemu@.service"
t0=$(date +%s%N)

# The new runtime must be complete.
test -x "$prefix/bin/qemu-system-xtensa" || { echo "no runtime binary in $prefix" >&2; exit 1; }
test -d "$prefix/share/qemu" || { echo "no share/qemu in $prefix" >&2; exit 1; }
test -f "$prefix/runtime.json" || { echo "no runtime.json in $prefix" >&2; exit 1; }
new_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtimeId"])' "$prefix/runtime.json")"

# The instance must exist, and must be idle.
sudo test -f "$unit" || { echo "$unit is not installed (install.sh $target first)" >&2; exit 1; }
old="$(sudo sed -n 's|^BindReadOnlyPaths=\(.*\):/opt/tbi-runtime$|\1|p' "$unit")"
test -n "$old" || { echo "cannot read the current runtime bind from $unit" >&2; exit 1; }
if [ "$(readlink -f "$old")" = "$prefix" ]; then echo "$N already runs $prefix ($new_id)"; exit 0; fi
active="$(systemctl list-units --plain --no-legend --state=active "$N-qemu@*.service" | wc -l)"
if [ "$active" -ne 0 ]; then
  echo "refused: $active $N-qemu@ session(s) active; switch when the instance is idle" >&2
  exit 3
fi

backup="/var/backups/tbi-lab/switch-runtime-$N-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 0700 "$backup"
sudo cp -p "$unit" "$backup/"
sudo test -f "/etc/$N/runtime.json" && sudo cp -p "/etc/$N/runtime.json" "$backup/"
echo "$old" | sudo tee "$backup/previous-runtime" >/dev/null

# Re-render exactly as install.sh does, changing only the runtime bind.
sed -e "s|@N@|$N|g" -e "s|@U@|$U|g" -e "s|@RUNTIME@|$prefix|g" "$here/tbi-qemu@.service.in" |
  sudo tee "$unit.tmp" >/dev/null
sudo mv -f "$unit.tmp" "$unit"
sudo install -m 0400 "$prefix/runtime.json" "/etc/$N/runtime.json"
sudo systemctl daemon-reload
sudo systemctl restart "$N-build.service"

grep -q '@[A-Z_]*@' "$unit" && { echo "FAILED: unrendered placeholder in $unit" >&2; exit 1; }
# Verify: the unit binds the new runtime, and the build service is back.
bound="$(systemctl show -p BindReadOnlyPaths --value "$N-qemu@check.service" | tr ' ' '\n' |
  sed -n 's|^\(.*\):/opt/tbi-runtime.*|\1|p')"
[ "$(readlink -f "$bound")" = "$prefix" ] || { echo "FAILED: unit binds '$bound'" >&2; exit 1; }
for _ in $(seq 1 40); do systemctl is-active --quiet "$N-build.service" && break; sleep 0.25; done
systemctl is-active --quiet "$N-build.service" || { echo "FAILED: $N-build is not active" >&2; exit 1; }
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
echo "OK   $N now runs runtime $new_id ($prefix) in ${ms} ms"
echo "     backup $backup; rollback: $0 $target $old"
