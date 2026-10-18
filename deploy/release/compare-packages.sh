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
diff <(cut -c67- "$a/MANIFEST.sha256") <(cut -c67- "$b/MANIFEST.sha256") > /dev/null ||
  { echo "DIFFERS: file lists"; diff <(cut -c67- "$a/MANIFEST.sha256") <(cut -c67- "$b/MANIFEST.sha256") || true; rc=1; }
while read -r sum path; do
  other="$(awk -v p="$path" '$2 == p { print $1 }' "$b/MANIFEST.sha256")"
  [ -n "$other" ] && [ "$other" != "$sum" ] && { echo "DIFFERS ($(kind "$path")): $path"; rc=1; }
done < "$a/MANIFEST.sha256"
# The manifests describe the files; check the files themselves match their manifests too.
(cd "$a" && sha256sum --quiet -c MANIFEST.sha256) || rc=1
(cd "$b" && sha256sum --quiet -c MANIFEST.sha256) || rc=1
n="$(wc -l < "$a/MANIFEST.sha256")"
if [ "$rc" -eq 0 ]; then
  echo "IDENTICAL: $n files ($(grep -c '\.map$' "$a/MANIFEST.sha256") source maps), manifest $(sha256sum "$a/MANIFEST.sha256" | cut -c1-16)"
fi
exit "$rc"
