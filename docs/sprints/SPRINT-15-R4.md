# Sprint 15 (DEV) — R4: ESP32 LEDC PWM, LED dimming, SG90 servo

**Status: implemented on branch `sprint-15-r4` (DEV only). Not merged, not deployed.** Alpha
(Sprint 14) is untouched. Baseline: `origin/sprint-13` = `802befe` (RC2 `91f3bd0` + branding PR #6).

## 1. Readiness decision (Phase A)

| Gate (SPRINT-13-R4-ARCHITECTURE §7) | State before this sprint | Decision |
|---|---|---|
| R4-A architecture + decisions R4-D1..D4 | proposed, never recorded as approved | Taken as approved in scope by the Sprint 15 directive ("LEDC, PWM LED dimming, SG90 … smallest viable implementation") with the architecture's **recommended** options: D1 = A1 (two-point solve), D2 = DEV only / post-alpha, D4 = hardware fade refused. D3 (servo supply current) had no recommendation: **none, stated** (no number is invented). All four listed for PM ratification (§8). |
| R4-P probe | GO (`e50ea78`), with O-R4-1 to resolve before R4-B | The timing evidence the probe required is satisfied and re-verified here on the implementation (§5): the driver's register sequence is complete, `W` exact vs hand calculation, frames deterministic, non-LEDC firmware unaffected. |
| O-R4-1 (output at duty 0) | open (no bench result, no Espressif statement) | **Still open.** Searched again (2026-10-15): IDF docs give the duty range [0, 2^res] and define hpoint, an IDF example README says "0 is 0%", but no Espressif source states the output level when hpoint and hpoint + 0 coincide. Implemented as **refused when it matters**: a duty-0 output that drives anything is refused by name after a whole tick; where no load can tell the difference (only a servo signal, which sees no valid pulse either way) it runs. |
| R4-B staging Gate B on Runtime v3 | not started | **Not started (needs PM authorization).** Also blocked by O-R4-1 per the probe verdict. |

Conclusion: implementation on a DEV branch was justified (the probe's technical gate holds and
every open item is either refused or bounded); acceptance for staging/alpha is not.

## 2. Architecture as implemented (deviations from the proposal are marked ▲)

```
guest (arduino-esp32 3.3.12) ──LEDC registers──► esp32_ledc (patch 0009)
   │ timers: clock, 10.8 divider, resolution, reset, pause      │ P <vns> <timer> run|reset|paused|unsupported
   │ channels: binding, enable, idle, hpoint/duty @ duty_start   │ W <vns> <signal> idle|on|unsupported
   ▼                                                             ▼
esp32_gpio (patch 0007) ── F <vns> <pad> periph:<signal> ──► Session Host
                                                               ├─ LedcTracker: exact waveform per signal (rational ns)
                                                               ├─ A1: low / each-high / all-high solves → average + peak
                                                               ├─ ServoBank: exact pulse edges → engine Servo (SG90)
                                                               └─ refusals (pwm_unsupported) after a whole tick
```

- ▲ **Frames.** The proposal's `W vns pad period high phase` became two frames: `P` (timer) and
  `W` (channel, by GPIO-matrix signal). Reason: a timer's parameter change takes effect at its next
  overflow and a duty change at the next cycle; with timer frames the host keeps the exact phase
  across reconfigurations, and pads are joined to signals through the `F` routing the host already
  receives. QEMU reports register state; all timing arithmetic is on the host, exact (rationals).
- ▲ **Negotiation.** No new acknowledgement command: an older host rejects the unknown `pwm`
  token at the hello (the bridge-v2 rule), so it never receives `P`/`W`; an older runtime never
  sends them, and the builder keeps refusing PWM sketches there. Same fail-closed property.
- **A1** as proposed, and generalised: several PWM pads are allowed when superposition holds
  (checked, not assumed); a part outside the instantly-settling set that the PWM output affects,
  an MCU input reading PWM, and interacting outputs are refused by name.

## 3. Acceptance gates (Phase B), defined before measurement

| # | Criterion | Measure | Pass |
|---|---|---|---|
| G1 | LEDC configuration | the 3.3.12 driver's sequences (analogWrite, ledcAttach/Write/Detach, second channel) produce P/W/F frames | waveform equals hand calculation for every step (T-R4-1) |
| G2 | Frequency | period from clock, divider, resolution | exact (rational equality) for 1 kHz REF_TICK, 5 kHz APB, 50 Hz APB/16 bit |
| G3 | Duty | high time | exact nominal; model resolution ≤ 1 source clock (O-R4-2) stated |
| G4 | Update timing | duty at next cycle; timer at next overflow; reset restarts | host unit tests on probe frames; no duty-0 transient after attach+write |
| G5 | Determinism | P/W/F stream across runs; host output from the same frames | byte-identical (T-R4-3); fingerprints recorded |
| G6 | Continuity | non-LEDC firmware on Runtime v3 | existing pinned suites unchanged (gate, s12/r1 determinism) |
| G7 | LED brightness | published average current vs engine reference | |avg − duty·I_high| ≤ 1e-12 A at 25/50/100 % (T-R4-5) |
| G8 | Ratings | peak, not average, against limits | unit test (app ratings) |
| G9 | SG90 pulses | pulse width seen by the servo | within 1 ns of exact (integer-ns hand-off) |
| G10 | SG90 position | angle vs 1.0/1.5/2.0 ms map, 600 °/s, hold, unpowered | within 1e-6 deg of the model; holds without pulses; no motion below 4.8 V |
| G11 | Unsupported | dither, fade, interrupts, low-speed, held timer, hpoint wrap, open drain, duty 0 on a load, non-A1 loads, PWM into an input, interacting outputs, fade/invert APIs | each refused with a named code (host) or at Build (`pwm_advanced`) |
| G12 | Isolation | GPIO, I2C, sensors, pins without PWM | full unit + e2e regression green |

## 4. Implemented (Phase C)

| Commit | Content |
|---|---|
| `d470e71` | Patch 0009 (LEDC → P/W frames, capability `pwm`); harness parsing; host waveform tracker (`pwm.ts`), A1 averaging (`pwmElectrical.ts`), session integration; builder gating (`pwm` required on v3, `pwm_advanced` refused); app failure messages |
| `0b20d41` | SG90 part (engine, catalog) and host `ServoBank`; R4 test firmware pinned; real-runtime suites; fixes from the independent review (§5.4) |
| `d3d4082` | App: SG90 in every view, PWM readouts, peak ratings, limitations, examples `esp32-led-fade`, `esp32-servo-sweep` |
| (this commit) | Test baselines updated for the R4 product (§5.3), this record |

Runtime v3 = `1a0867669eb0f01f` (upstream `40edccac` + patches 0001–0009) in Sprint 15; **since Sprint 16A
`2cb1406f94f52e4f` (+ patch 0010, §10)**, built by `provision.sh`
into a private DEV home (`~/tbi-s15-rt`). Not installed anywhere else.

## 5. Verification (Phase D) — all executed locally on DEV (`tbi-lab-srv`), 2026-10-15

### 5.1 R4 results

| Gate | Test | Result | Quantitative evidence |
|---|---|---|---|
| G1–G4 | T-R4-1 real QEMU (`TbiPwm`) | pass | analogWrite 1 kHz: period 1 000 000 ns, high 250 000 / 500 000 ns, 255 → static high; ledcAttach 5 kHz/12 bit: 200 000 ns, high 50 000 / 100 000 ns, 4096 → high; 2nd channel 1 kHz 25 %; ledcDetach → GPIO; no duty-0 latched |
| G2/G3 | host unit (probe frames) | 10 + 3 pass | servo 3277/4915/6554 → 1 000 061.035 / 1 499 938.965 / 2 000 122.070 ns (exact rationals) |
| G5 | T-R4-3 real QEMU | pass | 27-frame P/W/F stream byte-identical over 2 runs; fingerprint `03e11c34…a11206` |
| G6 | continuity | see 5.2 | |
| G7 | T-R4-5 real QEMU | pass | LED 220 Ω on GPIO2: I_high = 5.753982 mA; published averages 1.438496 / 2.876991 / 5.753982 mA at 25 / 50 / 100 % (= duty × I_high to 1e-12 A); 2 PWM pads at once exact |
| G7 | LED-fade example, real build + QEMU | pass | 20 samples, duty 1/256 … ; avg = duty × 5.753982 mA (1e-12 A); peak 5.753982 mA; build `requires: [pwm]` |
| G8 | app ratings unit | pass | peak replaces average for ratings only |
| G9/G10 | T-R4-4 real QEMU (`TbiServo`) | pass | pulses 1000.062 / 2000.123 / 1499.939 µs (≤ 1 ns from exact); angles 0.011 / 180 (clamped) / 89.989°, = model map to 1e-9 |
| G10 | servo-sweep example, real build + QEMU | pass | commanded 0 (999.76 µs, clamped), 179.97, 89.99° = integer duties 3276 / 6553 / 4915 |
| G11 | host + builder unit, real QEMU (`TbiPwmLs`) | pass | 9th channel → `unsupported low-speed`; dither, timer paused, open drain, relay coil (`pwm_load_unsupported`), input reading PWM, interacting outputs, duty 0 on a load, fade/invert at Build: each refused by name |
| G12 | full regression | see 5.2 | |

### 5.2 Regression (G6, G12)

| Suite | Runtime | Result |
|---|---|---|
| R-MCU-1 gate (`gate`) | v3 | **7/7**, pins unchanged |
| Determinism (`s12-determinism`, `r1-determinism`) | v3 | **8/8, 2/2**, all pins unchanged |
| Bridge (`s12-bridge`) | v3 | **11/11** |
| R2/R3 (`s12-r2`, `s12-r3`) | v3 | 3/3, 4/4 (re-run alone, see note) |
| R2/R3 timing (`s12-r2-timing`, `s12-bridge-timing`) | v3 and v2 | **11/11 on both** |
| Examples (`s12-examples`, `r1-examples`) | v3 | 3/3, 2/2 |
| Failures/safety (`failures`, `r2-failures`) | v3 | 15/15, 11/11 (r2-failures re-run alone) |
| R2 acceptance (isolation, determinism with mirrors, electrical equivalence, resources) | v3 | 5/5 (re-run alone) |
| Electrical (`electrical`) | v3 | 7/7 |
| Unit (`npm test`) | — | **1 233 / 1 233** (143 files) |
| Browser e2e (`test:e2e`) | — | **229 passed, 22 skipped, 0 failed** (skipped = real-QEMU / staging specs needing env flags, same set as CI) |
| Browser persistence (`test:browser`) | — | 4/4 |

**Note (not hidden):** the first continuity run (12 files) reported 70 passed / **8 failed**: 7 were
wall-clock timeouts ("timed out", "Matcher did not succeed in time", one early stall) while the
1-vCPU host also ran the UI agent, the reviewer and unit suites; 1 was `s12-r3` asserting Runtime
v2's exact capability list. Re-run alone on an idle host, the four affected files passed 23/23;
the `s12-r3` assertion now requires the I2C capabilities (v3 adds `pwm`).

### 5.3 Baselines changed, with the reason

- `s12-r3`: capability list `toEqual` → contains `i2c, pad-func, sched-input` (v3 adds `pwm`).
- `capabilities.test` (domain), `s13-capabilities` (e2e): PWM `limited` on v3; `pwm_advanced`
  refused; 20 facilities (was 19).
- `sprint4` A15, `sprint5` A13/A15, `locale` (e2e): Hebrew-surface allow-lists gain the technical
  tokens PWM, LEDC, SG90, TowerPro, analogWrite, ledcWrite, ledcDetach, digitalWrite, Hz, kHz, ms, us
  (CLAUDE.md terminology rule).
- `sprint4` (domain) closed catalog: `component.servo_sg90` (PM-6 approved family).
- `examples.test`: 10 ESP32 examples (was 8).

### 5.4 Independent review (separate read-only agent) and dispositions

| # | Severity | Finding | Disposition |
|---|---|---|---|
| B1 | blocker | servo re-anchored on every unrelated solve (identity comparison) → past pulses replayed → host error, session hang | **fixed** (`0b20d41`): compared by value, no re-feeding; post-run flush guarded; regression test proven to fail without the fix |
| M1 | minor | pause/resume restarted the phase | **fixed** (phase shifted by the pause) |
| M2 | minor | APB change applied at next overflow (hardware: immediate); REF_TICK assumed 1 MHz | open, documented (§6); rare path (CPU < 80 MHz) |
| M3 | minor | during the one-tick grace an unsupported pad is published solved low | **fixed in Sprint 16A** (§10): nothing is published while an unsupported state is pending |
| M4 | minor | only the first problem's start tracked | **fixed** (per problem) |
| M5 | minor | superposition only checked at all-high | **improved**: all pairs for ≥ 3 pads; higher-order cancellation documented |
| M6 | minor | PSU mode / matrix `lit` from the low point | open, documented (§6) |
| M7 | minor | QEMU can send duty > 2^20 with an invalid resolution → classified as protocol error | open (fails closed); fix needs a QEMU change (new runtime id) |
| M8 | minor | IDF output inversion not detected | **fixed in Sprint 16A** (§10): patch 0010 publishes the inversion, the host refuses it by name |
| M9 | minor | missing fall at a segment start after a high level (hpoint > 0) | **fixed** |
| M10 | minor | missing tests | **added**: B1 regression, open drain, session-level load refusal, strict P/W parsing, duty 0 into a servo, undefined servo signal, SG90 part, pause/resume, segment fall |
| N1–N6 | notes | res < 8 fractional-divider per-period jitter; LS idle immediacy; register read details; old host rejects every session on v3 (deploy together); RGB limitation text now assumes v3; aux-solve part state | documented (§6, §7) |

## 6. Known physical limitations

- **Duty 0 (O-R4-1):** not established; refused when it drives a load.
- **Average, not waveform:** the circuit is shown time-averaged (exact for instantly-settling
  loads). Capacitors, inductive loads, transistors, sensors on a PWM net are refused, not filtered.
- **Model resolution (O-R4-2):** high times can differ from nominal by ≤ 1 source clock.
- **First partial cycle:** between enabling a channel and its first cycle boundary the pad keeps
  its previous state (≤ one period).
- **High-speed channels only:** the 9th+ channel (low-speed group) is refused.
- **Output inversion** (`ledcOutputInvert`, GPIO-matrix OUT_INV) is refused at Build, and on the
  runtime (patch 0010) however it is set: an inverted LEDC output is `pwm_unsupported_mode`
  (`inverted`), any other inverted routing on a connected pin `unsupported_feature`.
- **SG90:** supply current not modelled (D3); signal thresholds 2.0/0.8 V assumed (unspecified);
  4.8–6.0 V only; 1.0–2.0 ms → 0–180° nominal map; no torque, load or stall; frames far from
  20 ms are accepted as the model's pulse rules allow.
- **Perceived LED brightness** is approximated by the average current (a cue, not photometry).
- **Fractional divider with resolution < 8 bits:** individual periods vary by ≤ 1 source clock
  (exact only on average); all Arduino defaults (8–16 bit) are exact.
- **APB clock change** (CPU below 80 MHz) takes effect at the next overflow in the model (real:
  immediately); REF_TICK assumed 1 MHz (ESP-IDF always configures it so).
- **Grace tick:** an unsupported PWM state is refused after one command tick; meanwhile nothing new
  is published (the previous truthful outcome stays on screen for ≤ one tick).
- **Averaged parts' discrete fields** (PSU CV/CC mode, LED-matrix lit count) come from the low point;
  their currents are averaged and peaks shown.
- **Superposition** is checked for all pairs and the all-high point; a higher-order interaction
  among ≥ 3 PWM pads that cancels in all of them is not detected.
- **Deployment coupling:** a pre-R4 host rejects Runtime v3's hello (unknown `pwm`), i.e. every
  session; host and runtime must be deployed together (Gate B/C).

## 7. Remaining blockers / open items

1. **O-R4-1** — one bench measurement (`docs/sprints/s13-evidence/h2/BENCH-PROTOCOL.md` §4,
   GPIO2 → 10 kΩ → GND, sketches 4a–4d, a scope if available). Minimal validation plan in §9.
2. **R4-B** (staging Gate B on Runtime v3) and **R4-C** — need PM authorization.
3. PM ratification of R4-D1..D7 (§1 for D2, §8 for the others).

## 8. Decisions taken in implementation (for PM ratification)

| # | Decision | Alternative |
|---|---|---|
| D1 | A1 two-point averaging, generalised with a superposition check | refuse all loads but the servo |
| D2 | R4 is DEV only / post-alpha (not in the 16 Nov alpha: R4-B not passed by 5 Nov) | in the alpha if R4-B passes by 5 Nov |
| D3 | SG90 supply current not modelled, reported as unknown | a vendor-sheet constant (no conditions given) |
| D4 | hardware fade refused (builder + runtime) | — |
| D5 | P/W frames instead of a single per-pad W | as proposed (loses exact phase across timer changes) |
| D6 | duty 0 refused only when a load can tell | refuse every duty 0 (breaks servo detach patterns) |
| D7 | SG90 signal thresholds 2.0/0.8 V (assumption) | require a direct pad connection |

## 9. Minimal validation plan (to close O-R4-1)

1. Owner: DevKitC, GPIO2 → 10 kΩ → GND, multimeter (scope if available); run BENCH-PROTOCOL §4
   sketches 4a–4d; record V(GPIO2) DC and any pulses.
2. If constant low (and, with a scope, no pulses): change the host's `zero` rule to a static low
   (one line in `pwm.ts`), add the measurement as evidence, re-run T-R4-1/-5.
3. If anything else: keep the refusal; document the measured behaviour.

## 10. Sprint 16A addendum (DEV, 2026-10-18)

All on DEV (`tbi-lab-srv`); nothing merged or deployed.

| Item | Change | Evidence |
|---|---|---|
| **M8** inversion | QEMU patch 0010: an inverted output (OUT_INV_SEL on a pad that drives) or an inverted output enable (OEN_INV_SEL) is published as pad function `inverted:<sel>` (sel kept when the inverted enable makes a routed pad drive). Host: an inverted LEDC pad is refused as `pwm_unsupported_mode` (`why: inverted`, EN/HE); any other inverted routing on a connected pin as a lasting `unsupported_feature`, named in the app as `inverted_output` (EN/HE); until that refusal nothing is published (QEMU still reports the uninverted GPIO level) | Real QEMU (`TbiPwmInv`, pinned `4b6de26f…`, built twice byte-identical): `ledcOutputInvert(18, true/false)` → `inverted:71`, then `periph:71`; `esp_rom_gpio_connect_out_signal` on GPIO19's LEDC signal → `inverted:72`; on simple GPIO21 → `inverted:256`, restored → `gpio`; GPIO22 (the ROM routine enables the output: `INV-EN22 1`) → `inverted:256`, and after GPIO_ENABLE is cleared (an input with OUT_INV still set) → `gpio`; frame stream identical over 2 runs. Session Host: an LED on GPIO18 is refused `pwm_unsupported_mode`/`inverted`; the last published current is the exact 25 % average (1.438496 mA) |
| **M3** grace tick | No electrical outcome is published while a PWM problem or an inverted routing is pending | host tests fail without the fix; real QEMU showed 0 mA in the grace window before the fix |
| Runtime v3 | `2cb1406f94f52e4f` = `40edccac` + 0001–0010 (Sprint 15: `1a0867669eb0f01f`; an intermediate `c97c28365cdce379` was superseded the same day by the review refinement) | `provision.sh qemu` clean twice |
| Test reliability | `bridge-v2` G-2 cases counted windows after 300 ms of wall time (1 of 2 runs failed on unmodified `fb90e18` under load); now 80 ms of simulated time | 3 × 25/25 under load |
| **Browser → real QEMU** | new `app/e2e/s15-r4-real.spec.ts` (`TBI_S15_REAL=1`): LED fade (GPIO18 `data-pwm=wave`, PWM note on the LED), servo sweep (angle shows `0°` and `180°`) | local stack on DEV (R4 Session Host + build service on loopback, Runtime v3 `2cb1406f94f52e4f`): **2/2**. With the previous real browser specs on the same R4 stack (on `c97c28365cdce379`): 17 passed, 2 skipped (old-host compatibility cases), **1 failed**: `s13-export-real`, its build exceeded the 300 s limit while unit tests ran beside it; re-run alone on the idle stack it passed (16 s) |

**G6 on `2cb1406f94f52e4f`**: 21 files 119/119 in one run (gate 7, s12-determinism 8, r1-determinism 2,
s12-bridge 11, s12-r2 3, s12-r3 4, s12-r2-timing 9, s12-bridge-timing 2, s12-examples 3,
r1-examples 2, failures 15, r2-failures 11, r2-acceptance 5, electrical 7, s12-pace 1,
s13-pad-short 1, s8-gate 5, s8-policy 7, s8-containment 9, isolation 5, s15-examples 2) and
s15-r4 **6/6** after the GPIO22 test step was made explicit (its first version assumed the ROM
routine leaves the pad an input; QEMU showed it enables the output, so the expectation, not the
runtime, was wrong). On the superseded `c97c28365cdce379` the same 22 files gave 125/125 after
provisioning the micropython image the `isolation` suite needs.

**Independent review of these changes** (separate read-only agent): no blocking or security
finding. Fixed: an inverted simple-GPIO pad could publish its uninverted level in the grace
window; OUT_INV on an input pad was reported (refused) although it drives nothing; an inverted
enable on a routed pad lost its signal number; Hebrew wording. Added tests: inverted LEDC on a
runtime without `pwm`, inversion cleared within one tick (not refused). Noted, not changed: a
problem flapping faster than the 1 ms tick is never refused and withholds publication meanwhile
(needs sustained sub-tick flapping; every persisting problem is refused within ~2 ms).

**Still open (assessed, not changed):**
- **M2** (APB change applied at the next overflow; REF_TICK assumed 1 MHz): only firmware that
  lowers the CPU below 80 MHz while PWM runs; the error is ≤ one period at the switch; no supported
  example does it. Fix belongs in patch 0009 (publish the APB change as a timer event). Deferred.
- **M6** (discrete fields from the low point: PSU CV/CC mode, LED-matrix lit count): currents and
  peaks are correct; a PSU that current-limits only during the high phase is shown in CV mode. One
  mode is not meaningful for a switching load; an "alternates" display is a PM/UI decision.
- **O-R4-1** duty 0: unchanged; no bench evidence exists (§9). Still refused when a load can tell.

## 11. Sprint 16C/16D addendum (DEV, 2026-10-18)

All on DEV (`tbi-lab-srv`); R4 is not merged and not deployed anywhere (no staging, no DEV-Lab).

| Item | Result |
|---|---|
| Baseline | RC4 released on `sprint-13` at `7e04c4d` (#8, #9, #10). Merged into this branch with a normal merge (`a957c29`): no textual conflict |
| Semantic conflict | RC4's `session_end` diagnostics classify every failure reason (typed table, pinned by a test); R4 adds `pwm_unsupported`. Classified `user_content`/`info` like `unsupported_feature` (`203fe7b`), row added to `docs/ops/SESSION-DIAGNOSTICS.md`. Found by typecheck; vitest alone passed |
| Typecheck, lint, unit | pass; **1316 / 1316** |
| PR #7 CI on `203fe7b` | 3/3 pass |
| Real QEMU, Runtime v3 `2cb1406f94f52e4f`, full runtime suite | 46 files: **201 passed, 2 failed, 19 skipped** in one run. Both failures: the v3 runtime home lacked the pinned `TbiR1Scan` image (`b86f9c5e…`), an environment gap, not R4 code; after a hash-verified copy the two files pass (3/3). Skipped: the six deployed/capacity files (need an installed instance) |
| G6 subset | inside the run above: `s15-r4` 6/6, `s15-examples` 2/2, and the 21 G6 files all pass |
| Browser → real QEMU (local stack, R4 host + build service, Runtime v3) | **16 passed, 1 failed, 2 skipped, 1 not run** in the full real set; the failure (`s6` input echo, second Run) was a correct `storage_pressure` refusal: the local stack's session root was on the 1.9 GB `/tmp` tmpfs, ~1 GB free, under the host's 1 GiB floor. Stack moved to disk: `s6-real` 3/3 and `s15-r4-real` 2/2 (LED fade, SG90 0°/180°) pass |
| Runtime v3 / host compatibility | unchanged: an R4 host needs Runtime v3 (capability `pwm`); deploy host and runtime together (R4-B) |
| M2, M6 | assessed in §10, unchanged: deferred / PM-UI decision |
| O-R4-1 preparation | bench sketch `s13-evidence/h2/bench/TbiBenchDuty0/` (protocol §4 steps 4a–4d from clean resets, serial markers, 30 s holds; compiles with the pinned toolchain, **not run on hardware**) and result sheet `s13-evidence/h2/bench/O-R4-1-RESULTS.md`. **O-R4-1 remains open**: no measurement exists |

**R4-B readiness (staging Gate B on Runtime v3), not started:**
1. O-R4-1 bench result (or a PM decision to keep the refusal as the documented behaviour) — open.
2. PM ratification of D1–D7 and the M2/M6 decisions — open.
3. Staging install of an R4 host + Runtime v3 on `tbi-s8` (`install.sh staging` with `TBI_S8_RUNTIME` = the v3 prefix), the deployed suites, `s15-r4-real` through staging, then rollback to RC4 (`7e04c4d` package, drill E of `RC4-RELEASE-HANDOFF.md`) — ready to run, needs PM authorization.
4. The v3 runtime home on any host must hold every pinned image of `artifacts.lock.json` (the gap above).
