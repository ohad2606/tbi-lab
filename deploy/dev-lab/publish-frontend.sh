#!/usr/bin/env bash
# Publish ONLY the frontend of an exact git ref as the dev-lab app (Sprint 9: the normal demo URL
# serves the Sprint 9 UI on the validated Sprint 8 backends). Builds in a clean temporary
# worktree, copies the static build to /srv/tbi-lab/dev-lab/<sha> and atomically re-points
# /srv/tbi-lab/dev-lab/current at it.
#
#   deploy/dev-lab/publish-frontend.sh 198ca92
#
# Unlike deploy/dev-lab/publish.sh it builds no backend bundle, writes nothing under
# /srv/tbi-lab/services and restarts no service; Caddy, the gate and the backend sockets are
# untouched. Same build settings as publish.sh: base `/`, the gate's sign-out URL, no preview
# badge and no storage namespace (the app keeps using dev-lab's existing projects).
# Old releases are kept. Roll back by re-pointing `current`:
#   sudo ln -sfn /srv/tbi-lab/dev-lab/<previous-sha> /srv/tbi-lab/dev-lab/current.tmp &&
#     sudo mv -T /srv/tbi-lab/dev-lab/current.tmp /srv/tbi-lab/dev-lab/current
# Requires sudo for /srv.
set -euo pipefail

ref="${1:?usage: publish-frontend.sh <git-ref>}"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify "${ref}^{commit}")"
root=/srv/tbi-lab/dev-lab
work="$(mktemp -d)"
trap 'git -C "$repo" worktree remove --force "$work/src" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

git -C "$repo" worktree add --detach "$work/src" "$sha" >/dev/null
(cd "$work/src" && npm ci --no-audit --no-fund &&
  env -u VITE_PREVIEW_NAME -u VITE_STORAGE_NAMESPACE VITE_SIGN_OUT_URL=/oauth2/sign_out \
    npm run build --workspace @tbi-lab/app)

previous="$(readlink -f "$root/current" || true)"
sudo install -d -m 0755 "$root"
sudo rm -rf "$root/$sha.new"
sudo cp -a "$work/src/app/dist" "$root/$sha.new"
sudo chown -R root:root "$root/$sha.new"
sudo chmod -R a+rX,go-w "$root/$sha.new"
if [ "$previous" != "$root/$sha" ]; then
  sudo rm -rf "$root/$sha"
  sudo mv -T "$root/$sha.new" "$root/$sha"
else
  echo "refusing to replace the live release $root/$sha in place" >&2
  sudo rm -rf "$root/$sha.new"
  exit 1
fi
sudo ln -sfn "$root/$sha" "$root/current.tmp"
sudo mv -T "$root/current.tmp" "$root/current"
echo "published frontend $sha -> $root/current (previous: $previous)"
