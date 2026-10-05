#!/usr/bin/env bash
# Build the Sprint 9 preview from an exact git ref in a clean temporary worktree and publish the
# static app to /srv/tbi-lab/s9-preview/<sha>, then point /srv/tbi-lab/s9-preview/current at it.
#
#   deploy/dev-lab/s9-preview/publish.sh sprint-9
#
# Static files only: unlike deploy/dev-lab/publish.sh it builds no backend bundle, writes nothing
# under /srv/tbi-lab/dev-lab or /srv/tbi-lab/services and restarts no service. The build:
#   --base=/s9-preview/                served under that path (s9-preview.caddy)
#   VITE_PREVIEW_NAME="Sprint 9"       an "experimental preview" badge on every screen
#   VITE_STORAGE_NAMESPACE=s9-preview  its own IndexedDB database and localStorage keys, so it
#                                      never reads or writes the projects of dev-lab (same origin)
#   VITE_SIGN_OUT_URL=/oauth2/sign_out the gate's sign-out, as for dev-lab
# Old releases are kept; roll back by re-pointing `current`. Requires sudo for /srv.
set -euo pipefail

ref="${1:?usage: publish.sh <git-ref>}"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify "${ref}^{commit}")"
root=/srv/tbi-lab/s9-preview
work="$(mktemp -d)"
trap 'git -C "$repo" worktree remove --force "$work/src" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

git -C "$repo" worktree add --detach "$work/src" "$sha" >/dev/null
(cd "$work/src" && npm ci --no-audit --no-fund &&
  VITE_SIGN_OUT_URL=/oauth2/sign_out VITE_PREVIEW_NAME="Sprint 9" \
    VITE_STORAGE_NAMESPACE=s9-preview npm run build --workspace @tbi-lab/app -- --base=/s9-preview/)

sudo install -d -m 0755 "$root"
sudo rm -rf "$root/$sha"
sudo cp -a "$work/src/app/dist" "$root/$sha"
sudo chown -R root:root "$root/$sha"
sudo chmod -R a+rX,go-w "$root/$sha"
sudo ln -sfn "$root/$sha" "$root/current.tmp"
sudo mv -T "$root/current.tmp" "$root/current"
echo "published Sprint 9 preview $sha -> $root/current"
