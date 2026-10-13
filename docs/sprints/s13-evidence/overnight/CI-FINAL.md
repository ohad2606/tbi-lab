# Final CI: candidate `c3b148b` (overnight, 2026-10-13)

**Commit tested:** `c3b148b11b71c1cb01ff67caf1a8dc3150b279d0`, clean tree. Everything ran **serially** on the single-core development host, with nothing else running. Commits after `c3b148b` change documentation only.

| Step | Result |
|---|---|
| Typecheck (all projects) | **pass** |
| Lint (eslint, prettier, boundaries) | **pass** |
| Unit (vitest) | **1146 / 1146 pass** (134 files) |
| e2e, full (`playwright.app.config.ts`) | **196 pass, 0 fail, 22 skipped**. All 22 skips are env-gated: real-QEMU backends (`TBI_S6/S11/S12_REAL`, run below or in earlier sprints) and the measurement-only `TBI_3D_TIMING` |
| Host build | **pass** |
| Pinned runtime suites, release QEMU (`TBI_RUNTIME_HOME=…/rthome-ctl`, Runtime v2 `b5b34b49cb7e4049`) | **12 / 12 suites, 81 / 81 tests pass**: gate 7, s12-determinism 8, r1-determinism 2, r2-acceptance 5, s12-pace 1, s12-r2-timing 9, r2-failures 11, failures 15, s12-bridge 11, s12-r3 4, s13-pad-short 1, electrical 7. **No pinned fingerprint changed; nothing re-baselined** |
| Real QEMU in a real browser (the candidate frontend against staging's backends at `dc1bff8`, bounded relays) | **9 / 9 pass**: export/import, journey EN→HE and HE→EN, live sliders ×2, pad short EN/HE, OS-09 LCD swap, P4 refusal |

**Not covered by this CI.**
- The candidate **host and build service** on a deployed instance: deployment is not authorized. The pinned suites run the candidate host code against the release QEMU locally.
- The staging-instance suites (`s8-*`, `s11-deployed`): they reconfigure staging.
- C-5 at N ≥ 2: needs the alpha host.
- OS-02 GPU timing: needs the owner's GPU.

## The first full run (`d5c03a6`) failed, and the failure was real

e2e `sprint5` A12 failed: a full storage showed "Could not save" instead of "storage is full". This was a regression from the overnight fix `7490778` (see `DATA-INTEGRITY-AUDIT.md`). It was fixed in `c3b148b` with a unit test that fails first. The whole CI was then rerun from the start on `c3b148b` (above). In the first run, unit (1144), typecheck and lint had passed; e2e was 195 pass, 1 fail.

## Release-candidate preparation package (not approval)

The package was built twice from `c3b148b` in clean worktrees (`~/tbi-s13-rel/build-package.sh`), with the same build time. See `SPRINT-13-ALPHA-READINESS.md` §6 for the hashes and the comparison.
