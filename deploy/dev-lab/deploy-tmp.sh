# Sprint 12 FU-11-2: scratch space for the deploy scripts (sourced, not executed).
#
# The builds run `npm ci` plus a production bundle; on this host /tmp is a 2 GB tmpfs that other
# work shares, and a full tmpfs once produced a truncated package (Sprint 11). Scratch space is
# therefore disk-backed, ${TBI_DEPLOY_TMP:-$HOME/.cache/tbi-deploy}, checked for at least
# ${TBI_DEPLOY_MIN_FREE_GB:-3} GB free before anything is built, and removed on exit.
#
#   source "$(dirname "$0")/deploy-tmp.sh"; work="$(deploy_tmp)"   # caller sets its own trap
deploy_tmp() {
  local base="${TBI_DEPLOY_TMP:-$HOME/.cache/tbi-deploy}"
  local need_kb=$(( ${TBI_DEPLOY_MIN_FREE_GB:-3} * 1024 * 1024 ))
  mkdir -p "$base"
  local free_kb
  free_kb="$(df -Pk "$base" | awk 'NR == 2 { print $4 }')"
  if [ -z "$free_kb" ] || [ "$free_kb" -lt "$need_kb" ]; then
    echo "deploy-tmp: only ${free_kb:-?} KiB free in $base, need $need_kb KiB; nothing was built" >&2
    return 1
  fi
  mktemp -d -p "$base" deploy.XXXXXX
}
