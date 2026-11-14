# Test safety (docs/ops/TEST-SAFETY.md): a script that restarts services, installs into /etc or
# /srv, or re-points a served release on this host refuses unless the operator names the instance
# it changes in TBI_ALLOW_SERVICE_MUTATION (comma-separated): `tbi` (DEV-Lab and its host routes),
# `tbi-s8` (staging). Source this file, then: require_mutation_opt_in <instance> [<instance>...]
# (any one of them suffices).
require_mutation_opt_in() {
  local want
  for want in "$@"; do
    case ",${TBI_ALLOW_SERVICE_MUTATION:-}," in *",$want,"*) return 0 ;; esac
  done
  echo "refused: set TBI_ALLOW_SERVICE_MUTATION=$1 to let $(basename "$0") change $1" >&2
  exit 64
}
