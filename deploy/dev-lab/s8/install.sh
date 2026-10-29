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
units=("$N-build.service" "$N-build-job@.service" "$N-session-host.service" "$N-qemu@.service" "$N-admin.service")
rule="/etc/polkit-1/rules.d/50-$N.rules"
# A staging release is an exact commit: refuse a tree with uncommitted changes before any change.
if [[ "$target" == staging && "$uninstall" != "--uninstall" ]]; then
  test -z "$(git -C "$repo" status --porcelain)" || { echo "refused: $repo has uncommitted changes" >&2; exit 1; }
fi

if [[ "$uninstall" == "--uninstall" ]]; then
  sudo systemctl disable --now "$N-build.service" "$N-session-host.service" "$N-admin.service" 2>/dev/null || true
  sudo systemctl stop "$N-build-job@*.service" "$N-qemu@*.service" 2>/dev/null || true
  for u in "${units[@]}"; do sudo rm -f "/etc/systemd/system/$u"; done
  sudo rm -f "$rule"
  sudo systemctl daemon-reload
  if [[ "$target" == staging ]]; then
    sudo rm -rf "/var/lib/$N-build" "/var/lib/$N-runtime" "/var/lib/private/$N-build" \
      "/var/lib/private/$N-runtime" "$STORE" "/etc/$N" "/etc/$N-owner" "$BUNDLES"
  fi
  echo "removed $N"
  exit 0
fi

# Sprint 23B/23C (docs/alpha/ADMIN-AND-FEEDBACK.md): TBI_S23_ADMIN=1 turns on access enforcement in
# both services, the owner's feedback routes and identity observations in the Session Host
# (TBI_ADMIN_MODE=full), and (Sprint 23C, D1) the dedicated admin service $N-admin.service, user
# tbi-admin, the only writer of the helper's spool. OFF by default: the units are rendered exactly
# as before and no admin service is installed. Refused, before any change, unless the helper's
# groups and directories exist (its own installer creates them; this script never does). This
# script creates the admin service's own user and groups: tbi-admin (primary group tbi-adminio)
# and its socket group tbi-sock-admin (caddy is added to it on dev-lab).
S23_ADMIN="${TBI_S23_ADMIN:-0}"
# `service` is accepted as a name for 1 (the ops tooling's spelling).
[[ "$S23_ADMIN" == service ]] && S23_ADMIN=1
[[ "$S23_ADMIN" =~ ^[01]$ ]] || { echo "TBI_S23_ADMIN must be 0, 1 or service" >&2; exit 1; }
if [[ "$S23_ADMIN" == 1 && "$uninstall" != "--uninstall" ]]; then
  for g in tbi-admin-view tbi-admin-spool tbi-admin-observe; do
    getent group "$g" >/dev/null || { echo "refused: group $g is missing (install the admin helper first)" >&2; exit 1; }
  done
  for d in /var/lib/tbi-admin/view /var/lib/tbi-admin/spool /var/lib/tbi-admin/results /var/lib/tbi-admin/observations; do
    sudo test -d "$d" || { echo "refused: $d is missing (install the admin helper first)" >&2; exit 1; }
  done
fi

# Sprint 23C (docs/alpha/ADMIN-AND-FEEDBACK.md): TBI_S23_FEEDBACK=1 is the feedback-only release
# (rc4-s23-feedback): the Session Host stores reports and its owner reads them
# (TBI_ADMIN_MODE=reports). It sets only that: TBI_REPORTS_DIR, TBI_ADMIN_MODE and
# TBI_OWNER_PRINCIPAL_FILE. No helper groups, no access view, no admin directory, no spool paths.
# Exclusive with TBI_S23_ADMIN. The owner reference file is the operator's (created once,
# scripts/owner-principal.mjs); this script creates its directory and checks the file when it
# exists (refusing a wrong one before any change). A missing file only warns: the Session Host
# then answers 503 on /admin and serves everything else.
S23_FEEDBACK="${TBI_S23_FEEDBACK:-0}"
[[ "$S23_FEEDBACK" =~ ^[01]$ ]] || { echo "TBI_S23_FEEDBACK must be 0 or 1" >&2; exit 1; }
if [[ "$S23_FEEDBACK" == 1 && "$S23_ADMIN" == 1 ]]; then
  echo "refused: TBI_S23_FEEDBACK and TBI_S23_ADMIN are exclusive" >&2; exit 1
fi
OWNER_FILE="/etc/$N-owner/owner.principal"
if [[ "$S23_FEEDBACK" == 1 && "$uninstall" != "--uninstall" ]] && sudo test -e "$OWNER_FILE"; then
  meta="$(sudo stat -c '%U:%G %a %F %h' "$OWNER_FILE")"
  [[ "$meta" == "root:tbi-runtimeio 640 regular file 1" ]] ||
    { echo "refused: $OWNER_FILE is '$meta', expected 'root:tbi-runtimeio 640 regular file 1'" >&2; exit 1; }
  # The whole content, as the Session Host reads it: one principal, at most one newline.
  owner="$(sudo head -c 64 "$OWNER_FILE"; echo .)"; owner="${owner%.}"
  owner_re=$'^p_[A-Za-z0-9_-]{26}\n?$'
  [[ "$owner" =~ $owner_re ]] ||
    { echo "refused: $OWNER_FILE must hold exactly one principal p_..." >&2; exit 1; }
  unset owner
fi

# Phase C (alpha): the Session Host's own ceiling on live sessions (engineering default 4). The
# host-wide limit is min(policy global.runtime.maxLiveSessions, this ceiling), so a ceiling below the
# policy's limit would silently override the policy (on the 6-CPU alpha: 4 instead of "cpus" = 6).
# TBI_S8_HOST_MAX_SESSIONS sets it (default 4, unchanged); the install refuses, before any change,
# a ceiling below the policy's limit on this host. A reinstall must therefore pass it again.
HOST_MAX="${TBI_S8_HOST_MAX_SESSIONS:-4}"
[[ "$HOST_MAX" =~ ^[1-9][0-9]{0,2}$ ]] || { echo "TBI_S8_HOST_MAX_SESSIONS must be a whole number" >&2; exit 1; }
POLICY_LIVE="$(python3 -c 'import json,os,sys
v=json.load(open(sys.argv[1])).get("global",{}).get("runtime",{}).get("maxLiveSessions","cpus")
print(len(os.sched_getaffinity(0)) if v=="cpus" else v)' "${TBI_S8_POLICY:-$here/policy.json}")"
if (( HOST_MAX < POLICY_LIVE )); then
  echo "refused: the Session Host ceiling ($HOST_MAX) is below the policy's live-session limit on this host ($POLICY_LIVE);" >&2
  echo "set TBI_S8_HOST_MAX_SESSIONS=$POLICY_LIVE so the policy governs" >&2
  exit 1
fi

# Users and groups (system accounts, no home, no login).
# Sprint 23B (security review H1): one socket group per backend (the backend and caddy only);
# tbi-gate stays for Caddy's internal origin (caddy and oauth2-proxy), never for a backend.
for g in tbi-buildio tbi-runtimeio tbi-gate tbi-artifacts tbi-sock-runtime tbi-sock-build; do
  getent group "$g" >/dev/null || sudo groupadd --system "$g"
done
if [[ "$S23_ADMIN" == 1 ]]; then
  for g in tbi-adminio tbi-sock-admin; do
    getent group "$g" >/dev/null || sudo groupadd --system "$g"
  done
fi
mkuser() { getent passwd "$1" >/dev/null ||
  sudo useradd --system --gid "$2" --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$1"; }
mkuser tbi-build tbi-artifacts
mkuser tbi-buildjob tbi-buildio
mkuser tbi-runtime tbi-runtimeio
mkuser tbi-qemu tbi-runtimeio
# Sprint 23C: the admin service's user; its other groups come from its unit (SupplementaryGroups).
if [[ "$S23_ADMIN" == 1 ]]; then mkuser tbi-admin tbi-adminio; fi
SOCK_ADMIN_GID="$(getent group tbi-sock-admin | cut -d: -f3 || true)"
SOCK_RUNTIME_GID="$(getent group tbi-sock-runtime | cut -d: -f3)"
SOCK_BUILD_GID="$(getent group tbi-sock-build | cut -d: -f3)"
ARTIFACTS_GID="$(getent group tbi-artifacts | cut -d: -f3)"
JOB_UID="$(id -u tbi-buildjob)"

# Keys: root-only files, handed to the two services as systemd credentials.
sudo install -d -m 0700 "/etc/$N"
for k in identity ticket; do
  # (The directory is root-only: test as root, or a re-run would silently replace the keys.)
  sudo test -s "/etc/$N/$k.key" || { openssl rand 32 | sudo tee "/etc/$N/$k.key" >/dev/null; }
  sudo chmod 0400 "/etc/$N/$k.key"
done

# Policy (Phase 4): plans, quotas, global limits — the values this instance enforces.
# Sprint 13 (H5): TBI_S8_POLICY selects another repository policy file (e.g. policy.alpha.json:
# five concurrent testers, shared build queue 10, two build workers). Default: policy.json.
POLICY="${TBI_S8_POLICY:-$here/policy.json}"
test -f "$POLICY" || { echo "no policy file $POLICY" >&2; exit 1; }
sudo install -m 0400 "$POLICY" "/etc/$N/policy.json"
# Sprint 13 (security audit #3): the managed artifact store is shared by all users; the alpha needs
# at least users x quota (5 x 128 MiB = 640). TBI_S8_ARTIFACT_CAP_MB sets it; default 256 (unchanged).
CAP_MB="${TBI_S8_ARTIFACT_CAP_MB:-256}"
[[ "$CAP_MB" =~ ^[1-9][0-9]{0,5}$ ]] || { echo "TBI_S8_ARTIFACT_CAP_MB must be a whole number of MiB" >&2; exit 1; }

# Sprint 12: the runtime's identity and bridge capabilities, for the build service (ADR-011 §5).
test -f "$RUNTIME/runtime.json" || { echo "no runtime.json in $RUNTIME" >&2; exit 1; }
sudo install -m 0400 "$RUNTIME/runtime.json" "/etc/$N/runtime.json"

# Artifact store (staging has its own) and the empty sandbox roots with their mount points.
sudo install -d -o tbi-build -g tbi-artifacts -m 2750 "$STORE"
root() { # $1 root dir, rest: mount points
  local r="$1"; shift
  sudo install -d -m 0755 "$r"
  for d in usr etc tmp proc sys dev run "$@"; do sudo install -d -m 0755 "$r/$d"; done
  for l in bin lib sbin; do sudo ln -sfn "usr/$l" "$r/$l"; done
}
# FU-11-1 (Sprint 12): the pinned system artifacts (runtime/firmware/artifacts.lock.json, e.g. the
# R1 reference image TbiGpioProof 5f177cbe…) as reference images of this store, each verified
# against its pinned sha256, owned by the store user, never overwriting a file the store already
# holds. The build service loads them at start. G-3: the only source is the immutable release
# artifact set of this checkout's lock (publish-release-artifacts.sh), never a runtime home.
LOCK="$repo/runtime/firmware/artifacts.lock.json"
ARTIFACTS="/srv/tbi-lab/release-artifacts/$(sha256sum < "$LOCK" | cut -c1-16)"
test -d "$ARTIFACTS" && cmp -s "$LOCK" "$ARTIFACTS/artifacts.lock.json" || {
  echo "release artifact set $ARTIFACTS missing or not for this lock" >&2
  echo "(deploy/dev-lab/s8/publish-release-artifacts.sh <provisioned runtime home>)" >&2
  exit 1
}
for sha in $(python3 -c 'import json,sys; [print(a["sha256"]) for a in json.load(open(sys.argv[1]))["artifacts"].values()]' \
  "$LOCK"); do
  sudo test -e "$STORE/$sha.bin" && continue
  src="$ARTIFACTS/$sha.bin"
  test -f "$src" || { echo "pinned artifact $sha is not in $ARTIFACTS" >&2; exit 1; }
  [ "$(sha256sum < "$src" | cut -d' ' -f1)" = "$sha" ] || { echo "sha256 mismatch: $src" >&2; exit 1; }
  sudo install -o tbi-build -g tbi-artifacts -m 0440 "$src" "$STORE/$sha.bin"
  echo "imported reference image $sha"
done

root "/var/lib/$N-build/sandbox-root" opt/tbi-arduino opt/tbi-node opt/tbi-build job
root "/var/lib/$N-runtime/sandbox-root" opt/tbi-runtime session

# Service bundles (staging: from this worktree).
if [[ "$target" == staging ]]; then
  # The Session Host is stamped with the product version and the exact commit (reported on
  # /health, as publish-runtime.sh does for dev-lab); only a clean tree is a commit.
  sha="$(git -C "$repo" rev-parse HEAD)"
  version="$(tr -d '[:space:]' < "$repo/VERSION")"
  (cd "$repo" && npm run --silent buildsvc:build &&
    npx esbuild runtime/admin/main.ts --bundle --platform=node --format=esm --target=node22 \
      --define:__TBI_RUNTIME_VERSION__="\"$version\"" --define:__TBI_RUNTIME_COMMIT__="\"$sha\"" \
      --outfile=runtime/admin/dist/admin-service.mjs --log-level=warning &&
    npx esbuild runtime/host/main.ts --bundle --platform=node --format=esm --target=node22 \
      --define:__TBI_RUNTIME_VERSION__="\"$version\"" --define:__TBI_RUNTIME_COMMIT__="\"$sha\"" \
      --outfile=runtime/host/dist/session-host.mjs --log-level=warning)
  grep -q "$sha" "$repo/runtime/host/dist/session-host.mjs" || { echo "host bundle not stamped" >&2; exit 1; }
  sudo install -d -m 0755 "$BUNDLES"
  sudo install -m 0644 "$repo/runtime/builder/dist/build-service.mjs" "$repo/runtime/builder/dist/build-job.mjs" \
    "$repo/runtime/host/dist/session-host.mjs" "$repo/runtime/admin/dist/admin-service.mjs" "$BUNDLES/"
fi

render() {
  sed -e "s|@N@|$N|g" -e "s|@NRE@|${N//-/\\\\-}|g" -e "s|@STORE@|$STORE|g" -e "s|@BUNDLES@|$BUNDLES|g" \
    -e "s|@ARDUINO@|$ARDUINO|g" -e "s|@NODE@|$NODE|g" -e "s|@RUNTIME@|$RUNTIME|g" \
    -e "s|@SOCK_RUNTIME_GID@|$SOCK_RUNTIME_GID|g" -e "s|@SOCK_BUILD_GID@|$SOCK_BUILD_GID|g" \
    -e "s|@ARTIFACTS_GID@|$ARTIFACTS_GID|g" -e "s|@JOB_UID@|$JOB_UID|g" -e "s|@ARTIFACT_CAP_MB@|$CAP_MB|g" \
    -e "s|@HOST_MAX_SESSIONS@|$HOST_MAX|g" -e "s|@SOCK_ADMIN_GID@|$SOCK_ADMIN_GID|g" "$1" |
    if [[ "$S23_ADMIN" == 1 ]]; then
      sed -e 's|^#\(Environment=TBI_ACCESS_VIEW=\)|\1|' -e 's|^#\(Environment=TBI_ADMIN_DIR=\)|\1|' \
        -e 's|^#\(ReadWritePaths=-/var/lib/tbi-admin/\)|\1|' -e 's|^#\(ReadOnlyPaths=-/var/lib/tbi-admin/\)|\1|' \
        -e 's|^#\(SupplementaryGroups=tbi-admin-\)|\1|' -e 's|^#\(Environment=TBI_ADMIN_MODE=full\)$|\1|' \
        -e 's|^#\(Environment=TBI_OBSERVATIONS_DIR=\)|\1|' \
        -e 's|^#\(InaccessiblePaths=-/var/lib/tbi-admin/\)|\1|'
    elif [[ "$S23_FEEDBACK" == 1 ]]; then
      sed -e 's|^#\(Environment=TBI_REPORTS_DIR=\)|\1|' -e 's|^#\(Environment=TBI_ADMIN_MODE=reports\)$|\1|' \
        -e 's|^#\(Environment=TBI_OWNER_PRINCIPAL_FILE=\)|\1|'
    else cat; fi
}
if [[ "$S23_FEEDBACK" == 1 ]]; then
  # The owner reference's directory: readable by the Session Host's group only.
  sudo install -d -o root -g tbi-runtimeio -m 0750 "/etc/$N-owner"
  sudo test -e "$OWNER_FILE" || echo "warning: $OWNER_FILE is missing: /admin answers 503 until the operator creates it" >&2
fi
render "$here/tbi-build.service.in" | sudo tee "/etc/systemd/system/$N-build.service" >/dev/null
render "$here/tbi-build-job@.service.in" | sudo tee "/etc/systemd/system/$N-build-job@.service" >/dev/null
render "$here/tbi-session-host.service.in" | sudo tee "/etc/systemd/system/$N-session-host.service" >/dev/null
render "$here/tbi-qemu@.service.in" | sudo tee "/etc/systemd/system/$N-qemu@.service" >/dev/null
render "$here/50-tbi-lab.rules.in" | sudo tee "$rule" >/dev/null
if [[ "$S23_ADMIN" == 1 ]]; then
  [[ -n "$SOCK_ADMIN_GID" ]] || { echo "group tbi-sock-admin is missing" >&2; exit 1; }
  render "$here/tbi-admin.service.in" | sudo tee "/etc/systemd/system/$N-admin.service" >/dev/null
else
  # Any other mode: no admin service (a previous TBI_S23_ADMIN=1 install is removed).
  sudo systemctl disable --now "$N-admin.service" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/$N-admin.service"
fi
if [[ "$target" == dev-lab ]]; then
  # The gate: Caddy and oauth2-proxy reach the sockets through the tbi-gate group; Caddy's
  # internal-origin socket lives in /run/tbi-gate (Caddyfile, oauth2-proxy.cfg in deploy/dev-lab).
  sudo usermod -aG tbi-gate caddy
  sudo usermod -aG tbi-gate oauth2-proxy
  # Sprint 23B (H1): caddy reaches each backend through that backend's own socket group.
  sudo usermod -aG tbi-sock-runtime,tbi-sock-build caddy
  # Sprint 23C: and the admin service's socket (the gate route /admin-api/*).
  if [[ "$S23_ADMIN" == 1 ]]; then sudo usermod -aG tbi-sock-admin caddy; fi
  sudo install -m 0644 "$here/tbi-gate.conf" /etc/tmpfiles.d/tbi-gate.conf
  sudo systemd-tmpfiles --create /etc/tmpfiles.d/tbi-gate.conf
  sudo install -d -m 0755 /etc/systemd/system/caddy.service.d
  sudo install -m 0644 "$here/caddy-gate.conf" /etc/systemd/system/caddy.service.d/tbi-gate.conf
  # (Caddy and oauth2-proxy must restart, not reload, for the groups and umask to apply, the
  # Sprint 23B socket groups included; the
  # Caddyfile and oauth2-proxy.cfg are installed by hand, deploy/dev-lab/README.md.)
fi
sudo systemctl daemon-reload
sudo systemctl enable "$N-build.service" "$N-session-host.service"
# Both together: they must hold the same keys and matching code.
sudo systemctl restart "$N-build.service" "$N-session-host.service"
if [[ "$S23_ADMIN" == 1 ]]; then
  # After the Session Host: the admin service reads its health-only socket.
  sudo systemctl enable "$N-admin.service"
  sudo systemctl restart "$N-admin.service"
fi
echo "installed $N (build: /run/$N-build/api.sock, runtime: /run/$N-runtime/api.sock)"
