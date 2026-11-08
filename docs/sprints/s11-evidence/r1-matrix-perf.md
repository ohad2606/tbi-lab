# R1 slice 6 — 8×8 matrix performance on the real runtime (2026-10-08)

Measured by `runtime/tests/r1-matrix-perf.runtime.test.ts` on the dev host (the same machine as dev-lab:
4 cores ARM64, 4 GB), real QEMU (runtime `33e35e4ac5e798d7`), firmware `TbiR1Scan` (16 matrix lines,
one `digitalWrite` per line; static pattern, or a checkerboard scanned at one row per millisecond).
Per-event solve times are the Session Host engine's own solves, timed in the test (test-only
instrumentation). Raw data: `matrix-perf/run-<n>.json` (four complete runs; an earlier attempt whose companion
session was ended by the host's client lease — a test-setup error, fixed — is not included).

| Run | Static solves (n, p50/p95/p99 ms) | Scanning solve p50/p95/p99/max (ms) | Solves / simulated s | Sim rate while scanning (× real time) | Matrix session max tick gap (ms) |
|---|---|---|---|---|---|
| 1 | 31, 1.65/5.34/7.71 | 0.49/1.76/3.39/5.43 | 9854 | 0.022 | 107 |
| 2 | 31, 1.98/5.60/7.19 | 0.51/1.74/3.24/5.78 | 9867 | 0.022 | 85 |
| 3 | 31, 2.34/5.81/5.85 | 0.49/1.66/3.01/6.87 | 9869 | 0.022 | 74 |
| 4 | 31, 1.85/6.91/8.11 | 0.50/1.73/3.30/7.30 | 9867 | 0.022 | 88 |

| Run | Companion alone (× real time) | Companion beside static (idle) matrix session | Companion beside scanning | Companion max tick gap beside scanning (ms) | Host CPU while scanning (s/s) | QEMU CPU: matrix while scanning / companion alone (s/s) |
|---|---|---|---|---|---|---|
| 1 | 3.88 | 1.84 | 1.76 | 10.9 | 0.27 | 0.31 / 0.70 |
| 2 | 3.63 | 1.72 | 1.72 | 9.8 | 0.28 | 0.31 / 0.68 |
| 3 | 3.43 | 1.76 | 1.80 | 15.1 | 0.28 | 0.32 / 0.62 |
| 4 | 3.56 | 1.18 | 1.72 | 10.0 | 0.28 | 0.31 / 0.67 |

## Gates (architecture §6.4) and the decision

| Gate | Result |
|---|---|
| p99 per-event solve ≤ 2 ms, static | **Not met** (5.9–8.1 ms; 31 solves: setup and pattern writes, many diodes switching at once) |
| p99 per-event solve ≤ 2 ms, scanning | **Not met** (3.0–3.4 ms; p50 ≈ 0.5 ms) |
| Companion rate ≥ 80 % of alone | **Not met** (≈ 33–52 %) — but the same drop occurs beside an IDLE matrix session (static pattern standing, no solves): it is the cost of two concurrent QEMU sessions on this host, not of the matrix |
| Companion max tick gap ≤ 100 ms | Met (10–15 ms) |

Additional finding: while scanning, the session itself runs at ≈ 0.022 × real time (about 9 900 pad
events, each a synchronous bridge round trip plus a 64-diode solve, per simulated second), and its
own bridge ticks are up to 85–107 ms apart in wall time. A scanned display is therefore not usable
in an ESP32 session even apart from the persistence-of-vision limit.

**Decision (the rule agreed with the PM): the matrix stays local-only.** The catalog keeps
`mcuRuntime: false` for `display.led_matrix_8x8`; the perf test asserts that the catalog refuses it
whenever a gate fails. The static-pattern capability is verified (engine r1-matrix, host r1-matrix
with the flag lifted for that test only) for when the PM revisits this.
