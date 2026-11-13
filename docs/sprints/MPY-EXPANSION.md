# MicroPython expansion (DEV, after RC6)

Branch `mpy-expansion` from `c38f2c9` (RC6, live on Alpha and accepted 2026-11-13). DEV only:
nothing here goes to Alpha. Runtime unchanged: Runtime v5 `39f2229a66d45e43`, MicroPython 1.29
(the S26 MicroPython home), arduino-esp32 3.3.12. No QEMU patch, firmware image or runtime
artifact changed.

## 1. Verified twins: audit

A twin is the same circuit (components, parameters, nets, connections: `circuitKey`) with a
program in the other language that does the same thing, run on real QEMU in both languages.
`EXAMPLE_VARIANTS` (`app/src/examples/catalog.ts`) pairs them; the language-switch unit test checks
every pair's circuits are identical. The twin recipes (`app/tests/exampleRecipes.ts`, `twinOf`)
run the original recipe with only the board's program replaced, so the drawings are identical
too.

### Added

| Original | New twin | Program | Real QEMU (local, `runtime/tests/mpy-twins.runtime.test.ts`, both languages) | Staging (`app/e2e/mpy-twins-real.spec.ts`) |
|---|---|---|---|---|
| esp32-input-echo | **mpy-input-echo** | `mpy_input_echo.py` | switch closed → `ECHO34=1`, LED > 1 mA; open → `ECHO34=0`, LED off | Build + Run (EN); switch Arduino → MicroPython shows the twin ("restored"), builds and runs |
| esp32-bench | **mpy-bench** | `mpy_input_echo.py` | switch → `ECHO34=1`, D1 lit; supply-fed D3 lit | Build + Run (HE) |
| esp32-motion-relay | **mpy-motion-relay** | `mpy_input_echo.py` | PIR motion → relay → alarm LED > 1 mA; none → off | Build + Run (EN) |
| esp32-night-light | **mpy-night-light** | `mpy_input_echo.py` | 1 lx → GPIO34 HIGH → GPIO4 > 3 V; 300 lx → off | Build + Run (EN) |
| esp32-servo-sweep | **mpy-servo-sweep** | `mpy_servo_sweep.py` (`PWM(freq=50)`, `duty_u16`) | SG90 commanded to 0°, 180° and 90° (±0.1°) | Build + Run (HE) |
| mpy-button | **esp32-button** | `Button.ino` | press → `button held`, LED > 1 mA; release → `button released`, off | Build + Run (EN) |
| mpy-adder-monitor | **esp32-adder-monitor** | `AdderMonitor.ino` (LEDC 1 kHz, 16 bit) | the four switch states printed `A=… B=… -> C=… S=… = n ok` | Build + Run (HE) |

The MicroPython InputEcho program does not repeat the Arduino sketch's start-up sweep of five
unconnected outputs (a runtime self-check with no effect on the circuit); the observable
behaviour (GPIO34 copied to GPIO4, `ECHO34=<level>` on each change) is the same.

Real-QEMU runs: local, Runtime v5 `39f2229a66d45e43`, the real Arduino and MicroPython build
providers (14/14 in the final run, evidence `mpy-twins.json`). Staging (tbi-s8 build service,
Session Host and QEMU, host `166eaa9`): 8/8 passed, screenshots kept on DEV.

### Logic limit demonstrators: excluded from the candidate

> On the release-candidate branch `mpy-rc` this commit is reverted (§4.3 recommendation, owner
> decision): the three twins below are not shipped. Kept on `mpy-expansion` for the record.


esp32-logic-and, esp32-logic-override and esp32-logic-quad-and are limit demonstrators: the
Arduino examples are refused by name (S30-L1 / the SN74LVC08A datasheet) once the sketch drives
GPIO18, or in every state. Their MicroPython twins (`mpy_logic_and.py`, `mpy_logic_override.py`,
`mpy_logic_quad_and.py`) only use `Pin`, and are refused exactly as the Arduino versions are; they
are in a separate commit so the owner can decide whether limit demonstrators need a twin.

### Not feasible with the MicroPython support of phase 1

| Example | Missing in phase 1 | Phase 2 |
|---|---|---|
| esp32-thermo-hygrometer (DHT22) | MicroPython's `dht` module was refused (`library:dht`), and a pure-Python read of the DHT22's 26–70 µs bits has no validated timing | the firmware's own `dht` module validated and allowed: §4.1, twin mpy-thermo-hygrometer |

The HC-SR04 distance alarm, refused before this branch (`machine.time_pulse_us`), now has a twin:
§2.

The examples without an ESP32 (resistors, logic, PSU) have no program, so no twin applies.

## 2. HC-SR04: `machine.time_pulse_us`

### How the Arduino path works

`pulseIn(18, HIGH, 30000)` in arduino-esp32 is a C loop polling the GPIO input register with
`micros()`. The Session Host (`runtime/host/devices.ts`) watches the TRIG pad's output frames
(exact QEMU virtual time, patch 0007), measures the trigger width, and schedules the ECHO edges
with `sched-input` (patch 0006) at the times `hcsr04Echo` gives (burst 200 µs, width
2 d / c(T)). The firmware only sees register levels; nothing is language-specific.

### Why MicroPython was refused, and what changed

Sprint 12 G2 (round 4) measured MicroPython 1.29's `time_pulse_us` on scheduled pulses as
research (−1.83..+2.96 µs on 124 pulses) but no product validation followed, so the Build analysis
(`runtime/builder/pyFeatures.ts`) kept it refused. `time_pulse_us` is the interpreter's own C loop
(`extmod/machine_pulse.c`: `mp_hal_pin_read` + `mp_hal_ticks_us`), the same mechanism as `pulseIn`,
on the same runtime bridge. So it fits the existing design: **no runtime, host, firmware or QEMU
change**, only the Build analysis.

Change: `time_pulse_us` moves from the refused names to the allowed `machine` names; analyzer
version 7 → 8 (part of the MicroPython profile hash: MicroPython build records are rebuilt once, no
cached build is reused across the change); a contract entry (`pyContract.ts`, `pulse_timing`); unit
tests (every spelling allowed, the timed pin declared as an input read, the facilities refused
before still refused).

### Product-level validation (real QEMU Runtime v5 `39f2229a66d45e43`, MicroPython 1.29)

`runtime/tests/mpy-distance.runtime.test.ts`, on the app's own request for the distance-alarm
circuit, oracle `hcsr04Echo` for the same environment:

| Check | Result |
|---|---|
| Accuracy, 2 cm, 5 cm, 10 cm, 20 cm, 50 cm, 1 m, 2 m, 3 m, 4 m at 20 °C; 1 m at −10 °C and 40 °C (3 readings each, 36 in all) | error −1.77..+1.62 µs against the oracle width (≤ 0.03 cm); bound asserted: the timing contract's ≈ 13 µs for polled inputs (as `pulseIn`) |
| Out of range (1 cm, 5 m: no echo) | `−2` every time, the call returns after 30.016 ms (timeout 30 ms); the program keeps running; back at 0.5 m the readings resume (2911–2912 µs vs 2911.89) |
| Pulse longer than the timeout (1 m echo, timeout 1 ms) | `−1` after 1.20 ms (≈ 200 µs burst + 1 ms), no hang; a 583 µs echo with the same timeout reads 583 |
| The shipped example vs its Arduino twin | 0.5 m: both `Distance: 50.2 cm`; 0.1 m: Arduino `10.0`, MicroPython `10.1` (583 vs 582 µs, both within 1 µs of 582.38), LED on (5.75 mA) in both; 5 m: both `No echo`; 0.3 m: both `30.1 cm`, LED off |

Usage note (as on hardware): `time_pulse_us` measures from the call if the pin is already at the
pulse level; the example calls it right after the trigger, 200 µs before the echo rises.

### New twin

**mpy-distance-alarm** (`mpy_distance_alarm.py`): the circuit of esp32-distance-alarm,
`time_pulse_us(echo, 1, 30000)`, `Distance: %.1f cm` / `No echo`, LED below 20 cm.

### W1 evidence and the frozen runtime

- Unchanged: QEMU (Runtime v5 `39f2229a66d45e43`, patches 0001–0012), the MicroPython 1.29
  interpreter image and mpy-cross, the arduino-esp32 core, the Session Host and its HC-SR04 model.
  The W1 runtime evidence (the runtime artifact set) is not affected.
- Changed: the **build service** (its MicroPython analysis, analyzer 8). It takes effect only where
  a build service with this code is deployed; until then (staging tbi-s8, Alpha) `time_pulse_us`
  stays refused at Build and mpy-distance-alarm would not build there. That is why its proof is the
  local real-QEMU run above and not the staging browser run: deploying a build service to staging
  was outside this task. A future candidate carries the build service change and should re-run
  `mpy-distance.runtime.test.ts` and a staging Build + Run of mpy-distance-alarm.

## 3. Libraries: survey and recommendation

The managed library registry (`packages/domain/src/libraryRegistry.ts`) holds one library per
language, both for the LCD1602 I²C display. Every other part of the palette that works with the
ESP32 was surveyed for the library a maker would normally reach for:

| Part | Arduino C++ today | MicroPython today | Usual library | Gap |
|---|---|---|---|---|
| LCD1602 I²C (PCF8574) | LiquidCrystal_PCF8574 2.2.0 (managed) or raw `Wire` | python_lcd I2cLcd (managed) or raw `I2C.writeto` | LiquidCrystal_I2C (Arduino) | none functionally; LiquidCrystal_I2C is the more common name, a second LCD library adds no capability |
| HC-SR04 | `pulseIn`, no library | `time_pulse_us`, no library (this branch, §2) | NewPing (Arduino), `hcsr04` driver (MicroPython, built on `time_pulse_us`) | none functionally |
| DHT22 / AM2302 | library-free sketch (validated 80/80 in S12 G2) | **none**: `dht` refused (`library:dht`) | Adafruit "DHT sensor library" + "Adafruit Unified Sensor" (Arduino); the firmware's built-in `dht` module (MicroPython) | **MicroPython cannot read the DHT22** |
| SG90 servo | LEDC (`ledcAttach` / `ledcWrite`), no library | `machine.PWM`, no library (this branch) | ESP32Servo (Arduino) | none functionally; ESP32Servo is what most tutorials use |
| PIR, relay, buzzer, LED, RGB LED, button, switch, potentiometer, LDR, logic gates | GPIO | GPIO | none | none |
| LED matrix 8×8, capacitor | not available with the ESP32 runtime (`mcuRuntime: false`) | same | — | not a library question |

### Recommendation

1. **MicroPython DHT22 (the only real gap): allow the firmware's built-in `dht` module, after
   validation; no registry entry.** Done in phase 2 (§4.1). `dht` is frozen into the MicroPython 1.29 image already on the
   runtime (the build cannot vendor it: its Python wrapper calls the firmware's C routine
   `esp.dht_readinto`, which times the bits itself). The work is the same as §2: allowlist `dht`
   (`DHT22(pin)`, `measure()`, `temperature()`, `humidity()`) in the Build analysis, then validate
   on real QEMU against the DHT22 model as S12 G2 did for the Arduino read (many reads across
   start phases, exact values, the no-pull-up case refused). The DHT22's bit margin (a 0 is 26–28
   µs high, a 1 is 70 µs) is wide compared with the ≈ 13 µs polling interval, so it is plausible,
   but not claimed until measured.
   If it passes: an mpy-thermo-hygrometer twin. Builder change only; no runtime artifact change.
   Effort: about one day including the validation runs.
2. **Arduino: add libraries only when testers ask for them.** Adafruit DHT (+ Unified Sensor, a
   dependency the registry already models) and ESP32Servo are the two most likely requests. Each
   is the existing registry pattern (vendored exact version, tree hash, licence, `validated`
   operations run on real QEMU against the part), but none is "trivial": each needs its own
   validation runs, and ESP32Servo's LEDC configuration must be checked against the host's PWM
   model. Not implemented here.
3. **Do not add alternative LCD libraries or NewPing**: they add no capability over what runs now.

Nothing was implemented for this section: no addition is trivial within the registry pattern (each
needs real-QEMU validation of its operations).

## 4. Phase 2 (owner-approved follow-up)

### 4.1 DHT22 with the firmware's `dht` module

The MicroPython 1.29 image on the runtime already contains the `dht` driver (frozen `dht.py`, the
C routine `esp.dht_readinto`). `esp.dht_readinto` drives the data pin open-drain; the Runtime v5
GPIO model publishes the open-drain bit (patch 0007: an open-drain 1 releases the pad), so the
host sees the start pulse and the release exactly as for the Arduino read, and the DHT22 model
(`runtime/host/devices.ts`, `dht22Frame` / `dht22Waveform`) answers. Nothing in the runtime,
host, firmware or QEMU changed: the Build analysis allows `import dht` (analyzer 9) and the
contract has a `dht22` entry.

Validation, real QEMU (`runtime/tests/mpy-dht.runtime.test.ts`), the raw 5-byte frame compared to
the oracle `dht22Frame` (temperature, humidity and checksum therefore exact):

| Check | Result |
|---|---|
| Range: (21.5 °C, 55 %), (−40, 0), (−39.9, 0.1), (−10, 30), (−0.1, 50), (0, 50), (0.1, 50), (25.6, 33.3), (60, 95), (80, 100) — 2 reads each | 20/20 frames exact (sign bit, both ends, the 0.1 steps around 0 °C) |
| The same sweep in a second session | identical transcript |
| Ten independent sessions, (21.5, 55) then (−10.3, 47.9), 2 reads each | 10/10 runs identical, every frame exact |
| A read within the sensor's 2 s collecting period | no answer → `OSError(errno.ETIMEDOUT)` (116 in this firmware) after 268 ms (the driver's 250 ms high + 18 ms start + its response waits), never a hang; the next read ≥ 2 s later is exact |
| No sensor on the pulled-up line | `OSError(ETIMEDOUT)` every read, 268 ms |
| No pull-up | the run is refused by name, `gpio_input_undefined` on GPIO4 (floating), no frame printed — as the Arduino read (S12 T-R2-8 on v5) |
| Checksum error | cannot occur with the model (it always sends a valid frame); the driver would raise `Exception("checksum error")`. Not exercised: stated, not claimed |
| mpy-thermo-hygrometer vs esp32-thermo-hygrometer at (21.5, 55), (−10, 30), (60, 95) | identical lines, `Temperature: 21.5 C  Humidity: 55.0 %` etc. |

Timing: the driver times the bits itself in C; the frames being exact for every bit pattern above
(both bit values in every byte position, across 86 frames in the final run) is the measurement that its decoding
margin holds on the runtime. The call duration varies by tens of µs between runs (268 153–268 181 µs:
the phase of the other core's interval), the frames do not.

Not validated: the `DHT11` class (no DHT11 part exists); the sensor's 1 s power-up rule with the
driver (the sensor is powered from the start of a session, more than 1 s before the first read).

**mpy-thermo-hygrometer** (`mpy_thermo_hygrometer.py`) is the twin of esp32-thermo-hygrometer.

### 4.2 `time_pulse_us`: edges and repeated runs

`runtime/tests/mpy-distance.runtime.test.ts` adds ten independent sessions per case:

| Case (oracle) | Readings, 3 per session (identical in all 10 sessions) |
|---|---|
| 1.99 cm, below the model's 2 cm (no echo) | −2, −2, −2; the call returns after 30 016 µs |
| 2 cm (116.48 µs) | 116, 116, 116 |
| 0.5 m (2 911.89 µs) | 2912, 2911, 2911 |
| 4 m (23 295.09 µs) | 23296, 23294, 23296 |
| 4.001 m, beyond 4 m (no echo) | −2, −2, −2; 30 016–30 017 µs |
| 1 m at −10 °C (6 149.31 µs) | 6151, 6149, 6149 |
| 1 m echo (5 823.77 µs) with a 1 ms timeout | −1, −1, −1; the call returns after 1 196–1 206 µs |

Run-to-run: the ten sessions of each case gave exactly the same sequence (values and call
durations): the simulation is deterministic. Within a session successive readings differ by up to
2 µs (the polling loop's phase against the echo edges, itself deterministic). All 36 readings of
the accuracy sweep (2 cm to 4 m, −10/20/40 °C) are within −1.77..+1.62 µs of the oracle.

### 4.3 The three logic pairs: why they are refused

All three refusals are made by the engine's datasheet-bound checks
(`packages/engine/src/logic/bounds.ts`), which depend only on the pad modes and levels the program
sets, never on the language. The engine and Session Host are identical on DEV (this branch), on
staging (host `166eaa9`) and on Alpha (RC6 `c38f2c9`): `git diff 166eaa9 HEAD -- packages/engine
runtime/host` and `git diff c38f2c9 HEAD -- …` are empty. The Arduino originals are refused in
the same way everywhere; the MicroPython twins only exist on this branch.

| Pair | Code | Where | Mechanism | By design |
|---|---|---|---|---|
| esp32-logic-and / mpy-logic-and | `logic_mcu_output_uncharacterized` | `bounds.ts:1325` (the `padLoad` check; limit `ESP32_PAD_LIGHT_LOAD_A` = 100 µA, `bounds.ts:925`) | once the program drives GPIO18 HIGH, the pad sources ≈ 330 µA into the 10 kΩ pull-down; the ESP32's V_OH is relied on only up to 100 µA (owner decision S30-L1), so the level is not guaranteed | yes: the example's own text says so (S29/S30) |
| esp32-logic-override / mpy-logic-override | `logic_mcu_input_not_guaranteed` | `bounds.ts:1268` (the `padInput` check) | GPIO19 reads the OR gate's output, which also drives the LED: under that load the SN74LVC1G32 guarantees only V_OH ≥ 2.4 V, below the ESP32's V_IH 2.475 V | yes (the example text names it) |
| esp32-logic-quad-and / mpy-logic-quad-and | `logic_input_leakage_uncharacterized` (at session creation) | `bounds.ts:1040` (input-leakage perturbation; the card's `iiVcc` is [3.6, 3.6] V, condition at `bounds.ts:1003-1005`) | the SN74LVC08A datasheet gives its input leakage only at V_CC = 3.6 V; here V_CC = 3.0 V | yes: "Not simulated: this example shows a limit of the datasheets" |

Measured on real QEMU (`mpy-twins.runtime.test.ts`): each pair ends with the same state, reason,
code and component in both languages; on the staging stack each MicroPython twin's Run is
refused by the same code.

**Recommendation: exclude them from the next candidate** (keep the commit on the branch). Applied on `mpy-rc` by reverting `5367fe7`. They are
correct — the refusal is the datasheet truth and identical to the Arduino originals — but a twin
that can only be refused adds little for testers: the limit is already demonstrated by the
Arduino examples, the switch from those examples now opens a MicroPython program that is refused
the same way (instead of the starter), and three more "refused" cards in the examples list make
MicroPython look less capable than it is. If the owner prefers completeness of the switch, they
are safe to include: no physical behaviour is claimed for them.

### 4.4 Overhead of the analysis change (analyzer 7 → 9)

Method: `runtime/tests/mpy-overhead.runtime.test.ts` (run with `TBI_MPY_BENCH=1`), the same file
run on the pre-change tree (`5367fe7`, analyzer 7) and on this branch (analyzer 9), one after the
other on DEV under the heavy lock, real MicroPython provider and real QEMU. Programs: the seven
curated MicroPython examples that use neither `time_pulse_us` nor `dht` (mpy-blink, -button,
-fade, -lcd-hello, -pot-threshold, -adder-monitor, -logic-feedback), each built 5 times into a
fresh, empty store (no cache). Evidence: `mpy-overhead-a7.json`, `mpy-overhead-a9.json`.

| Measure | Analyzer 7 | Analyzer 9 |
|---|---|---|
| Build, no cache (35 builds; the service's buildMs) | median 85 ms, mean 92 ms (57–209) | median 80 ms, mean 86 ms (43–180) |
| Artifact | 4 194 304 bytes each | the same bytes: every program's sha256 is identical at 7 and 9 |
| Analysis alone (1 400 calls) | 0.111 ms CPU per call | 0.110 ms CPU per call |
| Run mpy-blink (5 runs): Run → first program output | median 5.65 s | median 5.59 s |
| Run mpy-blink: Run → 3 s simulated | median 10.6 s | median 10.1 s |
| QEMU CPU time for those 3 s simulated | median 8.81 s | median 8.76 s |

The differences are within run-to-run noise. Because the artifacts are byte-identical, a program
that uses neither facility runs exactly the same firmware image as before: there is no run-time
cost by construction, and the measurement agrees.

One-time cost of the version change: the analyzer version is part of the MicroPython profile
hash, so every MicroPython build record made at analyzer 7 is a cache miss once. For the curated
sources that is 15 MicroPython programs × ≈ 0.1 s here (in-process; the deployed service adds its
per-job sandbox start, unchanged by this work); for users, each of their MicroPython programs is
rebuilt once on its next Build, at the cold cost above. Arduino builds are not affected (their
analyzer version is unchanged).

### 4.5 Phase 2 test results

All on DEV, Runtime v5 `39f2229a66d45e43`; logs and JSON evidence in `~/tbi-mpy/evidence/phase2/`.

| Suite | Result |
|---|---|
| Unit (vitest, the whole repository) | 2 590 passed, 3 skipped (the skips predate this branch); typecheck and lint (eslint, prettier, boundaries) clean |
| Runtime regression, real QEMU, full (`vitest.runtime.config.ts`, 62 files, 1 h 40 min) | 271 passed, 22 skipped, 2 failed. Both failures were a new assertion of this phase (the adder monitor's LED brightness waited for a simulated-time event that a steady circuit does not emit); the assertion was rewritten (engine expectation per state, as s29-mpy-monitor) and the file re-run: see the twins re-run line. Skipped: the deployed-instance and capacity suites (c5-deployed, c5-capacity, s11-deployed, s13-deployed-security, s8-deployed-policy, alpha-deployed-recovery: 19 tests, they need a deployed instance's environment) and the overhead benchmark (3, measurement only). Excluded: s8-containment (it drives the shared staging instance's sandboxes and crash recovery; not affected by this branch, and the coordinator's boundary keeps the shared services untouched) |
| Runtime, mpy-twins re-run after the fix | 17/17; then the adder pair once more with the check restricted to events after each switch change: 2/2, LED average at sums 1, 2, 1, 0 = 2.1577, 5.5742, 2.1577, 0.1798 mA in both languages (duty × the engine's ON current) |
| Browser e2e, full (`playwright.app.config.ts`, 450 tests, 24 min) | 382 passed, 66 skipped, 2 failed. Both failures (locale.spec "every shipped screen is translated", sprint5.spec A13/A15) were this branch's: the Hebrew summaries of the new twins quoted English serial output and API names. Fixed (Hebrew wording; `digitalRead`, `time_pulse_us`, `dht` added to the technical-token allowlist as earlier sprints did for their API names) and re-run: locale, sprint5 and mpy-twins-i18n 19/19. Skipped: the real-stack specs (61, env-gated; the new ones were run separately against staging), s13-3d-timing (4, measurement only), rc6-rollback-data (1, needs the Alpha and RC distributions) |
| Staging (tbi-s8, real build service + Session Host + QEMU) | mpy-twins-real 11/11; mpy-libraries-real 8/8 (EN and HE: both managed LCD libraries build and run; `import neopixel` refused at Build by name and Run refused; `#include <DHT.h>` does not build) |
| Local e2e, EN and HE | mpy-twins-i18n 4/4 (every twin pair both ways, exact and stored, after reload; the libraries panel follows the language); p1-language-switch 6/6 |

mpy-distance-alarm and mpy-thermo-hygrometer are not run on staging: its build service is at
analyzer 7 and refuses `time_pulse_us` and `dht` until a build service with this branch is
deployed (not done: the shared staging services were not redeployed).

## 5. Release candidate `mpy-rc` (DEV, conditional GO)

Branch `mpy-rc` from `bf24d16` (`mpy-expansion` unchanged). Baseline: RC6 `c38f2c9`.

- **Included:** the seven runnable twins (§1), the HC-SR04 twin with `machine.time_pulse_us` (§2),
  the DHT22 twin with the firmware's `dht` module (§4.1), the build-service analysis at analyzer 9,
  the tester guide and these notes, and the fix for A11Y-005.
- **Excluded:** the three logic limit-demonstrator twins (`git revert 5367fe7`, §4.3).
- **A11Y-005 fixed:** the code editor's accessible name is `{language} source code of {board}`
  (`קוד המקור ({language}) של {board}`) with the active language, so a MicroPython program is no
  longer announced as Arduino. Regression e2e `app/e2e/a11y-005-editor-name.spec.ts` (EN/HE: switch
  both ways, reload, a project opened in MicroPython; code preserved); it fails on `bf24d16` and
  passes on the candidate.
- **Staging:** only the build service was updated (analyzer 9), after a written preflight; the
  Session Host (166eaa9), QEMU, firmware and the other services were not touched. Evidence, the
  preflight and the rollback procedure are kept on DEV (`~/tbi-mpy/evidence/rc/`).
- Nothing is prepared for Alpha.
