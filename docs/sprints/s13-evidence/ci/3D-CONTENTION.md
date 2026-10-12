# CI stability — the Sprint 12 3D e2e failures (recorded and reproduced, 2026-10-12)

**Observed (Sprint 12 closure run, `138541f`):** 9 failures, all in `s9-sync.spec.ts` /
`s9-views.spec.ts`, while a unit-test run was started concurrently on the same 1-vCPU host. Re-run
alone: 15/15 pass.

**Reproduced (controlled):** the same two files with a single-core CPU burner (a busy Node loop,
started and stopped by PID) on `sprint-13` → 5 failed / 10 passed
([log](s9-under-cpu-burner.log)). Every failure is the same assertion:

    expect(getByTestId('view3d')).toHaveAttribute('data-status', 'ready')   // default timeout 5000 ms
    Expected: "ready"   Received: "loading"

**Measured (diagnostic spec, not committed):** time from opening the 3D tab to the end of
`loading`, and the final status:

| Condition | esp32-blink | esp32-motion-relay | esp32-blink (warm) | Final status |
|---|---|---|---|---|
| idle | 3.31 s | 3.43 s | 2.74 s | `ready` (3/3) |
| CPU burner (½ CPU) | 6.37 s | 6.21 s | 5.12 s | `ready` (3/3) |

**Classification: test-infrastructure timeout, not a functional failure.** The 3D view always
reaches `ready` (never `failed` / `unavailable`); under half the CPU it needs 5.1–6.4 s, above the
default 5 s assertion timeout. Software GL (SwiftShader) on one vCPU leaves a margin of about
1.5× when idle.

**Disposition (no assertion weakened):**
- Rule: the browser suites never run concurrently with other heavy jobs on the 1-vCPU host
  (unit suites, QEMU suites, builds). CI runners with more cores are unaffected.
- The 5 s readiness expectation is kept as is: on an idle host it holds with margin, and it is the
  only signal that 3D start-up has regressed.
- If a slower host must run them, the readiness wait becomes an explicit, documented start-up
  budget (a PM decision), not a silent timeout increase.
