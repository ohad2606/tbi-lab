# Sprint 13 CI after the Owner Smoke remediation and physics P2–P4, on `2e9ab98` (2026-10-12)

All runs were serial. Nothing else ran on the single-CPU host at the same time.

| Suite | Result |
|---|---|
| Unit (vitest) | **1127 / 1127** (131 files) |
| Typecheck, lint (incl. Prettier, boundaries) | pass |
| e2e, CI fakes (full) | **190 passed, 0 failed, 20 skipped** (the full run gave 188 + 2 failures, both caused by Sprint 13 behaviour changes and updated in `2e9ab98`: s6 (OS-08) and s12-parts (OS-04); both files re-run green) |
| Pinned runtime suites, release Runtime v2 QEMU `b5b34b49cb7e4049` | gate 7/7 (R-MCU-1 pins unchanged) · s12-determinism 8/8 · r1-determinism 2/2 (pins of `d20f2cc`) · r2-acceptance 5/5 · s12-pace 1/1 · s12-r2-timing 9/9 · r2-failures 11/11 · failures 15/15 · s12-bridge 11/11 · s12-r3 4/4 (incl. OS-09 real QEMU) · s13-pad-short 1/1 · electrical 7/7 |
| Real QEMU in the browser (Sprint 13 frontend, staging Session Host + Runtime v2 through bounded relays, stopped by PID) | s13-journey-real 2/2 (EN→HE, HE→EN) · s13-live-real 2/2 (night light and distance alarm, sliders dragged during live ESP32 sessions) |

**Measured cost.** Startup JS grows by about 20 KB gzip, because the OS-04 overlap rule loads the scene geometry at start. The lazy 3D chunk shrinks by about 16 KB. Option: move the rule off the startup path. That needs a PM call; it is not done.

**Deployments.** No deployment changed. dev-lab and staging still run `ba0f4a6`.
