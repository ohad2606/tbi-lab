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

### Feasible, added separately (their own commit)

esp32-logic-and, esp32-logic-override and esp32-logic-quad-and are limit demonstrators: the
Arduino examples are refused by name (S30-L1 / the SN74LVC08A datasheet) once the sketch drives
GPIO18, or in every state. Their MicroPython twins (`mpy_logic_and.py`, `mpy_logic_override.py`,
`mpy_logic_quad_and.py`) only use `Pin`, and are refused exactly as the Arduino versions are; they
are in a separate commit so the owner can decide whether limit demonstrators need a twin.

### Not feasible with the current MicroPython support

| Example | Missing |
|---|---|
| esp32-thermo-hygrometer (DHT22) | MicroPython's `dht` module is refused (`library:dht`), and a pure-Python read of the DHT22's 26–70 µs bits has no validated timing (the G2 contract does not cover bit-banged protocols with margins near the ≈ 13 µs polling interval). See §3 (libraries) for the path. |
| esp32-distance-alarm (HC-SR04) | `machine.time_pulse_us` was refused; see §2. |

The examples without an ESP32 (resistors, logic, PSU) have no program, so no twin applies.
