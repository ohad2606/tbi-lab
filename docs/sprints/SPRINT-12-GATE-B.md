# Sprint 12 — Gate B (staging) evidence

**Status: STOPPED at B4 for PM review.** A pinned release fingerprint did not match on Runtime v2
(`r1-determinism`). It is now explained and a candidate re-pin is prepared, but changing a release
pin is a PM decision. B4b (R-MCU-1), B5 (rollback rehearsal), B6 (browser runs on Runtime v2) and
B7 (C-5 dry run) were **not run**. Dev-lab and production are untouched; nothing is merged or
tagged; Sprints 11 and 12 stay open.

Evidence files: [`s12-evidence/gate-b/`](s12-evidence/gate-b/). Plan: [SPRINT-12-STAGING-PLAN.md](SPRINT-12-STAGING-PLAN.md).

## State left on staging (`tbi-s8-*`)

| Item | Value |
|---|---|
| Session Host | `c5ed6c0` (stamped bundle `1cfa4f42…`; `/health` runtime.commit = `c5ed6c0…`) |
| Build service | `c5ed6c0` (`fbdc0b13…`), `/etc/tbi-s8/runtime.json` = Runtime v2 |
| QEMU runtime bound by `tbi-s8-qemu@` | `/home/ubuntu/tbi-s12-rt-release/qemu-b5b34b49cb7e4049` (clean build) |
| Policy | byte-equal to the B0 backup |
| Sessions | none live |
| Rollback (one command, ~1 s, restarts only `tbi-s8-build`) | `deploy/dev-lab/s8/switch-runtime.sh staging /home/ubuntu/tbi-s8-rt/qemu-33e35e4ac5e798d7`; full: restore B0 |
| Backups | `/var/backups/tbi-lab/s12-staging-pre-20261010T165444Z` (B0), `/var/backups/tbi-lab/switch-runtime-tbi-s8-20261010T175548Z` (B3) |

## Steps

| Step | Result |
|---|---|
| Push | `b8ad8c4..c5ed6c0` (11 commits) pushed to `origin/sprint-12` |
| Preflight | all pass ([b-preflight.md](s12-evidence/gate-b/b-preflight.md)): clean tree; clean export `npm ci` + typecheck + lint + 1010/1010 unit; staging idle; 31 GB free; B0 backup; dev-lab isolation (separate binds, baseline snapshot); rollback path |
| B2 clean build | `provision.sh all` from `git archive c5ed6c0` into `~/tbi-s12-rt-release`: runtime id **`b5b34b49cb7e4049`** reproduced, capabilities `i2c,pad-func,sched-input`; locally gate 6/6 (Runtime v2 pins) + bridge 10/10 |
| B2 firmware | 6/12 pinned images reproduced byte-exact; 6 did not (finding G-2); pinned bytes imported sha-verified per the lock policy |
| B0 | backup taken before any change |
| B1 host v2 on v1 QEMU | `install.sh staging` (with `TBI_S8_ARTIFACTS` = release artifacts; plan correction G-3), stamped host installed; 11 reference images imported. Sprint 11 suites + `s11-deployed` on staging: 125 pass, 3 fail → `firmware` lock check passes 2/2 with the complete pin set (harness home, not staging); 2 `s8-deployed-policy` = G-4. Browser: an R2 example on this host is refused `unsupported_component`, "U2 cannot be simulated yet." |
| B3 switch | Runtime v2 in **921 ms**; only `tbi-s8-build` restarted |
| B4a all suites on Runtime v2 | 34 files: **152 pass, 5 fail, 2 skipped**. 3 = G-4 (`s8-deployed-policy`, one consequential). 2 = `r1-determinism` pin mismatch (G-1, **stop**). Passing: gate 7/7 (incl. new stressed boot window), s12-bridge 10/10, s12-r2 3/3, s12-r3 3/3, s12-determinism 8/8 (7 pins), s12-examples 3/3, s12-pace 1/1, s8-containment 9/9, s8-policy 7/7, s8-qemu-tasks 2/2, s11-deployed 6/6, r2-failures 11/11, all R1 part suites |
| B4b–B7 | not run (stopped) |
| Dev-lab | snapshot identical before and after every step (units, keys, policy, bundles, start times of tbi-build, tbi-session-host, Caddy, oauth2-proxy, tbi-qemu@ bind, v1 binary) |

## Findings

**G-1 (stop): `r1-determinism` had no Runtime v2 pins.** Each R1 example workload is
deterministic on Runtime v2 (3/3 on staging, 10/10 locally) but does not match the R1 pin; the
suite was never run on Runtime v2 during development (my omission). Event-by-event diff against v1:
in each workload exactly one event differs, the 0.89 s GPIO window, which on Runtime v2 also carries
the input-only pads 34/35/36/39 once (drive 0, level 0) — re-pin mechanism 2 already recorded for
the gate (`pinMode(INPUT)` transient). All electrical outcomes and timestamps are identical.
Candidate re-pin committed locally (`511044f`): motion `5fdb6a1ad50a412a`, night
`5596d749c3ce4f8c`, from 10 converging runs; v1 still reproduces the R1 pins. **Needs PM approval.**

**G-2: six pinned firmware images are not reproducible from a clean build.** `TbiR1Scan` (Sprint 11)
and the five Sprint 12 test images embed absolute host paths
(`/home/ubuntu/tbi-r1-clean/rt/arduino/data/…`) in core assert strings. Root cause: `provision.sh`
mapped `$RT/arduino/data` as written while the compiler sees the symlink-resolved directory; homes
with a symlinked arduino directory (`~/tbi-s8-rt`, the S12 dev home) built contaminated images.
This is the cause of the Sprint 7 "rebuild does not reproduce" note. Fix committed locally
(`42001e3`) and verified: through a symlinked home the old script embeds host paths, the fixed one
gives the clean-build bytes. Tests and the release use the pinned bytes (lock policy), so this did
not block B1–B4. **Decision needed:** re-pin the six images to the clean-build hashes (requires
re-establishing the S12 determinism pins against them) or keep the pinned bytes.

**G-3: plan correction.** The plan's B1 command would have failed: the v1 runtime home has no S12
test images, and FU-11-1 imports every pinned image. B1 used `TBI_S8_ARTIFACTS` pointing at the
release home.

**G-4: FU-11-1 does not close the Sprint 11 `s8-deployed-policy` 5/7 on staging.** The staging
store already holds `5f177cbe…` (TbiGpioProof) as a *managed* artifact (manifest from a Sprint 8
upload, 2026-10-04), so it is not a global reference image and fresh users cannot lease it
(400 `ticket`). FU-11-1 skips images already present. Same result as Sprint 11 (dev-lab holds it as a
reference: 7/7 there). Not changed by hand. Proposed fix: FU-11-1 converts a pinned image present
with a manifest into a reference image (removes the manifest), or the test leases its own build.

**G-5: compatibility (T-E2E-4) against the Sprint 11 host.** The S12 frontend against the S11 host
(staging before B1) fails explicitly and fail-closed (no QEMU started), but with
`invalid_attachment`, "A connected ESP32 pin cannot be used in the simulator", not
`unsupported_component` naming U2: the S11 host passes unknown part types to its engine, which
rejects the pad attachment. Not fixable in the deployed S11 host; avoided by deploying the host
before the frontend (the Gate C order).

**G-6: `s12-parts` is not a real-QEMU spec.** No browser spec ran the S12 examples on real QEMU; added
`app/e2e/s12-real.spec.ts` (`c4c5b4b`, local), used for the B1 refusal case. Its Runtime v2 cases
are part of B6, not yet run.

**G-7: R-MCU-1 needed a stressed boot window.** The gate had no stressed boot-window configuration,
so "30 stressed boot runs" was not runnable. Added (`c4c5b4b`, local); 2/2 and the B4a 3/3 match
the boot pin.

## Local commits awaiting push authorization

`c4c5b4b` (s12-real spec, stressed boot window), `511044f` (G-1 re-pin, needs approval),
`42001e3` (G-2 provision fix), and this record.

## To finish Gate B after approval

B4b R-MCU-1 at 40 runs per configuration (120 full incl. 40 stressed, 40 stressed boot; ≈ 1 h),
B5 rollback rehearsal, B6 `s12-real` (3 examples) + `s11-real` + `s6-real` on staging, B7 C-5 dry
run N = 1..3, and the G-4 fix if chosen.
