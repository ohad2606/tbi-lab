# RC5 release handoff (DEV)

Prepared on DEV (`tbi-lab-srv`), 2026-10-22. **Not an Alpha deployment authorization.** Nothing in
this document was run on Alpha. Every result is DEV evidence. The gate procedure is RC4's
(`docs/release/RC4-RELEASE-GATES.md` v5), applied to RC5; the Alpha-only gates are listed in §12.

## 1. Release identity

| | |
|---|---|
| **RC5 source commit** | **see §3 (the final commit of branch `rc5-release`)** |
| Base | `origin/sprint-15-r4` `c164cbe` = PR #7 head (R4 + 18F), which contains `origin/sprint-13` `6c30385` (RC4 `71c4ce7` + its docs) |
| RC5 commits on top of PR #7 | `467698e` RC5 profiles; `e828324` independent-review fixes (PWM pad ratings at both points, SG90 frame rate, core seed kept across restarts); `8db77d7` capacity workload mix with the R4 paths (test only) |
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
| Browser → real QEMU (RC4 set + R4/18F set, 25 tests) | first run **19 passed, 4 failed, 2 skipped**: the 4 failures were admission refusals of the single test identity (`session-create` `rate_limited`: 20 creations per 10 min in the preview plan; then `session_quota`), not product faults; rerun in rate-respecting batches: *(pending)* |
| Capacity (§10) | *(pending)* |
| Rollback rehearsal RC5 → RC4 → RC5 | *(pending)* |

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
- DEV measurement: *(pending: staging, 1 vCPU; the policy admits one preview session, so N ≥ 2 is
  recorded as a refusal. Six concurrent sessions cannot be measured on DEV; that measurement is
  Alpha's, on its 6-CPU host.)*

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

*(pending)*
