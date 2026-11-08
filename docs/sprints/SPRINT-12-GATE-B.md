# Sprint 12 — Gate B (staging) evidence

**Status (2026-10-11, Gate B final): COMPLETE: all steps pass; no release blocker.** PM "G-2 Final
Approval" executed: F-R2-2 option (a) implemented (`ba0f4a6`), G-2 closed. Evidence:
[final/](s12-evidence/gate-b/final/).

| Item | Value |
|---|---|
| Release commit (staged) | `ba0f4a6893499b8728e8c902095b19b2be48404c` (`/health` runtime.commit), branch `sprint-12` |
| Runtime | v2 `b5b34b49cb7e4049` (espressif/qemu `40edccac` + 0001–0008), capabilities `i2c,pad-func,sched-input` |
| Release artifact set | `767d3715fdaaef10`: 13 images, all reproducible from source, sha-verified |
| Staging bundles | build-job `011f703c…`, build-service `fbdc0b13…`, session-host `840bc8ae…` |
| Backups | B0 `/var/backups/tbi-lab/s12-staging-pre-gbfinal-20261011T122847Z`; switch backups `…-20261011T122938Z`, `…T135046Z`, `…T135215Z` |
| Rollback | `deploy/dev-lab/s8/switch-runtime.sh staging /home/ubuntu/tbi-s8-rt/qemu-33e35e4ac5e798d7` (rehearsed, 967 ms) |

| Step | Result |
|---|---|
| B0 | backup taken; dev-lab snapshot (before = final, identical) |
| B2 | release artifact set `767d3715fdaaef10` published (13 images); runtime v2 unchanged |
| B1 | `install.sh staging` from a clean checkout of `ba0f4a6` on v1 QEMU: bundles stamped, 13 reference images imported, `/health` = `ba0f4a6` |
| B3 | switch to Runtime v2 in **756 ms** (only `tbi-s8-build` restarted) |
| B4a | full runtime suite on staging/v2: **36/37 files, 169 pass, 0 fail, 3 skipped** (C-5 opt-in; 2 `s11-deployed` cases need an S10 host, as before). The earlier B4a failures are resolved: G-1 `r1-determinism` 2/2, G-4 `s8-deployed-policy` 7/7. Known failures reproduced as documented: F-R2-1 (s12-bridge-timing), F-R2-2 (s12-r2-timing) |
| B4b | R-MCU-1 release gate, 40 runs per configuration (6 configurations, 240 runs): **7/7**, every batch one result equal to the Runtime v2 pins |
| B5 | rollback to v1 in **967 ms**, `s11-deployed` + `s8-qemu-tasks` 8 pass / 2 skipped; forward to v2 in **808 ms**, same 8/2 |
| B6 | real-QEMU browser specs on staging (s12-real, s11-real, s6-real): **9 pass, 2 skipped** (old-host compatibility cases); product-level determinism 3/3 identical |
| B7 | C-5 (in-process host, paced, mix, 120 s): N=1 **pass** (p5 0.996×, tick-gap p99 3 ms, CPU 45 %); N=2 p5 0.87/0.94× (median 1.00×, CPU 78 %); N=3 CPU 100 %, sonar 0.80× sim/wall; tick-gap p99 ≤ 10 ms and 0 failures at every N; QEMU RSS ≈ 85 MB |
| Isolation | dev-lab units, bundles, keys, policy and processes identical before/after; staging policy byte-equal to B0; no session, relay or QEMU left |

Capacity: this 1-vCPU host meets D-2 at N = 1 only (as forecast); N ≥ 2 needs the D-1 hardware
decision. Accepted limitations: V1 timing contract (G2-FINAL.md §4).

**Status (2026-10-11, G-2 final package): STOPPED for PM acceptance.** See
[G2-FINAL.md](s12-evidence/gate-b/G2-FINAL.md): `c608cf5` pushed. Patch B applied in a local commit:
five lock re-pins (all 13 artifacts reproducible) and seven determinism pins (10/10). s12-bridge is split
per proposal 4(i). The s12-bridge-timing sweep is now a mechanism-matched KNOWN FAILURE (F-R2-1). The
EdgeEcho −9 µs is firmware polling (13.0 µs loop), not event loss. New sub-limitation: lock-holder
preemption, a 272–278 µs freeze. F-R2-2 options (a)/(b) returned; s12-r2-timing 4 m is still red.
Staging unchanged; B4b–B7 not run.

**Status (2026-10-11, G-2 round 5): STOPPED for PM acceptance.** See
[G2-ROUND5.md](s12-evidence/gate-b/G2-ROUND5.md): `630b313`, `54e9ad1`, `171fb3f` pushed
(`origin/sprint-12` = `171fb3f`). Three decision packages: the V1 timing-fidelity contract and
support matrix (F-R2-1); the +0.91 µs pulseIn exception explained (the other core's tick entry,
≈ 1.5 µs; every out-of-bound reading now attributed) and a two-tier acceptance contract (F-R2-2);
the complete Patch B (five lock re-pins, not two) against Patch A, with the release manifest.
Nothing applied; staging unchanged; B4b–B7 not run.

**Status (2026-10-11, G-2 round 4): STOPPED for PM review.** See
[G2-ROUND4.md](s12-evidence/gate-b/G2-ROUND4.md): `bd26ec5`, `8073ccc`, `211ccff` pushed
(`origin/sprint-12` = `211ccff`). F-R2-1 impact matrix measured (core 0 idle: ≈ 1–2 µs except the
≈ 10–12 µs other-core interval per ms; core 0 busy: core 1 frozen up to 0.98 ms; inter-core tick
offset delays `delay()` on core 1 by up to 477 µs). pulseIn bound derived and checked on 3 870
readings (L = 0.4534 µs; F-R2-2 inside it). Canonical images: code identical, differences are data
layout only; the +1 ms start is a tick-quantised cross-core race. Seven pins prepared as two
verified patches, not applied. Bridge-edge and firmware-visible HC-SR04 checks split. No pin or
tolerance changed; staging unchanged; B4b–B7 not run.

**Status (2026-10-11, G-2 round 3): STOPPED for PM review.** See
[G2-ROUND3.md](s12-evidence/gate-b/G2-ROUND3.md): H-1 fix pushed (`922e56b`) and its tests
(`publication.test.ts`, 13 cases) added; Sprint 11/12 regression suites pass under the fixed host;
seven replacement determinism baselines at 10 runs (old/new audited for electrical correctness,
timing fidelity and reproducibility); F-R2-1 (other core's ≈ 10.1 µs, corrected from 6.2 µs) and
F-R2-2 (pulseIn polling quantisation) investigated, with fix options. New TbiEdgeTime and
first-reading tests added; each fails on its open finding. Only TbiDht22 re-pinned. Staging
unchanged since B4a; B4b–B7 not run.

**Status (2026-10-10, G-2 round 2): STOPPED for PM acceptance.** See
[G2-EVIDENCE.md](s12-evidence/gate-b/G2-EVIDENCE.md): reproducible builds proven for all six
images; a pre-existing Session Host publication defect found (H-1, fix committed locally, not
deployed) that also invalidates the seven `s12-determinism` pins; per-image evidence and proposed
re-pins; two new R2 fidelity findings (F-R2-1, F-R2-2). Only TbiDht22 is re-pinned. Staging
unchanged since B4a; B4b–B7 not run.

**Status (2026-10-10, remediation round 1): STOPPED again for PM review at G-2.** The PM decision
of 2026-10-10 approved remediating G-1/G-2/G-4 and resuming Gate B. G-1, G-3 and G-4 pass. G-2:
the firmware builds are now reproducible (five independent builds, byte-identical), but the new
images do **not** behave identically to the pinned ones for four of six images, so the lock was
**not** re-pinned (PM condition) and Gate B was **not** resumed (B4a re-run, B4b–B7 not run).
Staging is unchanged since B4a (S12 host `c5ed6c0` on Runtime v2). Dev-lab and production are
untouched; nothing is merged or tagged; Sprints 11 and 12 stay open.

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

## Remediation round 1 (PM decision 2026-10-10)

Pushed as approved: `c4c5b4b`, `511044f`, `42001e3`, `d631c31` (origin/sprint-12 = `d631c31`).
Local, not pushed: `5617675` (G-4), `eacc248` (G-3), and this record.

### G-1 — passed

[g1-r1-determinism.md](s12-evidence/gate-b/g1-r1-determinism.md): per workload, same event count,
order and types, every `simNs` identical, all electrical events identical (9 and 8); one GPIO
window (0.89 s) keeps every v1 entry and adds pads 34/35/36/39 once — exactly the pads
`TbiBanks.ino:21` sets to INPUT (re-pin mechanism 2). 10/10 runs per workload on Runtime v2; v1
still reproduces the R1 pins. Old → new: motion `88122085bf12750f` → `5fdb6a1ad50a412a`, night
`1511138e44d4f5e4` → `5596d749c3ce4f8c`. No other fingerprint changed.

### G-2 — builds reproducible; behavioural equivalence NOT proven → stop

Reproducibility ([g2-builds.txt](s12-evidence/gate-b/g2-builds.txt)): F0 = the original clean
provisioning; F1 = fixed script, same home; F2 = symlinked home → same toolchain; F3 = symlinked
home → the independent September toolchain install (`tbi-r1-clean`, the original contamination
source); F4 = a new home with a freshly downloaded toolchain. All eight images byte-identical
across F0–F4 (the two R1 control images equal their existing pins); no image of F1–F4 contains a
host path.

| Image | Old pin (kept) | Reproducible new hash | Equivalent behaviour? |
|---|---|---|---|
| TbiDht22 | `a2e6b54c81ec…` | `1c9a0e52d98c…` | **yes**: s12-determinism 3 scenarios × 10 runs reproduce the old-image pins |
| TbiLcd | `2f70c09c14f7…` | `d8819c064115…` | **yes**: lcd1602-hello 10/10 = old-image pin |
| TbiHcSr04 | `620e06276aea…` | `9fd371b1ea77…` | **no** (3 scenarios, each 10/10 deterministic, new fingerprints `452b9156…`, `1f4bb381…`, `93a1ee6e…`). Localized ([g2-hcsr04-1m-diff.txt](s12-evidence/gate-b/g2-hcsr04-1m-diff.txt)): identical serial text (same echo `D 5823` µs), all events after 1 s identical; setup completes just after the 0.89 s publish window, so its first GPIO/serial events fall in the 0.90 s window |
| TbiEdgeEcho | `8cf4804dc1ba…` | `6ceb6ac3bb0d…` | **no**: closed-loop fingerprints differ, and `s12-bridge` edge spacing fails with the new image (8 µs > 5 µs tolerance): the firmware's polling phase against the scheduled edges shifts |
| TbiI2cProbe | `6f75261c61a6…` | `768f52b5cc6a…` | **no**: event stream differs (`fd736e87…` → `395cd764…`); not localized yet. Functional suite s12-r3 passes with the new image |
| TbiR1Scan | `5ddd712902b1…` | `b86f9c5e7d86…` | **not established**: my comparison scenario failed (the matrix is refused in ESP32 sessions; a loaded-pad variant never reached 3 s). Functional r1-matrix-perf passes with the new image |

All new images are 48–80 bytes smaller (shorter path strings), which shifts code/data layout; the
plausible mechanism is a small boot/loop timing shift that crosses a publish window or a polling
phase. That is a timing behaviour change of the test firmware, not of the runtime, but it is not
"identical behaviour", so the pins were kept (`previousSha256` re-pin reverted, uncommitted).
The provision fix (`42001e3`) is in place: from now on every build is path-independent and
reproducible; the six pinned images are the only non-reproducible ones.

**PM options:** (A) keep the six old pins (status quo; bytes preserved in the release artifact set,
tests unchanged; the images remain unreproducible from source); (B) re-pin to the reproducible
images and re-baseline: 3 HC-SR04 fingerprints (10/10 each, cause localized above), the
EdgeEcho spacing tolerance from a measured loop period (or the test firmware's polling), and an
I2cProbe/R1Scan stream comparison; (C) B for HcSr04/Dht22/Lcd now, the other three after
investigation. Recommendation: B — the old images cannot be rebuilt by anyone, which undermines the
release's provenance; the differences are confined to firmware timing in test images.

### G-3 — passed

`publish-release-artifacts.sh` published set `87e645cacf915050` (12 images, verified, root-owned,
read-only) at `/srv/tbi-lab/release-artifacts/87e645cacf915050`; a re-run only verifies. install.sh
reads only that set (no override, no runtime-home default), refuses uncommitted changes before any
change, and stamps the host. Not yet exercised by a staging install (Gate B stopped).

### G-4 — passed

Sessions in `s8-deployed-policy` use the test user's own uploaded image (normal API, own grant).
Staging: **7/7**, including both direct failures and the dependent admission-events case. The
authorization checks inside the suite are unchanged and pass (a non-owner lease is 404; another
user cannot see or end a session, 404).

### G-5 — tracked (TI-S12-1)

| Id | Issue | Status |
|---|---|---|
| TI-S12-1 | S12 frontend → S11 host: Run of an R2/R3 project fails with `invalid_attachment` ("A connected ESP32 pin cannot be used in the simulator") instead of `unsupported_component` naming the part; the S11 host passes unknown part types to its engine | Open, compatibility/UX. Non-blocking while the failure stays explicit and no QEMU starts (verified: none started). Mitigation: host before frontend (Gate C order) |
| TI-S12-2 | Six pinned test firmware images not reproducible from source (G-2) | Open, PM decision |

### Schedule forecast

Remaining Gate B after a G-2 decision: G-2 work (A: none; B: ≈ 0.5–1 day incl. EdgeEcho/I2cProbe
analysis), staging re-install from the final commit (≈ 0.5 h), B4a re-run (≈ 40 min), B4b R-MCU-1
(≈ 1.5 h), B5 (≈ 20 min), B6 (≈ 1 h), B7 (≈ 30 min): **1–2 working days**, inside the Oct 13–31
window; Gate C (dev-lab) and Owner Smoke follow separately.
