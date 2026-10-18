#!/usr/bin/env bash
# RC4 release package (preparation only, no deployment). Successor of the Sprint 13 / RC3 script
# docs/sprints/s13-evidence/release/build-package.sh (kept unchanged as RC3 evidence), with the
# same package layout, so an RC3 package and an RC4 package install and roll back the same way.
#
#   build-package.sh <profile.release.json> <commit> <out-dir> <build-time YYYY-MM-DDTHH:MM:SSZ>
#
# Differences from RC3 (packaging gate G2/G3):
# - Every release-relevant setting comes from the profile, validated against the source being
#   built (release-config.mjs: exactly the VITE_* settings the source reads, Active Minutes absent,
#   Report a Problem switches explicit and consistent, pinned Node/npm). Nothing is inherited:
#   npm ci and every build run under `env -i` with only PATH, HOME, LC_ALL and TZ added, and npm
#   reads no user or global npmrc (NPM_CONFIG_USERCONFIG / GLOBALCONFIG = /dev/null).
# - The profile and validator are read from the commit being built, not from this checkout.
# - The source is built beside the package (<out-dir>.src); the output does not depend on that
#   path (verified: two packages built at different paths are byte-identical, source maps included).
# - The effective configuration is recorded (build-config.json; configuration only, no secrets).
set -euo pipefail
[ $# -eq 4 ] || { echo "usage: $0 <profile> <commit> <out-dir> <build-time>" >&2; exit 2; }
profile_arg="$1"; ref="$2"; out="$3"; T="$4"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
R="$(git -C "$repo" rev-parse --verify "${ref}^{commit}")"
case "$out" in /*) ;; *) echo "out-dir must be absolute" >&2; exit 2 ;; esac
src="$out.src"

rm -rf "$out"; mkdir -p "$out"
git -C "$repo" worktree remove --force "$src" 2>/dev/null || true
rm -rf "$src"
git -C "$repo" worktree add --detach "$src" "$R" >/dev/null
trap 'git -C "$repo" worktree remove --force "$src" >/dev/null 2>&1 || true' EXIT
cd "$src"
test -z "$(git status --porcelain)"
profile="$src/deploy/release/$(basename "$profile_arg")"
[ -f "$profile" ] || { echo "profile $(basename "$profile_arg") is not in commit $R" >&2; exit 1; }

# The pinned build environment (validates the profile against this source first).
node deploy/release/release-config.mjs check "$profile" "$src" > "$out/build-config.json"
mapfile -t ENV < <(node deploy/release/release-config.mjs env "$profile" "$src" "$R" "$T")
[ "${#ENV[@]}" -gt 0 ]
base_env=("PATH=$PATH" "HOME=$HOME" "NPM_CONFIG_USERCONFIG=/dev/null" "NPM_CONFIG_GLOBALCONFIG=/dev/null"
  "LC_ALL=C" "TZ=UTC")

env -i "${base_env[@]}" npm ci --no-audit --no-fund > "$out/npm-ci.log" 2>&1
env -i "${ENV[@]}" npm run build --workspace @tbi-lab/app > "$out/frontend-build.log" 2>&1
node deploy/dev-lab/verify-build.mjs local "$src/app/dist" "$R" > "$out/verify-build.log" 2>&1
node deploy/release/check-dist.mjs "$profile" "$src/app/dist" > "$out/check-dist.log" 2>&1

version="$(tr -d '[:space:]' < VERSION)"
env -i "${base_env[@]}" npm run --silent buildsvc:build
env -i "${base_env[@]}" npx esbuild runtime/host/main.ts --bundle --platform=node --format=esm --target=node22 \
  --define:__TBI_RUNTIME_VERSION__="\"$version\"" --define:__TBI_RUNTIME_COMMIT__="\"$R\"" \
  --outfile=runtime/host/dist/session-host.mjs --log-level=warning
grep -q "$R" runtime/host/dist/session-host.mjs

cp -a app/dist "$out/frontend"
mkdir -p "$out/services"
cp runtime/host/dist/session-host.mjs runtime/builder/dist/build-service.mjs runtime/builder/dist/build-job.mjs "$out/services/"
(cd "$out" && find frontend services -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > MANIFEST.sha256)
sha256sum package-lock.json runtime/firmware/artifacts.lock.json deploy/dev-lab/s8/policy.json \
  deploy/dev-lab/s8/policy.alpha.json "deploy/release/$(basename "$profile")" > "$out/inputs.sha256"
echo "$R" > "$out/COMMIT"; echo "$version" > "$out/VERSION"; echo "$T" > "$out/BUILD_TIME"
node --version > "$out/node.version"; npm --version > "$out/npm.version"
echo "package $(basename "$out") done: $(sha256sum "$out/MANIFEST.sha256" | cut -c1-16)"
