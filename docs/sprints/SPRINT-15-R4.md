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

Runtime v3 = `1a0867669eb0f01f` (upstream `40edccac` + patches 0001–0009), built by `provision.sh`
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
| M3 | minor | during the one-tick grace an unsupported pad is published solved low | open, documented (§6); ≤ 1–2 ms before the refusal |
| M4 | minor | only the first problem's start tracked | **fixed** (per problem) |
| M5 | minor | superposition only checked at all-high | **improved**: all pairs for ≥ 3 pads; higher-order cancellation documented |
| M6 | minor | PSU mode / matrix `lit` from the low point | open, documented (§6) |
| M7 | minor | QEMU can send duty > 2^20 with an invalid resolution → classified as protocol error | open (fails closed); fix needs a QEMU change (new runtime id) |
| M8 | minor | IDF output inversion not detected | open, documented (§6) |
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
- **Output inversion** (`ledcOutputInvert`, GPIO-matrix OUT_INV) is refused at Build; inversion
  set through IDF APIs directly is not detected (the bit is not published by patch 0007).
- **SG90:** supply current not modelled (D3); signal thresholds 2.0/0.8 V assumed (unspecified);
  4.8–6.0 V only; 1.0–2.0 ms → 0–180° nominal map; no torque, load or stall; frames far from
  20 ms are accepted as the model's pulse rules allow.
- **Perceived LED brightness** is approximated by the average current (a cue, not photometry).
- **Fractional divider with resolution < 8 bits:** individual periods vary by ≤ 1 source clock
  (exact only on average); all Arduino defaults (8–16 bit) are exact.
- **APB clock change** (CPU below 80 MHz) takes effect at the next overflow in the model (real:
  immediately); REF_TICK assumed 1 MHz (ESP-IDF always configures it so).
- **Grace tick:** an unsupported PWM state is published (solved low) for ≤ one command tick before
  the session is refused.
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
3. PM ratification of R4-D1..D4 as applied (§1).

## 8. Decisions taken in implementation (for PM ratification)

| # | Decision | Alternative |
|---|---|---|
| D1 | A1 two-point averaging, generalised with a superposition check | refuse all loads but the servo |
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
