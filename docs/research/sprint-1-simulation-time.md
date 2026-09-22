# Sprint 1 research — Simulation time and determinism on the classic-ESP32 runtime

**Why this exists.** Sprint 1 must define a simulation-time contract (V1-ARCHITECTURE §7). The
Sprint 0 bridge was asynchronous and ran QEMU on host wall-clock time, so Sprint 0 never tested
whether a *deterministic* contract is achievable. This note records the smallest spikes needed to
answer that honestly. Nothing here is product code.

**Setup.** Runtime: the Gate C runtime (`a159x36/qemu @ esp-develop-9.2`, commit `03be9af0`, plus the
Sprint 0 enable-gating patch). Firmware: the Sprint 0 Arduino GPIO proof
(`esp32:esp32:esp32`, DIO, SHA256 `d069fffc…cdd44`). Classic `esp32` machine throughout. Host: the
1-core Neoverse-N1 dev server.

**Spike instrumentation**, added to `tbi_gpio_bridge.c` as properties that are **all off by
default** (the Sprint 0 ESP32 suite still passes 19/19 with this build). Diff:
`experiments/sprint-1-spikes/tbi_gpio_bridge.sprint1-spike.diff`.

| Property | Effect |
|---|---|
| `vclock=on` | every event carries `QEMU_CLOCK_VIRTUAL` in ns: `O <pin> <level> <vns>`; injected inputs are acknowledged `A <pin> <level> <vns>` |
| `sync=on` | after each GPIO event the VM is paused; it resumes when the host sends `C` |
| `inline=on` | the vCPU is held *inside* the GPIO write until the host sends `C`; inputs sent meanwhile are applied by the vCPU before the write returns |

Harnesses: `experiments/sprint-1-spikes/time_determinism.py`, `repeat_check.py`,
`lockstep_check.py` (stdlib Python).

---

## Result 1 — the MCU's own timeline is reproducible under `-icount`

First 24 GPIO transitions, compared across runs:

| Mode | Runs | Identical timestamps | Max divergence | Wall time for 16.1 s of simulated time |
|---|---|---|---|---|
| Real time (Sprint 0 default) | 2 | **No** | **9.48 s** | 18-28 s |
| `-icount shift=3,sleep=off` | 2 + 4 | **Yes, 6/6** | **0 ns** | 52 s (**0.31x real time**) |
| `-icount shift=3,sleep=on` | 2 | No | 3.0 ms | 55 s |
| `-icount shift=2,sleep=off` | 4 | No (3/4 stalled early) | — | ≥ 58 s |

Under `shift=3,sleep=off`, Arduino `delay(200)` appears as exactly **200.000 ms** of virtual time
between transitions. `shift=3` means 8 ns of virtual time per instruction, i.e. a 125 MHz virtual
CPU (the real part runs at 240 MHz). **Only `shift=3,sleep=off` is validated.** `shift=2` was
unstable and is not usable without further investigation.

## Result 2 — closing the loop deterministically is not yet achieved

A host "response function" (GPIO5 := NOT GPIO2, a pure function standing in for the solver, which
Sprint 0 already showed to be bit-deterministic) was driven in lockstep with the firmware. Three
runs per mode; firmware confirmed it read the injected level (`IN=1`) in every mode.

| Mode | MCU event timeline identical across runs | Injected inputs identical across runs | Injection lag (virtual) |
|---|---|---|---|
| `sync` + real time | No | No | 96-1,524 µs |
| `sync` + icount | **Yes** | No | 0 ns typically, up to 11.5 µs |
| `inline` + real time | No | No | 172-1,524 µs |
| `inline` + icount | No | No | **0 ns in every run** |

- **`sync` + icount** keeps the MCU timeline reproducible, but the pause only takes effect at the end
  of the current translation block, and a host reply arriving in that window is applied at a
  host-scheduling-dependent instant.
- **`inline` + icount** applies every response with **zero virtual time elapsed**, but holding the
  vCPU inside an I/O callback (Big QEMU Lock released) perturbs the virtual timeline itself. The
  divergence appears during **boot, before any electrical response**: all flash-pin boot events
  match exactly, then the first application GPIO event lands at 6.67 s in one run and 12.81 s in
  another.

**Conclusion.** A bit-reproducible closed MCU <-> electrical loop is **not demonstrated** with the
current integration. Two properties were each demonstrated separately: a reproducible MCU timeline
(icount), and zero-virtual-latency electrical response (inline hold). Achieving both together is an
engineering task with a clear hypothesis: apply responses at a *deterministic* stop point, for
example a `cpu_exit` at the GPIO write under icount, rather than at a main-loop-scheduled pause or
while holding the vCPU with the BQL released. The harness here is the acceptance test for it.

## Result 3 — resource figures (feed V1-ARCHITECTURE §12)

| Mode | QEMU RSS | QEMU CPU while firmware runs |
|---|---|---|
| Real time, Arduino firmware | ~204 MB | ~0.8 core (22.4 s CPU / 27.5 s wall) |
| `icount shift=3,sleep=off` | 84-132 MB | ~0.91 core, CPU-bound |

Sprint 0 reference: Espressif QEMU with MicroPython idle at the REPL, ~209 MB RSS and ~0 % CPU.

## Observation — slow emulated boot

The Arduino firmware's first application GPIO event occurs at **~12.9 s of virtual time** (and
6.7-12.8 s in inline runs). Real hardware reaches `setup()` in well under a second. On this host
that means tens of seconds of wall time before a sketch runs. Root cause not investigated; likely
candidates are emulated clock/RTC calibration loops or flash timeouts in the machine model. This is
a **session start-latency risk** for V1.
