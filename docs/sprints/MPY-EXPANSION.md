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

### Logic limit demonstrators (their own commit)

esp32-logic-and, esp32-logic-override and esp32-logic-quad-and are limit demonstrators: the
Arduino examples are refused by name once the sketch drives GPIO18, or (quad AND) at session
creation. Their MicroPython twins (`mpy_logic_and.py`, `mpy_logic_override.py`,
`mpy_logic_quad_and.py`, `Pin` only) are refused identically. In a separate commit so the owner
can decide whether limit demonstrators need a twin.

| Original | New twin | Real QEMU (both languages, identical end) | Staging |
|---|---|---|---|
| esp32-logic-and | **mpy-logic-and** | failed, `logic_mcu_output_uncharacterized`, U2 | builds; Run refused by that code |
| esp32-logic-override | **mpy-logic-override** | failed, `logic_mcu_input_not_guaranteed`, U2 | builds; Run refused by that code |
| esp32-logic-quad-and | **mpy-logic-quad-and** | refused at creation, `logic_input_leakage_uncharacterized`, U2 | builds; Run refused by that code |

### Not feasible with the current MicroPython support

| Example | Missing |
|---|---|
| esp32-thermo-hygrometer (DHT22) | MicroPython's `dht` module is refused (`library:dht`), and a pure-Python read of the DHT22's 26–70 µs bits has no validated timing (the G2 contract does not cover bit-banged protocols with margins near the ≈ 13 µs polling interval). See §3 (libraries) for the path. |

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
