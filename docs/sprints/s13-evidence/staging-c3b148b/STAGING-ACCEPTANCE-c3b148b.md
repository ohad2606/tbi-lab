# Staging validation: candidate `c3b148b` (overnight security and data-integrity fixes, 2026-10-13)

**PM authorization:** "Overnight Review and Conditional Release Authorization". Staging: GO. DEV: conditional GO, only if staging passes every mandatory gate.

**Result: staging PASSED every mandatory gate.** Staging now runs `c3b148b`, with the default staging policy (not the alpha policy).

## Release

| Item | Value |
|---|---|
| Commit | `c3b148b11b71c1cb01ff67caf1a8dc3150b279d0` (full CI: `s13-evidence/overnight/CI-FINAL.md`) |
| Package | Built twice from clean worktrees and byte-identical. Manifest `84bec1760151b5b6…` (`s13-evidence/overnight/rc-c3b148b/`). Read-only copy at `~/tbi-s13-rel/release-c3b148b` |
| Bundles | session-host `f9c1af47…`, build-service `fe2a2c50…`, build-job `011f703c…` (unchanged from `dc1bff8`) |
| Runtime / firmware lock / policy | **Unchanged**: Runtime v2 `b5b34b49cb7e4049`, artifact set `767d3715fdaaef10`, staging policy `d43ab503…`. There is no diff in `runtime/firmware`, QEMU, patches, policy or `install.sh` between `dc1bff8` and `c3b148b` |

## Compatibility (frontend ↔ Session Host)

| Pairing | Result |
|---|---|
| New frontend + old host (`dc1bff8`) | Real-QEMU browser runs 9/9 (CI-FINAL) |
| Old frontend + new host | Compatible by construction. The host no longer sends the runtime's error *text* in a `failed` state's detail. The frontend never read it, at either commit: it uses the reason code. The new `413 source_too_large` maps to the frontend's existing `too_large` handling, and both frontends already refuse sketches over 64 KiB before sending. The stream cap (4) is above the app's single stream |
| New + new | Target: B3 below |

Deployment order on DEV: host first, then frontend. Rollback runs in the reverse order.

## Steps

| Step | Result | Evidence |
|---|---|---|
| **B0** backup | **PASS**. `/var/backups/tbi-lab/s13-staging-pre-c3b148b-20261013T051853Z`: 4 units, polkit rule, `/etc/tbi-s8` (keys, policy, `runtime.json`), 3 bundles. 12 files, each byte-equal to the live file | `B0-hashes.txt` |
| **Baseline** | Deployed security test on `dc1bff8` *before* the install. It fails `sourceLimitAtSubmit` (an over-64 KiB sketch: 202, build record created) and `streamCap` (5th stream: 200), which are the controls that release lacks. Everything else passes | `sec-staging-before-dc1bff8.json` |
| **B1** install | **PASS**. `install.sh staging` from a clean worktree of `c3b148b` (`npm ci`), `TBI_S8_POLICY` explicitly unset (default policy), release runtime; 3.7 s. `/health` = `c3b148b`; the 3 bundles are **byte-identical to the package**. Units, policy, keys and `runtime.json` are unchanged. dev-lab is unchanged | `staging-before.txt`, `staging-after-B1.txt` |
| **B2** deployed suites | **PASS**. s11-deployed 6 + 2 skipped (old-host cases) · s8-deployed-policy 7/7 · s8-containment 9/9 · s8-qemu-tasks 2/2 · s8-policy 7/7 · **s13-deployed-security: every check** · **c5-deployed N=1 with fault: every criterion** (p5 0.9993, tick-gap p99 5 ms, isolation enforced, ended → re-created, nothing left over). Policy byte-equal to B0 afterwards | `B2-RESULTS`, `B2-*.json` |
| **B3** real-QEMU browser (the candidate frontend against staging, bounded relays) | **PASS: 33 tests**, plus 2 skips that apply only to old hosts. Export/import, journey EN↔HE, live sliders ×2, pad short EN/HE, OS-09, P4, Owner Smoke spec 13/13 (incl. a11y V1/V7), s12-real 3/3, s11-real 3/3, s6-real 3/3 incl. product-level determinism | `c3b-B3-run*.summary.txt` |
| **B5** rollback rehearsal | **PASS**. Rollback to `dc1bff8` from B0 in **1.64 s**, byte-equal to B0; session check 2/2 on it. Forward to `c3b148b` (`install.sh` from the clean checkout) in **2.86 s**, equal to the B1 state and the package. After the forward install: s8-qemu-tasks + s11-deployed 8 passed, 2 skipped; the security test passed again | `B5-*`, `staging-after-rollback.txt`, `staging-final.txt` |

## The overnight fixes, deployed

| Fix | Deployed check on staging |
|---|---|
| #1 event-stream cap | 4 streams 200, 5th **429**, a freed slot can be reused (before: 5th = 200) |
| #4 source limit at submit | Over 64 KiB: **413 `source_too_large`, no build id** (before: 202 plus a record); over 1 MiB: 413 |
| #6 no server text to clients | No client-visible body or event of the run names a server path. The `failed` state of a killed session carries `reason` with no `error` text |
| Launcher exception / crash containment | QEMU unit killed → `failed` / `guest_reset` reported; **Session Host PID unchanged**; health 200; the user starts again. A *throwing* launcher cannot be induced on a deployed instance without changing it; it is covered by `failures.test.ts` on the same code (it ends as `start_failed`) |
| #2 non-blocking shutdown | Worst `/health` latency while a session ends: 22 ms, the **same before and after**. On a healthy host the unit disappears at once, so the stall never shows here. The defect needs a slow `systemctl`, which `launcher.test.ts` reproduces (1018 ms before, < 150 ms after). The deployed result is a no-regression check, **not** a before/after proof |
| #9 constant-time build token | Build ownership: another user or a wrong token gets 404 |
| Isolation / ownership | Another user cannot read, stream, command or end the session (404), and the owner is unaffected. This held under load in c5-deployed too |
| Data integrity (H1/H2/H3/M2, A12) | Frontend-only (browser IndexedDB). Unit + e2e in CI on `c3b148b` (1146 unit; e2e 196/0 incl. A12 storage-full, A16 races, library); the real export/import run in B3 |

## Findings during staging (none in the product)

1. **Test precondition:** the a11y V1 "blocked Run" test assumed that opening `esp32-blink` blocks Run. Against a real build service, the unchanged example has a valid cached build, so Run is rightly available (OS-08). The test now makes a unique source edit first. Fixed in `b2db6ba`; 13/13 in real mode, and it passes in mock mode.
2. **Policy rate limit, by design:** a test's session was refused `rate_limited` (preview plan: 20 creations per 10 minutes for one identity) after three back-to-back browser batches. It was rerun after the window: pass. The same split was used for `dc1bff8`.

## Final staging state

`c3b148b`, Runtime v2 `b5b34b49cb7e4049`, default policy `d43ab503…`, bundles = package. No session, QEMU unit or relay was left behind. Rollback: `tools/rollback-staging.sh` (from B0; rehearsed).
