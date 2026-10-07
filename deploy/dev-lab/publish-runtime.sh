#!/usr/bin/env bash
# Publish ONLY the R2 Session Host (the ESP32 runtime: Session Host + simulation engine) of an
# exact git ref to dev-lab (Sprint 10 runtime sync). Narrow by construction:
#   - builds session-host.mjs from a clean temporary worktree of <ref>, stamped with the product
#     VERSION and the exact commit (reported read-only on /health as `runtime`);
#   - the release's build-service.mjs and build-job.mjs are BYTE COPIES of the release in use
#     (the build service and its job sandboxes bind the same services release; they must not
#     change), checked by sha256;
#   - writes /srv/tbi-lab/services/<sha>/MANIFEST.json (each file's sha256 and origin, and the
#     release this one replaced), switches /srv/tbi-lab/services/current atomically, and restarts
#     ONLY tbi-session-host.service (running preview sessions end: they are ephemeral). Nothing
#     else is touched: tbi-build (it keeps the release it started with; byte-identical anyway),
#     tbi-build-job@/tbi-qemu@ templates, oauth2-proxy, Caddy, policy, keys, state;
#   - verifies on the host's socket: active, /health protocol unchanged, runtime.commit = <sha>,
#     tbi-build's start time unchanged. Any failure rolls back to the previous release.
#
#   deploy/dev-lab/publish-runtime.sh <ref>
#   rollback: deploy/dev-lab/rollback-runtime.sh   (re-points to MANIFEST.json's `replaces`)
# Requires sudo for /srv and systemctl.
set -euo pipefail

ref="${1:?usage: publish-runtime.sh <git-ref>}"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify "${ref}^{commit}")"
root=/srv/tbi-lab/services
sock=/run/tbi-runtime/api.sock
protocol='tbi-lab.session/2'
prev="$(readlink -f "$root/current")"
test -d "$prev" && test -f "$prev/build-service.mjs" && test -f "$prev/build-job.mjs"
if [ "$prev" = "$root/$sha" ]; then echo "already serving $sha"; exit 0; fi

work="$(mktemp -d)"
trap 'git -C "$repo" worktree remove --force "$work/src" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
git -C "$repo" worktree add --detach "$work/src" "$sha" >/dev/null
version="$(tr -d '[:space:]' < "$work/src/VERSION")"
(cd "$work/src" && npm ci --no-audit --no-fund >/dev/null &&
  npx esbuild runtime/host/main.ts --bundle --platform=node --format=esm --target=node22 \
    --define:__TBI_RUNTIME_VERSION__="\"$version\"" --define:__TBI_RUNTIME_COMMIT__="\"$sha\"" \
    --outfile="$work/session-host.mjs" --log-level=warning)
grep -q "$sha" "$work/session-host.mjs" || { echo "bundle is not stamped with $sha" >&2; exit 1; }

h() { sha256sum "$1" | cut -d' ' -f1; }
bs="$(h "$prev/build-service.mjs")"
bj="$(h "$prev/build-job.mjs")"
sudo install -d -m 0755 "$root/$sha"
sudo install -m 0644 "$work/session-host.mjs" "$root/$sha/session-host.mjs"
sudo install -m 0644 "$prev/build-service.mjs" "$prev/build-job.mjs" "$root/$sha/"
[ "$(h "$root/$sha/build-service.mjs")" = "$bs" ] && [ "$(h "$root/$sha/build-job.mjs")" = "$bj" ]
cat > "$work/MANIFEST.json" <<JSON
{
  "release": "$sha",
  "kind": "runtime-only (publish-runtime.sh)",
  "replaces": "$prev",
  "files": {
    "session-host.mjs": { "sha256": "$(h "$work/session-host.mjs")", "from": "$sha", "version": "$version" },
    "build-service.mjs": { "sha256": "$bs", "from": "$prev (byte copy)" },
    "build-job.mjs": { "sha256": "$bj", "from": "$prev (byte copy)" }
  }
}
JSON
sudo install -m 0644 "$work/MANIFEST.json" "$root/$sha/MANIFEST.json"

build_started="$(systemctl show -p ActiveEnterTimestamp --value tbi-build.service)"
switch() {
  sudo ln -sfn "$1" "$root/current.tmp"
  sudo mv -T "$root/current.tmp" "$root/current"
  sudo systemctl restart tbi-session-host.service
}
health() { sudo curl -sf --unix-socket "$sock" http://localhost/health; }
rollback() {
  echo "FAILED: $1 -- rolling back to $(basename "$prev")" >&2
  switch "$prev"
  exit 1
}

switch "$root/$sha"
ok=0
for _ in $(seq 1 40); do
  if systemctl is-active --quiet tbi-session-host.service && health >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.5
done
[ "$ok" = 1 ] || rollback "the Session Host did not come up"
body="$(health)"
node -e '
  const [body, sha, protocol, version] = process.argv.slice(1);
  const h = JSON.parse(body);
  const fail = (m) => { console.error(m); process.exit(1); };
  if (h.protocol !== protocol) fail(`protocol ${h.protocol} != ${protocol}`);
  if (!h.runtime || h.runtime.commit !== sha || h.runtime.version !== version) fail(`runtime ${JSON.stringify(h.runtime)}`);
  console.log(`OK   /health: protocol ${h.protocol}, runtime v${h.runtime.version} ${h.runtime.commit}`);
' "$body" "$sha" "$protocol" "$version" || rollback "/health does not report the new runtime"
[ "$(systemctl show -p ActiveEnterTimestamp --value tbi-build.service)" = "$build_started" ] ||
  rollback "tbi-build was restarted"
echo "OK   tbi-build untouched (active since $build_started)"
echo "dev-lab runtime now serves $sha (services release $root/$sha; replaces $(basename "$prev"))"
