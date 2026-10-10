#!/usr/bin/env bash
# Sprint 12 (G-3): publish the pinned firmware images of THIS checkout's
# runtime/firmware/artifacts.lock.json as an immutable release artifact set:
#
#   deploy/dev-lab/s8/publish-release-artifacts.sh <runtime home>
#
#   -> /srv/tbi-lab/release-artifacts/<lock id>/<sha256>.bin  (root-owned, read-only)
#      plus artifacts.lock.json (the lock it was made from)
#
# <lock id> = first 16 hex digits of the lock file's sha256, so a set belongs to exactly one lock
# (one release). Every image is read from <runtime home>/artifacts (provision.sh output) and
# verified against its pinned sha256 before it is published; a set that already exists is only
# verified, never modified. install.sh reads its reference images from this set and nowhere else.
# Needs sudo.
set -euo pipefail

home="$(readlink -f "${1:?usage: publish-release-artifacts.sh <runtime home>}")"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
lock="$repo/runtime/firmware/artifacts.lock.json"
id="$(sha256sum < "$lock" | cut -c1-16)"
root=/srv/tbi-lab/release-artifacts
dest="$root/$id"
shas() { python3 -c 'import json,sys; [print(a["sha256"]) for a in json.load(open(sys.argv[1]))["artifacts"].values()]' "$1"; }

verify_set() {
  sudo cmp -s "$lock" "$1/artifacts.lock.json" || { echo "lock differs in $1" >&2; return 1; }
  for sha in $(shas "$lock"); do
    [ "$(sudo sha256sum < "$1/$sha.bin" | cut -d' ' -f1)" = "$sha" ] ||
      { echo "bad or missing $sha in $1" >&2; return 1; }
  done
}

if sudo test -d "$dest"; then
  verify_set "$dest"
  echo "OK   release artifact set $id already published and verified ($dest)"
  exit 0
fi

tmp="$root/.tmp-$id-$$"
sudo install -d -m 0755 "$root"
sudo install -d -m 0755 "$tmp"
trap 'sudo rm -rf "$tmp"' EXIT
for sha in $(shas "$lock"); do
  src="$home/artifacts/$sha.bin"
  test -f "$src" || { echo "pinned image $sha is not in $home/artifacts (provision.sh firmware)" >&2; exit 1; }
  [ "$(sha256sum < "$src" | cut -d' ' -f1)" = "$sha" ] || { echo "sha256 mismatch: $src" >&2; exit 1; }
  sudo install -o root -g root -m 0444 "$src" "$tmp/$sha.bin"
done
sudo install -o root -g root -m 0444 "$lock" "$tmp/artifacts.lock.json"
verify_set "$tmp"
sudo chmod 0555 "$tmp"
sudo mv "$tmp" "$dest"
trap - EXIT
echo "OK   published release artifact set $id ($(shas "$lock" | wc -l) images) at $dest"
