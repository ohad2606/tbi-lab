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
#
# Build identity and verification (Sprint 10): the build embeds its identity (buildInfo.config.ts:
# TBI_BUILD_COMMIT = the exact commit, TBI_BUILD_ENV = dev-lab, TBI_BUILD_TIME, also published as
# /version.json). Before and after the switch the script checks that
#   1. the build's /version.json names the intended commit (environment dev-lab, clean tree),
#   2. the compiled bundle carries the same commit,
#   3. index.html references only content-hashed assets present in the release,
#   4. the gate's origin (what the public site proxies to) serves that index.html byte for byte,
#      every asset it references, and /version.json with the intended commit,
#   5. the public https://dev-lab.tbi-tech.net/ is up and gated (it answers only after sign-in).
# Any mismatch after the switch rolls `current` back to the previous release and fails.
# TBI_BUILD_TIME may be given to reproduce a build byte for byte (an independent pre-build).
set -euo pipefail

ref="${1:?usage: publish-frontend.sh <git-ref>}"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify "${ref}^{commit}")"
root=/srv/tbi-lab/dev-lab
# FU-11-2: disk-backed scratch space with a free-space check (deploy-tmp.sh).
# shellcheck source=deploy-tmp.sh
source "$(dirname "$0")/deploy-tmp.sh"
work="$(deploy_tmp)"
trap 'git -C "$repo" worktree remove --force "$work/src" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

git -C "$repo" worktree add --detach "$work/src" "$sha" >/dev/null
build_time="${TBI_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
(cd "$work/src" && npm ci --no-audit --no-fund &&
  env -u VITE_PREVIEW_NAME -u VITE_STORAGE_NAMESPACE VITE_SIGN_OUT_URL=/oauth2/sign_out \
    TBI_BUILD_COMMIT="$sha" TBI_BUILD_ENV=dev-lab TBI_BUILD_TIME="$build_time" \
    npm run build --workspace @tbi-lab/app)

# 1-3: the build itself.
dist="$work/src/app/dist"
node "$repo/deploy/dev-lab/verify-build.mjs" local "$dist" "$sha"

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

# 4-5: what is actually served. On any mismatch, put the previous release back and fail.
if ! sudo -n "$(command -v node)" "$repo/deploy/dev-lab/verify-build.mjs" served "$root/$sha" "$sha"; then
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    sudo ln -sfn "$previous" "$root/current.tmp"
    sudo mv -T "$root/current.tmp" "$root/current"
    echo "VERIFICATION FAILED: rolled back to $previous" >&2
  fi
  exit 1
fi
echo "dev-lab now serves $sha (verified from /version.json and index.html as served by the gate)"
