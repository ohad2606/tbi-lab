#!/usr/bin/env bash
# Sprint 13 release package (preparation only, no deployment): build R from a clean worktree,
# exactly as install.sh (host + build service) and publish-frontend.sh (frontend) build it.
#   build-package.sh <commit> <name> <build-time>
set -euo pipefail
R="$1"; name="$2"; T="$3"
repo=/home/ubuntu/projects/tbi-lab-s13
base=/home/ubuntu/tbi-s13-rel
src="$base/src-$name"; out="$base/pkg-$name"
rm -rf "$out"; mkdir -p "$out"
git -C "$repo" worktree remove --force "$src" 2>/dev/null || true
git -C "$repo" worktree add --detach "$src" "$R" >/dev/null
cd "$src"
test -z "$(git status --porcelain)"
npm ci --no-audit --no-fund > "$out/npm-ci.log" 2>&1
env -u VITE_PREVIEW_NAME -u VITE_STORAGE_NAMESPACE -u VITE_FEEDBACK_URL VITE_SIGN_OUT_URL=/oauth2/sign_out \
  TBI_BUILD_COMMIT="$R" TBI_BUILD_ENV=dev-lab TBI_BUILD_TIME="$T" \
  npm run build --workspace @tbi-lab/app > "$out/frontend-build.log" 2>&1
node "$repo/deploy/dev-lab/verify-build.mjs" local "$src/app/dist" "$R" > "$out/verify-build.log" 2>&1
version="$(tr -d '[:space:]' < VERSION)"
npm run --silent buildsvc:build
npx esbuild runtime/host/main.ts --bundle --platform=node --format=esm --target=node22 \
  --define:__TBI_RUNTIME_VERSION__="\"$version\"" --define:__TBI_RUNTIME_COMMIT__="\"$R\"" \
  --outfile=runtime/host/dist/session-host.mjs --log-level=warning
grep -q "$R" runtime/host/dist/session-host.mjs
cp -a app/dist "$out/frontend"
mkdir -p "$out/services"
cp runtime/host/dist/session-host.mjs runtime/builder/dist/build-service.mjs runtime/builder/dist/build-job.mjs "$out/services/"
(cd "$out" && find frontend services -type f | sort | xargs sha256sum > MANIFEST.sha256)
sha256sum package-lock.json runtime/firmware/artifacts.lock.json deploy/dev-lab/s8/policy.json deploy/dev-lab/s8/policy.alpha.json > "$out/inputs.sha256"
echo "$R" > "$out/COMMIT"; echo "$version" > "$out/VERSION"; echo "$T" > "$out/BUILD_TIME"
node --version > "$out/node.version"
git -C "$repo" worktree remove --force "$src"
echo "package $name done: $(sha256sum "$out/MANIFEST.sha256" | cut -c1-16)"
