# RC5 release handoff (DEV)

Prepared on DEV (`tbi-lab-srv`), 2026-10-22. **Not an Alpha deployment authorization.** Nothing in
this document was run on Alpha. Every result is DEV evidence. The gate procedure is RC4's
(`docs/release/RC4-RELEASE-GATES.md` v5), applied to RC5; the Alpha-only gates are listed in §12.

## 1. Release identity

| | |
|---|---|
| **RC5 source commit** | **see §3 (the final commit of branch `rc5-release`)** |
| Base | `origin/sprint-15-r4` `c164cbe` = PR #7 head (R4 + 18F), which contains `origin/sprint-13` `6c30385` (RC4 `71c4ce7` + its docs) |
| RC5 commits on top of PR #7 | `467698e` RC5 profiles; `e828324` independent-review fixes (PWM pad ratings at both points, SG90 frame rate, core seed kept across restarts); `8db77d7` capacity workload mix with the R4 paths (test only); `d17cd21` s13-journey test timeout (test only); `04c8fbb` capacity harness: the rotation bound uses the run's N (test only); this handoff (docs) |
| Composition | RC4 + R4 (ESP32 LEDC PWM, LED dimming, TowerPro SG90, Runtime v3) + 18F (SG90 3D motion; Arduino core seed and curated prewarm) + the review fixes above. **Active Minutes absent. No Exploration Foundation (Sprint 19B) feature**: no logic gates, MicroPython, Runtime v4, time kernel or resistor power series (verified by search of the tree and by the independent ancestry review, §11) |
| Previous release (rollback target on Alpha) | RC4 `71c4ce773f765c107852fe1a222cc17f446779f7` on Runtime v2 `b5b34b49cb7e4049` |
| Runtime | **v3 `2cb1406f94f52e4f`** (§4); release artifacts `ff0ea83b43e6c57d` (§5) |
| Tools | Node `v24.21.0`, npm `11.19.0` (pinned in both profiles) |

## 2. Release configuration

Two profiles, `deploy/release/rc5.release.json` (**default: problem reports OFF**) and
`rc5-reports.release.json` (reports ON, as Alpha runs RC4). A unit test proves each RC5 profile
equals its RC4 counterpart except the release name and the exclusion note
(`deploy/release/tests/release-config.test.mjs`). Settings, exclusions and their meaning are as in
the RC4 handoff §2.

## 3. Packages and reproducibility (gate G2 on DEV)

`deploy/release/verify-on-packaging-host.sh <commit> <work>` (defaults to the RC5 profiles): each
profile built twice from clean worktrees at the commit's committer time, `env -i`, empty npm configs.

*(pending: the final commit's manifests; recorded in §13)*

## 4. Runtime v3 provenance

| Item | Value |
|---|---|
| Runtime id | `2cb1406f94f52e4f` = sha256(QEMU commit + the sha256 of each patch 0001–0010), first 16 hex; **recomputed from the RC5 tree: identical** |
| Upstream | `https://github.com/espressif/qemu.git`, tag `esp-develop-9.2.2-20260417`, commit `40edccac415693c5130f91c01d84176ae6008566` |
| Patches | `runtime/qemu/patches/0001…0010` (sha256 prefixes `7fc84611`, `a29bf7bf`, `ee3fa808`, `f01a24f7`, `40a7f984`, `0e1b69c7`, `21706596`, `957d9d9d`, `c072c53a`, `f7bc33cc`), recorded in the runtime's `runtime.json` |
| Capabilities | `i2c`, `pad-func`, `pwm`, `sched-input` |
| Release build | `runtime/provision/provision.sh qemu` in the clean home `~/tbi-s18-rt-release` (Sprint 18, 2026-10-20 06:32 UTC); logs `logs/qemu-{configure,build,install}-2cb1406f94f52e4f.log` |
| Binary | `bin/qemu-system-xtensa` sha256 **`c9610d7353c40e078dca2ccf939713c148e76e1d9c48924024e47284b4aa8bb1`**, 22 501 424 bytes |
| Reproducibility | the **runtime id** is reproducible from source; the **binary is not bit-reproducible** across builds (F-18-1, open). The deployed binary is therefore identified by its sha256 above, and Alpha must install exactly this build (or build its own and record its sha256 before testing) |

## 5. Firmware artifact manifest

`runtime/firmware/artifacts.lock.json` (sha256 prefix **`ff0ea83b43e6c57d`**), unchanged since R4:
18 pinned images, each by sha256, published as the immutable set
`/srv/tbi-lab/release-artifacts/ff0ea83b43e6c57d` (`deploy/dev-lab/s8/publish-release-artifacts.sh`).
`install.sh` imports each into the instance's store only after verifying its sha256. The set
includes the R1 reference image `TbiGpioProof` `5f177cbe…` and the R4 images `TbiPwm` `ecd8d690…`,
`TbiPwmLs` `027b9a12…`, `TbiServo` `5d4697ac…`, `TbiPwmInv` `4b6de26f…`, `TbiPwmApb` `78bec973…`.
(The `micropython` entry is a test interpreter image used by runtime tests; no product path in RC5
offers MicroPython.)

## 6. Verification matrix (DEV, on `e828324`; `8db77d7` adds a test-only change)

Initial results and clean final verification are reported separately. Skips are listed, never
counted as passes.

| Area | Initial run (one sequential chain, host shared with other work) | Clean verification |
|---|---|---|
| Typecheck, lint (format, boundaries) | pass | — |
| Unit (`vitest`) | **1379 / 1379** | — |
| Browser e2e (fakes, Chromium) | **236 passed, 0 failed, 33 skipped** (the env-gated real-stack specs, run on staging in §7) | — |
| Real QEMU, Runtime v3 release binary (`test:runtime`, 47 files) | 196 passed, **10 failed**, 19 skipped. 4 failures: the staging-instance suite ran against staging while it served a different release (§7 runs them on RC5). 6 failures: timing tests while the single CPU was loaded by unrelated work | `s12-r2-timing` 9/9, `failures` 15/15, `r2-failures` 10/10 + the resource measurement 1/1 (1 session: 11.2 s wall per 10 s simulated; 2 concurrent: 22.1 s), each alone on a quiet host |
| `test:esp32` (Sprint 1–2 experiment harness) | 19 passed, 1 failed: **F2** (known since RC4: the closed-loop test refuses its pinned flash image because the Gate C tests overwrite that shared file) | the closed-loop test alone with a pristine copy (sha `d069fffc…`): **1/1** |
| Reproducibility (G2) | `e828324`: both profiles byte-identical twice (`rc5` `2fd65f24e6dcd05d`, `rc5-reports` `e0f3b2edd848b166`) | final commit: §13 |

## 7. Staging (`tbi-s8`, the RC5 commit installed, Runtime v3)

| Step | Result |
|---|---|
| Install | `install.sh staging` from the clean RC5 worktree, `TBI_S8_RUNTIME` = the v3 release prefix; 5.9 s; `/health` reports the commit; build profiles: Arduino only |
| DEV-Lab during staging | unit, rule, key, policy and link hashes identical before and after |
| Deployed suites | **31 passed, 2 skipped** (s8-containment 9/9, s8-policy 7/7, s8-qemu-tasks 2/2, s11-deployed 6 + 2 old-host skips, s8-deployed-policy 7/7) and s13-deployed-security 1/1; staging policy restored byte-equal |
| Browser → real QEMU (RC4 set + R4/18F set, 25 tests) | first run **19 passed, 4 failed, 2 skipped**: the 4 failures were admission refusals of the single test identity (`session-create` `rate_limited`: 20 creations per 10 min in the preview plan; then `session_quota`), not product faults; clean redo in six batches 11 min apart (14:36–15:41, `8db77d7`): **28 passed, 0 failed, 2 skipped** (s6, s11, s12, s13-export/journey/live/staging, s15-r4, s18-r4b incl. duty 0 EN/HE, crash and Session Host restart recovery, s18f servo 3D and build) |
| Capacity (§10) | `capacity-acceptance.sh tbi-s8 … smoke` on `04c8fbb`: see §10 |
| Rollback rehearsal RC5 → RC4 → RC5 | staging backed up first (tgz sha256 `7c90a94a…`). **RC5 → RC4** (`71c4ce7`, Runtime v2 `b5b34b49cb7e4049`): install 3.5 s, ready +1.2 s, `/health` = `71c4ce7`, `s8-qemu-tasks` + `s8-deployed-policy` 9/9. **RC4 → RC5** (`04c8fbb`, v3 `2cb1406f94f52e4f`): install 2.7 s, ready +1.1 s, `/health` = `04c8fbb`, 9/9. DEV-Lab hashes identical before and after (`~/tbi-s19c/rc5-drill/`) |

## 7a. R4 owner-acceptance evidence

- The owner's manual acceptance of R4 on DEV-Lab (`b7da1c1`, Runtime v3, 2026-10-20) found two
  blockers: build time over 30 s, and the SG90 horn not moving in 3D. Both were fixed in 18F
  (`b59ee50`) and accepted through DEV-Lab deployment with an owner checklist
  (`docs/sprints/SPRINT-18F.md`, §4 and the owner checklist).
- RC5 = that code + the review fixes of §1. **The owner's written sign-off of R4 is not recorded in
  the repository: the PM confirms it** (§12).

## 8. Duty-0 fail-closed decision and tests

- Decision: the Sprint 18 directive ("preserve the strict Duty-0 refusal until physical evidence
  becomes available"), recorded in `docs/sprints/SPRINT-18-R4.md` §2 as the resolution of the
  R4-PROBE gate; O-R4-1 (what a real ESP32 outputs at duty 0) stays open: no bench measurement.
- Behaviour: duty 0 driving a load (an LED, a servo signal, a pad wired to GND) for a whole tick is
  refused by name, `pwm_duty_zero_unverified`; the attach-time duty 0 that the firmware replaces
  before its first cycle never takes effect.
- Tests: `runtime/host/tests/r4-pwm.test.ts` (refused after a whole tick; replaced before its cycle;
  review V5, pad to GND), `r4-servo.test.ts` (servo signal at duty 0 refused, naming the servo;
  replaced before its cycle), `pwm.test.ts`; real stack `app/e2e/s18-r4b-real.spec.ts` ("duty 0 into
  an LED is refused, named, in English and then in Hebrew").

## 9. Runtime-version mismatch refusals

| Case | Behaviour | Evidence |
|---|---|---|
| An artifact that requires `pwm` on a runtime without it (v2) | never starts: refused at the hello, before the firmware runs | `bridge-v2.test.ts` (requires), `r4-servo.test.ts` ("a servo on a runtime without pwm is refused, named, before the firmware runs") |
| A runtime announcing an unknown capability or protocol (e.g. v4 `unmodelled` to an RC5 host) | fails closed (`host_protocol_error`) | `bridge-v2.test.ts` ("an unknown capability or protocol version from the runtime fails closed") |
| A frame of a capability the runtime did not announce | fails closed | `bridge-v2.test.ts` (F/B frames), `harness/protocol` (P/W without pwm) |
| LEDC on a runtime without `pwm` | a refused peripheral (Runtime v2 rule) | `r4-pwm.test.ts` |
| The build service and its runtime disagree | the build service reads the runtime's capabilities from `runtime.json` (`/etc/<N>/runtime.json`, installed with the runtime); PWM sketches build with `requires: pwm` only when the runtime has it, else they are refused at Build | `features.test.ts` T-R4-6 |
| Host and runtime always move together | `switch-runtime.sh` (one command per instance) and the rollback of §11 move both | §11 |

## 10. Six-session Alpha workload harness, capacity and abort criteria

- Harness: `runtime/tests/c5-deployed.runtime.test.ts` via the one-command procedure
  `deploy/dev-lab/s8/capacity-acceptance.sh <instance> <evidence dir> [quick|smoke]` (preflight;
  ramp N = 1…6; faults at N = 5; 2 h soak at N = 5 with build bursts and session rotation; summary).
- RC5 workload mix (six slots, one of each per six-session run): HC-SR04 sonar (R2), **LED fade
  (R4 LEDC PWM)**, DHT22 (R2), **SG90 servo sweep (R4)**, GPIO blink (R1), I2C LCD (R3), the product's
  own curated sketches for the R4 slots. `TBI_C5_MIX=rc4` reproduces the RC4 mix.
- Pass criteria (PM D-2, unchanged): every session's pacing p5 ≥ 0.995× over 5 s windows after a
  30 s warm-up; tick-gap p99 ≤ 100 ms; no session fails; builds: all succeed, worst completion
  ≤ 120 s; isolation under load holds; faults reported and recovered; nothing left behind.
- **Abort criteria** (stop the run and do not release): any session failure other than an injected
  fault; host memory available < 15 %; any QEMU unit at its `MemoryMax`; a live session not
  released 60 s after its end; a build failure other than the harness's own invalid input; the
  host's Session Host or build service restarting; DEV-Lab/Alpha users affected. The procedure's
  preflight refuses a busy instance.
- DEV measurement (staging, 1 vCPU, `smoke`, `04c8fbb`; the policy admits one live session here):
  - ramp N = 1: **PASS** (worst build 10.2 s; pacing p5 0.9998; tick-gap p99 4 ms; nothing left).
  - ramp N = 2 and faults N = 2: admitted 1/2, the second **refused by the policy** as designed;
    every other criterion passed, faults recovered.
  - soak N = 1 (180 s, one rotation): sessions, pacing, rotation (gap 457 ms, clean), isolation and
    leftovers **pass**; the two mid-soak builds **fail by design**: with
    `deferWhileLiveSessionsAtLeast = cpus` (= 1 here) no build starts while a session is live, and a
    build that waits longer than `maxQueueWaitMs` (600 s) ends `capacity_timeout`
    (`runtime/builder/service.ts` `pump`). On Alpha's 6-CPU host at N = 5 this condition does not
    arise; the full soak there is what decides it.
  - Found and fixed on the way (test only, `04c8fbb`): the harness's rotation bound assumed N = 5,
    so `smoke` (N = 1) could never run its soak. First run kept as evidence.
  - Six concurrent sessions cannot be measured on DEV; that measurement is Alpha's.

## 11. Installation, switch and rollback (Alpha operators)

Nothing here is authorized yet beyond packaging; each deployment step needs the PM's written go.
RC5 differs from RC4 operationally in one point: **the Session Host and the runtime move together**
(RC5's host on Runtime v3; RC4's host on v2). An RC4 host rejects v3's hello; an RC5 host on v2
refuses PWM and servos by name. Both directions are one maintenance window.

1. **Source.** Bring the RC5 commit to the Alpha clone (a git bundle `6c30385..rc5-release`, as
   for RC4); `git rev-parse rc5-release` must print the commit of §13.
2. **Runtime v3.** On the Alpha packaging host: `runtime/provision/provision.sh qemu` in a clean
   runtime home. The printed runtime id must be **`2cb1406f94f52e4f`** (§4); record the binary's
   sha256 (QEMU builds are not bit-reproducible). Then
   `deploy/dev-lab/s8/publish-release-artifacts.sh <runtime home>` publishes the firmware set
   **`ff0ea83b43e6c57d`** (§5).
3. **Packages (G2).** `deploy/release/verify-on-packaging-host.sh <commit> <work>`: both RC5
   profiles twice, byte-identical, verdict PASS. Alpha's package build uses
   `deploy/release/build-package.sh deploy/release/rc5-reports.release.json …` (reports ON, as Alpha
   runs RC4) or `rc5.release.json` (OFF).
4. **Staging on Alpha** (its A15 overlay) with the RC5 package and Runtime v3: deployed suites, the
   real-stack browser gate (in batches, or with distinct synthetic identities: the per-user rate
   limit), the capacity procedure of §10 at N = 1…6.
5. **Switch (one window, 0 live sessions):** backup (units, polkit rule, policy, runtime.json,
   links) → services (`session-host.mjs`, `build-service.mjs`, `build-job.mjs` from the package) →
   frontend → `deploy/dev-lab/s8/switch-runtime.sh <instance> <v3 prefix>` (re-renders the QEMU
   unit, installs `runtime.json`, restarts the build service) → restart the Session Host →
   `/health` and `/version.json` = the RC5 commit; `runtime.json` capabilities include `pwm` →
   deployed suites → an R4 smoke (LED fade, servo sweep).
6. **Rollback (rehearsed on DEV staging, §7):** RC4 package + `switch-runtime.sh <instance> <v2
   prefix b5b34b49cb7e4049>` + Session Host restart, in one window. **Data compatibility:** a project
   that contains an **SG90 servo** does not open in RC4 (RC4 does not know the part: `unknown_type`;
   both releases use project schema 3, so RC4 cannot call it "newer"). The project is not lost: it
   stays in the browser and opens again after returning to RC5. Projects using PWM only through
   existing parts (an LED on `analogWrite`) open in RC4 unchanged; there PWM is refused at Build.
7. Return to DEV: G2 result, manifest hashes, runtime id and binary sha256, capacity summary.

## 12. Gates and what is left for Alpha

| Gate | Status on DEV | Left for Alpha |
|---|---|---|
| G1 source identity | the RC5 commit (§13); PR #7 + ancestry independently reviewed (§14) | the release-branch merge after the PM's approval |
| G2 reproducibility | PASS on DEV (§6, §13) | PASS on the Alpha packaging host |
| G3 switches pinned | RC5 profiles = RC4's (test) | Alpha's build script points at the RC5 profile |
| G4 content checks | every package's `verify-build.log` and `check-dist.log` pass | repeat on Alpha's packages |
| G5 regression | §6 (initial and clean results) and §7 | Alpha staging |
| G6 security | deployed security suite on staging 1/1 (§7) | gate checks 93/96, live Caddyfile hash, diff secret scan |
| G7 privacy | unchanged since RC4 (no report, rate or retention change) | — |
| G8 rollback | RC5 → RC4 → RC5 rehearsed on staging (§7) | Alpha's switch/rollback scripts for RC5 (runtime moves with the host) |
| G9 idle + window | — | at switch time |
| R4 owner acceptance | §7a | **the PM confirms the owner's sign-off** |
| Capacity | §10 (DEV: 1 vCPU) | **six-session measurement on Alpha** |

## 13. Final commit, package manifests

| | |
|---|---|
| **Package source commit** | **`84f4691db1303623de06cea273e09adfef2a449e`** (the packages stamp this commit; build time = its committer time `2026-10-22T16:12:04Z`) |
| Branch head | `rc5-release` = the commit that adds this section on top of `84f4691`: **docs only** (this file), so it changes no package. As for RC4 (`71c4ce7` packages, `6c30385` docs head) |
| G2 on DEV | `verify-on-packaging-host.sh 84f4691`: **PASS**. `rc5` manifest **`187c609670782cd7`**, `rc5-reports` manifest **`043c035697dbb468`**: 26 files each (8 source maps), byte-identical across two clean builds per profile. Node `v24.21.0`, npm `11.19.0`, 1 CPU |
| G4 on DEV | each package: `verify-build.log` "all checks passed: 84f4691…"; `check-dist.log` "21 assets, profile … confirmed" |
| Manifests differ from `e828324`'s | expected: the commit and build time are stamped into the packages |
| Staging | `04c8fbb` installed (the services are identical at `84f4691`: it adds docs only) |
| Runtime / firmware | v3 `2cb1406f94f52e4f`, binary sha256 `c9610d73…` (§4); artifacts `ff0ea83b43e6c57d` (§5) |
| DEV evidence | `~/tbi-s19c/rc5-g2-final/` (packages and `G2-RESULT.txt`; its header still reads "RC4 G2 packaging-host verification": a label in the script, cosmetic) |

## 14. Independent review of PR #7 and its ancestry

Two independent read-only reviews of `origin/sprint-13..rc5-release` (2026-10-22): one of the
runtime path (QEMU patches 0009/0010, harness, host PWM/servo/session), one of the builder, app,
packages, deploy and the ancestry. **No blockers in either.**

| Item | Finding | Disposition |
|---|---|---|
| Ancestry | `origin/sprint-13` `6c30385` is the merge-base; `71c4ce7..6c30385` docs only; of the 53 files RC4 touched since R4 forked, the 11 changed by the delta are additive R4 integration; RC4's runtime-exit fix untouched; problem reports and packaging scripts unchanged; **no Exploration Foundation code** | clean |
| Should-fix (app) | PWM pad rating checked only the higher-current point, so a sink (or GPIO16/17 source) over its limit at the other point was not reported | **fixed** `e828324` (both points, each in its own mode; tests) |
| Should-fix (runtime) | an SG90 accepted any frame up to 50 ms, so it moved for non-servo PWM (e.g. 1 kHz `analogWrite`) | **fixed** `e828324`: frames under 18 ms → warning `servo_frame_unsupported` (EN/HE), the servo holds |
| Builder M1 | every builder start deleted the current core seed (cold first build after each restart) | **fixed** `e828324` (only interrupted harvests removed) |
| Runtime M1 | a LEDC timer reset/pause does not re-anchor already pending channel latches (a latch can land mid-period) | open, minor; documented |
| Runtime M2 | `onSerial` closes windows without `advancePwm` (effect < 1 tick) | open, minor |
| Runtime M3 | a timer resolution outside 1..20 can send a duty the harness rejects: fails closed as `host_protocol_error`, unnamed | open, minor (fail-closed) |
| Runtime M4 | guest-visible LEDC registers (TIMER_VALUE, DUTY_R, reset value) not cycle-exact | open, minor (harmless with IDF/Arduino) |
| Runtime M5–M7 | transitions at an overflow between frames applied up to one tick late; grace-tick refusal checked at tick instants only; LEDC firmware without `features` runs up to one tick before `unsupported_feature` | open, minor (all fail-closed or < 1 tick) |
| Builder M2–M3 | concurrent curated harvests (needs > 1 active build); prewarm can precede a user in the FIFO | open, cost only |
| Host M4 (cross-check) | R4's try/catch around the final `flushWindow` | covered by the recovery tests in §7 (QEMU killed, Session Host restarted) |

**Request:** with this review, the RC5 gates on DEV (§12) and the PM's confirmation of the R4
owner sign-off (§7a), PR #7 and `rc5-release` can be proposed for merge. **Nothing is merged and
nothing is deployed to Alpha by this handoff.**

## 15. Release closure evidence (DEV, 2026-10-22 evening) and GO / NO-GO

Evidence directory on DEV: `~/tbi-s19d/` (one file per check; not in the repository).

### 15.1 Identity and lineage (re-verified)

| Item | Value |
|---|---|
| Package source | `84f4691` (tree `66ae3d4f…`); packages `rc5` `187c609670782cd7`, `rc5-reports` `043c035697dbb468` |
| Handoff head | `bb4e8ca` = `84f4691` + this document only (and this section's commit, docs only) |
| `origin/rc5-release` | `bb4e8ca` before this section |
| Separation from DEV-Lab | DEV-Lab serves the routing line `fae6a3c` (Runtime v4 `cd778dc17d8edcdd`). `fae6a3c` is not in RC5 and no RC5 commit is in `fae6a3c`. **No routing or Exploration evidence is used for RC5, and no RC5 evidence for the routing line** |
| Runtimes | v3 `2cb1406f94f52e4f` binary `c9610d73…` (RC5); v2 `b5b34b49cb7e4049` binary `b3d1108b…` (RC4, rollback); v4 `cd778dc1…` binary `202a5537…` (DEV-Lab only) |

### 15.2 Handoff artifacts (`~/rc5-release-handoff-20261022`)

- `SHA256SUMS`: 81 files, all OK. Bundle verifies; applied to a clone holding only `sprint-13`
  `6c30385`: `rc5-release` = `bb4e8ca`, `git fsck` clean, `84f4691` tree identical.
- Both packages: every file matches its `MANIFEST.sha256`; `COMMIT` = `84f4691`; profiles `rc5`
  (reports OFF) / `rc5-reports` (ON); profile test 13/13 (RC5 = RC4 settings except name and note).
- Firmware: lock `ff0ea83b43e6c57d`; the 18 published images in
  `/srv/tbi-lab/release-artifacts/ff0ea83b43e6c57d` all match their pinned sha256.
- G2 reproducibility and G4 content: §13 (PASS on DEV).

### 15.3 `s8-policy` cold-build scenario on the RC5 package (resolved on RC5)

On the 19B/routing line the suite failed because every service start deleted the Arduino core seed
and prewarm then ran a cold 34–60 s build on the single worker (review finding builder M1); the
suite restarts the services and its builds were refused `builder_busy`. RC5 contains the fix
(`e828324`). Reproduced against the **RC5 package bytes** on staging (bundles byte-equal to the
package: session-host `c00a0108…`, build-service `93f05c8e…`, build-job `011f703c…`, Runtime v3):

| Run | Result | Prewarm after each of the suite's restarts |
|---|---|---|
| 1 (21:18) | **7 / 7 passed** | `built: 0` ×4 (seed kept, no cold build) |
| 2 (21:30, after the 10-min rate window) | **7 / 7 passed** | `built: 0` ×3 |

Not a blocker for RC5. (On the routing line it stays a known, pre-existing issue until that line
takes the fix.)

### 15.4 Rollback compatibility of R4 projects (RC5 → RC4 → RC5), real browsers

Three phases, the same IndexedDB records carried between real builds (spec and dumps in
`~/tbi-s19d/a6/`):

1. RC5 (`84f4691`) opens the Servo Sweep example; the stored record contains `component.servo_sg90`.
2. RC4 (`71c4ce7`) with exactly those records: the library lists the project; **Open is refused**;
   Duplicate is refused (no copy created); creating and saving another project and reloading leave
   the servo record and its index entry **byte-identical**. Nothing is rewritten or discarded.
3. RC5 with the records as RC4 left them: opens in the editor, no notice; components, connections
   and revision unchanged.

**Defect (rollback wording):** RC4 says *"This project is damaged and cannot be opened. Your other
projects are not affected."* (HE: "הפרויקט פגום…"). The project is not damaged; the wording invites
the user to delete it, and Delete remains available. RC4 is the frozen rollback target, so this is
handled in the procedure (§15.6 step R3), not by changing RC4. Exported `.tbilab` files with a
servo are likewise refused by RC4's import; the file itself is never changed.

### 15.5 Alpha-only gates: exact status (none is passed by DEV evidence)

| Gate | DEV evidence (does not pass the gate) | Alpha status |
|---|---|---|
| G1 source identity | `rc5-release` `bb4e8ca`, package `84f4691`, PR #7 + ancestry reviewed (§14) | **open**: release-branch merge after PM approval; required CI |
| G2 reproducibility | PASS on DEV (§13) | **open**: run on the Alpha packaging host (A1/A2 copies) |
| G3 switches | RC5 profiles = RC4's (test) | **open**: Alpha's `build-package-alpha.sh` must point at the RC5 profile |
| G4 content | pass on DEV | **open**: repeat on Alpha's packages |
| G5 regression | §6, §7 | **open**: Alpha staging |
| G6 security | staging security suite 1/1 | **open**: gate checks (93), preview checks (96), live Caddyfile hash, secret scan |
| G7 privacy | unchanged since RC4 | no change |
| G8 rollback | RC5 → RC4 → RC5 on DEV staging (§7); data compatibility §15.4 | **open**: RC5 switch/rollback scripts for Alpha do not exist yet. RC4's `rc4-switch.sh`/`rc4-rollback.sh` move services and frontend only; RC5 must also move the runtime (`switch-runtime.sh`, v2 ↔ v3) in the same window |
| G9 idle + window | — | **open**: at switch time |
| A4 runtime | v3 provenance §4 | **open**: provision v3 on Alpha (id must be `2cb1406f94f52e4f`), record the binary sha256 |
| A6 capacity / concurrency | 1-CPU staging smoke only (§10): N = 1 pass; N = 2 refused by policy; rotation clean | **open**: N = 1…6 ramp, faults at N = 5, 2 h soak on the 6-CPU host. Note: Alpha's policy defers builds at `cpus` = 6 live sessions, so at N = 6 builds wait by design |
| A12 readiness check | — | **open**: Alpha's `rc4-readiness-check.sh` is RC4-specific; an RC5 version (runtime id, `pwm` capability) is needed |
| A15 staging isolation | RC5 changes no deploy template, unit or polkit rule since RC4 (`git diff 71c4ce7 84f4691 -- deploy/dev-lab/s8` empty), so the overlay's shape preflight sees RC4's templates | **open**: real-polkit `pkcheck` matrix on Alpha before any smoke |
| Session lifecycle | policy lifetime 30 min, QEMU `RuntimeMaxSec=1900`; rotation and crash/restart recovery pass on DEV (§7, §10) | **open**: soak on Alpha |
| CPU / memory limits | per QEMU unit `MemoryMax=384M`, `CPUQuota=100%`, `TasksMax=80`; per build job `1G`, `80%`; services `512M` each; policy `minAvailableMemoryMb 256` | **open**: worst case on Alpha (6 × 384 MiB + 2 × 1 GiB + 2 × 512 MiB) against its memory, measured in the soak |
| Concurrent builds | DEV runs `maxActive` 1, so builder finding M2 (two curated seed harvests at once) cannot occur on DEV | **open**: Alpha runs `maxActive: 2`; M2 is reachable there (outcome per review: cold-build fallback or incremental recompile, output correct). Watch for it in the Alpha burst/soak |
| R4 owner acceptance | §7a | **open**: the PM confirms the owner's sign-off |

### 15.6 Exact deployment and rollback procedure (Alpha; each step needs the PM's written go)

Deployment:
1. Transfer: bundle + packages + `SHA256SUMS` from `~/rc5-release-handoff-20261022`; verify
   `sha256sum -c SHA256SUMS`; `git fetch <bundle> rc5-release:rc5-release`; `rev-parse` = `bb4e8ca`;
   package `COMMIT` = `84f4691`.
2. Runtime v3: `runtime/provision/provision.sh qemu` in a clean runtime home → id `2cb1406f94f52e4f`;
   record the binary sha256. `publish-release-artifacts.sh <home>` → set `ff0ea83b43e6c57d`.
3. G2/G4 on the Alpha packaging host for the chosen profile (`rc5-reports` = Alpha's current
   reports-ON configuration, or `rc5`).
4. Alpha staging with the A15 overlay: RC5 package + v3; `pkcheck` matrix; deployed suites; real-stack
   browser gate (rate-respecting batches); capacity N = 1…6, faults, soak.
5. Write and review the RC5 switch/rollback scripts (G8) and the RC5 readiness check (A12).
6. Window (0 live sessions, G9): backup (units, polkit rule, policy, `runtime.json`, links, Caddyfile
   hash) → services from the package → frontend → `switch-runtime.sh <instance> <v3 prefix>` →
   restart the Session Host → `/health` and `/version.json` = `84f4691`; `runtime.json` capabilities
   include `pwm` → deployed suites → R4 smoke (LED fade, servo sweep) → readiness check.

Rollback (one window, 0 live sessions):
- R1. RC4 package links (`71c4ce7`) + `switch-runtime.sh <instance> <v2 prefix b5b34b49cb7e4049>` +
  Session Host and build service restart; `/health` = `71c4ce7`; `runtime.json` without `pwm`;
  deployed suites; readiness check (RC4 version).
- R2. Data: nothing to migrate. Projects stay in each tester's browser untouched (§15.4).
- R3. **Before** the rollback window, tell testers: projects containing an SG90 servo will show
  "damaged" in RC4 but are not damaged; **do not delete them**; they open again after RC5 returns.
- R4. Forward again = deployment step 6 from the same backup set.

### 15.7 Recommendation for PM review

**GO for Alpha staging validation (deployment steps 1–5).** On DEV every RC5 gate that DEV can run
has passed on the exact package, the cold-build blocker is resolved on RC5, artifacts and lineage
verify, and rollback preserves data.

**NO-GO for the Alpha production switch (step 6) today.** Open before it: the PM's confirmation of
the R4 owner sign-off; the Alpha-only gates of §15.5 (G1 merge, G2/G4 on Alpha, G6, A4, A6 six-session
capacity, A12, A15, G8 RC5 switch/rollback scripts that move the runtime with the host); the tester
notice of R3. None of these can be passed with DEV evidence.
