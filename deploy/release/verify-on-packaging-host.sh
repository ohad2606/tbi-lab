#!/usr/bin/env bash
# RC4 gate G2 on a packaging host (Alpha's or any other): build each release profile twice from
# the same commit and fail unless every pair is byte-identical (no exception list). Builds only:
# it installs, deploys and switches nothing, and writes only under <work-dir>.
#
#   verify-on-packaging-host.sh <commit> <work-dir> [build-time]
#
# <commit> must be the merged RC4 commit (the reviewed tree), present in this clone. The build time
# defaults to the commit's committer time (UTC), so every host derives the same value.
# Output: <work-dir>/pkg-<profile>-{1,2}, <work-dir>/G2-RESULT.txt (host, tools, hashes, verdict).
# Sprint 23B: TBI_PROFILES names the profiles (default "rc4 rc4-reports", the RC4 commit). A
# Sprint 23B commit builds only with its own profile: TBI_PROFILES=rc4-s23.
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: $0 <commit> <work-dir> [build-time]" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
R="$(git -C "$repo" rev-parse --verify "$1^{commit}")"
work="$2"
case "$work" in /*) ;; *) echo "work-dir must be absolute" >&2; exit 2 ;; esac
T="${3:-$(TZ=UTC git -C "$repo" show -s --format=%cd --date=format-local:%Y-%m-%dT%H:%M:%SZ "$R")}"
mkdir -p "$work"
result="$work/G2-RESULT.txt"
{
  echo "RC4 G2 packaging-host verification"
  echo "host: $(hostname)  cpus: $(nproc)  date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "commit: $R  build-time: $T"
  echo "node: $(node --version)  npm: $(npm --version)"
} > "$result"
rc=0
for profile in ${TBI_PROFILES:-rc4 rc4-reports}; do
  [[ "$profile" =~ ^rc[0-9]+(-[a-z0-9]+)?$ ]] || { echo "bad profile name: $profile" >&2; exit 2; }
  for n in 1 2; do
    "$here/build-package.sh" "deploy/release/$profile.release.json" "$R" "$work/pkg-$profile-$n" "$T" >> "$result" 2>&1 ||
      { echo "BUILD FAILED: $profile #$n" | tee -a "$result"; exit 1; }
  done
  if out="$("$here/compare-packages.sh" "$work/pkg-$profile-1" "$work/pkg-$profile-2")"; then
    echo "$profile: $out" | tee -a "$result"
  else
    rc=1
    { echo "$profile: NOT REPRODUCIBLE"; echo "$out"; } | tee -a "$result"
  fi
done
echo "verdict: $([ "$rc" -eq 0 ] && echo PASS || echo FAIL)" | tee -a "$result"
exit "$rc"
