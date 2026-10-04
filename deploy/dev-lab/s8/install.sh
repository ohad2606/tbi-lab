#!/usr/bin/env bash
# Sprint 8 containment: install (or remove) the build service, the Session Host and their sandbox
# templates, rendered for one instance name.
#
#   deploy/dev-lab/s8/install.sh staging   [--uninstall]   side-by-side validation instance
#                                                         (names tbi-s8-*, own store, own keys;
#                                                          not routed by Caddy; dev-lab untouched)
#   deploy/dev-lab/s8/install.sh dev-lab   [--uninstall]   the dev-lab services themselves
#                                                         (NOT run before the PM approves it)
#
# Needs sudo. Idempotent. Users and groups are shared by both instances and are never removed.
set -euo pipefail

target="${1:?usage: install.sh staging|dev-lab [--uninstall]}"
uninstall="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"

ARDUINO="${TBI_S8_ARDUINO:-/home/ubuntu/tbi-r1-clean/rt/arduino}"
NODE="${TBI_S8_NODE:-/home/ubuntu/.nvm/versions/node/v24.21.0}"
case "$target" in
  staging)
    N=tbi-s8
    STORE=/var/lib/tbi-s8-artifacts
    BUNDLES=/srv/tbi-lab/s8-staging
    RUNTIME="${TBI_S8_RUNTIME:-/home/ubuntu/tbi-s8-rt/qemu-current}"
    ;;
  dev-lab)
    N=tbi
    STORE=/var/lib/tbi-lab/artifacts
    BUNDLES=/srv/tbi-lab/services/current
    RUNTIME="${TBI_S8_RUNTIME:?set TBI_S8_RUNTIME to the provisioned runtime prefix}"
    ;;
  *) echo "unknown target: $target" >&2; exit 2 ;;
esac
units=("$N-build.service" "$N-build-job@.service" "$N-session-host.service" "$N-qemu@.service")
rule="/etc/polkit-1/rules.d/50-$N.rules"

if [[ "$uninstall" == "--uninstall" ]]; then
  sudo systemctl disable --now "$N-build.service" "$N-session-host.service" 2>/dev/null || true
  sudo systemctl stop "$N-build-job@*.service" "$N-qemu@*.service" 2>/dev/null || true
  for u in "${units[@]}"; do sudo rm -f "/etc/systemd/system/$u"; done
  sudo rm -f "$rule"
  sudo systemctl daemon-reload
  if [[ "$target" == staging ]]; then
    sudo rm -rf "/var/lib/$N-build" "/var/lib/$N-runtime" "/var/lib/private/$N-build" \
      "/var/lib/private/$N-runtime" "$STORE" "/etc/$N" "$BUNDLES"
  fi
  echo "removed $N"
  exit 0
fi

# Users and groups (system accounts, no home, no login).
for g in tbi-buildio tbi-runtimeio tbi-gate tbi-artifacts; do
  getent group "$g" >/dev/null || sudo groupadd --system "$g"
done
mkuser() { getent passwd "$1" >/dev/null ||
  sudo useradd --system --gid "$2" --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$1"; }
mkuser tbi-build tbi-artifacts
mkuser tbi-buildjob tbi-buildio
mkuser tbi-runtime tbi-runtimeio
mkuser tbi-qemu tbi-runtimeio
GATE_GID="$(getent group tbi-gate | cut -d: -f3)"
JOB_UID="$(id -u tbi-buildjob)"

# Keys: root-only files, handed to the two services as systemd credentials.
sudo install -d -m 0700 "/etc/$N"
for k in identity ticket; do
  # (The directory is root-only: test as root, or a re-run would silently replace the keys.)
  sudo test -s "/etc/$N/$k.key" || { openssl rand 32 | sudo tee "/etc/$N/$k.key" >/dev/null; }
  sudo chmod 0400 "/etc/$N/$k.key"
done

# Policy (Phase 4): plans, quotas, global limits — the values this instance enforces.
sudo install -m 0400 "$here/policy.json" "/etc/$N/policy.json"

# Artifact store (staging has its own) and the empty sandbox roots with their mount points.
sudo install -d -o tbi-build -g tbi-artifacts -m 2750 "$STORE"
root() { # $1 root dir, rest: mount points
  local r="$1"; shift
  sudo install -d -m 0755 "$r"
  for d in usr etc tmp proc sys dev run "$@"; do sudo install -d -m 0755 "$r/$d"; done
  for l in bin lib sbin; do sudo ln -sfn "usr/$l" "$r/$l"; done
}
root "/var/lib/$N-build/sandbox-root" opt/tbi-arduino opt/tbi-node opt/tbi-build job
root "/var/lib/$N-runtime/sandbox-root" opt/tbi-runtime session

# Service bundles (staging: from this worktree).
if [[ "$target" == staging ]]; then
  (cd "$repo" && npm run --silent buildsvc:build && npm run --silent host:build)
  sudo install -d -m 0755 "$BUNDLES"
  sudo install -m 0644 "$repo/runtime/builder/dist/build-service.mjs" "$repo/runtime/builder/dist/build-job.mjs" \
    "$repo/runtime/host/dist/session-host.mjs" "$BUNDLES/"
fi

render() {
  sed -e "s|@N@|$N|g" -e "s|@NRE@|${N//-/\\\\-}|g" -e "s|@STORE@|$STORE|g" -e "s|@BUNDLES@|$BUNDLES|g" \
    -e "s|@ARDUINO@|$ARDUINO|g" -e "s|@NODE@|$NODE|g" -e "s|@RUNTIME@|$RUNTIME|g" \
    -e "s|@GATE_GID@|$GATE_GID|g" -e "s|@JOB_UID@|$JOB_UID|g" "$1"
}
render "$here/tbi-build.service.in" | sudo tee "/etc/systemd/system/$N-build.service" >/dev/null
render "$here/tbi-build-job@.service.in" | sudo tee "/etc/systemd/system/$N-build-job@.service" >/dev/null
render "$here/tbi-session-host.service.in" | sudo tee "/etc/systemd/system/$N-session-host.service" >/dev/null
render "$here/tbi-qemu@.service.in" | sudo tee "/etc/systemd/system/$N-qemu@.service" >/dev/null
render "$here/50-tbi-lab.rules.in" | sudo tee "$rule" >/dev/null
if [[ "$target" == dev-lab ]]; then
  # The gate: Caddy and oauth2-proxy reach the sockets through the tbi-gate group; Caddy's
  # internal-origin socket lives in /run/tbi-gate (Caddyfile, oauth2-proxy.cfg in deploy/dev-lab).
  sudo usermod -aG tbi-gate caddy
  sudo usermod -aG tbi-gate oauth2-proxy
  sudo install -m 0644 "$here/tbi-gate.conf" /etc/tmpfiles.d/tbi-gate.conf
  sudo systemd-tmpfiles --create /etc/tmpfiles.d/tbi-gate.conf
fi
sudo systemctl daemon-reload
sudo systemctl enable "$N-build.service" "$N-session-host.service"
# Both together: they must hold the same keys and matching code.
sudo systemctl restart "$N-build.service" "$N-session-host.service"
echo "installed $N (build: /run/$N-build/api.sock, runtime: /run/$N-runtime/api.sock)"
