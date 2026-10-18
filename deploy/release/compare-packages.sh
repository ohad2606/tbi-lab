#!/usr/bin/env bash
# Reproducibility gate (G2): compare two packages built by build-package.sh from the same commit,
# profile and build time. Every file in MANIFEST.sha256 (executable JS, HTML, CSS, source maps,
# version.json, images, the three services) and the recorded configuration must be identical.
# There is no exception list: any differing file is reported by name and type, and fails.
#   compare-packages.sh <pkg-a> <pkg-b>
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <pkg-a> <pkg-b>" >&2; exit 2; }
a="$1"; b="$2"; rc=0
for f in COMMIT VERSION BUILD_TIME node.version npm.version inputs.sha256 build-config.json; do
  cmp -s "$a/$f" "$b/$f" || { echo "DIFFERS (record): $f"; rc=1; }
done
kind() {
  case "$1" in
    *.js.map | *.mjs.map) echo "source map" ;; *.js | *.mjs) echo "executable" ;;
    *.html) echo "html" ;; *.css) echo "css" ;; *.json) echo "json" ;; *) echo "asset" ;;
  esac
}
# The verdict: the two manifests are byte-identical (same paths, same hashes, same order).
if ! cmp -s "$a/MANIFEST.sha256" "$b/MANIFEST.sha256"; then
  rc=1
  # Name each differing or missing file (paths are column 67 on: names with spaces are kept).
  diff <(LC_ALL=C sort "$a/MANIFEST.sha256") <(LC_ALL=C sort "$b/MANIFEST.sha256") |
    sed -n 's/^[<>] [0-9a-f]\{64\}  //p' | LC_ALL=C sort -u |
    while IFS= read -r path; do echo "DIFFERS ($(kind "$path")): $path"; done
fi
# The manifests describe the files; check the files themselves match their manifests too.
(cd "$a" && sha256sum --quiet -c MANIFEST.sha256) || rc=1
(cd "$b" && sha256sum --quiet -c MANIFEST.sha256) || rc=1
n="$(wc -l < "$a/MANIFEST.sha256")"
if [ "$rc" -eq 0 ]; then
  echo "IDENTICAL: $n files ($(grep -c '\.map$' "$a/MANIFEST.sha256") source maps), manifest $(sha256sum "$a/MANIFEST.sha256" | cut -c1-16)"
fi
exit "$rc"
