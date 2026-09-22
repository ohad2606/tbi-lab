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

> **Superseded (Sprint 1 closure):** this was measured on a firmware image whose coredump partition
> the guest had modified. On the pristine image, the first application GPIO event is at 0.889 s.
> See C0 and C4.

The Arduino firmware's first application GPIO event occurs at **~12.9 s of virtual time** (and
6.7-12.8 s in inline runs). Real hardware reaches `setup()` in well under a second. On this host
that means tens of seconds of wall time before a sketch runs. Root cause not investigated; likely
candidates are emulated clock/RTC calibration loops or flash timeouts in the machine model. This is
a **session start-latency risk** for V1.

---

# Sprint 1 closure (2026-09-22) — deterministic closed loop, timing fidelity, resources

PM decision P1 made closed-loop determinism a V1 release requirement for ESP32 simulation, but the
results above had left the loop non-deterministic. This section records how determinism was
achieved, two defects found along the way, and the timing fidelity that can honestly be claimed.

## C0. Correction to Results 1-3 and the "slow boot" observation

The firmware artifacts in `/home/ubuntu/tbi-tools/fw/` were attached to QEMU **writable**, and the
guest had modified them. Both Arduino images had drifted from their recorded hashes:

- GPIO proof: `6356233a…` instead of `d069fffc…cdd44`;
- timing probe: `58c6fc1b…` instead of `5ef344ff…ddb34`.

The only changed bytes are at 0x3F0000-0x3F2CDF, the Arduino **coredump partition**. Some earlier
run panicked and wrote a core dump. Which run is unknown: the core dump survives, but no serial log
of the panic does. Every later boot then processed that core dump.

**Consequences:**

- The **"~12.9 s to first application GPIO"** figures above, and the first closure boot-timing
  measurements, were taken on a **modified image**. On the pristine image, the same firmware and
  configuration reach its first application GPIO at **0.889 s** simulated. Booting the drifted copy
  reproduces **12.789 s**. See C4.
- The **determinism conclusions stand.** Each comparison was made between runs of the same image
  state. Absolute boot times do not.
- **Fix.** The closed-loop harness and `timing_fidelity.py` now verify the pristine artifact's sha256
  and boot every run from a fresh scratch copy (`RunRecord.flashWritten` reports whether the guest
  wrote flash; it was `false` in every closure run). The images were restored from the Arduino build
  outputs, whose hashes match the recorded ones.
- **Product implication.** This is already required by V1-ARCHITECTURE §11 (per-session scratch copy)
  and is now an explicit part of "identical initial state" (§7.3).

## C1. Why the earlier lockstep attempts failed

| Attempt | Failure mechanism |
|---|---|
| `sync`: pause the VM after each event | The pause takes effect at a translation-block boundary via the main loop; a host reply could be applied in between |
| `inline`: hold the vCPU inside the GPIO write, BQL released | With the BQL released, QEMU's main loop runs virtual-clock timers while the vCPU is mid-instruction |

## C2. The synchronous bridge

`tbi-gpio-bridge` gained a `syncport` mode. The device owns a private blocking TCP connection to the
host and performs every exchange **on the calling emulator thread, holding the Big QEMU Lock**:

- **GPIO event:** the device sends `O|D <pin> <v> <vns>`. The host solves the circuit and replies with
  `I <pin> <level>` lines, each applied immediately and acknowledged with `A ... <vns>`, then `C`.
- **Periodic virtual-clock tick** (`poll-us`): the device sends `T <vns>`. The host applies any runtime
  commands scheduled at or before `vns`, then replies `C`.

Nothing else in QEMU runs during an exchange, so host latency stretches wall time only. Responses are
applied before the next guest instruction, at zero elapsed virtual time.

**Harness.** `experiments/sprint-1-spikes/closed-loop/` and the release-gate test
`tests/closed-loop.esp32.test.ts`. The host side is the **real Gate A engine and Gate C pin model**:

- **Circuit:** GPIO2 -> 220 ohm -> LED; GPIO2 -> 10 k -> GPIO5 <- 10 k <- VEXT (a lab PSU).
- **Stimulus:** VEXT toggles between 3.3 V and 0 V on an ordered command sequence scheduled in
  **simulation** time (13.0, 13.6, 14.2 and 14.9 s). GPIO5 therefore lands LOW, HIGH, or inside the
  undefined band, where it holds its previous level.
- **Fingerprint:** every GPIO event, every solve result (node voltages, LED current, PSU mode, at full
  precision), every injected input with its virtual timestamp, every command application, and the
  serial output.

## C3. Two residual non-determinisms, their root causes and fixes

### C3.1 APP-CPU reset (asynchronous machine reset request)

**Symptom.** 1 run in 10 diverged at the first application GPIO event.

**Localization.** The harness added per-tick vCPU PCs (a diagnostic only). The runs were identical up
to the tick where core 1 left reset, and the two cores' interleaving differed after it.

**Mechanism.** In `hw/xtensa/esp32.c`, releasing the APP CPU from reset calls
`qemu_system_reset_request()`. That request is **serviced asynchronously by the main loop**, so
the instruction at which core 1 starts depended on host scheduling.

**Fix.** `esp32-appcpu-reset-determinism.patch` (18 added lines). Under icount, both vCPUs run on one
round-robin thread. The APP-CPU reset is therefore applied synchronously, using the same four steps
the deferred path performs: set the reset cause, select the static vectors, remove watchpoints,
`cpu_reset`.

### C3.2 icount warp race (upstream QEMU core)

**Symptom.** On the pristine image, the APP-CPU fix alone still gave **2 divergences in 10** full
runs under main-loop stress. The stress is a QMP `query-status` every ~1 ms; it does not touch the
guest.

**Localization.** Both cores were halted (`waiti`) at 2.127 s. In the diverged run, the next tick fired
at 2128000992 ns instead of 2128000000. That offset (**992 ns = 124 instructions**) carried through every
later event, including the command at 13 s.

**Mechanism.** With `sleep=off`, `icount_start_warp_timer()` advances the virtual clock by
`next_deadline - now` whenever all CPUs are idle. The **main loop** calls it after every wake-up
(`util/main-loop.c`). The round-robin vCPU thread, however, drops the BQL around `tcg_cpu_exec()` and
`icount_process_data()`. So when a slice ends with a `waiti`, there is a window where all CPUs look idle
but the slice's instructions are not yet accounted. The main-loop thread has no `current_cpu`, so its
`now` omits them, and the warp overshoots by exactly that many instructions. Frequent main-loop
wake-ups make the window easier to hit.

**Fix.** `icount-warp-race-determinism.patch` (18 added lines: `accel/tcg/icount-common.c`,
`accel/tcg/tcg-accel-ops-rr.c`, `include/sysemu/cpu-timers.h`):

- A BQL-protected flag marks a round-robin slice in flight.
- A `sleep=off` warp is refused while the flag is set.
- Upstream already makes the vCPU thread `qemu_notify_event()` the main loop once all CPUs are idle
  and accounted. That notification becomes the only warp point, and it warps from an exact clock.

**Note.** An earlier closure hypothesis about a "warp race" had been dropped, because plain icount
under stress did not diverge in a handful of runs. The race is real, but it needs both cores to halt
with an unaccounted slice while the main loop is awake. It was exposed once the core-dump boot path
(C0) was gone.

### C3.3 Demonstration: eliminated, not merely reduced

| Runtime | Image | Scenario | Stress | Runs | Distinct timelines |
|---|---|---|---|---|---|
| no fixes | drifted | 3 s boot window | yes | 20 | **4** |
| APP-CPU fix | drifted | 3 s boot window | yes | 30 | 1 |
| no fixes | drifted | full 15.5 s | no | 10 | **2** |
| APP-CPU fix | drifted | full, 10 ms / 1 ms tick | with and without | 77 | 1 per tick |
| APP-CPU fix | **pristine** | full, 1 ms tick | yes | 5 + 5 | **2** (2 runs diverged, +992 ns) |
| **both fixes** | pristine | full, 1 ms tick | **yes** | **30** | **1** |
| both fixes | pristine | full, 1 ms tick | no | 10 (+4 in resource runs) | 1 |
| both fixes | pristine | full, 10 ms tick | **yes** | **10** | 1 |
| both fixes | pristine | full, 10 ms tick | no | 5 (+3 in resource runs) | 1 |
| both fixes | pristine | 3 s boot window, 10 ms tick | **yes** | **30** | 1 |

**Totals with both fixes:** 62 full-scenario runs (40 of them stressed) plus 30 stressed boot-window
runs, with **zero divergences**.

**Final fingerprints.** Pristine image, both fixes, and no divergence **across separate processes
and batches** either:

| Tick | Timeline sha256 | Serial sha256 |
|---|---|---|
| 1 ms | `1382cd99602e52e4…` | `c4d82896054ce928…` |
| 10 ms | `b779e313e61e4d72…` | `c4d82896054ce928…` |

Each run has 90 GPIO events, 45 solves, 5 injected input transitions and 4 commands. The unstressed
pre-warp-fix runs produced the same hashes, so the fix removes the race without altering the normal
timeline. Both reference fingerprints are now **pinned in the release-gate test**: the test compares
against the pinned values, not only within its own batch, so drift between processes fails it.

**Known remaining gap.** PRO-CPU and full-system resets (`esp_restart()`, watchdog) still use the
asynchronous `qemu_system_reset_request()`. The test firmware never restarts.

## C4. Timing fidelity (pristine image)

Probe firmware: `arduino/TbiTiming/`. GPIO2 edges serve as markers, timestamped by the bridge in
virtual time, and the firmware reports its own view. Harness: `timing_fidelity.py`.

**Boot to the first application GPIO event (`pinMode` in `setup()`), no debugger attached:**

| Scheduling quantum | Simulated | Firmware `millis()` at `setup()` |
|---|---|---|
| 100 ms (QEMU kick period, no tick) | **0.889 s** | 334 |
| 10 ms tick | **0.468 s** | 116 |
| 1 ms tick | **0.379 s** | 41 |
| *drifted image (core dump present), 100 ms* | *12.789 s* | *6330* |

**Boot phases.** Measured via GDB-stub breakpoints; the VM is stopped at each breakpoint and the
virtual clock read exactly.

| Segment | 100 ms quantum | 10 ms tick | 1 ms tick |
|---|---|---|---|
| reset -> 2nd-stage bootloader | 400.000 ms | 310.000 ms | 302.000 ms |
| bootloader -> app entry | 100.000 ms | 30.000 ms | 27.000 ms |
| app entry -> `app_main` | 496.125 ms | 62.356 ms | 17.000 ms |
| `app_main` -> `setup()` | 8,407.749 ms (*perturbed by GDB, see below*) | 497.644 ms | 35.812 ms |

**Findings:**

- **Where the ~12.9 s came from.** It came from the **core-dump partition on a modified image**
  (C0), not from the emulator's boot path. The drifted and pristine images differ only in that
  partition, and boot at 12.789 s vs 0.889 s simulated.
- **Scheduling-quantum effect (secondary).** Under icount, QEMU runs the two cores round-robin on one
  thread and switches at the next virtual-timer deadline. Early boot phases therefore land on exact
  multiples of the quantum (400/100 ms; 310/30 ms). Boot shrinks from 0.889 s to 0.379 s when the
  quantum goes from 100 ms to 1 ms. Real silicon runs both cores concurrently.
- **Not the cause:** flash emulation and ROM/bootloader content on a pristine image.
- **Not measured:** real silicon boot time.
- **Attaching GDB perturbs the timeline.** With GDB and no tick, `app_main` -> `setup()` took 8.4 s,
  against a 0.889 s total boot without GDB. At a 1 ms tick, the GDB and no-GDB boot totals agree
  (0.382 vs 0.379 s). Phase figures are therefore quoted for the 1 ms configuration; the no-tick
  phases are indicative only.

**Firmware-visible timing** (virtual time from the markers; the firmware's own report agrees):

| Measurement | No tick | 10 ms tick | 1 ms tick | Firmware's own view (1 ms tick) |
|---|---|---|---|---|
| `delay(1000)` | 1000.513 ms | 1000.514 ms | 999.902 ms | `millis` 1000, `micros` 999,904, 239.98 M cycles |
| 1 s window, 100 ms hardware-timer alarm | 999.985 ms | 999.985 ms | 999.986 ms | 9 ticks (the 10th alarm lands just after the window) |
| 1M-iteration busy loop | 48.801 ms | 48.801 ms | 48.803 ms | 11.71 M cycles = 11.7 CPU cycles per iteration |

- **Peripheral timers agree with simulation time.** `delay()`, `millis()`, `esp_timer`, hardware timer
  alarms and the CPU cycle counter all agree with simulation time within **0.06 %**.
- **Instruction-bound code runs ~1.9x slower than silicon** (estimate). At `shift=3` each instruction
  is 8 ns, a 125 MHz equivalent. For comparison, real-time mode gave 34.3 ms for the same loop on this
  host, but that mode is not reproducible and is debug-only (P3). No physical board was measured.
- **No correction constant is applied anywhere.**

## C5. Resources and speed in the V1 configuration

The V1 configuration uses the approved `hostCommandQuantum` of **1 ms** of simulated time (PM decision
P9; V1-ARCHITECTURE §7.6). The 10 ms rows are engineering measurements, kept because they show that
a different quantum yields a different — but equally reproducible — timeline.

Pristine image, full 15.5 s scenario, unpaced, 1-core dev host. QEMU figures read from `/proc`:
`VmHWM` gives the kernel-recorded peak RSS, and the 200 ms samples give the maximum sampled `VmRSS`.

| Tick | QEMU peak RSS (`VmHWM`) | Max sampled RSS | QEMU CPU time | Wall | Simulated/wall |
|---|---|---|---|---|---|
| 1 ms | **145 MB** | 90 MB | 8.5 s | 10.3 s | **~1.5x** |
| 10 ms | **144 MB** | — | 7.5 s | 8.6 s | ~1.8x |

- The first closure figures (92-94 MB) were **sampled** RSS on the drifted image. The kernel peak is
  higher, and it is the right figure for memory limits.
- The host-side process in these tests ran under the TypeScript dev toolchain (vite-node, 112-114 MB),
  so it is not a Session Host figure.
- The minimal Node engine host measured 53 MB bare, and 66 MB with the engine and a socket.
- The full Session Host is **unmeasured**.

## C6. Observation — GDB stub plus periodic tick

With the GDB stub attached and a periodic virtual timer running, `delay(1000)` could stall
indefinitely. Together with the timeline perturbation in C4, this confirms that debugger-attached runs
are outside the timing and determinism claims. Production never attaches GDB.
