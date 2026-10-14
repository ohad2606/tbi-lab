#!/usr/bin/env bash
# Sprint 13 H5: five-session capacity acceptance on a DEPLOYED instance (the alpha VM).
# Measurement only: fresh test users, the harness's own sessions and builds; nothing is
# installed, restarted or reconfigured. Run from a clean checkout of the release commit on the
# host itself (the harness reads /proc and the instance's units), as the operator with sudo.
#
#   deploy/dev-lab/s8/capacity-acceptance.sh <instance> <evidence dir> [quick]
#
# Stages (each a c5-deployed run; every report lands in <evidence dir>):
#   0. preflight: instance healthy and idle, runtime id, policy, host facts recorded
#   1. ramp:      N = 1 .. 6, 180 s each (N = 6 is above the alpha target: admitted or refused,
#                 recorded either way)
#   2. faults:    N = 5, 600 s, one session ended and one QEMU killed, both re-created
#   3. soak:      N = 5, 7200 s, a five-user build burst every 600 s; each session replaced by its
#                 user every 1500 s (staggered 60 s), below the policy's 30-min session lifetime:
#                 host-level continuity over 2 h, no single session lives longer than 25 min
#   4. summary:   every criterion of every run; overall PASS only if stages 1 (N <= 5), 2, 3 pass
# `quick` shortens the stages (60 s ramp, 180 s faults, 600 s soak); `smoke` runs only N = 1 and
# 2 (60 s), faults at N = 2 (120 s) and a 180 s soak at N = 1: a check of the procedure itself
# (e.g. on staging, whose policy admits one session: N = 2 then records the refusal).
set -euo pipefail
inst="${1:?usage: capacity-acceptance.sh <instance> <evidence dir> [quick]}"
out="${2:?evidence dir}"
quick="${3:-}"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
mkdir -p "$out"
RAMP_S=180 FAULT_S=600 SOAK_S=7200 BURST_S=600 ROTATE_S=1500
RAMP_N="1 2 3 4 5 6" FAULT_N=5 SOAK_N=5
if [ "$quick" = quick ]; then RAMP_S=60 FAULT_S=180 SOAK_S=600 BURST_S=300 ROTATE_S=300; fi
if [ "$quick" = smoke ]; then RAMP_S=60 FAULT_S=120 SOAK_S=180 BURST_S=90 ROTATE_S=100 RAMP_N="1 2" FAULT_N=2 SOAK_N=1; fi

health() { sudo -n curl -s -m 5 --unix-socket "/run/$inst-runtime/api.sock" http://x/health; }
echo "== 0. preflight ($inst)" | tee "$out/summary.txt"
test -z "$(git -C "$repo" status --porcelain)" || { echo "refused: uncommitted changes" >&2; exit 1; }
h="$(health)"; echo "health: $h" | tee -a "$out/summary.txt"
echo "$h" | grep -q '"sessions":{' || { echo "instance not healthy" >&2; exit 1; }
live="$(systemctl list-units --plain --no-legend --state=active "$inst-qemu@*" | wc -l)"
[ "$live" -eq 0 ] || { echo "refused: $live live session(s); run on an idle instance" >&2; exit 1; }
{
  echo "commit: $(git -C "$repo" rev-parse HEAD)"
  echo "runtime: $(sudo -n cat "/etc/$inst/runtime.json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["runtimeId"])')"
  echo "policy sha256: $(sudo -n sha256sum "/etc/$inst/policy.json" | cut -c1-16)"
  echo "alpha policy:  $(sha256sum "$repo/deploy/dev-lab/s8/policy.alpha.json" | cut -c1-16) (must match for the alpha acceptance)"
  echo "host: $(nproc) CPU, $(free -m | awk '/Mem:/{print $2}') MiB, $(uname -r), $(lscpu | sed -n 's/Model name:\s*//p')"
  echo "artifact cap: $(sudo -n systemctl show -p Environment "$inst-build.service" | grep -o 'TBI_ARTIFACT_CAP_MB=[0-9]*' || echo 'default (256 MiB)')"
} | tee -a "$out/summary.txt"
# Phase C: the live-session limits must agree. The Session Host admits min(policy limit, its own
# ceiling TBI_HOST_MAX_SESSIONS, default 4); a ceiling below the policy would cap the run silently.
ceiling="$(sudo -n systemctl show -p Environment "$inst-session-host.service" | { grep -o 'TBI_HOST_MAX_SESSIONS=[0-9]*' || true; } | cut -d= -f2)"
ceiling="${ceiling:-4}" # an install before Phase C renders none: the engineering default
hostpid="$(systemctl show -p MainPID --value "$inst-session-host.service")"
[ -n "$hostpid" ] && [ "$hostpid" != 0 ] || { echo "refused: $inst-session-host is not running" | tee -a "$out/summary.txt" >&2; exit 1; }
# "cpus" = the CPUs the Session Host may run on (its affinity), as the service resolves it.
cpus="$(sudo -n cat "/proc/$hostpid/status" | python3 -c 'import re,sys
l=re.search(r"Cpus_allowed_list:\s*(\S+)", sys.stdin.read()).group(1)
print(sum(int(b)-int(a)+1 if b else 1 for a,_,b in (r.partition("-") for r in l.split(","))))')"
policy_live="$(sudo -n cat "/etc/$inst/policy.json" | python3 -c 'import json,sys
v=json.load(sys.stdin).get("global",{}).get("runtime",{}).get("maxLiveSessions","cpus")
print(sys.argv[1] if v=="cpus" else v)' "$cpus")"
echo "live sessions: policy $policy_live, host ceiling $ceiling, effective $(( ceiling < policy_live ? ceiling : policy_live ))" | tee -a "$out/summary.txt"
(( ceiling >= policy_live )) || { echo "refused: host ceiling $ceiling below the policy's $policy_live (install.sh TBI_S8_HOST_MAX_SESSIONS)" | tee -a "$out/summary.txt" >&2; exit 1; }

run() { # $1 name, then env assignments
  local name="$1"; shift
  echo "== $name" | tee -a "$out/summary.txt"
  (cd "$repo" && env "$@" TBI_C5_DEPLOYED="$inst" \
    npx vitest run --config vitest.runtime.config.ts runtime/tests/c5-deployed.runtime.test.ts \
    >"$out/$name.log" 2>&1) || echo "   (harness exit $?)" | tee -a "$out/summary.txt"
  # The report is the JSON the harness prints; keep it and its pass record.
  python3 - "$out/$name.log" "$out/$name.json" <<'PY' | tee -a "$out/summary.txt"
import json, sys
t = open(sys.argv[1]).read(); i = t.find('{\n  "instance"')
if i < 0: print('   NO REPORT'); sys.exit(0)
d = json.loads(t[i:t.index('\n}\n', i) + 2]); json.dump(d, open(sys.argv[2], 'w'), indent=1)
p = d['pass']; ok = all(p.values())
print('   ' + ('PASS' if ok else 'FAIL') + '  ' + ' '.join(f"{k}={'y' if v else 'N'}" for k, v in p.items()))
print(f"   admitted {sum(a['status'] == 201 and not a.get('recreate') and not a.get('rotation') for a in d['admission'])}/{d['n']}, worst build {d.get('worstBuildAllMs', d['worstBuildMs'])} ms (first burst {d['worstBuildMs']} ms), "
      f"cpu mean {d['host']['cpuBusyMean']:.2f}, mem min {d['host']['memAvailableMinMb']} MiB, leftovers {d['leftovers']}")
for s in d['sessions']:
    print(f"     {s['workload']:<6} p5(5s) {s['rate5sP5']} startup {s['startupMs']} ms  tick-gap p99 {((s.get('pace') or {}).get('tickGapMs') or {}).get('p99')} ms {s.get('fault', '')}{' rotated' if s.get('rotated') else ''}")
r = d.get('rotation')
if r:
    gaps = [x['gapMs'] for x in r['replacements'] if x['gapMs'] is not None]
    print(f"   rotation: {len(r['replacements'])} replacements every {r['everyS']} s, gap max {max(gaps) if gaps else None} ms, "
          f"all clean {d['pass'].get('rotationsClean')}, "
          f"running-seconds {r['runningSeconds']}")
    print(f"   host-level soak {d['seconds']} s; per-session lifetime: the longest single session lived "
          f"{r['maxSessionAgeS']} s; rotationsClean={d['pass'].get('rotationsClean')} "
          f"lifetimeNeverReached={d['pass'].get('lifetimeNeverReached')}")
PY
}

for n in $RAMP_N; do run "ramp-n$n" TBI_C5_N="$n" TBI_C5_SECONDS=$RAMP_S; done
run "faults-n$FAULT_N" TBI_C5_N=$FAULT_N TBI_C5_SECONDS=$FAULT_S TBI_C5_FAULTS=1
run "soak-n$SOAK_N" TBI_C5_N=$SOAK_N TBI_C5_SECONDS=$SOAK_S TBI_C5_BUILD_EVERY=$BURST_S TBI_C5_ROTATE=$ROTATE_S

echo "== summary" | tee -a "$out/summary.txt"
python3 - "$out" "$RAMP_N" "$FAULT_N" "$SOAK_N" <<'PY' | tee -a "$out/summary.txt"
import json, os, sys
out = sys.argv[1]
need = [f'ramp-n{n}' for n in sys.argv[2].split() if n != '6'] + [f'faults-n{sys.argv[3]}', f'soak-n{sys.argv[4]}']
ok = True
for name in need:
    f = os.path.join(out, name + '.json')
    if not os.path.exists(f): print(f'{name}: NO REPORT'); ok = False; continue
    p = json.load(open(f))['pass']; good = all(p.values()); ok &= good
    print(f"{name}: {'PASS' if good else 'FAIL ' + ','.join(k for k, v in p.items() if not v)}")
f6 = os.path.join(out, 'ramp-n6.json')
if os.path.exists(f6):
    d = json.load(open(f6)); print(f"ramp-n6 (above target, informational): admitted {sum(a['status'] == 201 and not a.get('recreate') and not a.get('rotation') for a in d['admission'])}/6")
print('OVERALL: ' + ('PASS (five-session capacity accepted on this host, subject to PM review)' if ok else 'FAIL'))
PY
