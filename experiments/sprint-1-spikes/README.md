# Sprint 1 spikes — simulation time and determinism

Tiny executable spikes that answer one architectural question, which Sprint 0 left open: **can the
classic-ESP32 runtime give a deterministic simulation-time contract?** Findings:
`docs/research/sprint-1-simulation-time.md`. Decision: `docs/architecture/adr/ADR-007-simulation-time-contract.md`.

Not product code. Python harnesses are stdlib-only; the closed-loop harness is TypeScript and uses the
real Gate A engine and Gate C pin model. All of them use the runtime and firmware in `/home/ubuntu/tbi-tools/`
(outside git).

| File | What it measures |
|---|---|
| `time_determinism.py` | GPIO event virtual timestamps across runs in real-time and `-icount` modes, plus QEMU CPU and RSS |
| `repeat_check.py` | Repeats the icount modes and checks `delay()` spacing in virtual time |
| `lockstep_check.py` | Closed-loop determinism: host-injected responses in `sync` and `inline` modes. Superseded by the syncsock closed-loop test below; kept as the record of the failed approaches. |
| `tbi_gpio_bridge.sprint1-spike.diff` | The opt-in bridge properties, all **off by default**: `vclock`, `sync` and `inline` (rejected), and `syncport` + `poll-us` (the synchronous bridge and virtual tick used by V1). The Sprint 0 ESP32 suite passes 19/19 with them built in |
| `esp32-appcpu-reset-determinism.patch` | QEMU machine fix (`hw/xtensa/esp32.c`): under icount, the APP-CPU reset is applied synchronously instead of via the asynchronous main-loop reset request. It removed the boot-time divergence (the first of two) |
| `icount-warp-race-determinism.patch` | QEMU core fix (`accel/tcg`, `include/sysemu/cpu-timers.h`). With `sleep=off`, the main loop could warp the virtual clock while a round-robin vCPU slice was in flight, using a clock that excluded the slice's unaccounted instructions. The warp then overshot by a host-timing-dependent amount (observed: 992 ns = 124 instructions). The warp is now deferred until the slice is accounted |
| `closed-loop/closedLoop.ts` | Closed-loop harness: QEMU (icount + syncsock) <-> real engine. The circuit is GPIO2 -> LED, GPIO2 -> 10 k -> GPIO5 <- 10 k <- PSU, plus 4 PSU commands scheduled in simulation time. It hashes the full timeline (events, solves, injections, commands) and the serial output. `stressMainLoop` adds a QMP client polling every ~1 ms |
| `tests/closed-loop.esp32.test.ts` | **Release-gate test for R-MCU-1** (V1-ARCHITECTURE §7.3). The env vars `TBI_CLOSED_LOOP_RUNS` (default 5), `TBI_CLOSED_LOOP_TICK_US` (default 1000, the approved V1 `hostCommandQuantum` of 1 ms) and `TBI_CLOSED_LOOP_STRESS=1` control it. Run it with `npm run test:esp32 -- experiments/sprint-1-spikes/tests/closed-loop.esp32.test.ts` |
| `closed-loop/stressRuns.ts`, `closed-loop/findDivergence.ts` | Diagnostics: count distinct timelines in the boot window under stress; rerun until two runs diverge, then print the first differing per-tick vCPU PCs |
| `noise_check.py`, `warp_race_stress.py` | Hypothesis checks used during root-causing: host I/O noise and main-loop stress on plain icount. The warp-race hypothesis was dropped |
| `boot_timing.py`, `timing_fidelity.py` | Boot-phase simulated/wall times via GDB-stub breakpoints, and firmware interval measurements (`--no-gdb`) across real-time, icount, and icount + tick configurations |
| `arduino/TbiTiming/TbiTiming.ino` | Timing-probe firmware: GPIO2 markers around `delay(1000)`, a 1M-iteration busy loop and a 100 ms hardware timer. It prints its own `millis`/`micros`/cycle-counter view |

**Firmware artifact hygiene.** The guest can write to its flash: a panic writes the Arduino coredump
partition (0x3F0000), and that changes every later boot. The closed-loop harness and
`timing_fidelity.py` therefore verify the pristine artifact's sha256 and boot each run from a scratch
copy. The older Python spikes (`time_determinism.py`, `repeat_check.py`, `lockstep_check.py`,
`boot_timing.py`, `noise_check.py`, `warp_race_stress.py`) and the Sprint 0 Gate C runtime
(`experiments/gate-c-bridge/src/qemuRuntime.ts`) still attach the image **writable**; this was left
unchanged as a record. Before running them, restore the image from the Arduino build output.
