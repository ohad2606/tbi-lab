# Sprint 17C (DEV) — R4 Runtime v3, PWM / SG90, gates and live DEV acceptance

**Status: R4-B BLOCKED by O-R4-1 (documented gate); no DEV-Lab deployment. Engineering fixes
committed on `sprint-15-r4` (PR #7, draft, not merged).** DEV-Lab keeps serving RC4
`71c4ce773f765c107852fe1a222cc17f446779f7` with Runtime v2 `b5b34b49cb7e4049`. Alpha not
contacted or modified. Host verified: `tbi-lab-srv`.

## 1. Baseline (Phase 0), verified 2026-10-19

| Item | Verified value |
|---|---|
| Branch / PR | `sprint-15-r4` at `d51449e` = PR #7 head (draft, "do not merge"), CI 3/3 on it |
| Merged in | `origin/sprint-13` = `6c30385` (RC4 final: PR #11 launcher fix `71c4ce7` + docs PR #12) → merge `231e866`, no conflict |
| Runtime v3 | `2cb1406f94f52e4f` recomputed from `versions.env` (QEMU `40edccac`) + patches 0001–0010 of the branch; patch hashes equal `runtime.json`; capabilities `i2c,pad-func,pwm,sched-input`; binary sha256 `17c42489…` in `~/tbi-s15-rt/qemu-2cb1406f94f52e4f` |
| Firmware | all 17 images of `artifacts.lock.json` present in `~/tbi-s15-rt/artifacts`, each hash-verified (18 after TbiPwmApb below) |
| DEV-Lab | `services/current` and `dev-lab/current` → `71c4ce7…`; `tbi-qemu@` binds Runtime v2 `b5b34b49cb7e4049`; `/health` commit `71c4ce7…`, 0 sessions |
| Rollback kept | RC4 snapshot `~/tbi-r4-17c/devlab-rc4-snapshot-20261019T142619Z` (links, unit files, hashes) plus the Sprint 16E backup and its rehearsed rollback to `7e04c4d` |
| Headroom | 1 vCPU (A1), 3.7 GiB RAM (~2 GiB available), `/` 7.7 GB free, `/tmp` tmpfs 1.2 GB free |

## 2. Architecture gate (Phase 1): R4-D1 … D7 against the implementation

| Decision | Record | Implementation | Agreement |
|---|---|---|---|
| D1 A1 averaging | two-point solve, generalised with a superposition check | as recorded; Sprint 17C adds the discrete-state check (M6) and extremes over every combination (review V1/V2) | agrees |
| D2 DEV / post-alpha | R4 not in the alpha | unchanged; nothing deployed | agrees |
| D3 servo current | none, stated | `current: null`, "not modelled"; Sprint 17C: a supply's reading names the servos on its output | agrees |
| D4 hardware fade | refused | builder `pwm_advanced`, runtime `fade` | agrees |
| D5 P/W frames | instead of one `W` per pad | as recorded | agrees |
| D6 duty 0 | refused only when a load can tell (servo signal exempt) | **changed (disagreement resolved toward the directive):** the servo is no longer exempt; duty 0 reaching anything but the board pad itself and ground is refused, and a pad wired straight to GND is refused by its own current (review V5) | the directive's "duty 0 fail-closed where not validated" overrides the old D6 exemption, which assumed how an SG90 treats a steady high |
| D7 servo thresholds | 2.0 / 0.8 V assumption | unchanged | agrees |

Directive points: exact LEDC timing (rational arithmetic, update-at-next-cycle/overflow rules);
high-speed channels only (QEMU refuses the low-speed group; since 17C the host refuses it too,
V10); every unsupported mode refused by name; time averages only for instantly-settling loads;
peaks for ratings; SG90 pulses bounded (400–2600 µs valid, 1.0–2.0 ms → 0–180°, 10 µs deadband,
600 °/s, 50 ms frame timeout); unknown servo current.

## 3. M2 and M6 (Phase 2)

| Item | Supported scenarios affected | Misleading before? | Change | Evidence |
|---|---|---|---|---|
| **M2** APB clock change applied at the next overflow; REF_TICK assumed 1 MHz | any sketch that calls `setCpuFrequencyMhz(< 80)` while an APB LEDC timer runs (no example does) | yes: up to one period of the old waveform, then a slower one shown as exact | an APB timer published with a clock other than 80 MHz is refused at once (`pwm_unsupported_mode`, `timer-apb-clock`, EN/HE) and stays refused until the timer is reset. REF_TICK stays an assumption (ESP-IDF always sets 1 MHz) | real QEMU: new pinned firmware **TbiPwmApb** `78bec973…` (built twice, identical). QEMU republishes `P 939759763 0 run 40000000 16000 8`; the tracker refuses it; frame stream identical over 2 runs (fingerprint `43dab8da…`); through the Session Host an LED on GPIO18 is refused by name after the exact 25 % average was shown |
| **M6** discrete fields from the low point | a bench supply whose current limit is reached in only one PWM phase (LED matrix: refused on ESP32 anyway) | yes: CV shown while the supply current-limits half the time; the average assumes an instant regulator | an averaged part whose mode/contact/state differs between the points is refused: the supply as `pwm_supply_limited` (EN/HE), others as `pwm_load_unsupported` | unit (engine points, 2 mA vs 100 mA limit) and Session Host tests |
| M3, M8 | — | — | preserved; their tests pass | unit, `s15-r4` real |

**Finding F-17C-1 (not R4):** after `setCpuFrequencyMhz(40)` the emulator stops making
progress within ~1.5 s (Runtime v2 **and** v3: the same TbiPwmApb image stalls on both). Users
get the existing honest `stalled` message. CPU frequency changes are not modelled; proposed as
a builder refusal (`setCpuFrequencyMhz` symbol) — not implemented.

## 4. Independent review (Phase 5)

A separate read-only agent reviewed the R4 code at `b3f24df`. No blocking finding; fixed in
`ec2b1fe`, each with a test that fails without the fix:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| V1 | major | with ≥ 3 PWM pads, peaks taken over solved points only (pair combinations missed) | extremes over every combination (superposition verified); in practice a node shared by switching pads is always refused (the pad drivers differ high/low), shown by a test |
| V2 | major | voltage ratings checked against averages | voltage ranges reported; ratings at both extremes (with peak currents), worse row kept |
| V3 | major | during the grace tick the firmware received inputs (and sensors observations) from the placeholder point | nothing is fed back while a problem is pending |
| V4 | major | servos fed edges from placeholder solves (truncated pulse could command an angle) | servos suspended; the pulse in progress is discarded |
| V5 | minor | duty 0 on a pad wired straight to GND not refused | refused (pad current) |
| V6 | minor | a servo seeing an old waveform replayed its whole history (edge bound after ~17 min) | expansion from the last cycle boundary |
| V10 | note | host trusted QEMU for the low-speed refusal | host refuses itself |
| V13 | note | Hebrew state text inside LTR cells; voltage not isolated | cells follow the locale direction; voltages isolated |
| V7 | minor | segments anchored mid-period (routing/resume) drop a partial pulse; pending latches not re-based on pause/reset | documented limitation (≤ one period, under the existing "first partial cycle" limitation) |
| V8 | minor | a boundary-latched static level reaches an input up to one tick late | documented (within the 1 ms command quantum, ADR-007) |
| V9 | note | the servo model accepts any frame rate (e.g. 1 kHz, 500 µs pulses → 0°) | documented limitation; a frame-rate bound needs a source for SG90 behaviour — proposed |
| V11 | note | solve cost per latched PWM change grows with pads (38 solves at 8 pads) | measured (§6); a per-tick cap proposed |
| S1 | suspicion | LEDC pad routed back to GPIO without a G frame | **refuted**: patch 0007 republishes the pad state on every return to simple GPIO |
| S3 | suspicion | rollback: an RC4 app cannot open a project containing a servo | **confirmed**: RC4 shows "invalid project" and leaves the stored record untouched; re-deploying R4 makes it openable again. Rollback note (§7) |
| S4/S5 | — | host/runtime pairing fails closed both ways | confirmed by existing tests; deploy and roll back as a pair |

## 5. R4-B (Phase 3)

**Gate verdict: BLOCKED.** The documented gate (R4-PROBE §7: "GO for R4-B … with O-R4-1
resolved first (one physical board measurement or an Espressif source)"; SPRINT-15-R4 §1, §11)
requires O-R4-1. No bench measurement exists and none was inferred from QEMU. Per the directive,
only independent verification was run, on an isolated loopback stack (no staging or DEV-Lab
change). Results: §6.

## 6. Verification (all on DEV, Runtime v3 `2cb1406f94f52e4f`)

Code under test: `ec2b1fe` (fixes) on `231e866` (RC4 final merged in). Suites ran one at a time
(1 vCPU: no concurrent timing-sensitive runs).

| Suite | Result |
|---|---|
| Typecheck, lint (incl. boundary check) | pass |
| Unit (vitest, all workspaces) | **1347 / 1347** (149 files) |
| Browser e2e (Chromium, fake host) | **235 passed, 0 failed, 24 skipped** (env-gated real-stack and measurement specs) |
| Real QEMU, full runtime suite, Runtime v3 | **205 passed, 0 failed, 19 skipped** (46 files, 49 min). Skipped = the 6 deployed-instance/capacity files (need an installed instance; not run against staging or DEV-Lab, by decision) |
| — within it: R4 | `s15-r4` 8/8 (incl. the 2 new M2 cases), `s15-examples` 2/2 |
| — within it: R1/R2/R3 regression and determinism | `gate` 7, `s12-determinism` 8, `r1-determinism` 2, `s12-bridge`, `s12-r2`, `s12-r3`, `s12-r2-timing`, `s12-bridge-timing`, `r2-acceptance` 5, `electrical`, `s12-pace`, `s13-pad-short`, `isolation` 5: all pass, no pin changed |
| — within it: crash/recovery | `failures` 15/15, `r2-failures` 11/11 (QEMU killed, stalled, garbage, protocol errors, guest reset, recovery) |
| Browser → real QEMU (isolated loopback stack: R4 host + build service of `ec2b1fe`, Runtime v3, state in `~/tbi-r4-17c/stack`) | **16 passed, 0 failed, 2 skipped** (old-host compatibility cases): s6 blink / input echo / product determinism, s11 R1 parts, s12 HC-SR04 / DHT22 / LCD, s13 export-import, journey EN→HE and HE→EN, live controls, **s15 LED fade (GPIO18 `wave`, average shown) and SG90 sweep (0° and 180°)** |
| Browser crash/recovery (temporary spec, local stack) | QEMU SIGKILLed during the LED fade → `runtime_crashed` shown; a fresh Run reaches PWM again; Stop clean: pass |

**Measurements (actual):**

| Quantity | Value |
|---|---|
| LEDC frequency/duty | 1 kHz REF_TICK 25/50 %, 5 kHz APB 12-bit, 50 Hz 16-bit: exact (rational equality) |
| LED dimming | published average = 0.25 × I_high exactly: 1.4384956 mA of 5.7539823 mA |
| SG90 | 1000.062 µs → 0.011°, 2000.123 µs → 180°, 1499.939 µs → 89.989° (model, within 1e-6°) |
| Determinism | PWM frame stream (27 frames) fingerprint `03e11c34…a11206` = Sprint 15's; M8 `863b124d…`; M2 `43dab8da…`; each identical over 2 runs |
| Resources, one session (real browser, local stack, 1 s sampling) | QEMU 64–74 % of the vCPU while running, RSS ≤ 78.6 MiB; Session Host 1.3 % (LED fade), 3.0 % (servo), 2.4 % (blink baseline), RSS ≤ 97 MiB; build service idle (cached builds) |
| Host cost per latched PWM change (engine, this host) | 1 pad 0.43 ms (2 solves), 2 pads 1.48 ms, 4 pads 3.85 ms, 8 pads 15.2 ms (38 solves) |

**Finding F-17C-2 (resource):** a sketch re-latching 8 LEDC channels every 1 ms cycle would cost
~15 s of host CPU per simulated second. On DEV (one owner) that only slows that session; before a
multi-user deployment a per-tick cap (refuse beyond it, by name) is needed. Proposed, not
implemented. The curated examples change one channel at most every 8 ms.

**Not run, by decision:** staging and DEV-Lab deployed suites (R4-B blocked: nothing R4 is
installed there); the C-5 capacity measurement (opt-in, multi-CPU).

## 7. Deployment (Phase 4)

Not executed: R4-B is blocked. DEV-Lab and staging unchanged (RC4 `71c4ce7`, Runtime v2).
When unblocked, the pair to deploy is the R4 host/build service of the final commit with Runtime
v3 `2cb1406f94f52e4f` (never one without the other: an RC4 host rejects v3's hello; an R4 host on
v2 refuses PWM). Rollback = RC4 links + Runtime v2 binding; projects containing a servo then do
not open (S3) until R4 returns.

## 8. Remaining approvals

1. O-R4-1 bench measurement (BENCH-PROTOCOL §4), or an explicit PM waiver keeping the duty-0
   refusal as documented behaviour — unblocks R4-B.
2. Ratification of the revised D6 (servo no longer exempt) and of M2/M6 refusals.
3. Then: R4-B on staging, R4-C (DEV-Lab) as a coordinated host + runtime pair.
