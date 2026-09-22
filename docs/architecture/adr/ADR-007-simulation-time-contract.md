# ADR-007 — Simulation time contract

**Status:** Accepted (PM decisions P1, P3, P4 recorded 2026-09-22). The tick value is awaiting PM
confirmation. · **Date:** 2026-09-22 (revised in the Sprint 1 closure)

## Context
The Sprint 0 bridge ran QEMU on wall-clock time, and was never tested for reproducibility
(see `docs/sprints/SPRINT-0-ERRATA.md` E-1). Sprint 1 spikes
(`docs/research/sprint-1-simulation-time.md`) measured:

- **Real-time mode:** GPIO timelines diverge by up to **9.48 s** between runs.
- **`-icount shift=3,sleep=off`:** the MCU-only timeline is reproducible.
- **First closed-loop attempts** (pause at a TB boundary; hold the vCPU with the BQL released) were
  **not** reproducible.
- **Sprint 1 closure:**
  - A synchronous bridge plus two 18-line QEMU fixes makes the full closed loop reproducible. The
    fixes are a synchronous APP-CPU reset and an icount warp race.
  - With both fixes: **62 full-scenario runs (40 under main-loop stress) plus 30 stressed boot-window
    runs, zero divergences**, and identical hashes across separate processes. Without them, runs
    produced 2-4 distinct timelines.
  - The "~12.9 s boot" came from a guest-modified firmware image (a core dump in flash). The pristine
    image boots in 0.38-0.89 s simulated, depending on the dual-core scheduling quantum.

## Decision
- **Three properties, claimed separately:** deterministic causality, timing fidelity, and execution
  speed. Deterministic does not mean cycle-accurate.
- **Simulation time is QEMU's virtual clock under `-icount shift=3,sleep=off`.** Causality is defined
  in simulation time only. Wall-clock time is used for pacing, UI and policy timeouts only.
- **Release gate R-MCU-1 (V1-ARCHITECTURE §7.3).** Given the same inputs, the ESP32 simulation
  reproduces the same externally observable events with the same simulation timestamps:
  - **Inputs:** identical snapshot, firmware, runtime configuration, initial state, and ordered
    command/input sequence.
  - **Must match:** GPIO output events, electrical results, digital input transitions, and
    firmware-observable (serial) behaviour.
  - **Need not match:** internal QEMU state.
  - The ESP32 feature is not V1-ready until R-MCU-1 holds. Mode A is not affected.
- **Mechanism:**
  1. **icount.**
  2. **Synchronous bridge.** Every exchange runs on the emulator thread holding the BQL, and
     responses apply at zero elapsed simulation time.
  3. **Periodic virtual-time tick.** It is the only point where runtime commands apply, so commands
     are quantized to the tick.
  4. **Synchronous APP-CPU reset** under icount (a QEMU machine fix).
  5. **No `sleep=off` clock warp while a vCPU slice is in flight** (a QEMU core fix).
  6. **Each session boots from a fresh copy of the hash-verified firmware artifact.**
- **The tick is part of the timing model and of `runtimeVersion`.** Recommended: **1 ms**.
- **Only deterministic mode ships (P3).** Real-time mode is engineering/debug only.
- **Timing-fidelity claim:**
  - peripheral timers, `delay()`, `millis()` and the cycle counter agree with simulation time to
    < 0.06 %;
  - instruction-bound code runs ~1.9x slower than 240 MHz silicon (the 125 MHz-equivalent virtual
    CPU; estimate);
  - boot time is not representative (0.38 s to `setup()` at a 1 ms tick);
  - no correction constants.
- **Pacing** is done by delaying the tick reply, during which simulation time is frozen.

## Consequences
- **Paths outside the contract until fixed:**
  - full-system / PRO-CPU reset (`esp_restart`, WDT, EN as a system reset) is still asynchronous;
  - deep/light sleep uses the host clock and is unsupported;
  - Wi-Fi/BT are unsupported.
- Every new peripheral or bridge feature must extend the release-gate test
  (`experiments/sprint-1-spikes/tests/closed-loop.esp32.test.ts`).
- **The QEMU patch set grows by two fixes**, one of them in generic QEMU core code. Both must be
  carried onto the Espressif baseline (P8), and the core fix is a candidate for upstream submission.
- **Speed on production hardware is unknown** (P2). The dev host runs ~1.5x real time (unpaced) at a 1 ms tick.

**Evidence:** `docs/research/sprint-1-simulation-time.md` (Results 1-3, C1-C6);
`experiments/sprint-1-spikes/`.
