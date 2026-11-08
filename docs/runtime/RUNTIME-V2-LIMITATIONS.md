# Runtime v2 — accepted limitations and capacity criterion (record)

Runtime v2 `b5b34b49cb7e4049` (espressif/qemu `40edccac` + 0001–0008), deployed to dev-lab at
Gate C (2026-10-11, `ba0f4a6`). Accepted by the PM: the G-2 final approval and the Gate C
acceptance, both 2026-10-11. Evidence: `docs/sprints/s12-evidence/gate-b/G2-FINAL.md` §4,
`G2-ROUND4.md`, `G2-ROUND5.md`.

**TBI Lab V1 does not claim unrestricted microsecond timing fidelity.**

## Timing contract (accepted)

| Dimension | Contract |
|---|---|
| Electrical edges | Exact: scheduled inputs at their exact simulated ns; GPIO outputs timestamped at the exact ns of the write |
| Firmware-visible input detection | Within the reading loop's polling period, except inside the intervals below |
| Normal Arduino sketches (core 0 idle) | Within ≈ 1–2 µs of exact outside the intervals; within the interval length inside them; software-timed outputs only ever longer |
| Busy core 0 | **Unsupported** for µs timing (core 1 frozen up to 0.98 ms) |
| `delay()` on core 1 | Periods exact; the first wake-up's phase up to the image's inter-core tick offset late (0–477 µs) |

## Known limitations

| Id | Limitation | Bound measured | Scope |
|---|---|---|---|
| F-R2-1a | The other core's tick blinds the polling core | 10–12 µs (≈ 1.5 + 10–12 µs when split; ≤ ≈ 13.3 µs unsplit), once per simulated ms | all sketches |
| F-R2-1b | The polling core's own tick interrupt | core 1 ≈ 4 µs, core 0 ≈ 25.6 µs (also on silicon, ≈ 2× shorter there) | all sketches |
| F-R2-1c | Busy core 0 freezes core 1 | up to 0.98 ms | sketches keeping core 0 running |
| F-R2-1d | Lock-holder preemption (FreeRTOS spinlock held by a descheduled core) | 272–278 µs freezes (2 % of edges, EdgeEcho sweep) | core-1 code taking spinlocks at a high rate |
| F-R2-1e | `delay()` wake-up phase on core 1 | 0–477 µs | phase only |
| F-R2-1f | Startup cross-core race quantised to one tick | +1 ms app start (2 of 6 images) | startup only |
| F-R2-2 | `pulseIn` polling and truncation | ⌊W − L⌋ ≤ R ≤ ⌊W + L⌋, L = 0.4534 µs; an edge in an interval: \|R − W\| ≤ 13.5 µs | firmware-visible measurement |
| — | UART bit timing, `attachInterrupt` latency, LEDC/RMT/hardware timers, Wi-Fi/BT, ADC | not modelled / not measured; no claim | — |
| — | Internal pull-ups (D-4); third-party libraries (D-3); LCD at 5 V with 3.3 V pull-ups (out of spec, refused) | — | — |

Regression tests keep the known failures visible. `s12-bridge-timing` and `s12-r2-timing` carry
mechanism-matched **KNOWN FAILURE** cases: an unexpected failure or an unexpected pass fails them.

## D-2 capacity criterion for the POC host (ratified 2026-10-11)

- **Rate:** every session's 5th-percentile simulation rate is **≥ 0.995× over 5-second
  wall-clock windows**, after the 30 s boot warm-up.
- **Unchanged:** tick-gap p99 ≤ 100 ms; no session failures; Stop and cleanup leave no session,
  runtime or file behind.
- **Scope:** one active runtime session on the current POC host (1 vCPU).

Basis: N = 1 measured 0.99952× (5 s windows, p5), with a whole-run sim/wall of 0.99999986
(`s12-evidence/gate-c/c5win-n1-mix-paced.json`). The C-5 harness still evaluates 1 s windows at
0.99; switching it to the ratified criterion is Sprint 12 closure item C-6.
