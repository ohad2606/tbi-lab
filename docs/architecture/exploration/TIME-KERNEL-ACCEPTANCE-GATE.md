# Time kernel (EF-1) and LMC555 — time-domain acceptance gate

**Status:** defined 2026-10-22 (PM decision 3: "Isolated implementation and testing authorized.
Product exposure and DEV-Lab integration are NOT approved yet. Establish a specific time-domain
correctness and performance acceptance gate."). This gate is what the isolated work must pass before
exposure is even proposed; passing it is **not** an exposure approval.

Scope: `packages/engine/src/kernel/transient.ts` (branch `sprint-19b-kernel`) and, on it, an
LMC555 model. Nothing here is reachable from the product.

## 1. Kernel correctness (closed-form references; every expected value analytic)

| ID | Criterion | Pass |
|---|---|---|
| K1 | RC charge, V(1 − e^(−t/RC)) sampled every 0.1 τ over 5 τ | worst error ≤ 1 mV at the default tolerances (abs 1 mV, rel 1e-3); ≤ 20 µV at abs/rel 1e-5 |
| K2 | Two-stage RC ladder (two time constants), closed form | worst error ≤ 1 mV (default) |
| K3 | Order: tightening the tolerances ×100 | error falls ≥ ×10, and the trapezoidal kernel needs ≤ ⅓ of the solves of backward Euler at the same tolerance |
| K4 | Charge conservation: ∫ I_C dt over a window vs C·ΔV_C | agree within 0.1 % |
| K5 | Event localization (relay pull-in, a supply's CV/CC change) | event time within (trajectory voltage error / slope at the threshold) + eventTolS of the closed form; ≤ 50 µs at default tolerances, ≤ 5 µs at 1e-5 |
| K6 | Discontinuities (a step input, a capacitor on an ideal source) | no spurious current oscillation: |I| ≤ 1 µA once settled; the first step after any discontinuity or input change is backward Euler |
| K7 | Window independence: advancing to T in one window vs in N windows | results agree within the tolerances (not bit-identical: the step grids differ) |
| K8 | Determinism | the same circuit, requests and options give bit-identical steps, times and values |
| K9 | Refusals by name | step floor, budget, solve failure (after retries at half steps), logic parts (until propagation delay is modelled), time going back |

## 2. Kernel performance (DEV reference: 1 vCPU ARM, Node 24)

| ID | Criterion | Pass |
|---|---|---|
| P1 | RC over 5 τ, default tolerances | ≤ 300 solves, ≤ 200 ms wall |
| P2 | Budget accounting | never more than the budget + one trial per window |
| P3 | A 555-class relaxation oscillator (§3, astable at 14.4 kHz) for 10 ms simulated | ≤ 40 solves per period on average; wall time recorded (the product's real-time requirement is a separate exposure criterion, §4) |

## 3. LMC555 model (datasheet SNAS558N, pinned in `~/tbi-s19b/datasheets/lmc555.pdf`)

Device behaviour from the datasheet: the comparator thresholds come from the control voltage
(V_CTRL; threshold = V_CTRL, trigger = V_CTRL / 2); RESET below V_RES forces the output LOW and
the discharge ON; the discharge transistor's saturation voltage and the output stage's V_OH / V_OL
at their tabulated currents; supply current I_S.

**The datasheet gives bands, not single values** (at V_S = 5 V: V_CTRL 2.9–3.8 V, typical 3.3 V;
the timing accuracy of its own test circuit is 1.0–1.2 ms, typical 1.1 ms; the 12 V astable test
circuit 4.0–5.6 kHz). A deterministic simulation must pick one value; the prototype uses the
**typical** V_CTRL (⅔ V_S) and reports the guaranteed band beside every timing result. Whether a
typical-value timing model may be exposed in the product is an **owner decision** (physics validity;
EF-D4 A chose guaranteed values for logic outputs, where a bound is meaningful; for a timer a bound
gives no single waveform).

| ID | Criterion (the datasheet's own application circuits) | Pass |
|---|---|---|
| L1 | Monostable, R_A = 9.1 kΩ, C = 0.01 µF, V_S = 5 V | pulse width = R_A·C·ln 3 within 0.1 % (thresholds ⅔ / ⅓ V_S); inside the datasheet's timing-accuracy band scaled to this RC (1.0/1.1 … 1.2/1.1 of 1.1·R_A·C) |
| L2 | Astable, R_A = 1.78 kΩ, R_B = 4.12 kΩ, C = 0.01 µF, V_S = 5 V | t1 = (R_A + R_B)·C·ln 2 and t2 = R_B·C·ln 2 within 0.1 % (with the discharge saturation voltage and the comparator thresholds as modelled: the closed form is recomputed with them); duty cycle per equation (5) |
| L3 | Control-voltage pin driven externally | thresholds follow it exactly; a value outside the datasheet's range is refused by name |
| L4 | RESET | below V_RES (0.4–1.1 V band, typical used): output LOW, discharge ON, timing cleared |
| L5 | Supply | V_S outside 1.5–15 V refused by name; I_S per row |
| L6 | Output | V_OH / V_OL at the tabulated currents, guaranteed values; larger loads refused |
| L7 | Frequency | above f_MAX (3 MHz typical) refused by name; propagation delay (100 ns typical) either modelled or the timing error it causes stated |
| L8 | Determinism and refusals | as K8, K9 |

## 4. Exposure criteria (for a later decision; not part of this gate's pass)

- The owner's decision on typical-value timing (§3).
- Real time: a ≤ 10 kHz 555 circuit simulated at ≥ 1× real time in the browser worker on the
  reference desktop, with the UI thread free.
- Instruments: an oscilloscope (or equivalent waveform view) exists to show the result; a DC
  readout of an oscillating node is never presented as its value.
- Interaction with ESP32 sessions (the runtime's time base) designed and reviewed.

## 5. Status against this gate (2026-10-22, `sprint-19b-kernel`)

| Criteria | State |
|---|---|
| K2, K4, K5, K6, K7, K8, K9, P1, P2 | **pass** (`packages/engine/tests/kernel-transient.test.ts`) |
| K1 | **pass at the default tolerances** (worst 0.33 mV ≤ 1 mV); **not met at 1e-5** (136 µV > 20 µV) |
| K3 | **NOT MET** (recorded as `it.fails`). Cause, measured: the controller bounds the LOCAL error per step; the global error accumulates over the steps, and at loose tolerances `dtMax` (10 ms), not the tolerance, caps the step (1e-3 and 1e-4 take the same 64 steps, 326 µV; 1e-5: 136 µV; 1e-7: 11 µV). Fix for the next iteration: error-per-unit-step control or a global-error estimate (e.g. extrapolation over the window), then K1/K3 again |
| P3 | needs the LMC555 model |
| L1–L8 | not started: the LMC555 prototype comes after K1/K3 pass (a timer built on a kernel whose global error does not follow its tolerance would make L1/L2 tolerances meaningless) |
