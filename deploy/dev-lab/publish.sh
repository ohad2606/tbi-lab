#!/usr/bin/env bash
# Build TBI Lab from an exact git ref in a clean temporary worktree and publish the production
# build to /srv/tbi-lab/dev-lab/<sha>, then point /srv/tbi-lab/dev-lab/current at it. Since
# Sprint 6 it also publishes the R2 Session Host bundle of the same ref to
# /srv/tbi-lab/session-host/<sha> (outside the web root: never served) and restarts the host
# service, which ends any running preview session (sessions are ephemeral by design).
#
#   deploy/dev-lab/publish.sh runtime-r2-complete
#
# Old releases are kept; roll back by re-pointing `current`. Requires sudo for /srv.
set -euo pipefail

ref="${1:?usage: publish.sh <git-ref>}"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify "${ref}^{commit}")"
root=/srv/tbi-lab/dev-lab
work="$(mktemp -d)"
trap 'git -C "$repo" worktree remove --force "$work/src" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

git -C "$repo" worktree add --detach "$work/src" "$sha" >/dev/null
# The preview is protected by oauth2-proxy; the app only learns where signing out goes.
(cd "$work/src" && npm ci --no-audit --no-fund &&
  VITE_SIGN_OUT_URL=/oauth2/sign_out npm run build && npm run host:build && npm run buildsvc:build)

sudo install -d -m 0755 "$root"
sudo rm -rf "$root/$sha"
sudo cp -a "$work/src/app/dist" "$root/$sha"
sudo chown -R root:root "$root/$sha"
sudo chmod -R a+rX,go-w "$root/$sha"
sudo ln -sfn "$root/$sha" "$root/current.tmp"
sudo mv -T "$root/current.tmp" "$root/current"
echo "published $sha -> $root/current"

# The backend bundles of the same ref (Sprint 8 layout, deploy/dev-lab/s8): the build service,
# its in-sandbox step driver and the Session Host, together in /srv/tbi-lab/services/<sha>
# (outside the web root: never served). Restarting the two services ends running preview
# sessions and builds (they are ephemeral by design); their sandbox units stop with them.
services_root=/srv/tbi-lab/services
if [ -d "$services_root" ]; then
  sudo install -d -m 0755 "$services_root/$sha"
  sudo install -m 0644 "$work/src/runtime/builder/dist/build-service.mjs" \
    "$work/src/runtime/builder/dist/build-job.mjs" "$work/src/runtime/host/dist/session-host.mjs" \
    "$services_root/$sha/"
  sudo ln -sfn "$services_root/$sha" "$services_root/current.tmp"
  sudo mv -T "$services_root/current.tmp" "$services_root/current"
  sudo systemctl restart tbi-build.service tbi-session-host.service
  echo "published services $sha -> $services_root/current"
fi
