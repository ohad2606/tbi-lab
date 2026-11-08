#!/usr/bin/env bash
# B2: deployed suites against staging, strictly serial. Results in B2-RESULTS.
E=/home/ubuntu/tbi-s13-rel/deploy-c3b148b
cd /home/ubuntu/projects/tbi-lab-s13 || exit 1
export TBI_RUNTIME_HOME=/home/ubuntu/tbi-s13-r4probe/rthome-ctl
echo "tests from $(git rev-parse --short HEAD)" > $E/B2-RESULTS
t() { local n=$1; shift; env "$@" npx vitest run --config vitest.runtime.config.ts runtime/tests/$n.runtime.test.ts > $E/B2-$n.log 2>&1; echo "$n exit=$? $(grep -E '^\s+Tests ' $E/B2-$n.log | tail -1)" >> $E/B2-RESULTS; }
for s in s11-deployed s8-deployed-policy s8-containment s8-qemu-tasks s8-policy; do t $s TBI_S8_INSTANCE=tbi-s8; done
t s13-deployed-security TBI_S13_SEC_DEPLOYED=tbi-s8
t c5-deployed TBI_C5_DEPLOYED=tbi-s8 TBI_C5_N=1 TBI_C5_SECONDS=120 TBI_C5_FAULTS=1
echo "policy now: $(sudo -n sha256sum /etc/tbi-s8/policy.json | cut -c1-16)" >> $E/B2-RESULTS
echo B2 DONE >> $E/B2-RESULTS
