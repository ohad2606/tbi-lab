# ADR-007 — Simulation time contract

**Status:** Proposed — needs PM input (V1-ARCHITECTURE §18.3 P1, P3) · **Date:** 2026-09-22

## Context
The Sprint 0 bridge ran QEMU on wall-clock time, and was never tested for reproducibility. Sprint 1
spikes (`docs/research/sprint-1-simulation-time.md`) measured:
- real-time mode: GPIO timelines diverge by up to **9.48 s** between runs;
- `-icount shift=3,sleep=off`: the MCU event timeline is **identical across 6/6 runs** (0 ns), and
  `delay(200)` is exactly 200.000 ms of virtual time; it runs at **0.31x real time** on the dev host;
- closing the loop: zero-virtual-lag responses are achievable (`inline`, 0 ns in every run), and a
  reproducible MCU timeline is achievable, but **not both together** yet.

## Decision
- **Simulation time is QEMU's virtual clock under `-icount shift=3,sleep=off`**, the only validated
  setting. Wall-clock time is used for pacing, UI and timeouts only, and never enters an electrical
  calculation.
- Electrical solves occur only at events: t = 0, GPIO level or direction changes, runtime controls,
  MCU reset (EN). Each is processed in order at its simulation instant.
- Guarantees are tiered:
  - **G1 (V1 floor, proven):** electrical results are a pure function of snapshot, pin states and
    controls; events are totally ordered and stamped with simulation time; the MCU timeline is
    reproducible.
  - **G2 (V1 target, not yet achieved):** responses are visible at the same simulation instant and
    the whole closed loop is bit-reproducible. Hypothesis: apply responses at a deterministic stop
    point (e.g. `cpu_exit` at the GPIO write under icount). Acceptance test:
    `experiments/sprint-1-spikes/lockstep_check.py` reporting identical acknowledgements across runs.
- Not claimed: cycle accuracy, or real-silicon instruction timing. At `shift=3` the virtual CPU is
  equivalent to 125 MHz, so instruction-bound code takes ~1.9x longer in simulated time than on a
  240 MHz chip. Peripheral-timer-based timing is exact.
- Pacing is done by pausing between slices (virtual time is frozen while paused). When the
  simulation is slower than real time, the UI shows the ratio.

## Consequences
- If G2 is not achieved, V1 ships on G1, and product copy must not promise bit-exact replay.
- Speed on production hardware is decisive (P2) and currently unknown.

**Evidence:** `docs/research/sprint-1-simulation-time.md`; `experiments/sprint-1-spikes/`.
