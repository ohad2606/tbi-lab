# Five-session capacity acceptance (H5) — procedure for the alpha VM

Acceptance requirement (PM): five independent concurrent ESP32 sessions on the alpha host.

**Not yet run on the target.** The alpha VM is not approved or provisioned. The procedure is ready and validated on staging (single CPU) at N = 1 and 2. **The current single-core host has NOT passed five-session acceptance and is not expected to.**

## Prerequisites (on the alpha VM, after approval)

1. The release installed by the standard procedure (`install.sh <instance>`, as on staging), with:
   - **the alpha policy:** `TBI_S8_POLICY=deploy/dev-lab/s8/policy.alpha.json`, which gives five concurrent testers, a shared build queue of 10 and two build workers;
   - **an artifact store cap of at least 640 MiB:** `TBI_ARTIFACT_CAP_MB=640` (security audit #3: five users × 128 MiB quota; at the 256 MiB default, users evict each other's builds);
   - Runtime v2 `b5b34b49cb7e4049` and the release artifact set `767d3715fdaaef10`.
2. The instance is idle, with no live sessions.
3. A clean checkout of the release commit on the VM; Node as provisioned; passwordless sudo for the operator.

## One command

```
deploy/dev-lab/s8/capacity-acceptance.sh <instance> <evidence dir>          # full, ~3 h
deploy/dev-lab/s8/capacity-acceptance.sh <instance> <evidence dir> quick    # ~45 min
deploy/dev-lab/s8/capacity-acceptance.sh <instance> <evidence dir> smoke    # procedure check
```

| Stage | What | Duration (full) |
|---|---|---|
| 0 Preflight | Refuses an uncommitted checkout or a busy instance; records health, commit, runtime id, the policy hash (and whether it is the alpha policy), host CPU/memory/kernel/model, the artifact cap | — |
| 1 Ramp | N = 1 … 6 concurrent users (mix: HC-SR04 R2, DHT22 R2, GPIO R1, I2C LCD R3, GPIO, HC-SR04), 180 s each. N = 6 is informational (above the target: admitted or refused, recorded) | ~25 min |
| 2 Faults | N = 5, 600 s; one session ended and one session's QEMU unit killed, both re-created | ~12 min |
| 3 Soak | N = 5, **7200 s**; a five-user real build burst every 600 s | ~2 h |
| 4 Summary | Every criterion of every run; **OVERALL PASS** only if ramp N ≤ 5, faults and soak all pass | — |

## What every run measures and checks (`runtime/tests/c5-deployed.runtime.test.ts`)

Through the deployed instance's own sockets, sandbox, policy and admission. The users are fresh test users, as the gate would set them.

| Criterion (pass record) | Rule |
|---|---|
| `buildsAllSucceeded`, `buildsNoneRefused`, `buildWorstAtMost120s` | N users submit unique sketches **at once** (real compilations, never cache hits): all succeed, none refused, worst completion ≤ 120 s |
| `sessionsAdmitted` | All N sessions admitted by the policy |
| `rate5sP5AtLeast0995` | Ratified D-2 rule: every session's simulation rate p5 ≥ 0.995× over 5 s windows, after a 30 s warm-up |
| `tickGapP99AtMost100` | Every session's tick-gap p99 ≤ 100 ms (the host's own statistics) |
| `noFailures` | No session failed |
| `isolationEnforced` | Under load, a foreign user, and another user's valid token, can neither read, stream, command nor end a session; the owner is unaffected |
| `faultsRecovered` | Ended and crashed sessions are reported, their units are gone, and the users can start again |
| `noLeftovers` | Afterwards no QEMU unit, build-job unit or session directory remains |

Also recorded, not gated: per-session startup latency (create → running), CPU busy mean and p95, steal, load, memory available minimum, QEMU unit memory (cgroup), every build's completion time, and admission responses.

## Validation of the procedure (staging, 1 vCPU, release `dc1bff8`, 2026-10-13)

See `docs/sprints/s13-evidence/overnight/capacity-smoke/`.

- **N = 1:** **PASS** on every criterion. Build 37 s; p5 0.9998; tick-gap p99 5 ms; startup 1.06 s; isolation enforced; nothing left.
- **N = 2:** staging's preview policy admits one session, so the second user is **refused and recorded** (as designed: staging is not the alpha configuration).

The in-process harness (`c5-capacity.runtime.test.ts`) remains for comparison runs without the sandbox.

## After the run

The evidence directory holds `summary.txt`, one JSON report per run and the raw logs. Attach it to the H5 acceptance record. **Acceptance is the PM's decision on that evidence**; the script's OVERALL line is input to it, not approval.
