#!/usr/bin/env bash
# Build TBI Lab from an exact git ref in a clean temporary worktree and publish the production
# build to /srv/tbi-lab/dev-lab/<sha>, then point /srv/tbi-lab/dev-lab/current at it.
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
(cd "$work/src" && npm ci --no-audit --no-fund && npm run build)

sudo install -d -m 0755 "$root"
sudo rm -rf "$root/$sha"
sudo cp -a "$work/src/app/dist" "$root/$sha"
sudo chown -R root:root "$root/$sha"
sudo chmod -R a+rX,go-w "$root/$sha"
sudo ln -sfn "$root/$sha" "$root/current.tmp"
sudo mv -T "$root/current.tmp" "$root/current"
echo "published $sha -> $root/current"
